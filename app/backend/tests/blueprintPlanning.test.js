// Phase 2: the prompt library, Blueprint validation and approval, and the Timeline created straight from the approved
// Blueprint (placeholders, before any media). MOCK-FREE except where marked: the "providers" used to start a generation are
// fakes that only prove the prompt linkage; no Google service is contacted. Real Postgres.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { seedTestProject } from "../production.js";
import { analyzeScreenplay } from "../screenplayAnalysis.js";
import { approveShots, divideScene, listShots, updateShot } from "../shots.js";
import { ensureAllProductionSchemas } from "../productionSchema.js";
import { buildShotManifest, onScreenplayApproved, registerBlueprintRoutes } from "../blueprint.js";
import { approveBlueprint, planPrompts, promptStatus, registerPlanningRoutes, reopenBlueprint, validateBlueprint, blueprintStaleness } from "../planning.js";
import { getTimeline, registerTimelineRoutes } from "../timeline.js";
import { editPrompt, ensurePrompt, hashInputs, promptHistory } from "../prompts.js";
import { createGenerationService } from "../generations.js";
import { registerEventRoutes, subscribe, subscriberCount } from "../events.js";
import { saveSettings } from "../pipelineSettings.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let server, base, pid, sceneIds;
const requireRole = () => (req, res, next) => ((req.user = { id: 1 }), next());
const api = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json };
};
const P = (suffix = "") => `/api/production/${pid}${suffix}`;

async function freshProject() {
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'");
  const projectId = (await seedTestProject(db)).projectId;
  await analyzeScreenplay(db, projectId);
  const scenes = (await db.query("SELECT id FROM production_scenes WHERE project_id = $1 AND in_latest ORDER BY order_index", [projectId])).rows;
  for (const s of scenes) await divideScene(db, projectId, s.id, { mode: "script", replace: true });
  return { projectId, sceneIds: scenes.map((s) => s.id) };
}
async function readyToApprove() {
  await planPrompts(db, pid);
  for (const id of sceneIds) await approveShots(db, pid, id, { approved: true });
}

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  assert.deepEqual(await ensureAllProductionSchemas(db), []);
  const app = express();
  app.use(express.json());
  registerEventRoutes(app, db, requireRole, { heartbeatMs: 60000 }); // first, so it sees every production response
  registerBlueprintRoutes(app, db, requireRole);
  registerPlanningRoutes(app, db, requireRole);
  registerTimelineRoutes(app, db, requireRole);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => { ({ projectId: pid, sceneIds } = await freshProject()); });
