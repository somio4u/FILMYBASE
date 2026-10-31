// "Import episodes from a Word file": reads a finished screenplay file into episodes and scenes, in the same shape the app
// itself stores them. No AI and no database in here, so it is easy to test.
//
// The file looks like the app's own export:
//   EPISODE 4: THE PUNISHMENT OF DUST (title)
//   SCENE 1 (2 minutes)            <- the time in brackets is optional
//   EXT. KALI TEMPLE GROUNDS - NIGHT
//   Characters: SOUMYA, NAYANA     <- optional
//   an action line ...
//   SOUMYA                         <- a speaker in English capitals
//   (softly)                       <- optional acting note
//   the spoken words
//   FADE OUT.                      <- a transition
//
// A scene's action lines and dialogue are kept word for word; nothing is rewritten.
import { TRANSITION_LINE } from "./transitionNames.js";

const ODIA_DIGITS = "୦୧୨୩୪୫୬୭୮୯";
export function toAsciiDigits(text) {
  return String(text ?? "").replace(/[୦-୯]/g, (d) => String(ODIA_DIGITS.indexOf(d)));
}

const hasOdia = (text) => /[଀-୿]/.test(text);
const hasDevanagari = (text) => /[ऀ-ॿ]/.test(text);

// "(2 minutes 30 seconds)" in English or Odia -> 2.5; nothing readable -> null
export function parseDurationMinutes(text) {
  const t = toAsciiDigits(text).toLowerCase();
  const minutes = /(\d+(?:\.\d+)?)\s*(?:min|ମିନିଟ୍|ମିନିଟ|minutes?)/.exec(t);
  const seconds = /(\d+)\s*(?:sec|ସେକେଣ୍ଡ|ସେକେଣ୍ଡ୍|seconds?)/.exec(t);
  if (!minutes && !seconds) return null;
  const value = (minutes ? Number(minutes[1]) : 0) + (seconds ? Number(seconds[1]) / 60 : 0);
  return value > 0 ? Math.round(value * 10) / 10 : null;
}

const EPISODE_LINE = /^(?:EPISODE|ଏପିସୋଡ୍|ଏପିସୋଡ)\s*([0-9୦-୯]+)\s*[:：—–.-]?\s*(.*)$/i;
const SCENE_LINE = /^SCENE\s+([0-9୦-୯]+[A-Z]?)\s*(?:[(\[（]\s*(.*?)\s*[)\]）])?\s*[:.]?\s*$/i;
const SLUGLINE = /^(?:INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|INT|EXT)[. ]\s*\S/i;
const CHARACTERS_LINE = /^Characters?\s*:\s*(.*)$/i;
const TRANSITION = TRANSITION_LINE; // see transitionNames.js (also FREEZE. BREAK-, BREAK, INTERVAL …)
const CUE = /^([A-Z][A-Z0-9 .'’\-]{0,34}?)(?:\s*\((V\.O\.|O\.S\.|CONT'D|ECHOING)\))?$/;
const TIME_WORD = /\b(MORNING|AFTERNOON|EVENING|NIGHT|DAY|DAWN|DUSK|MIDNIGHT|NOON|SUNSET|SUNRISE)\b/i;
const BREAK_ONLY = /^[-_*=\s]{3,}$/;

const isEpisodeLine = (line) => EPISODE_LINE.test(line) && /^(?:EPISODE|ଏପିସୋଡ୍|ଏପିସୋଡ)\s*[0-9୦-୯]+\s*[:：—–.-]/i.test(line);
const isStructural = (line) => isEpisodeLine(line) || SCENE_LINE.test(line) || SLUGLINE.test(line) || CHARACTERS_LINE.test(line);

// "INT./EXT. TEMPLE SITE - NIGHT" -> { intExt, location, timeOfDay }
export function headingParts(heading) {
  const text = String(heading ?? "").replace(/\s+/g, " ").trim();
  const m = /^(INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|INT|EXT)[. ]\s*(.*)$/i.exec(text);
  const tag = (m?.[1] ?? "INT").toUpperCase().replace(/[.\s]/g, "");
  const intExt = tag.startsWith("EXT") ? "EXT" : "INT";
  const rest = (m?.[2] ?? text).trim().replace(/^[-–—:]\s*/, ""); // "INT - DAY - HOUSE": the dash after the tag is only a separator
  const parts = rest.split(/\s+[-–—]\s+/);
  // "INT DAY ADITYA HOUSE" (no dashes at all): a time word first, then the place
  if (parts.length === 1) {
    const leading = /^(MORNING|AFTERNOON|EVENING|NIGHT|DAY|DAWN|DUSK|MIDNIGHT|NOON|SUNSET|SUNRISE)\s+(\S.*)$/i.exec(parts[0]);
    if (leading) parts.splice(0, 1, leading[1], leading[2]);
  }
  let timeOfDay = "DAY";
  let locationParts = parts;
  if (parts.length > 1 && new RegExp(`^${TIME_WORD.source}$`, "i").test(parts[0].trim())) {
    // time first, place after: "INT - DAY - ADITYA HOUSE DINING"
    timeOfDay = parts[0].trim().toUpperCase();
    locationParts = parts.slice(1);
  } else if (parts.length > 1) {
    const last = parts[parts.length - 1];
    const word = TIME_WORD.exec(last);
    if (word) { timeOfDay = word[1].toUpperCase(); locationParts = parts.slice(0, -1); }
  }
  const location = locationParts.join(" - ").replace(/[.,;:]+$/, "").trim() || rest;
  return { intExt, location, timeOfDay };
}

