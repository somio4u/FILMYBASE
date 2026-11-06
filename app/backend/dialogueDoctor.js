// Dialogue Doctor — looks ONLY at what characters say, where they should say it, and where they should stay quiet.
// Built from the owner's "Dialogue Doctor" skill. Two kinds of work, kept apart on purpose:
//   * COUNTING is done by code, exactly (lines, words, dialogue share, who speaks, long speeches, ping-pong, narration, pairs) — never guessed by the AI.
//   * JUDGING (is it good, does it hit, silence, missing beats, comedy) is done by the AI, scene group by scene group, with the counts in front of it.
// The result can be sent to Script Doctor as a list of changes, so the same ▶ "make the changes" button works on it.

export const FLAGS = ["KEEP", "TRIM", "EXPAND", "CUT_TO_SILENCE", "ADD_DIALOGUE", "ADD_EMOTION", "ADD_LIGHT_COMEDY", "REWRITE_VOICE", "ON_THE_NOSE"];
export const FLAG_LABEL = { KEEP: "KEEP", TRIM: "TRIM", EXPAND: "EXPAND", CUT_TO_SILENCE: "CUT → SILENCE", ADD_DIALOGUE: "ADD DIALOGUE", ADD_EMOTION: "ADD EMOTION", ADD_LIGHT_COMEDY: "ADD LIGHT COMEDY", REWRITE_VOICE: "REWRITE VOICE", ON_THE_NOSE: "ON-THE-NOSE" };

// how much of a page is dialogue, by genre (a share of words, in percent) — judged by each scene's job, never by the number alone
export const GENRES = {
  action: { label: "Action / VFX spectacle", min: 25, max: 40 },
  scifi: { label: "Sci-fi / mythological epic", min: 30, max: 45 },
  thriller: { label: "Thriller", min: 40, max: 55 },
  drama: { label: "Drama / family", min: 55, max: 70 },
  comedy: { label: "Comedy / masala", min: 60, max: 75 },
  horror_comedy: { label: "Horror-comedy", min: 50, max: 65 },
};
export const DEFAULT_GENRE = "drama";

export const MUST_HAVE_BEATS = [
  "The hero's introduction line", "The villain's introduction and philosophy line", "A relationship-establishing scene before any loss", "The decision or vow",
  "Rules and stakes, said once", "The confrontation, where the villain gets his best argument", "The interval line", "The mentor's farewell (personal, not instructional)",
  "The apology or reconciliation", "The theme line, said once", "The climax punch, ideally a callback", "The last line of the film", "Callbacks that are planted clearly",
];

export const SCORE_AREAS = ["Voice distinctness", "Emotional impact", "Subtext", "Economy", "Coverage", "Comedy and tonal balance", "Memorable lines", "Language consistency"];
export const VERDICTS = ["Polish", "Dialogue pass", "Rebuild"];

const words = (t) => (String(t ?? "").trim().match(/\S+/g) ?? []).length;
const pick = (v, lang) => (typeof v === "string" ? v : String(v?.[lang] || v?.en || v?.hi || ""));

// ---- reading a scene: the blocks of one scene in a plain shape, {type, character, text}; works for the older scene shape too ----
export function blocksOf(scene) {
  if (Array.isArray(scene?.content)) {
    return scene.content.map((b) => b?.type === "dialogue"
      ? { type: "dialogue", character: String(b.character ?? "").trim().toUpperCase(), text: pick(b.line ?? b.text, "hi") || pick(b.line ?? b.text, "en"), parenthetical: pick(b.parenthetical, "en") }
      : b?.type === "transition" ? { type: "transition", text: String(b.transition ?? "") }
      : { type: "action", text: pick(b?.text, "en") }).filter((b) => b.type === "transition" || b.text.trim());
  }
  const out = [];
  const action = pick(scene?.action, "en");
  if (action.trim()) out.push({ type: "action", text: action });
  for (const d of Array.isArray(scene?.dialogue) ? scene.dialogue : []) out.push({ type: "dialogue", character: String(d.character ?? "").trim().toUpperCase(), text: pick(d.line, "hi") || pick(d.line, "en"), parenthetical: "" });
  return out;
}

const NARRATOR = /narrat|v\.?\s?o\.?$|voice.?over/i;
const AGREE = /^(haan|han|हाँ|हां|theek hai|ठीक है|chalo|चलो|ok|okay|yes|ji|जी|accha|अच्छा|hmm)[.!। ]*$/i;

