// The "connect Google Drive from the app" backend: status, test, disconnect,
// and the sign-in return path. Google is a LOCAL MOCK (tests/mockDrive.js):
// this proves our logic and our error messages, not that real Google accepts
// the credentials. FIXTURE ONLY.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import pg from "pg";
import { ensureProductionSchema } from "../production.js";
import { ensureMediaSchema, explainStorageError, createLocalBackend } from "../mediaStore.js";
import { setupProductionMedia } from "../productionMedia.js";
import { startMockDrive } from "./mockDrive.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drive-connect-"));
let mock, server, base, media, loggedIn = true;
const requireRole = () => (req, res, next) => (loggedIn ? next() : res.status(401).json({ error: "Please log in." }));
const ENV = { MEDIA_BACKEND: "gdrive", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret" };

async function build(env) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = loggedIn ? { id: 1, role: "admin" } : null; next(); });
  const m = setupProductionMedia({
    app, db, requireRole, backendDir: tmp, frontendUrl: "http://front", redirectUri: "http://back/cb", env,
    driveOverrides: { apiBase: mock.apiBase, uploadBase: mock.uploadBase }, googleOverrides: { tokenUrl: mock.tokenUrl, revokeUrl: mock.revokeUrl },
  });
  const srv = app.listen(0);
  return { m, srv, url: `http://127.0.0.1:${srv.address().port}` };
}
const get = async (p) => (await fetch(`${base}${p}`)).json();
const post = async (p) => { const r = await fetch(`${base}${p}`, { method: "POST" }); return { status: r.status, json: await r.json() }; };
async function setTokens({ access = "test-token", expiresIn = 3_600_000 } = {}) {
  await db.query("DELETE FROM production_drive_tokens");
  await db.query("INSERT INTO production_drive_tokens (access_token, refresh_token, expiry_date) VALUES ($1,'refresh-1',$2)", [access, Date.now() + expiresIn]);
}

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await ensureProductionSchema(db);
  await ensureMediaSchema(db);
  mock = await startMockDrive();
  ({ m: media, srv: server, url: base } = await build(ENV));
});
test.after(async () => { server.close(); await mock.close(); await db.end(); fs.rmSync(tmp, { recursive: true, force: true }); });
test.beforeEach(() => { mock.state.forceError = null; mock.state.tokenFails = false; mock.state.down = false; loggedIn = true; });

test("status: not connected -> connected (with the account's name and email) -> no secrets anywhere", async () => {
  await db.query("DELETE FROM production_drive_tokens");
  let s = await get("/api/production/storage/status");
  assert.equal(s.backend, "gdrive");
  assert.equal(s.configured, true);
  assert.equal(s.driveConnected, false);
  assert.equal(s.reconnectNeeded, false);
  assert.equal(s.account, null);
  assert.equal(s.setup.redirectUri, "http://back/cb");

  await setTokens();
  s = await get("/api/production/storage/status");
  assert.equal(s.driveConnected, true);
  assert.deepEqual(s.account, { displayName: "Test Person", emailAddress: "test@example.com" });
  const raw = JSON.stringify(s);
  for (const secret of ["test-token", "refresh-1", "csecret"]) assert.ok(!raw.includes(secret), `${secret} must not appear`);
});

test("status: a saved sign-in that Google no longer accepts shows 'reconnect needed'", async () => {
  await setTokens({ access: "stale", expiresIn: -1000 }); // expired -> must refresh
  mock.state.tokenFails = true;
  const s = await get("/api/production/storage/status");
  assert.equal(s.driveConnected, false);
  assert.equal(s.reconnectNeeded, true);
});

test("status: missing server credentials is reported as not configured", async () => {
  const b = await build({ MEDIA_BACKEND: "gdrive" });
  const s = await (await fetch(`${b.url}/api/production/storage/status`)).json();
  assert.equal(s.configured, false);
  const t = await (await fetch(`${b.url}/api/production/storage/test`, { method: "POST" })).json();
  assert.equal(t.ok, false);
  assert.equal(t.code, "not_configured");
  b.srv.close();
});

test("connection test: success proves upload, read-back and cleanup, and leaves no file behind", async () => {
  await setTokens();
  const before = [...mock.files.values()].filter((f) => !f.isFolder).length;
  const r = (await post("/api/production/storage/test")).json;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.steps, ["folder", "upload", "download", "cleanup"]);
  assert.equal([...mock.files.values()].filter((f) => !f.isFolder).length, before);
});

test("connection test: every common Google failure becomes a plain-English message with a code", async () => {
  await setTokens();
  const cases = [
    [{ status: 403, body: { error: { code: 403, message: "Google Drive API has not been used in project 123 before or it is disabled.", errors: [{ reason: "accessNotConfigured" }] } } }, "api_not_enabled", /Google Drive API is not switched on/],
    [{ status: 401, body: { error: { code: 401, message: "Invalid Credentials" } } }, "reconnect_needed", /Connect Google Drive again/],
    [{ status: 403, body: { error: { code: 403, message: "The user's Drive storage quota has been exceeded.", errors: [{ reason: "storageQuotaExceeded" }] } } }, "drive_full", /storage is full/],
    [{ status: 403, body: { error: { code: 403, message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] } } }, "permission", /refused permission/],
    [{ status: 404, body: { error: { code: 404, message: "File not found: abc" } } }, "folder_missing", /could not be found/],
    [{ status: 500, body: { error: { code: 500, message: "Backend Error" } } }, "google_down", /having trouble/],
  ];
  for (const [forced, code, message] of cases) {
    mock.state.forceError = forced;
    const r = (await post("/api/production/storage/test")).json;
    assert.equal(r.ok, false, code);
    assert.equal(r.code, code);
    assert.match(r.message, message);
    assert.ok(!JSON.stringify(r).includes("test-token"));
  }
});

