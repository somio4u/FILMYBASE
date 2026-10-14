import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCastingPpt } from "../castingPpt.js";
import { castFromSheet } from "../castingCast.js";

const bi = (en, or) => ({ en, or });
const mk = (rank, name, odiaName, group) => ({ rank, name, odiaName, screenTime: "High", score: "9/10", group, age: "30", look: bi("tall", "ଲମ୍ବା"), about: bi("About " + name, "ବିଷୟ " + name), importance: bi("Key to the plot", "ମୁଖ୍ୟ"), relation: bi("Rival of Soumya", "ପ୍ରତିଦ୍ୱନ୍ଦ୍ୱୀ"), arc: bi("Grows", "ବଢ଼େ") });
const cast = [
  mk(1, "Soumya", "ସୌମ୍ୟ", "protagonist"),
  mk(2, "Sulagna", "ସୁଲଗ୍ନା", "heroine"),
  mk(4, "Malati", "ମାଳତୀ", "heroine"),
  mk(3, "Balaram", "ବଳରାମ", "villain"),
  mk(10, "Deba", "ଦେବା", "sidekick"),
  mk(7, "Inspector Meera", "ମୀରା", "supporting"),
];

const slidesOf = (buffer) => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "cast-")), "c.pptx");
  writeFileSync(file, buffer);
  const count = execSync(`unzip -l ${file}`).toString().match(/ppt\/slides\/slide\d+\.xml/g).length;
  return { count, xml: (n) => execSync(`unzip -p ${file} ppt/slides/slide${n}.xml`).toString() };
};

test("casting PPT: cover + a title slide per non-empty section + one slide per character, in section order", async () => {
  const { count, xml } = slidesOf(await buildCastingPpt({ title: "Mahakali", cast, lang: "en" }));
  assert.equal(count, 1 + 5 + 6); // cover + 5 sections + 6 characters
  assert.match(xml(2), /THE PROTAGONIST/);
  assert.match(xml(3), /SOUMYA/);
  assert.match(xml(4), /THE HEROINES/);
  assert.match(xml(5), /SULAGNA/);
  assert.match(xml(6), /MALATI/);
  assert.match(xml(7), /THE VILLAINS/);
  assert.match(xml(3), /KEY TO THE PLOT|Key to the plot/i);
  assert.equal((xml(3).match(/PHOTO · drop here/g) ?? []).length, 3);
  // the details the director asked NOT to see are gone
  assert.doesNotMatch(xml(3), /WANTS|NEEDS|FLAW|INNER CONFLICT|VIRTUES/);
});

test("an empty section is skipped", async () => {
  const { count } = slidesOf(await buildCastingPpt({ title: "X", cast: [cast[0]], lang: "en" }));
  assert.equal(count, 3); // cover + protagonist section + Soumya
});

test("Odia version uses the Odia names and Odia text", async () => {
  const { xml } = slidesOf(await buildCastingPpt({ title: "ମହାକାଳୀ", cast, lang: "or" }));
  assert.match(xml(2), /ନାୟକ/);
  assert.match(xml(3), /ସୌମ୍ୟ/);
  assert.match(xml(3), /ମୁଖ୍ୟ/);
  assert.match(xml(3), /ଫଟୋ · ଏଠି ଲଗାନ୍ତୁ/);
});

test("without a pasted list the character sheet alone still makes a deck", async () => {
  const sheet = [{ name: "Soumya", age: "24", look: "tall", archetype: "hero", role: bi("Priest", "ପୂଜକ"), arc: bi("grows", "ବଢ଼େ"), relationToHero: "Is the hero" }, { name: "Sula", age: "40", archetype: "shadow", role: bi("Gang", "ଗ୍ୟାଙ୍ଗ") }];
  const { count } = slidesOf(await buildCastingPpt({ title: "X", cast: castFromSheet(sheet), lang: "en" }));
  assert.equal(count, 1 + 2 + 2);
});
