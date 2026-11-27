// Moving a project between the two sides of the app, without any AI and without touching the original:
//   AI Movie  ->  Movie (Story & Screenplay, film): the written scenes become the film's screenplay, exactly as written, through the SAME builder an imported
//                  PDF uses (screenplayProject.js), so every Movie function (acts, scene list, schedule, doctors, Buddy…) works on it like on any Movie project.
//   Movie     ->  AI Movie: the written scenes become the AI Movie screenplay (grouped into four beats by running time), with the story, characters and title.
// The new project is a separate copy; the one it came from stays exactly as it is.
import { buildScreenplayProject, saveScreenplayProject } from "./screenplayProject.js";
import { assignScenesToBeats } from "./screenplayTextParser.js";
import { createProjectLink } from "./projectLinks.js";

const pick = (value, language) => {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const order = [language, "en", "hi", "or"];
    for (const key of order) if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
    return String(Object.values(value).find((x) => typeof x === "string" && x.trim()) ?? "").trim();
  }
  return "";
};
const both = (t) => ({ en: t, hi: t });
const clip = (t, n) => { const s = String(t ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1).trim()}…` : s; };

// the language that has the most text in an AI Movie (it keeps English and Hindi side by side)
export function chooseLanguage(backfill) {
  const count = { en: 0, hi: 0 };
  for (const beat of backfill?.screenplayBeats ?? []) for (const scene of beat?.scenes ?? []) for (const b of scene?.content ?? []) {
    const v = b?.line ?? b?.text;
    if (v && typeof v === "object") for (const k of ["en", "hi"]) if (String(v[k] ?? "").trim()) count[k] += 1;
  }
  return count.hi > count.en ? "hi" : "en";
}

const HEADING = /^\s*(INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|I\s*\/\s*E|INT|EXT)\b\.?\s*(.*?)\s*(?:[-–—]\s*([A-Za-z ]+?))?\s*$/i;
const splitHeading = (heading) => {
  const m = HEADING.exec(heading ?? "");
  return m ? { intExt: m[1].toUpperCase().replace(/\s/g, "").replace(/\./g, ""), location: (m[2] ?? "").trim() || "LOCATION", timeOfDay: (m[3] ?? "").trim().toUpperCase() || "DAY" } : { intExt: "INT", location: String(heading ?? "").trim() || "LOCATION", timeOfDay: "DAY" };
};

// an AI Movie scene's lines, as one flat list; both the current layout (content blocks) and the old one (action + dialogue lists) are read
function blocksOf(scene, language) {
  const out = [];
  if (Array.isArray(scene?.content) && scene.content.length) {
    for (const b of scene.content) {
      if (b?.type === "dialogue") {
        const text = pick(b.line ?? b.text, language);
        if (text && b.character) out.push({ type: "dialogue", character: String(b.character).toUpperCase(), characterModifier: b.extension === "V.O." || b.extension === "O.S." ? b.extension : "none", parenthetical: pick(b.parenthetical, language), text });
      } else if (b?.type === "transition") {
        const text = String(b.transition ?? "").trim();
        if (text) out.push({ type: "transition", character: "", text });
      } else {
        const text = pick(b?.text, language);
        if (text) out.push({ type: "action", character: "", text });
      }
    }
    return out;
  }
  const action = pick(scene?.action, language);
  if (action) out.push({ type: "action", character: "", text: action });
  for (const d of scene?.dialogue ?? []) { const text = pick(d?.line, language); if (text && d?.character) out.push({ type: "dialogue", character: String(d.character).toUpperCase(), characterModifier: "none", parenthetical: "", text }); }
  return out;
}

// ---- AI Movie -> Movie --------------------------------------------------------------------------------------------------------------------------
export function filmEpisodeFromAiMovie(backfill, language = chooseLanguage(backfill)) {
  const scenes = [];
  for (const beat of backfill?.screenplayBeats ?? []) for (const raw of beat?.scenes ?? []) {
    const elements = blocksOf(raw, language);
    if (elements.length === 0) continue;
    const heading = pick(raw.sceneHeading, language) || "INT. LOCATION - DAY";
    const characters = [...new Set(elements.filter((e) => e.type === "dialogue").map((e) => e.character))];
    scenes.push({ number: String(scenes.length + 1), minutes: Math.max(0.5, Math.min(15, Number(raw.estimatedMinutes) || 2)), heading, characters, elements, ...splitHeading(heading), oneLiner: clip(elements.find((e) => e.type === "action")?.text ?? elements[0].text, 120) });
  }
  return { number: 1, title: "", declaredMinutes: null, scenes, minutes: scenes.reduce((n, s) => n + s.minutes, 0) };
}

export async function aiMovieToFilm(db, projectId, { ownerUserId = null, language = null, link = false } = {}) {
  const project = (await db.query("SELECT id, title, backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0];
  if (!project) throw Object.assign(new Error("The AI Movie project was not found."), { status: 404 });
  const lang = language ?? chooseLanguage(project.backfill);
  const episode = filmEpisodeFromAiMovie(project.backfill, lang);
  if (episode.scenes.length === 0) throw Object.assign(new Error("This AI Movie has no written scenes yet, so there is no screenplay to bring into Movie. Write the screenplay first."), { status: 422 });
  const title = String(project.title || pick(project.backfill?.story?.title, lang) || "AI Movie").trim();
  const runtime = Math.round(episode.minutes) || 90;
  const built = buildScreenplayProject({ episodes: [episode], warnings: [] }, { title, format: { type: "film", runtimeMinutes: runtime } });
  // what the AI Movie already knew about the story goes into the Movie's pitch deck, instead of an empty one
  const synopsis = pick(project.backfill?.synopsis, lang);
  if (synopsis) { built.deck.logline = both(clip(synopsis, 300)); built.deck.premise = both(clip(synopsis, 1500)); built.storyline.summary = both(clip(synopsis, 1500)); }
  const names = (project.backfill?.characterArc ?? []).map((c) => String(c?.name ?? "").trim()).filter(Boolean);
  for (const name of names) if (!built.characterSheet.characters.some((c) => c.name.toUpperCase() === name.toUpperCase())) built.characterSheet.characters.push({ ...built.characterSheet.characters[0], name, role: both(""), want: both(""), need: both(""), flaw: both(""), innerConflict: both(""), outerConflict: both(""), arc: both(""), introductionBeat: both(""), archetypeNote: both(""), virtues: [] });
  const conceptId = await saveScreenplayProject(db, built, { ownerUserId, setTitle: async (id, t) => { await db.query("UPDATE concepts SET title = $2 WHERE id = $1", [id, t]); } });
  if (link) await createProjectLink(db, { filmConceptId: conceptId, aiMovieId: projectId, language: lang });
  return { module: "film", projectRef: conceptId, title, scenes: built.summary.scenes, language: lang, linked: Boolean(link) };
}

// ---- Movie -> AI Movie ----------------------------------------------------------------------------------------------------------------------------
const ACTS = [["Act 1 — Setup", 25], ["Act 2 — Confrontation (first half)", 25], ["Act 2 — Confrontation (second half)", 25], ["Act 3 — Resolution", 25]];

export function aiMovieBackfillFromFilm({ title, deck, characterNames, outlines, written }) {
  // written: Map of sceneIndex -> { elements }; only scenes that really have lines travel
  const scenes = [];
  outlines.forEach((outline, index) => {
    const row = written.get(index);
    if (!row?.elements?.length) return;
    const heading = [outline?.intExt, pick(outline?.location, "en")].filter(Boolean).join(". ").replace(/^(INT|EXT)\. /, "$1. ") + (outline?.timeOfDay ? ` - ${outline.timeOfDay}` : "");
    const content = row.elements.map((e) => {
      if (e.type === "dialogue") return { type: "dialogue", character: String(e.character ?? "").toUpperCase(), line: both(String(e.text ?? "")), ...(e.parenthetical ? { parenthetical: both(e.parenthetical) } : {}), ...(e.characterModifier === "V.O." || e.characterModifier === "O.S." ? { extension: e.characterModifier } : {}) };
      if (e.type === "transition") return { type: "transition", transition: String(e.text ?? "").toUpperCase() };
      return { type: "action", text: both(String(e.text ?? "")) };
    });
    scenes.push({ sceneHeading: both(heading.trim() || "INT. LOCATION - DAY"), content, addedByUser: true, estimatedMinutes: Math.max(0.5, Math.min(15, Number(outline?.estimatedMinutes) || 2)) });
  });
  if (scenes.length === 0) throw Object.assign(new Error("This Movie has no written scenes yet, so there is no screenplay to bring into AI Movie. Write some scenes first."), { status: 422 });
  const total = scenes.reduce((n, s) => n + s.estimatedMinutes, 0);
  // four beats (the acts) when there are enough scenes; with fewer than four scenes, one beat for each scene, so no beat is ever empty
  const beatCount = Math.min(ACTS.length, scenes.length);
  const plot = Array.from({ length: beatCount }, (_, i) => ({ title: both(beatCount === ACTS.length ? ACTS[i][0] : `Part ${i + 1}`), description: both(""), runtimeMinutes: Math.round((total / beatCount) * 10) / 10 || 1 }));
  const groups = assignScenesToBeats(scenes.map((s) => s.estimatedMinutes), plot.map((b) => b.runtimeMinutes));
  const synopsis = pick(deck?.premise, "en") || pick(deck?.logline, "en");
  return {
    story: { title: both(title) },
    synopsis: both(synopsis),
    characterArc: characterNames.map((name) => ({ name })),
    plot,
    screenplayBeats: groups.map((g) => ({ status: "approved", feedback: null, scenes: g.map((i) => scenes[i]) })),
    ...(beatCount === ACTS.length ? { intervalAfterBeat: 1 } : {}),
    uploadedScreenplay: { filename: "brought over from Movie", at: new Date().toISOString() }, // the writer's own text: nothing changes it on its own
    scenesLeftOut: outlines.length - scenes.length,
  };
}

export async function filmToAiMovie(db, conceptId, { actorUserId = null, link = false } = {}) {
  const concept = (await db.query("SELECT id, title, concept_text FROM concepts WHERE id = $1", [conceptId])).rows[0];
  if (!concept) throw Object.assign(new Error("The Movie project was not found."), { status: 404 });
  const list = (await db.query(
    `SELECT sl.id, sl.content FROM scene_lists sl LEFT JOIN bit_sheets bs ON bs.id = sl.bit_sheet_id LEFT JOIN three_act_structures tas ON tas.id = bs.three_act_structure_id
     LEFT JOIN pitch_decks pd ON pd.id = tas.pitch_deck_id WHERE sl.concept_id = $1 OR pd.concept_id = $1 ORDER BY sl.created_at DESC, sl.id DESC LIMIT 1`, [conceptId])).rows[0];
  if (!list) throw Object.assign(new Error("This Movie has no scene list yet, so there is no screenplay to bring over."), { status: 422 });
  if (Array.isArray(list.content?.episodeScenes)) throw Object.assign(new Error("This is a series. Bringing a series into AI Movie is not available yet — only a film."), { status: 422 });
  const rows = (await db.query(
    `SELECT DISTINCT ON (scene_index) scene_index, content FROM screenplay_scenes WHERE scene_list_id = $1 AND episode_index IS NULL ORDER BY scene_index, created_at DESC, id DESC`, [list.id])).rows;
  const written = new Map(rows.map((r) => [r.scene_index, r.content]));
  const deck = (await db.query("SELECT content FROM pitch_decks WHERE concept_id = $1 ORDER BY id DESC LIMIT 1", [conceptId])).rows[0]?.content ?? {};
  const sheet = (await db.query("SELECT cs.content FROM character_sheets cs JOIN pitch_decks pd ON pd.id = cs.pitch_deck_id WHERE pd.concept_id = $1 ORDER BY cs.id DESC LIMIT 1", [conceptId])).rows[0]?.content;
  const names = (sheet?.characters ?? []).map((c) => (typeof c?.name === "string" ? c.name : pick(c?.name, "en"))).filter(Boolean);
  const title = String(concept.title || pick(deck.title, "en") || concept.concept_text?.slice(0, 60) || "Movie").trim();
  const backfill = aiMovieBackfillFromFilm({ title, deck, characterNames: names, outlines: list.content?.scenes ?? [], written });
  const left = backfill.scenesLeftOut; delete backfill.scenesLeftOut;
  const id = (await db.query(
    "INSERT INTO ai_movie_projects (title, pasted_text, detected_stage, backfill, stage_status, created_by) VALUES ($1, $2, 'screenplay', $3, $4, $5) RETURNING id",
    [title, String(concept.concept_text ?? "").slice(0, 4000), JSON.stringify(backfill), JSON.stringify({ screenplay: { status: "approved", feedback: null } }), actorUserId])).rows[0].id;
  if (link) await createProjectLink(db, { filmConceptId: conceptId, aiMovieId: id, language: "en" });
  return { module: "ai_movie", projectRef: id, title, scenes: backfill.screenplayBeats.reduce((n, b) => n + b.scenes.length, 0), scenesLeftOut: left, linked: Boolean(link) };
}