test("connection test: not connected is explained; local storage test also works", async () => {
  await db.query("DELETE FROM production_drive_tokens");
  const r = (await post("/api/production/storage/test")).json;
  assert.equal(r.ok, false);
  assert.equal(r.code, "not_connected");

  const local = await build({ MEDIA_BACKEND: "local", MEDIA_ROOT: path.join(tmp, "m"), MEDIA_SPOOL_DIR: path.join(tmp, "s") });
  const lr = await (await fetch(`${local.url}/api/production/storage/test`, { method: "POST" })).json();
  assert.equal(lr.ok, true);
  assert.equal(lr.backend, "local");
  const ls = await (await fetch(`${local.url}/api/production/storage/status`)).json();
  assert.equal(ls.driveConnected, null);
  local.srv.close();
});

test("disconnect: asks Google to cancel the sign-in, forgets tokens and folder memory, is safe to repeat", async () => {
  await setTokens();
  await db.query("INSERT INTO production_drive_folders (path_key, folder_id) VALUES ('x','y') ON CONFLICT DO NOTHING");
  const r = (await post("/api/production/drive/disconnect")).json;
  assert.equal(r.ok, true);
  assert.equal(r.wasConnected, true);
  assert.equal(r.revokedAtGoogle, true);
  assert.deepEqual(mock.state.revoked.slice(-1), ["refresh-1"]);
  assert.equal((await db.query("SELECT count(*)::int n FROM production_drive_tokens")).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int n FROM production_drive_folders")).rows[0].n, 0);
  assert.equal((await get("/api/production/storage/status")).driveConnected, false);
  const again = (await post("/api/production/drive/disconnect")).json;
  assert.equal(again.wasConnected, false);
});

test("admin only: not logged in is refused on every storage route", async () => {
  loggedIn = false;
  for (const [method, p] of [["GET", "/api/production/storage/status"], ["POST", "/api/production/storage/test"], ["POST", "/api/production/drive/disconnect"], ["GET", "/api/production/drive/connect"]]) {
    assert.equal((await fetch(`${base}${p}`, { method, redirect: "manual" })).status, 401, p);
  }
});

test("sign-in return: a good code stores tokens and lands back with 'connected'; bad cases say why", async () => {
  await db.query("DELETE FROM production_drive_tokens");
  const start = await fetch(`${base}/api/production/drive/connect`, { redirect: "manual" });
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const redirects = [];
  const res = { redirect: (u) => redirects.push(u) };

  await media.handleDriveCallback({ query: { state, code: "good-code" } }, res);
  assert.equal(redirects.at(-1), "http://front/?googleDriveConnected=1");
  const row = (await db.query("SELECT access_token, refresh_token FROM production_drive_tokens")).rows[0];
  assert.equal(row.refresh_token, "refresh-1");
  assert.equal((await get("/api/production/storage/status")).driveConnected, true);

  // the same state cannot be used twice
  await media.handleDriveCallback({ query: { state, code: "good-code" } }, res);
  assert.equal(redirects.at(-1), "http://front/?googleDriveError=1&reason=expired");

  const state2 = new URL((await fetch(`${base}/api/production/drive/connect`, { redirect: "manual" })).headers.get("location")).searchParams.get("state");
  await media.handleDriveCallback({ query: { state: state2, error: "access_denied" } }, res);
  assert.equal(redirects.at(-1), "http://front/?googleDriveError=1&reason=denied");

  const state3 = new URL((await fetch(`${base}/api/production/drive/connect`, { redirect: "manual" })).headers.get("location")).searchParams.get("state");
  await media.handleDriveCallback({ query: { state: state3, code: "wrong-code" } }, res);
  assert.equal(redirects.at(-1), "http://front/?googleDriveError=1&reason=token");

  await media.handleDriveCallback({ query: { state: "drive.forged", code: "good-code" } }, res);
  assert.equal(redirects.at(-1), "http://front/?googleDriveError=1&reason=expired");
});

test("a remembered folder that Google no longer has is forgotten and re-made once, instead of failing every upload", async () => {
  await setTokens();
  const pid = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text) VALUES ('Stale', 'x') RETURNING id")).rows[0].id;
  const f = path.join(tmp, "stale.png");
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500, 3)]));
  // Poison the folder memory: these folder ids do not exist at "Google".
  await db.query("DELETE FROM production_drive_folders");
  await db.query("INSERT INTO production_drive_folders (path_key, folder_id) VALUES ($1, 'gone-folder'), ($2, 'gone-child')", [`${pid}-Stale`, `${pid}-Stale/designs`]);
  const foldersBefore = mock.state.foldersCreated;
  const row = await media.store.putMedia({ projectId: pid, role: "design", filePath: f, originalName: "stale.png", label: "T" });
  assert.equal(row.status, "stored", row.last_error);
  assert.ok(mock.files.has(row.storage_key), "the file really is at Google");
  assert.equal(mock.state.foldersCreated, foldersBefore + 2, "the two folders were re-made once");
  const remembered = (await db.query("SELECT folder_id FROM production_drive_folders")).rows.map((r) => r.folder_id);
  assert.ok(!remembered.includes("gone-folder") && remembered.length === 2, "the memory now holds real folders");
});

test("explainStorageError covers network failures and passes unknown text through", () => {
  assert.equal(explainStorageError(new Error("fetch failed")).code, "network");
  assert.equal(explainStorageError(Object.assign(new Error("x"), { status: 429 })).code, "rate_limited");
  assert.match(explainStorageError(new Error("something odd")).message, /something odd/);
  assert.equal(typeof createLocalBackend, "function");
});
