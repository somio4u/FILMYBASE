// Pipeline steps 2 and 3: shot division and the text-only storyboard.
//
// A "shot" is one continuous camera view. Each scene is cut into numbered shots
// (SH001, SH002... — the code never changes, even if shots are re-ordered).
// Where the screenplay already has shot notes they become the shots. Where it
// does not, the AI writes them (or, with no AI available, a plain rule-based cut
// is made). Every shot records the framing, camera, who/what/where is in it,
// and which dialogue lines (D001...) it covers. The storyboard is a short
// written description of each shot's picture — no images.

import { phrasesOf, contains, normalizeForMatch } from "./screenplayAnalysis.js";

export async function ensureShotSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS production_shots (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      scene_id INTEGER NOT NULL REFERENCES production_scenes(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      framing TEXT,
      camera_angle TEXT,
      camera_move TEXT,
      description TEXT NOT NULL DEFAULT '',
      duration_sec NUMERIC NOT NULL DEFAULT 4,
      source TEXT NOT NULL DEFAULT 'manual',
      source_label TEXT,
      storyboard_text TEXT NOT NULL DEFAULT '',
      storyboard_status TEXT NOT NULL DEFAULT 'draft',
      edited BOOLEAN NOT NULL DEFAULT FALSE,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (project_id, code)
    )`,
    `CREATE INDEX IF NOT EXISTS production_shots_scene_idx ON production_shots (scene_id, order_index)`,
    `CREATE TABLE IF NOT EXISTS production_shot_assets (
      shot_id INTEGER NOT NULL REFERENCES production_shots(id) ON DELETE CASCADE,
      asset_id INTEGER NOT NULL REFERENCES production_assets(id) ON DELETE CASCADE,
      PRIMARY KEY (shot_id, asset_id)
    )`,
    `CREATE TABLE IF NOT EXISTS production_shot_dialogue (
      shot_id INTEGER NOT NULL REFERENCES production_shots(id) ON DELETE CASCADE,
      element_id INTEGER NOT NULL REFERENCES production_scene_elements(id) ON DELETE CASCADE,
      PRIMARY KEY (shot_id, element_id)
    )`,
  ];
  for (const sql of statements) await db.query(sql);
}

const httpError = (message, status = 400, code = "bad_request") => Object.assign(new Error(message), { status, code });

// ---------------------------------------------------------------------------
// Reading a shot note like "Close-up: Rahul's hands buttoning the shirt"
// ---------------------------------------------------------------------------

const FRAMINGS = [
  [/\bover[- ]the[- ]shoulder\b|\bOTS\b/i, "Over-the-shoulder"],
  [/\bextreme close[- ]?up\b|\bECU\b/i, "Extreme close-up"],
  [/\bmedium close[- ]?up\b|\bMCU\b/i, "Medium close-up"],
  [/\bclose[- ]?up\b|\bCU\b/i, "Close-up"],
  [/\bPOV\b|point of view/i, "POV"],
  [/\btwo[- ]shot\b/i, "Two-shot"],
  [/\binsert\b/i, "Insert"],
  [/\bmid[- ]?shot\b|\bmedium (?:wide )?shot\b|\bMS\b/i, "Medium"],
  [/\bwide\b|\bestablishing\b|\blong shot\b|\bWS\b|\bextreme wide\b/i, "Wide"],
];
const MOVES = [
  [/\brack focus\b/i, "Rack focus"],
  [/\bpush[- ]in\b|\bdolly in\b|\bslow push\b/i, "Push-in"],
  [/\bpull[- ]?back\b|\bdolly out\b|\bpull out\b/i, "Pull-back"],
  [/\bpan(?:s|ning)?\b/i, "Pan"],
  [/\btilt(?:s|ing)?\b/i, "Tilt"],
  [/\btrack(?:s|ing)?\b|\bdolly\b/i, "Tracking"],
  [/\bhandheld\b/i, "Handheld"],
  [/\bcrane\b|\bdrone\b|\baerial\b/i, "Crane / aerial"],
  [/\bzoom\b/i, "Zoom"],
];
const ANGLES = [
  [/\bbird'?s[- ]eye\b|\boverhead\b|\btop[- ]down\b/i, "Overhead"],
  [/\blow[- ]angle\b/i, "Low angle"],
  [/\bhigh[- ]angle\b/i, "High angle"],
  [/\bdutch\b/i, "Dutch angle"],
];
const first = (table, text) => table.find(([re]) => re.test(text))?.[1] ?? null;

export function readShotNote(text) {
  const t = String(text ?? "");
  const lead = t.split(/[:—–]/)[0];
  return {
    framing: first(FRAMINGS, lead) ?? first(FRAMINGS, t),
    cameraMove: first(MOVES, t),
    cameraAngle: first(ANGLES, t),
  };
}

// ---------------------------------------------------------------------------
// Pure shot builders (no database)
// ---------------------------------------------------------------------------

// scene.elements: [{id, kind, speaker, text, label?, code?}] in order.
export function shotsFromScriptNotes(elements) {
  const shots = [];
  let pendingDialogue = [];
  for (const e of elements) {
    if (e.kind === "shot_hint") {
      shots.push({ ...readShotNote(e.text), description: e.text, sourceLabel: e.label ?? null, dialogueIds: [], source: "script" });
      continue;
    }
    if (e.kind === "dialogue") {
      if (shots.length === 0) pendingDialogue.push(e.id);
      else shots[shots.length - 1].dialogueIds.push(e.id);
    }
  }
  if (shots.length > 0 && pendingDialogue.length > 0) shots[0].dialogueIds = [...pendingDialogue, ...shots[0].dialogueIds];
  return shots;
}

// A plain cut with no AI: one wide establishing shot, then one shot per action
// paragraph and one per spoken line.
export function shotsFromRules(scene, elements) {
  const shots = [];
  const place = [scene.location, scene.time_of_day].filter(Boolean).join(", ");
  const firstAction = elements.find((e) => e.kind === "action");
  shots.push({ framing: "Wide", cameraAngle: null, cameraMove: null, description: `Establishing view of ${place || scene.heading}.${firstAction ? "" : ""}`.trim(), dialogueIds: [], source: "rules" });
  for (const e of elements) {
    if (e.kind === "action") shots.push({ ...readShotNote(e.text), framing: readShotNote(e.text).framing ?? "Medium", description: e.text, dialogueIds: [], source: "rules" });
    else if (e.kind === "dialogue") shots.push({ framing: "Medium close-up", cameraAngle: "Eye level", cameraMove: null, description: `${e.speaker ?? "Someone"} speaks${e.parenthetical ? ` (${e.parenthetical})` : ""}.`, dialogueIds: [e.id], source: "rules" });
  }
  return shots;
}

function clean(value, max = 200) {
  if (typeof value !== "string") return null;
  const v = value.replace(/\s+/g, " ").trim();
  return v ? v.slice(0, max) : null;
}

// Checks what the AI sent and keeps only what is usable.
export function validateAiShots(raw, elements) {
  const list = Array.isArray(raw?.shots) ? raw.shots : [];
  const byCode = new Map(elements.filter((e) => e.kind === "dialogue" && e.code).map((e) => [e.code, e.id]));
  const used = new Set();
  const shots = [];
  for (const item of list.slice(0, 60)) {
    const description = clean(item?.description, 1200);
    if (!description) continue;
    const dialogueIds = [];
    for (const code of Array.isArray(item.dialogueCodes) ? item.dialogueCodes : []) {
      const id = byCode.get(String(code).toUpperCase());
      if (id && !used.has(id)) { used.add(id); dialogueIds.push(id); }
    }
    const duration = Number(item.durationSec);
    shots.push({
      framing: clean(item.framing, 60), cameraAngle: clean(item.cameraAngle, 60), cameraMove: clean(item.cameraMove, 60), description,
      durationSec: Number.isFinite(duration) && duration >= 1 && duration <= 30 ? duration : null, dialogueIds,
      names: [...(Array.isArray(item.characters) ? item.characters : []), ...(Array.isArray(item.props) ? item.props : [])].filter((n) => typeof n === "string").slice(0, 20),
      source: "ai",
    });
  }
  // Every spoken line must be inside some shot: stray lines join the nearest earlier shot.
  const missing = [...byCode.values()].filter((id) => !used.has(id));
  if (shots.length > 0) {
    for (const id of missing) {
      const index = elements.findIndex((e) => e.id === id);
      let target = shots.length - 1;
      for (let i = index - 1; i >= 0; i--) {
        const owner = shots.findIndex((s) => s.dialogueIds.includes(elements[i].id));
        if (owner >= 0) { target = owner; break; }
      }
      shots[target].dialogueIds.push(id);
    }
  }
  return shots;
}

function sceneForPrompt(scene, elements, assets) {
  const lines = elements.map((e) => {
    if (e.kind === "dialogue") return `[${e.code}] ${e.speaker}${e.parenthetical ? ` (${e.parenthetical})` : ""}: ${e.text_en || e.text_hi}`;
    if (e.kind === "shot_hint") return `[script shot note] ${e.text_en || e.text_hi}`;
    return `${e.kind}: ${e.text_en || e.text_hi}`;
  });
  return `SCENE ${scene.scene_number} — ${scene.heading}\nPeople, objects and places known in this scene: ${assets.map((a) => `${a.name} (${a.kind})`).join("; ") || "none listed"}\n\n${lines.join("\n")}`;
}

export function shotDivisionPrompt(scene, elements, assets) {
  return `You are an experienced film director preparing a shot list. Divide the scene below into numbered camera shots.

Rules:
- One shot = one continuous camera view. Typical length 2-8 seconds.
- Cover everything that happens on screen, in order. Do not invent new story events.
- Include an establishing shot when the place changes.
- For every spoken line (marked like [D004]) put its code in exactly one shot's dialogueCodes. A shot may hold several lines of one exchange.
- framing: one of Wide, Medium, Medium close-up, Close-up, Extreme close-up, Over-the-shoulder, POV, Two-shot, Insert.
- cameraAngle: e.g. Eye level, Low angle, High angle, Overhead. cameraMove: e.g. Static, Pan, Tilt, Push-in, Tracking, Handheld.
- description: ONE concrete sentence of what the camera SEES (no sound, no thoughts).
- characters / props: use the exact names from the known list when they are visible in the shot.
- durationSec: a number from 1 to 12.

Return JSON only: {"shots":[{"framing":"","cameraAngle":"","cameraMove":"","description":"","durationSec":4,"characters":[],"props":[],"dialogueCodes":[]}]}

${sceneForPrompt(scene, elements, assets)}`;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

async function nextShotCode(client, projectId) {
  const n = Number((await client.query("SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::int), 0) AS n FROM production_shots WHERE project_id = $1", [projectId])).rows[0].n);
  return n;
}

async function sceneContext(client, projectId, sceneId) {
  const scene = (await client.query("SELECT * FROM production_scenes WHERE id = $1 AND project_id = $2", [sceneId, projectId])).rows[0];
  if (!scene) return null;
  const elements = (await client.query("SELECT id, kind, code, speaker, extension, parenthetical, label, text_en, text_hi, order_index FROM production_scene_elements WHERE scene_id = $1 ORDER BY order_index", [sceneId])).rows
    .map((e) => ({ ...e, text: e.text_en || e.text_hi || "" }));
  const assets = (await client.query(
    `SELECT a.id, a.kind, a.code, a.name, a.aliases FROM production_scene_assets sa JOIN production_assets a ON a.id = sa.asset_id WHERE sa.scene_id = $1 ORDER BY a.kind, a.code`, [sceneId]
  )).rows.map((a) => ({ ...a, aliases: a.aliases ?? [] }));
  return { scene, elements, assets };
}

// Which dossier items are in this shot: named in its description, speaking in
// it, plus the scene's place. `names` are extra names the AI listed.
export function assetsForShot(shot, elements, sceneAssets) {
  const text = normalizeForMatch(shot.description);
  const speakers = elements.filter((e) => shot.dialogueIds.includes(e.id) && e.speaker).map((e) => normalizeForMatch(e.speaker).replace(/^the /, ""));
  const aiNames = (shot.names ?? []).map((n) => normalizeForMatch(n)).filter(Boolean);
  const ids = new Set();
  let locationAdded = false;
  for (const a of sceneAssets) {
    const phrases = phrasesOf(a);
    if (a.kind === "location") {
      if (!locationAdded && (phrases.some((ph) => contains(text, ph)) || aiNames.some((n) => phrases.includes(n)))) { ids.add(a.id); locationAdded = true; }
      continue;
    }
    const named = phrases.some((ph) => contains(text, ph)) || aiNames.some((n) => phrases.some((ph) => ph === n || contains(ph, n)));
    const speaks = a.kind === "character" && speakers.some((sp) => phrases.some((ph) => ph === sp || contains(ph, sp)));
    if (named || speaks) ids.add(a.id);
  }
  if (!locationAdded) {
    const loc = sceneAssets.find((a) => a.kind === "location");
    if (loc) ids.add(loc.id);
  }
  return [...ids];
}

async function insertShots(client, projectId, scene, elements, assets, shots, startOrder = 0) {
  let counter = await nextShotCode(client, projectId);
  const out = [];
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    counter += 1;
    const code = `SH${String(counter).padStart(3, "0")}`;
    const row = (await client.query(
      `INSERT INTO production_shots (project_id, scene_id, code, order_index, framing, camera_angle, camera_move, description, duration_sec, source, source_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [projectId, scene.id, code, startOrder + i, s.framing ?? null, s.cameraAngle ?? null, s.cameraMove ?? null, s.description, s.durationSec ?? 4, s.source ?? "manual", s.sourceLabel ?? null]
    )).rows[0];
    for (const id of s.dialogueIds ?? []) await client.query("INSERT INTO production_shot_dialogue (shot_id, element_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [row.id, id]);
    for (const assetId of assetsForShot({ ...s, dialogueIds: s.dialogueIds ?? [] }, elements, assets)) {
      await client.query("INSERT INTO production_shot_assets (shot_id, asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [row.id, assetId]);
    }
    out.push(row);
  }
  return out;
}

