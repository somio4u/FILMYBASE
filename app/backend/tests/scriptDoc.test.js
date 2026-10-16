import test from "node:test";
import assert from "node:assert/strict";
import { linesFromElements, elementsFromLines, cleanForSave, nextType, cycleType, matchNames, splitModifier, collectCharacterNames } from "../../frontend/src/scriptDoc.js";

const sample = [
  { type: "action", character: "", characterModifier: "none", parenthetical: "", text: "A jeep rolls on." },
  { type: "dialogue", character: "JAGANNATH", characterModifier: "V.O.", parenthetical: "softly", text: "Come.\nNow." },
  { type: "transition", character: "", characterModifier: "none", parenthetical: "", text: "CUT TO:" },
  { type: "flashback", character: "ROHAN", characterModifier: "none", parenthetical: "", text: "Years ago." },
];

test("elements -> lines -> elements gives back the same screenplay", () => {
  const lines = linesFromElements(sample);
  assert.deepEqual(lines.map((l) => l.t), ["action", "character", "parenthetical", "dialogue", "dialogue", "transition", "flashback"]);
  assert.equal(lines[1].text, "JAGANNATH (V.O.)");
  const { elements, lineToElement } = elementsFromLines(lines);
  assert.deepEqual(elements, sample);
  assert.deepEqual(lineToElement, [0, 1, 1, 1, 1, 2, 3]);
});

test("a dialogue line without a character above it is saved as action; a stray parenthetical keeps its brackets", () => {
  const { elements } = elementsFromLines([{ t: "dialogue", text: "Hello" }, { t: "parenthetical", text: "(smiling)" }]);
  assert.deepEqual(elements.map((e) => [e.type, e.text]), [["action", "Hello"], ["action", "(smiling)"]]);
});

test("typing a character line makes a dialogue: name in capitals, modifier split off, empty speech not saved", () => {
  const { elements } = elementsFromLines([{ t: "character", text: "meera (o.s.)" }, { t: "dialogue", text: "Who is there?" }, { t: "character", text: "ROHAN" }, { t: "dialogue", text: "" }, { t: "action", text: "   " }]);
  assert.equal(elements[0].character, "MEERA");
  assert.equal(elements[0].characterModifier, "O.S.");
  assert.equal(elements[0].text, "Who is there?");
  assert.deepEqual(cleanForSave(elements).map((e) => e.character || e.type), ["MEERA"]);
});

test("Enter and Tab: what the next line is", () => {
  assert.equal(nextType("character"), "dialogue");
  assert.equal(nextType("parenthetical"), "dialogue");
  assert.equal(nextType("dialogue"), "action");
  assert.equal(nextType("dialogue", true), "dialogue");
  assert.equal(nextType("action"), "action");
  assert.equal(cycleType("action"), "character");
  assert.equal(cycleType("action", true), "transition");
});

test("typing J offers every character with J (start of the name or of any word of it)", () => {
  const names = ["JAGANNATH", "OLD DEVOTEE", "ELDER PRIEST", "RAJA JAYA", "MEERA"];
  assert.deepEqual(matchNames("j", names), ["JAGANNATH", "RAJA JAYA"]);
  assert.deepEqual(matchNames("d", names), ["OLD DEVOTEE"]);
  assert.deepEqual(matchNames("", names), []);
  assert.deepEqual(matchNames("MEERA", names), []);
  assert.deepEqual(splitModifier("RAHUL (CONT'D)"), { name: "RAHUL", modifier: "CONT'D" });
});

test("the project's characters are collected from the sheet, the scene list and the written scenes", () => {
  const out = collectCharacterNames({ sheetNames: ["Jagannath"], sceneListNames: ["Old Devotee"], drafts: [{ charactersPresent: ["ELDER PRIEST"], elements: [{ type: "dialogue", character: "MEERA" }, { type: "action" }] }] });
  assert.deepEqual(out, ["ELDER PRIEST", "JAGANNATH", "MEERA", "OLD DEVOTEE"]);
});
