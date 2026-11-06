// Screenplay Doctor — reviews the WHOLE film: structure, characters, world, market. Built from the owner's "Screenplay Doctor" skill. It pairs with Dialogue Doctor
// (which looks only at what characters say). Same split of work: COUNTING and POSITIONS are done by code (where each major beat falls as a share of the running
// time, who appears first and last, who is on screen how much); JUDGING is done by the AI, scene group by scene group, then once for the whole film.
// The app has no page numbers, so a "page %" is a share of the film's running time (each scene's estimated minutes), and every note cites SCENE numbers.

import { blocksOf, sceneStats } from "./dialogueDoctor.js";

export const MARKETS = {
  indian_commercial: { label: "Indian commercial (Bollywood / regional mass)", interval: [47, 58] },
  indian_drama: { label: "Indian drama / social / small film", interval: [45, 60] },
  hollywood: { label: "Hollywood / international", interval: null },
};
export const DEFAULT_MARKET = "indian_commercial";

// where each major beat is expected, as a share of the running time (from the owner's skill: Hollywood — committed to the journey by 15–30%, midpoint 50–60%,
// all-is-lost 70–85%; Indian commercial — a real interval block at about 47–58%, a villain should be on screen well before the 50% mark)
export const BEAT_RANGES = {
  hollywood: { hook: [0, 5], incitingIncident: [8, 15], lockIn: [15, 30], midpoint: [50, 60], lowPoint: [70, 85], climax: [88, 98] },
  indian_commercial: { hook: [0, 5], incitingIncident: [8, 20], lockIn: [20, 35], midpoint: [47, 58], lowPoint: [70, 85], climax: [88, 98] },
  indian_drama: { hook: [0, 6], incitingIncident: [8, 22], lockIn: [20, 38], midpoint: [45, 60], lowPoint: [70, 88], climax: [88, 98] },
};
export const BEAT_NAMES = { hook: "The hook", incitingIncident: "The inciting incident", lockIn: "Locked into the journey", midpoint: "Midpoint / interval", lowPoint: "The low point (all is lost)", climax: "The climax" };

export const LENSES = [
  "Premise and hook", "Structure and pacing", "Protagonist and arc", "Antagonist", "Supporting cast", "Setups and payoffs", "World-building and rules",
  "Action and set-pieces", "Dialogue (overview)", "Scene craft and action lines", "Theme, emotion and tone", "Indian commercial checklist", "Logic and plausibility", "Market and production",
];
export const VERDICTS = ["Shoot-ready", "Polish", "Revise", "Rewrite", "Rethink"];

const minutesOf = (scene) => { const m = Number(scene?.estimatedMinutes); return Number.isFinite(m) && m > 0 ? m : 1; };
const heading = (scene) => String(scene?.sceneHeading?.en || scene?.sceneHeading?.hi || "").slice(0, 80);

// ---- code: where every scene sits in the running time, who is in it ----
export function timeline(scenes) {
  const total = scenes.reduce((n, s) => n + minutesOf(s), 0) || 1;
  let before = 0;
  return scenes.map((s, i) => {
    const start = (before / total) * 100;
    before += minutesOf(s);
    const st = sceneStats(s, i + 1);
    const present = Object.keys(st.speakers);
    return { number: i + 1, heading: heading(s), minutes: minutesOf(s), startPct: Math.round(start * 10) / 10, endPct: Math.round(((before / total) * 100) * 10) / 10, speakers: present, dialoguePct: st.dialoguePct };
  });
}

export function characterLedger(scenes) {
  const ledger = {};
  scenes.forEach((s, i) => {
    for (const b of blocksOf(s)) {
      if (b.type !== "dialogue" || !b.character) continue;
      const e = (ledger[b.character] ??= { first: i + 1, last: i + 1, scenes: new Set(), lines: 0 });
      e.last = i + 1; e.scenes.add(i + 1); e.lines += 1;
    }
  });
  return Object.fromEntries(Object.entries(ledger).map(([c, e]) => [c, { first: e.first, last: e.last, scenes: e.scenes.size, lines: e.lines }]).sort((a, b) => b[1].lines - a[1].lines));
}

// the AI names the scene of each major beat; code turns it into a share of the running time and says whether it falls inside the usual range
export function beatPositions(beatScenes, tl, market = DEFAULT_MARKET) {
  const ranges = BEAT_RANGES[market] ?? BEAT_RANGES[DEFAULT_MARKET];
  const out = [];
  for (const key of Object.keys(BEAT_NAMES)) {
    const n = Math.round(Number(beatScenes?.[key]));
    const at = tl.find((t) => t.number === n);
    if (!at) { out.push({ key, name: BEAT_NAMES[key], scene: 0, pct: null, range: ranges[key], verdict: "not found" }); continue; }
    const pct = Math.round(at.startPct);
    const [lo, hi] = ranges[key];
    out.push({ key, name: BEAT_NAMES[key], scene: n, pct, range: [lo, hi], verdict: pct < lo ? "early" : pct > hi ? "late" : "on target" });
  }
  return out;
}

