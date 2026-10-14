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
