// AI Shot Optimization & Cost Intelligence Engine — a capability INSIDE the existing Shot Cutter (shots.js), not a second cutter.
//
// Three different things (kept apart on purpose):
//   Editorial shot   a view that appears in the finished film (the existing production_shots rows)
//   Generation unit  ONE video request to the model; it covers 1 editorial shot, or several only when the provider can do it
//   Timeline clip    a piece of the timeline that points at approved media with an in / out time
//
// The engine is pure where it can be: buildOptimizationPlan() takes the current shots and returns a full plan (no database,
// no model), so it can be tested on any screenplay. The model (Gemini Pro by quality mode) is only asked afterwards to REVIEW the
// proposed merges and can only reject them, never invent new ones. Nothing here starts a paid image or video request.

import { createHash } from "node:crypto";
import { estimateCost, keyframePrompt, videoPrompt } from "./generations.js";
import { priceTable } from "./pipelineSettings.js";

// ---------------------------------------------------------------------------
// Guidance: how many editorial shots a film of this kind usually needs (per 300 seconds). Advisory, never a hard limit.
// ---------------------------------------------------------------------------
export const GENRE_PROFILES = {
  slow_drama: { label: "Slow drama / atmospheric", min: 30, max: 45 },
  balanced: { label: "Balanced narrative short", min: 45, max: 60 },
  thriller: { label: "Thriller / cinematic action", min: 50, max: 75 },
  action: { label: "High-intensity action", min: 65, max: 90 },
};
export const MODES = {
  cinematic: { label: "Cinematic Priority", blurb: "Storytelling and visual impact first: only obviously continuous or duplicate shots are joined." },
  balanced: { label: "Balanced", blurb: "Balance cinematic quality, feasibility and generation cost (default)." },
  budget: { label: "Budget Priority", blurb: "Cuts avoidable cost harder, still keeping every story beat, line of dialogue and signature moment." },
};
const MODE_RULES = {
  cinematic: { maxMembers: 3, similarity: 0.8, shortSec: 1.5, thin: false, reaction: false, establishing: false },
  balanced: { maxMembers: 3, similarity: 0.6, shortSec: 2.5, thin: true, reaction: true, establishing: true },
  budget: { maxMembers: 4, similarity: 0.45, shortSec: 3, thin: true, reaction: true, establishing: true },
};

// What the provider can actually do. Built from what the project really uses (see providers.js: one video request = one clip of
// 4, 6 or 8 seconds, started from one first-frame picture). Multi-cut video is NOT assumed: nothing in this codebase has ever
// verified it, so it stays off unless the operator sets VEO_MULTI_CUT=1 after testing it.
export function providerCapabilities(env = process.env) {
  const seconds = String(env.VEO_ALLOWED_SECONDS ?? "4,6,8").split(",").map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  return {
    model: env.VIDEO_MODEL || "veo-3.1-fast-generate-preview",
    allowedSeconds: seconds.length ? seconds : [4, 6, 8],
    maxSeconds: Math.max(...(seconds.length ? seconds : [8])),
    continuousCameraMove: true, // a move inside one clip is just a prompt
    multiCut: env.VEO_MULTI_CUT === "1", // several separate camera angles in one clip: unverified, off by default
    maxEditorialPerUnit: 3,
    firstFrameInput: true,
    note: env.VEO_MULTI_CUT === "1" ? "Multi-cut generation was switched on by the operator and is not verified by Filmybase." : "Multi-cut generation is not assumed. Several shots are joined only as ONE continuous shot.",
  };
}
const requestedSeconds = (sec, caps) => caps.allowedSeconds.find((s) => s >= Math.round(Number(sec) || 4)) ?? caps.maxSeconds;