// the first scene each lead character SPEAKS in, as a share of the running time (a villain who first appears after 50% is a risk)
export function lateEntrances(ledger, tl, limit = 50) {
  return Object.entries(ledger).filter(([, e]) => e.lines >= 4).map(([c, e]) => ({ character: c, scene: e.first, pct: Math.round(tl[e.first - 1]?.startPct ?? 0) })).filter((x) => x.pct > limit);
}

// ---- the AI's part ----
const S = (description) => ({ type: "STRING", description });
const OBJ = (properties, required) => ({ type: "OBJECT", properties, required: required ?? Object.keys(properties) });
const LIST = (items) => ({ type: "ARRAY", items });

export const DOCTOR_SYSTEM = `You are Screenplay Doctor, a professional script doctor who reviews a screenplay the way an experienced one would. You work for Hollywood, Hindi and Indian regional film. You answer four questions honestly: Does the script work? What is strong and must be protected? What is broken, and why? What should the next draft be: polish, revise, rewrite or rethink? You judge the script against what it is trying to be (its genre, market and audience), not your own taste.
How you give notes: be specific (cite scene numbers, never "the second act drags"); say the audience effect (confusion, boredom, lost sympathy) BEFORE the fix; keep craft notes (objective), taste notes (yours) and market notes (audience fit) separate; protect the writer's voice — move the film toward THEIR film; do not rewrite the script, short sample lines only; be honest and kind; give sensitive material (religion, caste, violence) craft and risk notes, never lectures. Never inflate scores: 9–10 professional, could shoot; 7–8 strong, needs polish; 5–6 working with clear problems; 3–4 major issues; 1–2 missing or broken.
Indian commercial films: the interval must land near 47–58% and be a real interval block (a twist, a vow or a shock); the second half needs its own structure (a new goal, new pressure from the villain, a pre-climax twist, the climax); hero-elevation moments at the introduction, the interval and the climax; songs must do story work; the comedy track should be woven into the plot; a social message woven in, not a lecture.
Craft points you check: setups and payoffs (every plant pays off, every payoff was planted); rules taught by demonstration through a newcomer, every rule later an obstacle or a tool, the climax resolved only with rules established earlier; the antagonist is present throughout, escalating, and gets the best argument; the protagonist causes the climax and their change costs something; scenes where nothing changes are flagged; action scenes need a goal, an obstacle, a clock, a reversal and a changed state.
Quote script lines exactly in their own language. Write notes in simple English.`;

const SCENE_ROW = OBJ({
  number: { type: "INTEGER", description: "The scene number, exactly as given." },
  purpose: S("One short line: what this scene is for in the story."),
  changes: { type: "BOOLEAN", description: "False if nothing changes in this scene (no new information, decision, relationship or power shift)." },
  plants: LIST(S("Something planted here that must pay off later (an object, line, rule, skill, relationship).")),
  payoffs: LIST(S("Something here that pays off an earlier plant; say what it pays off.")),
  rules: LIST(S("A rule of the story's world taught, used or broken here, with which of the three.")),
  heroic: { type: "BOOLEAN", description: "True if this is a hero-elevation or mass moment." },
});
export const CHUNK_SCHEMA = OBJ({ scenes: LIST(SCENE_ROW) });

const ISSUE = OBJ({
  severity: { type: "STRING", enum: ["Critical", "Major", "Minor"] },
  lens: S("One of the fourteen lenses."),
  problem: S("The problem, in one or two sentences, with the audience effect first."),
  scenes: LIST({ type: "INTEGER" }),
  fixes: LIST(S("One fix, as an instruction a writer can follow.")),
});
export const OVERVIEW_SCHEMA = OBJ({
  verdict: { type: "STRING", enum: VERDICTS }, verdictReason: S("Two sentences."), biggestFix: S("The single biggest fix."),
  logline: S("The logline as you read it, in one sentence."), assumptions: S("What you assumed about market, genre and draft stage."),
  beats: OBJ({ hook: { type: "INTEGER" }, incitingIncident: { type: "INTEGER" }, lockIn: { type: "INTEGER" }, midpoint: { type: "INTEGER" }, lowPoint: { type: "INTEGER" }, climax: { type: "INTEGER" } }),
  merits: LIST(S("Something strong that must be protected in the next draft.")),
  issues: LIST(ISSUE),
  scores: LIST(OBJ({ lens: S("One of the fourteen lenses."), score: { type: "INTEGER" }, reason: S("One line.") })),
  orphans: LIST(S("A plant that never pays off, or a payoff that was never planted, with the scene numbers.")),
  commercial: LIST(OBJ({ item: S("A point of the Indian commercial checklist."), status: { type: "STRING", enum: ["Strong", "Weak", "Missing", "n/a"] }, note: S("One sentence.") })),
  risks: LIST(S("A sensitivity, certification or production risk (religion, caste, real figures, violence, VFX, crowds, locations).")),
  revisionPlan: LIST(S("One step of the revision plan, biggest lever first, saying what to fix now and what can wait.")),
});

