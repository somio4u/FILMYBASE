// Phase 1 of the production restructure: screenplay versions, the Shot Manifest (the one read model every screen and agent
// uses), and the screenplay-approval hook. Real Postgres; no AI is involved (MOCK-FREE: nothing external is called).
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { seedTestProject } from "../production.js";
import { analyzeScreenplay } from "../screenplayAnalysis.js";
import { divideScene, listShots } from "../shots.js";
import { ensureAllProductionSchemas } from "../productionSchema.js";
import { buildShotManifest, currentScreenplayVersion, ensureBlueprintSchema, onScreenplayApproved, registerBlueprintRoutes, registerScreenplayVersion, screenplayFingerprint, shotRefId, slotState } from "../blueprint.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let server, base;
const requireRole = () => (req, res, next) => ((req.user = { id: 1 }), next());
const api = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json };
};
const bil = (en) => ({ en, hi: en });
const scene = (heading, action) => ({ sceneHeading: bil(heading), action: bil(action), estimatedMinutes: 1 });
async function beatsProject(title, sceneCount = 3) {
  const scenes = Array.from({ length: sceneCount }, (_, i) => scene(`INT. ROOM ${i + 1} - DAY`, `Action of scene ${i + 1}. Rudra looks at the lamp.`));
  const id = (await db.query("INSERT INTO ai_movie_projects (pasted_text, title, backfill) VALUES ('idea',$1,$2) RETURNING id", [title, JSON.stringify({ screenplayBeats: [{ status: "approved", scenes }] })])).rows[0].id;
  return id;
}

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  assert.deepEqual(await ensureAllProductionSchemas(db), []);
  await ensureBlueprintSchema(db); // idempotent
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] bp%' OR title LIKE '[TEST] Idea of an Idea%'");
  const app = express();
  app.use(express.json());
  registerBlueprintRoutes(app, db, requireRole);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] bp%' OR title LIKE '[TEST] Idea of an Idea%'"); await db.end(); });

test("screenplay approval hook: reads the screenplay into production, records version 1 and opens a draft Blueprint — and is safe to repeat", async () => {
  const pid = await beatsProject("[TEST] bp hook");
  const first = await onScreenplayApproved(db, pid);
  assert.equal(first.analyzed, true);
  assert.equal(first.summary.scenes, 3);
  assert.equal(first.screenplayVersion, 1);
  assert.equal(first.screenplayChanged, true);
  assert.equal(first.blueprintStatus, "draft");
  const again = await onScreenplayApproved(db, pid);
  assert.equal(again.screenplayVersion, 1, "the same screenplay approved twice is still version 1");
  assert.equal(again.screenplayChanged, false);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_blueprints WHERE project_id = $1", [pid])).rows[0].n, 1, "no duplicate draft");
});

test("a changed screenplay becomes version 2; nothing made from version 1 is deleted", async () => {
  const pid = await beatsProject("[TEST] bp versions");
  await onScreenplayApproved(db, pid);
  const before = await screenplayFingerprint(db, pid);
  const backfill = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [pid])).rows[0].backfill;
  backfill.screenplayBeats[0].scenes[1].action = bil("A completely different second scene. The lamp falls.");
  await db.query("UPDATE ai_movie_projects SET backfill = $2 WHERE id = $1", [pid, JSON.stringify(backfill)]);
  const second = await onScreenplayApproved(db, pid);
  assert.equal(second.screenplayVersion, 2);
  assert.equal(second.screenplayChanged, true);
  assert.notEqual((await screenplayFingerprint(db, pid)).fingerprint, before.fingerprint);
  const versions = (await api("GET", `/api/production/${pid}/screenplay-versions`)).json.versions;
  assert.deepEqual(versions.map((v) => v.version), [2, 1], "both versions are kept");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_blueprints WHERE project_id = $1", [pid])).rows[0].n, 1, "the open Blueprint carries on (Phase 2 marks it stale)");
});

