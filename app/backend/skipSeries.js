// "Start from Synopsis / Bit Sheet / Scene One-Liners" for a WEB SERIES or a VERTICAL DRAMA.
// The user pastes ALL episodes in one box, each starting with a heading ("Episode 1", "एपिसोड २" ...). The text is split into
// episodes (their own words), and the project is built in the series shape the rest of the app expects:
//   synopsis   -> a pitch deck with one synopsis per episode
//   bitsheet   -> + characters and three-act structure (made up to match), and a bit sheet with the user's bits per episode
//   scenelist  -> + characters, structure and bit sheet (made up to match), and a scene list with the user's scenes per episode
// Everything that talks to the AI is passed in as `models`, so this file can be tested with a scripted model.
import { splitEpisodes } from "./synopsisBrain.js";
import { cleanPastedStory, damageSignals } from "./pasteClean.js";

const BATCH = 5;
const STAGE_NAME = { synopsis: "synopsis", bitsheet: "Bit Sheet", scenelist: "scene one-liners" };

export function seriesFormatFrom(raw) {
  const type = raw?.type === "vertical" ? "vertical" : "series";
  const defaults = type === "vertical" ? { episodeCount: 60, episodeMinutes: 1.5 } : { episodeCount: 10, episodeMinutes: 10 };
  return { type, episodeCount: Number(raw?.episodeCount) > 0 ? Number(raw.episodeCount) : defaults.episodeCount, episodeMinutes: Number(raw?.episodeMinutes) > 0 ? Number(raw.episodeMinutes) : defaults.episodeMinutes };
}

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }

// models: { overview, episodes, characterSheet, threeAct, bitSheet, bits, scenes, finishSceneList }
export async function buildSeriesSkip({ stage, text, format: rawFormat, models, onProgress = () => {} }) {
  if (!["synopsis", "bitsheet", "scenelist"].includes(stage)) throw fail("Unknown start stage.");
  if (!String(text ?? "").trim()) throw fail(`Paste your ${STAGE_NAME[stage]} first.`);
  // read the paste first: keep the story, drop what came from the PDF it was copied from
  const cleaned = cleanPastedStory(text);
  const source = cleaned.text.trim();
  if (!source) throw fail(`Paste your ${STAGE_NAME[stage]} first.`);
  const parts = splitEpisodes(source);
  if (!parts) throw fail("I could not find the episodes. Paste all episodes in this one box, and start each one with a heading like “Episode 1”, “Episode 2” (or “एपिसोड १”).");
  const asked = seriesFormatFrom(rawFormat);
  const format = { ...asked, episodeCount: parts.length }; // the pasted episodes decide the count
  const note = asked.episodeCount !== parts.length ? `You chose ${asked.episodeCount} episodes but pasted ${parts.length}, so the project has ${parts.length}.` : null;

  onProgress("Reading the series");
  const overview = await models.overview({ stage, text: source, format, parts });
  const episodes = [];
  for (const [i, batch] of chunks(parts, BATCH).entries()) {
    onProgress(`Episodes ${i * BATCH + 1}-${i * BATCH + batch.length}`);
    const got = await models.episodes({ stage, parts: batch, startIndex: i * BATCH, overview, format });
    if (!Array.isArray(got) || got.length !== batch.length) throw fail(`I could not read episodes ${i * BATCH + 1}-${i * BATCH + batch.length} properly. Try again.`, 502);
    episodes.push(...got);
  }
  const deck = { title: overview.storylineTitle, logline: overview.storylineLogline, premise: overview.premise, toneGenre: overview.toneGenre, targetAudience: overview.targetAudience, majorCharacters: overview.majorCharacters, format, episodes };
  const built = { stage, format, note, cleanup: cleaned.report.summary, damaged: damageSignals(text).damaged, parts, concept: overview.concept, storyline: { title: overview.storylineTitle, logline: overview.storylineLogline, summary: overview.storylineSummary }, deck };
  if (stage === "synopsis") return built;

  onProgress("Characters");
  built.characterSheet = await models.characterSheet(deck);
  onProgress("Story structure");
  built.threeAct = await models.threeAct(deck, built.characterSheet);

  if (stage === "bitsheet") {
    const episodeBits = [];
    for (const [i, batch] of chunks(parts, BATCH).entries()) {
      onProgress(`Bit Sheet, episodes ${i * BATCH + 1}-${i * BATCH + batch.length}`);
      const got = await models.bits({ parts: batch, startIndex: i * BATCH, deck, format });
      if (!Array.isArray(got) || got.length !== batch.length) throw fail(`I could not read the bits of episodes ${i * BATCH + 1}-${i * BATCH + batch.length}. Try again.`, 502);
      episodeBits.push(...got);
    }
    built.bitSheet = { episodeBits, ...(built.threeAct?.controllingIdea ? { controllingIdea: built.threeAct.controllingIdea } : {}) };
    return built;
  }

  onProgress("Bit Sheet");
  built.bitSheet = await models.bitSheet(built.threeAct, deck);
  const episodeScenes = [];
  for (const [i, batch] of chunks(parts, BATCH).entries()) {
    onProgress(`Scenes, episodes ${i * BATCH + 1}-${i * BATCH + batch.length}`);
    const got = await models.scenes({ parts: batch, startIndex: i * BATCH, deck, format });
    if (!Array.isArray(got) || got.length !== batch.length) throw fail(`I could not read the scenes of episodes ${i * BATCH + 1}-${i * BATCH + batch.length}. Try again.`, 502);
    episodeScenes.push(...got);
  }
  built.sceneList = await models.finishSceneList({ episodeScenes, controllingIdea: built.bitSheet?.controllingIdea ?? null }, format);
  return built;
}

