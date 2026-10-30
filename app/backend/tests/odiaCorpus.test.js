import test from "node:test";
import assert from "node:assert/strict";
import { countOdiaWords, odiaWordsIn, textsOfScene, textsOfSceneList } from "../odiaCorpus.js";

test("Odia words are picked out of mixed text; English, digits and punctuation are not words", () => {
  assert.deepEqual(odiaWordsIn("INT. TEMPLE - NIGHT ମୁଁ ଆସିଲି। କିଏ ଅଛୁ ସେଠି? 12 abc"), ["ମୁଁ", "ଆସିଲି", "କିଏ", "ଅଛୁ", "ସେଠି"]);
  assert.deepEqual(odiaWordsIn(""), []);
  assert.deepEqual(odiaWordsIn(null), []);
  assert.deepEqual(odiaWordsIn("Hello world"), []);
  assert.deepEqual(odiaWordsIn("ମନ୍ଦିର, ଭୋଳ."), ["ମନ୍ଦିର", "ଭୋଳ"]); // conjuncts and signs stay inside the word
});

test("words are counted and the most used come first; the limit is respected", () => {
  const top = countOdiaWords(["ମୁଁ କଣ ମୁଁ", "କଣ ମୁଁ ଘର"]);
  assert.deepEqual(top, [["ମୁଁ", 3], ["କଣ", 2], ["ଘର", 1]]);
  assert.equal(countOdiaWords(["ମୁଁ କଣ ମୁଁ", "କଣ ମୁଁ ଘର"], { limit: 2 }).length, 2);
});

test("the texts of a saved scene (lines and acting notes) and of a scene list (one-liners, places, in any language field)", () => {
  assert.deepEqual(textsOfScene({ elements: [{ type: "action", text: "ସେ ଘରେ ଅଛି।" }, { type: "dialogue", character: "MEERA", parenthetical: "ଧୀରେ", text: "ମୁଁ ଆସିଲି।" }] }), ["ସେ ଘରେ ଅଛି।", "ମୁଁ ଆସିଲି।", "ଧୀରେ"]);
  assert.deepEqual(textsOfScene(null), []);
  const film = { scenes: [{ oneLiner: { en: "x", or: "ଗୋପାଳ ଆସେ", hi: "y" }, location: { en: "Temple" } }] };
  assert.ok(textsOfSceneList(film).includes("ଗୋପାଳ ଆସେ"));
  const series = { episodeScenes: [{ scenes: film.scenes }] };
  assert.ok(textsOfSceneList(series).includes("ଗୋପାଳ ଆସେ"));
});
