// The prompt library: every prompt that will ever be sent to a picture / video / voice model is stored here BEFORE
// it is used, as an immutable version. Editing a prompt makes a new version; the old one is kept forever (history).
// A generated file points at the prompt version it was made from (production_generations.prompt_id).
//
// "Stale" is never stored, it is worked out: a prompt carries the hash of the inputs it was written from (the shot's
// action and camera, the asset's details, the film's look...). When the inputs change the hash no longer matches.

import crypto from "node:crypto";

export const PURPOSES = ["model_sheet", "first_frame", "video", "audio"];
export const hashInputs = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
const httpError = (message, status = 400, code = "bad_request") => Object.assign(new Error(message), { status, code });

const targetColumns = ({ assetId = null, shotId = null, elementId = null }) => [assetId ?? 0, shotId ?? 0, elementId ?? 0];
const TARGET_WHERE = "purpose = $2 AND COALESCE(asset_id,0) = $3 AND COALESCE(shot_id,0) = $4 AND COALESCE(element_id,0) = $5";

export async function currentPrompt(db, projectId, purpose, target) {
  return (await db.query(`SELECT * FROM production_prompts WHERE project_id = $1 AND ${TARGET_WHERE} AND status = 'current'`, [projectId, purpose, ...targetColumns(target)])).rows[0] ?? null;
}

// Makes sure a current prompt exists for this target and says what happened:
//   created        first prompt for the target
//   unchanged      same words (the stored input hash is refreshed silently)
//   updated        the inputs changed, so a NEW version was written (the old one is kept as history)
//   kept_edited    a person edited the prompt; their words are never replaced automatically (it now shows as stale)
export async function ensurePrompt(db, projectId, { purpose, assetId = null, shotId = null, elementId = null, text, params = {}, sourceHash, actorUserId = null }) {
  if (!PURPOSES.includes(purpose)) throw httpError(`Unknown prompt purpose "${purpose}".`);
  if (!String(text ?? "").trim()) throw httpError("A prompt cannot be empty.");
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const current = (await client.query(`SELECT * FROM production_prompts WHERE project_id = $1 AND ${TARGET_WHERE} AND status = 'current' FOR UPDATE`, [projectId, purpose, ...targetColumns({ assetId, shotId, elementId })])).rows[0];
      let outcome;
      let row;
      if (!current) {
        const version = Number((await client.query(`SELECT COALESCE(MAX(version),0) + 1 AS n FROM production_prompts WHERE project_id = $1 AND ${TARGET_WHERE}`, [projectId, purpose, ...targetColumns({ assetId, shotId, elementId })])).rows[0].n);
        row = (await client.query(
          `INSERT INTO production_prompts (project_id, purpose, asset_id, shot_id, element_id, version, text, params, source_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [projectId, purpose, assetId, shotId, elementId, version, text, JSON.stringify(params), sourceHash, actorUserId]
        )).rows[0];
        outcome = "created";
      } else if (current.edited) {
        // A person's words are never replaced automatically. If the inputs moved on since they wrote it, it is reported
        // ("kept_edited") and shows as out of date until they choose to reset it to the plan.
        row = current;
        outcome = current.source_hash === sourceHash ? "unchanged" : "kept_edited";
      } else if (current.text === text) {
        if (current.source_hash !== sourceHash) await client.query("UPDATE production_prompts SET source_hash = $1 WHERE id = $2", [sourceHash, current.id]);
        row = { ...current, source_hash: sourceHash };
        outcome = "unchanged";
      } else {
        await client.query("UPDATE production_prompts SET status = 'superseded' WHERE id = $1", [current.id]);
        row = (await client.query(
          `INSERT INTO production_prompts (project_id, purpose, asset_id, shot_id, element_id, version, text, params, source_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [projectId, purpose, assetId, shotId, elementId, current.version + 1, text, JSON.stringify(params), sourceHash, actorUserId]
        )).rows[0];
        outcome = "updated";
      }
      await client.query("COMMIT");
      return { prompt: row, outcome };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error.code === "23505" && attempt < 2) continue; // two writers at once; the other one won, look again
      throw error;
    } finally {
      client.release();
    }
  }
  throw httpError("Could not save the prompt, try again.", 409);
}

// A person edits the words. New version, old one kept. The input hash stays the one it was written from, so if the
// inputs have changed since, the edited prompt is shown as stale (not silently overwritten).
export async function editPrompt(db, projectId, purpose, target, text, { actorUserId = null } = {}) {
  const clean = String(text ?? "").trim();
  if (!clean) throw httpError("A prompt cannot be empty.");
  if (clean.length > 6000) throw httpError("A prompt can be at most 6000 characters.");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query(`SELECT * FROM production_prompts WHERE project_id = $1 AND ${TARGET_WHERE} AND status = 'current' FOR UPDATE`, [projectId, purpose, ...targetColumns(target)])).rows[0];
    if (!current) throw httpError("There is no prompt to edit yet. Plan the Blueprint first.", 404, "not_found");
    if (current.text === clean) { await client.query("ROLLBACK"); return current; }
    await client.query("UPDATE production_prompts SET status = 'superseded' WHERE id = $1", [current.id]);
    const row = (await client.query(
      `INSERT INTO production_prompts (project_id, purpose, asset_id, shot_id, element_id, version, text, params, source_hash, edited, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10) RETURNING *`,
      [projectId, purpose, current.asset_id, current.shot_id, current.element_id, current.version + 1, clean, JSON.stringify(current.params), current.source_hash, actorUserId]
    )).rows[0];
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function promptHistory(db, projectId, purpose, target) {
  return (await db.query(`SELECT id, version, status, text, edited, created_at, created_by FROM production_prompts WHERE project_id = $1 AND ${TARGET_WHERE} ORDER BY version DESC`, [projectId, purpose, ...targetColumns(target)])).rows;
}

export const promptView = (p, freshHash = null) => p && ({
  id: p.id, purpose: p.purpose, version: p.version, text: p.text, edited: p.edited, params: p.params, createdAt: p.created_at,
  stale: freshHash !== null && p.source_hash !== freshHash,
});
