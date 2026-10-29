// "Look at what the PDF really contains BEFORE putting it anywhere" — Step 1 of the PDF import (read only: nothing is saved here).
// The PDF is read into plain text first (pdfReader.js, kind "screenplay": every line kept as laid out). This file then answers, without any AI
// (so it is free and cannot hit a quota): which stage is this material at, and what exactly is in it?
//
//   stage "screenplay"   scenes with their own written lines (dialogue / action) — fully or partly written
//   stage "scene_list"   scene headings, each with only a one-line summary
//   stage "bit_sheet"    numbered story beats, no scene headings
//   stage "synopsis"     prose that tells the story, possibly split into episodes, no scene headings
//   stage "characters"   a list of people with descriptions
//   stage "idea"         a short idea / logline / unstructured text
//
// A screenplay can be PARTLY written: some scenes have dialogue, the rest are only one-liners. The report lists both groups, so nothing is
// skipped and the writer knows exactly which scenes still have to be written.
import { parseEpisodesFromText } from "./screenplayImport.js";

const hasOdia = (t) => /[଀-୿]/.test(t);
const hasDevanagari = (t) => /[ऀ-ॿ]/.test(t);

// scene lines of a plain list, with a leading number: "1. INT. TEMPLE - NIGHT — Balaram pressures…", "Scene 4: EXT. ROAD - DAY"
const NUMBERED_HEADING = /^\s*(?:scene\s*)?\d{1,4}\s*[.):\-–—]\s*(?:INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|INT|EXT)[. ]\s*\S/im;
const HEADING_LINE = /^\s*(?:(?:scene\s*)?\d{1,4}\s*[.):\-–—]\s*)?(?:INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|INT|EXT)[. ]\s*\S/i;
const BEAT_LINE = /^\s*(?:beat\s*)?\d{1,3}\s*[.):\-–—]\s+\S{3,}/i;
const EPISODE_HEAD = /^\s*(?:episode|ep\.?|ଏପିସୋଡ୍?)\s*[0-9୦-୯]+/i;
const PERSON_LINE = /^\s*[-•*]?\s*([A-Z][A-Za-z'’. ]{1,28}|[଀-୿ऀ-ॿ][^:–—\-]{1,28})\s*[:–—-]\s*\S.{25,}$/;

export function languageName(text) {
  const odia = (text.match(/[଀-୿]/g) || []).length;
  const hindi = (text.match(/[ऀ-ॿ]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (odia > hindi && odia > latin * 0.15) return odia > latin ? "Odia" : "Odia + English";
  if (hindi > odia && hindi > latin * 0.15) return hindi > latin ? "Hindi" : "Hindi + English";
  return "English";
}

const wordCount = (s) => String(s ?? "").split(/\s+/).filter(Boolean).length;

// one scene: has the writer really written it (dialogue, or several action lines), or is it only a one-line summary?
export function sceneState(scene) {
  const dialogue = scene.elements.filter((e) => e.type === "dialogue").length;
  const action = scene.elements.filter((e) => e.type === "action").length;
  const words = scene.elements.reduce((n, e) => n + wordCount(e.text), 0);
  if (dialogue > 0) return { state: "written", dialogue, action, words };
  if (action >= 3 || words >= 90) return { state: "written", dialogue, action, words }; // narrated scene without speech
  if (scene.elements.length === 0) return { state: "empty", dialogue, action, words };
  return { state: "one_liner", dialogue, action, words };
}

export function analyzeImportedText(rawText) {
  const text = String(rawText ?? "").replace(/\r\n/g, "\n").trim();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const language = languageName(text);
  const base = { language, words: wordCount(text), lines: lines.length };
  if (!text) return { ...base, stage: "empty", episodes: [], scenes: [], totals: { episodes: 0, scenes: 0, written: 0, oneLiner: 0, empty: 0, dialogueLines: 0 }, characters: [], warnings: ["Nothing readable was found."] };

  const headingCount = lines.filter((l) => HEADING_LINE.test(l)).length;
  const parsed = headingCount > 0 ? parseEpisodesFromText(numberedHeadingsToPlain(text)) : { episodes: [], warnings: [] };
  const flat = parsed.episodes.flatMap((e) => e.scenes.map((s) => ({ episode: e, scene: s })));

  const scenes = flat.map(({ episode, scene }) => {
    const st = sceneState(scene);
    return {
      episode: episode.number, number: scene.number, heading: scene.heading, oneLiner: scene.oneLiner, state: st.state,
      dialogueLines: st.dialogue, actionLines: st.action, words: st.words,
    };
  });
  const totals = {
    episodes: parsed.episodes.length,
    scenes: scenes.length,
    written: scenes.filter((s) => s.state === "written").length,
    oneLiner: scenes.filter((s) => s.state === "one_liner").length,
    empty: scenes.filter((s) => s.state === "empty").length,
    dialogueLines: scenes.reduce((n, s) => n + s.dialogueLines, 0),
  };

  // who speaks, how much
  const speak = new Map();
  for (const { scene } of flat) for (const e of scene.elements) if (e.type === "dialogue" && e.character) speak.set(e.character, (speak.get(e.character) ?? 0) + 1);
  const characters = [...speak.entries()].sort((a, b) => b[1] - a[1]).map(([name, lines]) => ({ name, lines }));

  const episodeHeads = lines.filter((l) => EPISODE_HEAD.test(l)).length;
  const beatLines = lines.filter((l) => BEAT_LINE.test(l)).length;
  const personLines = lines.filter((l) => PERSON_LINE.test(l)).length;
  const warnings = [...parsed.warnings.filter((w) => !/has no content/.test(w))];

  let stage;
  if (totals.scenes >= 1 && totals.written >= 1) stage = "screenplay";
  else if (totals.scenes >= 1) stage = "scene_list";
  else if (beatLines >= 5 && beatLines >= lines.length * 0.4) stage = "bit_sheet";
  else if (personLines >= 4 && personLines >= lines.length * 0.4) stage = "characters";
  else if (base.words >= 350 || episodeHeads >= 1) stage = "synopsis";
  else stage = "idea";

  return {
    ...base, stage, episodes: parsed.episodes.map((e) => ({ number: e.number, title: e.title, scenes: e.scenes.length })),
    scenes, totals, characters, beats: stage === "bit_sheet" ? beatLines : 0, people: stage === "characters" ? personLines : 0,
    episodeHeadings: episodeHeads, warnings,
  };
}

// "1. INT. TEMPLE - NIGHT — one line" (a numbered list) -> the "SCENE 1 / INT. TEMPLE - NIGHT / one line" shape the parser reads.
function numberedHeadingsToPlain(text) {
  if (!NUMBERED_HEADING.test(text)) return text;
  return text.split("\n").map((line) => {
    const m = /^\s*(?:scene\s*)?(\d{1,4})\s*[.):\-–—]\s*((?:INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|INT|EXT)[. ]\s*\S.*)$/i.exec(line);
    if (!m) return line;
    // heading and summary on one line: "INT. PLACE - NIGHT — summary" -> split at the dash that follows the time word
    const split = /^(.*?\b(?:MORNING|AFTERNOON|EVENING|NIGHT|DAY|DAWN|DUSK|MIDNIGHT|NOON|SUNSET|SUNRISE)\b\.?)\s*[—–:-]\s+(.+)$/i.exec(m[2]);
    return split ? `SCENE ${m[1]}\n${split[1]}\n${split[2]}` : `SCENE ${m[1]}\n${m[2]}`;
  }).join("\n");
}

// The plain-language report the writer reads (English; the screen shows it as is, and in Odia through reportOdia).
export const STAGE_LABEL = {
  screenplay: "Screenplay stage", scene_list: "Scene one-liners stage", bit_sheet: "Bit sheet stage", synopsis: "Synopsis stage",
  characters: "Character development stage", idea: "Idea stage", empty: "Nothing readable",
};

export function reportLines(a) {
  const t = a.totals;
  const out = [];
  out.push(`This PDF is at the ${STAGE_LABEL[a.stage]}. It is in ${a.language}, about ${a.words} words.`);
  if (a.stage === "screenplay") {
    out.push(`It has ${t.scenes} scene${t.scenes === 1 ? "" : "s"}${t.episodes > 1 ? ` in ${t.episodes} episodes` : ""}. ${t.written} ${t.written === 1 ? "is" : "are"} written out (with ${t.dialogueLines} dialogue lines in all)${t.oneLiner + t.empty ? `, and ${t.oneLiner + t.empty} ${t.oneLiner + t.empty === 1 ? "has" : "have"} only a one-line summary and still need${t.oneLiner + t.empty === 1 ? "s" : ""} to be written` : ", nothing is missing"}.`);
    if (a.characters.length) out.push(`Speaking characters: ${a.characters.slice(0, 12).map((c) => `${c.name} (${c.lines})`).join(", ")}${a.characters.length > 12 ? " …" : ""}.`);
    out.push(`Plan: the ${t.written} written scene${t.written === 1 ? "" : "s"} go in exactly as they are, word for word, and stay editable${t.oneLiner + t.empty ? `; the ${t.oneLiner + t.empty} one-liner scene${t.oneLiner + t.empty === 1 ? "" : "s"} go in as “not written yet”, ready for you to write` : ""}. Nothing is skipped.`);
  } else if (a.stage === "scene_list") {
    out.push(`It has ${t.scenes} scene${t.scenes === 1 ? "" : "s"}, each with only a one-line summary. No dialogue is written yet, so none is lost by starting from the scene one-liners.`);
  } else if (a.stage === "bit_sheet") {
    out.push(`It has about ${a.beats} numbered story beats and no scene headings. The scenes have not been made yet.`);
  } else if (a.stage === "synopsis") {
    out.push(`It reads as a story synopsis${a.episodeHeadings ? ` split into ${a.episodeHeadings} episode heading${a.episodeHeadings === 1 ? "" : "s"}` : ""}. There are no scenes yet.`);
  } else if (a.stage === "characters") {
    out.push(`It describes about ${a.people} characters. There is no story or scenes in it yet.`);
  } else if (a.stage === "idea") {
    out.push("It is a short idea. There is no structure yet (no episodes, beats or scenes).");
  }
  if (a.warnings.length) out.push(`Check: ${a.warnings.slice(0, 3).join(" ")}`);
  return out;
}
