// Shot Optimization: saving, reviewing, approving, restoring plans; generation units; timeline mapping; failure fallback.
// REAL Postgres, MOCK model (scripted answers). No Google, no paid call is ever made here: the tests also prove none starts.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { seedTestProject } from "../production.js";
import { analyzeScreenplay } from "../screenplayAnalysis.js";
import { approveShots, divideScene, listShots, shotDivisionPrompt, shotsFromRules, validateAiShots, estimateSceneSeconds } from "../shots.js";
import { ensureAllProductionSchemas } from "../productionSchema.js";
import { approveBlueprint, planPrompts, reopenBlueprint, validateBlueprint } from "../planning.js";
import { getTimeline } from "../timeline.js";
import { registerShotPlanRoutes, createPlan, adjustPlan, approvePlan, restorePlan, reviewPlan, splitUnit, getPlan } from "../shotPlans.js";
import { activeUnits } from "../generationUnits.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let pid, server, base;
const requireRole = () => (req, res, next) => ((req.user = { id: 1 }), next());
const api = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json };
};
const P = (s = "") => `/api/production/${pid}${s}`;
const spend = async () => ({
  gens: (await db.query("SELECT count(*)::int AS n FROM production_generations WHERE project_id = $1", [pid])).rows[0].n,
  money: Number((await db.query("SELECT COALESCE(sum(cost_usd),0) AS n FROM production_spend WHERE project_id = $1", [pid])).rows[0].n),
});
const dialogueCount = async () => (await db.query("SELECT count(DISTINCT element_id)::int AS n FROM production_shot_dialogue d JOIN production_shots s ON s.id = d.shot_id WHERE s.project_id = $1", [pid])).rows[0].n;

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  assert.deepEqual(await ensureAllProductionSchemas(db), []);
  const app = express();
  app.use(express.json());
  registerShotPlanRoutes(app, db, requireRole, { getTextJson: async () => async (prompt) => ({ verdicts: [], notes: ["looks fine"] }), env: {} });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'");
  pid = (await seedTestProject(db)).projectId;
  await analyzeScreenplay(db, pid);
  const scenes = (await db.query("SELECT id FROM production_scenes WHERE project_id = $1 AND in_latest ORDER BY order_index", [pid])).rows;
  for (const s of scenes) await divideScene(db, pid, s.id, { mode: "script", replace: true });
  for (const s of scenes) await approveShots(db, pid, s.id, { approved: true });
});
test.after(async () => { server.close(); await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'"); await db.end(); });

test("the existing Shot Cutter now asks for justified shots with a per-scene budget, and its fallback cut no longer makes one shot per spoken line", () => {
  const scene = { scene_number: "1", heading: "INT. KITCHEN - DAY", location: "Kitchen", time_of_day: "Day" };
  const els = [{ id: 1, kind: "action", text: "Rahul enters." }, ...[2, 3, 4, 5, 6, 7].map((i) => ({ id: i, kind: "dialogue", code: `D00${i}`, speaker: i % 2 ? "Meera" : "Rahul", text: "Hello there my friend." })), { id: 9, kind: "action", text: "He sits." }];
  const prompt = shotDivisionPrompt(scene, els, []);
  assert.match(prompt, /EVERY SHOT MUST JUSTIFY ITS EXISTENCE/);
  assert.match(prompt, /Do NOT give every spoken line its own shot/);
  assert.match(prompt, /aim for about \d+ shots/);
  assert.ok(estimateSceneSeconds(els) > 10);
  const cut = shotsFromRules(scene, els);
  assert.equal(cut.filter((s) => s.dialogueIds.length).length, 2, "six lines become two exchange shots, not six");
  assert.equal(cut.flatMap((s) => s.dialogueIds).length, 6);
  const ai = validateAiShots({ shots: [{ description: "Rahul stands.", durationSec: 5, purpose: "reveals him", signature: true, continuousWithPrevious: true }] }, els);
  assert.equal(ai[0].signature, true); assert.equal(ai[0].purpose, "reveals him"); assert.equal(ai[0].continuousWithPrevious, true);
});

test("draft plan: nothing changes in the project; no generation, no spend; every dialogue line stays covered; plan versions are kept", async () => {
  const before = await listShots(db, pid);
  const s0 = await spend();
  const plan = await createPlan(db, pid, { mode: "balanced", env: {} });
  assert.equal(plan.status, "draft");
  assert.equal(plan.plan.initial_editorial_shot_count, before.length);
  assert.deepEqual((await listShots(db, pid)).map((s) => s.id), before.map((s) => s.id), "a draft changes nothing");
  assert.deepEqual(await spend(), s0, "no paid work");
  const p2 = await createPlan(db, pid, { mode: "budget", env: {} });
  assert.equal(p2.version, 2);
  assert.equal((await getPlan(db, pid, plan.id)).status, "superseded", "the older draft is kept as history, not deleted");
});

test("approving applies the merges: fewer shots, all dialogue still covered, units stored, prompts planned, still nothing paid; then the Blueprint approves with the timeline built from the optimized plan", async () => {
  const before = await listShots(db, pid);
  const dBefore = await dialogueCount();
  const draft = await createPlan(db, pid, { mode: "budget", env: {} });
  const s0 = await spend();
  const res = await approvePlan(db, pid, draft.id, { env: {} });
  const after = await listShots(db, pid);
  assert.equal(after.length, before.length - res.shots_removed);
  assert.equal(after.length, draft.plan.optimized_editorial_shot_count);
  assert.equal(await dialogueCount(), dBefore, "every spoken line is still inside some shot");
  assert.deepEqual(await spend(), s0, "approval starts no paid work");
  const units = await activeUnits(db, pid);
  assert.equal(units.length, draft.plan.planned_generation_unit_count);
  assert.ok(after.every((s) => s.shotStatus === "approved"));
  const merged = (await db.query("SELECT code, beats, merged_from FROM production_shots WHERE project_id = $1 AND merged_from IS NOT NULL", [pid])).rows;
  assert.equal(merged.length, res.merged_groups);
  for (const m of merged) assert.ok(m.beats.length >= 1 && m.merged_from.length >= 2, "internal beats and the original shot ids are kept");
  // prompts exist for the new shots and the Blueprint approves
  const bp = await approveBlueprint(db, pid);
  assert.ok(bp);
  const tl = await getTimeline(db, pid);
  assert.equal(tl.clips.filter((c) => c.kind === "shot" && !c.orphaned).length, after.length);
  assert.equal((await getPlan(db, pid, draft.id)).status, "approved");
});

test("restore puts the ORIGINAL shots back (same codes, same dialogue); refused once the Blueprint is approved or media exists", async () => {
  const before = await listShots(db, pid);
  const draft = await createPlan(db, pid, { mode: "budget", env: {} });
  assert.ok(draft.plan.groups.some((g) => g.accepted), "the seeded screenplay has something to merge in budget mode");
  await approvePlan(db, pid, draft.id, { env: {} });
  await restorePlan(db, pid, draft.id);
  const back = await listShots(db, pid);
  assert.deepEqual(back.map((s) => s.code), before.map((s) => s.code));
  assert.deepEqual(back.map((s) => s.description), before.map((s) => s.description));
  assert.equal(await dialogueCount(), before.reduce((n, s) => n + s.dialogue.length, 0));
  assert.equal((await getPlan(db, pid, draft.id)).status, "restored");
  // a second approval path: approve, make the Blueprint, then refuse restore
  const d2 = await createPlan(db, pid, { mode: "budget", env: {} });
  await approvePlan(db, pid, d2.id, { env: {} });
  await approveBlueprint(db, pid);
  await assert.rejects(restorePlan(db, pid, d2.id), /Blueprint is approved/);
  await reopenBlueprint(db, pid);
  const lead = (await db.query("SELECT id FROM production_shots WHERE project_id = $1 LIMIT 1", [pid])).rows[0].id;
  await db.query("INSERT INTO production_generations (project_id, kind, shot_id, version, status, review, prompt) VALUES ($1,'keyframe',$2,1,'ready','approved','x')", [pid, lead]);
  await assert.rejects(restorePlan(db, pid, d2.id), /already made/);
});

test("nothing approved is overwritten: a shot with generated work is excluded from every merge, and approval refuses a stale plan or an approved Blueprint", async () => {
  const shots = await listShots(db, pid);
  // put approved work on the first 30 shots
  for (const s of shots.slice(0, 30)) await db.query("INSERT INTO production_generations (project_id, kind, shot_id, version, status, review, prompt) VALUES ($1,'keyframe',$2,1,'ready','approved','x')", [pid, s.id]);
  const draft = await createPlan(db, pid, { mode: "budget", env: {} });
  const lockedIds = new Set(shots.slice(0, 30).map((s) => s.id));
  for (const g of draft.plan.groups) assert.ok(!g.shotIds.some((id) => lockedIds.has(id)), "locked shots are never in a merge group");
  await approvePlan(db, pid, draft.id, { env: {} });
  for (const s of shots.slice(0, 30)) assert.ok((await db.query("SELECT 1 FROM production_shots WHERE id = $1", [s.id])).rowCount === 1, "locked shot still exists");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_generations WHERE project_id = $1", [pid])).rows[0].n, 30, "no generation was deleted or added");
  // stale: edit a shot after drafting
  const d2 = await createPlan(db, pid, { mode: "balanced", env: {} });
  const any = (await listShots(db, pid))[40];
  await db.query("UPDATE production_shots SET description = description || ' changed', revision = revision + 1 WHERE id = $1", [any.id]);
  assert.equal((await getPlan(db, pid, d2.id)).stale, true);
  await assert.rejects(approvePlan(db, pid, d2.id, { env: {} }), /changed after this plan/);
  const d3 = await createPlan(db, pid, { mode: "balanced", env: {} });
  await planPrompts(db, pid);
  await approveBlueprint(db, pid);
  await assert.rejects(approvePlan(db, pid, d3.id, { env: {} }), /Blueprint is already approved/);
});

test("manual review: switching a group off keeps those shots; changing the mode recomputes from the saved shots; AI review can only reject", async () => {
  const draft = await createPlan(db, pid, { mode: "budget", env: {} });
  const g = draft.plan.groups.find((x) => x.accepted);
  const off = await adjustPlan(db, pid, draft.id, { decisions: { [g.id]: false }, env: {} });
  assert.equal(off.plan.optimized_editorial_shot_count, draft.plan.optimized_editorial_shot_count + g.shotIds.length - 1);
  const cin = await adjustPlan(db, pid, draft.id, { mode: "cinematic", env: {} });
  assert.ok(cin.plan.optimized_editorial_shot_count >= draft.plan.optimized_editorial_shot_count);
  const reviewed = await reviewPlan(db, pid, draft.id, async () => ({ verdicts: cin.plan.groups.map((x) => ({ groupId: x.id, verdict: "reject_join", reason: "needs its own shot" })), notes: ["x"] }), { env: {} });
  assert.equal(reviewed.plan.optimized_editorial_shot_count, reviewed.plan.initial_editorial_shot_count, "every merge rejected = no change");
  assert.ok(reviewed.review.rejected.length >= 0);
  await assert.rejects(reviewPlan(db, pid, draft.id, null), /not available/);
  await adjustPlan(db, pid, draft.id, { mode: "budget", env: {} }); // a new mode starts from a clean slate, so merges exist again
  await assert.rejects(reviewPlan(db, pid, draft.id, async () => { throw Object.assign(new Error("over the money limit"), { status: 402 }); }, { env: {} }), /money limit/);
});

test("multi-shot generation units (only when the operator enables multi-cut): one video stored once, clips read different parts of it, a failed combined generation splits without touching anything else", async () => {
  const shots = await listShots(db, pid);
  // make shots 3 and 4 of the same scene a continuous take
  const sceneShots = shots.filter((s) => s.sceneId === shots[0].sceneId);
  const [a, b, c] = sceneShots; // the first two shots of the scene; the third is made different so the pair stands alone
  await db.query("DELETE FROM production_shot_assets WHERE shot_id = $1", [c.id]);
  // same people and place, clearly different pictures, no "continues" wording: not merged as one shot, but a model that can do
  // multi-cut could film them in one clip
  await db.query("UPDATE production_shots SET duration_sec = 3, description = 'Wide view: a ceiling fan turns above the empty table.', framing = 'Wide', camera_move = 'Static' WHERE id = $1", [a.id]);
  await db.query("UPDATE production_shots SET duration_sec = 3, description = 'Close-up: a cold cup of tea rests beside a folded newspaper.', framing = 'Close-up', camera_move = 'Static' WHERE id = $1", [b.id]);
  await db.query("DELETE FROM production_shot_assets WHERE shot_id = ANY($1)", [[a.id, b.id]]);
  const shared = (await db.query("SELECT id FROM production_assets WHERE project_id = $1 AND kind = 'character' LIMIT 1", [pid])).rows[0].id;
  for (const id of [a.id, b.id]) await db.query("INSERT INTO production_shot_assets (shot_id, asset_id) VALUES ($1,$2)", [id, shared]);
  await db.query("DELETE FROM production_shot_dialogue WHERE shot_id = ANY($1)", [[a.id, b.id]]);
  const offPlan = await createPlan(db, pid, { mode: "cinematic", env: {} });
  assert.ok(offPlan.plan.generation_units.every((u) => u.editorial_shot_ids.length === 1), "with multi-cut off (the default) every shot gets its own request");
  const draft = await createPlan(db, pid, { mode: "cinematic", env: { VEO_MULTI_CUT: "1" } });
  const multi = draft.plan.generation_units.find((u) => u.editorial_shot_ids.includes(a.id) && u.editorial_shot_ids.includes(b.id));
  assert.ok(multi, "the two continuous shots share ONE generation unit");
  assert.ok(draft.plan.warnings.some((w) => w.code === "multi_shot_units"), "flagged as an unverified capability");
  const mapped = draft.plan.timeline_mapping.filter((m) => m.generation_unit_id === multi.generation_unit_id);
  assert.deepEqual(mapped.map((m) => m.source_in_ms), [0, 3000], "each clip points into a different part of the same video");
  await approvePlan(db, pid, draft.id, { env: {} });
  await approveBlueprint(db, pid);
  const units = await activeUnits(db, pid);
  const unit = units.find((u) => u.shot_ids.includes(a.id) && u.shot_ids.includes(b.id));
  assert.equal(unit.lead_shot_id, a.id);
  // prompts: only the lead has picture + video prompts; the video prompt covers the whole unit
  const vp = (await db.query("SELECT text, params FROM production_prompts WHERE project_id = $1 AND shot_id = $2 AND purpose = 'video' AND status = 'current'", [pid, a.id])).rows[0];
  assert.equal(vp.params.seconds, 6);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_prompts WHERE project_id = $1 AND shot_id = $2 AND status = 'current'", [pid, b.id])).rows[0].n, 0, "the rider shot has no separate generation prompts");
  // timeline: clips of both shots are placeholders until the unit's video is approved, then BOTH play it with their own in-points
  let tl = await getTimeline(db, pid);
  const ca = tl.clips.find((c) => c.shotId === a.id), cb = tl.clips.find((c) => c.shotId === b.id);
  assert.equal(cb.sourceInMs, 3000);
  assert.equal(cb.state, "planned");
  const gen = (await db.query("INSERT INTO production_generations (project_id, kind, shot_id, version, status, review, prompt, params, duration_ms) VALUES ($1,'video',$2,1,'ready','approved','x','{\"seconds\":6}',6000) RETURNING id", [pid, a.id])).rows[0].id;
  tl = await getTimeline(db, pid);
  const ca2 = tl.clips.find((c) => c.shotId === a.id), cb2 = tl.clips.find((c) => c.shotId === b.id);
  assert.equal(ca2.state, "video"); assert.equal(cb2.state, "video");
  assert.equal(ca2.media.generationId, gen); assert.equal(cb2.media.generationId, gen, "the same stored video is used by both clips");
  assert.equal(cb2.sourceInMs, 3000); assert.equal(cb2.flags.sourceTooShort, false);
  // an approved combined video cannot be split away from under its clips
  await assert.rejects(splitUnit(db, pid, unit.id), /already approved/);
  // a FAILED combined generation can be split, nothing else changes
  await db.query("UPDATE production_generations SET status = 'failed', review = 'pending', media_id = NULL WHERE id = $1", [gen]);
  const others = (await activeUnits(db, pid)).filter((u) => u.id !== unit.id).map((u) => u.code).sort();
  await reopenBlueprint(db, pid);
  const r = await splitUnit(db, pid, unit.id);
  const after = await activeUnits(db, pid);
  assert.equal(after.length, units.length + 1, "one unit became two");
  assert.ok(after.filter((u) => u.shot_ids.includes(a.id) || u.shot_ids.includes(b.id)).every((u) => u.shot_ids.length === 1), "the two shots now have one unit each");
  assert.ok(others.every((c) => after.some((u) => u.code === c)), "unrelated units untouched");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_prompts WHERE project_id = $1 AND shot_id = $2 AND purpose = 'video' AND status = 'current'", [pid, b.id])).rows[0].n, 1, "the second shot now has its own video prompt");
  await assert.rejects(splitUnit(db, pid, after[0].id), /already covers a single shot/);
});

test("routes: list/create/adjust/review/approve over HTTP; units endpoint; signature toggle; errors are plain", async () => {
  const empty = await api("GET", P("/shot-plans"));
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.modes.map((m) => m.key), ["cinematic", "balanced", "budget"]);
  assert.equal(empty.json.capabilities.multiCut, false);
  const made = await api("POST", P("/shot-plans"), { mode: "balanced" });
  assert.equal(made.status, 201);
  const id = made.json.plan.id;
  assert.equal((await api("PATCH", P(`/shot-plans/${id}`), { mode: "nonsense" })).status, 400);
  assert.equal((await api("POST", P(`/shot-plans/${id}/review`))).status, 200);
  const sig = (await listShots(db, pid))[2];
  assert.equal((await api("PUT", P(`/shots/${sig.id}/signature`), { signature: true })).status, 200);
  assert.equal((await db.query("SELECT is_signature FROM production_shots WHERE id = $1", [sig.id])).rows[0].is_signature, true);
  const ok = await api("POST", P(`/shot-plans/${id}/approve`));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await api("POST", P(`/shot-plans/${id}/approve`))).status, 409);
  assert.ok((await api("GET", P("/generation-units"))).json.units.length > 0);
  assert.equal((await api("GET", P("/shot-plans/999999"))).status, 404);
});

