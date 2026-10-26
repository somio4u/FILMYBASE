import test from "node:test";
import assert from "node:assert/strict";
import { stripEchoedLabel, repairLabelElements } from "../echoedLabels.js";

test("an echoed label is taken off, ordinary text is left alone", () => {
  assert.equal(stripEchoedLabel("ACTION: SOUMYA ର କଳା ରଙ୍ଗର ଏସୟୁଭି"), "SOUMYA ର କଳା ରଙ୍ଗର ଏସୟୁଭି");
  assert.equal(stripEchoedLabel("[S2.3] ACTION: ACTION: He runs."), "He runs.");
  assert.equal(stripEchoedLabel("DIALOGUE line of RAHUL: Come here."), "Come here.");
  assert.equal(stripEchoedLabel("ACTING NOTE of RAHUL: angrily"), "angrily");
  assert.equal(stripEchoedLabel("[action] He runs."), "He runs.");
  for (const fine of ["He takes action: he runs.", "Action speaks louder.", "Reaction: shock.", "ACTIONS follow.", "", "SOUMYA looks up."]) assert.equal(stripEchoedLabel(fine), fine);
  assert.equal(stripEchoedLabel(undefined), undefined);
});

test("a stored scene is repaired and an untouched one is reported unchanged", () => {
  const bad = { elements: [{ type: "action", text: "ACTION: A" }, { type: "dialogue", character: "X", text: "Hi", parenthetical: "ACTING NOTE of X: soft" }, { type: "action", text: "B" }] };
  const out = repairLabelElements(bad);
  assert.equal(out.changed, true);
  assert.deepEqual(out.content.elements.map((e) => e.text), ["A", "Hi", "B"]);
  assert.equal(out.content.elements[1].parenthetical, "soft");
  assert.equal(repairLabelElements({ elements: [{ type: "action", text: "B" }] }).changed, false);
});

import pg from "pg";
import { repairStoredLabels } from "../echoedLabels.js";
const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let up = true;
try { await db.query("SELECT 1"); } catch { up = false; }

test("startup repair: the newest version loses its labels as a NEW version; a second run changes nothing", { skip: !up }, async () => {
  const id = (await db.query("INSERT INTO scene_lists (content, status) VALUES ('{\"scenes\":[{}]}', 'approved') RETURNING id")).rows[0].id;
  try {
    await db.query("INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content, status) VALUES ($1, NULL, 0, $2, 'approved')", [id, JSON.stringify({ elements: [{ type: "action", text: "ACTION: SOUMYA runs." }] })]);
    await repairStoredLabels(db);
    const versions = (await db.query("SELECT content FROM screenplay_scenes WHERE scene_list_id = $1 ORDER BY id", [id])).rows;
    assert.equal(versions.length, 2); // the old one stays for Undo
    assert.equal(versions[1].content.elements[0].text, "SOUMYA runs.");
    await repairStoredLabels(db);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM screenplay_scenes WHERE scene_list_id = $1", [id])).rows[0].n, 2);
  } finally {
    await db.query("DELETE FROM screenplay_scenes WHERE scene_list_id = $1", [id]);
    await db.query("DELETE FROM scene_lists WHERE id = $1", [id]);
    await db.end();
  }
});