function oneLinerOf(elements) {
  const firstAction = elements.find((e) => e.type === "action")?.text ?? elements.find((e) => e.type === "dialogue")?.text ?? "";
  const sentence = firstAction.split(/[।.!?]\s*/)[0]?.trim() || firstAction.trim();
  const text = sentence.length > 20 ? sentence : firstAction.trim();
  return text.length > 180 ? `${text.slice(0, 177).trim()}...` : text;
}

function estimateMinutes(elements) {
  // about 12 short beats a minute, never below half a minute
  const words = elements.reduce((n, e) => n + String(e.text ?? "").split(/\s+/).filter(Boolean).length, 0);
  return Math.max(0.5, Math.min(15, Math.round((words / 110) * 2) / 2 || 1));
}

export function languageOf(text) {
  if (hasOdia(text)) return "or";
  if (hasDevanagari(text)) return "hi";
  return "en";
}

// the whole file -> { episodes: [{ number, title, declaredMinutes, scenes: [...] }], warnings }
export function parseEpisodesFromText(rawText) {
  const raw = String(rawText ?? "").replace(/\r\n/g, "\n").replace(/ /g, " ").split("\n");
  const lines = raw.map((l) => l.replace(/[​‌‍]/g, (c) => (c === "‌" ? c : "")).trim());
  const warnings = [];
  const episodes = [];
  let episode = null;
  let scene = null;
  // A draft without "SCENE 1" lines (headings only): every heading starts a new scene. With "SCENE n" lines, a second heading inside a scene is a change of place.
  const hasSceneMarkers = lines.some((l) => SCENE_LINE.test(l));

  const startEpisode = (number, title) => {
    episode = { number, title: title.replace(/\s*\([^)]*\)\s*$/, "").trim(), declaredMinutes: null, scenes: [] };
    episodes.push(episode);
    scene = null;
  };
  const ensureEpisode = () => { if (!episode) startEpisode(1, ""); };
  const push = (element) => { if (scene && String(element.text ?? "").trim()) scene.elements.push(element); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || BREAK_ONLY.test(line)) continue;

    if (isEpisodeLine(line)) {
      const m = EPISODE_LINE.exec(line);
      startEpisode(Number(toAsciiDigits(m[1])), m[2] ?? "");
      continue;
    }
    if (episode && !scene && episode.declaredMinutes === null && /(ମିନିଟ୍|minutes?)/i.test(line) && /(ସିନ୍|scenes?)/i.test(line)) {
      episode.declaredMinutes = parseDurationMinutes(line.split(/[•|]/).pop());
      continue;
    }

    const sceneStart = SCENE_LINE.exec(line);
    if (sceneStart) {
      ensureEpisode();
      scene = { number: toAsciiDigits(sceneStart[1]), minutes: sceneStart[2] ? parseDurationMinutes(sceneStart[2]) : null, heading: null, characters: [], elements: [] };
      episode.scenes.push(scene);
      continue;
    }

    if (SLUGLINE.test(line)) {
      ensureEpisode();
      if (!scene) {
        scene = { number: String(episode.scenes.length + 1), minutes: null, heading: line, characters: [], elements: [] };
        episode.scenes.push(scene);
      } else if (!scene.heading) {
        scene.heading = line;
      } else if (!hasSceneMarkers) {
        scene = { number: String(episode.scenes.length + 1), minutes: null, heading: line, characters: [], elements: [] };
        episode.scenes.push(scene);
      } else {
        push({ type: "action", character: "", text: line }); // a change of place inside one scene stays in the scene
      }
      continue;
    }
    if (!scene) continue;

    const chars = CHARACTERS_LINE.exec(line);
    if (chars) {
      scene.characters = chars[1].split(/[,，;]/).map((c) => c.trim()).filter(Boolean);
      continue;
    }

    const bare = line.replace(/\*\*|__/g, "").replace(/^\*+|\*+$/g, "").trim();
    if (TRANSITION.test(bare) || (bare === bare.toUpperCase() && /\bCUT TO\b/.test(bare) && !hasOdia(bare))) {
      push({ type: "transition", character: "", text: bare.toUpperCase().replace(/\s+/g, " ") });
      continue;
    }

    // a speaker: English capitals only, then an optional (acting note), then the spoken words
    const cue = !hasOdia(bare) && !hasDevanagari(bare) ? CUE.exec(bare) : null;
    if (cue && !/^(?:INT|EXT|SCENE|EPISODE)\b/.test(bare)) {
      let j = i + 1;
      while (j < lines.length && !lines[j]) j++;
      if (j < lines.length && !isStructural(lines[j]) && !TRANSITION.test(lines[j])) {
        let parenthetical = "";
        const note = /^\((.*)\)$/.exec(lines[j]);
        if (note) {
          parenthetical = note[1].trim();
          j++;
          while (j < lines.length && !lines[j]) j++;
        }
        if (j < lines.length && lines[j] && !isStructural(lines[j])) {
          const spoken = [lines[j]];
          // lines that follow with no blank line between belong to the same speech (plain-text files)
          let k = j;
          while (k + 1 < lines.length && lines[k + 1] && !isStructural(lines[k + 1]) && !TRANSITION.test(lines[k + 1]) && !(CUE.test(lines[k + 1]) && !hasOdia(lines[k + 1]))) {
            spoken.push(lines[k + 1]);
            k++;
          }
          let text = spoken.join(" ").replace(/\*\*|__/g, "").trim().replace(/^["“”]+|["“”]+$/g, "").trim();
          const inline = /^\(([^()]{1,80})\)\s+(.+)$/.exec(text);
          if (inline && !parenthetical) { parenthetical = inline[1].trim(); text = inline[2].trim(); }
          push({ type: "dialogue", character: cue[1].trim(), characterModifier: cue[2] ?? "none", parenthetical, text });
          i = k;
          continue;
        }
      }
    }

    push({ type: "action", character: "", text: bare });
  }

  const flat = episodes.flatMap((e) => e.scenes.map((s) => ({ e, s })));
  if (flat.length === 0) warnings.push("No scenes were found. Each scene needs a line like \"SCENE 1\" and a heading like \"INT. PLACE - DAY\".");
  for (const { e, s } of flat) {
    if (!s.heading) warnings.push(`Episode ${e.number}, scene ${s.number} has no heading (INT./EXT. place - time), so it was read as "INT. UNKNOWN - DAY".`);
    if (s.elements.length === 0) warnings.push(`Episode ${e.number}, scene ${s.number} has no content.`);
  }
  const seen = new Set();
  for (const e of episodes) {
    if (seen.has(e.number)) warnings.push(`Episode ${e.number} appears more than once in the file; the later one is used.`);
    seen.add(e.number);
  }

  // finish every scene: heading parts, characters, length, one-liner
  for (const { s } of flat) {
    const parts = headingParts(s.heading ?? "INT. UNKNOWN - DAY");
    s.heading = s.heading ?? "INT. UNKNOWN - DAY";
    s.intExt = parts.intExt;
    s.location = parts.location;
    s.timeOfDay = parts.timeOfDay;
    if (s.characters.length === 0) s.characters = [...new Set(s.elements.filter((e) => e.type === "dialogue").map((e) => e.character))];
    s.minutes = s.minutes ?? estimateMinutes(s.elements);
    s.oneLiner = oneLinerOf(s.elements);
  }
  for (const e of episodes) e.minutes = Math.round(e.scenes.reduce((n, s) => n + (s.minutes ?? 0), 0) * 10) / 10;

  // a repeated episode number: keep the last one
  const last = new Map();
  for (const e of episodes) last.set(e.number, e);
  return { episodes: [...last.values()].sort((a, b) => a.number - b.number), warnings };
}

