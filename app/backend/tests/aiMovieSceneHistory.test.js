// Undo / Redo of changes to the scenes of an AI Movie beat (aiMovieSceneHistory.js). REAL Postgres, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { ensureSceneHistorySchema, changedBeats, recordChanges, historyInfo, undoLast, redoLast } from "../aiMovieSceneHistory.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const sc = (n) => ({ sceneHeading: { en: `INT. PLACE ${n} - DAY`, hi: `INT. PLACE ${n} - DAY` }, content: [{ type: "action", text: { en: `s${n}`, hi: `s${n}` } }] });
const names = (scenes) => scenes.map((s) => s.content[0].text.en).join(",");
let id;

const beatsOf = async () => (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [id])).rows[0].backfill.screenplayBeats;
// what the routes do: keep the beat as it was, then save the new scenes
async function change(beatIndex, scenes, label) {
  const beats = await beatsOf();
  await recordChanges(db, id, changedBeats(beats, beats.map((b, i) => (i === beatIndex ? { ...b, scenes } : b))), label);
  beats[beatIndex] = { ...beats[beatIndex], scenes };
  await db.query("UPDATE ai_movie_projects SET backfill = jsonb_set(backfill, '{screenplayBeats}', $2::jsonb) WHERE id = $1", [id, JSON.stringify(beats)]);
}

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB, stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await ensureSceneHistorySchema(db);
});
test.beforeEach(async () => {
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[HIS-TEST]%'");
  id = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, backfill) VALUES ('[HIS-TEST]','idea',$1) RETURNING id", [JSON.stringify({ screenplayBeats: [{ status: "approved", scenes: [sc(1), sc(2)] }, { status: "pending", scenes: [sc(3)] }, { status: "not_started", scenes: null }] })])).rows[0].id;
});
test.after(async () => { await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[HIS-TEST]%'"); await db.end(); });

test("which beats really changed: only beats that were written before and whose scenes differ now", () => {
  const before = [{ scenes: [sc(1)] }, { scenes: [sc(2)] }, { scenes: null }, { scenes: [] }];
  const after = [{ scenes: [sc(1)] }, { scenes: [sc(9)] }, { scenes: [sc(3)] }, { scenes: [sc(4)] }];
  assert.deepEqual(changedBeats(before, after).map((c) => c.beatIndex), [1]); // a beat that was empty or unwritten before is not an edit to undo
  assert.deepEqual(changedBeats(before, [{ scenes: [sc(1)], status: "approved" }, before[1]]), []); // a status change alone is not a change to the scenes
  assert.deepEqual(changedBeats(undefined, after), []);
});

test("undo puts the beat back, redo brings the change again, and the newest change is undone first", async () => {
  assert.deepEqual(await historyInfo(db, id), { canUndo: false, canRedo: false, undoLabel: null, undoBeat: null, redoLabel: null, redoBeat: null });
  await change(0, [sc(1), sc(7), sc(2)], "You added a scene (beat 1)");
  await change(1, [sc(3), sc(8)], "You edited scene 1 of beat 2");
  let info = await historyInfo(db, id);
  assert.deepEqual([info.canUndo, info.canRedo, info.undoLabel, info.undoBeat], [true, false, "You edited scene 1 of beat 2", 1]);

  const first = await undoLast(db, id); // the newest change goes first
  assert.equal(first.beatIndex, 1);
  let beats = await beatsOf();
  assert.equal(names(beats[1].scenes), "s3");
  assert.equal(names(beats[0].scenes), "s1,s7,s2"); // the older change is still there
  assert.equal(beats[1].status, "pending"); // statuses are not touched
  info = await historyInfo(db, id);
  assert.deepEqual([info.canUndo, info.canRedo, info.redoLabel], [true, true, "You edited scene 1 of beat 2"]);

  await undoLast(db, id);
  assert.equal(names((await beatsOf())[0].scenes), "s1,s2");
  await assert.rejects(undoLast(db, id), /nothing to undo/);

  await redoLast(db, id); // the OLDEST undone one comes back first
  beats = await beatsOf();
  assert.equal(names(beats[0].scenes), "s1,s7,s2");
  assert.equal(names(beats[1].scenes), "s3");
  await redoLast(db, id);
  assert.equal(names((await beatsOf())[1].scenes), "s3,s8");
  await assert.rejects(redoLast(db, id), /nothing to redo/);
});

test("a new change after an undo throws the redo states away; only the newest 30 are kept; a vanished beat refuses clearly", async () => {
  await change(0, [sc(1), sc(7), sc(2)], "first");
  await undoLast(db, id);
  assert.equal((await historyInfo(db, id)).canRedo, true);
  await change(0, [sc(1), sc(5)], "second");
  assert.equal((await historyInfo(db, id)).canRedo, false); // like any editor
  for (let i = 0; i < 35; i++) await change(0, [sc(1), sc(100 + i)], `change ${i}`);
  const count = (await db.query("SELECT count(*)::int AS n FROM ai_movie_scene_history WHERE project_id = $1", [id])).rows[0].n;
  assert.equal(count, 30);
  assert.equal((await historyInfo(db, id)).undoLabel, "change 34");
  // the beat is gone (the screenplay was reset): the refusal says so and the project is not touched
  await db.query("UPDATE ai_movie_projects SET backfill = jsonb_set(backfill, '{screenplayBeats}', '[]'::jsonb) WHERE id = $1", [id]);
  await assert.rejects(undoLast(db, id), /no longer there/);
  assert.deepEqual(await beatsOf(), []);
  await assert.rejects(undoLast(db, 99999999), /not found|nothing to undo/);
});
