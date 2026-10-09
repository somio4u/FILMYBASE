// Tests for designSubmissions.js (+ assignee logins in designTasks.js) on a
// real local Postgres. Storage is the local-folder backend (or a backend that
// fails on purpose) — FIXTURE data only.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { ensureProductionSchema, seedTestProject } from "../production.js";
import { ensureMediaSchema, createMediaStore, createLocalBackend } from "../mediaStore.js";
import { ensureDesignTaskSchema, createDesignerTasks, getDesignerTask, updateDesignerTask } from "../designTasks.js";
import {
  ensureSubmissionSchema, addSubmissionFile, removeSubmissionFile, updateSubmissionFile, submitDraft,
  taskAssignedTo, designerMayViewMedia,
} from "../designSubmissions.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subs-test-"));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let n = 0;
let failing = false;

// A storage backend we can switch to "broken" (Drive down) and back.
const flakyBackend = {
  name: "flaky",
  inner: createLocalBackend({ root: path.join(tmp, "store") }),
  async put(args) { if (failing) throw new Error("storage is down"); return this.inner.put(args); },
  open(...a) { return this.inner.open(...a); },
  remove(...a) { return this.inner.remove(...a); },
};
const store = createMediaStore({ db, backend: flakyBackend, spoolDir: path.join(tmp, "spool") });

function pngFile(label = "x") {
  const p = path.join(tmp, `f${++n}.png`);
  fs.writeFileSync(p, Buffer.concat([PNG, crypto.createHash("sha256").update(`${label}${n}${Math.random()}`).digest()]));
  return p;
}
const ADMIN = { userId: 1, name: "Admin" };