export function chunkPrompt(scenes, numbers, market) {
  const m = MARKETS[market] ?? MARKETS[DEFAULT_MARKET];
  const text = scenes.map((scene, i) => {
    const lines = blocksOf(scene).map((b) => (b.type === "dialogue" ? `${b.character}: ${b.text}` : b.type === "transition" ? `[${b.text}]` : b.text)).join("\n").slice(0, 2200);
    return `SCENE ${numbers[i]} — ${heading(scene)}\n${lines}`;
  }).join("\n\n");
  return `Market: ${m.label}. Read these ${scenes.length} scenes and give exactly one row per scene, scene number exactly as written.\n\n${text}`;
}

const pct = (n) => (n === null || n === undefined ? "?" : `${n}%`);
export function overviewPrompt({ market, synopsis, characters, tl, rows, ledger, late, film }) {
  const m = MARKETS[market] ?? MARKETS[DEFAULT_MARKET];
  const map = rows.map((r) => { const t = tl[r.number - 1]; return `${r.number} (${pct(Math.round(t?.startPct ?? 0))}) ${t?.heading ?? ""} — ${r.purpose}${r.changes === false ? " [NOTHING CHANGES]" : ""}${r.heroic ? " [heroic]" : ""}`; }).join("\n").slice(0, 16000);
  const plants = rows.flatMap((r) => (r.plants ?? []).map((p) => `${r.number}: ${p}`)).join("\n").slice(0, 5000);
  const payoffs = rows.flatMap((r) => (r.payoffs ?? []).map((p) => `${r.number}: ${p}`)).join("\n").slice(0, 5000);
  const rules = rows.flatMap((r) => (r.rules ?? []).map((p) => `${r.number}: ${p}`)).join("\n").slice(0, 4000);
  const chars = Object.entries(ledger).slice(0, 14).map(([c, e]) => `${c}: first speaks in scene ${e.first} (${pct(Math.round(tl[e.first - 1]?.startPct ?? 0))}), last in ${e.last}, ${e.lines} lines in ${e.scenes} scenes`).join("\n");
  return `Market: ${m.label}${m.interval ? ` (the interval should land at ${m.interval[0]}–${m.interval[1]}% of the running time)` : ""}. The film is ${film.scenes} scenes, about ${film.minutes} minutes. Percentages are shares of the running time.
SYNOPSIS: ${String(synopsis ?? "").slice(0, 3000)}
CHARACTERS (from the story file): ${String(characters ?? "").slice(0, 3000)}
CHARACTER LEDGER (exact):\n${chars}${late.length ? `\nLATE ENTRANCES (first speak after the 50% mark): ${late.map((l) => `${l.character} at ${l.pct}%`).join(", ")}` : ""}
SCENE MAP (number (start %) heading — purpose):\n${map}
PLANTS:\n${plants || "(none found)"}\nPAYOFFS:\n${payoffs || "(none found)"}\nRULES:\n${rules || "(none found)"}

Review the whole film through the fourteen lenses (${LENSES.join("; ")}). Name the scene of each major beat (0 if there is none). Give the verdict (Shoot-ready, Polish, Revise, Rewrite or Rethink), the single biggest fix, the logline as you read it, your assumptions, the merits to protect, the problems by severity (Critical, Major, Minor — each with the scenes and one to three fixes), a 1–10 score for every lens, the orphan plants and payoffs, the Indian commercial checklist (hero elevation at introduction/interval/climax; songs; comedy track; family and emotion; social message; regional texture), the sensitivity and production risks, and an ordered revision plan.`;
}