test("an existing-style dense project (the seeded 65-shot film split down to ~260 shots in 5 minutes) is flagged, optimized by content, approved, and lands on the timeline", async () => {
  const { splitShot } = await import("../shots.js");
  for (let round = 0; round < 2; round++) for (const s of await listShots(db, pid)) await splitShot(db, pid, s.id);
  const dense = await listShots(db, pid);
  assert.ok(dense.length >= 250, `${dense.length} shots`);
  await db.query("UPDATE production_shots SET duration_sec = $2 WHERE project_id = $1", [pid, Math.round((300 / dense.length) * 100) / 100]);
  const scenes = (await db.query("SELECT id FROM production_scenes WHERE project_id = $1 AND in_latest", [pid])).rows;
  for (const s of scenes) await approveShots(db, pid, s.id, { approved: true });
  const dBefore = await dialogueCount();
  const s0 = await spend();
  const draft = await createPlan(db, pid, { mode: "balanced", env: {} });
  const p = draft.plan;
  assert.equal(p.initial_editorial_shot_count, dense.length);
  assert.ok(p.warnings.some((w) => w.code === "unusually_dense"), "flagged as unusually dense with a justification");
  assert.ok(p.auto_review_triggered);
  assert.ok(p.optimized_editorial_shot_count < p.initial_editorial_shot_count * 0.8, `${p.initial_editorial_shot_count} -> ${p.optimized_editorial_shot_count}`);
  assert.ok(p.comparison.savings_usd > 0 && p.comparison.optimized.requestedSeconds < p.comparison.cinematic.requestedSeconds);
  console.log(`seeded dense project: ${p.initial_editorial_shot_count} -> ${p.optimized_editorial_shot_count} shots; units ${p.initial_generation_unit_count} -> ${p.planned_generation_unit_count}; billed ${p.comparison.cinematic.requestedSeconds}s -> ${p.comparison.optimized.requestedSeconds}s; $${p.comparison.cinematic.withRetriesUsd} -> $${p.comparison.optimized.withRetriesUsd}`);
  await approvePlan(db, pid, draft.id, { env: {} });
  assert.equal((await listShots(db, pid)).length, p.optimized_editorial_shot_count);
  assert.equal(await dialogueCount(), dBefore, "dialogue coverage intact");
  assert.deepEqual(await spend(), s0, "no paid work");
  await approveBlueprint(db, pid);
  const tl = await getTimeline(db, pid);
  const clips = tl.clips.filter((c) => c.kind === "shot" && !c.orphaned);
  assert.equal(clips.length, p.optimized_editorial_shot_count);
  assert.equal(new Set(clips.map((c) => c.shotId)).size, clips.length, "every editorial shot has exactly one timeline placeholder");
});
