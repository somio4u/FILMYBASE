import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPromptsPdf, groupAssets } from "../promptsPdf.js";

const assets = [
  { kind: "character", name: "Soumya", code: "CHAR001", fileName: "CHAR001_Soumya", prompt: "Full-body model sheet of Soumya, 24, lean, saffron shawl." },
  { kind: "location", name: "Old Temple", code: "LOC001", fileName: "LOC001_Old-Temple", prompt: "Wide establishing view of an old stone temple at night." },
  { kind: "prop", name: "Props sheet 1", code: "PGRP01", fileName: "PGRP01_Props-sheet-1", members: [{ position: 1, name: "Diamond Eye" }, { position: 2, name: "Brass Lamp" }], prompt: "Props sheet for a film: 2 small objects together." },
];
const shots = [
  { sceneCode: "S01", sceneHeading: "INT. TEMPLE - NIGHT", shotCode: "SH01", fileName: "S01_SH01", description: "Soumya lights the lamp.", prompt: "Medium shot, Soumya lighting a lamp." },
  { sceneCode: "S01", sceneHeading: "INT. TEMPLE - NIGHT", shotCode: "SH02", description: "The empty altar.", prompt: "" },
  { sceneCode: "S02", sceneHeading: "EXT. VILLAGE - DAY", shotCode: "SH01", description: "Market.", prompt: "Wide shot of a busy market." },
];

test("groups assets into characters, environments and properties", () => {
  assert.deepEqual(groupAssets(assets).map((s) => `${s.title}:${s.items.length}`), ["Characters:1", "Environments:1", "Properties:1"]);
  assert.equal(groupAssets([...assets, { kind: "vehicle", name: "Jeep", code: "V1", prompt: "x" }]).at(-1).title, "Other");
});

test("the PDF holds every command, in sections, with scenes for the shots", async () => {
  const pdf = await buildPromptsPdf({ title: "Mahakali", assets, shots });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const file = path.join(mkdtempSync(path.join(tmpdir(), "pp-")), "p.pdf");
  writeFileSync(file, pdf);
  const text = execSync(`pdftotext -layout ${file} -`).toString();
  for (const part of ["Mahakali", "Characters", "Environments", "Properties", "Shots", "Soumya", "model sheet of Soumya", "Old Temple", "Diamond Eye", "Scene S01", "INT. TEMPLE - NIGHT", "S01_SH01", "Medium shot, Soumya lighting a lamp", "Scene S02", "busy market"]) assert.ok(text.includes(part), `PDF should contain "${part}"`);
  assert.match(text, /\(no command planned yet\)/); // a shot without a planned command says so instead of being skipped
});

test("the PDF says exactly what to save each picture as, lists every file name, and explains the way back into the app", async () => {
  const pdf = await buildPromptsPdf({ title: "Mahakali", assets, shots, waitingShots: 2, aspectRatio: "16:9", style: "Photorealistic live-action film look." });
  const file = path.join(mkdtempSync(path.join(tmpdir(), "pp-")), "p.pdf");
  writeFileSync(file, pdf);
  const text = execSync(`pdftotext -layout ${file} -`).toString();
  for (const part of ["How to use this PDF", "Import pictures I made elsewhere", "Checklist of file names", "[ ]  CHAR001_Soumya.png", "[ ]  PGRP01_Props-sheet-1.png", "[ ]  S01_SH01.png", "SAVE THE PICTURE AS:  CHAR001_Soumya.png", "SAVE THE PICTURE AS:  S01_SH01.png", "Picture shape: 16:9", "position 1 = top-left", "1 Diamond Eye", "2 Brass Lamp", "2 shots are not in this PDF yet", "Visual style of the film"]) {
    assert.ok(text.replace(/\s+/g, " ").includes(part.replace(/\s+/g, " ")), `PDF should contain "${part}"`);
  }
});
