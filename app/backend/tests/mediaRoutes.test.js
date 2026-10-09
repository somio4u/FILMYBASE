// HTTP-level tests for productionMedia.js (streaming route, status, sign-in
// state check). Drive is the LOCAL MOCK — fixture only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import pg from "pg";
import { ensureProductionSchema } from "../production.js";
import { ensureMediaSchema } from "../mediaStore.js";
import { setupProductionMedia } from "../productionMedia.js";
import { startMockDrive } from "./mockDrive.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "media-routes-"));
let mock, server, base, media, loggedIn = true;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(5000, 7)]);
const requireRole = () => (req, res, next) => (loggedIn ? next() : res.status(401).json({ error: "Please log in." }));

async function store(name, bytes, role = "design") {
  const pid = (await db.query("INSERT INTO ai_movie_projects (pasted_text) VALUES ('x') RETURNING id")).rows[0].id;
  const f = path.join(tmp, name);
  fs.writeFileSync(f, bytes);
  return media.store.putMedia({ projectId: pid, role, filePath: f, originalName: name, label: "T" });
}

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await ensureProductionSchema(db);
  await ensureMediaSchema(db);
  await db.query("DELETE FROM production_drive_tokens");
  await db.query("INSERT INTO production_drive_tokens (access_token, refresh_token, expiry_date) VALUES ('test-token','r',$1)", [Date.now() + 3_600_000]);
  mock = await startMockDrive();
  const app = express();
  media = setupProductionMedia({
    app, db, requireRole, backendDir: tmp, frontendUrl: "http://front", redirectUri: "http://back/cb",
    env: { MEDIA_BACKEND: "gdrive", GOOGLE_CLIENT_ID: "cid" },
    driveOverrides: { apiBase: mock.apiBase, uploadBase: mock.uploadBase },
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  await mock.close();
  await db.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("streams a stored file with correct headers; 206 for a byte range", async () => {
  const row = await store("a.png", PNG);
  const full = await fetch(`${base}/api/production/media/${row.id}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "image/png");
  assert.equal(full.headers.get("x-content-type-options"), "nosniff");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(PNG));

  const part = await fetch(`${base}/api/production/media/${row.id}`, { headers: { Range: "bytes=10-19" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 10-19/${PNG.length}`);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(PNG.subarray(10, 20)));

  const tail = await fetch(`${base}/api/production/media/${row.id}`, { headers: { Range: "bytes=-5" } });
  assert.equal(tail.status, 206);
  assert.ok(Buffer.from(await tail.arrayBuffer()).equals(PNG.subarray(PNG.length - 5)));

  assert.equal((await fetch(`${base}/api/production/media/${row.id}`, { headers: { Range: `bytes=${PNG.length + 10}-` } })).status, 416);
  assert.equal((await fetch(`${base}/api/production/media/${row.id}`, { headers: { Range: "garbage" } })).status, 416);
});

test("HTML and JSON uploads are served as downloads only (cannot run in the app's origin)", async () => {
  const html = await store("page.html", Buffer.from("<script>alert(1)</script>"), "export");
  const res = await fetch(`${base}/api/production/media/${html.id}`);
  assert.match(res.headers.get("content-disposition"), /^attachment/);
  const img = await store("b.png", Buffer.concat([PNG, Buffer.from([1])]));
  assert.match((await fetch(`${base}/api/production/media/${img.id}`)).headers.get("content-disposition"), /^inline/);
});

test("requires login; unknown or invalid ids fail cleanly", async () => {
  const row = await store("c.png", Buffer.concat([PNG, Buffer.from([2])]));
  loggedIn = false;
  assert.equal((await fetch(`${base}/api/production/media/${row.id}`)).status, 401);
  assert.equal((await fetch(`${base}/api/production/storage/status`)).status, 401);
  loggedIn = true;
  assert.equal((await fetch(`${base}/api/production/media/99999999`)).status, 404);
  assert.equal((await fetch(`${base}/api/production/media/abc`)).status, 400);
});

test("storage status reports backend, connection and file counts (no secrets)", async () => {
  const res = await fetch(`${base}/api/production/storage/status`);
  const body = await res.json();
  assert.equal(body.backend, "gdrive");
  assert.equal(body.driveConnected, true);
  assert.ok(body.files.stored >= 1);
  assert.ok(!JSON.stringify(body).includes("test-token"));
});

test("Drive connect redirects to Google with drive.file only and a state; callback rejects a bad state", async () => {
  const res = await fetch(`${base}/api/production/drive/connect`, { redirect: "manual" });
  assert.equal(res.status, 302);
  const url = new URL(res.headers.get("location"));
  assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.file");
  assert.match(url.searchParams.get("state"), /^drive\.[0-9a-f]{32}$/);
  assert.equal(url.searchParams.get("access_type"), "offline");

  const fakeRes = { redirect: (u) => (fakeRes.url = u) };
  await media.handleDriveCallback({ query: { state: "drive.forged", code: "x" } }, fakeRes);
  assert.equal(fakeRes.url, "http://front/?googleDriveError=1");
  const tokens = (await db.query("SELECT count(*)::int n FROM production_drive_tokens")).rows[0].n;
  assert.equal(tokens, 1); // forged callback changed nothing
});
