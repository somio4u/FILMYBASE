// Phase 4: Video Studio (video only from an approved first frame, takes, canonical take, timeline) and Audio Studio
// (spoken lines tied to shots and cues, timing checks, sound-effect and music cues on their own tracks).
// MOCK: storage is the local imitation of Google Drive, the picture / voice / video models are the local imitation of Gemini.
// None of it proves the real Google models accept the same requests.
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
import { registerBlueprintRoutes, buildShotManifest } from "../blueprint.js";
import { approveBlueprint, planPrompts, registerPlanningRoutes } from "../planning.js";
import { getTimeline, registerTimelineRoutes } from "../timeline.js";
import { registerStudioRoutes } from "../studio.js";
import { registerAudioCueRoutes } from "../audioCues.js";
import { saveSettings } from "../pipelineSettings.js";
import { startMockDrive } from "./mockDrive.js";
import { startMockGemini, sinePcm } from "./mockGemini.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-studio-"));
let drive, gemini, server, base, pid, scene5, scene2;
const requireRole = () => (req, res, next) => ((req.user = { id: 1 }), next());
const api = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json };
};
const P = (s = "") => `/api/production/${pid}${s}`;
async function until(fn, what, ms = 25000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 50)); }
}
const idle = () => until(async () => (await api("GET", P("/generations"))).json.generations.every((g) => g.status !== "running"), "generations to finish");
// A WAV (the mock voice returns PCM wrapped as .wav by the real provider code) is enough for the cue upload tests.
function wav(seconds = 1) {
  const pcm = sinePcm(seconds);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
async function approveRefsAndFrame(sceneDb) {
  const slots = (await api("GET", P(`/studio/frames?sceneId=${sceneDb}`))).json.slots;
  const need = [...new Set(slots.flatMap((s) => s.dependencies.map((d) => d.code)))];
  const lib = [];
  for (const t of ["character", "environment", "property"]) lib.push(...(await api("GET", P(`/studio/assets?type=${t}`))).json.assets);
  const kindOf = { character: "character", environment: "environment", prop: "prop", other: "prop" };
  for (const a of lib.filter((x) => need.includes(x.assetId))) {
    await api("POST", P("/generate"), { kind: kindOf[a.type], targetIds: [a.dbId] });
    await idle();
    await api("POST", P(`/generations/${(await api("GET", P(`/generations?assetId=${a.dbId}`))).json.generations[0].id}/review`), { decision: "approve" });
  }
  await api("POST", P("/generate"), { kind: "keyframe", targetIds: slots.map((s) => s.dbId) });
  await idle();
  const frames = [];
  for (const s of slots) {
    const g = (await api("GET", P(`/generations?shotId=${s.dbId}&kind=keyframe`))).json.generations[0];
    await api("POST", P(`/generations/${g.id}/review`), { decision: "approve" });
    frames.push(g.id);
  }
  return slots;
}

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
  app.use(express.json({ limit: "10mb" }));
  registerEventRoutes(app, db, requireRole, { heartbeatMs: 60000 });
  const media = setupProductionMedia({ app, db, requireRole, backendDir: tmp, frontendUrl: "http://front", redirectUri: "http://back/cb", env: { MEDIA_BACKEND: "gdrive", GOOGLE_CLIENT_ID: "cid" }, driveOverrides: { apiBase: drive.apiBase, uploadBase: drive.uploadBase } });
  registerBlueprintRoutes(app, db, requireRole);
  registerPlanningRoutes(app, db, requireRole);
  registerStudioRoutes(app, db, requireRole);
  registerTimelineRoutes(app, db, requireRole);
  registerAudioCueRoutes(app, db, requireRole, { store: media.store });
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
  scene5 = scenes.find((s) => s.scene_number === "5").id;
  scene2 = scenes.find((s) => s.scene_number === "2").id;
  await planPrompts(db, pid);
  await approveBlueprint(db, pid);
});
test.after(async () => { server.close(); await drive.close(); await gemini.close(); await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'"); await db.end(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("Video Studio: every planned shot has a video slot with its stored video prompt and target length; video is blocked until the first frame is approved", async () => {
  const r = (await api("GET", P(`/studio/video?sceneId=${scene5}`))).json;
  const shots = await listShots(db, pid, { sceneId: scene5 });
  assert.equal(r.slots.length, shots.length);
  for (const s of r.slots) {
    assert.match(s.prompt.text, /Start exactly from the given picture/);
    assert.ok([4, 6, 8].includes(s.targetSeconds));
    assert.equal(s.state, "blocked");
    assert.equal(s.readiness.ok, false);
    assert.match(s.readiness.reason, /first frame/);
    assert.equal(s.firstFrame, null);
    assert.ok(s.estimateUsd > 0);
  }
  assert.equal(r.counts.readyToMake, 0);
  const refused = await api("POST", P("/generate"), { kind: "video", targetIds: [r.slots[0].dbId] });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /needs an approved picture first/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_generations WHERE project_id = $1 AND kind = 'video'", [pid])).rows[0].n, 0);
  const scenes = (await api("GET", P("/studio/video/scenes"))).json.scenes;
  assert.equal(scenes.length, 12);
  assert.equal((await api("GET", P("/studio/video"))).status, 400);
});

