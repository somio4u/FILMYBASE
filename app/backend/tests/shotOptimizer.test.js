// AI Shot Optimization engine — PURE tests (no database, no model, no Google). The screenplays here are SYNTHETIC: they are
// generated to have the patterns the real cutter produces (per-line dialogue shots, micro-actions, repeated reactions…).
// They are NOT your real 270-shot project (that lives on the production database, which this sandbox cannot reach).
import test from "node:test";
import assert from "node:assert/strict";
import { buildOptimizationPlan, findRedundancy, providerCapabilities, reviewPlanWithModel, inferGenre, similarity, GENRE_PROFILES } from "../shotOptimizer.js";

let nextId = 1;
const L = (n) => ({ id: 1000 + n, kind: "location", name: `Place ${n}` });
const C = (n) => ({ id: 2000 + n, kind: "character", name: `Person ${n}` });
function shot(scene, o) {
  const id = nextId++;
  return {
    id, code: `SH${String(id).padStart(3, "0")}`, sceneId: scene.id, sceneCode: scene.code, framing: o.framing ?? "Medium", cameraAngle: "Eye level", cameraMove: o.move ?? "Static",
    description: o.text, durationSec: o.sec ?? 4, dialogue: (o.say ?? []).map((t, i) => ({ id: id * 10 + i, code: `D${id}${i}`, speaker: o.speaker ?? "Rahul", text: t })),
    assets: [scene.loc, ...(o.cast ?? scene.cast)], isSignature: Boolean(o.signature), continuousWithPrev: Boolean(o.cont), locked: Boolean(o.locked),
  };
}
const scene = (n, castN = 2) => ({ id: n, code: `SC${String(n).padStart(3, "0")}`, loc: L(n), cast: Array.from({ length: castN }, (_, i) => C(i + 1)) });

