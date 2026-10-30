// The five main stages (Idea, Story Synopsis, Three-act, Scene One-liners, Screenplay) decide where a project is; Characters and the Bit Sheet are
// optional and never do. REAL Postgres, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { detectStage } from "../drafts.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const J = JSON.stringify;
let concept;
test.before(async () => {
  await db.query("DELETE FROM concepts WHERE title = '[STAGE-TEST] Film'");
  concept = (await db.query("INSERT INTO concepts (concept_text, storylines, title) VALUES ('x', '[]', '[STAGE-TEST] Film') RETURNING id")).rows[0].id;
});
test.after(async () => { await db.query("DELETE FROM concepts WHERE id = $1", [concept]); await db.end(); });

test("a project moves Idea → Story Synopsis → Three-act → Scene One-liners → Screenplay with no characters and no Bit Sheet made by the writer", async () => {
  assert.deepEqual(await detectStage(db, "film", concept), { stage: "idea", approved: false });
  const deck = (await db.query("INSERT INTO pitch_decks (concept_id, content, status) VALUES ($1, $2, 'pending') RETURNING id", [concept, J({})])).rows[0].id;
  assert.deepEqual(await detectStage(db, "film", concept), { stage: "synopsis", approved: false });
  await db.query("UPDATE pitch_decks SET status = 'approved' WHERE id = $1", [deck]);
  // approved synopsis, NO character sheet: the next stage is the three-act (it used to be Characters)
  assert.deepEqual(await detectStage(db, "film", concept), { stage: "threeact", approved: false });
  const act = (await db.query("INSERT INTO three_act_structures (pitch_deck_id, content) VALUES ($1, $2) RETURNING id", [deck, J({})])).rows[0].id;
  assert.deepEqual(await detectStage(db, "film", concept), { stage: "threeact", approved: false }); // made, not locked yet
  await db.query("UPDATE three_act_structures SET status = 'locked' WHERE id = $1", [act]);
  assert.deepEqual(await detectStage(db, "film", concept), { stage: "scenelist", approved: false }); // no Bit Sheet needed to be here
  const bits = (await db.query("INSERT INTO bit_sheets (three_act_structure_id, content, status) VALUES ($1, $2, 'approved') RETURNING id", [act, J({})])).rows[0].id;
  const list = (await db.query("INSERT INTO scene_lists (bit_sheet_id, content) VALUES ($1, $2) RETURNING id", [bits, J({ scenes: [] })])).rows[0].id;
  assert.deepEqual(await detectStage(db, "film", concept), { stage: "scenelist", approved: false }); // made, not approved yet
  await db.query("UPDATE scene_lists SET status = 'approved' WHERE id = $1", [list]);
  assert.deepEqual(await detectStage(db, "film", concept), { stage: "screenplay", approved: true });
});
