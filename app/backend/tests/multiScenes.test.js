import test from "node:test";
import assert from "node:assert/strict";
import { splitSceneContexts } from "../../frontend/src/sceneContexts.js";
import { cleanPlan, defaultMinutes, planPrompt } from "../multiScenes.js";

test("numbered lines or blank lines cut the box into scenes; a single paragraph stays one scene; the words are kept", () => {
  assert.deepEqual(splitSceneContexts("1. Four friends reach the palace.\n2) Rohan finds a door.\nIt is locked.\n3- They run."), ["Four friends reach the palace.", "Rohan finds a door. It is locked.", "They run."]);
  assert.deepEqual(splitSceneContexts("Scene 1: A jeep arrives.\n\nScene 2: The gate opens."), ["A jeep arrives.", "The gate opens."]);
  assert.deepEqual(splitSceneContexts("A jeep arrives at night.\nThe friends step out.\n\nRohan knocks on the gate."), ["A jeep arrives at night. The friends step out.", "Rohan knocks on the gate."]);
  assert.deepEqual(splitSceneContexts("Only one paragraph here\nsplit over two lines"), ["Only one paragraph here split over two lines"]);
  assert.deepEqual(splitSceneContexts("  \n\n "), []);
  assert.deepEqual(splitSceneContexts("1. ଜଗନ୍ନାଥ ମନ୍ଦିର ଯାଏ।\n2. ମାଳତୀ ଘରେ ଅଛି।"), ["ଜଗନ୍ନାଥ ମନ୍ଦିର ଯାଏ।", "ମାଳତୀ ଘରେ ଅଛି।"]);
  assert.equal(splitSceneContexts(Array.from({ length: 40 }, (_, i) => `${i + 1}. s`).join("\n")).length, 30, "at most 30 at a time");
});

test("the heading plan: missing or odd answers fall back to plain editable defaults; length follows the context", () => {
  const contexts = ["A jeep arrives at the palace gate at night.", "x ".repeat(60)];
  const plan = cleanPlan({ scenes: [{ intExt: "ext", location: "palace gate", timeOfDay: "night" }, { intExt: "??", location: "", timeOfDay: "" }] }, contexts);
  assert.deepEqual(plan[0], { intExt: "EXT", location: "PALACE GATE", timeOfDay: "NIGHT", estimatedMinutes: 1 });
  assert.deepEqual(plan[1], { intExt: "INT", location: "LOCATION", timeOfDay: "DAY", estimatedMinutes: 3 });
  assert.equal(cleanPlan(null, contexts).length, 2);
  assert.equal(defaultMinutes("one two three"), 1);
  assert.match(planPrompt(contexts), /exactly 2 entries/);
  assert.match(planPrompt(contexts), /Do NOT rewrite, extend/);
});