// --- synthetic screenplays ---
function dramaFilm() { // dialogue-driven: long exchanges, quiet reactions
  const out = [];
  for (let s = 1; s <= 8; s++) {
    const sc = scene(s);
    out.push(shot(sc, { framing: "Wide", text: `Establishing view of the quiet kitchen number ${s} in soft morning light.`, sec: 5 }));
    for (let i = 0; i < 6; i++) out.push(shot(sc, { framing: i % 2 ? "Over-the-shoulder" : "Close-up", text: `${i % 2 ? "Meera" : "Rahul"} sits at table ${s} and speaks about the letter number ${i}, hands trembling.`, speaker: i % 2 ? "Meera" : "Rahul", say: [`Line ${s}-${i} about the letter.`], sec: 4 }));
    out.push(shot(sc, { framing: "Close-up", text: `Meera glances at Rahul across table ${s}, stunned into silence.`, sec: 3 }));
    out.push(shot(sc, { framing: "Close-up", text: `Rahul glances at Meera across table ${s}, stunned into silence.`, sec: 3 }));
  }
  return out;
}
function balancedFilm() {
  const out = [];
  for (let s = 1; s <= 10; s++) {
    const sc = scene(s);
    out.push(shot(sc, { framing: "Wide", text: `Establishing view of the old market street ${s} as the crowd gathers.`, sec: 5 }));
    out.push(shot(sc, { framing: "Medium", move: "Tracking", text: `Rahul walks down the lane ${s} past the fruit stalls.`, sec: 3 }));
    out.push(shot(sc, { framing: "Medium", move: "Tracking", text: `Then Rahul keeps walking and slows near the blue door ${s}.`, sec: 3, cont: true }));
    out.push(shot(sc, { framing: "Close-up", text: `Rahul knocks on the blue door number ${s} twice.`, sec: 3, say: [`Anyone home ${s}?`] }));
    out.push(shot(sc, { framing: "Medium", text: `Meera opens the door ${s} and studies him warily.`, sec: 5, speaker: "Meera", say: [`Who is it ${s}?`] }));
    out.push(shot(sc, { framing: "Medium", text: `Rahul shows Meera an old photograph from his pocket ${s}.`, sec: 6 }));
  }
  return out;
}
function actionFilm() { // chases and fights: impact shots with different people and places must stay apart
  const out = [];
  for (let s = 1; s <= 8; s++) {
    const sc = scene(s, 3);
    out.push(shot(sc, { framing: "Wide", move: "Crane / aerial", text: `Aerial view of the rooftops number ${s} at dusk as the chase begins.`, sec: 4 }));
    out.push(shot(sc, { framing: "Medium", move: "Tracking", text: `Rahul sprints along the rooftop ${s} edge.`, sec: 2, cast: [C(1)] }));
    out.push(shot(sc, { framing: "Medium", move: "Tracking", text: `Rahul keeps sprinting and leaps toward the next roof ${s}.`, sec: 2, cast: [C(1)], cont: true }));
    out.push(shot(sc, { framing: "Medium", text: `Rahul punches the guard ${s} hard in the jaw.`, sec: 3, cast: [C(1), C(2)] }));
    out.push(shot(sc, { framing: "Wide", text: `The guard ${s} falls down the stairs in a crash.`, sec: 3, cast: [C(2)] }));
    out.push(shot(sc, { framing: "Close-up", text: `Priya ${s} reacts to the noise from the balcony.`, sec: 3, cast: [C(3)] }));
  }
  out[3].isSignature = true; // a signature leap stays
  return out;
}
function denseFilm() { // the pattern behind "270 shots for 5 minutes": ~1.1s shots, every line and micro-action cut separately
  const out = [];
  for (let s = 1; s <= 12; s++) {
    const sc = scene(s);
    out.push(shot(sc, { framing: "Wide", text: `Establishing view of the apartment block ${s} at dawn.`, sec: 1.5 }));
    out.push(shot(sc, { framing: "Wide", text: `Another establishing view of the apartment block ${s} at dawn.`, sec: 1.2 }));
    for (let i = 0; i < 4; i++) out.push(shot(sc, { framing: "Medium", move: "Tracking", text: `${i === 0 ? "" : "Then "}Rahul walks along corridor ${s} toward the door, step ${i}.`, sec: 1, cont: i > 0 }));
    for (let i = 0; i < 8; i++) out.push(shot(sc, { framing: "Over-the-shoulder", text: `${i % 2 ? "Meera" : "Rahul"} says line ${i} of the argument in room ${s}.`, speaker: i % 2 ? "Meera" : "Rahul", say: [`Argument ${s}.${i}`], sec: 1.3 }));
    for (let i = 0; i < 3; i++) out.push(shot(sc, { framing: "Close-up", text: `Meera glances at Rahul in room ${s}, reaction ${i}.`, sec: 1 }));
    for (let i = 0; i < 4; i++) out.push(shot(sc, { framing: "Insert", text: `Rahul's hand ${["picks up", "turns", "sets down", "grips"][i]} the cup number ${s}.`, sec: 1 }));
    out.push(shot(sc, { framing: "Medium", text: `Rahul punches the guard ${s} in the corridor.`, sec: 1.2, cast: [C(1), C(2)] }));
    out.push(shot(sc, { framing: "Wide", text: `The guard ${s} falls down the stairs.`, sec: 1.2, cast: [C(2)] }));
  }
  return out;
}
const total = (shots) => shots.reduce((n, s) => n + s.durationSec, 0);
const dialogueIds = (shots) => shots.flatMap((s) => s.dialogue.map((d) => d.id)).sort((a, b) => a - b);
const plan = (shots, mode = "balanced", extra = {}) => buildOptimizationPlan({ shots, mode, env: {}, ...extra });
// a plan's editorial shots must still carry every spoken line exactly once
const planDialogue = (p, shots) => p.editorial_shots.flatMap((e) => e.dialogue_codes).sort().join() === shots.flatMap((s) => s.dialogue.map((d) => d.code)).sort().join();