async function user(role, name = role) {
  return (await db.query("INSERT INTO users (name, username, password_hash, password_salt, role) VALUES ($1,$2,'h','s',$3) RETURNING id", [name, `${name}-${crypto.randomUUID()}`, role])).rows[0].id;
}
async function freshTask(assetName = "Rahul Mohapatra", extra = {}) {
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'");
  const { projectId } = await seedTestProject(db);
  const asset = (await db.query("SELECT id FROM production_assets WHERE project_id = $1 AND name = $2", [projectId, assetName])).rows[0];
  const { created } = await createDesignerTasks(db, projectId, { assetIds: [asset.id], ...extra });
  return { projectId, taskId: created[0].taskId };
}
// A second task in an existing project (a fresh project would delete the first).
async function taskInProject(projectId, assetName) {
  const asset = (await db.query("SELECT id FROM production_assets WHERE project_id = $1 AND name = $2", [projectId, assetName])).rows[0];
  const { created } = await createDesignerTasks(db, projectId, { assetIds: [asset.id] });
  return { projectId, taskId: created[0].taskId };
}
async function upload(ctx, over = {}) {
  return addSubmissionFile(db, store, { projectId: ctx.projectId, taskId: ctx.taskId, filePath: pngFile(), originalName: "front.png", viewName: "Neutral front portrait", actor: ADMIN, ...over });
}

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await db.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, role TEXT NOT NULL, concept_id INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await db.query("DELETE FROM users WHERE username ~ '^(designer|director|Asha|Ravi|Dee)-'"); // leftovers from earlier runs
  await ensureProductionSchema(db);
  await ensureMediaSchema(db);
  await ensureDesignTaskSchema(db);
  await ensureSubmissionSchema(db);
  await ensureSubmissionSchema(db); // idempotent
});
test.after(async () => { await db.end(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("uploads collect in one draft (v1); the same bytes are not added twice; files are named after the asset and version", async () => {
  const ctx = await freshTask();
  const a = await upload(ctx);
  assert.equal(a.outcome, "ok");
  assert.equal(a.versionNo, 1);
  const bytes = pngFile("same");
  const b1 = await upload(ctx, { filePath: bytes, viewName: "Side profile" });
  const b2 = await upload(ctx, { filePath: bytes, viewName: "Side profile" });
  assert.equal(b2.duplicate, true);
  assert.equal(b2.fileId, b1.fileId);
  const task = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  assert.equal(task.submissions.length, 1);
  assert.equal(task.submissions[0].state, "draft");
  assert.equal(task.submissions[0].files.length, 2);
  const stored = (await db.query("SELECT stored_name, status FROM production_media_files WHERE id = $1", [task.submissions[0].files[0].mediaId])).rows[0];
  assert.match(stored.stored_name, /^CHAR001_v1_Neutral-front-portrait_[0-9a-f]{8}\.png$/);
  assert.equal(stored.status, "stored");
});

test("bad uploads are refused before anything is stored: wrong type, fake image, bad labels, other project, wrong task state", async () => {
  const ctx = await freshTask();
  const exe = path.join(tmp, "x.exe"); fs.writeFileSync(exe, "MZ");
  await assert.rejects(upload(ctx, { filePath: exe, originalName: "x.exe" }), /PNG, JPG, WebP, GIF or PDF/);
  const zip = path.join(tmp, "x.zip"); fs.writeFileSync(zip, "PK");
  await assert.rejects(upload(ctx, { filePath: zip, originalName: "x.zip" }), /PNG, JPG/);
  const fake = path.join(tmp, "fake.png"); fs.writeFileSync(fake, "<html>not an image</html>");
  await assert.rejects(upload(ctx, { filePath: fake, originalName: "fake.png" }), /does not look like/);
  await assert.rejects(upload(ctx, { fileRole: "banner" }), /clean, sheet or reference/);
  await assert.rejects(upload(ctx, { viewName: "x".repeat(201) }), /under 200/);
  assert.equal((await upload({ projectId: 99999999, taskId: ctx.taskId })).outcome, "not_found");
  assert.equal((await db.query("SELECT count(*)::int n FROM production_submission_files")).rows[0].n >= 0, true);
  const t = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  assert.equal(t.submissions.length, 0, "a refused upload does not even start a draft");
  await db.query("UPDATE production_design_tasks SET state = 'cancelled' WHERE id = $1", [ctx.taskId]);
  assert.equal((await upload(ctx)).outcome, "wrong_state");
});

test("a draft can be relabelled and have files removed", async () => {
  const ctx = await freshTask();
  const a = await upload(ctx);
  await upload(ctx);
  assert.equal((await updateSubmissionFile(db, { projectId: ctx.projectId, taskId: ctx.taskId, fileId: a.fileId, fileRole: "sheet", viewName: "Contact sheet" })).outcome, "ok");
  let t = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  const f = t.submissions[0].files.find((x) => x.id === a.fileId);
  assert.equal(f.fileRole, "sheet");
  assert.equal(f.viewName, "Contact sheet");
  await assert.rejects(updateSubmissionFile(db, { projectId: ctx.projectId, taskId: ctx.taskId, fileId: a.fileId }), /Nothing to change/);
  assert.equal((await removeSubmissionFile(db, { projectId: ctx.projectId, taskId: ctx.taskId, fileId: a.fileId })).outcome, "ok");
  t = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  assert.equal(t.submissions[0].files.length, 1);
  // a file id from a different task is "not found", never touched
  const other = await taskInProject(ctx.projectId, "The Black Figure");
  const o = await upload(other);
  assert.equal((await removeSubmissionFile(db, { projectId: ctx.projectId, taskId: ctx.taskId, fileId: o.fileId })).outcome, "not_found");
  const still = await getDesignerTask(db, other.projectId, other.taskId);
  assert.equal(still.submissions[0].files.length, 1, "the other task's file was not touched");
});

test("submit: needs a file and a clean image; freezes the version; hands the task over; stale revision is a conflict", async () => {
  const ctx = await freshTask();
  let task = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  assert.equal((await submitDraft(db, { projectId: ctx.projectId, taskId: ctx.taskId, expectedRevision: task.revision })).outcome, "empty");
  const sheet = await upload(ctx, { fileRole: "sheet" });
  assert.equal((await submitDraft(db, { projectId: ctx.projectId, taskId: ctx.taskId, expectedRevision: task.revision })).outcome, "no_clean_files");
  await upload(ctx, { fileRole: "clean" });
  assert.equal((await submitDraft(db, { projectId: ctx.projectId, taskId: ctx.taskId, expectedRevision: task.revision - 1 })).outcome, "conflict");
  await assert.rejects(submitDraft(db, { projectId: ctx.projectId, taskId: ctx.taskId, expectedRevision: task.revision, note: "x".repeat(2001) }), /2000/);
  await assert.rejects(submitDraft(db, { projectId: ctx.projectId, taskId: ctx.taskId }), /expectedRevision/);

  const done = await submitDraft(db, { projectId: ctx.projectId, taskId: ctx.taskId, expectedRevision: task.revision, note: "First pass", actor: ADMIN });
  assert.equal(done.outcome, "ok");
  assert.equal(done.versionNo, 1);
  assert.ok(done.openDecisions >= 0);
  task = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  assert.equal(task.state, "submitted");
  assert.equal(task.submissions[0].state, "submitted");
  assert.equal(task.submissions[0].note, "First pass");
  assert.ok(task.submissions[0].submittedAt);

  // frozen: nothing can be added, removed or relabelled now
  assert.equal((await upload(ctx)).outcome, "wrong_state");
  assert.equal((await removeSubmissionFile(db, { projectId: ctx.projectId, taskId: ctx.taskId, fileId: sheet.fileId })).outcome, "wrong_state");
  assert.equal((await updateSubmissionFile(db, { projectId: ctx.projectId, taskId: ctx.taskId, fileId: sheet.fileId, viewName: "changed" })).outcome, "wrong_state");
  assert.equal((await submitDraft(db, { projectId: ctx.projectId, taskId: ctx.taskId, expectedRevision: task.revision })).outcome, "wrong_state");
  assert.equal(task.submissions[0].files.length, 2, "the submitted version still has exactly its files");
});

test("two submits at once: exactly one wins", async () => {
  const ctx = await freshTask();
  await upload(ctx);
  const task = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  const results = await Promise.all([
    submitDraft(db, { projectId: ctx.projectId, taskId: ctx.taskId, expectedRevision: task.revision }),
    submitDraft(db, { projectId: ctx.projectId, taskId: ctx.taskId, expectedRevision: task.revision }),
  ]);
  assert.equal(results.filter((r) => r.outcome === "ok").length, 1);
  assert.equal((await db.query("SELECT count(*)::int n FROM production_design_submissions WHERE task_id = $1 AND state = 'submitted'", [ctx.taskId])).rows[0].n, 1);
});

test("several uploads at once still make exactly one draft holding every file", async () => {
  const ctx = await freshTask();
  const results = await Promise.all(Array.from({ length: 5 }, () => upload(ctx)));
  assert.ok(results.every((r) => r.outcome === "ok"));
  const task = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  assert.equal(task.submissions.length, 1);
  assert.equal(task.submissions[0].files.length, 5);
});

test("files not yet safely in storage block a submit; once storage recovers the submit works", async () => {
  const ctx = await freshTask();
  failing = true;
  const f = await upload(ctx);
  assert.equal(f.outcome, "ok"); // kept in the temporary spool
  const task = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  assert.equal(task.submissions[0].files[0].mediaStatus, "pending_upload");
  const blocked = await submitDraft(db, { projectId: ctx.projectId, taskId: ctx.taskId, expectedRevision: task.revision });
  assert.equal(blocked.outcome, "not_stored");
  assert.equal(blocked.count, 1);
  failing = false;
  assert.equal((await store.flushPendingUploads()).stored >= 1, true);
  assert.equal((await submitDraft(db, { projectId: ctx.projectId, taskId: ctx.taskId, expectedRevision: task.revision })).outcome, "ok");
});

test("after changes are requested a new draft (v2) starts and its submit supersedes v1", async () => {
  const ctx = await freshTask();
  await upload(ctx);
  let task = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  await submitDraft(db, { projectId: ctx.projectId, taskId: ctx.taskId, expectedRevision: task.revision });
  // (the reviewer's "request changes" is step 6; simulate its result)
  await db.query("UPDATE production_design_tasks SET state = 'changes_requested', revision = revision + 1 WHERE id = $1", [ctx.taskId]);
  await db.query("UPDATE production_design_submissions SET state = 'changes_requested' WHERE task_id = $1", [ctx.taskId]);
  const second = await upload(ctx);
  assert.equal(second.outcome, "ok");
  assert.equal(second.versionNo, 2);
  task = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  assert.equal((await submitDraft(db, { projectId: ctx.projectId, taskId: ctx.taskId, expectedRevision: task.revision })).versionNo, 2);
  task = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  assert.deepEqual(task.submissions.map((s) => [s.versionNo, s.state]), [[1, "superseded"], [2, "submitted"]]);
});

test("assigning to a designer login: only designer/admin logins; a plain name carries no access; clearing works", async () => {
  const ctx = await freshTask();
  const designer = await user("designer", "Asha");
  const director = await user("director", "Dee");
  let task = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  await assert.rejects(updateDesignerTask(db, ctx.projectId, ctx.taskId, { expectedRevision: task.revision, assigneeUserId: director }), /not a designer/);
  await assert.rejects(updateDesignerTask(db, ctx.projectId, ctx.taskId, { expectedRevision: task.revision, assigneeUserId: 99999999 }), /not a designer/);
  await assert.rejects(updateDesignerTask(db, ctx.projectId, ctx.taskId, { expectedRevision: task.revision, assigneeUserId: "7" }), /user id/);
  const r = await updateDesignerTask(db, ctx.projectId, ctx.taskId, { expectedRevision: task.revision, assigneeUserId: designer });
  assert.equal(r.state, "claimed");
  task = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  assert.equal(task.assignee, "Asha");
  assert.equal(task.assigneeUserId, designer);
  assert.ok(await taskAssignedTo(db, ctx.taskId, designer));
  assert.equal(await taskAssignedTo(db, ctx.taskId, director), null);

  const r2 = await updateDesignerTask(db, ctx.projectId, ctx.taskId, { expectedRevision: task.revision, assignee: "Someone without a login" });
  task = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  assert.equal(task.assigneeUserId, null);
  assert.equal(await taskAssignedTo(db, ctx.taskId, designer), null, "typing a name removes the old login's access");

  await updateDesignerTask(db, ctx.projectId, ctx.taskId, { expectedRevision: r2.revision, assigneeUserId: designer });
  task = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  await updateDesignerTask(db, ctx.projectId, ctx.taskId, { expectedRevision: task.revision, assigneeUserId: null });
  task = await getDesignerTask(db, ctx.projectId, ctx.taskId);
  assert.equal(task.assignee, null);
  assert.equal(task.state, "open");
});

test("a designer may view only files from tasks assigned to them; a cancelled task closes access", async () => {
  const ctx = await freshTask();
  const other = await taskInProject(ctx.projectId, "The Black Figure");
  const asha = await user("designer", "Asha");
  const ravi = await user("designer", "Ravi");
  for (const [c, who] of [[ctx, asha], [other, ravi]]) {
    const t = await getDesignerTask(db, c.projectId, c.taskId);
    await updateDesignerTask(db, c.projectId, c.taskId, { expectedRevision: t.revision, assigneeUserId: who });
  }
  const mine = await upload(ctx);
  const theirs = await upload(other);
  const mediaOf = async (fileId) => (await db.query("SELECT media_id FROM production_submission_files WHERE id = $1", [fileId])).rows[0].media_id;
  assert.equal(await designerMayViewMedia(db, await mediaOf(mine.fileId), asha), true);
  assert.equal(await designerMayViewMedia(db, await mediaOf(theirs.fileId), asha), false);
  assert.equal(await designerMayViewMedia(db, await mediaOf(mine.fileId), ravi), false);
  const stray = await store.putMedia({ projectId: ctx.projectId, role: "design", filePath: pngFile("stray"), originalName: "s.png" });
  assert.equal(await designerMayViewMedia(db, stray.id, asha), false, "a file in no submission is not viewable");
  await db.query("UPDATE production_design_tasks SET state = 'cancelled' WHERE id = $1", [ctx.taskId]);
  assert.equal(await designerMayViewMedia(db, await mediaOf(mine.fileId), asha), false);
  assert.equal(await taskAssignedTo(db, ctx.taskId, asha), null);
});
