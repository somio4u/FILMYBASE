// Pictures made OUTSIDE the app and imported back by file name (pictureNames.js / pictureImport.js). The AI service is a LOCAL IMITATION (tests/mockGemini.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { seedTestProject } from "../production.js";
import { analyzeScreenplay, listScenes } from "../screenplayAnalysis.js";
import { ensureAllProductionSchemas } from "../productionSchema.js";
import { createMediaStore, createLocalBackend } from "../mediaStore.js";
import { createProviders, pcmToWav, wavDurationMs } from "../providers.js";
import { createGenerationService } from "../generations.js";
import { combineProps } from "../propGroups.js";
import { parsePictureName, assetFileName, shotFileName, imageKind, slug } from "../pictureNames.js";
import { importPictures, expandUploads } from "../pictureImport.js";
import AdmZip from "adm-zip";
import { saveSettings, getSettings, spendSummary, assertWithinBudget } from "../pipelineSettings.js";
import { divideScene, listShots, generateStoryboard, approveStoryboard, approveShots } from "../shots.js";
import { startMockGemini } from "./mockGemini.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gen-test-"));
let mock, providers, store, gens;

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  assert.deepEqual(await ensureAllProductionSchemas(db), []);
  mock = await startMockGemini();
  providers = createProviders({ env: { GEMINI_API_KEY: "test-key", GEMINI_API_BASE: mock.base }, sleep: async () => {} });
  store = createMediaStore({ db, backend: createLocalBackend({ root: path.join(tmp, "media") }), spoolDir: path.join(tmp, "spool") });
  gens = createGenerationService({ db, store, providers, env: {}, videoPollMs: 1 });
});
test.after(async () => {
  await mock.close();
  await db.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// a fresh project with scene 2 cut into shots and its text storyboard approved
async function ready({ approveStoryboardToo = true } = {}) {
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'");
  const { projectId } = await seedTestProject(db);
  await analyzeScreenplay(db, projectId);
  const scene = (await listScenes(db, projectId)).find((s) => s.number === "2");
  await divideScene(db, projectId, scene.id, { mode: "script" });
  await generateStoryboard(db, projectId, scene.id, {});
  if (approveStoryboardToo) await approveShots(db, projectId, scene.id);
  mock.state.requests.length = 0;
  return { projectId, scene };
}
const assetByName = async (pid, re) => (await db.query("SELECT * FROM production_assets WHERE project_id = $1", [pid])).rows.find((a) => re.test(a.name));
const finish = async ({ row, done }) => { await done; return (await gens.list(row.project_id, { id: row.id }))[0]; };
const ONE_PIXEL_OK = (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const mediaRow = async (id) => (await db.query("SELECT * FROM production_media_files WHERE id = $1", [id])).rows[0];



const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(20)]);

test("names: the code at the start decides; format, case and a tool's own ending do not matter", () => {
  assert.deepEqual(parsePictureName("CHAR001_Rohan.png"), { type: "asset", code: "CHAR001" });
  assert.deepEqual(parsePictureName("char001-rohan (2).JPG"), { type: "asset", code: "CHAR001" });
  assert.deepEqual(parsePictureName("LOC002_Old-Temple_final.webp"), { type: "asset", code: "LOC002" });
  assert.deepEqual(parsePictureName("PROP004.png"), { type: "asset", code: "PROP004" });
  assert.deepEqual(parsePictureName("PGRP01_Props-sheet-1.png"), { type: "asset", code: "PGRP01" });
  assert.deepEqual(parsePictureName("SC001_SH003.png"), { type: "shot", sceneCode: "SC001", shotCode: "SH003" });
  assert.deepEqual(parsePictureName("downloads/sc012_sh010 copy.jpeg"), { type: "shot", sceneCode: "SC012", shotCode: "SH010" });
  assert.deepEqual(parsePictureName("midjourney_a8f3c.png"), null);
  assert.deepEqual(parsePictureName("CHAR0011_x.png").code, "CHAR0011", "a longer number is a different code, not CHAR001");
  assert.equal(slug("Old Temple (north)"), "Old-Temple-north");
  assert.equal(assetFileName({ code: "CHAR001", name: "Rohan Das" }), "CHAR001_Rohan-Das");
  assert.equal(shotFileName({ sceneCode: "SC001", code: "SH003" }), "SC001_SH003");
});

test("a file is a picture because of its first bytes, not its name", () => {
  assert.equal(imageKind(PNG).mime, "image/png");
  assert.equal(imageKind(JPG).mime, "image/jpeg");
  assert.equal(imageKind(WEBP).mime, "image/webp");
  assert.equal(imageKind(Buffer.from("this is only text, not a picture")), null);
});

test("a .zip is opened; junk files inside it are ignored", () => {
  const zip = new AdmZip();
  zip.addFile("CHAR001_Rohan.png", PNG);
  zip.addFile("__MACOSX/._CHAR001_Rohan.png", Buffer.from("junk"));
  zip.addFile("sub/SC001_SH001.jpg", JPG);
  const out = expandUploads([{ name: "pictures.zip", bytes: zip.toBuffer() }, { name: ".DS_Store", bytes: Buffer.from("x") }, { name: "LOC001.png", bytes: PNG }]);
  assert.deepEqual(out.map((f) => f.name).sort(), ["CHAR001_Rohan.png", "LOC001.png", "SC001_SH001.jpg"]);
});

test("import: each picture is connected by its name to the right character / shot, waiting for review, costing nothing", async () => {
  const { projectId } = await ready();
  const rohan = await assetByName(projectId, /Rahul/);
  const shot = (await listShots(db, projectId)).find((s) => s.shotStatus === "approved");
  const before = (await spendSummary(db, projectId)).spentUsd;
  const report = await importPictures({ db, gens, projectId, files: [
    { name: `${assetFileName(rohan)}.png`, bytes: PNG },
    { name: `${shotFileName(shot)}.jpg`, bytes: JPG },
  ] });
  assert.equal(report.skipped.length, 0, JSON.stringify(report.skipped));
  assert.equal(report.imported.length, 2);
  assert.match(report.imported[0].target, new RegExp(rohan.code));
  const rows = (await db.query("SELECT * FROM production_generations WHERE project_id = $1 ORDER BY id", [projectId])).rows;
  assert.equal(rows.length, 2);
  const [ref, frame] = rows;
  assert.deepEqual([ref.kind, ref.asset_id, ref.status, ref.review, ref.provider, Number(ref.cost_usd), ref.version], ["character", rohan.id, "ready", "pending", "imported", 0, 1]);
  assert.deepEqual([frame.kind, frame.shot_id, frame.status, frame.review], ["keyframe", shot.id, "ready", "pending"]);
  assert.ok(ref.media_id && frame.media_id, "the files are stored");
  assert.equal(ref.prompt.length > 20, true, "the planned command is kept with the picture");
  assert.equal((await spendSummary(db, projectId)).spentUsd, before, "importing costs nothing");

  // uploading again makes version 2 of the same target
  await importPictures({ db, gens, projectId, files: [{ name: `${rohan.code}_new-take.png`, bytes: PNG }] });
  assert.equal(Number((await db.query("SELECT max(version) AS v FROM production_generations WHERE asset_id = $1", [rohan.id])).rows[0].v), 2);
});

test("import: autoApprove approves each picture at once", async () => {
  const { projectId } = await ready();
  const rohan = await assetByName(projectId, /Rahul/);
  const report = await importPictures({ db, gens, projectId, autoApprove: true, files: [{ name: `${rohan.code}.png`, bytes: PNG }] });
  assert.equal(report.imported[0].approved, true);
  assert.equal((await db.query("SELECT review FROM production_generations WHERE asset_id = $1", [rohan.id])).rows[0].review, "approved");
});

test("import: every picture that cannot be used is reported with the reason, never guessed at", async () => {
  const { projectId } = await ready();
  const rohan = await assetByName(projectId, /Rahul/);
  const report = await importPictures({ db, gens, projectId, files: [
    { name: "some-random-name.png", bytes: PNG },
    { name: "CHAR999_Nobody.png", bytes: PNG },
    { name: "SC099_SH099.png", bytes: PNG },
    { name: `${rohan.code}.png`, bytes: Buffer.from("not a picture at all, just text") },
    { name: "notes.zip", bytes: Buffer.from("this is not a zip") },
  ] });
  assert.equal(report.imported.length, 0);
  const reasons = Object.fromEntries(report.skipped.map((s) => [s.file, s.reason]));
  assert.match(reasons["some-random-name.png"], /cannot tell what this picture is/);
  assert.match(reasons["CHAR999_Nobody.png"], /no item with the code CHAR999/);
  assert.match(reasons["SC099_SH099.png"], /no shot SC099_SH099/);
  assert.match(reasons[`${rohan.code}.png`], /not a picture/);
  assert.match(reasons["notes.zip"], /could not be opened/);
  assert.equal((await db.query("SELECT 1 FROM production_generations WHERE project_id = $1", [projectId])).rowCount, 0);
});

test("import: a shot whose division is not approved is refused; a single prop on a props sheet points to the sheet", async () => {
  const { projectId, scene } = await ready();
  await approveShots(db, projectId, scene.id, { approved: false });
  const shot = (await listShots(db, projectId)).find((s) => s.sceneId === scene.id || true);
  const refused = await importPictures({ db, gens, projectId, files: [{ name: `${shotFileName(shot)}.png`, bytes: PNG }] });
  assert.match(refused.skipped[0].reason, /not approved yet/);

  const { groups } = await combineProps(db, projectId, { perImage: 6 });
  const member = groups[0].members[0];
  const viaMember = await importPictures({ db, gens, projectId, files: [{ name: `${member.code}_x.png`, bytes: PNG }] });
  assert.match(viaMember.skipped[0].reason, new RegExp(`on the props sheet ${groups[0].code}`));
  const viaSheet = await importPictures({ db, gens, projectId, files: [{ name: `${groups[0].code}_Props-sheet-1.png`, bytes: PNG }] });
  assert.equal(viaSheet.imported.length, 1);
  assert.equal(viaSheet.imported[0].target.startsWith(groups[0].code), true);
});
