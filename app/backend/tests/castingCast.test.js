import test from "node:test";
import assert from "node:assert/strict";
import { parseCastList, buildCast } from "../castingCast.js";

const TABLE = `Rank	Character	Expected Screen Time	Story Importance
1	Soumya (ସୌମ୍ୟ)	Very High	10/10
2	Sulagna (ସୁଲଗ୍ନା)	Very High	9.5/10
8	Sulochana (ସୁଲୋଚନା)	Limited	9/10
9	Jagannath Dash (ଜଗନ୍ନାଥ ଦାଶ)	Limited / Flashbacks	9/10
6	Madhab (ମାଧବ)	Medium–High	8.5/10
7	Inspector Meera (ମୀରା)	Medium	8/10`;

test("reads the pasted rank table (tabs), names with Odia in brackets, scores and screen time", () => {
  const list = parseCastList(TABLE);
  assert.equal(list.length, 6);
  assert.deepEqual(list[0], { rank: 1, name: "Soumya", odiaName: "ସୌମ୍ୟ", screenTime: "Very High", score: "10/10" });
  assert.equal(list[3].name, "Jagannath Dash");
  assert.equal(list[3].screenTime, "Limited / Flashbacks");
  assert.equal(list[4].screenTime, "Medium–High");
  assert.equal(list[5].name, "Inspector Meera");
});

test("also reads lines separated by spaces and plain names", () => {
  const list = parseCastList("1  Soumya (ସୌମ୍ୟ)  Very High  10/10\n2. Ratan\nDeba");
  assert.equal(list.length, 3);
  assert.equal(list[0].score, "10/10");
  assert.equal(list[1].name, "Ratan");
  assert.equal(list[2].name, "Deba");
});

test("builds an entry for EVERY listed character, using the sheet's age for those that have one", async () => {
  const seen = [];
  const ask = async (contents) => {
    seen.push(contents);
    const bi = (x) => ({ en: x, or: `${x}-or` });
    const mk = (name, group) => ({ name, group, age: "30", look: bi("look"), about: bi("about"), importance: bi("imp"), relation: bi("rel"), arc: bi("arc") });
    return { cast: [mk("Soumya", "protagonist"), mk("Sulagna", "heroine"), mk("Sulochana", "sidekick"), mk("Jagannath Dash", "villain"), mk("Madhab", "sidekick"), mk("Inspector Meera", "bogus")] };
  };
  const cast = await buildCast({ listText: TABLE, sheetCharacters: [{ name: "SOUMYA", age: "24", look: "tall", archetype: "hero" }], deck: { title: { en: "Mahakali" }, episodes: [{ title: { en: "Fire" }, synopsis: { en: "It begins" } }] }, ask });
  assert.equal(cast.length, 6);
  assert.equal(cast[0].age, "24"); // from the sheet, not the AI's 30
  assert.equal(cast[0].fromSheet, true);
  assert.equal(cast[2].fromSheet, false);
  assert.equal(cast[3].group, "villain");
  assert.equal(cast[5].group, "supporting"); // an invalid group falls back to supporting
  assert.match(seen[0], /CHARACTER SHEET \(truth\)/);
  assert.match(seen[0], /Ep 1 Fire: It begins/);
});

test("an empty list gives a plain message", async () => {
  await assert.rejects(buildCast({ listText: "Rank\tCharacter\n  \n", ask: async () => ({}) }), (e) => e.status === 400 || /could not find/.test(e.message));
});

import { findCharacters, gatherScriptEvidence, addToCast, castFromSheet } from "../castingCast.js";

test("finding characters: skips those already in the PPT, keeps priority order, dedupes, fills sheet age", async () => {
  const bi2 = (x) => ({ en: x, or: `${x}-or` });
  const mk = (name, group, score) => ({ name, odiaName: `${name}-od`, group, age: "40", look: bi2("l"), about: bi2("a"), importance: bi2("i"), relation: bi2("r"), arc: bi2("arc"), screenTime: "High", score });
  let asked = "";
  const ask = async (contents) => { asked = contents; return { characters: [mk("Soumya", "protagonist", 10), mk("Madhab", "sidekick", 8.5), mk("madhab", "sidekick", 8), mk("Meera", "supporting", 8)] }; };
  const evidence = gatherScriptEvidence({ deck: { title: { en: "Mahakali" } }, bible: { characters: [{ name: "Madhab" }] }, sceneListContent: { acts: [{ scenes: [{ location: { en: "Temple" }, oneLiner: { en: "Madhab sees the idol" } }] }] } });
  assert.match(evidence, /1\. Temple: Madhab sees the idol/);
  const out = await findCharacters({ evidence, sheetCharacters: [{ name: "Madhab", age: "29", archetype: "ally" }], existing: ["Soumya"], ask });
  assert.deepEqual(out.map((c) => c.name), ["Madhab", "Meera"]); // Soumya skipped, duplicate dropped
  assert.equal(out[0].age, "29");
  assert.equal(out[0].rank, 1);
  assert.equal(out[0].score, "8.5/10");
  assert.match(asked, /ALREADY IN THE PPT \(do not list these\): Soumya/);
});

test("adding to the PPT list: no duplicates, bad group becomes supporting, junk fields are dropped", () => {
  const seed = castFromSheet([{ name: "Soumya", archetype: "hero", age: "24" }]);
  const added = addToCast(seed, { name: "Meera", group: "wizard", age: "35", evil: "x", look: { en: "tall", or: "" } });
  assert.equal(added.length, 2);
  assert.equal(added[1].group, "supporting");
  assert.equal(added[1].evil, undefined);
  assert.equal(addToCast(added, { name: "MEERA" }).length, 2);
});