test("hook on a project with no screenplay yet reports it instead of failing", async () => {
  const id = (await db.query("INSERT INTO ai_movie_projects (pasted_text, title) VALUES ('just an idea','[TEST] bp empty') RETURNING id")).rows[0].id;
  const r = await onScreenplayApproved(db, id);
  assert.equal(r.analyzed, false);
  assert.ok(r.reason);
  assert.equal((await currentScreenplayVersion(db, id)), null);
});

test("Shot Manifest on the real 'Idea of an Idea' screenplay: ordered, stable ids, durations add up to the timeline start times", async () => {
  const projectId = (await seedTestProject(db)).projectId;
  await analyzeScreenplay(db, projectId);
  const scenes = (await db.query("SELECT id FROM production_scenes WHERE project_id = $1 AND in_latest ORDER BY order_index", [projectId])).rows;
  for (const s of scenes) await divideScene(db, projectId, s.id, { mode: "script", replace: true });
  const shots = await listShots(db, projectId);
  assert.equal(shots.length, 65);
  const manifest = await buildShotManifest(db, projectId);
  assert.equal(manifest.shots.length, 65);
  assert.equal(manifest.totals.shots, 65);
  assert.equal(manifest.totals.scenes, 12);
  assert.equal(new Set(manifest.shots.map((s) => s.shot_id)).size, 65, "every shot id is distinct");
  assert.match(manifest.shots[0].shot_id, /^SC001_SH001$/);
  let t = 0;
  manifest.shots.forEach((s, i) => {
    assert.equal(s.sequence, i + 1);
    assert.equal(s.planned_start_ms, t, "start = sum of the durations before it");
    assert.equal(s.timeline.duration_ms, s.planned_duration_ms);
    assert.ok(s.planned_duration_ms >= 1000);
    t += s.planned_duration_ms;
  });
  assert.equal(manifest.totals.planned_duration_ms, t);
  assert.ok(manifest.shots.every((s) => s.image.state === "planned" || s.image.state === "blocked"));
  assert.ok(manifest.shots.every((s) => s.image.prompt_id === null && s.video.prompt_id === null), "no prompts exist until the Blueprint is planned (Phase 2)");
  assert.ok(manifest.shots.every((s) => s.video.state === "blocked" && s.video.blocked_by[0] === "first frame"), "video waits for an approved first frame");
  assert.equal(manifest.shots.some((s) => s.character_ids.length > 0), true, "characters are linked by their stable codes");
  assert.equal(manifest.screenplay_version, 1, "a project that existed before versions gets version 1 the first time it is read");
  assert.equal((await db.query("SELECT source FROM production_screenplay_versions WHERE project_id = $1", [projectId])).rows[0].source, "migrated");
  assert.deepEqual((await api("GET", `/api/production/${projectId}/manifest`)).json.totals, manifest.totals);
});

test("scale: 20 scenes and 251 shots give 251 distinct, ordered shots with correct start times", async () => {
  const pid = await beatsProject("[TEST] bp scale", 20);
  await onScreenplayApproved(db, pid);
  const scenes = (await db.query("SELECT id FROM production_scenes WHERE project_id = $1 AND in_latest ORDER BY order_index", [pid])).rows;
  let n = 0;
  const durations = [];
  for (let s = 0; s < scenes.length; s++) {
    const count = s < 11 ? 13 : 12; // 11*13 + 9*12 = 251
    for (let k = 0; k < count; k++) {
      n++;
      const d = 2 + ((n * 7) % 6); // 2..7 seconds, varied
      durations.push(d);
      await db.query("INSERT INTO production_shots (project_id, scene_id, code, order_index, description, duration_sec, framing) VALUES ($1,$2,$3,$4,$5,$6,'Wide')", [pid, scenes[s].id, `SH${String(n).padStart(3, "0")}`, k, `Shot ${n}`, d]);
    }
  }
  assert.equal(n, 251);
  const manifest = await buildShotManifest(db, pid);
  assert.equal(manifest.shots.length, 251);
  assert.equal(manifest.totals.scenes, 20);
  assert.equal(new Set(manifest.shots.map((s) => s.shot_id)).size, 251);
  let t = 0;
  manifest.shots.forEach((s, i) => { assert.equal(s.planned_start_ms, t); assert.equal(s.planned_duration_ms, durations[i] * 1000); t += durations[i] * 1000; });
  assert.equal(manifest.totals.planned_duration_ms, durations.reduce((a, b) => a + b, 0) * 1000);
  assert.deepEqual(manifest.shots.map((s) => s.sequence), Array.from({ length: 251 }, (_, i) => i + 1));
});