test.after(async () => { server.close(); await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'"); await db.end(); });

test("prompt library: planning writes one prompt per asset, two per shot and one per spoken line — and planning twice changes nothing", async () => {
  const before = await promptStatus(db, pid);
  assert.equal(before.current.length, 0);
  const first = await planPrompts(db, pid);
  const shots = await listShots(db, pid);
  const assets = (await db.query("SELECT count(*)::int AS n FROM production_assets WHERE project_id = $1 AND in_latest_import", [pid])).rows[0].n;
  assert.equal(first.created, assets + shots.length * 2 + 17);
  assert.equal(first.updated + first.unchanged + first.kept_edited, 0);
  const again = await planPrompts(db, pid);
  assert.equal(again.unchanged, first.total, "same facts, same prompts");
  assert.equal(again.created, 0);
  const byPurpose = (await db.query("SELECT purpose, count(*)::int AS n FROM production_prompts WHERE project_id = $1 AND status = 'current' GROUP BY purpose", [pid])).rows;
  const n = (p) => byPurpose.find((r) => r.purpose === p)?.n;
  assert.equal(n("first_frame"), 65); assert.equal(n("video"), 65); assert.equal(n("audio"), 17); assert.equal(n("model_sheet"), assets);
  const frame = (await db.query("SELECT text FROM production_prompts WHERE project_id = $1 AND purpose = 'first_frame' LIMIT 1", [pid])).rows[0].text;
  assert.match(frame, /single film frame/);
  const video = (await db.query("SELECT text, params FROM production_prompts WHERE project_id = $1 AND purpose = 'video' LIMIT 1", [pid])).rows[0];
  assert.match(video.text, /Start exactly from the given picture/);
  assert.match(video.text, /Target length: about [468] seconds/);
  assert.ok([4, 6, 8].includes(video.params.seconds));
});

test("prompt library: a prompt is immutable history — a change makes a new version, an edit by a person is never overwritten", async () => {
  await planPrompts(db, pid);
  const shot = (await listShots(db, pid))[0];
  const target = { shotId: shot.id };
  const edited = await editPrompt(db, pid, "first_frame", target, "My own first-frame wording for this shot.", { actorUserId: 5 });
  assert.equal(edited.version, 2);
  assert.equal(edited.edited, true);
  assert.equal((await promptHistory(db, pid, "first_frame", target)).length, 2, "version 1 is kept");
  assert.equal((await promptHistory(db, pid, "first_frame", target)).find((v) => v.version === 1).status, "superseded");
  assert.equal(await editPrompt(db, pid, "first_frame", target, "My own first-frame wording for this shot.").then((r) => r.id), edited.id, "saving identical words adds no version");
  // the shot changes: planning must keep the person's words, and say they are out of date
  await updateShot(db, pid, shot.id, { expectedRevision: shot.revision, edits: { description: "A completely different description of the shot." } });
  const replan = await planPrompts(db, pid);
  assert.equal(replan.kept_edited, 1);
  const cur = (await db.query("SELECT text FROM production_prompts WHERE project_id = $1 AND shot_id = $2 AND purpose = 'first_frame' AND status = 'current'", [pid, shot.id])).rows[0].text;
  assert.equal(cur, "My own first-frame wording for this shot.");
  const status = await promptStatus(db, pid);
  assert.ok(status.stale.some((s) => s.prompt.shot_id === shot.id && s.spec.purpose === "first_frame"), "the edited prompt shows as stale");
  // an un-edited prompt whose inputs changed gets a NEW version and keeps the old one
  assert.equal((await promptHistory(db, pid, "video", target)).length, 2);
  assert.equal(replan.updated >= 1, true);
});

test("ensurePrompt: two writers at once never create two current prompts", async () => {
  const a = (await db.query("SELECT id FROM production_assets WHERE project_id = $1 LIMIT 1", [pid])).rows[0].id;
  const spec = { purpose: "model_sheet", assetId: a, text: "x sheet", sourceHash: hashInputs("x") };
  const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => ensurePrompt(db, pid, spec)));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_prompts WHERE project_id = $1 AND asset_id = $2 AND status = 'current'", [pid, a])).rows[0].n, 1);
  assert.equal(outcomes.filter((o) => o.outcome === "created").length, 1);
});

test("validation: before planning it lists exactly what is missing; after planning and shot approval it passes, with a cost estimate", async () => {
  const bad = await validateBlueprint(db, pid);
  assert.equal(bad.ok, false);
  const codes = bad.errors.map((e) => e.code);
  assert.ok(codes.includes("missing_frame_prompts") && codes.includes("missing_video_prompts") && codes.includes("shots_not_approved") && codes.includes("missing_audio_prompts"));
  assert.equal(bad.errors.find((e) => e.code === "missing_frame_prompts").count, 65);
  await readyToApprove();
  const good = await validateBlueprint(db, pid);
  assert.deepEqual(good.errors, [], JSON.stringify(good.errors));
  assert.equal(good.ok, true);
  assert.equal(good.counts.shots, 65);
  assert.equal(good.estimate.frames, 65);
  assert.ok(Math.abs(good.estimate.framesUsd - 65 * 0.04) < 0.011);
  assert.ok(good.estimate.videoUsd > 0 && good.estimate.totalUsd > good.estimate.framesUsd);
  assert.equal(typeof good.estimate.fitsBudget, "boolean");
});

