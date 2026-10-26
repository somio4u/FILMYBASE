import test from "node:test";
import assert from "node:assert/strict";
import { formatFinalDraft } from "../finalDraftFormat.js";

test("character names, parentheticals and transitions follow Final Draft; words are never changed", () => {
  const out = formatFinalDraft([
    { type: "action", text: "  Rahul   enters.  " },
    { type: "dialogue", character: "rahul ", text: "Come   here.", parenthetical: "(Angrily)", characterModifier: "none" },
    { type: "transition", text: "cut to" },
    { type: "transition", text: "fade out" },
    { type: "transition", text: "the end" },
  ]);
  assert.equal(out[0].text, "Rahul enters.");
  assert.equal(out[1].character, "RAHUL");
  assert.equal(out[1].text, "Come here.");
  assert.equal(out[1].parenthetical, "angrily");
  assert.deepEqual(out.slice(2).map((e) => e.text), ["CUT TO:", "FADE OUT.", "THE END"]);
});

test("(CONT'D) only when the same speaker continues after action with no one else between", () => {
  const d = (character, text) => ({ type: "dialogue", character, text, characterModifier: "none" });
  const a = { type: "action", text: "He looks away." };
  const out = formatFinalDraft([d("RAHUL", "One."), a, d("RAHUL", "Two."), d("RAHUL", "Three."), a, d("MEERA", "Four."), a, d("RAHUL", "Five.")]);
  assert.deepEqual(out.filter((e) => e.type === "dialogue").map((e) => e.characterModifier), ["none", "CONT'D", "none", "none", "none"]);
});

test("Odia / Hindi text and a modifier already set are left alone", () => {
  const out = formatFinalDraft([{ type: "dialogue", character: "ସୌମ୍ୟା", text: "ଆସ।", parenthetical: "(ଧୀରେ)", characterModifier: "V.O." }, { type: "action", text: "x" }, { type: "dialogue", character: "ସୌମ୍ୟା", text: "ଯା।", characterModifier: "V.O." }]);
  assert.equal(out[0].parenthetical, "ଧୀରେ");
  assert.equal(out[2].characterModifier, "V.O.");
  assert.deepEqual(formatFinalDraft(undefined), []);
});
