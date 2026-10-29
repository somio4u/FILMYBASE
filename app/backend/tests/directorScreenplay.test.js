import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import AdmZip from "adm-zip";
import ScriptAwarePDF from "../mixedScriptPdf.js";
import { directorScenes, writeDirectorPdf, buildDirectorDocx, CUT_TO, DIRECTOR_LAYOUT } from "../directorScreenplay.js";

const { Packer } = createRequire(import.meta.url)("docx");
const FONTS = { odiaRegular: new URL("../fonts/NotoSansOriya.ttf", import.meta.url).pathname, hindiRegular: new URL("../fonts/NotoSansDevanagari-Regular.ttf", import.meta.url).pathname };

const action = (text) => ({ type: "action", text });
const dialogue = (character, text, extra = {}) => ({ type: "dialogue", character, characterModifier: "none", parenthetical: "", text, ...extra });
const film = () => ({
  deck: { episodes: [] },
  sceneList: { scenes: [{ intExt: "INT", location: { en: "Kali Temple" }, timeOfDay: "DAY" }, { intExt: "EXT", location: { en: "Road" }, timeOfDay: "NIGHT" }] },
  rows: new Map([[null, [
    { scene_index: 0, content: { charactersPresent: ["A", "B"], elements: [action("ସକାଳ।"), dialogue("A", "Hello", { parenthetical: "softly" })] } },
    { scene_index: 1, content: { charactersPresent: ["B"], elements: [action("Road."), { type: "transition", text: "FADE OUT." }] } },
  ]]]),
});
const series = () => ({
  deck: { episodes: [{ title: { en: "One" } }, { title: { en: "Two" } }] },
  sceneList: { episodeScenes: [{ scenes: [{ intExt: "INT", location: { en: "A" }, timeOfDay: "DAY" }] }, { scenes: [{ intExt: "EXT", location: { en: "B" }, timeOfDay: "DAY" }, { intExt: "EXT", location: { en: "C" }, timeOfDay: "DAY" }] }] },
  rows: new Map([
    [0, [{ scene_index: 0, content: { elements: [action("e1s1")] } }]],
    [1, [{ scene_index: 0, content: { elements: [action("e2s1")] } }, { scene_index: 1, content: { elements: [action("e2s2")] } }]],
  ]),
});

test("every scene ends with Cut to...., unless it already ends with its own transition; the screenplay's lines are kept as they are", () => {
  const f = film();
  const scenes = directorScenes(f.deck, f.sceneList, f.rows);
  assert.equal(scenes.length, 2);
  assert.deepEqual(scenes[0].elements.map((e) => e.text), ["ସକାଳ।", "Hello", CUT_TO]);
  assert.equal(scenes[0].elements[1].parenthetical, "softly");
  assert.deepEqual(scenes[1].elements.map((e) => e.text), ["Road.", "FADE OUT."]); // already closed by its own transition: nothing added
  assert.equal(CUT_TO, "Cut to....");
  // the saved scene itself is not touched
  assert.equal(f.rows.get(null)[0].content.elements.length, 2);
});

test("scenes are listed per episode, with the episode marked where it starts; a scene not written yet is skipped", () => {
  const s = series();
  const all = directorScenes(s.deck, s.sceneList, s.rows);
  assert.deepEqual(all.map((x) => [x.episodeIndex, x.number, x.firstInEpisode]), [[0, 1, true], [1, 1, true], [1, 2, false]]);
  assert.equal(all[0].episodeTitle, "One");
  assert.deepEqual(directorScenes(s.deck, s.sceneList, s.rows, { onlyEpisode: 1 }).map((x) => x.location), ["B", "C"]);
  s.rows.set(1, [s.rows.get(1)[0]]); // the second scene of episode 2 is not written
  assert.equal(directorScenes(s.deck, s.sceneList, s.rows, { onlyEpisode: 1 }).length, 1);
});

test("PDF: a page per scene, Pg- N on every page, and nothing of the scene body is printed in the left part of the page", async () => {
  const s = series();
  const scenes = directorScenes(s.deck, s.sceneList, s.rows);
  const doc = new ScriptAwarePDF({ size: "A4", margin: 50, bufferPages: true });
  const printed = [];
  const original = doc.text.bind(doc);
  doc.text = (text, ...args) => { printed.push({ text: String(text), x: typeof args[0] === "number" ? args[0] : null }); return original(text, ...args); };
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const finished = new Promise((resolve) => doc.on("end", resolve));
  writeDirectorPdf(doc, scenes, { fonts: FONTS });
  doc.end();
  await finished;
  const pdf = Buffer.concat(chunks).toString("latin1");
  assert.equal((pdf.match(/\/Type \/Page\b/g) ?? []).length, 3);
  for (const n of [1, 2, 3]) assert.ok(printed.some((p) => p.text === `Pg- ${n}`), `Pg- ${n}`);
  for (const line of ["(e1s1)", "(e2s1)", "(e2s2)", CUT_TO]) {
    const hit = printed.find((p) => p.text === line);
    assert.ok(hit, line);
    assert.ok(hit.x >= DIRECTOR_LAYOUT.nameX, `${line} starts at x=${hit.x}: the left part of the page must stay empty`);
  }
});

test("Word: the same layout as a table whose first column is empty, every scene ending with Cut to....", async () => {
  const f = film();
  const buffer = await Packer.toBuffer(buildDirectorDocx(directorScenes(f.deck, f.sceneList, f.rows)));
  const xml = new AdmZip(buffer).readAsText("word/document.xml");
  for (const part of ["SCENE - 01", "SCENE - 02", "Kali Temple / Int", "ସକାଳ।", "(softly) Hello", CUT_TO, "FADE OUT."]) assert.ok(xml.includes(part), part);
  assert.ok(xml.includes("<w:tbl>"));
  assert.equal((xml.match(/Cut to\.\.\.\./g) ?? []).length, 1); // scene 2 keeps its own FADE OUT.
  assert.match(new AdmZip(buffer).readAsText("word/footer1.xml"), /Pg-/);
});

test("nothing written yet: the file says so instead of failing", async () => {
  const doc = new ScriptAwarePDF({ size: "A4", margin: 50, bufferPages: true });
  doc.on("data", () => {});
  const finished = new Promise((resolve) => doc.on("end", resolve));
  writeDirectorPdf(doc, [], { fonts: FONTS });
  doc.end();
  await finished;
  const buffer = await Packer.toBuffer(buildDirectorDocx([]));
  assert.ok(new AdmZip(buffer).readAsText("word/document.xml").includes("No scene of this screenplay has been written yet."));
});
