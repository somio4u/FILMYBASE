import test from "node:test";
import assert from "node:assert/strict";
import { buildScreenplayPlainText, countScenes } from "../screenplayText.js";

const deck = { title: { en: "Mahakali" }, logline: { en: "A priest vs a landlord." }, episodes: [{ title: { en: "Fire" } }, { title: { en: "Ash" } }] };
const scene = (loc) => ({ intExt: "INT", location: { en: loc }, timeOfDay: "NIGHT" });
const row = (i, elements) => ({ scene_index: i, content: { elements } });
const els = [
  { type: "action", text: "Soumya lights the lamp." },
  { type: "dialogue", character: "Soumya", parenthetical: "softly", text: "Where is the idol?" },
  { type: "transition", text: "cut to:" },
];

test("film screenplay becomes plain screenplay text", () => {
  const sceneList = { scenes: [scene("Temple"), scene("Village")] };
  const out = buildScreenplayPlainText({ deck, sceneList, scenesByEpisode: new Map([[null, [row(0, els)]]]) });
  assert.match(out, /^Mahakali\n\nA priest vs a landlord\./);
  assert.match(out, /SCENE 1 — INT\. TEMPLE — NIGHT\nSoumya lights the lamp\.\nSOUMYA\n\(softly\)\nWhere is the idol\?\nCUT TO:/);
  assert.doesNotMatch(out, /VILLAGE/); // a scene not yet written is left out
  assert.equal(countScenes(sceneList), 2);
});

test("series screenplay is split by episode", () => {
  const sceneList = { episodeScenes: [{ scenes: [scene("Temple")] }, { scenes: [scene("Ghat")] }] };
  const out = buildScreenplayPlainText({ deck, sceneList, scenesByEpisode: new Map([[0, [row(0, els)]], [1, [row(0, els)]]]) });
  assert.match(out, /EPISODE 1: FIRE/);
  assert.match(out, /EPISODE 2: ASH/);
  assert.equal(countScenes(sceneList), 2);
});

test("old scenes stored as {en,or,hi} objects read as English text, not [object Object]", () => {
  const out = buildScreenplayPlainText({ deck, sceneList: { scenes: [scene("Temple")] }, scenesByEpisode: new Map([[null, [row(0, [{ type: "action", text: { en: "Hello", or: "ନମସ୍କାର" } }])]]]) });
  assert.match(out, /Hello/);
  assert.doesNotMatch(out, /object Object/);
});

import { parseScreenplayText } from "../screenplayParse.js";
test("the text made here is read back by Production's own screenplay reader, scene for scene", () => {
  const sceneList = { scenes: [scene("Temple"), scene("Village")] };
  const out = buildScreenplayPlainText({ deck, sceneList, scenesByEpisode: new Map([[null, [row(0, els), row(1, els)]]]) });
  const parsed = parseScreenplayText(out);
  assert.equal(parsed.scenes.length, 2);
  assert.ok(parsed.scenes[0].elements.some((e) => e.kind === "dialogue" && e.speaker === "SOUMYA"));
});
test("production reads numbered headings as finished scripts print them", () => {
  const parsed = parseScreenplayText("12. INT. TEMPLE - NIGHT\nShe waits.\n\n13A EXT. VILLAGE - DAY\nHe runs.");
  assert.deepEqual(parsed.scenes.map((s) => s.number), ["12", "13A"]);
});