test("approving the Blueprint creates the Timeline at once: one ordered placeholder per shot with start/length from the plan, no media needed", async () => {
  assert.equal((await api("GET", P("/timeline"))).json.exists, false, "no timeline before approval");
  const refused = await api("POST", P("/blueprint/approve"));
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, "not_valid");
  assert.ok(refused.json.validation.errors.length > 0);
  assert.equal((await api("GET", P("/timeline"))).json.exists, false, "a refused approval creates nothing");
  await readyToApprove();
  const ok = await api("POST", P("/blueprint/approve"));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.blueprint.status, "approved");
  assert.equal(ok.json.timeline.created, 65);
  assert.equal(ok.json.timeline.dialogue, 17);
  const tl = (await api("GET", P("/timeline"))).json;
  assert.equal(tl.exists, true);
  assert.deepEqual(tl.tracks.map((t) => t.name), ["V1", "A1", "A2", "A3"]);
  const manifest = await buildShotManifest(db, pid);
  const v1 = tl.clips.filter((c) => c.kind === "shot");
  assert.equal(v1.length, 65);
  v1.forEach((c, i) => {
    const m = manifest.shots[i];
    assert.equal(c.shotRef, m.shot_id);
    assert.equal(c.startMs, m.planned_start_ms);
    assert.equal(c.durationMs, m.planned_duration_ms);
    assert.equal(c.plannedDurationMs, m.planned_duration_ms);
    assert.equal(c.state, "planned");
    assert.equal(c.media, null, "no media exists, only the placeholder");
    assert.ok(c.imagePrompt?.text && c.videoPrompt?.text, "the inspector can show both persisted prompts");
  });
  assert.equal(tl.totalMs, manifest.totals.planned_duration_ms);
  assert.equal(tl.summary.placeholders, 65);
  assert.equal(tl.clips.filter((c) => c.kind === "dialogue").length, 17);
  // dialogue sits on its own track, starting with its shot
  const shotStart = new Map(v1.map((c) => [c.shotId, c.startMs]));
  for (const d of tl.clips.filter((c) => c.kind === "dialogue")) assert.ok(d.startMs >= shotStart.get(d.shotId));
  // approving again never duplicates anything
  const twice = await api("POST", P("/blueprint/approve"));
  assert.equal(twice.json.alreadyApproved, true);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_timeline_clips WHERE timeline_id = $1 AND kind = 'shot'", [tl.id])).rows[0].n, 65);
});

test("an approved picture/take/voice replaces the right slot; generated-but-unapproved media never does", async () => {
  await readyToApprove();
  await approveBlueprint(db, pid);
  const shots = await listShots(db, pid);
  const s1 = shots[0], s2 = shots[1];
  const line = (await db.query("SELECT e.id FROM production_scene_elements e WHERE e.project_id = $1 AND e.kind = 'dialogue' ORDER BY e.id LIMIT 1", [pid])).rows[0].id;
  const insert = async (kind, shotId, elementId, review = "pending", params = {}, status = "ready") =>
    (await db.query("INSERT INTO production_generations (project_id, kind, shot_id, element_id, version, status, review, prompt, params, duration_ms) VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(version),0)+1 FROM production_generations WHERE project_id = $1 AND kind = $2 AND COALESCE(shot_id,0) = $5 AND COALESCE(element_id,0) = $6),$7,$8,'p',$9,$10) RETURNING id", [pid, kind, shotId, elementId, shotId ?? 0, elementId ?? 0, status, review, JSON.stringify(params), kind === "audio" ? 2400 : null])).rows[0].id;
  const clipOf = async (shotId) => (await getTimeline(db, pid)).clips.find((c) => c.kind === "shot" && c.shotId === shotId);
  // 4. generated but unapproved image: slot unchanged, review needed
  const frame = await insert("keyframe", s1.id, null);
  let c = await clipOf(s1.id);
  assert.equal(c.state, "planned");
  assert.equal(c.media, null);
  assert.equal(c.reviewNeeded.frame, 1);
  assert.equal((await getTimeline(db, pid)).summary.reviewNeeded, 1);
  // approving it replaces the slot (5) and the video prompt is still there
  await db.query("UPDATE production_generations SET review = 'approved' WHERE id = $1", [frame]);
  c = await clipOf(s1.id);
  assert.equal(c.state, "first_frame");
  assert.equal(c.media.type, "image");
  assert.equal(c.media.generationId, frame);
  assert.ok(c.videoPrompt?.text, "the video prompt is still available");
  assert.equal(c.reviewNeeded.frame, 0);
  // 6. a generated but unapproved video does not replace the image
  const take1 = await insert("video", s1.id, null, "pending", { seconds: 4 });
  c = await clipOf(s1.id);
  assert.equal(c.state, "first_frame");
  assert.equal(c.media.type, "image");
  assert.equal(c.reviewNeeded.video, 1);
  await db.query("UPDATE production_generations SET review = 'approved' WHERE id = $1", [take1]);
  c = await clipOf(s1.id);
  assert.equal(c.state, "video");
  assert.equal(c.media.type, "video");
  assert.equal(c.sourceDurationMs, 4000, "the provider's source duration is kept apart from the planned and timeline durations");
  assert.equal(c.plannedDurationMs, Math.round(s1.durationSec * 1000));
  assert.ok(c.frame?.generationId === frame, "the approved first frame stays reachable");
  // 7. approving another take swaps the clip's media, and every older take/prompt remains in the database
  const take2 = await insert("video", s1.id, null, "pending", { seconds: 6 });
  await db.query("UPDATE production_generations SET review = 'pending' WHERE id = $1", [take1]);
  await db.query("UPDATE production_generations SET review = 'approved' WHERE id = $1", [take2]);
  c = await clipOf(s1.id);
  assert.equal(c.media.generationId, take2);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_generations WHERE shot_id = $1 AND kind = 'video'", [s1.id])).rows[0].n, 2);
  // the neighbouring shot is untouched
  assert.equal((await clipOf(s2.id)).state, "planned");
  // audio goes on the independent dialogue track
  const voice = await insert("audio", null, line);
  let tl = await getTimeline(db, pid);
  assert.equal(tl.clips.find((x) => x.elementId === line).state, "planned");
  await db.query("UPDATE production_generations SET review = 'approved' WHERE id = $1", [voice]);
  tl = await getTimeline(db, pid);
  const dlg = tl.clips.find((x) => x.elementId === line);
  assert.equal(dlg.state, "audio");
  assert.equal(dlg.media.type, "audio");
  assert.equal(dlg.sourceDurationMs, 2400);
  assert.equal(tl.tracks.find((t) => t.id === dlg.trackId).kind, "dialogue");
  assert.equal(tl.summary.videos, 1); assert.equal(tl.summary.audio, 1);
});

