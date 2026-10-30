// PDF import — Step 2: a screenplay that is already written (fully or partly) becomes a project, exactly as written. No AI is used here:
// the scene list, the written scenes and the cast come straight from the file, so nothing can be reworded, merged, split or dropped.
//
//   written scenes   -> a screenplay_scenes row each (action + dialogue lines word for word; editable like any scene)
//   one-liner scenes -> only in the scene list with their summary, NO screenplay row: they show as "not written yet" with the Write button
//   the earlier stages (pitch deck, characters, three acts, bit sheet) are made as simple placeholders from what the file holds
//     (title, who speaks, one-liners per episode) so the project opens normally; they can be developed later.
//
// buildScreenplayProject: parsed episodes -> plain data; saveScreenplayProject: writes it to the database in one transaction.
import { languageOf, outlineFor, sceneContent } from "./screenplayImport.js";
import { sceneState } from "./importAnalysis.js";

const text = (value) => ({ en: value, or: value, hi: value });
const round1 = (n) => Math.round(n * 10) / 10;

// the one-line summary of a scene that has no written lines yet: what its text says
function summaryOf(scene) {
  const joined = scene.elements.map((e) => e.text).join(" ").replace(/\s+/g, " ").trim();
  return joined.length > 400 ? `${joined.slice(0, 397).trim()}...` : joined;
}

