// SYNOPSIS MODE. The user writes the whole story (an episode-by-episode synopsis) and wants it kept exactly.
// The Story Brain therefore does NOT design a new story here. It
//   1. splits the user's text into episodes (verbatim),
//   2. READS the synopsis to build the Story Bible around it (characters, facts, setups, climax, per-episode plan),
//   3. RATES it and proposes small changes, each with the exact words it would replace,
//   4. applies only the changes the user ACCEPTS. Anything not accepted never reaches the story.
// Every function takes the model as `ask` so it can be tested with a scripted model.
import {
  STORY_BRAIN_SYSTEM, OBJ, LIST, S, TRUTH_SCHEMA, CLIMAX_SCHEMA, BLUEPRINT_SCHEMA,
  formatUnits, newUsage, usageSummary, brainAsker, runCritics,
} from "./storyBrain.js";

const DIGITS = { "०": "0", "१": "1", "२": "2", "३": "3", "४": "4", "५": "5", "६": "6", "७": "7", "८": "8", "९": "9", "୦": "0", "୧": "1", "୨": "2", "୩": "3", "୪": "4", "୫": "5", "୬": "6", "୭": "7", "୮": "8", "୯": "9" };
const toNumber = (s) => Number(String(s).replace(/[०-९୦-୯]/g, (d) => DIGITS[d] ?? d));

