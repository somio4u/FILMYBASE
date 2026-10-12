// Phase 3: Image Studio read models (library + one slot per planned shot), canonical vs history, dependencies, stale marks,
// and the whole generate -> review -> approve -> timeline loop through the REAL generation service.
// MOCK: storage is the local imitation of Google Drive, the picture model is the local imitation of Gemini (tests/mockGemini.js).
// Nothing here proves the real Google picture model accepts the same requests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import pg from "pg";
import { seedTestProject } from "../production.js";
import { analyzeScreenplay } from "../screenplayAnalysis.js";
import { approveShots, divideScene, listShots } from "../shots.js";
import { ensureAllProductionSchemas } from "../productionSchema.js";
import { setupProductionMedia } from "../productionMedia.js";
import { registerPipelineRoutes } from "../pipelineRoutes.js";
import { createProviders } from "../providers.js";
import { registerEventRoutes, subscribe } from "../events.js";
import { registerBlueprintRoutes } from "../blueprint.js";
import { approveBlueprint, planPrompts, registerPlanningRoutes } from "../planning.js";
import { getTimeline, registerTimelineRoutes } from "../timeline.js";
import { registerStudioRoutes, assetLibrary, frameSlots } from "../studio.js";
import { editPrompt } from "../prompts.js";
import { saveSettings } from "../pipelineSettings.js";
import { startMockDrive } from "./mockDrive.js";
import { startMockGemini } from "./mockGemini.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "image-studio-"));
let drive, gemini, server, base, pid, sceneDb, shots;
const requireRole = () => (req, res, next) => ((req.user = { id: 1 }), next());
const api = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json };
};
const P = (s = "") => `/api/production/${pid}${s}`;
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 50)); }
}
const idle = () => until(async () => (await api("GET", P("/generations"))).json.generations.every((g) => g.status !== "running"), "generations to finish");

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  assert.deepEqual(await ensureAllProductionSchemas(db), []);
  await db.query("DELETE FROM production_drive_folders");
  await db.query("DELETE FROM production_drive_tokens");
  await db.query("INSERT INTO production_drive_tokens (access_token, refresh_token, expiry_date) VALUES ('test-token','r',$1)", [Date.now() + 3_600_000]);
  drive = await startMockDrive();
  gemini = await startMockGemini();
  const app = express();
  app.use(express.json());
  registerEventRoutes(app, db, requireRole, { heartbeatMs: 60000 });
  const media = setupProductionMedia({ app, db, requireRole, backendDir: tmp, frontendUrl: "http://front", redirectUri: "http://back/cb", env: { MEDIA_BACKEND: "gdrive", GOOGLE_CLIENT_ID: "cid" }, driveOverrides: { apiBase: drive.apiBase, uploadBase: drive.uploadBase } });
  registerBlueprintRoutes(app, db, requireRole);
  registerPlanningRoutes(app, db, requireRole);
  registerStudioRoutes(app, db, requireRole);
  registerTimelineRoutes(app, db, requireRole);
  registerPipelineRoutes(app, db, requireRole, { store: media.store, providers: createProviders({ env: { GEMINI_API_KEY: "test-key", GEMINI_API_BASE: gemini.base }, sleep: async () => {} }) });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'");
  pid = (await seedTestProject(db)).projectId;
  await analyzeScreenplay(db, pid);
  const scenes = (await db.query("SELECT id, scene_number FROM production_scenes WHERE project_id = $1 AND in_latest ORDER BY order_index", [pid])).rows;
  for (const s of scenes) await divideScene(db, pid, s.id, { mode: "script", replace: true });
  for (const s of scenes) await approveShots(db, pid, s.id, { approved: true });
  sceneDb = scenes.find((s) => s.scene_number === "2").id;
  shots = (await listShots(db, pid, { sceneId: sceneDb }));
  await planPrompts(db, pid);
  await approveBlueprint(db, pid);
});
test.after(async () => { server.close(); await drive.close(); await gemini.close(); await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'"); await db.end(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("every planned shot has exactly one slot: scene 2's 8 shots show 8 slots, each with its prompt and dependencies, before anything is generated", async () => {
  const r = (await api("GET", P(`/studio/frames?sceneId=${sceneDb}`))).json;
  assert.equal(r.slots.length, shots.length);
  assert.equal(r.counts.shots, 8);
  assert.equal(r.counts.approved, 0);
  assert.deepEqual(r.slots.map((s) => s.shotId), shots.map((s) => `SC002_${s.code}`));
  for (const s of r.slots) {
    assert.equal(s.state === "blocked" || s.state === "planned", true);
    assert.match(s.prompt.text, /single film frame/);
    assert.equal(s.prompt.stale, false);
    assert.equal(s.canonical, null);
    assert.ok(s.dependencies.length >= 1);
  }
  assert.equal(r.counts.readyToMake, 0, "nothing can be made until its references are approved");
  assert.equal(r.counts.blocked, 8);
  const blocked = r.slots.find((s) => s.readiness.missing.length > 0);
  assert.match(blocked.readiness.missing[0], /^(CHAR|PROP|LOC|ENV)?\w*\d+ /);
  const scenes = (await api("GET", P("/studio/frames/scenes"))).json.scenes;
  assert.equal(scenes.length, 12);
  assert.equal(scenes.find((s) => s.code === "SC002").shots, 8);
});

