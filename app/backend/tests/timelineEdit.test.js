// Phase 5a: timeline editing. Real Postgres; no AI or media storage involved (generations are plain rows).
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { seedTestProject } from "../production.js";
import { analyzeScreenplay } from "../screenplayAnalysis.js";
import { approveShots, divideScene, listShots } from "../shots.js";
import { ensureAllProductionSchemas } from "../productionSchema.js";
import { registerEventRoutes, subscribe } from "../events.js";
import { approveBlueprint, planPrompts, reopenBlueprint } from "../planning.js";
import { getTimeline, registerTimelineRoutes } from "../timeline.js";
import { applyEdit, editHistory, redoEdit, registerTimelineEditRoutes, undoEdit, HISTORY_LIMIT, MIN_CLIP_MS } from "../timelineEdit.js";
import { registerAudioCueRoutes } from "../audioCues.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let server, base, pid, shots;
const requireRole = () => (req, res, next) => ((req.user = { id: 1 }), next());
const api = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json };
};
const P = (s = "") => `/api/production/${pid}${s}`;
const edit = (op, extra = {}) => api("POST", P("/timeline/edit"), { op, ...extra });
const tl = () => getTimeline(db, pid);
const v1 = async () => (await tl()).clips.filter((c) => c.kind === "shot" && !c.orphaned).sort((a, b) => a.startMs - b.startMs || a.part - b.part);
const snapshot = async () => JSON.stringify((await tl()).clips.map((c) => [c.id, c.trackId, c.startMs, c.durationMs, c.sourceInMs, c.part, c.takeOverride, c.shotId]));

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  assert.deepEqual(await ensureAllProductionSchemas(db), []);
  const app = express();
  app.use(express.json());
  registerEventRoutes(app, db, requireRole, { heartbeatMs: 60000 });
  registerTimelineRoutes(app, db, requireRole);
  registerTimelineEditRoutes(app, db, requireRole);
  registerAudioCueRoutes(app, db, requireRole, { store: null });
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
test.after(async () => { server.close(); await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'"); await db.end(); });

test("trim with ripple: the clip changes length and EVERYTHING after it, on every track, moves by the same amount; planned length and source are untouched", async () => {
  const before = await tl();
  const clips = await v1();
  const c = clips[3];
  const later = before.clips.filter((x) => x.startMs >= c.startMs + c.durationMs);
  const r = await edit({ type: "trim", clipId: c.id, durationMs: c.durationMs + 2500, ripple: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.moved, later.length);
  const after = await tl();
  const trimmed = after.clips.find((x) => x.id === c.id);
  assert.equal(trimmed.durationMs, c.durationMs + 2500);
  assert.equal(trimmed.plannedDurationMs, c.plannedDurationMs, "the Shot Cutter's planned length is kept");
  assert.equal(trimmed.edited, true);
  for (const l of later) assert.equal(after.clips.find((x) => x.id === l.id).startMs, l.startMs + 2500);
  assert.equal(after.totalMs, before.totalMs + 2500);
  const earlier = before.clips.filter((x) => x.startMs < c.startMs + c.durationMs && x.id !== c.id);
  for (const e of earlier) assert.equal(after.clips.find((x) => x.id === e.id).startMs, e.startMs, "nothing before the edit moves");
  // shortening pulls them back
  await edit({ type: "trim", clipId: c.id, durationMs: c.durationMs, ripple: true });
  assert.equal((await tl()).totalMs, before.totalMs);
});

test("trim without ripple: shortening leaves a gap and moves nothing; lengthening into the next clip is refused with a plain reason", async () => {
  const clips = await v1();
  const c = clips[2];
  const next = clips[3];
  const total = (await tl()).totalMs;
  const shorter = await edit({ type: "trim", clipId: c.id, durationMs: c.durationMs - 1000, ripple: false });
  assert.equal(shorter.status, 200);
  assert.equal(shorter.json.moved, 0);
  let t = await tl();
  assert.equal(t.clips.find((x) => x.id === next.id).startMs, next.startMs, "the next clip did not move — there is now a 1 s gap");
  assert.equal(t.totalMs, total);
  // growing back by 1 s fits the gap; growing by 1.5 s would hit the next clip
  assert.equal((await edit({ type: "trim", clipId: c.id, durationMs: c.durationMs, ripple: false })).status, 200);
  const clash = await edit({ type: "trim", clipId: c.id, durationMs: c.durationMs + 1500, ripple: false });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.code, "overlap");
  assert.match(clash.json.error, /would run into/);
  assert.equal((await edit({ type: "trim", clipId: c.id, durationMs: c.durationMs + 1500 })).json.code, "ripple_required", "ripple is never assumed");
  assert.equal((await edit({ type: "trim", clipId: c.id, durationMs: 50, ripple: true })).status, 400);
  assert.equal((await edit({ type: "trim", clipId: c.id, durationMs: 4000.5, ripple: true })).status, 400);
  assert.equal((await edit({ type: "trim", clipId: 999999, durationMs: 4000, ripple: true })).status, 404);
  assert.equal((await edit({ type: "levitate" })).status, 400);
  void t;
});

test("source duration stays separate: a clip trimmed longer than its source is FLAGGED, not rewritten; slip changes only where it starts in the source", async () => {
  const c = (await v1())[0];
  const g = (await db.query("INSERT INTO production_generations (project_id, kind, shot_id, version, status, review, prompt, params) VALUES ($1,'video',$2,1,'ready','approved','p',$3) RETURNING id", [pid, c.shotId, JSON.stringify({ seconds: 4 })])).rows[0].id;
  let clip = (await v1())[0];
  assert.equal(clip.sourceDurationMs, 4000);
  assert.equal(clip.flags.sourceTooShort, false);
  await edit({ type: "trim", clipId: c.id, durationMs: 6000, ripple: true });
  clip = (await v1())[0];
  assert.equal(clip.durationMs, 6000);
  assert.equal(clip.sourceDurationMs, 4000, "the file's own length is never changed by an edit");
  assert.equal(clip.plannedDurationMs, Math.round(shots[0].durationSec * 1000));
  assert.equal(clip.flags.sourceTooShort, true, "flagged: the timeline asks for more than the source has");
  await edit({ type: "slip", clipId: c.id, sourceInMs: 1500 });
  clip = (await v1())[0];
  assert.equal(clip.sourceInMs, 1500);
  assert.equal(clip.startMs, c.startMs, "slip does not move the clip");
  void g;
});

test("split: one shot becomes two back-to-back parts sharing the source; total length is unchanged; re-approving the Blueprint does not duplicate or undo the split", async () => {
  const c = (await v1())[1];
  const total = (await tl()).totalMs;
  assert.equal((await edit({ type: "split", clipId: c.id, atMs: c.startMs + 50 })).status, 400, "too close to the edge");
  assert.equal((await edit({ type: "split", clipId: c.id, atMs: c.startMs + c.durationMs + 5 })).status, 400);
  const r = await edit({ type: "split", clipId: c.id, atMs: c.startMs + 1000 });
  assert.equal(r.status, 200);
  const parts = (await v1()).filter((x) => x.shotId === c.shotId);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => p.part), [0, 1]);
  assert.equal(parts[0].durationMs, 1000);
  assert.equal(parts[1].startMs, c.startMs + 1000);
  assert.equal(parts[1].durationMs, c.durationMs - 1000);
  assert.equal(parts[1].sourceInMs, 1000, "the second half plays the source from where the first half stopped");
  assert.equal((await tl()).totalMs, total);
  assert.equal((await tl()).summary.shots, 65 + 1);
  await reopenBlueprint(db, pid);
  await planPrompts(db, pid);
  for (const s of (await db.query("SELECT id FROM production_scenes WHERE project_id = $1", [pid])).rows) await approveShots(db, pid, s.id, { approved: true });
  await approveBlueprint(db, pid);
  const again = (await v1()).filter((x) => x.shotId === c.shotId);
  assert.equal(again.length, 2, "still exactly two parts");
  assert.equal(again[0].durationMs, 1000, "the edited part keeps its edit");
  assert.equal(await editHistory(db, pid).then((h) => h.canUndo), false, "a re-plan starts a fresh undo history");
});