test("video comes only from an approved first frame, never automatically after an image; takes wait for review, one approved take drives the timeline", async () => {
  const slots = await approveRefsAndFrame(scene5);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_generations WHERE project_id = $1 AND kind = 'video'", [pid])).rows[0].n, 0, "approving every first frame started no video by itself");
  const v0 = (await api("GET", P(`/studio/video?sceneId=${scene5}`))).json;
  assert.equal(v0.counts.readyToMake, slots.length);
  assert.ok(v0.counts.estimateUsd > 0);
  assert.ok(v0.slots.every((s) => s.firstFrame?.mediaUrl && s.state === "planned"));
  const target = v0.slots[0];
  const go = await api("POST", P("/generate"), { kind: "video", targetIds: [target.dbId], durationSec: 4 });
  assert.equal(go.status, 202);
  await idle();
  let s1 = (await api("GET", P(`/studio/video?sceneId=${scene5}`))).json.slots[0];
  assert.equal(s1.state, "ready_for_review");
  assert.equal(s1.canonical, null);
  assert.equal(s1.latestReady.seconds, 4);
  assert.equal(s1.latestReady.promptCurrent, true);
  let clip = (await getTimeline(db, pid)).clips.find((c) => c.shotId === target.dbId);
  assert.equal(clip.state, "first_frame", "an unapproved take does not replace the first frame on the timeline");
  assert.equal(clip.reviewNeeded.video, 1);
  const take1 = s1.latestReady.id;
  await api("POST", P(`/generations/${take1}/review`), { decision: "approve" });
  clip = (await getTimeline(db, pid)).clips.find((c) => c.shotId === target.dbId);
  assert.equal(clip.state, "video");
  assert.equal(clip.media.type, "video");
  assert.equal(clip.media.generationId, take1);
  assert.equal(clip.sourceDurationMs, 4000);
  assert.equal(clip.frame.generationId, v0.slots[0].firstFrame.id, "the approved first frame stays reachable under the video");
  // a second take to compare: it waits; the approved one stays
  await api("POST", P("/generate"), { kind: "video", targetIds: [target.dbId], durationSec: 6 });
  await idle();
  s1 = (await api("GET", P(`/studio/video?sceneId=${scene5}`))).json.slots[0];
  assert.equal(s1.canonical.id, take1);
  assert.equal(s1.latestReady.seconds, 6);
  await api("POST", P(`/generations/${s1.latestReady.id}/review`), { decision: "approve" });
  s1 = (await api("GET", P(`/studio/video?sceneId=${scene5}`))).json.slots[0];
  assert.equal(s1.canonical.seconds, 6);
  assert.equal(s1.history.length, 1);
  assert.equal((await getTimeline(db, pid)).clips.find((c) => c.shotId === target.dbId).sourceDurationMs, 6000);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_generations WHERE project_id = $1 AND shot_id = $2 AND kind = 'video'", [pid, target.dbId])).rows[0].n, 2, "both takes kept");
  // only that shot has a video
  assert.equal((await getTimeline(db, pid)).summary.videos, 1);
});

