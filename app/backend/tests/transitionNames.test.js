import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { isTransitionName, repairTransitionElements, repairStoredTransitions, withoutTransitions } from "../transitionNames.js";
import { parseEpisodesFromText } from "../screenplayImport.js";
import { sceneRowsFromList } from "../smartScheduler.js";
import { buildScreenplayPlainText } from "../screenplayText.js";
import { buildDocument } from "../adSheets.js";

test('"FREEZE. BREAK-" and the other transition lines are transitions, real names are not', () => {
  for (const t of ["FREEZE. BREAK-", "FREEZE.", "FREEZE FRAME", "BREAK-", "COMMERCIAL BREAK", "FADE OUT.", "CUT TO:", "THE END", "END OF EPISODE", "INTERVAL"]) assert.equal(isTransitionName(t), true, t);
  for (const t of ["SOUMYA", "BREAKER", "FREEZER", "KALI", "MAKAR"]) assert.equal(isTransitionName(t), false, t);
});

test("the Word import reads FREEZE. BREAK- as a transition, never as a speaker", () => {
  const text = ["EPISODE 1: TEST", "SCENE 1 (1 minute)", "INT. TEMPLE - NIGHT", "Soumya prays alone.", "SOUMYA", "Mother, help me.", "FREEZE. BREAK-", "", "SCENE 2 (1 minute)", "EXT. ROAD - DAY", "A jeep passes.", "FREEZE."].join("\n");
  const els = parseEpisodesFromText(text).episodes[0].scenes.flatMap((s) => s.elements);
  assert.ok(els.some((e) => e.type === "transition" && e.text.startsWith("FREEZE. BREAK")));
  assert.ok(!els.some((e) => e.type === "dialogue" && /FREEZE|BREAK/.test(e.character)));
  assert.ok(els.some((e) => e.type === "dialogue" && e.character === "SOUMYA"));
});

test("a screenplay already stored with the mistake is repaired (words after it are kept as an action line)", () => {
  const bad = { elements: [{ type: "dialogue", character: "SOUMYA", text: "Help." }, { type: "dialogue", character: "FREEZE. BREAK-", text: "Episode ends." }], charactersPresent: ["SOUMYA", "FREEZE. BREAK-"] };
  const r = repairTransitionElements(bad);
  assert.equal(r.changed, true);
  assert.deepEqual(r.content.elements.map((e) => e.type), ["dialogue", "transition", "action"]);
  assert.equal(r.content.elements[1].text, "FREEZE. BREAK-");
  assert.deepEqual(r.content.charactersPresent, ["SOUMYA"]);
  assert.equal(repairTransitionElements(r.content).changed, false); // nothing left to repair
});

test("the Smart Scheduler, the plain-text script and name lists never count a transition as a person", () => {
  const list = { scenes: [{ intExt: "INT", location: { en: "Temple" }, oneLiner: { en: "x" } }] };
  const written = new Map([["film-0", { elements: [{ type: "dialogue", character: "SOUMYA", text: "hi" }, { type: "dialogue", character: "FREEZE. BREAK-", text: "" }], charactersPresent: ["SOUMYA", "FREEZE. BREAK-"] }]]);
  assert.deepEqual(sceneRowsFromList(list, written)[0].artists, ["SOUMYA"]);
  const plain = buildScreenplayPlainText({ deck: { title: "T" }, sceneList: list, scenesByEpisode: new Map([[null, [{ scene_index: 0, content: written.get("film-0") }]]]) });
  assert.match(plain, /FREEZE\. BREAK-/);
  assert.deepEqual(withoutTransitions([{ label: "ANU" }, { label: "FREEZE. BREAK-" }, "RAVI", "FADE OUT."]), [{ label: "ANU" }, "RAVI"]);
});

test("AD papers show the AI's clear description, not the script's raw first line", () => {
  const rows = [{ id: "film-0", label: "1", episode: null, minutes: 2, location: "TEMPLE", rawLocation: "TEMPLE", intExt: "INT", timeOfDay: "DAY", night: false, artists: [], written: true, gist: "a", body: "" }];
  const spec = buildDocument("one-liner", { title: "T", rows, plan: null, adSheet: [{ sceneSummary: { en: "Soumya prays at the temple while Ratan watches." } }], breakdown: null, tags: [], contacts: new Map() });
  assert.match(JSON.stringify(spec), /Soumya prays at the temple/);
  assert.ok(!spec.sections[0].rows[0].includes("a"));
});

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let up = true;
try { await db.query("SELECT 1"); } catch { up = false; }

test("startup repair: only the newest version is fixed, as a NEW version; a second run changes nothing", { skip: !up }, async () => {
  const id = (await db.query("INSERT INTO scene_lists (content, status) VALUES ('{\"scenes\":[{}]}', 'approved') RETURNING id")).rows[0].id;
  const put = (content) => db.query("INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content, status) VALUES ($1, NULL, 0, $2, 'approved')", [id, JSON.stringify(content)]);
  try {
    await put({ elements: [{ type: "dialogue", character: "SOUMYA", text: "hi" }] });
    await put({ elements: [{ type: "dialogue", character: "SOUMYA", text: "hi" }, { type: "dialogue", character: "FREEZE. BREAK-", text: "" }], charactersPresent: ["SOUMYA", "FREEZE. BREAK-"] });
    await repairStoredTransitions(db);
    const versions = (await db.query("SELECT content FROM screenplay_scenes WHERE scene_list_id = $1 ORDER BY id", [id])).rows;
    assert.equal(versions.length, 3); // the two old versions stay
    assert.deepEqual(versions[2].content.elements.map((e) => e.type), ["dialogue", "transition"]);
    await repairStoredTransitions(db);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM screenplay_scenes WHERE scene_list_id = $1", [id])).rows[0].n, 3);
  } finally {
    await db.query("DELETE FROM screenplay_scenes WHERE scene_list_id = $1", [id]);
    await db.query("DELETE FROM scene_lists WHERE id = $1", [id]);
    await db.end();
  }
});
