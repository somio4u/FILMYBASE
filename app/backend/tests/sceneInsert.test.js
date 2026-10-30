import test from "node:test";
import assert from "node:assert/strict";
import { makeInsertedScenes, planInsertions, renumberSimpleScenes } from "../sceneInsert.js";

const text = (v) => ({ en: v, or: v, hi: v });
const scene = (n, place, extra = {}) => ({ sceneNumber: String(n), actNumber: 1, intExt: "INT", location: text(place), timeOfDay: "DAY", oneLiner: text(`one-liner ${n}`), estimatedMinutes: 2, purpose: "plot_advancing", ...extra });
const list = (n) => Array.from({ length: n }, (_, i) => scene(i + 1, `Place ${i + 1}`));
const fields = (extra = {}) => ({ intExt: "EXT", location: "River", timeOfDay: "night", oneLiner: "A new thing happens.", estimatedMinutes: 3, ...extra });

test("one scene in the middle: fields as before, later scene numbers move up", () => {
  const { at, newScene, nextScenes } = makeInsertedScenes(list(4), 2, fields());
  assert.equal(at, 2);
  assert.equal(newScene.intExt, "EXT");
  assert.equal(newScene.timeOfDay, "NIGHT");
  assert.deepEqual(newScene.location, text("River"));
  assert.equal(newScene.estimatedMinutes, 3);
  assert.equal(newScene.addedByUser, true);
  assert.deepEqual(nextScenes.map((s) => s.sceneNumber), ["1", "2", "3", "4", "5"]);
  assert.equal(nextScenes[2].oneLiner.en, "A new thing happens.");
  assert.equal(nextScenes[3].oneLiner.en, "one-liner 3"); // the old scene 3 is now 4
});

test("a position outside the list is pulled in; scenes with numbers like 12A are not renumbered", () => {
  assert.equal(makeInsertedScenes(list(3), 99, fields()).at, 3);
  assert.equal(makeInsertedScenes(list(3), -5, fields()).at, 0);
  const odd = [scene("5", "A"), scene("5A", "B"), scene("6", "C")];
  const { nextScenes, newScene } = makeInsertedScenes(odd, 2, fields());
  assert.match(newScene.sceneNumber, /A$/);
  assert.equal(nextScenes.length, 4);
  assert.equal(nextScenes[3].sceneNumber, "6");
});

test("an AI scene keeps its own bilingual text and is marked as added by the AI; time and minutes are kept sane", () => {
  const { newScene } = makeInsertedScenes(list(2), 1, { intExt: "INT", location: { en: "Temple", or: "ମନ୍ଦିର", hi: "मंदिर" }, timeOfDay: "DAY", oneLiner: { en: "x", or: "ଏକ", hi: "एक" }, turn: { en: "t" }, estimatedMinutes: 99, addedBy: "ai" });
  assert.equal(newScene.location.or, "ମନ୍ଦିର");
  assert.equal(newScene.oneLiner.hi, "एक");
  assert.equal(newScene.turn.en, "t");
  assert.equal(newScene.estimatedMinutes, 15);
  assert.equal(newScene.addedByAI, true);
  assert.equal(newScene.addedByUser, undefined);
});

test("planInsertions: highest position first, scenes for the same spot in reverse, so applying them in that order gives the order asked for", () => {
  const scenes = list(5);
  const generated = [
    { afterScene: "2", oneLiner: "A" },
    { afterScene: "2", oneLiner: "B" },
    { afterScene: "4", oneLiner: "C" },
    { afterScene: "0", oneLiner: "D" },
    { afterScene: "end", oneLiner: "E" },
  ];
  const plan = planInsertions(scenes, generated);
  assert.deepEqual(plan.map((p) => [p.position, p.fields.oneLiner]), [[5, "E"], [4, "C"], [2, "B"], [2, "A"], [0, "D"]]);
  // apply them for real, the way the job does
  let current = scenes;
  for (const { position, fields: f } of plan) current = makeInsertedScenes(current, position, { intExt: "INT", location: "X", oneLiner: f.oneLiner, addedBy: "ai" }).nextScenes;
  assert.deepEqual(current.map((s) => s.oneLiner.en), ["D", "one-liner 1", "one-liner 2", "A", "B", "one-liner 3", "one-liner 4", "C", "one-liner 5", "E"]);
  assert.deepEqual(current.map((s) => s.sceneNumber), Array.from({ length: 10 }, (_, i) => String(i + 1)));
});

test("an unknown scene number goes to the end (never lost); renumbering leaves odd numbering alone", () => {
  const plan = planInsertions(list(3), [{ afterScene: "zzz", oneLiner: "A" }, { afterScene: "", oneLiner: "B" }]);
  assert.deepEqual(plan.map((p) => p.position), [3, 3]);
  assert.deepEqual(renumberSimpleScenes([scene("1A", "x"), scene("two", "y")]).map((s) => s.sceneNumber), ["1A", "two"]);
});