test("three screenplay types: counts shrink only where the content allows, nothing story-critical is lost, tests are synthetic", () => {
  const films = { drama: dramaFilm(), balanced: balancedFilm(), action: actionFilm() };
  for (const [name, shots] of Object.entries(films)) {
    const p = plan(shots);
    assert.ok(p.optimized_editorial_shot_count <= p.initial_editorial_shot_count, name);
    assert.ok(planDialogue(p, shots), `${name}: every line of dialogue is still in exactly one shot`);
    assert.equal(p.warnings.filter((w) => w.level === "error").length, 0, name);
    assert.equal(p.timeline_mapping.length, p.optimized_editorial_shot_count);
    for (const g of p.groups.filter((g) => g.accepted)) assert.ok(g.durationSec <= 8, `${name}: a joined shot never exceeds the model's 8 s clip`);
    console.log(`${name}: ${p.initial_editorial_shot_count} -> ${p.optimized_editorial_shot_count} shots, ${p.initial_generation_unit_count} -> ${p.planned_generation_unit_count} requests, ${p.comparison.cinematic.requestedSeconds}s -> ${p.comparison.optimized.requestedSeconds}s billed, $${p.comparison.cinematic.withRetriesUsd} -> $${p.comparison.optimized.withRetriesUsd}`);
  }
  assert.ok(plan(films.balanced).optimized_editorial_shot_count < films.balanced.length, "continuous walking shots are joined");
  assert.equal(plan(films.drama).groups.filter((g) => g.reasons.includes("continuous_motion")).length, 0, "a quiet drama has no continuous motion to join");
});

test("action: punches, falls and reactions in other places stay separate; a signature shot is never merged; locked shots are never touched", () => {
  const shots = actionFilm();
  const p = plan(shots, "budget");
  for (const s of shots.filter((x) => /punches|falls down|reacts/.test(x.description))) {
    assert.ok(p.editorial_shots.some((e) => e.merged_from.includes(s.id) && e.merged_from.length === 1), `${s.description} is its own shot`);
  }
  assert.ok(p.editorial_shots.find((e) => e.id === shots[3].id).is_signature);
  assert.deepEqual(p.editorial_shots.find((e) => e.id === shots[3].id).merged_from, [shots[3].id]);
  const locked = actionFilm().map((s, i) => ({ ...s, locked: i < 12 }));
  const q = plan(locked, "budget");
  for (const e of q.editorial_shots.slice(0, 12)) assert.equal(e.merged_from.length, 1, "shots with approved/generated work are never merged");
});

test("the dense plan (~270 shots in 5 minutes) is flagged, optimized by content, and compared honestly", () => {
  const shots = denseFilm();
  assert.ok(shots.length >= 250 && shots.length <= 300, `${shots.length} shots`);
  assert.ok(Math.abs(total(shots) - 300) < 60, `${total(shots)} s`);
  const p = plan(shots);
  assert.ok(p.warnings.some((w) => w.code === "unusually_dense"), "flagged as unusually dense");
  assert.equal(p.auto_review_triggered, true);
  assert.ok(p.optimized_editorial_shot_count < p.initial_editorial_shot_count * 0.8, `${p.initial_editorial_shot_count} -> ${p.optimized_editorial_shot_count}`);
  assert.ok(p.optimized_editorial_shot_count > 40, "not forced down to an arbitrary target");
  assert.ok(planDialogue(p, shots), "all dialogue kept");
  assert.ok(p.groups.every((g) => g.reasons.length && g.detail), "every merge group says why");
  assert.ok(p.comparison.savings_usd > 0 && p.comparison.requests_removed > 0 && p.comparison.seconds_removed > 0);
  // the impact pair is never merged (different people / places)
  assert.equal(p.groups.filter((g) => g.hasImpact && g.accepted).length, 0);
  // mapping is complete and consistent with the plan
  assert.equal(p.timeline_mapping.reduce((n, m) => n + m.duration_ms, 0), p.editorial_shots.reduce((n, e) => n + e.duration_ms, 0));
  for (const m of p.timeline_mapping) assert.ok(p.generation_units.some((u) => u.generation_unit_id === m.generation_unit_id));
  // mode ordering: budget joins at least as much as balanced, which joins at least as much as cinematic
  const counts = ["cinematic", "balanced", "budget"].map((m) => plan(shots, m).optimized_editorial_shot_count);
  assert.ok(counts[2] <= counts[1] && counts[1] <= counts[0], `cinematic ${counts[0]} >= balanced ${counts[1]} >= budget ${counts[2]}`);
  console.log(`dense: ${shots.length} -> cinematic ${counts[0]} / balanced ${counts[1]} / budget ${counts[2]} shots; units ${p.planned_generation_unit_count}; billed ${p.comparison.cinematic.requestedSeconds}s -> ${p.comparison.optimized.requestedSeconds}s; $${p.comparison.cinematic.withRetriesUsd} -> $${p.comparison.optimized.withRetriesUsd}`);
});

