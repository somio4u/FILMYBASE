// "Rename a character in the whole script" for AI Movie (aiMovieRename.js): the pure walk, and the database side (preview, rename, undo). REAL Postgres, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { renameInBackfill, renameCharacter, renameUndoInfo, undoRename, ensureRenameUndoSchema } from "../aiMovieRename.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const t = (en, hi = en) => ({ en, hi });
const backfill = () => ({
  story: t("Mira defies a cyclone.", "मीरा तूफ़ान से लड़ती है। Mira"),
  synopsis: { logline: t("MIRA saves the village."), premise: t("Miranda is not Mira.") },
  characterArc: [{ name: "Mira", want: t("Mira wants peace."), need: t("to forgive") }, { name: "Kaal", want: t("Kaal wants Mira.") }],
  plot: [{ title: t("The storm"), description: t("Mira hears the bells.") }],
  screenplayBeats: [{ status: "approved", autoApproved: true, generatingSince: "2026-01-01", scenes: [
    { sceneHeading: t("INT. TEMPLE - DAY"), characters: t("Mira, Kaal"), content: [{ type: "action", text: t("Mira ties her anklets.") }, { type: "dialogue", character: "MIRA", parenthetical: t("to Mira's guru"), line: t("Stay back, Kaal.") }, { type: "dialogue", character: "KAAL", line: t("Mira, wait.") }] },
    { sceneHeading: t("EXT. SHORE - DAWN"), content: [{ type: "action", text: t("The sea is quiet.") }] },
  ] }],
  removedScenes: [{ beatIndex: 0, sceneIndex: 0, scene: { sceneHeading: t("INT. HUT - NIGHT"), content: [{ type: "dialogue", character: "MIRA", line: t("Hello") }] } }],
  intervalAfterBeat: 3,
});

test("the walk: whole names only, case kept, speaker cues in capitals; counts are per scene; ids and statuses are left alone", () => {
  const { backfill: out, summary } = renameInBackfill(backfill(), "Mira", "Meera");
  const scene = out.screenplayBeats[0].scenes[0];
  assert.equal(scene.content[0].text.en, "Meera ties her anklets.");
  assert.equal(scene.content[1].character, "MEERA"); // a speaker cue stays in capitals
  assert.equal(scene.content[1].parenthetical.en, "to Meera's guru");
  assert.equal(scene.characters.en, "Meera, Kaal");
  assert.equal(out.synopsis.logline.en, "MEERA saves the village."); // the case style of each place is kept
  assert.equal(out.synopsis.premise.en, "Miranda is not Meera."); // "Miranda" is another name: untouched
  assert.equal(out.characterArc[0].name, "Meera");
  assert.equal(out.story.hi, "मीरा तूफ़ान से लड़ती है। Meera"); // Hindi text keeps its own script; only the Latin spelling in it changes
  assert.equal(out.removedScenes[0].scene.content[0].character, "MEERA"); // "Undo the last removal" does not bring the old name back
  assert.equal(out.screenplayBeats[0].status, "approved");
  assert.equal(out.screenplayBeats[0].generatingSince, "2026-01-01");
  assert.equal(out.intervalAfterBeat, 3);
  assert.equal(summary.scenes, 1); // only the first scene mentions the name
  assert.equal(summary.speakerLines, 1);
  assert.ok(summary.mentions >= 4);
  assert.ok(summary.otherPlaces >= 6);
  // the input is not changed
  assert.equal(backfill().screenplayBeats[0].scenes[0].content[0].text.en, "Mira ties her anklets.");
});

test("a Devanagari spelling can be renamed on its own; a name that is not there changes nothing", () => {
  const { backfill: out, summary } = renameInBackfill(backfill(), "मीरा", "मीरा देवी");
  assert.equal(out.story.hi, "मीरा देवी तूफ़ान से लड़ती है। Mira");
  assert.equal(summary.otherPlaces, 1);
  const none = renameInBackfill(backfill(), "Nobody", "Someone");
  assert.deepEqual(none.summary, { scenes: 0, speakerLines: 0, mentions: 0, otherPlaces: 0 });
  assert.deepEqual(none.backfill, backfill());
});

let id;
test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB, stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await ensureRenameUndoSchema(db);
});
test.beforeEach(async () => {
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[REN-TEST]%'");
  id = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, backfill) VALUES ('[REN-TEST]','idea',$1) RETURNING id", [JSON.stringify(backfill())])).rows[0].id;
});
test.after(async () => { await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[REN-TEST]%'"); await db.end(); });

test("preview only counts (nothing saved, no undo); the rename saves, keeps the old text for Undo, and Undo puts it all back", async () => {
  const preview = await renameCharacter(db, id, { from: "Mira", to: "Meera", preview: true });
  assert.equal(preview.scenes, 1);
  assert.equal(preview.preview, true);
  assert.equal((await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [id])).rows[0].backfill.characterArc[0].name, "Mira");
  assert.equal((await renameUndoInfo(db, id)).canUndo, false);

  const done = await renameCharacter(db, id, { from: "Mira", to: "Meera" });
  assert.equal(done.scenes, 1);
  assert.equal(done.canUndo, true);
  const after = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [id])).rows[0].backfill;
  assert.equal(after.characterArc[0].name, "Meera");
  assert.equal(after.screenplayBeats[0].scenes[0].content[1].character, "MEERA");
  const info = await renameUndoInfo(db, id);
  assert.deepEqual([info.canUndo, info.from, info.to], [true, "Mira", "Meera"]);

  const undone = await undoRename(db, id);
  assert.equal(undone.restored, true);
  assert.deepEqual((await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [id])).rows[0].backfill, backfill());
  assert.equal((await renameUndoInfo(db, id)).canUndo, false);
  await assert.rejects(undoRename(db, id), /no rename to undo/);
});

test("a rename that finds nothing keeps no undo; bad names, a missing project and a second rename (only the last can be undone) behave", async () => {
  const none = await renameCharacter(db, id, { from: "Nobody", to: "Someone" });
  assert.equal(none.scenes + none.mentions + none.speakerLines + none.otherPlaces, 0);
  assert.equal((await renameUndoInfo(db, id)).canUndo, false);
  await assert.rejects(renameCharacter(db, id, { from: "Mira", to: "mira" }), /same as the old/);
  await assert.rejects(renameCharacter(db, id, { from: "", to: "X" }), /old name and the new name/);
  await assert.rejects(renameCharacter(db, 99999999, { from: "Mira", to: "X" }), /not found/);
  await renameCharacter(db, id, { from: "Mira", to: "Meera" });
  await renameCharacter(db, id, { from: "Kaal", to: "Kala" });
  const info = await renameUndoInfo(db, id);
  assert.deepEqual([info.from, info.to], ["Kaal", "Kala"]); // only the last rename can be undone
  await undoRename(db, id);
  const back = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [id])).rows[0].backfill;
  assert.equal(back.characterArc[0].name, "Meera"); // the first rename stays
  assert.equal(back.characterArc[1].name, "Kaal");
});
