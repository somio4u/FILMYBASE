// "Change the place name in the screenplay too": every scene whose place is one of the chosen names gets the one final name.
// The INT/EXT word is not part of a place (Temple Interior and Temple Exterior are one place), so the scene's own INT/EXT stays as it is.
// Each change is remembered (old heading per scene) so it can be undone without touching anything written since.
import { normalizeLocation } from "./nameCleanup.js";

const textOf = (v) => (v && typeof v === "object" ? v.en || v.or || v.hi || "" : String(v ?? ""));
const placeKey = (loc) => normalizeLocation(String(textOf(loc)).trim().toUpperCase() || "UNKNOWN LOCATION");

// the scene list content -> { content, changes: [{ episodeIndex, sceneIndex, before, after }] }
export function renameLocationInList(content, names, to) {
  const wanted = new Set(names.map((n) => normalizeLocation(String(n).trim().toUpperCase())));
  const changes = [];
  const fix = (scenes, episodeIndex) => (scenes ?? []).map((scene, sceneIndex) => {
    if (!wanted.has(placeKey(scene.location))) return scene;
    const before = scene.location ?? null;
    if (textOf(before).trim() === to) return scene;
    const after = before && typeof before === "object" ? Object.fromEntries(Object.keys({ en: 1, ...before }).map((k) => [k, to])) : { en: to };
    changes.push({ episodeIndex, sceneIndex, before, after });
    return { ...scene, location: after };
  });
  const next = { ...content };
  if (Array.isArray(next.episodeScenes)) next.episodeScenes = next.episodeScenes.map((ep, i) => ({ ...ep, scenes: fix(ep.scenes, i) }));
  else if (Array.isArray(next.scenes)) next.scenes = fix(next.scenes, null);
  return { content: next, changes };
}

// put the old headings back, only where the scene still has the name we gave it
export function undoLocationRename(content, changes) {
  const next = { ...content };
  let restored = 0;
  const put = (scenes, episodeIndex) => (scenes ?? []).map((scene, sceneIndex) => {
    const c = changes.find((x) => (x.episodeIndex ?? null) === episodeIndex && x.sceneIndex === sceneIndex);
    if (!c || textOf(scene.location) !== textOf(c.after)) return scene;
    restored++;
    return { ...scene, location: c.before };
  });
  if (Array.isArray(next.episodeScenes)) next.episodeScenes = next.episodeScenes.map((ep, i) => ({ ...ep, scenes: put(ep.scenes, i) }));
  else if (Array.isArray(next.scenes)) next.scenes = put(next.scenes, null);
  return { content: next, restored };
}

export async function ensureLocationRenameSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS location_rename_backups (
    id SERIAL PRIMARY KEY,
    scene_list_id INTEGER NOT NULL,
    from_names JSONB NOT NULL,
    to_name TEXT NOT NULL,
    changes JSONB NOT NULL,
    undone BOOLEAN NOT NULL DEFAULT false,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

export function registerLocationRenameRoutes(app, db, { requireRole }) {
  const admin = requireRole("admin");

  async function locked(client, id) {
    const list = await client.query("SELECT content FROM scene_lists WHERE id = $1 FOR UPDATE", [id]);
    if (!list.rows[0]) return { status: 404, error: "Scene list not found" };
    const running = await client.query("SELECT 1 FROM auto_pipeline_runs WHERE scene_list_id = $1 AND status = 'running' LIMIT 1", [id]);
    if (running.rows.length > 0) return { status: 409, error: "The AI is still writing this script. Change the place names once it has finished." };
    return { content: list.rows[0].content };
  }

  // preview: true only counts
  app.post("/api/scene-lists/:id/rename-location", admin, async (req, res) => {
    const id = Number(req.params.id);
    const names = (Array.isArray(req.body?.names) ? req.body.names : []).map((n) => String(n ?? "").trim()).filter(Boolean);
    const to = String(req.body?.to ?? "").trim().toUpperCase();
    if (names.length === 0 || !to) { res.status(400).json({ error: "Give the place names and the one name to keep." }); return; }
    if (to.length > 80 || /[\n\r]/.test(to)) { res.status(400).json({ error: "The new name is too long." }); return; }
    const preview = req.body?.preview === true;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const l = await locked(client, id);
      if (l.error) { await client.query("ROLLBACK"); res.status(l.status).json({ error: l.error }); return; }
      const r = renameLocationInList(l.content, names, to);
      let backupId = null;
      if (!preview && r.changes.length > 0) {
        await client.query("UPDATE scene_lists SET content = $1 WHERE id = $2", [JSON.stringify(r.content), id]);
        backupId = (await client.query("INSERT INTO location_rename_backups (scene_list_id, from_names, to_name, changes, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id", [id, JSON.stringify(names), to, JSON.stringify(r.changes), req.user?.id ?? null])).rows[0].id;
      }
      await client.query(preview ? "ROLLBACK" : "COMMIT");
      res.json({ scenes: r.changes.length, preview, backupId, sceneList: preview ? null : r.content });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("Renaming a place failed:", error.message);
      res.status(500).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  app.get("/api/scene-lists/:id/rename-location/latest", admin, async (req, res) => {
    const row = (await db.query("SELECT id, from_names, to_name, jsonb_array_length(changes) AS scenes, created_at FROM location_rename_backups WHERE scene_list_id = $1 AND NOT undone ORDER BY id DESC LIMIT 1", [Number(req.params.id)])).rows[0];
    res.json({ latest: row ? { id: row.id, from: row.from_names, to: row.to_name, scenes: Number(row.scenes), createdAt: row.created_at } : null });
  });

  app.post("/api/scene-lists/:id/rename-location/:backupId/undo", admin, async (req, res) => {
    const id = Number(req.params.id);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const l = await locked(client, id);
      if (l.error) { await client.query("ROLLBACK"); res.status(l.status).json({ error: l.error }); return; }
      const b = (await client.query("SELECT id, changes FROM location_rename_backups WHERE id = $1 AND scene_list_id = $2 AND NOT undone FOR UPDATE", [Number(req.params.backupId), id])).rows[0];
      if (!b) { await client.query("ROLLBACK"); res.status(404).json({ error: "Nothing to undo." }); return; }
      const r = undoLocationRename(l.content, b.changes);
      await client.query("UPDATE scene_lists SET content = $1 WHERE id = $2", [JSON.stringify(r.content), id]);
      await client.query("UPDATE location_rename_backups SET undone = true WHERE id = $1", [b.id]);
      await client.query("COMMIT");
      res.json({ restored: r.restored, sceneList: r.content });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("Undoing a place rename failed:", error.message);
      res.status(500).json({ error: error.message });
    } finally {
      client.release();
    }
  });
}
