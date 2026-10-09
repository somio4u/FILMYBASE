// Tests for mediaStore.js. Drive is a LOCAL MOCK (tests/mockDrive.js) — these
// prove the app's own logic (chunking, resume, dedupe, spool/retry, range
// reads, validation), NOT that real Google Drive accepts it. FIXTURE ONLY.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { ensureProductionSchema } from "../production.js";
import { ensureMediaSchema, createMediaStore, createDriveBackend, createLocalBackend, backendNameFromEnv, magicMatches } from "../mediaStore.js";
import { startMockDrive } from "./mockDrive.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "media-test-"));
let mock;
let connected = true;

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function makeFile(name, bytes) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, bytes);
  return p;
}
function png(size, seed = 1) {
  return Buffer.concat([PNG_HEAD, crypto.createHash("sha256").update(String(seed)).digest(), Buffer.alloc(Math.max(0, size - 40), seed % 250)]);
}
async function newProject(title = "Test Film") {
  return (await db.query("INSERT INTO ai_movie_projects (pasted_text, title) VALUES ('x', $1) RETURNING id", [title])).rows[0].id;
}
function driveStore(opts = {}) {
  const backend = createDriveBackend({
    db, getAccessToken: async () => (connected ? mock.token : null),
    apiBase: mock.apiBase, uploadBase: mock.uploadBase, chunkSize: 256 * 1024, ...opts,
  });
  return createMediaStore({ db, backend, spoolDir: path.join(tmp, "spool-" + crypto.randomUUID()) });
}
async function readAll(stream) {
  const parts = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts);
}

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await ensureProductionSchema(db);
  await ensureMediaSchema(db);
  await ensureMediaSchema(db); // idempotent
  await db.query("DELETE FROM production_drive_folders");
  mock = await startMockDrive();
});
test.after(async () => {
  await mock.close();
  await db.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Drive: a file is stored with the right bytes, in project/role folders, row keyed by Drive id", async () => {
  const store = driveStore();
  const pid = await newProject("Akhada");
  const bytes = png(10_000, 11);
  const row = await store.putMedia({ projectId: pid, role: "design", filePath: makeFile("a.png", bytes), originalName: "a.png", label: "CHAR001_v1" });
  assert.equal(row.status, "stored");
  assert.equal(row.backend, "gdrive");
  assert.match(row.stored_name, /^CHAR001_v1_[0-9a-f]{8}\.png$/);
  assert.ok(mock.files.get(row.storage_key).data.equals(bytes));
  // folders: "<id>-Akhada" then "designs"
  const folderNames = [...mock.files.values()].filter((f) => f.isFolder).map((f) => f.name);
  assert.ok(folderNames.includes(`${pid}-Akhada`) && folderNames.includes("designs"));
  assert.equal(row.spool_path, null);
});

test("Drive: identical content in the same project is stored once; folders are not re-created", async () => {
  const store = driveStore();
  const pid = await newProject();
  const bytes = png(5_000, 22);
  const a = await store.putMedia({ projectId: pid, role: "design", filePath: makeFile("b1.png", bytes), originalName: "b1.png" });
  const uploadsBefore = mock.state.uploads;
  const foldersBefore = mock.state.foldersCreated;
  const b = await store.putMedia({ projectId: pid, role: "design", filePath: makeFile("b2.png", bytes), originalName: "b2.png" });
  assert.equal(b.id, a.id);
  assert.equal(b.deduplicated, true);
  assert.equal(mock.state.uploads, uploadsBefore);
  // a different file in the same folder reuses folders
  await store.putMedia({ projectId: pid, role: "design", filePath: makeFile("b3.png", png(5_000, 23)), originalName: "b3.png" });
  assert.equal(mock.state.foldersCreated, foldersBefore);
});

test("Drive: a large file goes up in chunks and reads back identical", async () => {
  const store = driveStore();
  const pid = await newProject();
  const bytes = png(700 * 1024 + 123, 33); // > 2 chunks of 256 KiB
  const row = await store.putMedia({ projectId: pid, role: "video_take", filePath: makeFile("c.png", bytes), originalName: "c.png" });
  assert.equal(row.status, "stored");
  assert.ok(mock.files.get(row.storage_key).data.equals(bytes));
});

test("Drive: a server error mid-upload resumes instead of failing or duplicating", async () => {
  const store = driveStore();
  const pid = await newProject();
  const bytes = png(700 * 1024, 44);
  mock.state.failChunkOnce = 1;
  const before = mock.state.uploads;
  const row = await store.putMedia({ projectId: pid, role: "keyframe", filePath: makeFile("d.png", bytes), originalName: "d.png" });
  assert.equal(row.status, "stored");
  assert.equal(mock.state.uploads, before + 1); // exactly one finished file
  assert.ok(mock.files.get(row.storage_key).data.equals(bytes));
});