// "Episode 3", "EP-3", "एपिसोड 3", "ଏପିସୋଡ୍ ୩", "Sequence 2", "भाग 4" ... at the start of a line
const HEADING = /^[ \t]*[#*_>\-\s]*(?:episode|ep\.?|sequence|part|एपिसोड|एपिसोड्|एपीसोड|भाग|ଏପିସୋଡ୍|ଏପିସୋଡ|ଭାଗ)\s*[-–—:.#]*\s*([0-9०-९୦-୯]{1,3})(?![0-9०-९୦-୯])[ \t]*[-–—:.)]*[ \t]*([^\n]*)$/gimu;

// Splits the user's text into episodes. Each episode's text is the user's own words, untouched.
export function splitEpisodes(text) {
  const src = String(text ?? "");
  const marks = [...src.matchAll(HEADING)].map((m) => ({ index: m.index, end: m.index + m[0].length, number: toNumber(m[1]), title: (m[2] ?? "").replace(/[*_#]+/g, "").trim() }));
  // keep a clean 1, 2, 3 ... sequence (ignore a stray heading that breaks it)
  const seq = [];
  for (const m of marks) if (m.number === seq.length + 1) seq.push(m);
  if (seq.length < 2) return null;
  return seq.map((m, i) => ({
    number: m.number,
    title: m.title,
    text: src.slice(m.end, i + 1 < seq.length ? seq[i + 1].index : src.length).trim(),
  })).filter((u) => u.text.length > 0);
}

const normalize = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// Used only when the text has no "Episode N" headings: the model cuts the text into episodes, and every piece is checked to be
// the user's own words (a piece that is not found word for word is rejected).
async function splitWithModel(text, expected, ask) {
  const out = await ask(
    "Finding the episodes in your synopsis",
    `Here is the user's full synopsis of a story told in ${expected || "several"} parts (episodes).\n\nCut it into its episodes, in order. For each episode return its title (if there is one) and its text COPIED WORD FOR WORD from the synopsis, with nothing added, removed or reworded.\n\nSYNOPSIS:\n${text}`,
    OBJ({ episodes: LIST(OBJ({ number: { type: "INTEGER" }, title: S("Title, if the user gave one, else empty."), text: S("The episode's text, copied exactly.") })) }),
  );
  const flat = normalize(text);
  const units = (out.episodes ?? []).map((e, i) => ({ number: i + 1, title: e.title ?? "", text: String(e.text ?? "").trim() }))
    .filter((u) => u.text && flat.includes(normalize(u.text).slice(0, Math.min(80, normalize(u.text).length))));
  return units.length >= 2 ? units : null;
}

const UNIT_PROPS = BLUEPRINT_SCHEMA.properties.units.items.properties;
const UNIT_NO_SYNOPSIS = OBJ(Object.fromEntries(Object.entries(UNIT_PROPS).filter(([k]) => k !== "synopsis")));

const READ_SCHEMA = OBJ({
  promise: OBJ({ title: S("Title."), logline: S("Logline."), centralQuestion: S("Central question."), genrePromise: S("Genre promise."), whyWow: S("Why wow.") }),
  hiddenTruth: TRUTH_SCHEMA.properties.hiddenTruth,
  namesInOdia: TRUTH_SCHEMA.properties.namesInOdia,
  characters: TRUTH_SCHEMA.properties.characters,
  villainPlan: TRUTH_SCHEMA.properties.villainPlan,
  facts: TRUTH_SCHEMA.properties.facts,
  climax: CLIMAX_SCHEMA.properties.climax,
  setupsPayoffs: CLIMAX_SCHEMA.properties.setupsPayoffs,
  units: LIST(UNIT_NO_SYNOPSIS),
});

const RATE_SCHEMA = OBJ({
  episodeScores: LIST(OBJ({ unit: { type: "INTEGER", description: "Episode number." }, score: { type: "INTEGER", description: "0-10" }, note: S("One or two sentences: what works and what is weak.") })),
  suggestions: LIST(OBJ({
    unit: { type: "INTEGER", description: "The episode number the change is in." },
    severity: { type: "STRING", enum: ["major", "minor"] },
    why: S("Where it is hard or weak, and why, in plain words."),
    original: S("The EXACT words in the user's synopsis that you would change, copied word for word (a sentence or two at most)."),
    replacement: S("The words you would put there instead. A small change only."),
  }), "At most 12 suggestions, most important first."),
});

export const LOCK_RULES = `This is the user's OWN story. You are reading and checking it, not redesigning it. Never change the order of events, who lives or dies, any twist, any reveal, or how any episode ends. Only small things may change: a name made consistent, a small detail, a small logic slip. Anything you suggest must be small, and must quote the exact words it would replace.`;

// 1-3: build the Story Bible around the user's synopsis and rate it. Returns { bible, usage } like designStoryBible.
export async function designBibleFromSynopsis(synopsis, format, { onProgress = () => {}, ask: askIn = null } = {}) {
  const usage = newUsage();
  const ask = askIn ?? brainAsker(usage, onProgress);
  const text = String(synopsis ?? "").trim();
  if (text.length < 200) throw Object.assign(new Error("The synopsis is too short. Paste the complete synopsis of all the episodes, or turn the switch off to let Adu design the story."), { status: 400 });
  let parts = splitEpisodes(text);
  if (!parts) parts = await splitWithModel(text, formatUnits(format).count, ask);
  if (!parts) throw Object.assign(new Error("I could not find the episodes in your synopsis. Start each one with a heading like “Episode 1”, “एपिसोड 2”, then paste it again."), { status: 400 });
  const units = { ...formatUnits(format), count: parts.length };
  units.label = units.kind === "episode" ? `a web series of ${parts.length} episodes, ${units.minutes} minutes each` : units.label;

  const read = await ask(
    "Reading your synopsis",
    `${LOCK_RULES}\n\nFORMAT: ${units.label}.\n\nTHE USER'S COMPLETE SYNOPSIS (already split into ${parts.length} ${units.kind}s):\n${parts.map((p) => `--- ${units.kind.toUpperCase()} ${p.number}${p.title ? `: ${p.title}` : ""} ---\n${p.text}`).join("\n\n")}\n\nBuild the Story Bible AROUND this story: the title and logline, the hidden truth and timeline, every character, the villain's plan, the facts and world rules, the climax, the setups and payoffs, and for each ${units.kind} a plan (cold open, question, hero's move, villain's move, clue, turn, ending hook, cliffhanger details). EVERYTHING comes from the synopsis. Where it is silent, infer the smallest thing that fits and say so in the field. Return exactly ${parts.length} units, in order.`,
    READ_SCHEMA,
    STORY_BRAIN_SYSTEM,
  );
  const bible = {
    idea: text, format, units, synopsisMode: true, lockedSynopsis: text,
    promise: read.promise, hiddenTruth: read.hiddenTruth, namesInOdia: read.namesInOdia, characters: read.characters,
    villainPlan: read.villainPlan, facts: read.facts, climax: read.climax, setupsPayoffs: read.setupsPayoffs,
    // the story of every episode is the user's own text, word for word
    blueprint: parts.map((p, i) => ({ ...(read.units?.[i] ?? {}), number: p.number, title: p.title || read.units?.[i]?.title || `${units.kind === "episode" ? "Episode" : "Sequence"} ${p.number}`, synopsis: p.text, synopsisOriginal: p.text })),
  };

  // rate it: the three critics read it once (no rewriting), and a rater proposes small, quoted changes
  const check = await runCritics(bible, ask, 1);
  const rated = await ask(
    "Rating your synopsis episode by episode",
    `${LOCK_RULES}\n\nRate each ${units.kind} of the user's synopsis from 0 to 10 for how well it would work on screen, and list what is hard or weak. For each problem propose ONE small change: copy the exact words from the synopsis that you would change, and give the replacement. If something is fine, say nothing about it.\n\n${bible.blueprint.map((u) => `--- ${units.kind.toUpperCase()} ${u.number}: ${u.title} ---\n${u.synopsis}`).join("\n\n")}`,
    RATE_SCHEMA,
    STORY_BRAIN_SYSTEM,
  );
  bible.review = { passed: check.passed, keptVersion: 1, scores: check.scores, reports: check.reports, history: [{ version: 1, scores: check.scores, passed: check.passed }] };
  bible.synopsisReview = { episodeScores: (rated.episodeScores ?? []).map((e) => ({ unit: e.unit, score: e.score, note: e.note })), suggestions: cleanSuggestions(rated.suggestions, bible.blueprint) };
  return { bible, usage: usageSummary(usage) };
}

// keeps only suggestions whose "original" really is in that episode's text, and that do not overlap each other
export function cleanSuggestions(list, blueprint) {
  const out = [];
  const taken = new Map(); // unit -> [[start, end]]
  for (const s of list ?? []) {
    const unit = blueprint.find((u) => u.number === s.unit);
    const original = String(s.original ?? "").trim();
    const replacement = String(s.replacement ?? "").trim();
    if (!unit || !original || !replacement || original === replacement) continue;
    const at = unit.synopsisOriginal.indexOf(original);
    if (at < 0) continue;
    const spans = taken.get(unit.number) ?? [];
    if (spans.some(([a, b]) => at < b && at + original.length > a)) continue;
    taken.set(unit.number, [...spans, [at, at + original.length]]);
    out.push({ id: `s${out.length + 1}`, unit: unit.number, severity: s.severity === "major" ? "major" : "minor", why: String(s.why ?? ""), original, replacement, at, status: "pending" });
    if (out.length >= 12) break;
  }
  return out;
}

// The text of one episode as pieces: unchanged words (kind "same") and changed words (kind "changed" = accepted, "proposed" = waiting
// for the user's answer). The screen draws "same" in black and the rest in red.
export function unitParts(unit, suggestions) {
  const original = unit.synopsisOriginal ?? unit.synopsis ?? "";
  const mine = (suggestions ?? []).filter((s) => s.unit === unit.number && s.status !== "rejected").sort((a, b) => a.at - b.at);
  const parts = [];
  let cursor = 0;
  for (const s of mine) {
    if (s.at < cursor) continue;
    if (s.at > cursor) parts.push({ kind: "same", text: original.slice(cursor, s.at) });
    parts.push({ kind: s.status === "accepted" ? "changed" : "proposed", text: s.replacement, was: s.original, id: s.id });
    cursor = s.at + s.original.length;
  }
  if (cursor < original.length) parts.push({ kind: "same", text: original.slice(cursor) });
  return parts;
}

// What the story uses: the user's words with ONLY the accepted changes applied.
export function currentSynopsis(unit, suggestions) {
  return unitParts(unit, (suggestions ?? []).map((s) => (s.status === "accepted" ? s : { ...s, status: "rejected" }))).map((p) => p.text).join("");
}

// decisions: { s1: "accept", s2: "reject" }, or all: "accept" | "reject". Returns a new bible.
export function applyDecisions(bible, { decisions = {}, all = null } = {}) {
  if (!bible?.synopsisMode) return bible;
  const list = (bible.synopsisReview?.suggestions ?? []).map((s) => {
    const d = all ?? decisions[s.id];
    return d === "accept" ? { ...s, status: "accepted" } : d === "reject" ? { ...s, status: "rejected" } : s;
  });
  return { ...bible, synopsisReview: { ...bible.synopsisReview, suggestions: list }, blueprint: bible.blueprint.map((u) => ({ ...u, synopsis: currentSynopsis(u, list) })) };
}

// On approval: whatever the user did not accept is dropped, so it can never reach the story.
export function finalizeSynopsisBible(bible) {
  if (!bible?.synopsisMode) return bible;
  const list = (bible.synopsisReview?.suggestions ?? []).map((s) => (s.status === "accepted" ? s : { ...s, status: "rejected" }));
  return { ...bible, synopsisReview: { ...bible.synopsisReview, suggestions: list, finalized: true }, blueprint: bible.blueprint.map((u) => ({ ...u, synopsis: currentSynopsis(u, list) })) };
}

// For the screen: every episode with its coloured pieces.
export function decorateSynopsisBible(bible) {
  if (!bible?.synopsisMode) return bible;
  const list = bible.synopsisReview?.suggestions ?? [];
  return { ...bible, blueprint: bible.blueprint.map((u) => ({ ...u, parts: unitParts(u, list) })) };
}

// The instruction every later stage (storylines, pitch deck, characters, beats, scene one-liners, screenplay) and every judge receives.
export function lockedSynopsisIdea(bible) {
  const kind = bible.units?.kind === "sequence" ? "SEQUENCE" : "EPISODE";
  return `LOCKED SYNOPSIS MODE — THE USER WROTE THIS STORY. ${LOCK_RULES}
Follow every ${kind.toLowerCase()}'s synopsis below EXACTLY: the same events in the same order, the same people, the same twists, the same ending of every ${kind.toLowerCase()}. Add only what a stage needs (dialogue, scene detail, small business). If anything you write contradicts the synopsis, that is a BLOCKING problem.

THE USER'S SYNOPSIS, ${kind} BY ${kind} (their own words, with only the changes they accepted):
${(bible.blueprint ?? []).map((u) => `--- ${kind} ${u.number}: ${u.title} ---\n${u.synopsis}`).join("\n\n")}`;
}