test("a scene with 15 shots shows 15 planned image slots", async () => {
  const sc = (await db.query("SELECT id FROM production_scenes WHERE project_id = $1 AND scene_number = '1'", [pid])).rows[0].id;
  const have = (await listShots(db, pid, { sceneId: sc })).length;
  for (let k = have; k < 15; k++) await db.query("INSERT INTO production_shots (project_id, scene_id, code, order_index, description, duration_sec, shot_status) VALUES ($1,$2,$3,$4,'extra shot',3,'approved')", [pid, sc, `SH9${String(k).padStart(2, "0")}`, k]);
  assert.equal((await api("GET", P(`/studio/frames?sceneId=${sc}`))).json.slots.length, 15);
});

test("the asset libraries: Characters / Environments / Properties list the project's own assets with state, prompt and where each is used", async () => {
  const ch = (await api("GET", P("/studio/assets?type=character"))).json;
  const env = (await api("GET", P("/studio/assets?type=environment"))).json;
  const prop = (await api("GET", P("/studio/assets?type=property"))).json;
  assert.ok(ch.assets.length >= 4 && env.assets.length >= 4 && prop.assets.length >= 4);
  assert.ok(ch.assets.every((a) => a.type === "character") && env.assets.every((a) => a.type === "environment") && prop.assets.every((a) => ["prop", "other"].includes(a.type)));
  const rahul = ch.assets.find((a) => /Rahul/.test(a.name));
  assert.match(rahul.prompt.text, /Character model sheet/);
  assert.ok(rahul.usedCount > 5, "the shots that use this character are listed");
  assert.match(rahul.usedInShots[0], /^SC\d+_SH\d+$/);
  assert.equal(rahul.canonical, null);
  assert.equal(ch.counts.approved, 0);
  assert.equal(ch.counts.inProject, ch.assets.length);
  assert.ok(ch.counts.estimateMissingUsd > 0);
  assert.equal((await api("GET", P("/studio/assets?type=wizard"))).status, 400);
  assert.equal((await api("GET", P("/studio/frames"))).status, 400);
});

