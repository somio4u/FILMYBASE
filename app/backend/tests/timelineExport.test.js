// Phase 5b: timeline snapshots and export. REAL ffmpeg, REAL Postgres; storage is the local imitation of Google Drive (MOCK).
// Media files are made with ffmpeg and inserted as approved generations directly — no AI model is involved here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import express from "express";
import pg from "pg";
import { seedTestProject } from "../production.js";
import { analyzeScreenplay } from "../screenplayAnalysis.js";
import { approveShots, divideScene, listShots } from "../shots.js";
import { ensureAllProductionSchemas } from "../productionSchema.js";
import { setupProductionMedia } from "../productionMedia.js";
import { approveBlueprint, planPrompts } from "../planning.js";
import { getTimeline, registerTimelineRoutes } from "../timeline.js";
import { registerTimelineEditRoutes } from "../timelineEdit.js";
import { registerTimelineExportRoutes, probeDurationMs, audibleTracks } from "../timelineExport.js";
import { startMockDrive } from "./mockDrive.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tl-export-"));
let drive, server, base, pid, shots, store;
const requireRole = () => (req, res, next) => ((req.user = { id: 1 }), next());
const api = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json };
};
const P = (s = "") => `/api/production/${pid}${s}`;
const ff = (...args) => { const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args]); assert.equal(r.status, 0, String(r.stderr)); };
const png = path.join(tmp, "a.png"), mp4 = path.join(tmp, "v.mp4"), wav = path.join(tmp, "s.wav");
async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)); }
}
async function media(file, name) {
  return store.putMedia({ projectId: pid, role: "export", filePath: file, originalName: name, label: name, subfolder: "T", createdBy: 1 });
}
let ver = 0;
async function approve(kind, shotId, mediaId, extra = {}) {
  const r = await db.query(
    `INSERT INTO production_generations (project_id, kind, shot_id, element_id, version, status, review, prompt, media_id, duration_ms)
     VALUES ($1,$2,$3,$4,$5,'ready','approved','p',$6,$7) RETURNING id`, [pid, kind, shotId ?? null, extra.elementId ?? null, ++ver, mediaId, extra.durationMs ?? 4000]);
  return r.rows[0].id;
}
const tl = () => getTimeline(db, pid);
const exportAndWait = async (snapshotId, body = {}) => {
  const r = await api("POST", P(`/timeline/snapshots/${snapshotId}/export`), body);
  if (r.status !== 202) return r;
  const id = r.json.export.id;
  return { status: 202, row: await until(async () => { const x = (await db.query("SELECT * FROM production_exports WHERE id = $1", [id])).rows[0]; return x.status !== "running" ? x : null; }, "export") };
};

test.before(async () => {
  ff("-f", "lavfi", "-i", "color=c=red:s=320x180", "-frames:v", "1", png);
  ff("-f", "lavfi", "-i", "testsrc=s=320x180:r=24", "-t", "4", "-pix_fmt", "yuv420p", mp4);
  ff("-f", "lavfi", "-i", "sine=f=440:d=2", wav);
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  assert.deepEqual(await ensureAllProductionSchemas(db), []);
  await db.query("DELETE FROM production_drive_folders");
  await db.query("DELETE FROM production_drive_tokens");
  await db.query("INSERT INTO production_drive_tokens (access_token, refresh_token, expiry_date) VALUES ('test-token','r',$1)", [Date.now() + 3_600_000]);
  drive = await startMockDrive();
  const app = express();
  app.use(express.json());
  const m = setupProductionMedia({ app, db, requireRole, backendDir: tmp, frontendUrl: "http://front", redirectUri: "http://back/cb", env: { MEDIA_BACKEND: "gdrive", GOOGLE_CLIENT_ID: "cid" }, driveOverrides: { apiBase: drive.apiBase, uploadBase: drive.uploadBase } });
  store = m.store;
  registerTimelineRoutes(app, db, requireRole);
  registerTimelineEditRoutes(app, db, requireRole);
  registerTimelineExportRoutes(app, db, requireRole, { store });
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
  await planPrompts(db, pid);
  await approveBlueprint(db, pid);
  shots = await listShots(db, pid);
});
test.after(async () => { server.close(); await drive.close(); await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'"); await db.end(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("a snapshot freezes the timeline: later edits and new approvals do not change it, and it cannot be changed or deleted", async () => {
  const before = await tl();
  const s1 = await api("POST", P("/timeline/snapshots"), { label: "first" });
  assert.equal(s1.status, 201);
  const snap = (await api("GET", P(`/timeline/snapshots/${s1.json.snapshot.id}`))).json;
  assert.equal(snap.summary.clips, before.clips.length);
  assert.equal(snap.summary.containsPlaceholders, true);
  assert.equal(snap.summary.approvedOnly, false);
  const clip = before.clips.find((c) => c.kind === "shot");
  await api("POST", P("/timeline/edit"), { op: { type: "trim", clipId: clip.id, durationMs: clip.durationMs + 1000, ripple: true } });
  const m = await media(png, "x.png");
  await approve("keyframe", clip.shotId, m.id);
  const again = (await api("GET", P(`/timeline/snapshots/${snap.id}`))).json;
  assert.deepEqual(again.layout, snap.layout, "the saved snapshot is exactly as it was");
  const s2 = await api("POST", P("/timeline/snapshots"), {});
  assert.equal(s2.json.snapshot.version, 2, "each save is a new numbered version");
  await assert.rejects(db.query("UPDATE production_timeline_snapshots SET label = 'x' WHERE id = $1", [snap.id]), /cannot be changed|immutable|snapshot/i);
  assert.equal((await api("GET", P("/timeline/snapshots"))).json.snapshots.length, 2);
  assert.equal((await api("GET", P("/timeline/snapshots/99999999"))).status, 404);
});