// ---------------------------------------------------------------------------
// Reading a shot
// ---------------------------------------------------------------------------
const STOP = new Set("a an the and or of to in on at with his her their its is are was were he she they it as by for from then while into onto up down out over under again still".split(" "));
const tokens = (text) => new Set(String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
export function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}
const IMPACT = /\b(punch\w*|kick\w*|slam\w*|smash\w*|crash\w*|explo\w+|shoot\w*|shot fired|gun ?fire|stab\w*|slash\w*|strik\w+|struck|hit|hits|hitting|fight\w*|fall|falls|falling|fell|collid\w+|leap\w*|jump\w*|dive|dives|diving|tackl\w+|throw\w*|threw|blast\w*|chas\w+|race|races|racing|rams?|rammed|slic\w+)\b/i;
const CONTINUE_WORDS = /^(then|continues|continuing|keeps|keep|still|as|while|following|follows|now)\b/i;
const MOVES_CONTINUOUS = /(track|follow|push|dolly|pan|tilt|crane|aerial|handheld|steadicam|pull)/i;
const REACTION = /\b(react|reacts|reaction|glance|glances|looks at|looks toward|stares|watches|listens|notices|stunned|stands?\s+watching)\b/i;
const ESTABLISH = /\b(establish|exterior|view of|overview|skyline|aerial|wide view)\b/i;
const isWide = (s) => /wide/i.test(s.framing ?? "");
const hasImpact = (s) => IMPACT.test(s.description ?? "");
const speakersOf = (s) => new Set((s.dialogue ?? []).map((d) => String(d.speaker ?? "").toLowerCase()).filter(Boolean));
const idsOf = (s, kind) => new Set((s.assets ?? []).filter((a) => a.kind === kind).map((a) => a.id));
const jacc = (A, B) => {
  if (A.size === 0 && B.size === 0) return 1;
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  return both / (A.size + B.size - both);
};
const sec = (s) => Number(s.durationSec) || 4;

// Shots that may never be merged away: the Spectacle Director's signature moments, anything with approved work behind it.
export const isProtected = (s) => Boolean(s.isSignature || s.locked);

// ---------------------------------------------------------------------------
// Redundancy: which neighbouring shots could be one?
// ---------------------------------------------------------------------------
// Returns null (keep apart) or { reason, action, detail }.
function linkBetween(a, b, rules, caps) {
  if (a.sceneId !== b.sceneId) return null;
  if (isProtected(a) || isProtected(b)) return null;
  if (sec(a) + sec(b) > caps.maxSeconds) return null;
  const locA = idsOf(a, "location"), locB = idsOf(b, "location");
  if (locA.size && locB.size && jacc(locA, locB) === 0) return null; // the place changes: never one continuous shot
  const charsA = idsOf(a, "character"), charsB = idsOf(b, "character");
  const charOverlap = jacc(charsA, charsB);
  const dialogueLines = (a.dialogue?.length ?? 0) + (b.dialogue?.length ?? 0);
  const speakers = new Set([...speakersOf(a), ...speakersOf(b)]);
  if (dialogueLines > 3 || speakers.size > 2) return null; // keep dialogue coverage readable
  const impact = hasImpact(a) || hasImpact(b);
  const sim = similarity(a.description, b.description);
  const sameFraming = String(a.framing ?? "").toLowerCase() === String(b.framing ?? "").toLowerCase();

  // an impact beat is only ever joined to a near-identical shot (budget mode: same people too)
  if (impact && !(sim >= 0.8 || (rules === MODE_RULES.budget && sim >= 0.6 && charOverlap === 1))) {
    // a continuous tracking move through one fight beat is still one shot
    if (!(MOVES_CONTINUOUS.test(`${a.cameraMove} ${b.cameraMove}`) && charOverlap >= 0.99 && b.continuousWithPrev)) return null;
  }
  if (sameFraming && sim >= rules.similarity && dialogueLines === 0) {
    return sim >= 0.92 ? { reason: "near_duplicate", action: "remove", detail: `The two shots describe almost the same picture (${Math.round(sim * 100)}% alike).` }
      : { reason: "near_duplicate", action: "merge_continuous", detail: `Near-identical views (${Math.round(sim * 100)}% alike): one shot is enough.` };
  }
  if (charOverlap >= 0.5 && (b.continuousWithPrev || CONTINUE_WORDS.test(String(b.description ?? "").trim()) || (MOVES_CONTINUOUS.test(`${a.cameraMove} ${b.cameraMove}`) && sim >= 0.15))) {
    return { reason: "continuous_motion", action: "merge_continuous", detail: "One continuous movement: the camera can simply stay with it." };
  }
  if (rules.establishing && isWide(a) && isWide(b) && ESTABLISH.test(a.description) && ESTABLISH.test(b.description) && sim >= 0.3) {
    return { reason: "repeated_establishing", action: "merge_continuous", detail: "A second establishing view that gives no new information." };
  }
  if (rules.reaction && REACTION.test(a.description) && REACTION.test(b.description) && dialogueLines === 0 && sameFraming) {
    return { reason: "reaction_repeat", action: "merge_continuous", detail: "Two reaction shots in a row: one reaction shot carries both." };
  }
  if ((sec(a) < rules.shortSec || sec(b) < rules.shortSec) && charOverlap >= 0.5 && !impact) {
    return { reason: "short_shot", action: "internal_beats", detail: `A shot under ${rules.shortSec}s is too short to justify its own generation: it becomes a beat inside its neighbour.` };
  }
  return null;
}