// the exact numbers of ONE scene
export function sceneStats(scene, number) {
  const blocks = blocksOf(scene);
  const dialogue = blocks.filter((b) => b.type === "dialogue");
  const action = blocks.filter((b) => b.type === "action");
  const dWords = dialogue.reduce((n, b) => n + words(b.text), 0);
  const aWords = action.reduce((n, b) => n + words(b.text), 0);
  const speakers = {};
  for (const d of dialogue) speakers[d.character || "?"] = (speakers[d.character || "?"] ?? 0) + 1;
  // the longest run of lines by the SAME speaker with no one else speaking in between
  let longestSpeech = 0, run = 0, last = null;
  for (const d of dialogue) { run = d.character === last ? run + 1 : 1; last = d.character; longestSpeech = Math.max(longestSpeech, run); }
  // the longest stretch of back-and-forth where every line is 1–3 words ("ping-pong")
  let pingPong = 0, streak = 0;
  for (const d of dialogue) { if (words(d.text) <= 3 || AGREE.test(d.text.trim())) { streak += 1; pingPong = Math.max(pingPong, streak); } else streak = 0; }
  const total = dWords + aWords;
  const pairs = {};
  for (let i = 1; i < dialogue.length; i++) { const a = dialogue[i - 1].character, b = dialogue[i].character; if (a && b && a !== b) { const k = [a, b].sort().join(" ↔ "); pairs[k] = (pairs[k] ?? 0) + 1; } }
  return {
    number, dialogueLines: dialogue.length, actionLines: action.length, dialogueWords: dWords, actionWords: aWords,
    dialoguePct: total ? Math.round((dWords / total) * 100) : 0, speakers, longestSpeech, pingPong,
    narrationLines: dialogue.filter((d) => NARRATOR.test(d.character)).length, silent: dialogue.length === 0, pairs,
  };
}

// hints from the numbers alone (the AI decides the final flag; these are only "look here" marks, each with its reason in plain words)
export function ruleHints(stat, genre = DEFAULT_GENRE) {
  const band = GENRES[genre] ?? GENRES[DEFAULT_GENRE];
  const hints = [];
  if (stat.dialogueLines > 0 && stat.dialoguePct > band.max + 15) hints.push(`the dialogue is ${stat.dialoguePct}% of this scene, well above the ${band.min}–${band.max}% usual for ${band.label}`);
  if (stat.dialogueLines > 0 && stat.dialoguePct < band.min - 25) hints.push(`the dialogue is only ${stat.dialoguePct}% of this scene, well below the ${band.min}–${band.max}% usual for ${band.label}`);
  if (stat.longestSpeech > 8) hints.push(`one speaker talks ${stat.longestSpeech} lines in a row with no interruption`);
  if (stat.pingPong >= 10) hints.push(`${stat.pingPong} very short lines in a row (agreement ping-pong)`);
  if (stat.narrationLines > 0) hints.push(`${stat.narrationLines} narration line${stat.narrationLines === 1 ? "" : "s"} in this scene`);
  return hints;
}

// the whole film's numbers
export function filmStats(scenes) {
  const per = scenes.map((s, i) => sceneStats(s, i + 1));
  const characters = {}, pairs = {};
  for (const s of per) {
    for (const [c, n] of Object.entries(s.speakers)) { const e = (characters[c] ??= { lines: 0, scenes: 0, first: s.number, last: s.number }); e.lines += n; e.scenes += 1; e.last = s.number; }
    for (const [p, n] of Object.entries(s.pairs)) pairs[p] = (pairs[p] ?? 0) + n;
  }
  const dW = per.reduce((n, s) => n + s.dialogueWords, 0), aW = per.reduce((n, s) => n + s.actionWords, 0);
  const narrationLines = per.reduce((n, s) => n + s.narrationLines, 0);
  return {
    scenes: per.length, dialogueWords: dW, actionWords: aW, dialoguePct: dW + aW ? Math.round((dW / (dW + aW)) * 100) : 0,
    silentScenes: per.filter((s) => s.silent).map((s) => s.number), narrationLines, narrationScenes: per.filter((s) => s.narrationLines > 0).map((s) => s.number),
    characters: Object.fromEntries(Object.entries(characters).sort((a, b) => b[1].lines - a[1].lines)),
    pairs: Object.fromEntries(Object.entries(pairs).sort((a, b) => b[1] - a[1])),
    longSpeeches: per.filter((s) => s.longestSpeech > 8).map((s) => ({ scene: s.number, lines: s.longestSpeech })),
    pingPongScenes: per.filter((s) => s.pingPong >= 10).map((s) => s.number),
  };
}

