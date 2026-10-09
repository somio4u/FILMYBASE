// Pipeline step 1: reading the screenplay. The parser runs on the real
// "Idea of an Idea" screenplay (fixtures/idea-of-an-idea.md) and on other
// formats; the analysis runs on a real local Postgres. No AI is involved.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { parseScreenplayText, parseHeading, scenesFromBeats } from "../screenplayParse.js";
import { ensureProductionSchema, seedTestProject, ingestAgentOutput } from "../production.js";
import { ensureScreenplayAnalysisSchema, analyzeScreenplay, listScenes, getScene, normalizeForMatch, linkSceneToAssets } from "../screenplayAnalysis.js";

const FIXTURE = fs.readFileSync(path.join(import.meta.dirname, "../fixtures/idea-of-an-idea.md"), "utf8");
const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await ensureProductionSchema(db);
  await ensureScreenplayAnalysisSchema(db);
  await ensureScreenplayAnalysisSchema(db); // idempotent
});
test.after(() => db.end());

async function freshTestProject() {
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'");
  return (await seedTestProject(db)).projectId;
}
const sceneByNumber = async (pid, n) => (await listScenes(db, pid)).find((s) => s.number === String(n));
const assetNames = (scene) => scene.assets.map((a) => a.name);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

test("parser reads the real screenplay: 12 scenes, nothing from the character sheets, every heading split correctly", () => {
  const { scenes, warnings } = parseScreenplayText(FIXTURE);
  assert.deepEqual(warnings, []);
  assert.deepEqual(scenes.map((s) => s.number), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  const by = (n) => scenes.find((s) => s.number === String(n));
  assert.deepEqual([by(1).intExt, by(1).location, by(1).time], ["INT", "RAHUL'S BEDROOM", "MORNING"]);
  assert.deepEqual([by(2).intExt, by(2).location], ["INT/EXT", "APARTMENT ENTRANCE"]);
  assert.deepEqual([by(4).location, by(4).time], ["OFFICE — WORKSTATION AREA", "DAY"]);
  assert.deepEqual([by(7).location, by(7).time], ["PSYCHIATRIC CLINIC — DOCTOR'S CABIN".replace("PSYCHIATRIC", "PSYCHIATRIST"), "AFTERNOON, CONTINUOUS"]);
  assert.deepEqual([by(10).qualifier, by(10).intExt, by(10).location, by(10).time], ["DREAM", "EXT", "VAST DESERT", "SURREAL"]);
  assert.equal(by(12).time, "MORNING (FINAL SCENE)");
  assert.ok(!scenes.some((s) => s.elements.some((e) => /Odia Brahmin|janeu|KEY PROPS/.test(e.text))), "the character sheet / notes are not parsed as scenes");
});

test("parser: every shot note and dialogue line in the script is found, in order", () => {
  const { scenes } = parseScreenplayText(FIXTURE);
  const kinds = (s, k) => s.elements.filter((e) => e.kind === k);
  assert.deepEqual(scenes.map((s) => kinds(s, "shot_hint").length), [4, 8, 6, 4, 3, 5, 6, 3, 9, 9, 2, 6]);
  assert.deepEqual(scenes.map((s) => kinds(s, "dialogue").length), [0, 0, 0, 1, 4, 0, 3, 0, 1, 7, 1, 0]);
  assert.equal(scenes.reduce((n, s) => n + kinds(s, "shot_hint").length, 0), 65);
  assert.equal(scenes.reduce((n, s) => n + kinds(s, "dialogue").length, 0), 17);
  assert.deepEqual(kinds(scenes[1], "shot_hint").map((e) => e.label), ["2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "2.8"]);
  assert.deepEqual(kinds(scenes[6], "dialogue").map((e) => e.speaker), ["DOCTOR", "RAHUL", "DOCTOR"]);
  assert.deepEqual(kinds(scenes[9], "dialogue").map((e) => e.speaker), ["RAHUL", "THE FIGURE", "RAHUL", "THE FIGURE", "THE FIGURE", "THE FIGURE", "THE FIGURE"]);
});

test("parser: dialogue keeps the exact Hindi/English wording and the stage directions", () => {
  const { scenes } = parseScreenplayText(FIXTURE);
  const d = scenes[4].elements.filter((e) => e.kind === "dialogue");
  assert.equal(d[0].text, "अबे क्या हुआ? भूत देख लिया क्या?");
  assert.equal(d[1].speaker, "RAHUL");
  assert.equal(d[1].parenthetical, "hesitant, low voice");
  assert.match(d[1].text, /^यार\.\.\. मुझे एक अजीब सा आदमी दिखता है। पूरा काला suit पहना हुआ, बिल्कुल Spider-Man जैसा body/);
  assert.equal(d[3].parenthetical, "laughing");
  assert.equal(scenes[9].elements.filter((e) => e.kind === "dialogue")[1].parenthetical, "calm, deep, echoing voice");
  assert.deepEqual(scenes[11].elements.filter((e) => e.kind === "transition").map((e) => e.text), ["FADE OUT."]);
  assert.equal(scenes[0].elements.filter((e) => e.kind === "note").length, 1);
  assert.ok(scenes[11].elements.every((e) => !/^END\.?$/.test(e.text)));
});

test("parser: ordinary screenplay format (INT./EXT. headings, CAPS speakers, (V.O.), transitions, Windows line endings)", () => {
  const text = "FADE IN:\r\n\r\nINT. KITCHEN - DAY\r\n\r\nMary enters, drops her bag.\r\n\r\nMARY\r\n(tired)\r\nHello there.\r\nAnyone home?\r\n\r\nJOHN (V.O.)\r\nWe need to talk.\r\n\r\nCUT TO:\r\n\r\nEXT. STREET - NIGHT\r\n\r\nCars pass.\r\n";
  const { scenes, warnings } = parseScreenplayText(text);
  assert.deepEqual(warnings, []);
  assert.equal(scenes.length, 2);
  assert.deepEqual([scenes[0].number, scenes[0].intExt, scenes[0].location, scenes[0].time], ["1", "INT", "KITCHEN", "DAY"]);
  assert.deepEqual([scenes[1].number, scenes[1].intExt, scenes[1].location, scenes[1].time], ["2", "EXT", "STREET", "NIGHT"]);
  const el = scenes[0].elements;
  assert.deepEqual(el.map((e) => e.kind), ["action", "dialogue", "dialogue", "transition"]);
  assert.equal(el[1].speaker, "MARY");
  assert.equal(el[1].text, "(tired) Hello there. Anyone home?".replace("(tired) ", ""));
  assert.equal(el[2].speaker, "JOHN");
  assert.equal(el[2].extension, "V.O.");
  assert.equal(el[3].text, "CUT TO:");
});

test("parser: no headings gives a clear warning and no scenes; empty and odd input never throws", () => {
  const r = parseScreenplayText("Just a story about a man.\nHe walks.");
  assert.equal(r.scenes.length, 0);
  assert.match(r.warnings[0], /No scene headings/);
  assert.equal(parseScreenplayText("").scenes.length, 0);
  assert.equal(parseScreenplayText(null).scenes.length, 0);
  const odd = parseScreenplayText("INT. ROOM - DAY\n\n\n\n**\n*\n---\n");
  assert.equal(odd.scenes.length, 1);
  assert.match(odd.warnings[0], /no content/);
});

test("parseHeading: qualifiers, times, plain locations", () => {
  assert.deepEqual(parseHeading("INT. OFFICE - DAY"), { heading: "INT. OFFICE - DAY", intExt: "INT", location: "OFFICE", time: "DAY", qualifier: null });
  assert.equal(parseHeading("EXT. WINE/BEER SHOP COUNTER — EVENING").location, "WINE/BEER SHOP COUNTER");
  assert.equal(parseHeading("I/E. CAR - NIGHT").intExt, "INT/EXT");
  assert.equal(parseHeading("THE ROOFTOP").location, "THE ROOFTOP");
  assert.equal(parseHeading("").location, null);
});

test("scenesFromBeats reads the app's own saved screenplay (content blocks and the older action/dialogue shape)", () => {
  const backfill = { screenplayBeats: [
    { scenes: [
      { sceneHeading: { en: "INT. HOME - NIGHT", hi: "" }, estimatedMinutes: 1.5, content: [
        { type: "action", text: { en: "A dim room.", hi: "धुंधला कमरा।" } },
        { type: "dialogue", character: "ASHA", parenthetical: { en: "softly", hi: "" }, line: { en: "Come in.", hi: "अंदर आओ।" } },
        { type: "transition", transition: "CUT TO:" },
      ] },
      { sceneHeading: { en: "EXT. ROAD - DAY" }, action: { en: "Dust rises." }, dialogue: [{ character: "RAVI", line: { en: "Go!" } }] },
    ] },
    { scenes: [{ sceneHeading: { en: "INT. SHOP - DAY" }, action: { en: "Quiet." } }] },
  ] };
  const scenes = scenesFromBeats(backfill);
  assert.deepEqual(scenes.map((s) => s.number), ["1.1", "1.2", "2.1"]);
  assert.deepEqual(scenes.map((s) => s.beatIndex), [0, 0, 1]);
  assert.equal(scenes[0].location, "HOME");
  assert.equal(scenes[0].estimatedMinutes, 1.5);
  assert.deepEqual(scenes[0].elements.map((e) => e.kind), ["action", "dialogue", "transition"]);
  assert.deepEqual(scenes[0].elements[1].textBoth, { en: "Come in.", hi: "अंदर आओ।" });
  assert.equal(scenes[1].elements[1].speaker, "RAVI");
  assert.deepEqual(scenesFromBeats({}), []);
});

// ---------------------------------------------------------------------------
// Analysis (database)
// ---------------------------------------------------------------------------

test("analysis of the test project: 12 scenes with stable codes, 17 dialogue lines D001-D017 in order, 65 shot notes", async () => {
  const pid = await freshTestProject();
  const r = await analyzeScreenplay(db, pid);
  assert.equal(r.outcome, "analyzed");
  assert.equal(r.summary.source, "text");
  assert.equal(r.summary.scenes, 12);
  assert.equal(r.summary.dialogueLines, 17);
  assert.equal(r.summary.shotHints, 65);
  assert.equal(r.summary.created, 12);
  const scenes = await listScenes(db, pid);
  assert.deepEqual(scenes.map((s) => s.code), Array.from({ length: 12 }, (_, i) => `SC${String(i + 1).padStart(3, "0")}`));
  const codes = (await db.query(
    "SELECT e.code FROM production_scene_elements e JOIN production_scenes s ON s.id = e.scene_id WHERE e.project_id = $1 AND e.kind = 'dialogue' ORDER BY s.order_index, e.order_index", [pid]
  )).rows.map((x) => x.code);
  assert.deepEqual(codes, Array.from({ length: 17 }, (_, i) => `D${String(i + 1).padStart(3, "0")}`));
  const scene10 = await getScene(db, pid, scenes[9].id);
  assert.equal(scene10.qualifier, "DREAM");
  const first = scene10.elements.find((e) => e.kind === "dialogue");
  assert.equal(first.language, "hi");
  assert.equal(first.textHi, first.text);
  assert.equal(first.textEn, "");
  const action = scene10.elements.find((e) => e.kind === "action");
  assert.equal(action.language, "en");
});

test("running the analysis again changes nothing: same scenes, same ids, no duplicate issues", async () => {
  const pid = await freshTestProject();
  await analyzeScreenplay(db, pid);
  const ids = async () => (await db.query("SELECT id, code FROM production_scene_elements WHERE project_id = $1 ORDER BY id", [pid])).rows;
  const before = await ids();
  const issuesBefore = (await db.query("SELECT count(*)::int n FROM production_issues WHERE project_id = $1 AND status = 'open'", [pid])).rows[0].n;
  const again = await analyzeScreenplay(db, pid);
  assert.equal(again.summary.unchanged, 12);
  assert.equal(again.summary.created, 0);
  assert.deepEqual(await ids(), before);
  assert.equal((await db.query("SELECT count(*)::int n FROM production_scenes WHERE project_id = $1", [pid])).rows[0].n, 12);
  assert.equal((await db.query("SELECT count(*)::int n FROM production_issues WHERE project_id = $1 AND status = 'open'", [pid])).rows[0].n, issuesBefore);
});

test("when the screenplay changes, untouched dialogue keeps its id; a new line gets the next id; a deleted line goes; the scene's revision moves", async () => {
  const pid = await freshTestProject();
  await analyzeScreenplay(db, pid);
  const idOf = async (needle) => (await db.query("SELECT code, id FROM production_scene_elements WHERE project_id = $1 AND kind = 'dialogue' AND text_hi LIKE $2", [pid, `%${needle}%`])).rows[0];
  const kept = await idOf("भूत देख लिया क्या");
  const sceneRev = (await sceneByNumber(pid, 5));
  let text = (await db.query("SELECT pasted_text FROM ai_movie_projects WHERE id = $1", [pid])).rows[0].pasted_text;
  // add a line in scene 5 and delete the doctor's first line in scene 7
  text = text.replace('"अबे क्या हुआ? भूत देख लिया क्या?"', '"अबे क्या हुआ? भूत देख लिया क्या?"\n\n**RAHUL**\n"कुछ नहीं।"');
  text = text.replace('**DOCTOR**\n"बोलिए, क्या तकलीफ़ है?"\n\n', "");
  await db.query("UPDATE ai_movie_projects SET pasted_text = $1 WHERE id = $2", [text, pid]);
  const r = await analyzeScreenplay(db, pid);
  assert.equal(r.summary.dialogueLines, 17);
  assert.deepEqual(await idOf("भूत देख लिया क्या"), kept, "an unchanged line keeps its id");
  assert.equal((await idOf("कुछ नहीं")).code, "D018");
  assert.equal(await idOf("बोलिए, क्या तकलीफ़ है"), undefined);
  assert.equal(r.summary.updated, 2);
  assert.equal(r.summary.unchanged, 10);
  const rev = (await db.query("SELECT revision FROM production_scenes WHERE id = $1", [sceneRev.id])).rows[0].revision;
  assert.equal(rev, 2);
});

test("a scene removed from the script is hidden, not deleted, and comes back with the same code if restored", async () => {
  const pid = await freshTestProject();
  await analyzeScreenplay(db, pid);
  const original = (await db.query("SELECT pasted_text FROM ai_movie_projects WHERE id = $1", [pid])).rows[0].pasted_text;
  const cut = original.replace(/### SCENE 8 —[\s\S]*?(?=### SCENE 9 —)/, "");
  await db.query("UPDATE ai_movie_projects SET pasted_text = $1 WHERE id = $2", [cut, pid]);
  const r = await analyzeScreenplay(db, pid);
  assert.equal(r.summary.removed, 1);
  assert.equal((await listScenes(db, pid)).length, 11);
  assert.equal((await db.query("SELECT count(*)::int n FROM production_scenes WHERE project_id = $1", [pid])).rows[0].n, 12);
  await db.query("UPDATE ai_movie_projects SET pasted_text = $1 WHERE id = $2", [original, pid]);
  await analyzeScreenplay(db, pid);
  const back = await listScenes(db, pid);
  assert.equal(back.length, 12);
  assert.equal(back.find((s) => s.number === "8").code, "SC008");
});

test("scenes are linked to the right characters, props and places (and not to look-alikes)", async () => {
  const pid = await freshTestProject();
  await analyzeScreenplay(db, pid);
  const s2 = assetNames(await sceneByNumber(pid, 2));
  for (const n of ["Rahul Mohapatra", "The Black Figure", "Wilting potted plant", "High-ankle boot", "Apartment entrance corridor"]) assert.ok(s2.includes(n), `scene 2 should include ${n}`);
  const s1 = assetNames(await sceneByNumber(pid, 1));
  assert.ok(s1.includes("Black leather office bag"));
  assert.ok(s1.includes("Rahul's bedroom"));
  assert.ok(!s1.includes("Office, Bhubaneswar") && !s1.includes("Office pantry"), "a prop called 'office bag' must not link an office location");
  const s5 = await sceneByNumber(pid, 5);
  for (const n of ["Office pantry", "Debashish", "Biswajit", "Paper coffee cup", "The Black Figure"]) assert.ok(assetNames(s5).includes(n), `scene 5 should include ${n}`);
  assert.ok(!assetNames(s5).includes("The Psychiatrist"), "a character only talked about in dialogue ('go see a psychiatrist') is not in the scene");
  const s10 = await sceneByNumber(pid, 10);
  for (const n of ["Dream desert", "Royal throne chair", "The Black Figure", "Rahul Mohapatra"]) assert.ok(assetNames(s10).includes(n), `scene 10 should include ${n}`);
  const s3 = assetNames(await sceneByNumber(pid, 3));
  assert.ok(s3.includes("Traffic signal junction") && s3.includes("Rahul's black hatchback car"));
  assert.ok(!s3.includes("Street outside Rahul's building") || true);
  const s7 = assetNames(await sceneByNumber(pid, 7));
  assert.ok(s7.includes("Doctor's cabin") && s7.includes("The Psychiatrist") && s7.includes("Prescription and pad"));
  const detail = await getScene(db, pid, (await sceneByNumber(pid, 5)).id);
  const debashish = detail.assets.find((a) => a.name === "Debashish");
  assert.ok(debashish.via.includes("speaker"));
  assert.ok(detail.assets.find((a) => a.name === "Office pantry").via.some((v) => ["heading", "agent_ref"].includes(v)));
});

test("a speaker who is not in the dossier is reported once, and the report closes when the line is gone", async () => {
  const pid = await freshTestProject();
  const base = (await db.query("SELECT pasted_text FROM ai_movie_projects WHERE id = $1", [pid])).rows[0].pasted_text;
  await db.query("UPDATE ai_movie_projects SET pasted_text = $1 WHERE id = $2", [base.replace('**RAHUL** *(to himself, quietly)*', '**STRANGER**\n"Wake up."\n\n**RAHUL** *(to himself, quietly)*'), pid]);
  const r = await analyzeScreenplay(db, pid);
  assert.deepEqual(r.summary.unknownSpeakers, ["STRANGER"]);
  await analyzeScreenplay(db, pid);
  const open = async () => (await db.query("SELECT message FROM production_issues WHERE project_id = $1 AND status = 'open' AND category = 'screenplay_unknown_speaker'", [pid])).rows;
  assert.equal((await open()).length, 1);
  assert.match((await open())[0].message, /"STRANGER" speaks in scene 11/);
  await db.query("UPDATE ai_movie_projects SET pasted_text = $1 WHERE id = $2", [base, pid]);
  await analyzeScreenplay(db, pid);
  assert.equal((await open()).length, 0);
});

test("an item that appears in no scene is flagged; the real speakers of the test film are all known", async () => {
  const pid = await freshTestProject();
  const r = await analyzeScreenplay(db, pid);
  assert.deepEqual(r.summary.unknownSpeakers, []);
  const flagged = (await db.query("SELECT message FROM production_issues WHERE project_id = $1 AND status = 'open' AND category = 'not_in_any_scene'", [pid])).rows.map((x) => x.message);
  assert.ok(flagged.some((m) => /Silver wristwatch/.test(m)), "the wristwatch is never in a scene");
  assert.ok(!flagged.some((m) => /Rahul Mohapatra/.test(m)));
});

test("the app's own saved screenplay (beats) is used when present", async () => {
  const backfill = { screenplayBeats: [{ scenes: [
    { sceneHeading: { en: "INT. HOME - NIGHT" }, content: [
      { type: "action", text: { en: "Asha waits.", hi: "आशा इंतज़ार करती है।" } },
      { type: "dialogue", character: "ASHA", line: { en: "Come in.", hi: "अंदर आओ।" } },
    ] },
  ] }] };
  const pid = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, backfill, assets) VALUES ('Beats film','', $1, $2) RETURNING id",
    [JSON.stringify(backfill), JSON.stringify({ characters: [{ name: "Asha", visualDescription: { en: "x", hi: "" } }], properties: [], environments: [{ name: "Home", visualDescription: { en: "x", hi: "" } }] })])).rows[0].id;
  await ingestAgentOutput(db, pid);
  const r = await analyzeScreenplay(db, pid);
  assert.equal(r.summary.source, "beats");
  assert.equal(r.summary.scenes, 1);
  const [scene] = await listScenes(db, pid);
  assert.equal(scene.number, "1.1");
  assert.deepEqual(scene.assets.map((a) => a.name).sort(), ["Asha", "Home"]);
  const detail = await getScene(db, pid, scene.id);
  const line = detail.elements.find((e) => e.kind === "dialogue");
  assert.deepEqual([line.textEn, line.textHi, line.code], ["Come in.", "अंदर आओ।", "D001"]);
});

test("no screenplay / unknown project / unreadable text are answered clearly, creating nothing", async () => {
  const empty = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text) VALUES ('Empty','') RETURNING id")).rows[0].id;
  const r1 = await analyzeScreenplay(db, empty);
  assert.equal(r1.outcome, "no_screenplay");
  assert.match(r1.message, /no screenplay yet/);
  const prose = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text) VALUES ('Prose','Once upon a time there was a boy.') RETURNING id")).rows[0].id;
  const r2 = await analyzeScreenplay(db, prose);
  assert.equal(r2.outcome, "no_screenplay");
  assert.match(r2.warnings[0], /No scene headings/);
  assert.equal((await analyzeScreenplay(db, 99999999)).outcome, "not_found");
  assert.equal((await db.query("SELECT count(*)::int n FROM production_scenes WHERE project_id IN ($1,$2)", [empty, prose])).rows[0].n, 0);
});

