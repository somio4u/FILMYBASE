// AI MOVIE → "Undo / Redo" of changes to the scenes of a beat (the Movie screenplay has it: every change is a new version; AI Movie kept only the latest text).
// Every change made by hand or by the AI to the scenes of a beat — an edit, an AI rewrite, a dialogue write, "Extend", the Cinematic Director, add / move / remove a
// scene — first saves how that beat's scenes were. "Undo" puts the newest saved state back (and keeps the state it replaced, so "Redo" can bring it again).
// One list per project, the newest 30. A NEW change throws away the "redo" states (like any editor). Writing the whole screenplay by the background job is NOT kept
// here (that is not an edit to undo). Undo brings back that beat's scenes as a whole.
const KEEP = 30;

export async function ensureSceneHistorySchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_scene_history (
    id SERIAL PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE, beat_index INTEGER NOT NULL,
    label TEXT NOT NULL, before_scenes JSONB NOT NULL, after_scenes JSONB, undone BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await db.query("CREATE INDEX IF NOT EXISTS ai_movie_scene_history_project ON ai_movie_scene_history (project_id, id)");
}

// the beats whose scenes really changed between two saves (both written beforehand and now): [{ beatIndex, before }]
export function changedBeats(beforeBeats, afterBeats) {
  const out = [];
  (Array.isArray(afterBeats) ? afterBeats : []).forEach((after, beatIndex) => {
    const before = Array.isArray(beforeBeats) ? beforeBeats[beatIndex] : null;
    if (!before || !Array.isArray(before.scenes) || before.scenes.length === 0 || !Array.isArray(after?.scenes)) return;
    if (JSON.stringify(before.scenes) !== JSON.stringify(after.scenes)) out.push({ beatIndex, before: before.scenes });
  });
  return out;
}

// db may be a pool or a client. A new change clears the redo states.
export async function recordChanges(db, projectId, changes, label) {
  if (!changes || changes.length === 0) return 0;
  await db.query("DELETE FROM ai_movie_scene_history WHERE project_id = $1 AND undone", [projectId]);
  for (const c of changes) await db.query("INSERT INTO ai_movie_scene_history (project_id, beat_index, label, before_scenes) VALUES ($1,$2,$3,$4)", [projectId, c.beatIndex, String(label).slice(0, 120), JSON.stringify(c.before)]);
  await db.query("DELETE FROM ai_movie_scene_history WHERE project_id = $1 AND id NOT IN (SELECT id FROM ai_movie_scene_history WHERE project_id = $1 ORDER BY id DESC LIMIT $2)", [projectId, KEEP]);
  return changes.length;
}

export async function historyInfo(db, projectId) {
  const undo = (await db.query("SELECT beat_index, label FROM ai_movie_scene_history WHERE project_id = $1 AND NOT undone ORDER BY id DESC LIMIT 1", [projectId])).rows[0];
  const redo = (await db.query("SELECT beat_index, label FROM ai_movie_scene_history WHERE project_id = $1 AND undone ORDER BY id ASC LIMIT 1", [projectId])).rows[0];
  return { canUndo: Boolean(undo), canRedo: Boolean(redo), undoLabel: undo?.label ?? null, undoBeat: undo?.beat_index ?? null, redoLabel: redo?.label ?? null, redoBeat: redo?.beat_index ?? null };
}

const fail = (status, message) => Object.assign(new Error(message), { status });

async function swap(db, projectId, direction) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query("SELECT backfill FROM ai_movie_projects WHERE id = $1 FOR UPDATE", [projectId])).rows[0];
    if (!row) throw fail(404, "Project not found.");
    const undoing = direction === "undo";
    const entry = (await client.query(
      undoing ? "SELECT * FROM ai_movie_scene_history WHERE project_id = $1 AND NOT undone ORDER BY id DESC LIMIT 1 FOR UPDATE" : "SELECT * FROM ai_movie_scene_history WHERE project_id = $1 AND undone ORDER BY id ASC LIMIT 1 FOR UPDATE", [projectId]
    )).rows[0];
    if (!entry) throw fail(404, undoing ? "There is nothing to undo." : "There is nothing to redo.");
    const beats = Array.isArray(row.backfill?.screenplayBeats) ? row.backfill.screenplayBeats.slice() : [];
    const beat = beats[entry.beat_index];
    if (!beat || !Array.isArray(beat.scenes)) throw fail(409, "That part of the screenplay is no longer there, so it cannot be put back.");
    const restore = undoing ? entry.before_scenes : entry.after_scenes;
    if (!Array.isArray(restore)) throw fail(409, "That state was not kept.");
    beats[entry.beat_index] = { ...beat, scenes: restore };
    await client.query("UPDATE ai_movie_projects SET backfill = $1, updated_at = now() WHERE id = $2", [JSON.stringify({ ...row.backfill, screenplayBeats: beats }), projectId]);
    await client.query("UPDATE ai_movie_scene_history SET undone = $2, after_scenes = CASE WHEN $2 THEN $3::jsonb ELSE after_scenes END WHERE id = $1", [entry.id, undoing, JSON.stringify(beat.scenes)]);
    await client.query("COMMIT");
    return { beatIndex: entry.beat_index, label: entry.label, sceneCount: restore.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export const undoLast = (db, projectId) => swap(db, projectId, "undo");
export const redoLast = (db, projectId) => swap(db, projectId, "redo");
