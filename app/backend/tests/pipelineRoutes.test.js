// The whole AI pipeline through its web routes, on the real "Idea of an Idea"
// screenplay: shots -> text storyboard -> reference pictures -> shot pictures ->
// voices -> video -> assemble. Storage is the LOCAL MOCK of Google Drive and the
// AI service is the LOCAL MOCK of Gemini; ffmpeg is the real program.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import AdmZip from "adm-zip";
import express from "express";
import pg from "pg";
import { seedTestProject } from "../production.js";
import { analyzeScreenplay } from "../screenplayAnalysis.js";
import { ensureAllProductionSchemas } from "../productionSchema.js";
import { setupProductionMedia } from "../productionMedia.js";
import { registerPipelineRoutes } from "../pipelineRoutes.js";
import { createProviders } from "../providers.js";
import { startMockDrive } from "./mockDrive.js";
import { startMockGemini } from "./mockGemini.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-routes-"));
let drive, gemini, server, base, media, loggedIn = true, projectId, scenes;

const requireRole = () => (req, res, next) => (loggedIn ? ((req.user = { id: 1 }), next()) : res.status(401).json({ error: "Please log in." }));
const api = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const waitIdle = (pid = projectId) => until(async () => (await api("GET", `/api/production/${pid}/generations`)).json.generations.every((g) => g.status !== "running"), "generations to finish");
const shotsOf = async (n) => (await api("GET", `/api/production/${projectId}/shots?sceneId=${scenes[n]}`)).json.shots;

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  assert.deepEqual(await ensureAllProductionSchemas(db), []);
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'");
  await db.query("DELETE FROM production_drive_folders");
  await db.query("DELETE FROM production_drive_tokens");
  await db.query("INSERT INTO production_drive_tokens (access_token, refresh_token, expiry_date) VALUES ('test-token','r',$1)", [Date.now() + 3_600_000]);
  drive = await startMockDrive();
  gemini = await startMockGemini();
  const app = express();
  app.use(express.json());
  media = setupProductionMedia({
    app, db, requireRole, backendDir: tmp, frontendUrl: "http://front", redirectUri: "http://back/cb",
    env: { MEDIA_BACKEND: "gdrive", GOOGLE_CLIENT_ID: "cid" }, driveOverrides: { apiBase: drive.apiBase, uploadBase: drive.uploadBase },
  });
  registerPipelineRoutes(app, db, requireRole, {
    store: media.store,
    providers: createProviders({ env: { GEMINI_API_KEY: "test-key", GEMINI_API_BASE: gemini.base }, sleep: async () => {} }),
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  projectId = (await seedTestProject(db)).projectId;
  await analyzeScreenplay(db, projectId);
  scenes = Object.fromEntries((await db.query("SELECT scene_number, id FROM production_scenes WHERE project_id = $1", [projectId])).rows.map((r) => [r.scene_number, r.id]));
});
test.after(async () => {
  server.close();
  await drive.close();
  await gemini.close();
  await db.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("routes validate their input and need a login", async () => {
  assert.equal((await api("GET", "/api/production/abc/pipeline")).status, 400);
  assert.equal((await api("GET", "/api/production/999999/pipeline")).status, 404);
  assert.equal((await api("PATCH", `/api/production/${projectId}/settings`, { aspectRatio: "7:5" })).status, 400);
  assert.equal((await api("POST", `/api/production/${projectId}/generate`, { kind: "movie", targetIds: [1] })).status, 400);
  assert.equal((await api("POST", `/api/production/${projectId}/generate`, { kind: "character", targetIds: [] })).status, 400);
  assert.equal((await api("POST", `/api/production/${projectId}/scenes/${scenes[2]}/storyboard`, {})).status, 400); // no shots yet
  assert.equal((await api("POST", `/api/production/${projectId}/export`, {})).status, 409); // nothing to assemble
  loggedIn = false;
  assert.equal((await api("GET", `/api/production/${projectId}/pipeline`)).status, 401);
  assert.equal((await api("POST", `/api/production/${projectId}/generate`, { kind: "character", targetIds: [1] })).status, 401);
  loggedIn = true;
  const info = (await api("GET", `/api/production/${projectId}/pipeline`)).json;
  assert.equal(info.spend.limitUsd, 5);
  assert.equal(info.status.scenes, 12);
  assert.equal(info.providers.textAvailable, false);
});

test("steps 2-3 over the web: cut the scene, write and approve the storyboard", async () => {
  const cut = await api("POST", `/api/production/${projectId}/scenes/${scenes[2]}/divide`, {});
  assert.equal(cut.status, 200);
  assert.equal(cut.json.mode, "script");
  assert.equal(cut.json.shots.length, 8);
  assert.equal((await api("POST", `/api/production/${projectId}/scenes/${scenes[2]}/divide`, {})).status, 409);
  assert.equal((await api("POST", `/api/production/${projectId}/scenes/${scenes[2]}/storyboard/approve`, {})).status, 400); // no text yet
  const sb = await api("POST", `/api/production/${projectId}/scenes/${scenes[2]}/storyboard`, {});
  assert.equal(sb.json.written, 8);
  const edit = await api("PATCH", `/api/production/${projectId}/shots/${sb.json.shots[0].id}`, { expectedRevision: sb.json.shots[0].revision, edits: { durationSec: 3 } });
  assert.equal(edit.json.shot.durationSec, 3);
  assert.equal((await api("PATCH", `/api/production/${projectId}/shots/${sb.json.shots[0].id}`, { expectedRevision: 1, edits: { durationSec: 2 } })).status, 409);
  assert.equal((await api("POST", `/api/production/${projectId}/scenes/${scenes[2]}/storyboard/approve`, {})).json.approved, true);
  // a shot can be added, split, merged, deleted over the web too
  const added = await api("POST", `/api/production/${projectId}/scenes/${scenes[2]}/shots`, { description: "Extra insert", afterShotId: sb.json.shots[0].id });
  assert.equal(added.status, 201);
  assert.equal((await api("POST", `/api/production/${projectId}/shots/${added.json.shot.id}/split`, {})).json.shots.length, 2);
  assert.equal((await api("DELETE", `/api/production/${projectId}/shots/${added.json.shot.id}`)).json.deleted, true);
  const leftover = (await shotsOf(2)).find((s) => /continued/.test(s.description));
  assert.equal((await api("DELETE", `/api/production/${projectId}/shots/${leftover.id}`)).json.deleted, true);
  assert.equal((await shotsOf(2)).length, 8);
  await api("POST", `/api/production/${projectId}/scenes/${scenes[2]}/storyboard/approve`, {});
});

test("step 4 over the web: references for everyone in scene 2, characters before the rest, then approved", async () => {
  const shots = await shotsOf(2);
  const needed = new Map();
  for (const s of shots) for (const a of s.assets) if (["character", "location", "prop"].includes(a.kind)) needed.set(a.id, a);
  assert.ok(needed.size >= 4);
  const kinds = { character: "character", location: "environment", prop: "prop" };
  for (const kind of ["character", "prop", "environment"]) {
    const ids = [...needed.values()].filter((a) => kinds[a.kind] === kind).map((a) => a.id);
    if (ids.length === 0) continue;
    const r = await api("POST", `/api/production/${projectId}/generate`, { kind, targetIds: ids });
    assert.equal(r.status, 202);
    assert.equal(r.json.started.length, ids.length);
  }
  await waitIdle();
  const refs = (await api("GET", `/api/production/${projectId}/generations`)).json.generations;
  assert.equal(refs.length, needed.size);
  assert.ok(refs.every((g) => g.status === "ready"));
  for (const g of refs) assert.equal((await api("POST", `/api/production/${projectId}/generations/${g.id}/review`, { decision: "approve" })).json.generation.review, "approved");
  // the pictures come back through the app (never via a Drive link)
  const first = refs[0];
  const img = await fetch(`${base}${first.mediaUrl}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  // stored in the project's own folder, in the numbered folder, in an item sub-folder
  const row = (await db.query("SELECT * FROM production_media_files WHERE id = $1", [first.mediaId])).rows[0];
  const folderPath = drive.pathOf(row.storage_key);
  assert.match(folderPath, /^\[TEST\] Idea of an Idea[^/]* \/ 0[123] (Characters|Props|Environments) \/ (CHAR|PROP|LOC)\d+ /, folderPath);
});

test("step 5 over the web: a picture for every shot of scene 2, using the approved references", async () => {
  const shots = await shotsOf(2);
  gemini.state.requests.length = 0;
  const r = await api("POST", `/api/production/${projectId}/generate`, { kind: "keyframe", targetIds: shots.map((s) => s.id) });
  assert.equal(r.status, 202);
  assert.equal(r.json.started.length, 8);
  await waitIdle();
  const keyframeCalls = gemini.state.requests.filter((x) => x.path.endsWith(":generateContent"));
  assert.equal(keyframeCalls.length, 8);
  assert.ok(keyframeCalls.every((c) => c.body.contents[0].parts.filter((p) => p.inlineData).length >= 1), "every shot picture was drawn with reference pictures attached");
  const list = (await api("GET", `/api/production/${projectId}/generations?kind=keyframe`)).json.generations;
  assert.equal(list.length, 8);
  for (const g of list) await api("POST", `/api/production/${projectId}/generations/${g.id}/review`, { decision: "approve" });
  const row = (await db.query("SELECT * FROM production_media_files WHERE id = $1", [list[0].mediaId])).rows[0];
  assert.match(drive.pathOf(row.storage_key), / \/ 04 Shot images \/ SC002 \/ /);
});

test("steps 4-7 on scene 5 (dialogue): voices, shot pictures, one video take, then everything approved", async () => {
  const cut = await api("POST", `/api/production/${projectId}/scenes/${scenes[5]}/divide`, {});
  assert.equal(cut.json.shots.length, 3);
  await api("POST", `/api/production/${projectId}/scenes/${scenes[5]}/storyboard`, {});
  await api("POST", `/api/production/${projectId}/scenes/${scenes[5]}/storyboard/approve`, {});
  let shots = await shotsOf(5);
  // pictures need approved references, and say exactly which are missing
  const blocked = await api("POST", `/api/production/${projectId}/generate`, { kind: "keyframe", targetIds: [shots[0].id] });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /approved reference picture first/);
  const forced = await api("POST", `/api/production/${projectId}/generate`, { kind: "keyframe", targetIds: shots.map((s) => s.id), allowMissing: true });
  assert.equal(forced.status, 202);
  const lines = shots.flatMap((s) => s.dialogue);
  assert.equal(lines.length, 4);
  assert.equal((await api("POST", `/api/production/${projectId}/generate`, { kind: "audio", targetIds: lines.map((l) => l.id) })).status, 202);
  await waitIdle();
  for (const g of (await api("GET", `/api/production/${projectId}/generations?sceneId=${scenes[5]}`)).json.generations) {
    assert.equal(g.status, "ready", g.error);
    await api("POST", `/api/production/${projectId}/generations/${g.id}/review`, { decision: "approve" });
  }
  // video: only from an approved picture; the first take
  const take = await api("POST", `/api/production/${projectId}/generate`, { kind: "video", targetIds: [shots[0].id], durationSec: 4 });
  assert.equal(take.status, 202);
  await waitIdle();
  const video = (await api("GET", `/api/production/${projectId}/generations?kind=video&shotId=${shots[0].id}`)).json.generations[0];
  assert.equal(video.status, "ready", video.error);
  await api("POST", `/api/production/${projectId}/generations/${video.id}/review`, { decision: "approve" });
  const status = (await api("GET", `/api/production/${projectId}/pipeline`)).json.status;
  assert.equal(status.audio.approved, 4);
  assert.equal(status.video.approved, 1);
  assert.equal(status.keyframes.approved, 11);
  assert.ok((await api("GET", `/api/production/${projectId}/pipeline`)).json.spend.spentUsd > 1);
  shots = await shotsOf(5);
});

test("step 8 over the web: scene 5 is assembled into a real video with the voices, plus an edit package", async () => {
  const plan = (await api("GET", `/api/production/${projectId}/export/plan?sceneId=${scenes[5]}`)).json;
  assert.deepEqual([plan.shots, plan.usable, plan.gaps.length, plan.ffmpeg], [3, 3, 0, true]);
  const started = await api("POST", `/api/production/${projectId}/export`, { sceneId: scenes[5] });
  assert.equal(started.status, 202);
  assert.equal((await api("POST", `/api/production/${projectId}/export`, { sceneId: scenes[5] })).status, 409); // one at a time
  const done = await until(async () => {
    const e = (await api("GET", `/api/production/${projectId}/exports`)).json.exports[0];
    return e.status !== "running" ? e : null;
  }, "export", 60000);
  assert.equal(done.status, "ready", done.error);
  assert.equal(done.sceneCode, "SC005");
  assert.deepEqual([done.manifest.shots, done.manifest.used, done.manifest.gaps], [3, 3, []]);

  const video = await fetch(`${base}${done.videoUrl}`);
  assert.equal(video.status, 200);
  const file = path.join(tmp, "cut.mp4");
  fs.writeFileSync(file, Buffer.from(await video.arrayBuffer()));
  const probe = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file]).stdout.toString());
  assert.deepEqual(probe.streams.map((s) => s.codec_type).sort(), ["audio", "video"]);
  assert.equal(probe.streams.find((s) => s.codec_type === "video").width, 1280);
  // three shots of at least 4s each (the shots are longer than their pictures), plus the voices
  assert.ok(Number(probe.format.duration) >= 9, `duration ${probe.format.duration}`);

  const zipRes = await fetch(`${base}${done.packageUrl}`);
  assert.equal(zipRes.headers.get("content-disposition").startsWith("attachment"), true);
  const zip = new AdmZip(Buffer.from(await zipRes.arrayBuffer()));
  const names = zip.getEntries().map((e) => e.entryName);
  assert.ok(names.includes("manifest.json") && names.includes("shotlist.csv") && names.includes("README.txt"));
  assert.ok(names.filter((n) => n.startsWith("media/")).length >= 3 + 4);
  const csv = zip.readAsText("shotlist.csv");
  assert.match(csv, /^Scene,Shot,Code,Framing/);
  assert.equal(csv.trim().split("\n").length, 4);
  const row = (await db.query("SELECT * FROM production_media_files WHERE id = $1", [Number(done.videoUrl.split("/").pop())])).rows[0];
  assert.match(drive.pathOf(row.storage_key), / \/ 07 Exports \/ Rough cuts \/ /);
});

test("whole-project export lists what is still missing instead of hiding it", async () => {
  const plan = (await api("GET", `/api/production/${projectId}/export/plan`)).json;
  assert.equal(plan.shots, 11);
  assert.equal(plan.usable, 11);
  assert.ok(plan.gaps.length === 0 || plan.gaps.every((g) => /no approved/.test(g)));
  // scene 2 shots have pictures but their (absent) voices are not needed; scene 5 voices are all approved
  await api("POST", `/api/production/${projectId}/scenes/${scenes[3]}/divide`, {});
  const plan2 = (await api("GET", `/api/production/${projectId}/export/plan`)).json;
  assert.equal(plan2.shots, 11 + 6);
  assert.equal(plan2.gaps.filter((g) => /scene 3/.test(g)).length, 6);
});

test("money limit over the web: stops with a clear 402 and works again after raising it", async () => {
  const shots = await shotsOf(2);
  const set = await api("PATCH", `/api/production/${projectId}/settings`, { budgetLimitUsd: 0.01 });
  assert.equal(set.json.settings.effectiveBudgetUsd, 0.01);
  const r = await api("POST", `/api/production/${projectId}/generate`, { kind: "keyframe", targetIds: [shots[0].id] });
  assert.equal(r.status, 402);
  assert.equal(r.json.code, "over_budget");
  assert.match(r.json.error, /Raise the money limit/);
  await api("PATCH", `/api/production/${projectId}/settings`, { budgetLimitUsd: 50 });
  assert.equal((await api("POST", `/api/production/${projectId}/generate`, { kind: "keyframe", targetIds: [shots[0].id] })).status, 202);
  await waitIdle();
});