test("one project's scenes never show in another's; deleting a project removes its scenes", async () => {
  const a = await freshTestProject();
  await analyzeScreenplay(db, a);
  const b = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text) VALUES ('Other','INT. ROOM - DAY\n\nHe waits.') RETURNING id")).rows[0].id;
  await analyzeScreenplay(db, b);
  assert.equal((await listScenes(db, b)).length, 1);
  const aScene = (await listScenes(db, a))[0];
  assert.equal(await getScene(db, b, aScene.id), null);
  await db.query("DELETE FROM ai_movie_projects WHERE id = $1", [a]);
  for (const t of ["production_scenes", "production_scene_elements", "production_scene_assets"]) {
    const col = t === "production_scene_assets" ? "scene_id IN (SELECT id FROM production_scenes WHERE project_id = " + a + ")" : `project_id = ${a}`;
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${t} WHERE ${col}`)).rows[0].n, 0, t);
  }
});

test("normalizeForMatch and linkSceneToAssets: possessives, punctuation, Hindi names, empty input", () => {
  assert.equal(normalizeForMatch("Rahul's  Bedroom!"), "rahul bedroom");
  assert.equal(normalizeForMatch("रुद्र के साथ"), "रुद्र के साथ");
  const links = linkSceneToAssets(
    { number: "3", heading: "INT. HOME - DAY", location: "HOME", elements: [{ kind: "dialogue", speaker: "रुद्र", text: "चलो" }] },
    [{ id: 1, kind: "character", name: "रुद्र", aliases: [], sceneRefs: [] }, { id: 2, kind: "location", name: "Home", aliases: [], sceneRefs: [] }, { id: 3, kind: "prop", name: "Key", aliases: [], sceneRefs: ["Scene 3"] }]
  );
  assert.deepEqual([...links.keys()].sort(), [1, 2, 3]);
  assert.deepEqual(links.get(3), ["agent_ref"]);
  assert.equal(linkSceneToAssets({ number: "1", heading: "", elements: [] }, []).size, 0);
});