export function buildScreenplayProject(parsed, { title = "", format = null, minutesFallback = 90, targetScenes = null } = {}) {
  const episodes = parsed.episodes.filter((e) => e.scenes.length > 0);
  if (episodes.length === 0) throw Object.assign(new Error("No scenes were found in this screenplay, so no project was made."), { status: 422 });
  const allText = episodes.flatMap((e) => e.scenes.flatMap((s) => s.elements.map((x) => x.text))).join("\n");
  const language = languageOf(allText);
  const isSeries = format?.type === "series" || format?.type === "vertical" || episodes.length > 1;

  const rows = []; // screenplay_scenes to write: { episodeIndex (null for a film), sceneIndex, content }
  const episodeScenes = episodes.map((episode, ei) => episode.scenes.map((scene, si) => {
    const written = sceneState(scene).state === "written";
    const outline = outlineFor({ ...scene, oneLiner: written ? scene.oneLiner : summaryOf(scene) || scene.oneLiner }, si, undefined, episode.number, []);
    if (written) rows.push({ episodeIndex: isSeries ? ei : null, sceneIndex: si, content: sceneContent(scene, language) });
    return outline;
  }));

  const speakers = new Map();
  for (const episode of episodes) for (const scene of episode.scenes) for (const e of scene.elements) if (e.type === "dialogue" && e.character) speakers.set(e.character, (speakers.get(e.character) ?? 0) + 1);
  const cast = [...speakers.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const projectTitle = String(title ?? "").trim() || episodes[0].title || `Imported screenplay (${episodes[0].scenes[0].location})`;
  const sumMinutes = (scenes) => round1(scenes.reduce((n, s) => n + (Number(s.estimatedMinutes) || 0), 0));
  const oneLiners = episodes.flatMap((e, ei) => e.scenes.map((s, si) => episodeScenes[ei][si].oneLiner.en)).filter(Boolean);
  const concept = `${projectTitle} — imported screenplay with ${episodeScenes.flat().length} scenes. ${oneLiners.slice(0, 3).join(" ")}`.trim();

  const emptyChar = (name) => ({ name, role: text(""), emotionalCore: text(""), conflict: text("") });
  const sheetChar = (name) => ({
    name, age: "", relationToHero: "", look: "", archetype: "ally", archetypeNote: text(""), role: text(""), want: text(""), need: text(""),
    flaw: text(""), virtues: [], innerConflict: text(""), outerConflict: text(""), arc: text(""), introductionBeat: text(""),
  });

  const totalMinutes = round1(episodeScenes.flat().reduce((n, s) => n + (Number(s.estimatedMinutes) || 0), 0)) || minutesFallback;
  const deckFormat = isSeries
    ? { type: format?.type === "vertical" ? "vertical" : "series", episodeCount: episodes.length, episodeMinutes: round1(totalMinutes / episodes.length) || 10 }
    : { type: "film", runtimeMinutes: Math.round(totalMinutes) || minutesFallback };
  const deck = {
    title: text(projectTitle), logline: text(""), premise: text(""), toneGenre: text(""), targetAudience: text(""),
    majorCharacters: cast.slice(0, 6).map(emptyChar), format: deckFormat,
    episodes: isSeries ? episodes.map((e, ei) => ({
      title: text(e.title || `Episode ${e.number}`),
      synopsis: text(e.scenes.map((s, si) => episodeScenes[ei][si].oneLiner.en).filter(Boolean).join(" ")),
      hook: text(""),
    })) : null,
  };
  const idea = text("");
  const threeAct = { controllingIdea: idea, setup: { summary: text(""), beats: [] }, confrontation: { summary: text(""), beats: [] }, resolution: { summary: text(""), beats: [] } };
  const bitSheet = isSeries ? { episodeBits: episodes.map(() => ({ bits: [] })), controllingIdea: idea } : { bits: [], controllingIdea: idea };

  const sceneList = isSeries
    ? { episodeScenes: episodeScenes.map((scenes) => ({ scenes, totalEstimatedMinutes: sumMinutes(scenes), targetMinutes: deckFormat.episodeMinutes })), controllingIdea: idea }
    : { scenes: episodeScenes[0], totalEstimatedMinutes: sumMinutes(episodeScenes[0]), targetMinutes: deckFormat.runtimeMinutes, controllingIdea: idea };

  // how many scenes the writer wants in all (asked after the draft was looked at); kept with the scene list so the app can show what is still to plan
  const wanted = Math.floor(Number(targetScenes));
  if (!isSeries && wanted > 0 && wanted < 2000) sceneList.targetScenes = wanted;
  const writtenCount = rows.length;
  const total = episodeScenes.flat().length;
  return {
    isSeries, language, title: projectTitle, concept, storyline: { title: text(projectTitle), logline: text(""), summary: text(oneLiners.slice(0, 5).join(" ")) },
    deck, characterSheet: { characters: cast.map(sheetChar) }, threeAct, bitSheet, sceneList, rows,
    summary: { scenes: total, written: writtenCount, notWritten: total - writtenCount, episodes: episodes.length, cast: cast.length },
  };
}

// One transaction: either the whole project is there afterwards, or nothing is. Returns the new concept id.
export async function saveScreenplayProject(db, built, { ownerUserId = null, setTitle = async () => {} } = {}) {
  const J = JSON.stringify;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const concept = (await client.query("INSERT INTO concepts (concept_text, storylines, owner_user_id) VALUES ($1, $2, $3) RETURNING id", [built.concept, J([built.storyline]), ownerUserId])).rows[0].id;
    const deckId = (await client.query("INSERT INTO pitch_decks (concept_id, content, status) VALUES ($1, $2, 'approved') RETURNING id", [concept, J(built.deck)])).rows[0].id;
    await client.query("INSERT INTO character_sheets (pitch_deck_id, content, status) VALUES ($1, $2, 'approved')", [deckId, J(built.characterSheet)]);
    const act = (await client.query("INSERT INTO three_act_structures (pitch_deck_id, content, status) VALUES ($1, $2, 'locked') RETURNING id", [deckId, J(built.threeAct)])).rows[0].id;
    const bits = (await client.query("INSERT INTO bit_sheets (three_act_structure_id, content, status) VALUES ($1, $2, 'approved') RETURNING id", [act, J(built.bitSheet)])).rows[0].id;
    const listId = (await client.query("INSERT INTO scene_lists (bit_sheet_id, content, status) VALUES ($1, $2, 'approved') RETURNING id", [bits, J(built.sceneList)])).rows[0].id;
    for (const row of built.rows) {
      await client.query("INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content) VALUES ($1, $2, $3, $4)", [listId, row.episodeIndex, row.sceneIndex, J(row.content)]);
    }
    await client.query("COMMIT");
    await setTitle(concept, built.title);
    return concept;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