// Shot / reverse-shot run of 4+ close dialogue shots: the middle pairs become two-shots.
function reverseRuns(shots) {
  const runs = new Set();
  let run = [];
  const flush = () => { if (run.length >= 4) run.slice(0, run.length - (run.length % 2)).forEach((s, i) => { if (i % 2 === 0) runs.add(`${s.id}`); }); run = []; };
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i], prev = run[run.length - 1];
    const speaker = [...speakersOf(s)][0];
    if (speaker && s.dialogue.length === 1 && !isProtected(s) && (!prev || (prev.sceneId === s.sceneId && [...speakersOf(prev)][0] !== speaker))) run.push(s);
    else { flush(); if (speaker && s.dialogue.length === 1 && !isProtected(s)) run = [s]; }
  }
  flush();
  return runs; // ids of shots that start a pair to join with the following shot
}

export function findRedundancy(shots, mode = "balanced", caps = providerCapabilities()) {
  const rules = MODE_RULES[mode] ?? MODE_RULES.balanced;
  const pairStarts = rules.thin ? reverseRuns(shots) : new Set();
  const groups = [];
  let i = 0;
  while (i < shots.length) {
    const members = [shots[i]];
    const links = [];
    let total = sec(shots[i]);
    while (i + members.length < shots.length && members.length < Math.min(rules.maxMembers, caps.maxEditorialPerUnit + 1)) {
      const a = members[members.length - 1], b = shots[i + members.length];
      let link = linkBetween(a, b, rules, caps);
      if (!link && pairStarts.has(`${a.id}`) && members.length === 1 && a.sceneId === b.sceneId && sec(a) + sec(b) <= caps.maxSeconds && !isProtected(b)) {
        link = { reason: "shot_reverse", action: "internal_beats", detail: "A long shot / reverse-shot exchange: this pair can be one two-shot with both lines." };
      }
      if (!link || total + sec(b) > caps.maxSeconds) break;
      members.push(b); links.push(link); total += sec(b);
    }
    if (members.length > 1) {
      const reasons = [...new Set(links.map((l) => l.reason))];
      const removes = links.every((l) => l.action === "remove");
      groups.push({
        id: `G-${members[0].id}`, shotIds: members.map((m) => m.id), codes: members.map((m) => m.code), sceneId: members[0].sceneId,
        reasons, action: removes ? "remove" : links.some((l) => l.action === "internal_beats") && !links.some((l) => l.action === "merge_continuous") ? "internal_beats" : "merge_continuous",
        detail: links.map((l) => l.detail).join(" "), durationSec: total,
        hasDialogue: members.some((m) => m.dialogue?.length), hasImpact: members.some(hasImpact),
        risk: members.some(hasImpact) ? "medium" : members.some((m) => m.dialogue?.length) ? "low" : "low",
      });
    }
    i += members.length;
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------
const joinText = (parts, max = 1200) => parts.map((p) => String(p ?? "").trim().replace(/[.\s]+$/, "")).filter(Boolean).join(". Then ").slice(0, max) + ".";
function mergeGroup(group, byId) {
  const members = group.shotIds.map((id) => byId.get(id));
  const lead = members[0];
  const moves = members.map((m) => m.cameraMove).filter((m) => m && m !== "Static");
  const keepFirst = group.action === "remove"; // a duplicate adds nothing: the first one stays as it is
  const beats = members.map((m) => m.description);
  const durationSec = keepFirst ? sec(lead) : Math.min(8, members.reduce((n, m) => n + sec(m), 0));
  return {
    ...lead,
    description: keepFirst ? lead.description : joinText(beats),
    durationSec,
    cameraMove: moves[0] ?? lead.cameraMove,
    dialogue: keepFirst ? lead.dialogue : members.flatMap((m) => m.dialogue ?? []),
    assets: [...new Map(members.flatMap((m) => m.assets ?? []).map((a) => [a.id, a])).values()],
    beats, mergedFrom: members.map((m) => m.id), mergedCodes: members.map((m) => m.code), mergeReason: group.reasons.join(", "), groupId: group.id,
    isSignature: members.some((m) => m.isSignature),
  };
}

// ---------------------------------------------------------------------------
// Difficulty, cost and risk
// ---------------------------------------------------------------------------
const RETRY_RATE = { easy: 0.1, medium: 0.25, hard: 0.45 }; // PROVISIONAL assumptions, not measured: shown as such in the plan
export function unitDifficulty(unit, shots) {
  const text = shots.map((s) => s.description).join(" ");
  let points = 0;
  const chars = new Set(shots.flatMap((s) => (s.assets ?? []).filter((a) => a.kind === "character").map((a) => a.id)));
  if (chars.size >= 3) points += 1;
  if (chars.size >= 5) points += 1;
  if (IMPACT.test(text)) points += 1;
  if (/\b(crowd|army|mob|explosion|fire|flood|storm|swarm|dozens|hundreds)\b/i.test(text)) points += 1;
  if (shots.length > 1) points += 2;
  if (unit.requestedSeconds >= 8) points += 1;
  if (shots.some((s) => /whip|spin|orbit|360|rapid/i.test(`${s.cameraMove} ${s.description}`))) points += 1;
  return points >= 4 ? "hard" : points >= 2 ? "medium" : "easy";
}

function planUnits(editorial, caps, mode) {
  // One unit per editorial shot — unless the provider can really deliver several in one clip AND they are a continuous take.
  const units = [];
  let i = 0;
  const canJoin = (a, b) => a.sceneId === b.sceneId && !isProtected(a) && !isProtected(b) && (caps.multiCut || b.continuousWithPrev) && jacc(idsOf(a, "character"), idsOf(b, "character")) >= 0.5 && !(hasImpact(a) && hasImpact(b));
  while (i < editorial.length) {
    const members = [editorial[i]];
    let total = sec(editorial[i]);
    if (MODE_RULES[mode].maxMembers > 1) {
      while (i + members.length < editorial.length && members.length < caps.maxEditorialPerUnit && canJoin(members[members.length - 1], editorial[i + members.length]) && total + sec(editorial[i + members.length]) <= caps.maxSeconds) {
        total += sec(editorial[i + members.length]);
        members.push(editorial[i + members.length]);
      }
    }
    units.push({ members, totalSec: total });
    i += members.length;
  }
  return units;
}

function costOf(units, prices, caps) {
  let video = 0, image = 0, retry = 0, seconds = 0;
  for (const u of units) {
    const secs = u.requestedSeconds ?? requestedSeconds(u.totalSec, caps);
    const v = estimateCost("video", { seconds: secs }, prices);
    const f = estimateCost("image", {}, prices);
    video += v; image += f; seconds += secs;
    retry += (v + f) * (RETRY_RATE[u.difficulty] ?? 0.25);
  }
  const r = (n) => Math.round(n * 100) / 100;
  return { videoUsd: r(video), imageUsd: r(image), retryUsd: r(retry), totalUsd: r(video + image), withRetriesUsd: r(video + image + retry), requestedSeconds: seconds };
}

const pricesAreEstimates = (env = process.env) => !(env.COST_VIDEO_PER_SECOND && env.COST_IMAGE_EACH);

// ---------------------------------------------------------------------------
// Genre
// ---------------------------------------------------------------------------
export function inferGenre(shots, hint = null) {
  const h = String(hint ?? "").toLowerCase();
  if (/action|fight|martial|war/.test(h)) return "action";
  if (/thriller|crime|horror|suspense|mystery|spectacle/.test(h)) return "thriller";
  if (/drama|slice|romance|family|literary|atmospher/.test(h)) return "slow_drama";
  if (shots.length === 0) return "balanced";
  const act = shots.filter(hasImpact).length / shots.length;
  const talk = shots.filter((s) => s.dialogue?.length).length / shots.length;
  if (act > 0.25) return "action";
  if (act > 0.12) return "thriller";
  if (talk > 0.6 && act < 0.05) return "slow_drama";
  return "balanced";
}

export const baselineHash = (shots) => createHash("sha256").update(JSON.stringify(shots.map((s) => [s.id, s.description, s.durationSec, s.framing, s.cameraMove, (s.dialogue ?? []).map((d) => d.id), s.revision ?? 0]))).digest("hex").slice(0, 16);

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------
// shots: [{ id, code, sceneId, sceneCode, framing, cameraAngle, cameraMove, description, durationSec, dialogue[], assets[], isSignature?, continuousWithPrev?, locked? }]
// decisions: { [groupId]: false } — groups the person (or the review) switched off. Everything else is on.
export function buildOptimizationPlan({ shots, mode = "balanced", genre = null, genreHint = null, decisions = {}, caps = providerCapabilities(), prices = priceTable(), style = "", projectId = null, screenplayVersion = null, aspectRatio = "16:9", remainingBudgetUsd = null, env = process.env }) {
  if (!MODES[mode]) throw Object.assign(new Error(`Unknown mode "${mode}".`), { status: 400 });
  const filmSeconds = shots.reduce((n, s) => n + sec(s), 0);
  const genreKey = GENRE_PROFILES[genre] ? genre : inferGenre(shots, genreHint);
  const profile = GENRE_PROFILES[genreKey];
  const scale = filmSeconds / 300;
  const range = { min: Math.round(profile.min * scale), max: Math.round(profile.max * scale) };
  const byId = new Map(shots.map((s) => [s.id, s]));

  const groups = findRedundancy(shots, mode, caps).map((g) => ({ ...g, accepted: decisions[g.id] !== false }));
  const accepted = new Map(groups.filter((g) => g.accepted).map((g) => [g.shotIds[0], g]));
  const skip = new Set(groups.filter((g) => g.accepted).flatMap((g) => g.shotIds.slice(1)));
  const editorial = [];
  for (const s of shots) {
    if (skip.has(s.id)) continue;
    editorial.push(accepted.has(s.id) ? mergeGroup(accepted.get(s.id), byId) : { ...s, beats: [s.description], mergedFrom: [s.id], mergedCodes: [s.code] });
  }

  // generation units: cinematic plan (one per original shot) and optimized plan
  const attach = (u, name) => {
    const requested = requestedSeconds(u.totalSec, caps);
    const difficulty = unitDifficulty({ requestedSeconds: requested }, u.members);
    return { ...u, requestedSeconds: requested, difficulty, name };
  };
  const cinematicUnits = shots.map((s) => attach({ members: [s], totalSec: sec(s) }, "cinematic"));
  const optUnits = planUnits(editorial, caps, mode).map((u) => attach(u, "optimized"));
  const cinematicCost = costOf(cinematicUnits, prices, caps);
  const optCost = costOf(optUnits, prices, caps);

  // ---- structured output ----
  let clock = 0;
  const unitRows = [];
  const mapping = [];
  const editorialRows = [];
  optUnits.forEach((u, idx) => {
    const code = `GU${String(idx + 1).padStart(3, "0")}`;
    const lead = u.members[0];
    const pseudo = { ...lead, description: u.members.length > 1 ? joinText(u.members.map((m) => m.description)) : lead.description, durationSec: u.totalSec, storyboardText: "", assets: lead.assets ?? [], cameraMove: lead.cameraMove };
    const chars = [...new Set(u.members.flatMap((m) => (m.assets ?? []).filter((a) => a.kind === "character").map((a) => a.id)))];
    const envs = [...new Set(u.members.flatMap((m) => (m.assets ?? []).filter((a) => a.kind === "location").map((a) => a.id)))];
    const props = [...new Set(u.members.flatMap((m) => (m.assets ?? []).filter((a) => a.kind === "prop").map((a) => a.id)))];
    const beats = u.members.flatMap((m) => m.beats ?? [m.description]);
    const names = (lead.assets ?? []).filter((a) => ["character", "location", "prop"].includes(a.kind)).slice(0, 4).map((a) => a.name);
    const moves = [...new Set(u.members.map((m) => m.cameraMove).filter((m) => m && m !== "Static"))];
    const unitMs = Math.round(u.totalSec * 1000);
    unitRows.push({
      generation_unit_id: code, scene_id: lead.sceneId, scene_code: lead.sceneCode, editorial_shot_ids: u.members.map((m) => m.id), editorial_shot_codes: u.members.map((m) => m.code),
      duration: unitMs, requested_seconds: u.requestedSeconds,
      opening_frame_prompt: keyframePrompt(pseudo, style, names), video_generation_prompt: `${videoPrompt(pseudo, style)} Target length: about ${u.requestedSeconds} seconds.`,
      internal_action_beats: beats, camera_movement: moves.join(" → ") || "steady", required_character_ids: chars, required_environment_ids: envs, required_prop_ids: props,
      continuity_constraints: [chars.length ? "Characters must keep the same faces and clothes as their approved model sheets." : null, envs.length ? "The place must match its approved model sheet." : null, u.members.length > 1 ? "One unbroken take: no cuts, same place, same people." : null, lead.continuousWithPrev ? "Continues straight from the previous shot." : null].filter(Boolean),
      expected_generation_difficulty: u.difficulty,
      fallback_generation_strategy: u.members.length > 1 ? "split_into_single_shot_units" : (beats.length > 1 ? "split_beats_into_separate_shots" : "shorter_duration_or_simpler_camera"),
      estimated_cost_usd: Math.round((estimateCost("video", { seconds: u.requestedSeconds }, prices) + estimateCost("image", {}, prices)) * 100) / 100,
    });
    let offset = 0;
    for (const m of u.members) {
      const ms = Math.round(sec(m) * 1000);
      mapping.push({ editorial_shot_id: `${m.sceneCode}_${m.code}`, shot_db_id: m.id, generation_unit_id: code, source_in_ms: offset, duration_ms: ms, timeline_start_ms: clock });
      editorialRows.push({ id: m.id, code: m.code, scene_id: m.sceneId, scene_code: m.sceneCode, editorial_shot_id: `${m.sceneCode}_${m.code}`, description: m.description, framing: m.framing, camera_move: m.cameraMove, duration_ms: ms, merged_from: m.mergedFrom, merged_codes: m.mergedCodes, merge_reason: m.mergeReason ?? null, internal_beats: m.beats ?? [], is_signature: Boolean(m.isSignature), generation_unit_id: code, dialogue_codes: (m.dialogue ?? []).map((d) => d.code) });
      offset += ms; clock += ms;
    }
  });

  // ---- quality validation (Step 7), deterministic ----
  const warnings = [];
  const origDialogue = new Set(shots.flatMap((s) => (s.dialogue ?? []).map((d) => d.id)));
  const keptDialogue = new Set(editorial.flatMap((s) => (s.dialogue ?? []).map((d) => d.id)));
  const lostDialogue = [...origDialogue].filter((id) => !keptDialogue.has(id));
  if (lostDialogue.length) warnings.push({ code: "dialogue_lost", level: "error", message: `${lostDialogue.length} spoken line(s) would no longer be inside any shot.` });
  const sig = shots.filter((s) => s.isSignature).length;
  if (editorial.filter((s) => s.isSignature).length < sig) warnings.push({ code: "signature_lost", level: "error", message: "A signature cinematic moment would be merged away." });
  if (editorial.length > range.max * 1.25) warnings.push({ code: "still_dense", level: "warning", message: `Even after optimization the plan has ${editorial.length} shots; a ${profile.label.toLowerCase()} film of ${Math.round(filmSeconds)}s usually needs ${range.min}–${range.max}. Check whether every shot justifies itself.` });
  if (editorial.length < range.min * 0.6 && shots.length >= range.min) warnings.push({ code: "possibly_too_sparse", level: "warning", message: `${editorial.length} shots is well under the usual ${range.min}–${range.max}: check that no story beat was lost.` });
  const hardUnits = optUnits.filter((u) => u.difficulty === "hard").length;
  if (hardUnits) warnings.push({ code: "hard_units", level: "info", message: `${hardUnits} generation unit(s) are expected to be hard for the model (crowds, impacts, many characters). Expect retries there.` });
  const multi = optUnits.filter((u) => u.members.length > 1).length;
  if (multi) warnings.push({ code: "multi_shot_units", level: "warning", message: `${multi} generation unit(s) cover several shots in one clip. ${caps.multiCut ? "Multi-cut generation is switched on but has not been verified against the real model." : "These are continuous takes: the editor cuts inside one clip."}` });
  const densityFlag = shots.length > range.max * 1.25;
  const autoReview = densityFlag;
  if (densityFlag) warnings.push({ code: "unusually_dense", level: "warning", message: `The original plan has ${shots.length} shots for ${Math.round(filmSeconds)} seconds (usually ${range.min}–${range.max}): this is unusually dense and was sent for an automatic optimization review.` });
  if (pricesAreEstimates(env)) warnings.push({ code: "provisional_prices", level: "info", message: "Prices are Filmybase's built-in estimates (not read from your Google bill), so every cost here is provisional." });
  warnings.push({ code: "retry_rates_assumed", level: "info", message: "Retry costs use assumed retry rates (10% easy, 25% medium, 45% hard); they are not measured." });

  const mergedAway = shots.length - editorial.length;
  const savingsUsd = Math.round((cinematicCost.withRetriesUsd - optCost.withRetriesUsd) * 100) / 100;
  const savingsPct = cinematicCost.withRetriesUsd ? Math.round((savingsUsd / cinematicCost.withRetriesUsd) * 100) : 0;
  const risky = groups.filter((g) => g.accepted && (g.hasImpact || g.shotIds.length > 2)).length;
  const errors = warnings.filter((w) => w.level === "error").length;
  const confidence = Math.max(0.3, Math.min(0.95, 0.9 - risky * 0.01 - hardUnits * 0.01 - errors * 0.3 - (pricesAreEstimates(env) ? 0.05 : 0)));
  const fits = (c) => remainingBudgetUsd === null || c.withRetriesUsd <= remainingBudgetUsd;
  let recommended = "optimized";
  let why = `The optimized plan removes ${mergedAway} shot(s) and ${cinematicUnits.length - optUnits.length} generation request(s) and keeps every line of dialogue and signature moment.`;
  if (errors) { recommended = "cinematic"; why = "The optimized plan loses story material (see the errors), so the original plan is recommended."; }
  else if (mergedAway === 0) { recommended = "cinematic"; why = "Nothing in this screenplay could be safely merged: every shot has its own job."; }
  else if (mode === "cinematic" && savingsPct < 8 && fits(cinematicCost)) { recommended = "cinematic"; why = "Savings are small and the original plan fits the budget, so storytelling comes first."; }
  else if (!fits(optCost)) why += " It still does not fit the remaining budget: raise the limit or choose Budget Priority.";

  const sceneIds = [...new Set(shots.map((s) => s.sceneId))];
  return {
    project_id: projectId, screenplay_version: screenplayVersion, mode, mode_label: MODES[mode].label,
    film_duration: Math.round(filmSeconds * 1000), film_duration_seconds: Math.round(filmSeconds), genre: genreKey, genre_label: profile.label, genre_range: range,
    initial_editorial_shot_count: shots.length, optimized_editorial_shot_count: editorial.length,
    planned_generation_unit_count: optUnits.length, initial_generation_unit_count: cinematicUnits.length,
    total_requested_generation_seconds: optCost.requestedSeconds, initial_requested_generation_seconds: cinematicCost.requestedSeconds,
    estimated_generation_cost: optCost.totalUsd, estimated_retry_cost: optCost.retryUsd, optimization_confidence: Math.round(confidence * 100) / 100,
    optimization_notes: [why, `${groups.filter((g) => g.accepted).length} merge group(s) applied, ${groups.filter((g) => !g.accepted).length} switched off.`, `Average shot length ${(filmSeconds / Math.max(1, editorial.length)).toFixed(1)}s after, ${(filmSeconds / Math.max(1, shots.length)).toFixed(1)}s before.`],
    warnings,
    comparison: {
      cinematic: { editorial_shots: shots.length, generation_units: cinematicUnits.length, ...cinematicCost },
      optimized: { editorial_shots: editorial.length, generation_units: optUnits.length, ...optCost },
      savings_usd: savingsUsd, savings_percent: savingsPct, shots_removed: mergedAway, requests_removed: cinematicUnits.length - optUnits.length, seconds_removed: cinematicCost.requestedSeconds - optCost.requestedSeconds,
      recommended, recommendation: why, prices_provisional: pricesAreEstimates(env), remaining_budget_usd: remainingBudgetUsd,
      fits_budget: { cinematic: fits(cinematicCost), optimized: fits(optCost) },
    },
    auto_review_triggered: autoReview, mode_options: Object.entries(MODES).map(([key, v]) => ({ key, ...v })),
    capabilities: caps, groups,
    scene_breakdown: sceneIds.map((id) => {
      const before = shots.filter((s) => s.sceneId === id), after = editorialRows.filter((s) => s.scene_id === id);
      return { scene_id: id, scene_code: before[0]?.sceneCode, initial_shots: before.length, optimized_shots: after.length, initial_seconds: before.reduce((n, s) => n + sec(s), 0), generation_units: unitRows.filter((u) => u.scene_id === id).length };
    }),
    editorial_shots: editorialRows, generation_units: unitRows, timeline_mapping: mapping,
    stale_hash: baselineHash(shots),
  };
}

// ---------------------------------------------------------------------------
// Model review (Pro by quality mode): may only REJECT proposed merges, never add shots or merges.
// ---------------------------------------------------------------------------
const REVIEW_BATCH = 20; // merge groups per model call: fewer calls, lower cost

export function reviewPrompt(groups, shotsById, sceneCodeOf) {
  const lines = groups.map((g) => `GROUP ${g.id} (scene ${sceneCodeOf(g.sceneId)}; ${g.action}; ${g.reasons.join(", ")}):\n${g.shotIds.map((id, i) => `  ${i + 1}. [${shotsById.get(id).framing ?? "?"}${shotsById.get(id).cameraMove ? `, ${shotsById.get(id).cameraMove}` : ""}, ${shotsById.get(id).durationSec}s] ${shotsById.get(id).description}${(shotsById.get(id).dialogue ?? []).length ? `  (dialogue: ${shotsById.get(id).dialogue.map((d) => `${d.speaker}: ${d.text}`).join(" / ")})` : ""}`).join("\n")}`);
  return `You are the editor checking a cost-saving proposal on a film's shot list. A rule engine wants to join neighbouring shots into one continuous AI-generated shot. Reject a join ONLY if it would damage story clarity, emotional impact, action choreography, geography, a dramatic reveal or a memorable moment. Cheap is not a reason to approve; a join that keeps everything important is fine. Judge each group on its own.

Return JSON only: {"verdicts":[{"groupId":"","verdict":"keep_join"|"reject_join","reason":"one short sentence"}],"notes":["optional short notes"]}

${lines.join("\n\n")}`;
}

// Returns { verdicts, notes, failures, reviewed, total, stoppedByBudget }. A money-limit stop (402) keeps everything already answered.
export async function reviewPlanWithModel(plan, shots, textJson) {
  const byId = new Map(shots.map((s) => [s.id, s]));
  const sceneCodeOf = (id) => plan.scene_breakdown.find((s) => s.scene_id === id)?.scene_code ?? id;
  const groups = plan.groups.filter((g) => g.accepted);
  const verdicts = {};
  const notes = [];
  let failures = 0, reviewed = 0, stoppedByBudget = false;
  for (let i = 0; i < groups.length; i += REVIEW_BATCH) {
    const batch = groups.slice(i, i + REVIEW_BATCH);
    try {
      const raw = await textJson(reviewPrompt(batch, byId, sceneCodeOf));
      for (const v of Array.isArray(raw?.verdicts) ? raw.verdicts : []) {
        if (batch.some((g) => g.id === v.groupId) && ["keep_join", "reject_join"].includes(v.verdict)) verdicts[v.groupId] = { verdict: v.verdict, reason: String(v.reason ?? "").slice(0, 300) };
      }
      for (const n of Array.isArray(raw?.notes) ? raw.notes : []) if (typeof n === "string") notes.push(n.slice(0, 300));
      reviewed += batch.length;
    } catch (error) {
      if (error.status === 402) {
        if (reviewed === 0 && failures === 0) throw error; // nothing was reviewed at all: say so plainly
        stoppedByBudget = true;
        break;
      }
      failures += batch.length;
    }
  }
  return { verdicts, notes, failures, reviewed, total: groups.length, stoppedByBudget };
}
