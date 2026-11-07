// A finished screenplay's text -> scenes (headings, speakers, brackets, dialogue, action, transitions) -> placed into the beats; no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { parseScreenplayText, toAiMovieScenes, assignScenesToBeats } from "../screenplayTextParser.js";

const SCRIPT = `AKHADA

Written by Someone

FADE IN:

1. INT. AKHADA RING - DAWN

Mist over the sand. Rakhyaka tapes his hands.
He looks up.

RAKHYAKA
(quietly)
तुम आ गए?

SHREYA (V.O.)
हाँ।
मैं देर से आई।

CUT TO:

2. EXT. VILLAGE LANE - DAY 2

Children run past a wall of posters.

KAAL
Yeh akhada ab mera hai.

                                                  (CONTINUED)
12.

3. INT./EXT. JEEP - MOVING - NIGHT

Headlights cut the dark.
`;

test("headings, action, speakers with brackets and extensions, transitions; the title page and page numbers are ignored", () => {
  const scenes = parseScreenplayText(SCRIPT);
  assert.deepEqual(scenes.map((s) => s.heading), ["INT. AKHADA RING - DAWN", "EXT. VILLAGE LANE - DAY", "INT./EXT. JEEP - MOVING - NIGHT"]);
  assert.deepEqual(scenes[0].blocks[0], { type: "action", text: "Mist over the sand. Rakhyaka tapes his hands. He looks up." });
  assert.deepEqual(scenes[0].blocks[1], { type: "dialogue", character: "RAKHYAKA", parenthetical: "quietly", text: "तुम आ गए?" });
  assert.deepEqual(scenes[0].blocks[2], { type: "dialogue", character: "SHREYA", parenthetical: "", text: "हाँ। मैं देर से आई।" });
  assert.deepEqual(scenes[0].blocks[3], { type: "transition", text: "CUT TO" });
  assert.equal(scenes[1].blocks[1].character, "KAAL");
  assert.equal(scenes[2].blocks.length, 1);
});

test("an inline speaker (\"MIRA Step back!\") is read only for names the story knows", () => {
  const text = "INT. TEMPLE - DAY\n\nMIRA Step back!\nShe raises the sword.\n\nSTORM clouds gather over the roof.\n";
  const without = parseScreenplayText(text);
  assert.equal(without[0].blocks.length, 2); assert.ok(without[0].blocks.every((b) => b.type === "action"));
  const withNames = parseScreenplayText(text, { knownCharacters: ["Mira"] });
  assert.equal(withNames[0].blocks[0].type, "dialogue"); assert.equal(withNames[0].blocks[0].character, "MIRA");
  assert.equal(withNames[0].blocks[0].text, "Step back! She raises the sword.");
  assert.equal(withNames[0].blocks.at(-1).type, "action", "STORM is a capital word, not a speaker");
});

test("no scene heading at all gives no scenes", () => {
  assert.deepEqual(parseScreenplayText("Just some notes.\n\nNo headings here."), []);
});

test("the scenes take the AI Movie shape: both language slots hold the written text, speakers and brackets kept", () => {
  const out = toAiMovieScenes(parseScreenplayText(SCRIPT));
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].sceneHeading, { en: "INT. AKHADA RING - DAWN", hi: "INT. AKHADA RING - DAWN" });
  assert.deepEqual(out[0].content[1], { type: "dialogue", character: "RAKHYAKA", line: { en: "तुम आ गए?", hi: "तुम आ गए?" }, parenthetical: { en: "quietly", hi: "quietly" } });
  assert.deepEqual(out[0].content[3], { type: "transition", transition: "CUT TO" });
});

test("scenes are placed into beats in order: by running time, every beat gets at least one scene, nothing is lost or reordered", () => {
  const minutes = Array.from({ length: 20 }, () => 1);
  const groups = assignScenesToBeats(minutes, [5, 5, 10]); // 25% / 25% / 50%
  assert.deepEqual(groups.map((g) => g.length), [5, 5, 10]);
  assert.deepEqual(groups.flat(), Array.from({ length: 20 }, (_, i) => i));
  const tight = assignScenesToBeats([1, 1, 1], [100, 1, 1]); // a huge first beat must leave a scene for each later beat
  assert.deepEqual(tight.map((g) => g.length), [1, 1, 1]);
  const many = assignScenesToBeats(Array.from({ length: 126 }, () => 1), Array.from({ length: 46 }, () => 2));
  assert.ok(many.every((g) => g.length >= 1)); assert.equal(many.flat().length, 126); assert.deepEqual(many.flat(), Array.from({ length: 126 }, (_, i) => i));
  assert.throws(() => assignScenesToBeats([1, 1], [1, 1, 1]), /every beat needs at least one scene/);
  assert.throws(() => assignScenesToBeats([1], []), /no beat sheet/);
});
