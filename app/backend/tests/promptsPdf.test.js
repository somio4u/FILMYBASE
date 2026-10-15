import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPromptsPdf, groupAssets } from "../promptsPdf.js";

const assets = [
  { kind: "character", name: "Soumya", code: "C01", prompt: "Full-body model sheet of Soumya, 24, lean, saffron shawl." },
  { kind: "location", name: "Old Temple", code: "L01", prompt: "Wide establishing view of an old stone temple at night." },
  { kind: "prop", name: "Diamond Eye", code: "P01", prompt: "Close-up of a glowing diamond eye." },
];
const shots = [
  { sceneCode: "S01", sceneHeading: "INT. TEMPLE - NIGHT", shotCode: "SH01", description: "Soumya lights the lamp.", prompt: "Medium shot, Soumya lighting a lamp." },
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
