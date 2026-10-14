import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCastingPpt } from "../castingPpt.js";

const bi = (en, hi, or) => ({ en, hi, or });
const characters = [
  { name: "Soumya", age: "24", look: "Tall, dark, intense eyes", relationToHero: "Is the hero", archetype: "hero", role: bi("Young priest", "युवा पुजारी", "ଯୁବ ପୂଜକ"), want: bi("Revenge", "बदला", "ପ୍ରତିଶୋଧ"), flaw: bi("Pride", "घमंड", "ଅହଂକାର") },
  { name: "Sula", age: "40", look: "Heavy build", relationToHero: "Enemy", archetype: "shadow", role: bi("Gang leader", "गिरोह सरगना", "ଗ୍ୟାଙ୍ଗ ନେତା"), want: bi("Power", "ताकत", "କ୍ଷମତା"), flaw: bi("Greed", "लालच", "ଲୋଭ") },
];

test("casting PPT: cover + one slide per character, with 3 photo placeholders each", async () => {
  const buffer = await buildCastingPpt({ title: "Mahakali", characters });
  const dir = mkdtempSync(path.join(tmpdir(), "cast-"));
  const file = path.join(dir, "c.pptx");
  writeFileSync(file, buffer);
  const slides = execSync(`unzip -l ${file}`).toString().match(/ppt\/slides\/slide\d+\.xml/g);
  assert.equal(slides.length, 3);
  const slide2 = execSync(`unzip -p ${file} ppt/slides/slide2.xml`).toString();
  assert.match(slide2, /Soumya/);
  assert.match(slide2, /Tall, dark, intense eyes/);
  assert.equal((slide2.match(/>PHOTO</g) ?? []).length, 3);
  assert.match(slide2, /SOUMYA/);
});