test("a video take made from a first frame that was later replaced is flagged out of date; the money limit is checked before every video", async () => {
  const slots = await approveRefsAndFrame(scene5);
  const t = slots[0];
  await api("POST", P("/generate"), { kind: "video", targetIds: [t.dbId] });
  await idle();
  const take = (await api("GET", P(`/studio/video?sceneId=${scene5}`))).json.slots[0].latestReady.id;
  await api("POST", P(`/generations/${take}/review`), { decision: "approve" });
  // a new first frame is approved afterwards
  await api("POST", P("/generate"), { kind: "keyframe", targetIds: [t.dbId] });
  await idle();
  const newer = (await api("GET", P(`/generations?shotId=${t.dbId}&kind=keyframe`))).json.generations[0];
  await api("POST", P(`/generations/${newer.id}/review`), { decision: "approve" });
  const s = (await api("GET", P(`/studio/video?sceneId=${scene5}`))).json.slots[0];
  assert.equal(s.canonical.outdated, true);
  assert.equal(s.stale, true);
  assert.equal(s.canonical.id, take, "nothing was deleted or replaced");
  await saveSettings(db, pid, { budgetLimitUsd: 0.2 });
  const over = await api("POST", P("/generate"), { kind: "video", targetIds: [slots[1].dbId], durationSec: 8 });
  assert.equal(over.status, 402);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_generations WHERE project_id = $1 AND kind = 'video' AND shot_id = $2", [pid, slots[1].dbId])).rows[0].n, 0);
});

test("Audio Studio: every spoken line shows its speaker, shot, voice and stored instruction; a made voice waits for review, an approved voice goes to the dialogue track", async () => {
  const r = (await api("GET", P(`/studio/audio?sceneId=${scene5}`))).json;
  assert.ok(r.lines.length >= 3);
  const line = r.lines[0];
  assert.match(line.lineId, /^D\d+$/);
  assert.ok(line.speaker && line.text);
  assert.match(line.shotId, /^SC005_SH\d+$/);
  assert.ok(line.voice, "one steady voice per speaker");
  assert.equal(line.state, "planned");
  assert.equal(line.prompt.stale, false);
  assert.equal(new Set(r.lines.filter((l) => l.speaker === line.speaker).map((l) => l.voice)).size, 1, "a speaker keeps one voice");
  const go = await api("POST", P("/generate"), { kind: "audio", targetIds: [line.dbId] });
  assert.equal(go.status, 202);
  await idle();
  let a = (await api("GET", P(`/studio/audio?sceneId=${scene5}`))).json.lines[0];
  assert.equal(a.state, "ready_for_review");
  assert.equal(a.canonical, null);
  assert.ok(a.latestReady.durationMs > 0);
  assert.equal((await getTimeline(db, pid)).clips.find((c) => c.elementId === line.dbId).state, "planned");
  await api("POST", P(`/generations/${a.latestReady.id}/review`), { decision: "approve" });
  a = (await api("GET", P(`/studio/audio?sceneId=${scene5}`))).json.lines[0];
  assert.equal(a.state, "approved");
  assert.equal(a.canonical.id > 0, true);
  const tl = await getTimeline(db, pid);
  const dc = tl.clips.find((c) => c.elementId === line.dbId);
  assert.equal(dc.state, "audio");
  assert.equal(tl.tracks.find((t) => t.id === dc.trackId).name, "A1");
  assert.equal(dc.sourceDurationMs, a.canonical.durationMs);
  // the audio instruction is linked: the media row points at the audio prompt version
  assert.ok((await db.query("SELECT prompt_id FROM production_generations WHERE id = $1", [a.canonical.id])).rows[0].prompt_id);
  assert.equal(r.counts.lines, r.lines.length);
});

