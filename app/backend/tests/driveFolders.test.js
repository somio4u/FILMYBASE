// How files are arranged in Google Drive: a folder named after the project,
// numbered sub-folders, one folder per character/prop/environment, renaming.
// Google is a LOCAL MOCK (tests/mockDrive.js). FIXTURE ONLY.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { ensureProductionSchema } from "../production.js";
import { ensureMediaSchema, createMediaStore, createDriveBackend, createLocalBackend, safeFolderName, PROJECT_FOLDER_LAYOUT } from "../mediaStore.js";
import { startMockDrive } from "./mockDrive.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drive-folders-"));
let mock, store;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = () => { const p = path.join(tmp, `f${Math.random()}.png`); fs.writeFileSync(p, Buffer.concat([PNG, crypto.randomBytes(40)])); return p; };
const project = async (title) => (await db.query("INSERT INTO ai_movie_projects (title, pasted_text) VALUES ($1,'x') RETURNING id", [title])).rows[0].id;
const folderNames = () => [...mock.files.values()].filter((f) => f.isFolder).map((f) => f.name);

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await ensureProductionSchema(db);
  await ensureMediaSchema(db);
  await db.query("DELETE FROM production_drive_folders");
  await db.query("DELETE FROM production_project_folders");
  mock = await startMockDrive();
  const backend = createDriveBackend({ db, getAccessToken: async () => mock.token, apiBase: mock.apiBase, uploadBase: mock.uploadBase, chunkSize: 256 * 1024 });
  store = createMediaStore({ db, backend, spoolDir: path.join(tmp, "spool") });
});
test.after(async () => { await mock.close(); await db.end(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("folder names keep every language, drop characters folders cannot hold, and never come out empty", () => {
  assert.equal(safeFolderName("Idea of an Idea"), "Idea of an Idea");
  assert.equal(safeFolderName("[TEST] Idea of an Idea (अधूरे ख्याल)"), "[TEST] Idea of an Idea (अधूरे ख्याल)");
  assert.equal(safeFolderName("ଗପ: ଏକ/ଦୁଇ"), "ଗପ- ଏକ-ଦୁଇ");
  assert.equal(safeFolderName('a<b>c|d?e*f"g\\h'), "a-b-c-d-e-f-g-h");
  assert.equal(safeFolderName("   ...  "), "Untitled");
  assert.equal(safeFolderName(null, "Project 5"), "Project 5");
  assert.ok(safeFolderName("x".repeat(300)).length <= 100);
});

test("prepare creates the project-named folder with every numbered sub-folder, once, in the root of Drive", async () => {
  const pid = await project("Idea of an Idea");
  const info = await store.prepareProject(pid);
  assert.equal(info.folderName, "Idea of an Idea");
  assert.match(info.link, /^https:\/\/drive\.google\.com\/drive\/folders\/folder\d+$/);
  assert.deepEqual(info.layout, PROJECT_FOLDER_LAYOUT);
  const root = [...mock.files.entries()].find(([, f]) => f.name === "Idea of an Idea");
  assert.ok(root, "project folder exists");
  assert.equal(root[1].parents, undefined, "created in the root of Drive (no parent folder)");
  const children = [...mock.files.values()].filter((f) => f.parents?.[0] === root[0]).map((f) => f.name);
  assert.deepEqual(children, PROJECT_FOLDER_LAYOUT);
  const before = mock.state.foldersCreated;
  await store.prepareProject(pid);
  assert.equal(mock.state.foldersCreated, before, "running it again makes nothing new");
});

test("each kind of file lands in its numbered folder; items get their own sub-folder; names carry the code", async () => {
  const pid = await project("Akhada Film");
  const put = (role, subfolder, label) => store.putMedia({ projectId: pid, role, filePath: png(), originalName: "x.png", label, subfolder });
  const ch = await put("character", "CHAR001 Rahul Mohapatra", "CHAR001_Rahul_front_v1");
  const pr = await put("prop", "PROP002 High-ankle boot", "PROP002_boot");
  const en = await put("environment", "ENV003 Rahul's bedroom", "ENV003_bedroom");
  const sh = await put("keyframe", null, "SH010_keyframe");
  const up = await put("design", "CHAR001 Rahul Mohapatra", "CHAR001_v1_Side-profile");
  assert.match(mock.pathOf(ch.storage_key), /^Akhada Film \/ 01 Characters \/ CHAR001 Rahul Mohapatra \/ CHAR001_Rahul_front_v1_[0-9a-f]{8}\.png$/);
  assert.match(mock.pathOf(pr.storage_key), /^Akhada Film \/ 02 Props \/ PROP002 High-ankle boot \/ PROP002_boot_/);
  assert.match(mock.pathOf(en.storage_key), /^Akhada Film \/ 03 Environments \/ ENV003 Rahul's bedroom \/ ENV003_bedroom_/);
  assert.match(mock.pathOf(sh.storage_key), /^Akhada Film \/ 04 Shot images \/ SH010_keyframe_/);
  assert.match(mock.pathOf(up.storage_key), /^Akhada Film \/ 08 Designer uploads \/ CHAR001 Rahul Mohapatra \/ /);
  // a second file for the same item reuses its folder
  const before = folderNames().filter((n) => n === "CHAR001 Rahul Mohapatra").length;
  await put("character", "CHAR001 Rahul Mohapatra", "CHAR001_Rahul_side_v1");
  assert.equal(folderNames().filter((n) => n === "CHAR001 Rahul Mohapatra").length, before);
});

test("renaming the project renames its Drive folder; files stay inside it, nothing is duplicated", async () => {
  const pid = await project("Working Title");
  const a = await store.putMedia({ projectId: pid, role: "character", filePath: png(), originalName: "a.png", label: "A", subfolder: "CHAR001 X" });
  assert.match(mock.pathOf(a.storage_key), /^Working Title \/ 01 Characters/);
  const foldersBefore = mock.state.foldersCreated;
  await db.query("UPDATE ai_movie_projects SET title = 'Final Title' WHERE id = $1", [pid]);
  const info = await store.projectFolderInfo(pid);
  assert.equal(info.folderName, "Final Title");
  assert.match(mock.pathOf(a.storage_key), /^Final Title \/ 01 Characters \/ CHAR001 X \//, "the existing file is now under the new name");
  const b = await store.putMedia({ projectId: pid, role: "character", filePath: png(), originalName: "b.png", label: "B", subfolder: "CHAR001 X" });
  assert.match(mock.pathOf(b.storage_key), /^Final Title \/ 01 Characters \/ CHAR001 X \//);
  assert.equal(mock.state.foldersCreated, foldersBefore, "no new folders were made by the rename");
  assert.equal(folderNames().filter((n) => n === "Working Title").length, 0);
});

test("two projects with the same title get different folders (the second one carries its number)", async () => {
  const p1 = await project("Same Name");
  const p2 = await project("Same Name");
  const i1 = await store.prepareProject(p1);
  const i2 = await store.prepareProject(p2);
  assert.equal(i1.folderName, "Same Name");
  assert.equal(i2.folderName, `Same Name (${p2})`);
  assert.notEqual(i1.link, i2.link);
});

test("an untitled project still gets a sensible folder; unsafe characters are replaced", async () => {
  const p = await project(null);
  assert.equal((await store.prepareProject(p)).folderName, `Project ${p}`);
  const q = await project("A/B: the <best> film?");
  assert.equal((await store.prepareProject(q)).folderName, "A-B- the -best- film");
});

test("the folder info for a project that has no folder yet is available without creating anything", async () => {
  const pid = await project("Not Yet");
  const before = mock.state.foldersCreated;
  const info = await store.projectFolderInfo(pid);
  assert.equal(info.folderName, "Not Yet");
  assert.equal(info.link, null);
  assert.equal(mock.state.foldersCreated, before);
  assert.equal(await store.projectFolderInfo(99999999), null);
});

test("local storage uses the same arrangement on disk", async () => {
  const root = path.join(tmp, "local");
  const local = createMediaStore({ db, backend: createLocalBackend({ root }), spoolDir: path.join(tmp, "spool-local") });
  const pid = await project("Local Film");
  await local.prepareProject(pid);
  assert.deepEqual(fs.readdirSync(path.join(root, "Local Film")).sort(), [...PROJECT_FOLDER_LAYOUT].sort());
  const row = await local.putMedia({ projectId: pid, role: "prop", filePath: png(), originalName: "p.png", label: "PROP001_pot", subfolder: "PROP001 Pot" });
  assert.match(row.storage_key, /^Local Film\/02 Props\/PROP001 Pot\/PROP001_pot_[0-9a-f]{8}\.png$/);
  assert.ok(fs.existsSync(path.join(root, row.storage_key)));
});
