// A finished Film screenplay (scenes stored as structured elements) turned into one plain screenplay
// text — scene headings, action, character names, dialogue — the shape the AI Movies importer reads.
// Pure functions: no database here.
const text = (v) => (typeof v === "string" ? v : v && typeof v === "object" ? v.en ?? v.or ?? v.hi ?? "" : "");

export function countScenes(sceneList) {
  if (Array.isArray(sceneList?.episodeScenes)) return sceneList.episodeScenes.reduce((n, e) => n + (e.scenes?.length ?? 0), 0);
  return sceneList?.scenes?.length ?? 0;
}

function sceneToText(scene, number, elements) {
  // "SCENE 3 — INT. PLACE — NIGHT": the form Production reads scene numbers from
  const lines = [`SCENE ${number} — ${scene.intExt ?? "INT"}. ${text(scene.location).toUpperCase() || "LOCATION"} — ${scene.timeOfDay ?? "DAY"}`];
  for (const element of elements ?? []) {
    const body = text(element.text).trim();
    if (element.type === "dialogue") {
      const modifier = element.characterModifier && element.characterModifier !== "none" ? ` (${element.characterModifier})` : "";
      lines.push(`${String(element.character ?? "CHARACTER").toUpperCase()}${modifier}`);
      if (element.parenthetical) lines.push(`(${element.parenthetical})`);
      if (body) lines.push(body);
    } else if (element.type === "flashback") {
      lines.push(`FLASHBACK - ${String(element.character ?? "").toUpperCase()}'S POV: ${body}`.trim());
    } else if (element.type === "transition") {
      lines.push(body.toUpperCase());
    } else if (body) {
      lines.push(body);
    }
  }
  return lines.join("\n");
}

// scenesByEpisode: Map(episodeIndex|null -> rows [{ scene_index, content: { elements } }])
export function buildScreenplayPlainText({ deck, sceneList, scenesByEpisode }) {
  const parts = [text(deck?.title) || "Untitled"];
  if (text(deck?.logline)) parts.push(text(deck.logline));
  const writeScenes = (scenes, rows, startAt = 1) => {
    const out = [];
    scenes.forEach((scene, i) => {
      const row = rows.find((r) => r.scene_index === i);
      if (row) out.push(sceneToText(scene, startAt + i, row.content?.elements));
    });
    return out;
  };
  if (Array.isArray(sceneList?.episodeScenes)) {
    sceneList.episodeScenes.forEach((episode, index) => {
      const scenes = writeScenes(episode.scenes ?? [], scenesByEpisode.get(index) ?? []);
      if (!scenes.length) return;
      parts.push(`EPISODE ${index + 1}: ${text(deck?.episodes?.[index]?.title).toUpperCase() || "UNTITLED"}`, ...scenes);
    });
  } else {
    parts.push(...writeScenes(sceneList?.scenes ?? [], scenesByEpisode.get(null) ?? []));
  }
  return parts.join("\n\n");
}