test("Audio Studio flags a voice that runs past the end of its shot, and says plainly that video is not lip-synced", async () => {
  const lines = (await api("GET", P(`/studio/audio?sceneId=${scene5}`))).json.lines;
  const line = lines[0];
  const g = (await db.query("INSERT INTO production_generations (project_id, kind, element_id, version, status, review, prompt, duration_ms) VALUES ($1,'audio',$2,1,'ready','approved','p',60000) RETURNING id", [pid, line.dbId])).rows[0].id;
  const a = (await api("GET", P(`/studio/audio?sceneId=${scene5}`))).json;
  const flagged = a.lines.find((l) => l.dbId === line.dbId);
  assert.equal(flagged.timing.fits, false);
  assert.ok(flagged.timing.overflowMs > 0);
  assert.equal(a.counts.overflowing, 1);
  const shotWithCloseUp = a.lines.find((l) => l.lipSync);
  void g; void shotWithCloseUp;
  const closeUps = (await db.query("SELECT count(*)::int AS n FROM production_shots s JOIN production_shot_dialogue sd ON sd.shot_id = s.id WHERE s.scene_id = $1 AND s.framing ILIKE '%close%'", [scene5])).rows[0].n;
  assert.equal(a.lines.filter((l) => l.lipSync).length > 0, closeUps > 0);
  if (closeUps > 0) assert.match(a.lines.find((l) => l.lipSync).lipSync, /not lip-synced/);
});

test("Audio Studio scenes list only scenes that have spoken lines, with approved counts", async () => {
  const scenes = (await api("GET", P("/studio/audio/scenes"))).json.scenes;
  assert.ok(scenes.length >= 3 && scenes.length < 12);
  assert.ok(scenes.every((s) => s.lines > 0));
  assert.equal(scenes.reduce((n, s) => n + s.lines, 0), 17);
});