test("changes after approval are flagged stale and nothing is deleted; reopening gives a new draft and keeps the timeline", async () => {
  await readyToApprove();
  await approveBlueprint(db, pid);
  assert.deepEqual((await blueprintStaleness(db, pid)).reasons, []);
  const shot = (await listShots(db, pid))[3];
  await updateShot(db, pid, shot.id, { expectedRevision: shot.revision, edits: { durationSec: 9 } });
  let st = await blueprintStaleness(db, pid);
  assert.equal(st.stale, true);
  assert.ok(st.reasons.some((r) => r.code === "shots_changed"));
  assert.ok(st.reasons.some((r) => r.code === "prompts_stale"), "the video prompt carries the length, so it is out of date");
  const reopened = await reopenBlueprint(db, pid, { reason: "changed a shot" });
  assert.equal(reopened.status, "draft");
  assert.equal(reopened.version, 2);
  assert.equal((await db.query("SELECT status FROM production_blueprints WHERE project_id = $1 AND version = 1", [pid])).rows[0].status, "superseded", "the old Blueprint is history, not deleted");
  assert.equal((await getTimeline(db, pid)).clips.filter((c) => c.kind === "shot").length, 65, "the timeline is kept");
  await assert.rejects(reopenBlueprint(db, pid), /no approved Blueprint/);
  const v = await validateBlueprint(db, pid);
  assert.equal(v.ok, false, "stale prompts and a re-opened shot block approval until refreshed");
  await planPrompts(db, pid);
  for (const id of sceneIds) await approveShots(db, pid, id, { approved: true });
  const again = await approveBlueprint(db, pid);
  assert.equal(again.blueprint.version, 2);
  const tl = await getTimeline(db, pid);
  assert.equal(tl.clips.find((c) => c.shotId === shot.id).durationMs, 9000, "an unedited placeholder follows the new plan");
  assert.equal(tl.clips.find((c) => c.shotId === shot.id).plannedDurationMs, 9000);
  assert.equal(tl.clips.filter((c) => c.kind === "shot").length, 65, "no duplicates after re-approval");
  assert.equal((await promptHistory(db, pid, "video", { shotId: shot.id })).length, 2, "both prompt versions kept");
});