test("one project's manifest never contains another project's shots, assets or versions", async () => {
  const a = await beatsProject("[TEST] bp iso a");
  const b = await beatsProject("[TEST] bp iso b");
  await onScreenplayApproved(db, a); await onScreenplayApproved(db, b);
  const sa = (await db.query("SELECT id FROM production_scenes WHERE project_id = $1 ORDER BY order_index LIMIT 1", [a])).rows[0].id;
  await db.query("INSERT INTO production_shots (project_id, scene_id, code, order_index, description, duration_sec) VALUES ($1,$2,'SH001',0,'only in a',3)", [a, sa]);
  assert.equal((await buildShotManifest(db, a)).shots.length, 1);
  assert.equal((await buildShotManifest(db, b)).shots.length, 0);
  assert.equal((await api("GET", `/api/production/999999/manifest`)).status, 404);
  assert.equal((await api("GET", `/api/production/abc/manifest`)).status, 400);
});

test("slotState: planned / blocked / generating / ready for review / approved / failed are told apart", () => {
  assert.equal(slotState({ approved: null, generations: [], blocked: false }), "planned");
  assert.equal(slotState({ approved: null, generations: [], blocked: true }), "blocked");
  assert.equal(slotState({ approved: null, generations: [{ status: "running", review: "pending" }], blocked: false }), "generating");
  assert.equal(slotState({ approved: null, generations: [{ status: "ready", review: "pending" }], blocked: false }), "ready_for_review");
  assert.equal(slotState({ approved: null, generations: [{ status: "ready", review: "rejected" }], blocked: false }), "planned", "a rejected result leaves the slot waiting for a new one");
  assert.equal(slotState({ approved: null, generations: [{ status: "failed", review: "pending" }], blocked: false }), "failed");
  assert.equal(slotState({ approved: { id: 1 }, generations: [{ status: "ready", review: "approved" }], blocked: true }), "approved");
  assert.equal(shotRefId({ sceneCode: "SC002", code: "SH015" }), "SC002_SH015");
});

test("a generated but unapproved picture is 'ready for review', never 'approved'; approving it changes the manifest", async () => {
  const pid = await beatsProject("[TEST] bp review");
  await onScreenplayApproved(db, pid);
  const sc = (await db.query("SELECT id FROM production_scenes WHERE project_id = $1 ORDER BY order_index LIMIT 1", [pid])).rows[0].id;
  const shotId = (await db.query("INSERT INTO production_shots (project_id, scene_id, code, order_index, description, duration_sec, shot_status) VALUES ($1,$2,'SH001',0,'Rudra at the lamp',3,'approved') RETURNING id", [pid, sc])).rows[0].id;
  const gen = (await db.query("INSERT INTO production_generations (project_id, kind, shot_id, version, status, review, prompt) VALUES ($1,'keyframe',$2,1,'ready','pending','p') RETURNING id", [pid, shotId])).rows[0].id;
  let m = await buildShotManifest(db, pid);
  assert.equal(m.shots[0].image.state, "ready_for_review");
  assert.equal(m.shots[0].image.approved_asset_id, null, "nothing is canonical until approved");
  assert.equal(m.totals.first_frames_approved, 0);
  await db.query("UPDATE production_generations SET review = 'approved' WHERE id = $1", [gen]);
  m = await buildShotManifest(db, pid);
  assert.equal(m.shots[0].image.state, "approved");
  assert.equal(m.shots[0].image.approved_asset_id, gen);
  assert.equal(m.totals.first_frames_approved, 1);
  assert.equal(m.shots[0].video.state, "planned", "the video slot is now allowed (not blocked) because the first frame is approved");
});
