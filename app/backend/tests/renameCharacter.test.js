import test from "node:test";
import assert from "node:assert/strict";
import { renameInText, renameInElements, renameInScreenplay, renameInSceneList, validRename } from "../renameCharacter.js";

test("only the whole name changes, and the case style is kept", () => {
  assert.equal(renameInText("SULA walks in. Sula smiles; sula waits. SULATA and ASULA stay.", "sula", "Sulagna").text, "SULAGNA walks in. Sulagna smiles; sulagna waits. SULATA and ASULA stay.");
  assert.equal(renameInText("SULAଙ୍କ ମୁହଁ, ଓ SULA!", "Sula", "Sulagna").text, "SULAGNAଙ୍କ ମୁହଁ, ଓ SULAGNA!");
  assert.equal(renameInText("Sula's bag", "sula", "Sulagna").text, "Sulagna's bag");
  assert.equal(renameInText("(O.S.)", "sula", "Sulagna").count, 0);
  assert.equal(renameInText("MALA AND SULA", "MALA", "MALINI").text, "MALINI AND SULA");
  assert.equal(renameInText("a.b", "a.b", "c").text, "c", "special characters in a name are not patterns");
});

test("a scene: speakers, mentions in action and dialogue, acting notes, and the present-characters list", () => {
  const content = {
    elements: [
      { type: "action", character: "", text: "SULA (28, sari) enters. Rohan sees Sula." },
      { type: "dialogue", character: "SULA", characterModifier: "none", parenthetical: "to Sula's mother", text: "Ma, Sula is here." },
      { type: "dialogue", character: "ROHAN", text: "Welcome." },
      { type: "flashback", character: "SULA", text: "Years ago." },
    ],
    charactersPresent: ["SULA", "ROHAN"],
  };
  const r = renameInScreenplay(content, "Sula", "Sulagna");
  assert.equal(r.changed, true);
  assert.equal(r.speakers, 1);
  assert.deepEqual(r.content.charactersPresent, ["SULAGNA", "ROHAN"]);
  assert.equal(r.content.elements[0].text, "SULAGNA (28, sari) enters. Rohan sees Sulagna.");
  assert.equal(r.content.elements[1].character, "SULAGNA");
  assert.equal(r.content.elements[1].parenthetical, "to Sulagna's mother");
  assert.equal(r.content.elements[1].text, "Ma, Sulagna is here.");
  assert.equal(r.content.elements[2].character, "ROHAN");
  assert.equal(r.content.elements[3].character, "SULAGNA");
  assert.equal(renameInScreenplay({ elements: [{ type: "action", text: "Nothing here." }] }, "Sula", "Sulagna").changed, false);
});

test("the scene list outline and names change too", () => {
  const r = renameInSceneList({ scenes: [{ oneLiner: { en: "Sula meets Rohan", or: "SULA ଦେଖା କରେ" } }], characterNames: ["Sula", "ROHAN", "SULAGNA"] }, "sula", "Sulagna");
  assert.equal(r.content.scenes[0].oneLiner.en, "Sulagna meets Rohan");
  assert.equal(r.content.scenes[0].oneLiner.or, "SULAGNA ଦେଖା କରେ");
  assert.deepEqual(r.content.characterNames, ["SULAGNA", "ROHAN"]);
  assert.equal(r.count, 2);
});

test("a rename needs two different names", () => {
  assert.equal(validRename("sula", "Sulagna"), null);
  assert.match(validRename("", "x"), /old name and the new/);
  assert.match(validRename("Sula", "SULA"), /same/);
});