// ---- cleaning the AI's answers ----
const t = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
export function normalizeRows(raw, numbers) {
  const ok = new Set(numbers); const out = [];
  for (const r of Array.isArray(raw?.scenes) ? raw.scenes : []) {
    const number = Math.round(Number(r?.number));
    if (!ok.has(number) || out.some((o) => o.number === number)) continue;
    const list = (v) => (Array.isArray(v) ? v : []).map((x) => t(x, 200)).filter(Boolean).slice(0, 6);
    out.push({ number, purpose: t(r.purpose, 200), changes: r.changes !== false, plants: list(r.plants), payoffs: list(r.payoffs), rules: list(r.rules), heroic: Boolean(r.heroic) });
  }
  return out;
}
export function normalizeOverview(raw, sceneCount) {
  const ints = (v) => [...new Set((Array.isArray(v) ? v : []).map((n) => Math.round(Number(n))).filter((n) => n >= 1 && n <= sceneCount))].slice(0, 30);
  const score = (v) => Math.min(10, Math.max(1, Math.round(Number(v)) || 1));
  const list = (v, max, n = 12) => (Array.isArray(v) ? v : []).map((x) => t(x, max)).filter(Boolean).slice(0, n);
  return {
    verdict: VERDICTS.includes(raw?.verdict) ? raw.verdict : null, verdictReason: t(raw?.verdictReason, 500), biggestFix: t(raw?.biggestFix, 500), logline: t(raw?.logline, 400), assumptions: t(raw?.assumptions, 500),
    beats: Object.fromEntries(Object.keys(BEAT_NAMES).map((k) => [k, ints([raw?.beats?.[k]])[0] ?? 0])),
    merits: list(raw?.merits, 300),
    issues: (Array.isArray(raw?.issues) ? raw.issues : []).filter((i) => ["Critical", "Major", "Minor"].includes(i?.severity) && t(i.problem, 10)).map((i) => ({ severity: i.severity, lens: t(i.lens, 60), problem: t(i.problem, 500), scenes: ints(i.scenes), fixes: list(i.fixes, 400, 3) })).slice(0, 40),
    scores: (Array.isArray(raw?.scores) ? raw.scores : []).filter((s) => LENSES.includes(s?.lens)).map((s) => ({ lens: s.lens, score: score(s.score), reason: t(s.reason, 240) })),
    orphans: list(raw?.orphans, 300), commercial: (Array.isArray(raw?.commercial) ? raw.commercial : []).filter((c) => ["Strong", "Weak", "Missing", "n/a"].includes(c?.status)).map((c) => ({ item: t(c.item, 120), status: c.status, note: t(c.note, 300) })).slice(0, 12),
    risks: list(raw?.risks, 300), revisionPlan: list(raw?.revisionPlan, 400, 10),
  };
}
export const overallScore = (scores) => (scores.length ? Math.round((scores.reduce((n, s) => n + s.score, 0) / scores.length) * 10) / 10 : null);

export function chunksOf(count, size = 10) {
  const out = [];
  for (let from = 1; from <= count; from += size) out.push({ chunk: out.length + 1, from, to: Math.min(count, from + size - 1) });
  return out;
}

// ---- the findings as a list of changes for Script Doctor (so ▶ / ⚡ work on them) ----
export function toReportItems(overview, positions, late) {
  const items = [];
  for (const i of overview.issues) {
    const severity = i.severity === "Critical" ? "critical" : i.severity === "Major" ? "major" : "minor";
    const structural = /structure|pacing|premise|antagonist|protagonist|arc|setups|world|theme|market|logic/i.test(i.lens) || i.scenes.length === 0 || i.scenes.length > 6;
    items.push({ kind: structural ? "structure" : "scene", title: `${i.lens}: ${i.problem}`.slice(0, 120), action: `${i.problem} Fix: ${i.fixes.join(" Or: ")}`.slice(0, 900), scenes: i.scenes, pages: [], severity });
  }
  for (const p of positions.filter((x) => x.verdict === "early" || x.verdict === "late")) items.push({ kind: "structure", title: `${p.name} falls ${p.verdict} (${p.pct}%)`, action: `${p.name} (scene ${p.scene}) sits at ${p.pct}% of the running time; the usual range is ${p.range[0]}–${p.range[1]}%. Move it ${p.verdict === "late" ? "earlier" : "later"} or rebalance the acts around it.`, scenes: [p.scene], pages: [], severity: p.key === "midpoint" ? "major" : "minor" });
  for (const l of late) items.push({ kind: "structure", title: `${l.character} arrives late (${l.pct}%)`, action: `${l.character} first speaks in scene ${l.scene}, ${l.pct}% into the film. A villain or major character who appears after the halfway mark is a risk: plant them earlier.`, scenes: [l.scene], pages: [], severity: "major" });
  for (const o of overview.orphans) items.push({ kind: "structure", title: `Orphan plant or payoff`, action: o, scenes: [], pages: [], severity: "minor" });
  for (const r of overview.risks) items.push({ kind: "risk", title: "Sensitivity / production risk", action: r, scenes: [], pages: [], severity: "note" });
  for (const m of overview.merits) items.push({ kind: "keep", title: "Protect this", action: m, scenes: [], pages: [], severity: "note" });
  return items;
}
