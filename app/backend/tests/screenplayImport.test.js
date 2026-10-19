import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import mammoth from "mammoth";
import { parseEpisodesFromText, parseDurationMinutes, sceneContent, outlineFor, headingParts } from "../screenplayImport.js";

const DOCX = new URL("../../../exports/Maha-Kali-Episodes-4-8-Odia.docx", import.meta.url);

test("durations in Odia and English digits are read", () => {
  assert.equal(parseDurationMinutes("(୨ ମିନିଟ୍ ୩୦ ସେକେଣ୍ଡ)"), 2.5);
  assert.equal(parseDurationMinutes("(1 min)"), 1);
});

test("a heading splits into place, in/out and time", () => {
  assert.deepEqual(headingParts("EXT. KALI TEMPLE GROUNDS - NIGHT"), { intExt: "EXT", location: "KALI TEMPLE GROUNDS", timeOfDay: "NIGHT" });
});

test("the real Word file gives episodes 4 to 8 with their scenes", { skip: !fs.existsSync(DOCX) }, async () => {
  const { value } = await mammoth.extractRawText({ buffer: fs.readFileSync(DOCX) });
  const parsed = parseEpisodesFromText(value);
  assert.deepEqual(parsed.episodes.map((e) => e.number), [4, 5, 6, 7, 8]);
  assert.deepEqual(parsed.episodes.map((e) => e.scenes.length), [8, 8, 7, 8, 9]);
  const first = parsed.episodes[0].scenes[0];
  assert.equal(first.heading, "EXT. KALI TEMPLE GROUNDS - NIGHT");
  assert.ok(first.elements.some((e) => e.type === "dialogue" && e.character === "NAYANA"));
  const all = parsed.episodes.flatMap((e) => e.scenes.flatMap((s) => s.elements));
  assert.ok(all.some((e) => e.type === "dialogue" && e.character === "VILLAGER 1"));
  assert.ok(all.some((e) => e.type === "transition"));
  assert.ok(all.every((e) => e.text.trim().length > 0));
});

test("scenes are shaped for the screenplay and the scene list", () => {
  const parsed = parseEpisodesFromText(
    "EPISODE 4: TEST\n\nSCENE 1 (1 min)\nINT. HOUSE - DAY\nCharacters: RAM\nRam sits down.\nRAM\n(softly)\nHello there.\nCUT TO BLACK."
  );
  const scene = parsed.episodes[0].scenes[0];
  const content = sceneContent(scene, "or");
  assert.equal(content.importedFromFile, true);
  assert.equal(content.dialogueLanguage, "or");
  const line = content.elements.find((e) => e.type === "dialogue");
  assert.equal(line.character, "RAM");
  assert.equal(line.parenthetical, "softly");
  const outline = outlineFor(scene, 0, { actNumber: 2, purpose: "twist" }, 4, ["E3S1"]);
  assert.equal(outline.sceneNumber, "E4S1");
  assert.equal(outline.actNumber, 2);
  assert.equal(outline.location.or, "HOUSE");
});

test("text without episodes gives nothing", () => {
  assert.equal(parseEpisodesFromText("just some words").episodes.length, 0);
});