// what the screenplay stores for one scene
export function sceneContent(scene, language) {
  return {
    elements: scene.elements.map((e) => (e.type === "dialogue"
      ? { type: "dialogue", character: e.character, characterModifier: e.characterModifier ?? "none", ...(e.parenthetical ? { parenthetical: e.parenthetical } : {}), text: e.text }
      : { type: e.type, character: "", text: e.text })),
    charactersPresent: scene.characters,
    dialogueLanguage: language,
    editedByUser: true,
    importedFromFile: true,
  };
}

// the scene-list line for one scene (what the left panel and the schedule use)
export function outlineFor(scene, index, old, episodeNumber, previousNumbers) {
  const text = (value) => ({ en: value, or: value, hi: value });
  const prefixed = /^(.*?)(\d+)$/.exec(String(previousNumbers?.[0] ?? ""));
  const episodic = /^E\d+S\d+$/i.exec(String(previousNumbers?.[0] ?? ""));
  const sceneNumber = episodic ? `E${episodeNumber}S${index + 1}` : prefixed ? `${prefixed[1]}${index + 1}` : String(index + 1);
  return {
    actNumber: old?.actNumber ?? 1,
    sceneNumber,
    intExt: scene.intExt,
    location: text(scene.location),
    timeOfDay: scene.timeOfDay,
    oneLiner: text(scene.oneLiner),
    estimatedMinutes: Math.max(0.5, Math.min(15, Number(scene.minutes) || 2)),
    purpose: old?.purpose ?? "plot_advancing",
    importedFromFile: true,
  };
}