test("Drive: ranged reads return the right slice (video seeking)", async () => {
  const store = driveStore();
  const pid = await newProject();
  const bytes = png(300_000, 55);
  const row = await store.putMedia({ projectId: pid, role: "design", filePath: makeFile("e.png", bytes), originalName: "e.png" });
  const part = await store.openMedia(row.id, { start: 1000, end: 1999 });
  assert.equal(part.size, bytes.length);
  assert.ok((await readAll(part.stream)).equals(bytes.subarray(1000, 2000)));
  const whole = await store.openMedia(row.id);
  assert.ok((await readAll(whole.stream)).equals(bytes));
});

test("Drive down / not connected: file is kept in the spool as pending, then uploaded later", async () => {
  const store = driveStore();
  const pid = await newProject();
  const bytes = png(8_000, 66);
  mock.state.down = true;
  const pending = await store.putMedia({ projectId: pid, role: "design", filePath: makeFile("f.png", bytes), originalName: "f.png" });
  assert.equal(pending.status, "pending_upload");
  assert.ok(pending.last_error && pending.attempts === 1);
  assert.ok(fs.existsSync(pending.spool_path));
  // still viewable while pending
  assert.ok((await readAll((await store.openMedia(pending.id)).stream)).equals(bytes));
  mock.state.down = false;
  const flushed = await store.flushPendingUploads();
  assert.equal(flushed.stored, 1);
  const after = (await db.query("SELECT * FROM production_media_files WHERE id = $1", [pending.id])).rows[0];
  assert.equal(after.status, "stored");
  assert.equal(after.spool_path, null);
  assert.ok(!fs.existsSync(pending.spool_path));
  assert.ok(mock.files.get(after.storage_key).data.equals(bytes));

  // not connected at all -> clear, kept as pending
  connected = false;
  const np = await store.putMedia({ projectId: pid, role: "design", filePath: makeFile("g.png", png(3_000, 67)), originalName: "g.png" });
  assert.equal(np.status, "pending_upload");
  assert.match(np.last_error, /not connected/i);
  connected = true;
});

test("a pending upload gives up (status failed) after the attempt limit, with the reason kept", async () => {
  const store = driveStore();
  const pid = await newProject();
  mock.state.down = true;
  const row = await store.putMedia({ projectId: pid, role: "design", filePath: makeFile("h.png", png(2_000, 77)), originalName: "h.png" });
  for (let i = 0; i < 3; i++) await store.flushPendingUploads({ maxAttempts: 3 });
  const after = (await db.query("SELECT status, last_error FROM production_media_files WHERE id = $1", [row.id])).rows[0];
  mock.state.down = false;
  assert.equal(after.status, "failed");
  assert.ok(after.last_error);
});

test("local backend stores and serves files; paths cannot escape the root", async () => {
  const root = path.join(tmp, "localroot");
  const store = createMediaStore({ db, backend: createLocalBackend({ root }), spoolDir: path.join(tmp, "spool-local") });
  const pid = await newProject();
  const bytes = png(4_000, 88);
  const row = await store.putMedia({ projectId: pid, role: "audio", filePath: makeFile("i.png", bytes), originalName: "i.png" });
  assert.equal(row.backend, "local");
  assert.ok(fs.readFileSync(path.join(root, row.storage_key)).equals(bytes));
  assert.ok((await readAll((await store.openMedia(row.id, { start: 0, end: 9 })).stream)).equals(bytes.subarray(0, 10)));
  await assert.rejects(createLocalBackend({ root }).open("../../etc/passwd"), /Unsafe/);
});

test("rejects disallowed types, empty files, and files that are not what their name says", async () => {
  const store = driveStore();
  const pid = await newProject();
  await assert.rejects(store.putMedia({ projectId: pid, role: "design", filePath: makeFile("x.exe", Buffer.from("MZ")), originalName: "x.exe" }), /not allowed/);
  await assert.rejects(store.putMedia({ projectId: pid, role: "design", filePath: makeFile("empty.png", Buffer.alloc(0)), originalName: "empty.png" }), /empty/);
  await assert.rejects(store.putMedia({ projectId: pid, role: "design", filePath: makeFile("fake.png", Buffer.from("<html>not an image</html>")), originalName: "fake.png" }), /does not look like/);
  assert.equal((await db.query("SELECT count(*)::int n FROM production_media_files WHERE project_id = $1", [pid])).rows[0].n, 0);
});

test("the same content in two different projects is kept separately", async () => {
  const store = driveStore();
  const p1 = await newProject();
  const p2 = await newProject();
  const bytes = png(3_500, 99);
  const a = await store.putMedia({ projectId: p1, role: "design", filePath: makeFile("j.png", bytes), originalName: "j.png" });
  const b = await store.putMedia({ projectId: p2, role: "design", filePath: makeFile("j2.png", bytes), originalName: "j2.png" });
  assert.notEqual(a.id, b.id);
});

test("backend choice: Drive by default on Render, local elsewhere, explicit setting wins", () => {
  assert.equal(backendNameFromEnv({ RENDER: "true" }), "gdrive");
  assert.equal(backendNameFromEnv({}), "local");
  assert.equal(backendNameFromEnv({ RENDER: "true", MEDIA_BACKEND: "local" }), "local");
  assert.equal(magicMatches("image/png", PNG_HEAD), true);
  assert.equal(magicMatches("image/png", Buffer.from("GIF89a")), false);
});