test("reorder: moving a shot repacks V1 with no gaps or overlaps, carries the shot's dialogue with it, and keeps the total length", async () => {
  const before = await tl();
  const clips = await v1();
  const talking = clips.find((c) => before.clips.some((d) => d.kind === "dialogue" && d.shotId === c.shotId));
  const target = clips[0];
  const total = before.totalMs;
  const dlg = before.clips.filter((d) => d.kind === "dialogue" && d.shotId === talking.shotId);
  const offsets = dlg.map((d) => d.startMs - talking.startMs);
  const r = await edit({ type: "reorder", clipId: talking.id, beforeClipId: target.id });
  assert.equal(r.status, 200);
  const after = await v1();
  assert.equal(after[0].id, talking.id, "now first");
  assert.equal(after[1].id, target.id);
  let cursor = after[0].startMs;
  for (const c of after) { assert.equal(c.startMs, cursor, "contiguous: no gap, no overlap"); cursor += c.durationMs; }
  assert.equal((await tl()).totalMs, total);
  const moved = (await tl()).clips.filter((d) => d.kind === "dialogue" && d.shotId === talking.shotId);
  moved.forEach((d, i) => assert.equal(d.startMs - after[0].startMs, offsets[i], "the line keeps its offset inside its shot"));
  assert.equal((await edit({ type: "reorder", clipId: talking.id, beforeClipId: talking.id })).status, 400);
  assert.equal((await edit({ type: "reorder", clipId: dlg[0].id })).status, 400, "dialogue is moved with 'move', not reorder");
  // to the end
  await edit({ type: "reorder", clipId: after[0].id });
  const last = (await v1()).at(-1);
  assert.equal(last.id, after[0].id);
});

