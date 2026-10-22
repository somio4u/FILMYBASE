// Colour tags on scenes: the admin marks a scene for the screenplay writer — red "change", yellow "check", blue "new", green "done" —
// with a short note ("make Makar's speech shorter"). The writer can turn a tag green ("done") but nothing else; only the admin sets,
// changes or clears tags. Tags belong to a scene's place (episode, scene), so they move with the scene when scenes are added, removed
// or dragged (those routes shift this table together with the written versions).
import { byLabel } from "./sceneAuthors.js";

export const TAGS = ["change", "check", "new", "done"];

export async function ensureSceneTagSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS scene_tags (
    id SERIAL PRIMARY KEY,
    scene_list_id INTEGER NOT NULL,
    episode_index INTEGER,
    scene_index INTEGER NOT NULL,
    tag TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    set_by_name TEXT,
    set_by_role TEXT,
    set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    done_by TEXT,
    done_at TIMESTAMPTZ
  )`);
  await db.query("CREATE INDEX IF NOT EXISTS scene_tags_list ON scene_tags (scene_list_id)");
}

// What this person may do with a scene's tag: the admin anything (a tag, or null = clear); the writer only turn an existing tag into "done".
export function allowedChange(role, existingTag, wanted) {
  if (role === "admin") return wanted === null || TAGS.includes(wanted);
  if (role === "screenplay_writer") return Boolean(existingTag) && existingTag !== "done" && wanted === "done";
  return false;
}

// [episodeIndex, sceneIndex, tag, note, set by, done by] for every tagged scene of a scene list (sent with the 20-second check)
export async function listTags(db, sceneListId) {
  const rows = (await db.query(
    "SELECT episode_index, scene_index, tag, note, set_by_name, set_by_role, done_by FROM scene_tags WHERE scene_list_id = $1 ORDER BY episode_index, scene_index",
    [sceneListId])).rows;
  return rows.map((r) => [r.episode_index, r.scene_index, r.tag, r.note, byLabel({ name: r.set_by_name, role: r.set_by_role }), r.done_by]);
}

export function registerSceneTagRoutes(app, db, requireRole) {
  app.put("/api/scene-lists/:id/scene-tag", requireRole("admin", "screenplay_writer"), async (req, res) => {
    const sceneListId = Number(req.params.id);
    const episodeIndex = req.body.episodeIndex === null || req.body.episodeIndex === undefined ? null : Number(req.body.episodeIndex);
    const sceneIndex = Number(req.body.sceneIndex);
    const wanted = req.body.tag === null || req.body.tag === undefined || req.body.tag === "" ? null : String(req.body.tag);
    const note = String(req.body.note ?? "").trim().slice(0, 500);
    const list = (await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId])).rows[0];
    if (!list) { res.status(404).json({ error: "Scene list not found" }); return; }
    const scenes = episodeIndex === null ? list.content.scenes : list.content.episodeScenes?.[episodeIndex]?.scenes;
    if (!Number.isInteger(sceneIndex) || !Array.isArray(scenes) || !scenes[sceneIndex]) { res.status(400).json({ error: "That scene does not exist." }); return; }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const where = "scene_list_id = $1 AND episode_index IS NOT DISTINCT FROM $2 AND scene_index = $3";
      const existing = (await client.query(`SELECT * FROM scene_tags WHERE ${where} ORDER BY id DESC LIMIT 1 FOR UPDATE`, [sceneListId, episodeIndex, sceneIndex])).rows[0];
      if (!allowedChange(req.user.role, existing?.tag, wanted)) {
        await client.query("ROLLBACK");
        res.status(403).json({ error: req.user.role === "admin" ? "That is not a tag." : "You can only mark a tagged scene as done." });
        return;
      }
      const me = byLabel(req.user);
      if (req.user.role === "screenplay_writer") {
        await client.query("UPDATE scene_tags SET tag = 'done', done_by = $2, done_at = now() WHERE id = $1", [existing.id, me]);
      } else {
        await client.query(`DELETE FROM scene_tags WHERE ${where}`, [sceneListId, episodeIndex, sceneIndex]);
        if (wanted) {
          await client.query(
            `INSERT INTO scene_tags (scene_list_id, episode_index, scene_index, tag, note, set_by_name, set_by_role, done_by, done_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [sceneListId, episodeIndex, sceneIndex, wanted, note, req.user.name, req.user.role, wanted === "done" ? me : null, wanted === "done" ? new Date() : null]);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    res.json({ tags: await listTags(db, sceneListId) });
  });
}
