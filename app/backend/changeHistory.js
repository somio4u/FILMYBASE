// "Change history" (admin): what changed in a project's screenplay, episode by episode, from the version history the app already
// keeps — every change to a scene is a new row in screenplay_scenes, so this works for work done long before this screen existed.
// Who made a version (content.madeBy, see sceneAuthors.js) is shown where it was recorded; older versions carry no name.

import { byLabel } from "./sceneAuthors.js";

// a scene's text as plain lines, for reading and comparing
export function linesOf(content) {
  return (content?.elements ?? []).map((e) => {
    if (e.type === "dialogue") {
      const who = `${e.character ?? ""}${e.characterModifier && e.characterModifier !== "none" ? ` (${e.characterModifier})` : ""}`;
      return `${who}${e.parenthetical ? ` (${e.parenthetical})` : ""}: ${e.text ?? ""}`;
    }
    return String(e.text ?? "");
  });
}

// how this version came to be, in one word
export function sourceOf(content) {
  if (content?.importedFromFile) return "imported";
  if (content?.editedByUser) return "edited";
  return "ai";
}

export function summariseHistory(sceneList, rows) {
  const groups = Array.isArray(sceneList.episodeScenes)
    ? sceneList.episodeScenes.map((e, i) => ({ episodeIndex: i, scenes: e.scenes ?? [] }))
    : [{ episodeIndex: null, scenes: sceneList.scenes ?? [] }];
  const byScene = new Map();
  for (const r of rows) {
    const key = `${r.episode_index ?? "film"}-${r.scene_index}`;
    const entry = byScene.get(key) ?? { versions: 0, firstAt: r.created_at, lastAt: r.created_at, lastSource: null, lastBy: null, list: [] };
    entry.versions += 1;
    entry.list.push(r);
    if (r.created_at < entry.firstAt) entry.firstAt = r.created_at;
    if (r.created_at >= entry.lastAt) { entry.lastAt = r.created_at; entry.lastSource = r.source; entry.lastBy = r.by ?? null; }
    byScene.set(key, entry);
  }
  return groups.map((g) => {
    const scenes = g.scenes.map((s, i) => {
      const e = byScene.get(`${g.episodeIndex ?? "film"}-${i}`);
      return {
        sceneIndex: i,
        sceneNumber: s.sceneNumber ?? String(i + 1),
        location: s.location?.en || s.location?.or || "",
        versions: e?.versions ?? 0,
        changes: Math.max(0, (e?.versions ?? 0) - 1),
        firstAt: e?.firstAt ?? null,
        lastAt: e?.lastAt ?? null,
        lastSource: e?.lastSource ?? null,
        lastBy: e?.lastBy ?? null,
      };
    });
    // who made the changes (every version after a scene's first): { label, changes } most active first
    const tally = new Map();
    g.scenes.forEach((_, i) => {
      const list = (byScene.get(`${g.episodeIndex ?? "film"}-${i}`)?.list ?? []).slice().sort((a, b) => a.created_at - b.created_at);
      list.slice(1).forEach((v) => { if (v.by) tally.set(v.by, (tally.get(v.by) ?? 0) + 1); });
    });
    const people = [...tally.entries()].map(([label, changes]) => ({ label, changes })).sort((a, b) => b.changes - a.changes);
    const dated = scenes.filter((s) => s.lastAt);
    return {
      episodeIndex: g.episodeIndex,
      sceneCount: scenes.length,
      changedScenes: scenes.filter((s) => s.changes > 0).length,
      totalChanges: scenes.reduce((n, s) => n + s.changes, 0),
      people,
      firstAt: dated.length ? dated.reduce((a, s) => (s.firstAt < a ? s.firstAt : a), dated[0].firstAt) : null,
      lastAt: dated.length ? dated.reduce((a, s) => (s.lastAt > a ? s.lastAt : a), dated[0].lastAt) : null,
      scenes,
    };
  });
}

export function registerChangeHistoryRoutes(app, db, requireRole) {
  app.get("/api/scene-lists/:id/change-history", requireRole("admin"), async (req, res) => {
    const id = Number(req.params.id);
    const list = (await db.query("SELECT content FROM scene_lists WHERE id = $1", [id])).rows[0];
    if (!list) { res.status(404).json({ error: "Scene list not found" }); return; }
    const rows = (await db.query("SELECT episode_index, scene_index, content, created_at FROM screenplay_scenes WHERE scene_list_id = $1", [id])).rows
      .map((r) => ({ ...r, source: sourceOf(r.content), by: byLabel(r.content?.madeBy) }));
    res.json({ episodes: summariseHistory(list.content, rows) });
  });

  // every version of one scene, oldest first, as plain lines
  app.get("/api/scene-lists/:id/change-history/scene", requireRole("admin"), async (req, res) => {
    const id = Number(req.params.id);
    const sceneIndex = Number(req.query.sceneIndex);
    const episodeIndex = req.query.episodeIndex === undefined || req.query.episodeIndex === "" ? null : Number(req.query.episodeIndex);
    if (!Number.isInteger(sceneIndex)) { res.status(400).json({ error: "Which scene?" }); return; }
    const rows = (await db.query(
      `SELECT id, content, created_at FROM screenplay_scenes
       WHERE scene_list_id = $1 AND episode_index IS NOT DISTINCT FROM $2 AND scene_index = $3 ORDER BY created_at, id`,
      [id, episodeIndex, sceneIndex])).rows;
    res.json({ versions: rows.map((r) => ({ id: r.id, at: r.created_at, source: sourceOf(r.content), by: byLabel(r.content?.madeBy), lines: linesOf(r.content) })) });
  });
}