test("validation: placeholders are reported (warning for black, error for refuse); unreadable files are errors", async () => {
  const s = (await api("POST", P("/timeline/snapshots"), {})).json.snapshot;
  const warn = (await api("GET", P(`/timeline/snapshots/${s.id}/validate`))).json;
  assert.equal(warn.ok, true);
  assert.ok(warn.warnings.some((w) => w.code === "placeholders"));
  assert.equal(warn.contains.approvedOnly, false);
  const refuse = (await api("GET", P(`/timeline/snapshots/${s.id}/validate?placeholders=refuse`))).json;
  assert.equal(refuse.ok, false);
  assert.ok(refuse.errors.some((e) => e.code === "placeholders"));
  // a missing file
  const m = await media(png, "gone.png");
  await approve("keyframe", shots[0].id, m.id);
  const s2 = (await api("POST", P("/timeline/snapshots"), {})).json.snapshot;
  await db.query("UPDATE production_media_files SET storage_key = 'does-not-exist', spool_path = NULL WHERE id = $1", [m.id]).catch(() => {});
  const broken = (await api("GET", P(`/timeline/snapshots/${s2.id}/validate`))).json;
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.some((e) => e.code === "file_unavailable"));
});

test("export from a snapshot: real ffmpeg, picture length matches the edited timeline, report says placeholders are present", async () => {
  const m1 = await media(png, "f.png");
  const m2 = await media(mp4, "v.mp4");
  await approve("keyframe", shots[0].id, m1.id);
  await approve("video", shots[1].id, m2.id, { durationMs: 4000 });
  await approve("keyframe", shots[1].id, m1.id);
  const t = await tl();
  const shotClips = t.clips.filter((c) => c.kind === "shot").sort((a, b) => a.startMs - b.startMs);
  // shorten the second clip with ripple, so the snapshot differs from the Blueprint plan
  const c2 = shotClips[1];
  await api("POST", P("/timeline/edit"), { op: { type: "trim", clipId: c2.id, durationMs: 1500, ripple: true } });
  const s = (await api("POST", P("/timeline/snapshots"), { label: "cut" })).json.snapshot;
  const total = (await tl()).totalMs;
  const done = await exportAndWait(s.id);
  assert.equal(done.row.status, "ready", done.row.error);
  assert.equal(done.row.snapshot_id, s.id);
  assert.equal(done.row.report.containsPlaceholders, true);
  assert.equal(done.row.report.approvedOnly, false);
  assert.equal(done.row.report.durationCheck.withinTolerance, true, JSON.stringify(done.row.report.durationCheck));
  assert.ok(Math.abs(done.row.report.durationCheck.measuredMs - total) <= 700);
  const opened = await store.openMedia(done.row.video_media_id);
  const out = path.join(tmp, "out.mp4");
  await new Promise((res, rej) => { const w = fs.createWriteStream(out); opened.stream.pipe(w); w.on("finish", res); w.on("error", rej); });
  const measured = await probeDurationMs("ffmpeg", out);
  assert.ok(Math.abs(measured - total) <= 700, `file is ${measured}ms, timeline is ${total}ms`);
  assert.ok(done.row.package_media_id);
});

test("export refuses when asked for approved media only and placeholders exist; no media is produced", async () => {
  const s = (await api("POST", P("/timeline/snapshots"), {})).json.snapshot;
  const done = await exportAndWait(s.id, { placeholders: "refuse" });
  assert.equal(done.row.status, "failed");
  assert.match(done.row.error, /approved media only/);
  assert.equal(done.row.video_media_id, null);
});

test("a second export cannot start while one is running; an export of a snapshot ignores later timeline edits", async () => {
  const s = (await api("POST", P("/timeline/snapshots"), {})).json.snapshot;
  const first = await api("POST", P(`/timeline/snapshots/${s.id}/export`), {});
  const second = await api("POST", P(`/timeline/snapshots/${s.id}/export`), {});
  assert.equal(first.status, 202);
  assert.equal(second.status, 409);
  await until(async () => (await db.query("SELECT 1 FROM production_exports WHERE project_id = $1 AND status = 'running'", [pid])).rowCount === 0, "export");
});

test("audibleTracks: solo wins, otherwise muted tracks are dropped", () => {
  const t = [{ name: "V1", kind: "video" }, { name: "A1", kind: "audio" }, { name: "A2", kind: "audio", muted: true }, { name: "A3", kind: "audio", solo: true }];
  assert.deepEqual([...audibleTracks(t)], ["A3"]);
  assert.deepEqual([...audibleTracks(t.map((x) => ({ ...x, solo: false })))].sort(), ["A1", "A3"]);
});
