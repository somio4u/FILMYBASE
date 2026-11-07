// A draft made from the owner's own final screenplay: the chosen draft is copied (story, synopsis, characters, beat sheet stay), its screenplay is replaced; nothing else changes.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createDraftFromScreenplay } from "../draftFromScreenplay.js";
import { ensureDraftFor, ensureDraftSchema } from "../drafts.js";
import { parseScreenplayText, toAiMovieScenes } from "../screenplayTextParser.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let projectId, draft;
const oldScene = (n) => ({ sceneHeading: { en: `INT. OLD ${n} - DAY`, hi: `INT. OLD ${n} - DAY` }, content: [{ type: "action", text: { en: "Old.", hi: "Old." } }] });
test.before(async () => {
  await ensureDraftSchema?.(db);
  const backfill = { story: { title: { en: "Akhada", hi: "Akhada" } }, synopsis: { en: "The same story", hi: "वही कहानी" }, characterArc: [{ name: "Rakhyaka" }], plot: Array.from({ length: 3 }, (_, i) => ({ title: { en: `Beat ${i + 1}`, hi: `Beat ${i + 1}` }, description: { en: "x", hi: "x" }, runtimeMinutes: 5 })), screenplayBeats: [{ status: "approved", scenes: [oldScene(1)] }, { status: "approved", scenes: [oldScene(2)] }, { status: "approved", scenes: [oldScene(3)] }], removedScenes: [{ beatIndex: 0 }] };
  projectId = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, backfill, stage_status) VALUES ('[FROMSP-TEST] Akhada', 'x', $1, $2) RETURNING id", [JSON.stringify(backfill), JSON.stringify({ screenplay: { status: "approved" } })])).rows[0].id;
  draft = await ensureDraftFor(db, "ai_movie", projectId, { actorUserId: 1 });
});
test.after(async () => {
  const refs = (await db.query("SELECT project_ref FROM project_drafts WHERE group_id = $1", [draft.group_id])).rows.map((r) => r.project_ref);
  await db.query("DELETE FROM project_drafts WHERE group_id = $1", [draft.group_id]);
  await db.query("DELETE FROM ai_movie_projects WHERE id = ANY($1)", [[...new Set([...refs, projectId])]]);
  await db.end();
});

const SCRIPT = Array.from({ length: 6 }, (_, i) => `INT. NEW PLACE ${i + 1} - DAY\n\nSomething new happens.\n\nRAKHYAKA\nनया संवाद ${i + 1}\n`).join("\n");
const scenesOf = (text) => toAiMovieScenes(parseScreenplayText(text, { knownCharacters: ["Rakhyaka"] })).map((s) => ({ ...s, estimatedMinutes: 1 }));

test("the new draft keeps the story, synopsis, characters and beat sheet, has the uploaded screenplay in the beats, and the old draft is untouched", async () => {
  const out = await createDraftFromScreenplay(db, { parentDraftId: draft.id, scenes: scenesOf(SCRIPT), filename: "final.pdf", label: "Final screenplay", actorUserId: 1 });
  assert.equal(out.scenes, 6); assert.equal(out.beats, 3);
  assert.notEqual(out.draft.project_ref, projectId);
  const neu = (await db.query("SELECT backfill, stage_status FROM ai_movie_projects WHERE id = $1", [out.draft.project_ref])).rows[0];
  assert.equal(neu.backfill.synopsis.hi, "वही कहानी"); assert.equal(neu.backfill.plot.length, 3); assert.equal(neu.backfill.characterArc[0].name, "Rakhyaka");
  assert.deepEqual(neu.backfill.screenplayBeats.map((b) => b.scenes.length), [2, 2, 2]);
  assert.equal(neu.backfill.screenplayBeats[0].scenes[0].sceneHeading.en, "INT. NEW PLACE 1 - DAY");
  assert.equal(neu.backfill.screenplayBeats[0].scenes[0].content[1].character, "RAKHYAKA");
  assert.equal(neu.backfill.removedScenes, undefined); assert.equal(neu.stage_status.screenplay.status, "approved");
  assert.equal(out.draft.current_stage, "screenplay", "Continue Draft opens at the screenplay");
  assert.match(out.draft.note, /final\.pdf/); assert.equal(out.draft.label, "Final screenplay");
  const old = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0];
  assert.equal(old.backfill.screenplayBeats[0].scenes[0].sceneHeading.en, "INT. OLD 1 - DAY", "the old draft's screenplay is exactly as it was");
  assert.equal(old.backfill.removedScenes.length, 1);
});

test("a screenplay that cannot be placed leaves NO draft behind", async () => {
  const before = Number((await db.query("SELECT count(*) FROM project_drafts WHERE group_id = $1", [draft.group_id])).rows[0].count);
  await assert.rejects(() => createDraftFromScreenplay(db, { parentDraftId: draft.id, scenes: scenesOf(SCRIPT).slice(0, 2), filename: "short.pdf", actorUserId: 1 }), /every beat needs at least one scene/);
  assert.equal(Number((await db.query("SELECT count(*) FROM project_drafts WHERE group_id = $1", [draft.group_id])).rows[0].count), before);
});
