import test from "node:test";
import assert from "node:assert/strict";
import { buildIndex, candidatesFor, lookAlikes, skeleton } from "../../frontend/src/odiaFuzzy.js";

test("look-alike letters share one skeleton; real differences stay different", () => {
  assert.equal(skeleton("କଣ"), skeleton("କନ"));
  assert.equal(skeleton("ଭୋଳ"), skeleton("ଭୋଲ"));
  assert.equal(skeleton("ମୁଁ"), skeleton("ମୁନ"));
  assert.equal(skeleton("ପାଉ"), skeleton("ପଉ"));
  assert.equal(skeleton("ଶିବ"), skeleton("ସିବ"));
  assert.equal(skeleton("ଟିକ"), skeleton("ତିକ"));
  assert.equal(skeleton("ନୀଳ"), skeleton("ନିଲ"));
  assert.notEqual(skeleton("କଣ"), skeleton("ଖଣ"));
  assert.notEqual(skeleton("ଘର"), skeleton("ଗର"));
  assert.equal(skeleton(""), "");
});

// the words of the writer's scripts, counted
const corpus = [["ଗୋପାଳ", 40], ["ଗୋପାଲ", 2], ["ଟଙ୍କା", 30], ["ତଙ୍କା", 1], ["ଭଣ୍ଡାର", 12], ["ଖେଳ", 25], ["ଯାଉ", 9], ["ଜାଉ", 1], ["ମାୟା", 8], ["ସୁନା", 14], ["ଶୁନା", 3], ["ମୁଁ", 300], ["କଣ", 200], ["ପାଉ", 4]];
const index = buildIndex(corpus);

test("a word typed with plain letters finds the spelling the scripts really use (the most used first)", () => {
  assert.equal(candidatesFor("gopala", { index })[0], "ଗୋପାଳ"); // not ଗୋପଲ, not the rare ଗୋପାଲ
  assert.equal(candidatesFor("Gopala", { index })[0], "ଗୋପାଳ"); // a sentence capital changes nothing
  assert.equal(candidatesFor("tanka", { index })[0], "ଟଙ୍କା"); // ତ vs ଟ decided by the scripts
  assert.equal(candidatesFor("bhandara", { index })[0], "ଭଣ୍ଡାର");
  assert.equal(candidatesFor("khela", { index })[0], "ଖେଳ");
  assert.equal(candidatesFor("jaau", { index })[0], "ଯାଉ");
  assert.equal(candidatesFor("maayaa", { index })[0], "ମାୟା");
  assert.equal(candidatesFor("suna", { index })[0], "ସୁନା");
  assert.deepEqual(candidatesFor("suna", { index }).slice(0, 2), ["ସୁନା", "ଶୁନା"]); // the other spelling stays a choice
});

test("the writer's own words and the built-in list come before the scripts; the rules come after them", () => {
  assert.equal(candidatesFor("kana", { index })[0], "କଣ");
  assert.equal(candidatesFor("kana", { index, words: { kana: "କନା" } })[0], "କନା");
  const c = candidatesFor("gopala", { index });
  assert.ok(c.includes("ଗୋପଲ"), "what the rules give is still a choice");
  assert.ok(c.indexOf("ଗୋପାଳ") < c.indexOf("ଗୋପଲ"));
});

test("a word that is in no list: the rules' answer first, then look-alikes to pick from; no duplicates, never more than the limit", () => {
  const c = candidatesFor("kanala", { index: new Map() });
  assert.equal(c[0], "କନଲ");
  assert.ok(c.includes("କଣଲ") && c.includes("କନଳ"));
  assert.equal(new Set(c).size, c.length);
  assert.ok(candidatesFor("kanala", { index: new Map(), limit: 3 }).length <= 3);
  assert.deepEqual(candidatesFor("", { index }), [""].filter(Boolean));
});

test("look-alikes: the single swaps, and a closing ନ can be the nasal mark", () => {
  assert.ok(lookAlikes("ମୁନ").includes("ମୁଁ"));
  assert.ok(lookAlikes("କନ").includes("କଣ"));
  assert.ok(lookAlikes("ଭଲ").includes("ଭଳ"));
  assert.deepEqual(lookAlikes("ଗର"), []);
});

test("the index keeps the most used word first and ignores empty words", () => {
  const i = buildIndex([["କଣ", 5], ["କନ", 9], ["", 3]]);
  assert.deepEqual(i.get(skeleton("କଣ")).map((x) => x.word), ["କନ", "କଣ"]);
  assert.equal(i.size, 1);
});