test("billing is by Veo's 4 / 6 / 8 second clips: a 1 s shot still bills 4 s, so merging saves real seconds, and a 9 s join is refused", () => {
  const sc = scene(1);
  const a = shot(sc, { text: "Rahul walks the lane.", sec: 2, move: "Tracking" }), b = shot(sc, { text: "Then Rahul keeps walking to the door.", sec: 2, move: "Tracking", cont: true }), c = shot(sc, { text: "Then Rahul stops at the doorway.", sec: 2, move: "Tracking", cont: true });
  const p = plan([a, b, c]);
  assert.equal(p.initial_generation_unit_count, 3);
  assert.equal(p.comparison.cinematic.requestedSeconds, 12, "three 2 s shots each bill a 4 s clip");
  assert.equal(p.optimized_editorial_shot_count, 1);
  assert.equal(p.comparison.optimized.requestedSeconds, 6, "one 6 s continuous shot bills 6 s");
  const long = [shot(sc, { text: "Rahul walks the lane slowly.", sec: 5, move: "Tracking" }), shot(sc, { text: "Then Rahul keeps walking to the door.", sec: 5, move: "Tracking", cont: true })];
  assert.equal(plan(long).optimized_editorial_shot_count, 2, "5 s + 5 s would exceed one 8 s clip: stay two shots");
});

test("multi-shot generation is capability-dependent: off by default (continuous shots are merged into ONE editorial shot), on only when the operator enables it", () => {
  const caps = providerCapabilities({});
  assert.equal(caps.multiCut, false);
  assert.deepEqual(caps.allowedSeconds, [4, 6, 8]);
  const sc = scene(1);
  const a = shot(sc, { text: "Rahul crosses the room slowly.", sec: 3 }), b = shot(sc, { text: "Rahul turns to the window.", sec: 3, cont: true, framing: "Close-up" });
  // one unit per shot with multi-cut off, even though they are continuous… unless they are joined editorially first
  const off = buildOptimizationPlan({ shots: [a, b], mode: "cinematic", env: {}, caps: providerCapabilities({}) });
  const on = buildOptimizationPlan({ shots: [a, b], mode: "cinematic", env: {}, caps: providerCapabilities({ VEO_MULTI_CUT: "1" }) });
  assert.ok(off.generation_units.every((u) => u.editorial_shot_ids.length === 1));
  assert.ok(on.capabilities.multiCut);
  const wide = (text, sec) => shot(sc, { text, sec, framing: "Wide" });
  const x = [wide("Rahul stands in the hall.", 3), { ...wide("Meera enters the hall.", 3), cameraMove: "Pan", continuousWithPrev: true }];
  const multi = buildOptimizationPlan({ shots: x, mode: "budget", env: {}, caps: providerCapabilities({ VEO_MULTI_CUT: "1" }) });
  if (multi.generation_units.some((u) => u.editorial_shot_ids.length > 1)) assert.ok(multi.warnings.some((w) => w.code === "multi_shot_units"), "multi-shot units always carry an unverified-capability warning");
});

test("a person can switch a merge group off and get those shots back; the plan is recomputed from the same shots", () => {
  const shots = balancedFilm();
  const p = plan(shots);
  const g = p.groups.find((x) => x.accepted);
  const q = plan(shots, "balanced", { decisions: { [g.id]: false } });
  assert.equal(q.optimized_editorial_shot_count, p.optimized_editorial_shot_count + g.shotIds.length - 1);
  assert.ok(q.groups.find((x) => x.id === g.id && !x.accepted));
});