// ---- the AI's part ----
const S = (description) => ({ type: "STRING", description });
const OBJ = (properties, required) => ({ type: "OBJECT", properties, required: required ?? Object.keys(properties) });
const LIST = (items) => ({ type: "ARRAY", items });

export const DOCTOR_SYSTEM = `You are Dialogue Doctor, a script doctor who looks ONLY at dialogue: what characters say, where they should say it, and where they should stay quiet. You judge a scene by its job, never by a number alone. You write for ordinary audiences of Hindi and Indian regional cinema.
Rules you follow:
- Audience effect first, then the fix. Be specific (scene number, the exact line, in its own language). Do not rewrite the film; give small sample lines only.
- Craft notes are objective; taste notes are marked as taste. Never lecture about sensitive material.
SILENCE ZONES (dialogue should be cut): the grief peak; awe and reveal shots; mid-action (short commands only); right after a big hit line; transformation moments; songs and montages; when the image already says it; sacred and ritual moments.
FLAGS (one per scene): KEEP (works — say why, so it is protected); TRIM (too much talk for the scene's job); EXPAND (needs more talk); CUT_TO_SILENCE (should play without words); ADD_DIALOGUE (a must-have beat is missing); ADD_EMOTION (the words are flat at an emotional moment); ADD_LIGHT_COMEDY (a relief or bonding moment is missing); REWRITE_VOICE (the line could belong to anyone); ON_THE_NOSE (a character states their feeling or the theme outright).
EMOTIONAL PEAK TESTS (death, sacrifice, confession, reunion, betrayal): earned (bond shown at least twice before)? specific (a memory, nickname, object)? register drop (no jargon in grief)? subtext? rhythm (short, broken lines)? last words personal, not instruction? contrast (warmth before the tragedy)? silence after the hit line? callback? Rate Lands / Half-lands / Misses.
LIGHT COMEDY goes: after a set-piece survives, in team bonding, fish-out-of-water moments, through character logic, one or two scenes before a tragedy, in training failures, running gags, dry villain wit (sparingly). It NEVER goes: during or right after a death or sexual violence, mid-climax, in sacred moments, anywhere it makes the threat look silly.
LINE PROBLEMS to watch: exposition dumps, repeated lines, dialogue explaining what is on screen, name-calling in every line, agreement ping-pong, the theme said more than once, punch lines in the wrong place, out-of-character slang, inconsistent dialect.
You are given exact counts computed by a program — trust them, never recount. Quote lines exactly in their own language (Hindi stays in Devanagari). Write your notes in simple English.`;

const SCENE_NOTE = OBJ({
  number: { type: "INTEGER", description: "The scene number, exactly as given." },
  flag: { type: "STRING", enum: FLAGS },
  problem: S("One or two plain sentences: what the audience would feel. For KEEP: why it works."),
  fix: S("What to do, as an instruction a writer can follow. For KEEP: say what to protect."),
  peak: OBJ({ is: { type: "BOOLEAN", description: "True only if this scene is a death, sacrifice, confession, reunion or betrayal peak." }, verdict: { type: "STRING", enum: ["Lands", "Half-lands", "Misses", "n/a"] }, reason: S("Which of the nine tests it passes or fails; empty if not a peak.") }),
  comedy: OBJ({ add: { type: "BOOLEAN" }, idea: S("Who, what kind of humour, and a sample line; empty if none.") }),
  bestLine: OBJ({ character: S("Speaker, or empty."), line: S("The best line in this scene quoted exactly, or empty if nothing is worth protecting.") }),
});
export const CHUNK_SCHEMA = OBJ({ scenes: LIST(SCENE_NOTE) });