test("move / delete / mute / solo: audio and cue clips move freely, cue clips can leave the timeline, tracks mute and solo", async () => {
  const t0 = await tl();
  const d = t0.clips.find((c) => c.kind === "dialogue");
  assert.equal((await edit({ type: "move", clipId: d.id, startMs: d.startMs + 750 })).status, 200);
  assert.equal((await tl()).clips.find((c) => c.id === d.id).startMs, d.startMs + 750);
  assert.equal((await edit({ type: "move", clipId: (await v1())[0].id, startMs: 5000 })).status, 400, "pictures are reordered, not dragged anywhere");
  assert.equal((await edit({ type: "delete", clipId: d.id })).status, 400, "a spoken line cannot be deleted from the timeline");
  const shot = shots[1];
  const cue = (await api("POST", P("/audio-cues"), { kind: "sfx", label: "Thud", shotId: shot.id })).json.cue;
  const cueClip = (await tl()).clips.find((c) => c.cueId === cue.id);
  assert.equal((await edit({ type: "delete", clipId: cueClip.id })).status, 200);
  assert.equal((await tl()).clips.some((c) => c.cueId === cue.id), false);
  assert.equal((await api("GET", P("/audio-cues"))).json.cues.length, 1, "the cue itself still exists in the Audio Studio");
  const a1 = t0.tracks.find((t) => t.name === "A1");
  await edit({ type: "track", trackId: a1.id, muted: true });
  assert.equal((await tl()).tracks.find((t) => t.id === a1.id).muted, true);
  await edit({ type: "track", trackId: a1.id, muted: false, solo: true });
  const t1 = (await tl()).tracks.find((t) => t.id === a1.id);
  assert.deepEqual([t1.muted, t1.solo], [false, true]);
  assert.equal((await edit({ type: "track", trackId: 99999999, muted: true })).status, 404);
});

test("take replacement: any finished, not-rejected take of THIS shot can play; a rejected / unfinished / other shot's take is refused; null goes back to 'the approved one'", async () => {
  const c = (await v1())[0];
  const other = (await v1())[1];
  const mk = async (shotId, status, review, seconds) => (await db.query("INSERT INTO production_generations (project_id, kind, shot_id, version, status, review, prompt, params) VALUES ($1,'video',$2,(SELECT COALESCE(MAX(version),0)+1 FROM production_generations WHERE project_id=$1 AND kind='video' AND shot_id=$2),$3,$4,'p',$5) RETURNING id", [pid, shotId, status, review, JSON.stringify({ seconds })])).rows[0].id;
  const approved = await mk(c.shotId, "ready", "approved", 4);
  const alt = await mk(c.shotId, "ready", "pending", 6);
  const bad = await mk(c.shotId, "ready", "rejected", 8);
  const running = await mk(c.shotId, "running", "pending", 8);
  const foreign = await mk(other.shotId, "ready", "approved", 4);
  assert.equal((await v1())[0].media.generationId, approved);
  assert.equal((await edit({ type: "take", clipId: c.id, generationId: bad })).json.code, "rejected");
  assert.equal((await edit({ type: "take", clipId: c.id, generationId: running })).json.code, "not_ready");
  assert.equal((await edit({ type: "take", clipId: c.id, generationId: foreign })).json.code, "wrong_take");
  assert.equal((await edit({ type: "take", clipId: c.id, generationId: alt })).status, 200);
  let now = (await v1())[0];
  assert.equal(now.media.generationId, alt);
  assert.equal(now.sourceDurationMs, 6000);
  assert.equal(now.takeOverride, true);
  assert.equal((await db.query("SELECT review FROM production_generations WHERE id = $1", [approved])).rows[0].review, "approved", "the approval itself is untouched: the edit only chooses what plays");
  assert.equal((await edit({ type: "take", clipId: c.id, generationId: null })).status, 200);
  now = (await v1())[0];
  assert.equal(now.media.generationId, approved);
  assert.equal(now.takeOverride, false);
});

