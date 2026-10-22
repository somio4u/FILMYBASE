// Long background jobs (Synchronize, the AD scene sheet) used to live only in the server's memory: a deploy or restart made them vanish.
// Their state is now also kept in the database, and a job that was running when the server stopped is started again from the beginning
// when the server comes back (these jobs save their results only at the end, so starting again never leaves anything half-done).

export async function ensureJobSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS background_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    scene_list_id INTEGER NOT NULL,
    key TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    state JSONB NOT NULL DEFAULT '{}',
    resumes INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
  )`);
  await db.query("CREATE INDEX IF NOT EXISTS background_jobs_lookup ON background_jobs (kind, scene_list_id, started_at DESC)");
}

export const MAX_RESUMES = 3;
export const GIVE_UP_AFTER_MS = 3 * 60 * 60 * 1000;

export function createJobStore(db) {
  const row = (r) => (r ? { id: r.id, kind: r.kind, sceneListId: r.scene_list_id, key: r.key, status: r.status, state: r.state, resumes: r.resumes, startedAt: new Date(r.started_at).getTime(), updatedAt: new Date(r.updated_at).getTime(), finishedAt: r.finished_at ? new Date(r.finished_at).getTime() : null } : null);
  return {
    async insert(id, kind, sceneListId, key, state) {
      await db.query("INSERT INTO background_jobs (id, kind, scene_list_id, key, state) VALUES ($1, $2, $3, $4, $5)", [id, kind, sceneListId, String(key ?? ""), JSON.stringify(state)]);
    },
    async save(id, state, status) {
      await db.query(
        "UPDATE background_jobs SET state = $2, status = $3, updated_at = now(), finished_at = CASE WHEN $3 = 'running' THEN NULL ELSE COALESCE(finished_at, now()) END WHERE id = $1",
        [id, JSON.stringify(state), status]);
    },
    async get(id) { return row((await db.query("SELECT * FROM background_jobs WHERE id = $1", [id])).rows[0]); },
    async latest(kind, sceneListId, key) {
      return row((await db.query(
        "SELECT * FROM background_jobs WHERE kind = $1 AND scene_list_id = $2 AND ($3::text IS NULL OR key = $3) ORDER BY started_at DESC LIMIT 1",
        [kind, sceneListId, key ?? null])).rows[0]);
    },
    async running(kind) { return (await db.query("SELECT * FROM background_jobs WHERE kind = $1 AND status = 'running' ORDER BY started_at", [kind])).rows.map(row); },
    async countResume(id) { await db.query("UPDATE background_jobs SET resumes = resumes + 1, updated_at = now() WHERE id = $1", [id]); },
  };
}

// a job found "running" at start-up: should it be started again, or has it been tried enough / is it too old?
export function shouldResume(job, now = Date.now()) {
  if (job.resumes >= MAX_RESUMES) return { resume: false, why: `it was interrupted ${MAX_RESUMES} times by server restarts` };
  if (now - job.startedAt > GIVE_UP_AFTER_MS) return { resume: false, why: "it had been running for more than 3 hours" };
  return { resume: true };
}
