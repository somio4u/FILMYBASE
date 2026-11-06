// AI MOVIE → "Rename a character in the whole script" (the Movie screenplay has it; AI Movie did not).
// The name is changed everywhere it is written in the project's own text: the story, synopsis, character arcs, three acts, beat sheet, and every scene
// of the screenplay (who speaks, the action lines, the dialogue and the acting notes) — in English AND Hindi. A name changes only as a WHOLE name
// ("SULA" in "SULA walks in", not in "SULATA"); the case style is kept. Hindi / Odia text keeps whatever script it was written in: to change a name written in
// Devanagari, rename that spelling too (the screen says so).
// Undo: the text exactly as it was before the rename is kept (one rename back); it is put back as a whole.
import { renameInText, validRename } from "./renameCharacter.js";

export { validRename };

// the parts of the project's text that are renamed; everything else (statuses, ids, times, production sheets) is left alone
const TEXT_KEYS = ["story", "synopsis", "characterArc", "threeAct", "plot", "screenplayBeats", "removedScenes"];

// walks any JSON value; strings change, structure stays. `speakerKeys`: keys whose value is a speaker cue (written in capitals, like the screenplay does)
function walk(value, from, to, tally, key = "") {
  if (typeof value === "string") {
    const r = renameInText(value, from, to);
    if (r.count === 0) return value;
    if (key === "character") { tally.speakerLines += r.count; return r.text.toUpperCase(); }
    tally.mentions += r.count;
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, from, to, tally, key));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, from, to, tally, k);
    return out;
  }
  return value;
}

// backfill -> { backfill (new), summary: { scenes, speakerLines, mentions, otherPlaces } }
export function renameInBackfill(backfill, from, to) {
  const next = { ...(backfill ?? {}) };
  const summary = { scenes: 0, speakerLines: 0, mentions: 0, otherPlaces: 0 };
  for (const key of TEXT_KEYS) {
    if (next[key] === undefined || next[key] === null) continue;
    if (key === "screenplayBeats") {
      // counted per scene, so "found in N scenes" is real
      next[key] = next[key].map((beat) => (beat && Array.isArray(beat.scenes) ? { ...beat, scenes: beat.scenes.map((scene) => {
        const tally = { speakerLines: 0, mentions: 0 };
        const changed = walk(scene, from, to, tally);
        if (tally.speakerLines + tally.mentions > 0) { summary.scenes += 1; summary.speakerLines += tally.speakerLines; summary.mentions += tally.mentions; }
        return changed;
      }) } : beat));
    } else if (key === "removedScenes") {
      // scenes kept for "Undo the last removal": renamed too, so bringing one back does not bring the old name back (not counted)
      next[key] = next[key].map((entry) => (entry && entry.scene ? { ...entry, scene: walk(entry.scene, from, to, { speakerLines: 0, mentions: 0 }) } : entry));
    } else {
      const tally = { speakerLines: 0, mentions: 0 };
      next[key] = walk(next[key], from, to, tally);
      summary.otherPlaces += tally.speakerLines + tally.mentions;
    }
  }
  return { backfill: next, summary };
}

// the parts that Undo puts back
export const snapshotOf = (backfill) => Object.fromEntries(TEXT_KEYS.filter((k) => backfill?.[k] !== undefined).map((k) => [k, backfill[k]]));

export async function ensureRenameUndoSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_rename_undo (
    project_id INTEGER PRIMARY KEY REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
    from_name TEXT NOT NULL, to_name TEXT NOT NULL, snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}

const fail = (status, message) => Object.assign(new Error(message), { status });

// preview: only counts. Otherwise: renames, keeps the before-text for Undo, returns the summary.
export async function renameCharacter(db, projectId, { from, to, preview = false }) {
  const problem = validRename(from, to);
  if (problem) throw fail(400, problem);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query("SELECT backfill FROM ai_movie_projects WHERE id = $1 FOR UPDATE", [projectId])).rows[0];
    if (!row) throw fail(404, "Project not found.");
    const result = renameInBackfill(row.backfill ?? {}, from.trim(), to.trim());
    if (!preview && result.summary.scenes + result.summary.mentions + result.summary.speakerLines + result.summary.otherPlaces > 0) {
      await client.query(
        `INSERT INTO ai_movie_rename_undo (project_id, from_name, to_name, snapshot) VALUES ($1,$2,$3,$4)
         ON CONFLICT (project_id) DO UPDATE SET from_name = EXCLUDED.from_name, to_name = EXCLUDED.to_name, snapshot = EXCLUDED.snapshot, created_at = now()`,
        [projectId, from.trim(), to.trim(), JSON.stringify(snapshotOf(row.backfill ?? {}))]
      );
      await client.query("UPDATE ai_movie_projects SET backfill = $1, updated_at = now() WHERE id = $2", [JSON.stringify(result.backfill), projectId]);
    }
    await client.query("COMMIT");
    return { ...result.summary, preview, canUndo: !preview ? true : undefined };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function renameUndoInfo(db, projectId) {
  const r = (await db.query("SELECT from_name, to_name, created_at FROM ai_movie_rename_undo WHERE project_id = $1", [projectId])).rows[0];
  return r ? { canUndo: true, from: r.from_name, to: r.to_name, at: r.created_at } : { canUndo: false };
}

// Undo: puts back the text exactly as it was before the last rename (anything changed after it is lost — the screen says so first)
export async function undoRename(db, projectId) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const undo = (await client.query("SELECT from_name, to_name, snapshot FROM ai_movie_rename_undo WHERE project_id = $1 FOR UPDATE", [projectId])).rows[0];
    if (!undo) throw fail(404, "There is no rename to undo.");
    const row = (await client.query("SELECT backfill FROM ai_movie_projects WHERE id = $1 FOR UPDATE", [projectId])).rows[0];
    if (!row) throw fail(404, "Project not found.");
    await client.query("UPDATE ai_movie_projects SET backfill = $1, updated_at = now() WHERE id = $2", [JSON.stringify({ ...(row.backfill ?? {}), ...undo.snapshot }), projectId]);
    await client.query("DELETE FROM ai_movie_rename_undo WHERE project_id = $1", [projectId]);
    await client.query("COMMIT");
    return { restored: true, from: undo.from_name, to: undo.to_name };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
