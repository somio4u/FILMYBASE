import test from "node:test";
import assert from "node:assert/strict";
import { analyzeImportedText, reportLines, sceneState } from "../importAnalysis.js";

// a screenplay in the layout of the Mahakali export: Odia action and dialogue, English capitals for headings and speakers
const PARTLY_WRITTEN = `EPISODE 1: ମହାକାଳୀ
SCENE 1
INT. TEMPLE COMMITTEE OFFICE - NIGHT
ବଳରାମ ପୂଜକ ଜଗନ୍ନାଥଙ୍କୁ ଚାହିଁ ରହିଛି। ଟେବୁଲ ଉପରେ କାଗଜ ଖିନ୍ନ।
BALARAM
(ଧୀରେ)
ମନ୍ଦିର ଜମି ଦେଇଦିଅ, ଜଗନ୍ନାଥ।
JAGANNATH
ମୁଁ ମରିଯିବି, ତଥାପି ଦେବି ନାହିଁ।
Cut to....
SCENE 2
EXT. OLD KALI TEMPLE - NIGHT
ବଳରାମ ଓ ତାର ସାଙ୍ଗମାନେ ମନ୍ଦିରରେ ପଶିଲେ।
SCENE 3
EXT. VILLAGE ROAD - NIGHT
ମାତାଲ ଦେବା ଅନ୍ଧାର ରାସ୍ତାରେ ଡରୁଛି।
DEBA
କିଏ ଅଛୁ ସେଠି?
`;

test("a screenplay with some scenes written and some only one-liners: both groups are reported, nothing dropped", () => {
  const a = analyzeImportedText(PARTLY_WRITTEN);
  assert.equal(a.stage, "screenplay");
  assert.match(a.language, /Odia/);
  assert.equal(a.totals.scenes, 3);
  assert.equal(a.totals.written, 2); // scene 1 and 3 have dialogue
  assert.equal(a.totals.oneLiner, 1); // scene 2: one action line only
  assert.equal(a.totals.dialogueLines, 3);
  assert.deepEqual(a.scenes.map((s) => s.state), ["written", "one_liner", "written"]);
  assert.deepEqual(a.characters.map((c) => c.name).sort(), ["BALARAM", "DEBA", "JAGANNATH"]);
  assert.equal(a.characters.length, 3);
  const text = reportLines(a).join("\n");
  assert.match(text, /Screenplay stage/);
  assert.match(text, /3 scenes/);
  assert.match(text, /2 are written out/);
  assert.match(text, /1 has only a one-line summary/);
  assert.match(text, /If you make your project from this draft[^]*word for word/);
  assert.match(text, /the 1 one-liner scene go in as “not written yet”/);
});

test("a numbered list of scene headings with one-liners is the scene one-liners stage (no dialogue to lose)", () => {
  const list = `1. INT. TEMPLE COMMITTEE OFFICE - NIGHT — Balaram pressures the upright priest Jagannath to surrender temple land.
2. EXT. OLD KALI TEMPLE - NIGHT — Balaram and his accomplices desecrate the temple.
3. EXT. VILLAGE ROAD - NIGHT — A drunken Deba is terrorized on a dark road.`;
  const a = analyzeImportedText(list);
  assert.equal(a.stage, "scene_list");
  assert.equal(a.totals.scenes, 3);
  assert.equal(a.totals.dialogueLines, 0);
  assert.match(a.scenes[0].oneLiner, /Balaram pressures/);
  assert.match(reportLines(a).join(" "), /none is lost/);
});

test("numbered beats without scene headings are a bit sheet", () => {
  const beats = Array.from({ length: 8 }, (_, i) => `${i + 1}. Something important happens to the hero in beat ${i + 1}.`).join("\n");
  const a = analyzeImportedText(beats);
  assert.equal(a.stage, "bit_sheet");
  assert.equal(a.beats, 8);
});

test("long prose with episode headings is a synopsis; a few lines is an idea", () => {
  const prose = `Episode 1\n${"A village priest guards the temple land while a rich man schemes to take it. ".repeat(40)}\nEpisode 2\n${"The goddess's eyes are stolen and the village suffers. ".repeat(20)}`;
  const s = analyzeImportedText(prose);
  assert.equal(s.stage, "synopsis");
  assert.equal(s.episodeHeadings, 2);
  assert.equal(analyzeImportedText("A priest fights to save a temple from a greedy man.").stage, "idea");
});

test("a list of people with descriptions is the character stage", () => {
  const people = [
    "JAGANNATH - An upright old priest of the Kali temple who has never taken a bribe in his life.",
    "BALARAM - A corrupt temple committee head who wants the temple land for a corporate project.",
    "DEBA - A drunken villager who sees things the others cannot, haunted by a guilty night.",
    "SOUMYA - A young woman possessed by the goddess who demands that the stolen eyes be returned.",
    "NAYANA - Soumya's elder sister, practical and afraid, who tries to keep the family safe.",
  ].join("\n");
  const a = analyzeImportedText(people);
  assert.equal(a.stage, "characters");
  assert.equal(a.people, 5);
});

test("empty input and the scene-state rule", () => {
  assert.equal(analyzeImportedText("   ").stage, "empty");
  assert.equal(sceneState({ elements: [] }).state, "empty");
  assert.equal(sceneState({ elements: [{ type: "action", text: "One short line." }] }).state, "one_liner");
  assert.equal(sceneState({ elements: [{ type: "dialogue", character: "A", text: "Hi" }] }).state, "written");
  assert.equal(sceneState({ elements: [1, 2, 3].map((n) => ({ type: "action", text: `Line ${n}.` })) }).state, "written");
});
