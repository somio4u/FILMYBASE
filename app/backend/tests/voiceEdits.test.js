import test from "node:test";
import assert from "node:assert/strict";
import { applyVoiceEdits, cleanEdits } from "../voiceEdits.js";

const el = (type, character, text) => ({ type, character, characterModifier: "none", parenthetical: "", text });
const scene = [el("action", "", "Night. The square is lit."), el("dialogue", "OLD DEVOTEE", "Jaya Maa Kali!"), el("dialogue", "ELDER PRIEST", "The night is long."), el("action", "", "The priest nods.")];

test("a plain insert still works (after the line the writer named)", () => {
  const out = applyVoiceEdits(scene, { insert: [el("dialogue", "meera", "Who is there?")], insertAfter: 2 });
  assert.deepEqual(out.elements.map((e) => e.text), ["Night. The square is lit.", "Jaya Maa Kali!", "Who is there?", "The night is long.", "The priest nods."]);
  assert.equal(out.elements[2].character, "MEERA");
  assert.equal(out.counts.added, 1);
});

test("change a dialogue by its line number; delete a line; the other lines are untouched", () => {
  const out = applyVoiceEdits(scene, { insert: [], edits: [{ action: "replace", line: 3, text: "The day is long.", character: "" }, { action: "delete", line: 4 }] });
  assert.deepEqual(out.elements.map((e) => e.text), ["Night. The square is lit.", "Jaya Maa Kali!", "The day is long."]);
  assert.deepEqual(out.counts, { added: 0, changed: 1, removed: 1, rewrote: false });
});

test("remove a character from the scene: every line they speak goes; renaming keeps the lines", () => {
  const removed = applyVoiceEdits(scene, { edits: [{ action: "remove_character", character: "elder priest" }] });
  assert.equal(removed.elements.filter((e) => e.character === "ELDER PRIEST").length, 0);
  assert.equal(removed.counts.removed, 1);
  assert.deepEqual(removed.removedCharacters, ["ELDER PRIEST"]);
  const renamed = applyVoiceEdits(scene, { edits: [{ action: "rename_character", character: "OLD DEVOTEE", to: "Jagannath" }] });
  assert.equal(renamed.elements[1].character, "JAGANNATH");
  assert.equal(renamed.elements[1].text, "Jaya Maa Kali!");
});

test("rewriting the whole scene replaces it; speakers that vanished are reported", () => {
  const out = applyVoiceEdits(scene, { rewritten: [el("action", "", "Day. The square is busy."), el("dialogue", "OLD DEVOTEE", "Jaya Maa Kali!")] });
  assert.equal(out.counts.rewrote, true);
  assert.equal(out.elements.length, 2);
  assert.deepEqual(out.removedCharacters, ["ELDER PRIEST"]);
});

test("bad edits are ignored, not applied", () => {
  assert.deepEqual(cleanEdits([{ action: "delete", line: 0 }, { action: "explode", line: 1 }, { action: "replace", line: "x" }, { action: "remove_character", character: "  " }]), []);
  const out = applyVoiceEdits(scene, { edits: [{ action: "delete", line: 99 }] });
  assert.equal(out.elements.length, 4);
});