test("undo and redo step through the edits exactly, a new edit ends the redo chain, the history is capped, and a stale screen is refused", async () => {
  const s0 = await snapshot();
  const clips = await v1();
  await edit({ type: "trim", clipId: clips[0].id, durationMs: clips[0].durationMs + 1000, ripple: true });
  const s1 = await snapshot();
  await edit({ type: "split", clipId: clips[2].id, atMs: clips[2].startMs + 1000 + 1000 });
  const s2 = await snapshot();
  await edit({ type: "reorder", clipId: clips[4].id, beforeClipId: clips[0].id });
  const s3 = await snapshot();
  let h = await editHistory(db, pid);
  assert.equal(h.canUndo, true);
  assert.equal(h.canRedo, false);
  assert.equal(h.edits.length, 3);
  await undoEdit(db, pid); assert.equal(await snapshot(), s2, "undo the reorder");
  await undoEdit(db, pid); assert.equal(await snapshot(), s1, "undo the split (the second part is removed)");
  await undoEdit(db, pid); assert.equal(await snapshot(), s0, "undo the trim");
  assert.equal((await api("POST", P("/timeline/undo"))).status, 409, "nothing left to undo");
  await redoEdit(db, pid); assert.equal(await snapshot(), s1);
  await redoEdit(db, pid); assert.equal(await snapshot(), s2, "the split part comes back with its id");
  await redoEdit(db, pid); assert.equal(await snapshot(), s3);
  assert.equal((await api("POST", P("/timeline/redo"))).status, 409);
  await undoEdit(db, pid);
  assert.equal((await editHistory(db, pid)).canRedo, true);
  await edit({ type: "slip", clipId: clips[0].id, sourceInMs: 500 });
  assert.equal((await editHistory(db, pid)).canRedo, false, "a new edit ends the redo chain");
  // revision protection (two screens / a re-plan)
  const rev = (await tl()).editRevision;
  assert.equal((await edit({ type: "slip", clipId: clips[0].id, sourceInMs: 600 }, { expectedRevision: rev - 1 })).json.code, "stale");
  assert.equal((await edit({ type: "slip", clipId: clips[0].id, sourceInMs: 600 }, { expectedRevision: rev })).status, 200);
  const hist = (await api("GET", P("/timeline/history"))).json;
  assert.ok(hist.edits[0].label.length > 0);
});

test("the undo history is capped; undo works after a part was split and then the whole timeline was changed by other edits", async () => {
  const c = (await v1())[0];
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) await applyEdit(db, pid, { type: "slip", clipId: c.id, sourceInMs: i * 10 });
  const rows = (await db.query("SELECT count(*)::int AS n FROM production_timeline_edits WHERE timeline_id = (SELECT id FROM production_timelines WHERE project_id = $1)", [pid])).rows[0].n;
  assert.equal(rows, HISTORY_LIMIT);
  assert.ok(MIN_CLIP_MS >= 100);
});

test("every edit announces itself so open timelines refresh, and edits never touch prompts, approvals or media", async () => {
  const seen = [];
  const off = subscribe(pid, (e) => seen.push(e));
  const c = (await v1())[0];
  const before = (await db.query("SELECT (SELECT count(*) FROM production_prompts WHERE project_id=$1) AS p, (SELECT count(*) FROM production_generations WHERE project_id=$1) AS g", [pid])).rows[0];
  await edit({ type: "trim", clipId: c.id, durationMs: c.durationMs + 500, ripple: true });
  await undoEdit(db, pid);
  off();
  assert.ok(seen.some((e) => e.type === "timeline_changed" && e.reason === "edit"));
  assert.ok(seen.some((e) => e.type === "timeline_changed" && e.reason === "undo"));
  const after = (await db.query("SELECT (SELECT count(*) FROM production_prompts WHERE project_id=$1) AS p, (SELECT count(*) FROM production_generations WHERE project_id=$1) AS g", [pid])).rows[0];
  assert.deepEqual(after, before);
});

test("no timeline yet: editing is refused with the next step, not a crash", async () => {
  const other = (await db.query("INSERT INTO ai_movie_projects (pasted_text, title) VALUES ('x','[TEST] Idea of an Idea none') RETURNING id")).rows[0].id;
  const r = await api("POST", `/api/production/${other}/timeline/edit`, { op: { type: "trim", clipId: 1, durationMs: 2000, ripple: true } });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "no_timeline");
  assert.equal((await api("GET", `/api/production/${other}/timeline/history`)).json.canUndo, false);
});