test("sound-effect and music cues: planned on the shot, appear on their own timeline tracks, need an attached file and approval; no generator pretends to exist", async () => {
  const shot = (await listShots(db, pid, { sceneId: scene2 }))[1];
  const list0 = (await api("GET", P("/audio-cues"))).json;
  assert.deepEqual(list0.cues, []);
  assert.match(list0.generator.note, /No sound-effect or music generator is configured/);
  assert.equal((await api("POST", P("/audio-cues"), { kind: "foley", label: "x" })).status, 400);
  assert.equal((await api("POST", P("/audio-cues"), { kind: "sfx", label: "  " })).status, 400);
  assert.equal((await api("POST", P("/audio-cues"), { kind: "sfx", label: "Door", shotId: 999999 })).status, 400);
  const sfx = (await api("POST", P("/audio-cues"), { kind: "sfx", label: "Door slam", prompt: "A heavy wooden door slams shut", shotId: shot.id, offsetMs: 500, durationMs: 1200 })).json.cue;
  const music = (await api("POST", P("/audio-cues"), { kind: "music", label: "Tense strings", prompt: "Low tense strings, building", shotId: shot.id, durationMs: 3000 })).json.cue;
  assert.equal(sfx.state, "planned");
  assert.equal(sfx.shotId, `SC002_${shot.code}`);
  let tl = await getTimeline(db, pid);
  const shotClip = tl.clips.find((c) => c.kind === "shot" && c.shotId === shot.id);
  const sc = tl.clips.find((c) => c.cueId === sfx.id);
  const mc = tl.clips.find((c) => c.cueId === music.id);
  assert.equal(tl.tracks.find((t) => t.id === sc.trackId).name, "A2");
  assert.equal(tl.tracks.find((t) => t.id === mc.trackId).name, "A3");
  assert.equal(sc.startMs, shotClip.startMs + 500, "starts inside its shot, at the offset");
  assert.equal(sc.durationMs, 1200);
  assert.equal(sc.state, "planned");
  assert.equal(tl.summary.cuesPlanned, 2);
  // approving without a file is refused
  assert.equal((await api("POST", P(`/audio-cues/${sfx.id}/approval`), { approved: true })).status, 409);
  // attach a real (generated) wav, then it waits for approval
  assert.equal((await api("POST", P(`/audio-cues/${sfx.id}/media`), { filename: "door.exe", dataBase64: wav().toString("base64") })).status, 400);
  assert.equal((await api("POST", P(`/audio-cues/${sfx.id}/media`), { filename: "door.wav", dataBase64: "AAAA" })).status, 400);
  const up = await api("POST", P(`/audio-cues/${sfx.id}/media`), { filename: "door.wav", dataBase64: wav(1).toString("base64") });
  assert.equal(up.status, 200);
  assert.equal(up.json.cue.state, "ready_for_review");
  tl = await getTimeline(db, pid);
  assert.equal(tl.clips.find((c) => c.cueId === sfx.id).state, "planned", "attached but not approved: the timeline slot is unchanged");
  assert.equal(tl.clips.find((c) => c.cueId === sfx.id).reviewNeeded.audio, 1);
  const seen = [];
  const off = subscribe(pid, (e) => seen.push(e));
  const ok = await api("POST", P(`/audio-cues/${sfx.id}/approval`), { approved: true });
  assert.equal(ok.json.cue.state, "approved");
  assert.ok(seen.some((e) => e.type === "media_review" && e.cueId === sfx.id), "live sync is told");
  off();
  tl = await getTimeline(db, pid);
  const done = tl.clips.find((c) => c.cueId === sfx.id);
  assert.equal(done.state, "audio");
  assert.match(done.media.url, /^\/api\/production\/media\/\d+$/);
  assert.equal(tl.summary.cues, 1);
  assert.equal(tl.summary.cuesPlanned, 1);
  // moving the cue or its shot moves the clip; deleting removes it; a re-approved Blueprint keeps the cue clips
  await api("PATCH", P(`/audio-cues/${sfx.id}`), { offsetMs: 900 });
  assert.equal((await getTimeline(db, pid)).clips.find((c) => c.cueId === sfx.id).startMs, shotClip.startMs + 900);
  await api("POST", P("/blueprint/reopen"), {}); await planPrompts(db, pid);
  for (const s of (await db.query("SELECT id FROM production_scenes WHERE project_id = $1", [pid])).rows) await approveShots(db, pid, s.id, { approved: true });
  await approveBlueprint(db, pid);
  assert.equal((await getTimeline(db, pid)).clips.filter((c) => c.cueId === sfx.id).length, 1, "no duplicate cue clip after the Blueprint is approved again");
  assert.equal((await api("DELETE", P(`/audio-cues/${music.id}`))).json.deleted, true);
  assert.equal((await getTimeline(db, pid)).clips.some((c) => c.cueId === music.id), false);
  assert.equal((await api("DELETE", P(`/audio-cues/${music.id}`))).status, 404);
});

test("a cue made before the Blueprint is approved still gets its timeline clip when the timeline is created", async () => {
  await db.query("DELETE FROM production_timelines WHERE project_id = $1", [pid]);
  await db.query("UPDATE production_blueprints SET status = 'superseded' WHERE project_id = $1", [pid]);
  const shot = (await listShots(db, pid, { sceneId: scene2 }))[0];
  const cue = (await api("POST", P("/audio-cues"), { kind: "music", label: "Opening theme", shotId: shot.id })).json.cue;
  assert.equal((await getTimeline(db, pid)).exists, false, "no timeline yet, and creating a cue did not invent one");
  await approveBlueprint(db, pid);
  assert.ok((await getTimeline(db, pid)).clips.some((c) => c.cueId === cue.id));
});

test("everything stays out of other projects: cues, studio slots and timeline", async () => {
  const other = (await db.query("INSERT INTO ai_movie_projects (pasted_text, title) VALUES ('x','[TEST] Idea of an Idea other') RETURNING id")).rows[0].id;
  await api("POST", P("/audio-cues"), { kind: "sfx", label: "mine" });
  assert.deepEqual((await api("GET", `/api/production/${other}/audio-cues`)).json.cues, []);
  assert.deepEqual((await api("GET", `/api/production/${other}/studio/video?sceneId=${scene5}`)).json.slots, []);
  assert.equal((await api("PATCH", `/api/production/${other}/audio-cues/1`, { label: "x" })).status, 404);
  assert.equal((await buildShotManifest(db, other)).shots.length, 0);
});
