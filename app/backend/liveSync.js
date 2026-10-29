// Two people on one project (the admin and a screenplay writer): every 20 seconds each open screen asks "did anything change?".
//   GET /api/scene-lists/:id/sync?known=<list hash>&editing=<scene key>
// answers with the scene list's hash (and the scene list itself when it differs from the one the screen already has), the newest
// version of every scene (id + who made it), and who else is editing which scene right now ("Kumar is editing E4S3").
// "Editing right now" is remembered here, in memory, for one minute after the last time that person's screen said so.
import { byLabel } from "./sceneAuthors.js";
import { listTags } from "./sceneTags.js";

const PRESENCE_MS = 60 * 1000;

// who is editing what: presence = Map(sceneListId -> Map(userId -> { name, role, key, at }))
export function notePresence(presence, sceneListId, user, key, now = Date.now()) {
  let people = presence.get(sceneListId);
  if (!people) { people = new Map(); presence.set(sceneListId, people); }
  if (key) people.set(user.id, { name: user.name, role: user.role, key: String(key), at: now });
  else people.delete(user.id);
}

// the others (not the one asking) who edited within the last minute
export function othersEditing(presence, sceneListId, selfId, now = Date.now()) {
  const people = presence.get(sceneListId);
  if (!people) return [];
  const out = [];
  for (const [userId, p] of people) {
    if (now - p.at > PRESENCE_MS) { people.delete(userId); continue; }
    if (userId !== selfId) out.push({ name: p.name, role: p.role, label: byLabel(p), key: p.key });
  }
  return out;
}

// "2-5" -> { episodeIndex: 2, sceneIndex: 5 }; "film-5" -> { episodeIndex: null, sceneIndex: 5 }
export function parseSceneKey(key) {
  const m = /^(film|\d+)-(\d+)$/.exec(String(key ?? ""));
  return m ? { episodeIndex: m[1] === "film" ? null : Number(m[1]), sceneIndex: Number(m[2]) } : null;
}

export function registerLiveSyncRoutes(app, db, requireRole) {
  const presence = new Map();

  app.get("/api/scene-lists/:id/sync", requireRole("admin", "screenplay_writer", "independent_writer"), async (req, res) => {
    const id = Number(req.params.id);
    const list = (await db.query("SELECT md5(content::text) AS hash, content FROM scene_lists WHERE id = $1", [id])).rows[0];
    if (!list) { res.status(404).json({ error: "Scene list not found" }); return; }
    const editingKey = parseSceneKey(req.query.editing) ? String(req.query.editing) : null;
    notePresence(presence, id, req.user, editingKey);
    const scenes = (await db.query(
      `SELECT DISTINCT ON (episode_index, scene_index) episode_index, scene_index, id, content->'madeBy' AS made_by
       FROM screenplay_scenes WHERE scene_list_id = $1 ORDER BY episode_index, scene_index, created_at DESC, id DESC`, [id])).rows;
    const known = String(req.query.known ?? "");
    res.json({
      hash: list.hash,
      ...(known && known !== list.hash ? { sceneList: list.content } : {}),
      scenes: scenes.map((r) => [r.episode_index, r.scene_index, r.id, byLabel(r.made_by)]),
      editors: othersEditing(presence, id, req.user.id),
      tags: await listTags(db, id),
    });
  });
}