test("generate -> review -> approve: a new result waits for review and never becomes the canonical one until approved; older versions go to history", async () => {
  const rahul = (await api("GET", P("/studio/assets?type=character"))).json.assets.find((a) => /Rahul/.test(a.name));
  const start = await api("POST", P("/generate"), { kind: "character", targetIds: [rahul.dbId] });
  assert.equal(start.status, 202);
  const during = (await api("GET", P("/studio/assets?type=character"))).json.assets.find((a) => a.dbId === rahul.dbId);
  assert.ok(during.running || during.latestReady, "running or already finished");
  await idle();
  let a = (await api("GET", P("/studio/assets?type=character"))).json.assets.find((x) => x.dbId === rahul.dbId);
  assert.equal(a.state, "ready_for_review");
  assert.equal(a.canonical, null, "a generated-but-unapproved sheet is not canonical");
  assert.ok(a.latestReady?.mediaUrl);
  assert.equal(a.latestReady.promptCurrent, true, "it was made from the current planned prompt");
  const v1 = a.latestReady.id;
  await api("POST", P(`/generations/${v1}/review`), { decision: "approve" });
  a = (await api("GET", P("/studio/assets?type=character"))).json.assets.find((x) => x.dbId === rahul.dbId);
  assert.equal(a.state, "approved");
  assert.equal(a.canonical.id, v1);
  assert.equal(a.history.length, 0);
  // regenerate: v2 is ready for review, v1 stays canonical
  await api("POST", P("/generate"), { kind: "character", targetIds: [rahul.dbId] });
  await idle();
  a = (await api("GET", P("/studio/assets?type=character"))).json.assets.find((x) => x.dbId === rahul.dbId);
  assert.equal(a.canonical.id, v1, "the approved version is untouched until the new one is approved");
  assert.equal(a.latestReady.version, 2);
  await api("POST", P(`/generations/${a.latestReady.id}/review`), { decision: "approve" });
  a = (await api("GET", P("/studio/assets?type=character"))).json.assets.find((x) => x.dbId === rahul.dbId);
  assert.equal(a.canonical.version, 2);
  assert.equal(a.history.length, 1, "v1 moved into the history, nothing was deleted");
  assert.equal(a.history[0].version, 1);
  assert.equal(a.versions, 2);
});

test("double submit while a job runs is refused; regenerate/refresh never create two canonical results", async () => {
  const lib = (await api("GET", P("/studio/assets?type=environment"))).json.assets[0];
  const [first, second] = await Promise.all([api("POST", P("/generate"), { kind: "environment", targetIds: [lib.dbId] }), api("POST", P("/generate"), { kind: "environment", targetIds: [lib.dbId] })]);
  assert.deepEqual([first.status, second.status].sort(), [202, 409], "exactly one of the two simultaneous requests started a job");
  await idle();
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_generations WHERE project_id = $1 AND asset_id = $2", [pid, lib.dbId])).rows[0].n, 1);
  const g = (await api("GET", P(`/generations?assetId=${lib.dbId}`))).json.generations[0];
  await api("POST", P(`/generations/${g.id}/review`), { decision: "approve" });
  await api("POST", P(`/generations/${g.id}/review`), { decision: "approve" }); // pressing twice is harmless
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_generations WHERE project_id = $1 AND asset_id = $2 AND review = 'approved'", [pid, lib.dbId])).rows[0].n, 1);
});