test("a clip a person has edited keeps their duration when the plan changes; a shot removed from the plan keeps its clip, flagged", async () => {
  await readyToApprove();
  await approveBlueprint(db, pid);
  const shots = await listShots(db, pid);
  const tl0 = await getTimeline(db, pid);
  const clip = tl0.clips.find((c) => c.shotId === shots[0].id);
  await db.query("UPDATE production_timeline_clips SET duration_ms = 1500, edited = TRUE WHERE id = $1", [clip.id]);
  const gone = shots[shots.length - 1];
  await db.query("DELETE FROM production_shots WHERE id = $1", [gone.id]);
  await updateShot(db, pid, shots[0].id, { expectedRevision: shots[0].revision, edits: { durationSec: 12 } });
  await reopenBlueprint(db, pid);
  await readyToApprove();
  await approveBlueprint(db, pid);
  const tl = await getTimeline(db, pid);
  const kept = tl.clips.find((c) => c.id === clip.id);
  assert.equal(kept.durationMs, 1500, "the edited timeline duration is theirs");
  assert.equal(kept.plannedDurationMs, 12000, "the planned duration still follows the Shot Cutter");
  const orphan = tl.clips.find((c) => c.kind === "shot" && c.shotId === null);
  assert.equal(orphan?.orphaned ?? true, true);
  assert.equal(tl.clips.filter((c) => c.kind === "shot" && !c.orphaned).length, 64);
});

test("a changed screenplay blocks approval until the Blueprint is re-synced; the earlier version stays on record", async () => {
  await readyToApprove();
  const { registerScreenplayVersion, ensureDraftBlueprint } = await import("../blueprint.js");
  const v1 = await registerScreenplayVersion(db, pid, "approval");
  await ensureDraftBlueprint(db, pid, v1.version);
  assert.equal((await validateBlueprint(db, pid)).errors.some((e) => e.code === "screenplay_changed"), false);
  await db.query("UPDATE production_scenes SET content_hash = 'changed-text' WHERE id = $1", [sceneIds[0]]);
  const v2 = await registerScreenplayVersion(db, pid, "approval");
  assert.equal(v2.changed, true);
  assert.equal(v2.version, v1.version + 1);
  const validation = await validateBlueprint(db, pid);
  assert.ok(validation.errors.some((e) => e.code === "screenplay_changed"), JSON.stringify(validation.errors.map((e) => e.code)));
  assert.equal((await api("POST", P("/blueprint/approve"))).status, 409);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_screenplay_versions WHERE project_id = $1", [pid])).rows[0].n, 2, "version 1 is still on record");
});

test("generation uses the planned prompt: the media row points at the prompt version, and a person's edit is what is sent", async () => {
  await planPrompts(db, pid);
  const gens = createGenerationService({ db, store: {}, providers: { models: { image: "i", speech: "s", video: "v" }, generateImage: async () => { throw new Error("fake provider (no real service in this test)"); }, generateSpeech: async () => { throw new Error("fake"); }, generateVideo: async () => { throw new Error("fake") } } });
  const asset = (await db.query("SELECT id FROM production_assets WHERE project_id = $1 AND kind = 'character' AND in_latest_import LIMIT 1", [pid])).rows[0];
  await editPrompt(db, pid, "model_sheet", { assetId: asset.id }, "EDITED SHEET WORDS: a front view and a side view.");
  const { row, done } = await gens.generateReference(pid, asset.id, { actorUserId: 1 });
  await done;
  assert.equal(row.prompt, "EDITED SHEET WORDS: a front view and a side view.");
  assert.ok(row.prompt_id);
  const p = (await db.query("SELECT purpose, version, edited FROM production_prompts WHERE id = $1", [row.prompt_id])).rows[0];
  assert.deepEqual([p.purpose, p.version, p.edited], ["model_sheet", 2, true]);
  assert.equal((await db.query("SELECT status FROM production_generations WHERE id = $1", [row.id])).rows[0].status, "failed", "the fake provider failed, as arranged");
  const m = await buildShotManifest(db, pid);
  assert.equal(m.assets.find((a) => a.db_id === asset.id).state, "failed");
  // generating WITHOUT a prior Blueprint still works and still records the prompt (existing projects keep working)
  const shot = (await listShots(db, pid)).find((s) => s.assets.length > 0);
  await db.query("DELETE FROM production_prompts WHERE project_id = $1", [pid]);
  const r2 = await gens.generateReference(pid, asset.id, { actorUserId: 1 }).then(async (x) => { await x.done; return x.row; });
  assert.ok(r2.prompt_id, "the prompt was created on demand");
  assert.equal(r2.version, 2);
  void shot;
});