// Saves what buildSeriesSkip made, with the same statuses the film start-from paths use. Returns the new project's id.
export async function saveSeriesSkip(db, built, { setTitle = async () => {}, ownerUserId = null } = {}) {
  const J = JSON.stringify;
  const concept = (await db.query("INSERT INTO concepts (concept_text, storylines, owner_user_id) VALUES ($1, $2, $3) RETURNING id", [built.concept, J([built.storyline]), ownerUserId])).rows[0].id;
  const deckStatus = built.stage === "synopsis" ? null : "approved";
  const deckRow = deckStatus
    ? await db.query("INSERT INTO pitch_decks (concept_id, content, status) VALUES ($1, $2, $3) RETURNING id", [concept, J(built.deck), deckStatus])
    : await db.query("INSERT INTO pitch_decks (concept_id, content) VALUES ($1, $2) RETURNING id", [concept, J(built.deck)]);
  const deckId = deckRow.rows[0].id;
  await setTitle(concept, built.deck.title);
  if (built.stage === "synopsis") return concept;
  await db.query("INSERT INTO character_sheets (pitch_deck_id, content, status) VALUES ($1, $2, 'approved')", [deckId, J(built.characterSheet)]);
  const act = (await db.query("INSERT INTO three_act_structures (pitch_deck_id, content, status) VALUES ($1, $2, 'locked') RETURNING id", [deckId, J(built.threeAct)])).rows[0].id;
  if (built.stage === "bitsheet") {
    await db.query("INSERT INTO bit_sheets (three_act_structure_id, content) VALUES ($1, $2)", [act, J(built.bitSheet)]);
    return concept;
  }
  const bits = (await db.query("INSERT INTO bit_sheets (three_act_structure_id, content, status) VALUES ($1, $2, 'approved') RETURNING id", [act, J(built.bitSheet)])).rows[0].id;
  await db.query("INSERT INTO scene_lists (bit_sheet_id, content) VALUES ($1, $2)", [bits, J(built.sceneList)]);
  return concept;
}