test("first frames wait for their references; independent shots proceed; the approved frame appears on the timeline", async () => {
  const slots0 = (await api("GET", P(`/studio/frames?sceneId=${sceneDb}`))).json;
  const needed = new Map();
  for (const s of slots0.slots) for (const d of s.dependencies) needed.set(d.code, d);
  // blocked by every missing reference
  const refused = await api("POST", P("/generate"), { kind: "keyframe", targetIds: [slots0.slots[0].dbId] });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /need an approved reference picture first/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_generations WHERE project_id = $1 AND kind = 'keyframe'", [pid])).rows[0].n, 0, "nothing was made, nothing was spent");
  // approve the references that ONE shot needs: only that shot (and shots needing no more) become ready
  const lib = async (type) => (await api("GET", P(`/studio/assets?type=${type}`))).json.assets;
  const all = [...(await lib("character")), ...(await lib("environment")), ...(await lib("property"))];
  const target = slots0.slots[0];
  const kindOf = { character: "character", environment: "environment", prop: "prop", other: "prop" };
  for (const d of target.dependencies) {
    const asset = all.find((a) => a.assetId === d.code);
    await api("POST", P("/generate"), { kind: kindOf[asset.type] ?? "prop", targetIds: [asset.dbId] });
    await idle();
    const gid = (await api("GET", P(`/generations?assetId=${asset.dbId}`))).json.generations[0].id;
    await api("POST", P(`/generations/${gid}/review`), { decision: "approve" });
  }
  const slots1 = (await api("GET", P(`/studio/frames?sceneId=${sceneDb}`))).json;
  const ready = slots1.slots.filter((s) => s.readiness.ok);
  assert.ok(ready.length >= 1 && ready.length < slots1.slots.length, `only the shots whose references are approved are ready (${ready.length} of ${slots1.slots.length})`);
  assert.equal(slots1.counts.readyToMake, ready.length);
  assert.ok(slots1.counts.estimateUsd > 0);
  assert.equal(slots1.slots[0].readiness.ok, true);
  // make the ready frames only (one request, many shots)
  const seen = [];
  const off = subscribe(pid, (e) => seen.push(e));
  const batch = await api("POST", P("/generate"), { kind: "keyframe", targetIds: slots1.slots.map((s) => s.dbId) });
  assert.equal(batch.status, 202);
  assert.equal(batch.json.started.length, ready.length, "the blocked shots were skipped, not failed");
  assert.equal(batch.json.skipped.length, slots1.slots.length - ready.length);
  await idle();
  // the event follows the status change by a moment (after the spend is written), so wait for it rather than assume
  await until(() => seen.filter((e) => e.type === "job_finished").length >= ready.length, "every finished job to announce itself");
  off();
  const slots2 = (await api("GET", P(`/studio/frames?sceneId=${sceneDb}`))).json;
  const made = slots2.slots.find((s) => s.dbId === slots1.slots[0].dbId);
  assert.equal(made.state, "ready_for_review");
  assert.equal(made.canonical, null);
  assert.equal(made.latestReady.promptCurrent, true);
  // the timeline does NOT change until approval
  let tl = await getTimeline(db, pid);
  assert.equal(tl.clips.find((c) => c.shotId === made.dbId).state, "planned");
  assert.equal(tl.clips.find((c) => c.shotId === made.dbId).reviewNeeded.frame, 1);
  await api("POST", P(`/generations/${made.latestReady.id}/review`), { decision: "approve" });
  tl = await getTimeline(db, pid);
  const clip = tl.clips.find((c) => c.shotId === made.dbId);
  assert.equal(clip.state, "first_frame");
  assert.equal(clip.media.type, "image");
  assert.equal(clip.media.generationId, made.latestReady.id);
  // retry / regenerate / reopen: still one canonical and one timeline clip
  await api("POST", P("/generate"), { kind: "keyframe", targetIds: [made.dbId] });
  await idle();
  const after = (await api("GET", P(`/studio/frames?sceneId=${sceneDb}`))).json.slots.find((s) => s.dbId === made.dbId);
  assert.equal(after.canonical.id, made.latestReady.id, "the approved frame stays canonical while a new one waits for review");
  assert.equal(after.latestReady.version, 2);
  assert.equal(after.history.length, 0);
  assert.equal((await getTimeline(db, pid)).clips.filter((c) => c.shotId === made.dbId && c.kind === "shot").length, 1);
});

