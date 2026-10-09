// HTTP tests for the designer login lockdown and the upload/submit routes.
// Real Express + multer + Postgres; storage is the local-folder backend.
// FIXTURE data only.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import pg from "pg";
import { ensureProductionSchema, registerProductionRoutes, seedTestProject } from "../production.js";
import { ensureMediaSchema } from "../mediaStore.js";
import { setupProductionMedia } from "../productionMedia.js";
import { ensureDesignTaskSchema, registerDesignTaskRoutes, createDesignerTasks } from "../designTasks.js";
import { ensureSubmissionSchema, registerSubmissionRoutes, designerGatekeeper } from "../designSubmissions.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routes-test-"));
const uploadTmp = path.join(os.tmpdir(), "filmybase-uploads");
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let server, base, ids, ctxAsha, ctxRavi;

const png = (seed) => Buffer.concat([PNG_HEAD, crypto.createHash("sha256").update(String(seed) + Math.random()).digest(), Buffer.alloc(3000, 7)]);
const as = (who, extra = {}) => ({ headers: { "x-user": who, ...(extra.headers ?? {}) }, ...extra, });
async function call(who, method, url, body) {
  const options = { method, headers: { "x-user": who } };
  if (body !== undefined && !(body instanceof FormData)) { options.headers["Content-Type"] = "application/json"; options.body = JSON.stringify(body); }
  if (body instanceof FormData) options.body = body;
  const res = await fetch(`${base}${url}`, options);
  let json = null;
  try { json = await res.clone().json(); } catch { /* not JSON */ }
  return { status: res.status, json, res };
}
function form(bytes, name, fields = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("file", new Blob([bytes]), name);
  return fd;
}
const leftovers = () => (fs.existsSync(uploadTmp) ? fs.readdirSync(uploadTmp).length : 0);

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await db.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, role TEXT NOT NULL, concept_id INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await ensureProductionSchema(db);
  await ensureMediaSchema(db);
  await ensureDesignTaskSchema(db);
  await ensureSubmissionSchema(db);

  await db.query("DELETE FROM users WHERE username ~ '^(Boss|Asha|Ravi)-'"); // leftovers from earlier runs
  const mk = async (role, name) => (await db.query("INSERT INTO users (name, username, password_hash, password_salt, role) VALUES ($1,$2,'h','s',$3) RETURNING id, name, role", [name, `${name}-${crypto.randomUUID()}`, role])).rows[0];
  const admin = await mk("admin", "Boss");
  const asha = await mk("designer", "Asha");
  const ravi = await mk("designer", "Ravi");
  ids = { admin, asha, ravi };

  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'");
  const { projectId } = await seedTestProject(db);
  const assetId = async (name) => (await db.query("SELECT id FROM production_assets WHERE project_id = $1 AND name = $2", [projectId, name])).rows[0].id;
  const a = await createDesignerTasks(db, projectId, { assetIds: [await assetId("Rahul Mohapatra")], assigneeUserId: asha.id });
  const r = await createDesignerTasks(db, projectId, { assetIds: [await assetId("The Black Figure")], assigneeUserId: ravi.id });
  ctxAsha = { projectId, taskId: a.created[0].taskId };
  ctxRavi = { projectId, taskId: r.created[0].taskId };

  const app = express();
  app.use(express.json());
  const byName = { admin, asha, ravi };
  app.use((req, res, next) => { req.user = byName[req.headers["x-user"]] ?? null; next(); });
  const requireRole = (...roles) => (req, res, next) => (!req.user ? res.status(401).json({ error: "Please log in." }) : roles.includes(req.user.role) ? next() : res.status(403).json({ error: "no" }));
  app.use(designerGatekeeper);
  app.get("/api/concepts", requireRole("admin", "director"), (req, res) => res.json([]));
  app.get("/api/auth/users", requireRole("admin"), (req, res) => res.json([]));
  const media = setupProductionMedia({
    app, db, requireRole, backendDir: tmp, frontendUrl: "http://front", redirectUri: "http://back/cb",
    env: { MEDIA_BACKEND: "local", MEDIA_ROOT: path.join(tmp, "media"), MEDIA_SPOOL_DIR: path.join(tmp, "spool") },
  });
  registerProductionRoutes(app, db, requireRole);
  registerDesignTaskRoutes(app, db, requireRole);
  registerSubmissionRoutes(app, db, requireRole, { store: media.store, serveMedia: media.serveMedia });
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await db.end(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("a designer login can use ONLY /api/designer/*; every other area is refused", async () => {
  for (const [method, url] of [
    ["GET", `/api/production/${ctxAsha.projectId}/overview`],
    ["GET", `/api/production/${ctxAsha.projectId}/assets`],
    ["GET", `/api/production/${ctxAsha.projectId}/tasks`],
    ["GET", `/api/production/${ctxAsha.projectId}/tasks/${ctxAsha.taskId}`],
    ["GET", `/api/production/designers`],
    ["GET", "/api/production/media/1"],
    ["GET", "/api/production/storage/status"],
    ["POST", `/api/production/${ctxAsha.projectId}/tasks/${ctxAsha.taskId}/submit`],
    ["POST", `/api/production/${ctxAsha.projectId}/tasks/${ctxAsha.taskId}/uploads`],
    ["GET", "/api/concepts"],
    ["GET", "/api/auth/users"],
    ["GET", "/api/some/route/nobody/protected"],
  ]) {
    const r = await call("asha", method, url);
    assert.equal(r.status, 403, `${method} ${url}`);
  }
  assert.equal((await call("asha", "GET", "/api/designer/tasks")).status, 200);
});

test("not logged in -> 401 on designer and admin routes", async () => {
  assert.equal((await call("nobody", "GET", "/api/designer/tasks")).status, 401);
  assert.equal((await call("nobody", "GET", `/api/designer/tasks/${ctxAsha.taskId}`)).status, 401);
  assert.equal((await call("nobody", "POST", `/api/designer/tasks/${ctxAsha.taskId}/uploads`, form(png(1), "a.png"))).status, 401);
  assert.equal((await call("nobody", "GET", "/api/designer/media/1")).status, 401);
});

test("each designer sees only their own tasks; someone else's task looks like it does not exist", async () => {
  const mine = await call("asha", "GET", "/api/designer/tasks");
  assert.deepEqual(mine.json.tasks.map((t) => t.id), [ctxAsha.taskId]);
  const his = await call("ravi", "GET", "/api/designer/tasks");
  assert.deepEqual(his.json.tasks.map((t) => t.id), [ctxRavi.taskId]);
  const detail = await call("asha", "GET", `/api/designer/tasks/${ctxAsha.taskId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.brief.asset.name, "Rahul Mohapatra");
  assert.ok(Array.isArray(detail.json.submissions));
  const foreign = await call("asha", "GET", `/api/designer/tasks/${ctxRavi.taskId}`);
  const missing = await call("asha", "GET", `/api/designer/tasks/99999999`);
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.json, missing.json);
});

test("upload as the assigned designer works; others' tasks, bad types and missing files are refused and leave no temp files", async () => {
  const before = leftovers();
  const ok = await call("asha", "POST", `/api/designer/tasks/${ctxAsha.taskId}/uploads`, form(png("a"), "front.png", { viewName: "Neutral front portrait", fileRole: "clean" }));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.versionNo, 1);
  assert.equal((await call("asha", "POST", `/api/designer/tasks/${ctxRavi.taskId}/uploads`, form(png("b"), "x.png"))).status, 404);
  assert.equal((await call("asha", "POST", `/api/designer/tasks/${ctxAsha.taskId}/uploads`, form(Buffer.from("MZ"), "evil.exe"))).status, 400);
  assert.equal((await call("asha", "POST", `/api/designer/tasks/${ctxAsha.taskId}/uploads`, form(Buffer.from("<html>"), "fake.png"))).status, 400);
  assert.equal((await call("asha", "POST", `/api/designer/tasks/${ctxAsha.taskId}/uploads`, form(png("c"), "c.png", { fileRole: "banner" }))).status, 400);
  const none = await call("asha", "POST", `/api/designer/tasks/${ctxAsha.taskId}/uploads`, new FormData());
  assert.equal(none.status, 400);
  assert.equal(leftovers(), before, "no temporary upload files are left behind");
  const detail = await call("asha", "GET", `/api/designer/tasks/${ctxAsha.taskId}`);
  assert.equal(detail.json.submissions[0].files.length, 1);
  assert.equal(detail.json.submissions[0].files[0].viewName, "Neutral front portrait");
});

test("a designer sees their own files (with ranges); never another designer's, never through the admin route", async () => {
  const mine = (await call("asha", "GET", `/api/designer/tasks/${ctxAsha.taskId}`)).json.submissions[0].files[0];
  const full = await call("asha", "GET", `/api/designer/media/${mine.mediaId}`);
  assert.equal(full.status, 200);
  assert.equal(full.res.headers.get("content-type"), "image/png");
  assert.equal(full.res.headers.get("x-content-type-options"), "nosniff");
  const part = await fetch(`${base}/api/designer/media/${mine.mediaId}`, { headers: { "x-user": "asha", Range: "bytes=0-7" } });
  assert.equal(part.status, 206);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(PNG_HEAD));

  // Ravi uploads his own, Asha cannot see it
  await call("ravi", "POST", `/api/designer/tasks/${ctxRavi.taskId}/uploads`, form(png("r"), "r.png"));
  const his = (await call("ravi", "GET", `/api/designer/tasks/${ctxRavi.taskId}`)).json.submissions[0].files[0];
  assert.equal((await call("asha", "GET", `/api/designer/media/${his.mediaId}`)).status, 404);
  assert.equal((await call("ravi", "GET", `/api/designer/media/${mine.mediaId}`)).status, 404);
  assert.equal((await call("asha", "GET", "/api/designer/media/999999")).status, 404);
  assert.equal((await call("asha", "GET", `/api/production/media/${mine.mediaId}`)).status, 403);
  assert.equal((await call("admin", "GET", `/api/production/media/${his.mediaId}`)).status, 200);
});

test("relabel and remove in the draft, then submit; a second submit and later changes are refused", async () => {
  const t = (await call("asha", "GET", `/api/designer/tasks/${ctxAsha.taskId}`)).json;
  const file = t.submissions[0].files[0];
  assert.equal((await call("asha", "PATCH", `/api/designer/tasks/${ctxAsha.taskId}/uploads/${file.id}`, { viewName: "Front", fileRole: "clean" })).status, 200);
  assert.equal((await call("asha", "PATCH", `/api/designer/tasks/${ctxAsha.taskId}/uploads/${file.id}`, {})).status, 400);
  assert.equal((await call("asha", "PATCH", `/api/designer/tasks/${ctxRavi.taskId}/uploads/${file.id}`, { viewName: "x" })).status, 404);

  assert.equal((await call("asha", "POST", `/api/designer/tasks/${ctxAsha.taskId}/submit`, {})).status, 400); // no revision
  const stale = await call("asha", "POST", `/api/designer/tasks/${ctxAsha.taskId}/submit`, { expectedRevision: t.revision - 1 });
  assert.equal(stale.status, 409);
  const sent = await call("asha", "POST", `/api/designer/tasks/${ctxAsha.taskId}/submit`, { expectedRevision: t.revision, note: "Ready for review" });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.versionNo, 1);
  const after = (await call("asha", "GET", `/api/designer/tasks/${ctxAsha.taskId}`)).json;
  assert.equal(after.state, "submitted");
  assert.equal(after.submissions[0].note, "Ready for review");
  assert.equal((await call("asha", "POST", `/api/designer/tasks/${ctxAsha.taskId}/submit`, { expectedRevision: after.revision })).status, 409);
  assert.equal((await call("asha", "POST", `/api/designer/tasks/${ctxAsha.taskId}/uploads`, form(png("late"), "late.png"))).status, 409);
  assert.equal((await call("asha", "DELETE", `/api/designer/tasks/${ctxAsha.taskId}/uploads/${file.id}`)).status, 409);
});

test("comments: a designer can write on their own task only", async () => {
  const mine = await call("asha", "POST", `/api/designer/tasks/${ctxAsha.taskId}/comments`, { body: "Which hairstyle in Scene 11?", kind: "clarification" });
  assert.equal(mine.status, 200);
  assert.equal((await call("asha", "POST", `/api/designer/tasks/${ctxRavi.taskId}/comments`, { body: "hi" })).status, 404);
  assert.equal((await call("asha", "POST", `/api/designer/tasks/${ctxAsha.taskId}/comments`, { body: "  " })).status, 400);
  const t = (await call("asha", "GET", `/api/designer/tasks/${ctxAsha.taskId}`)).json;
  assert.deepEqual(t.comments.map((c) => [c.kind, c.author_name]), [["clarification", "Asha"]]);
});

test("admin can assign by designer login, list designers, and upload/submit on any task", async () => {
  const list = await call("admin", "GET", "/api/production/designers");
  const listed = list.json.designers.map((d) => d.id);
  assert.ok(listed.includes(ids.asha.id) && listed.includes(ids.ravi.id));
  assert.ok(!listed.includes(ids.admin.id), "admins are not listed as designers");
  const t = (await call("admin", "GET", `/api/production/${ctxRavi.projectId}/tasks/${ctxRavi.taskId}`)).json;
  assert.equal(t.assigneeUserId, ids.ravi.id);
  assert.equal(t.submissions.length, 1);

  const up = await call("admin", "POST", `/api/production/${ctxRavi.projectId}/tasks/${ctxRavi.taskId}/uploads`, form(png("adm"), "adm.png", { viewName: "Side" }));
  assert.equal(up.status, 200);
  assert.equal((await call("admin", "POST", `/api/production/${ctxRavi.projectId}/tasks/${ctxRavi.taskId}/uploads`, form(png("adm2"), "adm.png"))).status, 200);
  // wrong project for that task id -> not found
  assert.equal((await call("admin", "POST", `/api/production/99999999/tasks/${ctxRavi.taskId}/uploads`, form(png("x"), "x.png"))).status, 404);
  assert.equal((await call("admin", "POST", `/api/production/abc/tasks/${ctxRavi.taskId}/uploads`, form(png("y"), "y.png"))).status, 400);
  const cur = (await call("admin", "GET", `/api/production/${ctxRavi.projectId}/tasks/${ctxRavi.taskId}`)).json;
  const sent = await call("admin", "POST", `/api/production/${ctxRavi.projectId}/tasks/${ctxRavi.taskId}/submit`, { expectedRevision: cur.revision });
  assert.equal(sent.status, 200);
});