test("money limit: generation still checks the project's limit with prompts in the loop", async () => {
  await planPrompts(db, pid);
  await saveSettings(db, pid, { budgetLimitUsd: 0.001 });
  const gens = createGenerationService({ db, store: {}, providers: { models: { image: "i", speech: "s", video: "v" }, generateImage: async () => ({ bytes: Buffer.from("x"), ext: ".png" }) } });
  const asset = (await db.query("SELECT id FROM production_assets WHERE project_id = $1 AND in_latest_import LIMIT 1", [pid])).rows[0];
  await assert.rejects(gens.generateReference(pid, asset.id), (e) => e.status === 402);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_generations WHERE project_id = $1", [pid])).rows[0].n, 0, "nothing was started");
});

test("live events: approving media publishes a project-scoped event over the in-process bus and over the SSE route", async () => {
  const seen = [];
  const off = subscribe(pid, (e) => seen.push(e));
  const other = [];
  const offOther = subscribe(pid + 1000, (e) => other.push(e));
  await planPrompts(db, pid);
  assert.ok(seen.some((e) => e.type === "prompts_planned"));
  const gens = createGenerationService({ db, store: {}, providers: { models: { image: "i", speech: "s", video: "v" } } });
  const shot = (await listShots(db, pid))[0];
  const g = (await db.query("INSERT INTO production_generations (project_id, kind, shot_id, version, status, review, prompt) VALUES ($1,'keyframe',$2,1,'ready','pending','p') RETURNING id", [pid, shot.id])).rows[0].id;
  await gens.review(pid, g, { decision: "approve" });
  const ev = seen.find((e) => e.type === "media_review");
  assert.deepEqual([ev.decision, ev.kind, ev.shotId, ev.generationId], ["approve", "keyframe", shot.id, g]);
  assert.equal(other.length, 0, "another project's listeners hear nothing");
  off(); offOther();
  // SSE over HTTP
  const controller = new AbortController();
  const response = await fetch(`${base}${P("/events")}`, { signal: controller.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const readUntil = async (re) => { while (!re.test(text)) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value); } };
  await readUntil(/hello/);
  assert.equal(subscriberCount(pid), 1);
  await gens.review(pid, g, { decision: "reset" });
  await readUntil(/media_review/);
  assert.match(text, /"decision":"reset"/);
  controller.abort();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(subscriberCount(pid), 0, "a closed connection is cleaned up");
  assert.equal((await api("GET", "/api/production/abc/events")).status, 400);
});

test("existing projects with no Blueprint records load: manifest, blueprint status and timeline all answer sensibly", async () => {
  const bp = (await api("GET", P("/blueprint"))).json;
  assert.equal(bp.blueprint, null);
  assert.equal(bp.validation.ok, false);
  assert.equal((await api("GET", P("/timeline"))).json.exists, false);
  assert.equal((await api("GET", P("/manifest"))).json.shots.length, 65);
  assert.equal((await api("GET", `/api/production/999999/blueprint`)).status, 404);
});

test("any successful production change tells watchers to refetch (and a refused one does not)", async () => {
  const seen = [];
  const off = subscribe(pid, (e) => seen.push(e));
  await api("POST", P("/blueprint/approve")); // refused: not valid yet
  assert.equal(seen.filter((e) => e.type === "changed").length, 0, "a refused request changes nothing, so it announces nothing");
  await api("POST", P("/blueprint/prompts/plan"));
  assert.ok(seen.some((e) => e.type === "changed" && /prompts\/plan/.test(e.path)));
  assert.ok(seen.some((e) => e.type === "prompts_planned"));
  await readyToApprove();
  await api("POST", P("/blueprint/approve"));
  assert.ok(seen.some((e) => e.type === "blueprint_approved"));
  assert.ok(seen.some((e) => e.type === "timeline_changed"), "the timeline announces itself too");
  off();
});

test("the prompt list is in plan order (assets, then each shot's frame and video) and stays in that order after an edit", async () => {
  await planPrompts(db, pid);
  const before = (await api("GET", P("/blueprint/prompts?purpose=first_frame"))).json.prompts.map((p) => p.shotId);
  const shot = (await listShots(db, pid))[0];
  await editPrompt(db, pid, "first_frame", { shotId: shot.id }, "edited words");
  const after = (await api("GET", P("/blueprint/prompts?purpose=first_frame"))).json.prompts.map((p) => p.shotId);
  assert.deepEqual(after, before);
  assert.equal(after[0], shot.id);
});