// Cuts one scene into shots. mode: "auto" (script notes, else AI, else rules),
// "script", "ai", "rules". Refuses when the scene already has shots unless
// replace is true; refuses to replace shots that already have pictures/sound/video.
export async function divideScene(db, projectId, sceneId, { mode = "auto", replace = false, textJson = null, actorUserId = null } = {}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM production_scenes WHERE id = $1 FOR UPDATE", [sceneId]);
    const ctx = await sceneContext(client, projectId, sceneId);
    if (!ctx) { await client.query("ROLLBACK"); return { outcome: "not_found" }; }
    const existing = (await client.query("SELECT id FROM production_shots WHERE scene_id = $1", [sceneId])).rows;
    if (existing.length > 0 && !replace) { await client.query("ROLLBACK"); return { outcome: "exists", count: existing.length }; }
    if (existing.length > 0) {
      const made = (await client.query("SELECT count(*)::int AS n FROM production_generations WHERE shot_id = ANY($1)", [existing.map((s) => s.id)])).rows[0].n;
      if (made > 0) throw httpError("Pictures, sound or video were already made for these shots. Edit the shots one by one instead of cutting the scene again.", 409, "has_generations");
    }
    await client.query("COMMIT");

    // The AI call happens outside the transaction (it can take a while).
    let shots = [];
    let used = mode;
    const hasNotes = ctx.elements.some((e) => e.kind === "shot_hint");
    if (mode === "script" || (mode === "auto" && hasNotes)) {
      shots = shotsFromScriptNotes(ctx.elements);
      used = "script";
      if (shots.length === 0) throw httpError("This scene has no shot notes in the screenplay. Use the AI or the simple cut instead.", 400, "no_notes");
    } else if ((mode === "ai" || mode === "auto") && textJson) {
      let aiError = null;
      try {
        shots = validateAiShots(await textJson(shotDivisionPrompt(ctx.scene, ctx.elements, ctx.assets)), ctx.elements);
      } catch (error) {
        aiError = error;
      }
      used = "ai";
      if (shots.length === 0) {
        if (mode === "ai") throw httpError(`The AI could not cut this scene${aiError ? ` (${aiError.message})` : ""}. Try again, or use the simple cut.`, 502, "ai_failed");
        shots = shotsFromRules(ctx.scene, ctx.elements);
        used = "rules";
      }
    } else if (mode === "ai") {
      throw httpError("The AI is not available on this server right now.", 503, "not_configured");
    } else {
      shots = shotsFromRules(ctx.scene, ctx.elements);
      used = "rules";
    }
    if (shots.length === 0) throw httpError("Nothing in this scene could be turned into shots.", 400, "empty_scene");

    await client.query("BEGIN");
    if (existing.length > 0) await client.query("DELETE FROM production_shots WHERE scene_id = $1", [sceneId]);
    const rows = await insertShots(client, projectId, ctx.scene, ctx.elements, ctx.assets, shots);
    await client.query(
      "INSERT INTO production_audit_events (project_id, actor_user_id, action, entity, entity_id, detail) VALUES ($1,$2,'scene_divided','scene',$3,$4)",
      [projectId, actorUserId, String(sceneId), JSON.stringify({ mode: used, shots: rows.length, replaced: existing.length })]
    );
    await client.query("COMMIT");
    return { outcome: "divided", mode: used, count: rows.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listShots(db, projectId, { sceneId = null } = {}) {
  const params = [projectId];
  let where = "s.project_id = $1";
  if (sceneId) { params.push(sceneId); where += " AND s.scene_id = $2"; }
  const rows = (await db.query(
    `SELECT s.*, sc.code AS scene_code, sc.scene_number, sc.order_index AS scene_order, sc.heading
     FROM production_shots s JOIN production_scenes sc ON sc.id = s.scene_id WHERE ${where} AND sc.in_latest ORDER BY sc.order_index, s.order_index`, params
  )).rows;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const assets = (await db.query(
    `SELECT sa.shot_id, a.id, a.code, a.name, a.kind FROM production_shot_assets sa JOIN production_assets a ON a.id = sa.asset_id WHERE sa.shot_id = ANY($1) ORDER BY a.kind, a.code`, [ids]
  )).rows;
  const dialogue = (await db.query(
    `SELECT sd.shot_id, e.id, e.code, e.speaker, e.text_en, e.text_hi, e.parenthetical FROM production_shot_dialogue sd JOIN production_scene_elements e ON e.id = sd.element_id
     WHERE sd.shot_id = ANY($1) ORDER BY e.order_index`, [ids]
  )).rows;
  const counters = new Map();
  return rows.map((r) => {
    const n = (counters.get(r.scene_id) ?? 0) + 1;
    counters.set(r.scene_id, n);
    return {
      id: r.id, code: r.code, sceneId: r.scene_id, sceneCode: r.scene_code, sceneNumber: r.scene_number, number: `${r.scene_number}.${n}`, heading: r.heading,
      framing: r.framing, cameraAngle: r.camera_angle, cameraMove: r.camera_move, description: r.description, durationSec: Number(r.duration_sec),
      source: r.source, sourceLabel: r.source_label, storyboardText: r.storyboard_text, storyboardStatus: r.storyboard_status, edited: r.edited, revision: r.revision,
      assets: assets.filter((a) => a.shot_id === r.id).map(({ id, code, name, kind }) => ({ id, code, name, kind })),
      dialogue: dialogue.filter((d) => d.shot_id === r.id).map((d) => ({ id: d.id, code: d.code, speaker: d.speaker, parenthetical: d.parenthetical, text: d.text_en || d.text_hi })),
    };
  });
}

async function loadShot(client, projectId, shotId) {
  const shot = (await client.query("SELECT * FROM production_shots WHERE id = $1 AND project_id = $2", [shotId, projectId])).rows[0];
  if (!shot) throw httpError("Shot not found.", 404, "not_found");
  return shot;
}

async function renumber(client, sceneId) {
  const rows = (await client.query("SELECT id FROM production_shots WHERE scene_id = $1 ORDER BY order_index, id", [sceneId])).rows;
  for (let i = 0; i < rows.length; i++) await client.query("UPDATE production_shots SET order_index = $1 WHERE id = $2", [i, rows[i].id]);
}

const EDITABLE = { framing: 60, cameraAngle: 60, cameraMove: 60, description: 1500 };

export async function updateShot(db, projectId, shotId, { expectedRevision, edits }) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const shot = await loadShot(client, projectId, shotId);
    if (expectedRevision !== undefined && Number(expectedRevision) !== shot.revision) throw httpError("Someone changed this shot since you opened it. Reload and try again.", 409, "stale");
    const sets = [];
    const values = [];
    const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };
    for (const [key, max] of Object.entries(EDITABLE)) {
      if (edits[key] === undefined) continue;
      if (edits[key] !== null && typeof edits[key] !== "string") throw httpError(`${key} must be text.`);
      const v = edits[key] === null ? null : edits[key].trim().slice(0, max);
      if (key === "description" && !v) throw httpError("A shot needs a description.");
      push({ framing: "framing", cameraAngle: "camera_angle", cameraMove: "camera_move", description: "description" }[key], v || (key === "description" ? "" : null));
    }
    if (edits.durationSec !== undefined) {
      const d = Number(edits.durationSec);
      if (!Number.isFinite(d) || d < 1 || d > 30) throw httpError("Shot length must be between 1 and 30 seconds.");
      push("duration_sec", d);
    }
    if (edits.storyboardText !== undefined) {
      if (typeof edits.storyboardText !== "string" || edits.storyboardText.length > 4000) throw httpError("The storyboard text must be text under 4000 characters.");
      push("storyboard_text", edits.storyboardText.trim());
      push("storyboard_status", "draft");
    }
    if (sets.length > 0) await client.query(`UPDATE production_shots SET ${sets.join(", ")}, edited = TRUE, revision = revision + 1, updated_at = now() WHERE id = ${Number(shot.id)}`, values);
    if (Array.isArray(edits.assetIds)) {
      const valid = (await client.query("SELECT id FROM production_assets WHERE project_id = $1 AND id = ANY($2)", [projectId, edits.assetIds.map(Number).filter(Number.isInteger)])).rows.map((r) => r.id);
      await client.query("DELETE FROM production_shot_assets WHERE shot_id = $1", [shot.id]);
      for (const id of valid) await client.query("INSERT INTO production_shot_assets (shot_id, asset_id) VALUES ($1,$2)", [shot.id, id]);
      await client.query("UPDATE production_shots SET edited = TRUE, revision = revision + 1, updated_at = now() WHERE id = $1", [shot.id]);
    }
    if (Array.isArray(edits.dialogueIds)) {
      const valid = (await client.query("SELECT id FROM production_scene_elements WHERE scene_id = $1 AND kind = 'dialogue' AND id = ANY($2)", [shot.scene_id, edits.dialogueIds.map(Number).filter(Number.isInteger)])).rows.map((r) => r.id);
      await client.query("DELETE FROM production_shot_dialogue WHERE shot_id = $1", [shot.id]);
      for (const id of valid) await client.query("INSERT INTO production_shot_dialogue (shot_id, element_id) VALUES ($1,$2)", [shot.id, id]);
      await client.query("UPDATE production_shots SET edited = TRUE, revision = revision + 1, updated_at = now() WHERE id = $1", [shot.id]);
    }
    await client.query("COMMIT");
    return (await listShots(db, projectId)).find((s) => s.id === shot.id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function addShot(db, projectId, sceneId, { afterShotId = null, description = "", framing = null, durationSec = 4 } = {}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM production_scenes WHERE id = $1 FOR UPDATE", [sceneId]);
    const ctx = await sceneContext(client, projectId, sceneId);
    if (!ctx) throw httpError("Scene not found.", 404, "not_found");
    const text = String(description ?? "").trim() || "New shot";
    let position = Number((await client.query("SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM production_shots WHERE scene_id = $1", [sceneId])).rows[0].n);
    if (afterShotId) {
      const after = await loadShot(client, projectId, afterShotId);
      if (after.scene_id !== sceneId) throw httpError("That shot is in a different scene.");
      position = after.order_index + 1;
      await client.query("UPDATE production_shots SET order_index = order_index + 1 WHERE scene_id = $1 AND order_index >= $2", [sceneId, position]);
    }
    const [row] = await insertShots(client, projectId, ctx.scene, ctx.elements, ctx.assets, [{ framing, description: text.slice(0, 1500), durationSec, dialogueIds: [], source: "manual" }], position);
    await renumber(client, sceneId);
    await client.query("COMMIT");
    return (await listShots(db, projectId)).find((s) => s.id === row.id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteShot(db, projectId, shotId) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const shot = await loadShot(client, projectId, shotId);
    const made = (await client.query("SELECT count(*)::int AS n FROM production_generations WHERE shot_id = $1", [shotId])).rows[0].n;
    if (made > 0) throw httpError("Pictures, sound or video were already made for this shot, so it cannot be deleted.", 409, "has_generations");
    await client.query("DELETE FROM production_shots WHERE id = $1", [shotId]);
    await renumber(client, shot.scene_id);
    await client.query("COMMIT");
    return { deleted: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Splits a shot in two: the new shot goes right after it, takes the second half
// of the dialogue lines, and starts with the same people and places.
export async function splitShot(db, projectId, shotId) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const shot = await loadShot(client, projectId, shotId);
    await client.query("SELECT id FROM production_scenes WHERE id = $1 FOR UPDATE", [shot.scene_id]);
    const made = (await client.query("SELECT count(*)::int AS n FROM production_generations WHERE shot_id = $1", [shotId])).rows[0].n;
    if (made > 0) throw httpError("Pictures, sound or video were already made for this shot, so it cannot be split.", 409, "has_generations");
    const lines = (await client.query(
      "SELECT sd.element_id FROM production_shot_dialogue sd JOIN production_scene_elements e ON e.id = sd.element_id WHERE sd.shot_id = $1 ORDER BY e.order_index", [shotId]
    )).rows.map((r) => r.element_id);
    const move = lines.slice(Math.ceil(lines.length / 2));
    await client.query("UPDATE production_shots SET order_index = order_index + 1 WHERE scene_id = $1 AND order_index > $2", [shot.scene_id, shot.order_index]);
    let counter = await nextShotCode(client, projectId);
    const row = (await client.query(
      `INSERT INTO production_shots (project_id, scene_id, code, order_index, framing, camera_angle, camera_move, description, duration_sec, source, edited)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',TRUE) RETURNING *`,
      [projectId, shot.scene_id, `SH${String(++counter).padStart(3, "0")}`, shot.order_index + 1, shot.framing, shot.camera_angle, shot.camera_move, `${shot.description} (continued)`, shot.duration_sec]
    )).rows[0];
    await client.query("INSERT INTO production_shot_assets (shot_id, asset_id) SELECT $1, asset_id FROM production_shot_assets WHERE shot_id = $2", [row.id, shotId]);
    for (const id of move) {
      await client.query("DELETE FROM production_shot_dialogue WHERE shot_id = $1 AND element_id = $2", [shotId, id]);
      await client.query("INSERT INTO production_shot_dialogue (shot_id, element_id) VALUES ($1,$2)", [row.id, id]);
    }
    await client.query("UPDATE production_shots SET edited = TRUE, revision = revision + 1, updated_at = now() WHERE id = $1", [shotId]);
    await renumber(client, shot.scene_id);
    await client.query("COMMIT");
    return (await listShots(db, projectId, { sceneId: shot.scene_id })).filter((s) => s.id === shotId || s.id === row.id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Merges a shot with the one after it (descriptions joined, lengths added).
export async function mergeShotWithNext(db, projectId, shotId) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const shot = await loadShot(client, projectId, shotId);
    await client.query("SELECT id FROM production_scenes WHERE id = $1 FOR UPDATE", [shot.scene_id]);
    const next = (await client.query("SELECT * FROM production_shots WHERE scene_id = $1 AND order_index > $2 ORDER BY order_index LIMIT 1", [shot.scene_id, shot.order_index])).rows[0];
    if (!next) throw httpError("There is no shot after this one to merge with.", 400, "no_next");
    const made = (await client.query("SELECT count(*)::int AS n FROM production_generations WHERE shot_id = ANY($1)", [[shot.id, next.id]])).rows[0].n;
    if (made > 0) throw httpError("Pictures, sound or video were already made for one of these shots, so they cannot be merged.", 409, "has_generations");
    await client.query("INSERT INTO production_shot_dialogue (shot_id, element_id) SELECT $1, element_id FROM production_shot_dialogue WHERE shot_id = $2 ON CONFLICT DO NOTHING", [shot.id, next.id]);
    await client.query("INSERT INTO production_shot_assets (shot_id, asset_id) SELECT $1, asset_id FROM production_shot_assets WHERE shot_id = $2 ON CONFLICT DO NOTHING", [shot.id, next.id]);
    await client.query(
      `UPDATE production_shots SET description = $1, duration_sec = $2, storyboard_status = 'draft', edited = TRUE, revision = revision + 1, updated_at = now() WHERE id = $3`,
      [`${shot.description} ${next.description}`.slice(0, 1500), Math.min(30, Number(shot.duration_sec) + Number(next.duration_sec)), shot.id]
    );
    await client.query("DELETE FROM production_shots WHERE id = $1", [next.id]);
    await renumber(client, shot.scene_id);
    await client.query("COMMIT");
    return (await listShots(db, projectId)).find((s) => s.id === shot.id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Text storyboard
// ---------------------------------------------------------------------------

// A plain description built from the shot's own fields (works with no AI).
export function storyboardFromTemplate(shot) {
  const camera = [shot.framing, shot.cameraAngle, shot.cameraMove].filter(Boolean).join(" · ");
  const who = shot.assets.filter((a) => a.kind === "character").map((a) => a.name);
  const where = shot.assets.find((a) => a.kind === "location")?.name;
  const things = shot.assets.filter((a) => a.kind === "prop" || a.kind === "other").map((a) => a.name);
  const parts = [`${camera || "Shot"}. ${shot.description.replace(/^[^:]{0,40}:\s*/, "")}`.trim()];
  if (who.length) parts.push(`In frame: ${who.join(", ")}.`);
  if (things.length) parts.push(`Objects: ${things.join(", ")}.`);
  if (where) parts.push(`Place: ${where}.`);
  if (shot.dialogue.length) parts.push(`Speaking: ${shot.dialogue.map((d) => `${d.speaker} [${d.code}]`).join(", ")}.`);
  return parts.join(" ");
}

export function storyboardPrompt(shots, sceneHeading) {
  return `You are a storyboard artist writing text-only storyboard frames for a film. For each shot below, write ONE vivid paragraph (2-4 sentences) describing exactly what the picture shows: the framing, where people stand, what they do, light and mood, and the important objects. Describe only what is visible (no sound, no inner thoughts). Keep every fact in the shot description; do not add new story events. Keep the shot codes.

Scene: ${sceneHeading}

Shots:
${shots.map((s) => `${s.code} | ${[s.framing, s.cameraAngle, s.cameraMove].filter(Boolean).join(" / ")} | ${s.description} | people/objects: ${s.assets.map((a) => a.name).join(", ") || "none"} | lines: ${s.dialogue.map((d) => `${d.speaker}: ${d.text}`).join(" / ") || "none"}`).join("\n")}

Return JSON only: {"frames":[{"code":"SH001","text":"..."}]}`;
}

// Writes storyboard text for every shot of a scene that has none yet (or all of
// them when overwrite is true). Never touches shots you edited by hand unless
// overwrite is true.
export async function generateStoryboard(db, projectId, sceneId, { textJson = null, overwrite = false } = {}) {
  const shots = await listShots(db, projectId, { sceneId });
  if (shots.length === 0) throw httpError("Cut this scene into shots first.", 400, "no_shots");
  const targets = shots.filter((s) => overwrite || !s.storyboardText);
  if (targets.length === 0) return { outcome: "nothing_to_do", written: 0 };
  let byCode = new Map();
  let used = "template";
  if (textJson) {
    try {
      const raw = await textJson(storyboardPrompt(targets, shots[0].heading));
      for (const f of Array.isArray(raw?.frames) ? raw.frames : []) {
        const text = clean(f?.text, 4000);
        if (text && typeof f.code === "string") byCode.set(f.code.toUpperCase(), text);
      }
      if (byCode.size > 0) used = "ai";
    } catch {
      byCode = new Map();
    }
  }
  let written = 0;
  for (const s of targets) {
    const text = byCode.get(s.code) ?? storyboardFromTemplate(s);
    await db.query("UPDATE production_shots SET storyboard_text = $1, storyboard_status = 'draft', revision = revision + 1, updated_at = now() WHERE id = $2", [text, s.id]);
    written++;
  }
  return { outcome: "written", written, mode: used };
}

// Approving a scene's storyboard is what lets its shots go on to pictures.
export async function approveStoryboard(db, projectId, sceneId, { approved = true } = {}) {
  const shots = await listShots(db, projectId, { sceneId });
  if (shots.length === 0) throw httpError("This scene has no shots yet.", 400, "no_shots");
  if (approved && shots.some((s) => !s.storyboardText)) throw httpError("Every shot needs its storyboard text before you can approve the scene.", 400, "missing_text");
  await db.query("UPDATE production_shots SET storyboard_status = $1 WHERE scene_id = $2 AND project_id = $3", [approved ? "approved" : "draft", sceneId, projectId]);
  return { approved, shots: shots.length };
}