test("a shot frame made from a reference that was later replaced, or from an older prompt, is flagged stale — not deleted", async () => {
  const lib = (await api("GET", P("/studio/assets?type=character"))).json.assets;
  const slots = (await api("GET", P(`/studio/frames?sceneId=${sceneDb}`))).json.slots;
  const slot = slots.find((s) => s.dependencies.every((d) => d.type === "character" || d.type === "environment" || d.type === "prop" || d.type === "other"));
  // approve all of that shot's references quickly with direct rows (this test is about the flags, not the generation itself)
  const all = [...lib, ...(await api("GET", P("/studio/assets?type=environment"))).json.assets, ...(await api("GET", P("/studio/assets?type=property"))).json.assets];
  const kindOf = { character: "character", environment: "environment", prop: "prop", other: "prop" };
  const refIds = [];
  for (const d of slot.dependencies) {
    const a = all.find((x) => x.assetId === d.code);
    const g = (await db.query("INSERT INTO production_generations (project_id, kind, asset_id, version, status, review, prompt) VALUES ($1,$2,$3,1,'ready','approved','p') RETURNING id", [pid, kindOf[a.type], a.dbId])).rows[0].id;
    refIds.push(g);
  }
  const frame = (await db.query("INSERT INTO production_generations (project_id, kind, shot_id, version, status, review, prompt, params) VALUES ($1,'keyframe',$2,1,'ready','approved','p',$3) RETURNING id", [pid, slot.dbId, JSON.stringify({ refs: refIds })])).rows[0].id;
  let s = (await api("GET", P(`/studio/frames?sceneId=${sceneDb}`))).json.slots.find((x) => x.dbId === slot.dbId);
  assert.equal(s.stale, false);
  assert.equal(s.canonical.id, frame);
  // the first reference is replaced by a new approval
  const asset = all.find((x) => x.assetId === slot.dependencies[0].code);
  const newer = (await db.query("INSERT INTO production_generations (project_id, kind, asset_id, version, status, review, prompt) VALUES ($1,$2,$3,2,'ready','pending','p') RETURNING id", [pid, kindOf[asset.type], asset.dbId])).rows[0].id;
  await api("POST", P(`/generations/${newer}/review`), { decision: "approve" });
  s = (await api("GET", P(`/studio/frames?sceneId=${sceneDb}`))).json.slots.find((x) => x.dbId === slot.dbId);
  assert.equal(s.canonical.outdated, true);
  assert.equal(s.stale, true);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_generations WHERE id = $1", [frame])).rows[0].n, 1, "the frame still exists");
  // an edited prompt that is later out of date by a shot change is flagged too
  await editPrompt(db, pid, "first_frame", { shotId: slot.dbId }, "hand written");
  await db.query("UPDATE production_shots SET description = description || ' (changed)' WHERE id = $1", [slot.dbId]);
  s = (await api("GET", P(`/studio/frames?sceneId=${sceneDb}`))).json.slots.find((x) => x.dbId === slot.dbId);
  assert.equal(s.prompt.stale, true);
  assert.equal(s.prompt.edited, true);
});

test("money limit: a batch of frames stops at the limit; nothing is started over it", async () => {
  const slot = (await api("GET", P(`/studio/frames?sceneId=${sceneDb}`))).json.slots[0];
  await saveSettings(db, pid, { budgetLimitUsd: 0.001 });
  const r = await api("POST", P("/generate"), { kind: "environment", targetIds: [(await api("GET", P("/studio/assets?type=environment"))).json.assets[0].dbId] });
  assert.equal(r.status, 402);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_generations WHERE project_id = $1", [pid])).rows[0].n, 0);
  void slot;
});

test("the studio's slots use the edited prompt, and the media row records which prompt version it came from", async () => {
  const env = (await api("GET", P("/studio/assets?type=environment"))).json.assets[0];
  await editPrompt(db, pid, "model_sheet", { assetId: env.dbId }, "HAND-WRITTEN environment sheet prompt, wide view and a detail view.");
  await api("POST", P("/generate"), { kind: "environment", targetIds: [env.dbId] });
  await idle();
  const a = (await api("GET", P("/studio/assets?type=environment"))).json.assets.find((x) => x.dbId === env.dbId);
  assert.equal(a.latestReady.promptCurrent, true);
  const row = (await db.query("SELECT g.prompt, p.version, p.edited FROM production_generations g JOIN production_prompts p ON p.id = g.prompt_id WHERE g.id = $1", [a.latestReady.id])).rows[0];
  assert.equal(row.prompt, "HAND-WRITTEN environment sheet prompt, wide view and a detail view.");
  assert.deepEqual([row.version, row.edited], [2, true]);
  assert.equal(gemini.state.requests.some((r) => JSON.stringify(r.body ?? {}).includes("HAND-WRITTEN environment sheet prompt")), true, "the edited words are what was actually sent to the (mock) picture model");
});

test("studio helpers answer for a project with no scenes or assets without failing", async () => {
  const empty = (await db.query("INSERT INTO ai_movie_projects (pasted_text, title) VALUES ('x','[TEST] Idea of an Idea empty') RETURNING id")).rows[0].id;
  assert.deepEqual((await assetLibrary(db, empty, "character")).assets, []);
  assert.deepEqual((await frameSlots(db, empty, 123)).slots, []);
});