export const OVERVIEW_SCHEMA = OBJ({
  verdict: { type: "STRING", enum: VERDICTS },
  verdictReason: S("Two sentences."),
  topFixes: LIST(S("One of the three biggest fixes, as an instruction.")),
  mustHave: LIST(OBJ({ beat: S("The beat, from the list given."), status: { type: "STRING", enum: ["Present", "Weak", "Missing"] }, scene: { type: "INTEGER", description: "Scene number where it is (or should be); 0 if none." }, note: S("One sentence.") })),
  scores: LIST(OBJ({ area: S("One of the eight areas."), score: { type: "INTEGER", description: "1 to 10, never inflated." }, reason: S("One line.") })),
  voices: LIST(OBJ({ character: S("A lead character."), voice: S("Vocabulary, register, sentence length, tics — and what they would never say."), distinct: { type: "BOOLEAN", description: "False if they sound like someone else." } })),
  comedyMap: LIST(OBJ({ scene: { type: "INTEGER" }, idea: S("Who, where, what kind of humour, and a sample line.") })),
  pairGaps: LIST(S("An important relationship pair with 0–1 real exchanges before its payoff.")),
});

export function chunkPrompt(scenes, stats, genre, numbers) {
  const band = GENRES[genre] ?? GENRES[DEFAULT_GENRE];
  const text = scenes.map((scene, i) => {
    const st = stats[i]; const hints = ruleHints(st, genre);
    const lines = blocksOf(scene).map((b) => (b.type === "dialogue" ? `   ${b.character}${b.parenthetical ? ` (${b.parenthetical})` : ""}: ${b.text}` : b.type === "transition" ? `   [${b.text}]` : `   ${b.text}`)).join("\n").slice(0, 2600);
    const head = pick(scene?.sceneHeading, "en") || `Scene ${numbers[i]}`;
    return `SCENE ${numbers[i]} — ${head}\n[counts: ${st.dialogueLines} dialogue lines, ${st.actionLines} action lines, dialogue ${st.dialoguePct}% of the words${hints.length ? `; LOOK HERE: ${hints.join("; ")}` : ""}]\n${lines}`;
  }).join("\n\n");
  return `Genre: ${band.label} (dialogue is usually ${band.min}–${band.max}% of a page). Judge each of these ${scenes.length} scenes: give every scene exactly one note, with the scene number exactly as written.\n\n${text}`;
}

export function overviewPrompt(film, notes, genre, gist) {
  const band = GENRES[genre] ?? GENRES[DEFAULT_GENRE];
  const chars = Object.entries(film.characters).slice(0, 12).map(([c, e]) => `${c}: ${e.lines} lines in ${e.scenes} scenes (first scene ${e.first}, last ${e.last})`).join("\n");
  const pairs = Object.entries(film.pairs).slice(0, 15).map(([p, n]) => `${p}: ${n} exchanges`).join("; ");
  const flagged = notes.map((n) => `${n.number}:${n.flag}${n.peak?.is ? `/peak ${n.peak.verdict}` : ""}`).join(" ");
  return `Genre: ${band.label}. The whole film is ${film.scenes} scenes; dialogue is ${film.dialoguePct}% of all words; ${film.narrationLines} narration lines (in scenes ${film.narrationScenes.slice(0, 20).join(", ") || "none"}); ${film.silentScenes.length} scenes have no dialogue at all.
CHARACTERS (exact counts):\n${chars}\nPAIRS (back-to-back exchanges): ${pairs || "none"}\nSCENE FLAGS SO FAR: ${flagged}\nSCENE GISTS (number — heading — first line spoken):\n${gist}\n
Now give the verdict for the whole film's dialogue (Polish = line edits only; Dialogue pass = scene-level rewrites; Rebuild = voices and emotional groundwork need new scenes), the three biggest fixes, the 13 must-have beats (use exactly these names: ${MUST_HAVE_BEATS.join(" | ")}), the eight scores (${SCORE_AREAS.join(", ")}), a voice sheet for each lead character, where light comedy should go (never in tragic stretches), and the relationship pairs that lack real exchanges.`;
}

// the AI's answer -> clean notes (a bad flag is dropped; numbers must belong to this group)
export function normalizeNotes(raw, numbers) {
  const ok = new Set(numbers);
  const out = [];
  for (const n of Array.isArray(raw?.scenes) ? raw.scenes : []) {
    const number = Math.round(Number(n?.number));
    if (!ok.has(number) || !FLAGS.includes(n?.flag) || out.some((o) => o.number === number)) continue;
    const t = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
    out.push({
      number, flag: n.flag, problem: t(n.problem, 400), fix: t(n.fix, 500),
      peak: n.peak?.is ? { is: true, verdict: ["Lands", "Half-lands", "Misses"].includes(n.peak.verdict) ? n.peak.verdict : "n/a", reason: t(n.peak.reason, 400) } : { is: false },
      comedy: n.comedy?.add && t(n.comedy.idea, 300) ? { add: true, idea: t(n.comedy.idea, 300) } : { add: false },
      bestLine: t(n.bestLine?.line, 300) ? { character: t(n.bestLine.character, 60), line: t(n.bestLine.line, 300) } : null,
    });
  }
  return out;
}

