// "Import episodes from a Word file": the writer finishes the screenplay
// outside the app, uploads the Word (or text) file, and the app replaces the
// chosen episodes' screenplay with it. Nothing is lost: the old version of
// every replaced episode is kept in screenplay_import_backups, and each
// replaced scene keeps its old text as an earlier version (↶ Undo works).
import crypto from "crypto";
import path from "path";
import { languageOf, outlineFor, parseEpisodesFromText, sceneContent } from "./screenplayImport.js";

export async function ensureScreenplayImportSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS screenplay_import_backups (
    id SERIAL PRIMARY KEY,
    scene_list_id INTEGER NOT NULL,
    batch_id TEXT NOT NULL,
    episode_index INTEGER NOT NULL,
    old_scenes JSONB NOT NULL,
    old_screenplay JSONB NOT NULL,
    old_schedules JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    undone_at TIMESTAMPTZ
  )`);
}

function summarise(parsed, episodeScenes) {
  return parsed.episodes.map((episode) => {
    const index = episode.number - 1;
    const existing = episodeScenes[index]?.scenes;
    return {
      number: episode.number,
      title: episode.title,
      sceneCount: episode.scenes.length,
      minutes: episode.minutes,
      declaredMinutes: episode.declaredMinutes,
      exists: Array.isArray(existing),
      currentSceneCount: existing?.length ?? 0,
    };
  });
}

export function registerScreenplayImportRoutes(app, db, tools) {
  const { requireRole, upload, extractText, lockSceneListForSceneEdit, withSceneArray, withRecountedMinutes } = tools;

  async function lastImport(sceneListId) {
    const rows = (await db.query(
      `SELECT batch_id, episode_index, created_at FROM screenplay_import_backups
       WHERE scene_list_id = $1 AND undone_at IS NULL AND batch_id = (
         SELECT batch_id FROM screenplay_import_backups WHERE scene_list_id = $1 AND undone_at IS NULL ORDER BY id DESC LIMIT 1)
       ORDER BY episode_index`, [sceneListId])).rows;
    if (rows.length === 0) return null;
    return { createdAt: rows[0].created_at, episodes: rows.map((r) => r.episode_index + 1) };
  }

  app.get("/api/scene-lists/:id/screenplay-import", requireRole("admin"), async (req, res) => {
    res.json({ lastImport: await lastImport(Number(req.params.id)) });
  });

  app.post("/api/scene-lists/:id/screenplay-import", requireRole("admin"), upload.single("file"), async (req, res) => {
    const sceneListId = Number(req.params.id);
    if (!req.file) { res.status(400).json({ error: "Please choose a Word (.docx) or text file." }); return; }
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext === ".pdf") {
      res.status(400).json({ error: "A PDF can't be read accurately for Odia (letters get broken). Please upload the Word (.docx) file instead." });
      return;
    }
    if (![".docx", ".txt", ".md"].includes(ext)) {
      res.status(400).json({ error: "Please upload a Word (.docx) or text (.txt) file." });
      return;
    }
    const text = await extractText(req.file);
    const parsed = parseEpisodesFromText(text);
    if (parsed.episodes.length === 0) {
      res.status(400).json({ error: "Couldn't find any episodes. Each episode should start with a line like \"EPISODE 4: TITLE\" followed by \"SCENE 1\", \"INT./EXT. PLACE - TIME\"." });
      return;
    }

    const list = (await db.query("SELECT content, status FROM scene_lists WHERE id = $1", [sceneListId])).rows[0];
    if (!list) { res.status(404).json({ error: "Scene list not found" }); return; }
    if (!Array.isArray(list.content?.episodeScenes)) {
      res.status(400).json({ error: "Import works for series (episodes) only." });
      return;
    }

    if (req.body.apply !== "1") {
      res.json({ episodes: summarise(parsed, list.content.episodeScenes), warnings: parsed.warnings, lastImport: await lastImport(sceneListId) });
      return;
    }

    let wanted;
    try { wanted = JSON.parse(req.body.episodes ?? "[]").map(Number); } catch { wanted = []; }
    const chosen = parsed.episodes.filter((e) => wanted.includes(e.number));
    if (chosen.length === 0) { res.status(400).json({ error: "Please tick at least one episode to import." }); return; }
    // the language of the whole file (Odia / Hindi / English), judged from its words
    const language = languageOf(text);

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const locked = await lockSceneListForSceneEdit(client, sceneListId, chosen[0].number - 1);
      if (locked.error) { await client.query("ROLLBACK"); res.status(locked.status).json({ error: locked.error }); return; }
      let content = locked.content;
      const missing = chosen.filter((e) => !Array.isArray(content.episodeScenes[e.number - 1]?.scenes));
      if (missing.length > 0) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: `Episode ${missing.map((e) => e.number).join(", ")} doesn't exist in this project yet.` });
        return;
      }
      const schedules = (await client.query("SELECT id, content FROM shoot_schedules WHERE scene_list_id = $1", [sceneListId])).rows;
      const batchId = crypto.randomUUID();

      for (const episode of chosen) {
        const index = episode.number - 1;
        const oldScenes = content.episodeScenes[index].scenes;
        const oldRows = (await client.query(
          `SELECT DISTINCT ON (scene_index) scene_index, content, status, feedback FROM screenplay_scenes
           WHERE scene_list_id = $1 AND episode_index = $2 ORDER BY scene_index, created_at DESC, id DESC`, [sceneListId, index])).rows;
        await client.query(
          `INSERT INTO screenplay_import_backups (scene_list_id, batch_id, episode_index, old_scenes, old_screenplay, old_schedules)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [sceneListId, batchId, index, JSON.stringify(oldScenes), JSON.stringify(oldRows), JSON.stringify(schedules)]);

        const newScenes = episode.scenes.map((scene, i) => outlineFor(scene, i, oldScenes[i], episode.number, [oldScenes[0]?.sceneNumber]));
        content = withRecountedMinutes(withSceneArray(content, index, newScenes), index);
        for (let i = 0; i < episode.scenes.length; i++) {
          await client.query(
            "INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content) VALUES ($1, $2, $3, $4)",
            [sceneListId, index, i, JSON.stringify(sceneContent(episode.scenes[i], language))]);
        }
        // scenes the new file no longer has
        for (const table of ["screenplay_scenes", "screenplay_scene_redo"]) {
          await client.query(`DELETE FROM ${table} WHERE scene_list_id = $1 AND episode_index = $2 AND scene_index >= $3`, [sceneListId, index, episode.scenes.length]);
        }
        for (const row of schedules) {
          if (!Array.isArray(row.content?.scheduleDays)) continue;
          const scheduleDays = row.content.scheduleDays.map((day) => ({
            ...day,
            sceneRefs: (day.sceneRefs ?? []).filter((ref) => !(ref.episodeIndex === index && ref.sceneIndex >= episode.scenes.length)),
          }));
          row.content = { ...row.content, scheduleDays };
        }
      }
      await client.query("UPDATE scene_lists SET content = $1 WHERE id = $2", [JSON.stringify(content), sceneListId]);
      for (const row of schedules) await client.query("UPDATE shoot_schedules SET content = $1 WHERE id = $2", [JSON.stringify(row.content), row.id]);
      await client.query("COMMIT");
      res.json({ sceneList: content, imported: chosen.map((e) => ({ number: e.number, sceneCount: e.scenes.length })), lastImport: await lastImport(sceneListId) });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("Screenplay import failed:", error.message);
      res.status(500).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  app.post("/api/scene-lists/:id/screenplay-import/undo", requireRole("admin"), async (req, res) => {
    const sceneListId = Number(req.params.id);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const locked = await lockSceneListForSceneEdit(client, sceneListId, 0);
      if (locked.error) { await client.query("ROLLBACK"); res.status(locked.status).json({ error: locked.error }); return; }
      const backups = (await client.query(
        `SELECT * FROM screenplay_import_backups WHERE scene_list_id = $1 AND undone_at IS NULL AND batch_id = (
           SELECT batch_id FROM screenplay_import_backups WHERE scene_list_id = $1 AND undone_at IS NULL ORDER BY id DESC LIMIT 1)
         ORDER BY id`, [sceneListId])).rows;
      if (backups.length === 0) { await client.query("ROLLBACK"); res.status(400).json({ error: "There is no import to undo." }); return; }

      let content = locked.content;
      for (const backup of backups) {
        const index = backup.episode_index;
        content = withRecountedMinutes(withSceneArray(content, index, backup.old_scenes), index);
        for (const table of ["screenplay_scenes", "screenplay_scene_redo"]) {
          // anything the old episode had no written scene for goes away again
          await client.query(`DELETE FROM ${table} WHERE scene_list_id = $1 AND episode_index = $2 AND NOT (scene_index = ANY($3::int[]))`, [sceneListId, index, backup.old_screenplay.map((r) => r.scene_index)]);
        }
        for (const row of backup.old_screenplay) {
          await client.query(
            "INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content, status, feedback) VALUES ($1, $2, $3, $4, $5, $6)",
            [sceneListId, index, row.scene_index, JSON.stringify(row.content), row.status, row.feedback]);
        }
      }
      // the schedule as it was before the (first) import of this batch
      for (const row of backups[0].old_schedules) {
        await client.query("UPDATE shoot_schedules SET content = $1 WHERE id = $2", [JSON.stringify(row.content), row.id]);
      }
      await client.query("UPDATE scene_lists SET content = $1 WHERE id = $2", [JSON.stringify(content), sceneListId]);
      await client.query("UPDATE screenplay_import_backups SET undone_at = now() WHERE id = ANY($1)", [backups.map((b) => b.id)]);
      await client.query("COMMIT");
      res.json({ sceneList: content, undone: backups.map((b) => b.episode_index + 1), lastImport: await lastImport(sceneListId) });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("Screenplay import undo failed:", error.message);
      res.status(500).json({ error: error.message });
    } finally {
      client.release();
    }
  });
}