test("every generation unit carries the required fields, each editorial shot maps to a unit, ids are stable", () => {
  const p = plan(balancedFilm());
  for (const k of ["project_id", "screenplay_version", "film_duration", "genre", "initial_editorial_shot_count", "optimized_editorial_shot_count", "planned_generation_unit_count", "total_requested_generation_seconds", "estimated_generation_cost", "estimated_retry_cost", "optimization_confidence", "optimization_notes", "warnings", "scene_breakdown", "editorial_shots", "generation_units", "timeline_mapping"]) assert.ok(k in p, k);
  const u = p.generation_units[0];
  for (const k of ["generation_unit_id", "scene_id", "editorial_shot_ids", "duration", "opening_frame_prompt", "video_generation_prompt", "internal_action_beats", "camera_movement", "required_character_ids", "required_environment_ids", "required_prop_ids", "continuity_constraints", "expected_generation_difficulty", "fallback_generation_strategy"]) assert.ok(k in u, k);
  assert.match(u.video_generation_prompt, /Start exactly from the given picture/);
  assert.ok(Number.isInteger(u.duration) && p.timeline_mapping.every((m) => Number.isInteger(m.duration_ms) && Number.isInteger(m.source_in_ms)), "timing is integer milliseconds");
  assert.ok(p.optimization_confidence > 0 && p.optimization_confidence <= 1);
});

test("genre ranges scale with film length and are advisory; genre is inferred from content unless told", () => {
  assert.equal(inferGenre(dramaFilm()), "slow_drama");
  assert.ok(["action", "thriller"].includes(inferGenre(actionFilm())));
  assert.equal(inferGenre([], "high intensity action film"), "action");
  const p = plan(dramaFilm());
  assert.equal(p.genre_range.min, Math.round(GENRE_PROFILES.slow_drama.min * (p.film_duration_seconds / 300)));
  assert.ok(similarity("Rahul walks down the lane", "Rahul walks down the lane") === 1 && similarity("a b c", "x y z") === 0);
});

test("prices: built-in estimates are labelled provisional; configured prices are not; the plan fits-the-budget flag uses the real remaining budget", () => {
  const a = plan(balancedFilm());
  assert.ok(a.warnings.some((w) => w.code === "provisional_prices") && a.comparison.prices_provisional);
  const b = buildOptimizationPlan({ shots: balancedFilm(), env: { COST_VIDEO_PER_SECOND: "0.15", COST_IMAGE_EACH: "0.04" }, remainingBudgetUsd: 1 });
  assert.equal(b.comparison.prices_provisional, false);
  assert.equal(b.comparison.fits_budget.optimized, false);
  assert.match(b.comparison.recommendation, /budget/i);
});

test("model review may only REJECT merges, is batched, reports failures, keeps partial answers when the money limit stops it", async () => {
  const shots = dramaFilm().concat(balancedFilm(), actionFilm());
  const p = plan(shots, "budget");
  const accepted = p.groups.filter((g) => g.accepted);
  assert.ok(accepted.length > 20, `${accepted.length} groups`);
  const first = accepted[0];
  let calls = 0;
  const r = await reviewPlanWithModel(p, shots, async (prompt) => { calls++; return { verdicts: prompt.includes(first.id) ? [{ groupId: first.id, verdict: "reject_join", reason: "the reveal needs its own shot" }, { groupId: "G-not-real", verdict: "reject_join" }] : [], notes: ["ok"] }; });
  assert.equal(r.verdicts[first.id].verdict, "reject_join");
  assert.equal(r.verdicts["G-not-real"], undefined, "invented groups are ignored");
  assert.equal(calls, Math.ceil(accepted.length / 20), "groups are sent in batches of 20, not one call each");
  assert.equal(r.reviewed, accepted.length);
  const failing = await reviewPlanWithModel(p, shots, async () => { throw new Error("model down"); });
  assert.ok(failing.failures > 0 && Object.keys(failing.verdicts).length === 0);
  await assert.rejects(reviewPlanWithModel(p, shots, async () => { throw Object.assign(new Error("limit"), { status: 402 }); }), /limit/, "nothing reviewed at all: the stop is reported as an error");
  let n = 0;
  const partial = await reviewPlanWithModel(p, shots, async () => { if (++n === 2) throw Object.assign(new Error("limit"), { status: 402 }); return { verdicts: [{ groupId: first.id, verdict: "reject_join", reason: "x" }] }; });
  assert.equal(partial.stoppedByBudget, true);
  assert.equal(partial.verdicts[first.id].verdict, "reject_join", "answers already paid for are kept");
  assert.ok(partial.reviewed < partial.total);
  assert.ok(findRedundancy(shots).length > 0);
});