export function normalizeOverview(raw) {
  const t = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const score = (v) => Math.min(10, Math.max(1, Math.round(Number(v)) || 1));
  return {
    verdict: VERDICTS.includes(raw?.verdict) ? raw.verdict : null, verdictReason: t(raw?.verdictReason, 500),
    topFixes: (Array.isArray(raw?.topFixes) ? raw.topFixes : []).map((x) => t(x, 400)).filter(Boolean).slice(0, 3),
    mustHave: (Array.isArray(raw?.mustHave) ? raw.mustHave : []).filter((m) => ["Present", "Weak", "Missing"].includes(m?.status)).map((m) => ({ beat: t(m.beat, 120), status: m.status, scene: Math.max(0, Math.round(Number(m.scene)) || 0), note: t(m.note, 300) })).slice(0, 20),
    scores: (Array.isArray(raw?.scores) ? raw.scores : []).filter((s) => SCORE_AREAS.includes(s?.area)).map((s) => ({ area: s.area, score: score(s.score), reason: t(s.reason, 240) })),
    voices: (Array.isArray(raw?.voices) ? raw.voices : []).map((v) => ({ character: t(v.character, 60), voice: t(v.voice, 500), distinct: v.distinct !== false })).filter((v) => v.character).slice(0, 12),
    comedyMap: (Array.isArray(raw?.comedyMap) ? raw.comedyMap : []).map((c) => ({ scene: Math.max(0, Math.round(Number(c.scene)) || 0), idea: t(c.idea, 300) })).filter((c) => c.idea).slice(0, 10),
    pairGaps: (Array.isArray(raw?.pairGaps) ? raw.pairGaps : []).map((p) => t(p, 200)).filter(Boolean).slice(0, 10),
  };
}

// the scenes cut into groups the AI can judge in one call
export function chunksOf(count, size = 8) {
  const out = [];
  for (let from = 1; from <= count; from += size) out.push({ chunk: out.length + 1, from, to: Math.min(count, from + size - 1) });
  return out;
}

// ---- the findings as a list of changes for Script Doctor (so ▶ / ⚡ work on them) ----
const FLAG_KIND = { KEEP: "keep", TRIM: "scene", EXPAND: "scene", CUT_TO_SILENCE: "scene", ADD_DIALOGUE: "scene", ADD_EMOTION: "scene", ADD_LIGHT_COMEDY: "scene", REWRITE_VOICE: "scene", ON_THE_NOSE: "scene" };
export function toReportItems(notes, overview, film) {
  const items = [];
  for (const n of notes) {
    if (n.flag === "KEEP") { if (n.bestLine) items.push({ kind: "keep", title: `Protect the line in scene ${n.number}`, action: `${n.bestLine.character ? `${n.bestLine.character}: ` : ""}${n.bestLine.line} — ${n.problem}`.slice(0, 900), scenes: [n.number], pages: [], severity: "note" }); continue; }
    items.push({ kind: FLAG_KIND[n.flag], title: `Scene ${n.number}: ${FLAG_LABEL[n.flag]}`.slice(0, 120), action: `${n.fix} (${n.problem})`.slice(0, 900), scenes: [n.number], pages: [], severity: n.peak?.verdict === "Misses" ? "major" : "minor" });
  }
  for (const m of overview?.mustHave ?? []) if (m.status !== "Present") items.push({ kind: m.scene ? "scene" : "structure", title: `${m.status} beat: ${m.beat}`.slice(0, 120), action: `${m.note || m.beat}`.slice(0, 900), scenes: m.scene ? [m.scene] : [], pages: [], severity: m.status === "Missing" ? "major" : "minor" });
  if (film?.narrationLines > 3) items.push({ kind: "global", title: "Cut the narration", action: `There are ${film.narrationLines} narration lines. Keep narration to the very few places the film truly needs it, and never to describe what is on screen.`, scenes: [], pages: [], severity: "major" });
  for (const v of overview?.voices ?? []) if (!v.distinct) items.push({ kind: "global", title: `Give ${v.character} their own voice`, action: `${v.character} sounds like someone else. Voice sheet: ${v.voice}`.slice(0, 900), scenes: [], pages: [], severity: "major" });
  return items;
}
