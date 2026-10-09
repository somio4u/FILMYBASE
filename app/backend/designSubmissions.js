// Designer uploads and submissions.
//
// Files a designer uploads for a task collect in a DRAFT submission. Pressing
// Submit freezes that draft into an exact numbered version ("v1", "v2"...):
// after that no file can be added, removed or relabelled, so the reviewer
// (step 6) approves precisely what they looked at. Stored files themselves are
// never overwritten; a revision after feedback is a new version.
//
// Who may do what:
//   - admin: any task, through /api/production/:projectId/tasks/:taskId/...
//   - designer login: only tasks assigned to them, through /api/designer/...
// Both call the same functions below; the route layer decides who may call.

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import multer from "multer";
import { addTaskComment, loadSubmissions, getDesignerTask, listDesignerTasks } from "./designTasks.js";

export const DESIGNER_ROLE = "designer";
const UPLOADABLE_STATES = ["open", "claimed", "changes_requested"];
const DESIGN_FILE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf"]);
const FILE_ROLES = ["clean", "sheet", "reference"];
const MAX_FILES_PER_DRAFT = 60;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function ensureSubmissionSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS production_design_submissions (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      task_id INTEGER NOT NULL REFERENCES production_design_tasks(id) ON DELETE CASCADE,
      version_no INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft'
        CHECK (state IN ('draft','submitted','approved','changes_requested','superseded')),
      note TEXT,
      created_by_user_id INTEGER,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      submitted_at TIMESTAMPTZ,
      UNIQUE (task_id, version_no)
    )`,
    `ALTER TABLE production_design_submissions ADD COLUMN IF NOT EXISTS review_note TEXT`,
    `ALTER TABLE production_design_submissions ADD COLUMN IF NOT EXISTS reviewed_by_name TEXT`,
    `ALTER TABLE production_design_submissions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`,
    // At most one draft per task, enforced by the database.
    `CREATE UNIQUE INDEX IF NOT EXISTS production_design_submissions_one_draft
       ON production_design_submissions (task_id) WHERE state = 'draft'`,
    `CREATE TABLE IF NOT EXISTS production_submission_files (
      id SERIAL PRIMARY KEY,
      submission_id INTEGER NOT NULL REFERENCES production_design_submissions(id) ON DELETE CASCADE,
      media_id INTEGER NOT NULL REFERENCES production_media_files(id) ON DELETE CASCADE,
      file_role TEXT NOT NULL DEFAULT 'clean' CHECK (file_role IN ('clean','sheet','reference')),
      view_name TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      added_by_user_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (submission_id, media_id)
    )`,
  ];
  for (const sql of statements) await db.query(sql);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function cleanFileRole(value) {
  if (value === undefined || value === null || value === "") return "clean";
  if (!FILE_ROLES.includes(value)) throw httpError(400, "File type must be clean, sheet or reference.");
  return value;
}
function cleanViewName(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 200) throw httpError(400, "The view name must be under 200 characters.");
  return value.trim() || null;
}
function slug(text) {
  return String(text ?? "").normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

async function lockTask(client, projectId, taskId) {
  return (
    await client.query(
      `SELECT t.*, a.code AS asset_code FROM production_design_tasks t
       JOIN production_assets a ON a.id = t.asset_id
       WHERE t.id = $1 AND t.project_id = $2 FOR UPDATE OF t`,
      [taskId, projectId]
    )
  ).rows[0];
}

// Adds one already-received file (on disk at filePath) to the task's draft.
export async function addSubmissionFile(db, store, { projectId, taskId, filePath, originalName, fileRole, viewName, actor = {} }) {
  const role = cleanFileRole(fileRole);
  const view = cleanViewName(viewName);
  const ext = path.extname(originalName ?? "").toLowerCase();
  if (!DESIGN_FILE_EXTENSIONS.has(ext)) throw httpError(400, "Design files must be PNG, JPG, WebP, GIF or PDF.");

  // Check the task first (cheap) so a rejected upload isn't stored at all.
  const peek = (await db.query("SELECT state FROM production_design_tasks WHERE id = $1 AND project_id = $2", [taskId, projectId])).rows[0];
  if (!peek) return { outcome: "not_found" };
  if (!UPLOADABLE_STATES.includes(peek.state)) return { outcome: "wrong_state", state: peek.state };

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const task = await lockTask(client, projectId, taskId);
    if (!task) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (!UPLOADABLE_STATES.includes(task.state)) {
      await client.query("ROLLBACK");
      return { outcome: "wrong_state", state: task.state };
    }
    let draft = (await client.query("SELECT * FROM production_design_submissions WHERE task_id = $1 AND state = 'draft'", [taskId])).rows[0];
    if (!draft) {
      const next = Number((await client.query("SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM production_design_submissions WHERE task_id = $1", [taskId])).rows[0].n);
      draft = (
        await client.query(
          "INSERT INTO production_design_submissions (project_id, task_id, version_no, created_by_user_id, created_by_name) VALUES ($1,$2,$3,$4,$5) RETURNING *",
          [projectId, taskId, next, actor.userId ?? null, actor.name ?? null]
        )
      ).rows[0];
    }
    const count = Number((await client.query("SELECT count(*) AS n FROM production_submission_files WHERE submission_id = $1", [draft.id])).rows[0].n);
    if (count >= MAX_FILES_PER_DRAFT) {
      await client.query("ROLLBACK");
      throw httpError(400, `A version can hold at most ${MAX_FILES_PER_DRAFT} files.`);
    }

    // Stored while the task row is locked, so two uploads at once cannot race
    // each other into two drafts. (Dedupe: same bytes -> same media row.)
    const label = `${task.asset_code}_v${draft.version_no}${view ? `_${slug(view)}` : ""}`;
    const media = await store.putMedia({
      projectId, role: "design", filePath, originalName, label, createdBy: actor.userId ?? null,
    });
    const already = (await client.query("SELECT id FROM production_submission_files WHERE submission_id = $1 AND media_id = $2", [draft.id, media.id])).rows[0];
    if (already) {
      await client.query("COMMIT");
      return { outcome: "ok", fileId: already.id, submissionId: draft.id, versionNo: draft.version_no, duplicate: true };
    }
    const file = (
      await client.query(
        `INSERT INTO production_submission_files (submission_id, media_id, file_role, view_name, sort_order, added_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [draft.id, media.id, role, view, count, actor.userId ?? null]
      )
    ).rows[0];
    await client.query(
      "INSERT INTO production_audit_events (project_id, actor_user_id, action, entity, entity_id, detail) VALUES ($1,$2,'submission_file_added','design_task',$3,$4)",
      [projectId, actor.userId ?? null, taskId, JSON.stringify({ submissionId: draft.id, mediaId: media.id, versionNo: draft.version_no })]
    );
    await client.query("COMMIT");
    return { outcome: "ok", fileId: file.id, submissionId: draft.id, versionNo: draft.version_no, duplicate: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Finds a draft file and checks it really belongs to this project + task.
async function draftFile(client, projectId, taskId, fileId) {
  return (
    await client.query(
      `SELECT f.*, s.state AS submission_state FROM production_submission_files f
       JOIN production_design_submissions s ON s.id = f.submission_id
       WHERE f.id = $1 AND s.task_id = $2 AND s.project_id = $3 FOR UPDATE OF f`,
      [fileId, taskId, projectId]
    )
  ).rows[0];
}

export async function removeSubmissionFile(db, { projectId, taskId, fileId, actor = {} }) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const task = await lockTask(client, projectId, taskId);
    const file = task ? await draftFile(client, projectId, taskId, fileId) : null;
    if (!file) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (file.submission_state !== "draft") {
      await client.query("ROLLBACK");
      return { outcome: "wrong_state", state: file.submission_state };
    }
    await client.query("DELETE FROM production_submission_files WHERE id = $1", [fileId]);
    await client.query(
      "INSERT INTO production_audit_events (project_id, actor_user_id, action, entity, entity_id, detail) VALUES ($1,$2,'submission_file_removed','design_task',$3,$4)",
      [projectId, actor.userId ?? null, taskId, JSON.stringify({ fileId, mediaId: file.media_id })]
    );
    await client.query("COMMIT");
    return { outcome: "ok" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSubmissionFile(db, { projectId, taskId, fileId, fileRole, viewName }) {
  const role = fileRole === undefined ? undefined : cleanFileRole(fileRole);
  const view = viewName === undefined ? undefined : cleanViewName(viewName);
  if (role === undefined && view === undefined) throw httpError(400, "Nothing to change.");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const task = await lockTask(client, projectId, taskId);
    const file = task ? await draftFile(client, projectId, taskId, fileId) : null;
    if (!file) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (file.submission_state !== "draft") {
      await client.query("ROLLBACK");
      return { outcome: "wrong_state", state: file.submission_state };
    }
    await client.query("UPDATE production_submission_files SET file_role = $1, view_name = $2 WHERE id = $3", [
      role ?? file.file_role, view === undefined ? file.view_name : view, fileId,
    ]);
    await client.query("COMMIT");
    return { outcome: "ok" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Freezes the draft as an exact version and hands the task to the reviewer.
export async function submitDraft(db, { projectId, taskId, expectedRevision, note, actor = {} }) {
  if (!Number.isInteger(expectedRevision)) throw httpError(400, "expectedRevision is required.");
  const text = note === undefined || note === null ? "" : String(note).trim();
  if (text.length > 2000) throw httpError(400, "The note must be under 2000 characters.");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const task = await lockTask(client, projectId, taskId);
    if (!task) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (task.revision !== expectedRevision) {
      await client.query("ROLLBACK");
      return { outcome: "conflict", currentRevision: task.revision };
    }
    if (!UPLOADABLE_STATES.includes(task.state)) {
      await client.query("ROLLBACK");
      return { outcome: "wrong_state", state: task.state };
    }
    const draft = (await client.query("SELECT * FROM production_design_submissions WHERE task_id = $1 AND state = 'draft' FOR UPDATE", [taskId])).rows[0];
    const files = draft
      ? (
          await client.query(
            `SELECT f.file_role, m.status AS media_status FROM production_submission_files f
             JOIN production_media_files m ON m.id = f.media_id WHERE f.submission_id = $1`,
            [draft.id]
          )
        ).rows
      : [];
    if (!draft || files.length === 0) {
      await client.query("ROLLBACK");
      return { outcome: "empty" };
    }
    if (!files.some((f) => f.file_role === "clean")) {
      await client.query("ROLLBACK");
      return { outcome: "no_clean_files" };
    }
    const notStored = files.filter((f) => f.media_status !== "stored").length;
    if (notStored > 0) {
      await client.query("ROLLBACK");
      return { outcome: "not_stored", count: notStored };
    }
    await client.query("UPDATE production_design_submissions SET state = 'submitted', note = $1, submitted_at = now() WHERE id = $2", [text || null, draft.id]);
    // Earlier versions that were sent back are now history.
    await client.query("UPDATE production_design_submissions SET state = 'superseded' WHERE task_id = $1 AND state = 'changes_requested'", [taskId]);
    const updated = (
      await client.query("UPDATE production_design_tasks SET state = 'submitted', revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING revision", [taskId])
    ).rows[0];
    const openDecisions = (task.brief?.needsDecision ?? []).length;
    await client.query(
      "INSERT INTO production_audit_events (project_id, actor_user_id, action, entity, entity_id, detail) VALUES ($1,$2,'design_submitted','design_task',$3,$4)",
      [projectId, actor.userId ?? null, taskId, JSON.stringify({ submissionId: draft.id, versionNo: draft.version_no, files: files.length })]
    );
    await client.query("COMMIT");
    return { outcome: "ok", submissionId: draft.id, versionNo: draft.version_no, revision: updated.revision, openDecisions };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Who may see what (designer side)
// ---------------------------------------------------------------------------

// The task row if it is assigned to this user, else null. One place, used by
// every designer route.
export async function taskAssignedTo(db, taskId, userId) {
  if (!Number.isInteger(taskId) || !Number.isInteger(userId)) return null;
  return (
    (await db.query("SELECT id, project_id, state, revision FROM production_design_tasks WHERE id = $1 AND assignee_user_id = $2 AND state <> 'cancelled'", [taskId, userId])).rows[0] ?? null
  );
}

// May this user see this stored file? True only if it is part of a submission
// on a task assigned to them.
export async function designerMayViewMedia(db, mediaId, userId) {
  if (!Number.isInteger(mediaId) || !Number.isInteger(userId)) return false;
  const row = (
    await db.query(
      `SELECT 1 FROM production_submission_files f
       JOIN production_design_submissions s ON s.id = f.submission_id
       JOIN production_design_tasks t ON t.id = s.task_id
       WHERE f.media_id = $1 AND t.assignee_user_id = $2 AND t.state <> 'cancelled' LIMIT 1`,
      [mediaId, userId]
    )
  ).rows[0];
  return Boolean(row);
}

// A designer login may use ONLY these. Everything else is refused here, even
// a route that forgot to check roles itself.
const DESIGNER_ALLOWED = [
  ["POST", /^\/api\/auth\/(login|logout)$/],
  ["GET", /^\/api\/auth\/me$/],
  ["GET", /^\/api\/health$/],
  [null, /^\/api\/designer\//],
];
export function designerGatekeeper(req, res, next) {
  if (req.user?.role !== DESIGNER_ROLE || !req.path.startsWith("/api/")) return next();
  const allowed = DESIGNER_ALLOWED.some(([method, pattern]) => (method === null || method === req.method) && pattern.test(req.path));
  if (!allowed) return res.status(403).json({ error: "This login can only use design tasks." });
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerSubmissionRoutes(app, db, requireRole, { store, serveMedia }) {
  const tmpDir = path.join(os.tmpdir(), "filmybase-uploads");
  fs.mkdirSync(tmpDir, { recursive: true });
  // Upload to disk (not memory): big files never sit in RAM.
  const upload = multer({ dest: tmpDir, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 } });
  const receive = (req, res, next) =>
    upload.single("file")(req, res, (error) => {
      if (!error) return next();
      if (error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: `The file is too large (the limit is ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB).` });
      return res.status(400).json({ error: "The upload could not be read." });
    });

  const guard = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ error: error.message });
      if (error.status === 413) return res.status(413).json({ error: error.message });
      throw error;
    }
  };
  const respond = (res, result) => {
    switch (result.outcome) {
      case "not_found": return res.status(404).json({ error: "Not found." });
      case "conflict": return res.status(409).json({ error: "This task was changed by someone else. Reload and try again.", currentRevision: result.currentRevision });
      case "wrong_state": return res.status(409).json({ error: `This can't be done while the task is "${result.state}".`, state: result.state });
      case "empty": return res.status(400).json({ error: "Upload at least one file before submitting." });
      case "no_clean_files": return res.status(400).json({ error: "Add at least one clean image (not only sheets or references) before submitting." });
      case "not_stored": return res.status(409).json({ error: `${result.count} file${result.count === 1 ? " is" : "s are"} still being saved to storage. Wait a minute and try again.` });
      default: return res.json(result);
    }
  };
  const num = (value) => (/^\d+$/.test(String(value)) ? Number(value) : NaN);

  // What both sides do with a task once access has been checked.
  const actions = {
    async upload(req, res, { projectId, taskId, actor }) {
      const file = req.file;
      if (!file) return res.status(400).json({ error: "No file was received." });
      try {
        respond(res, await addSubmissionFile(db, store, {
          projectId, taskId, filePath: file.path, originalName: file.originalname,
          fileRole: req.body?.fileRole, viewName: req.body?.viewName, actor,
        }));
      } finally {
        fsPromises.unlink(file.path).catch(() => {});
      }
    },
    async remove(req, res, { projectId, taskId, actor }) {
      respond(res, await removeSubmissionFile(db, { projectId, taskId, fileId: num(req.params.fileId), actor }));
    },
    async relabel(req, res, { projectId, taskId }) {
      respond(res, await updateSubmissionFile(db, { projectId, taskId, fileId: num(req.params.fileId), fileRole: req.body?.fileRole, viewName: req.body?.viewName }));
    },
    async submit(req, res, { projectId, taskId, actor }) {
      respond(res, await submitDraft(db, { projectId, taskId, expectedRevision: req.body?.expectedRevision, note: req.body?.note, actor }));
    },
    async comment(req, res, { projectId, taskId, actor }) {
      respond(res, await addTaskComment(db, projectId, taskId, {
        body: req.body?.body, kind: req.body?.kind, actorUserId: actor.userId, authorName: actor.name,
      }));
    },
  };
  // A request must be cleaned up even when it is refused: multer has already
  // written the file to disk by the time a handler runs.
  const cleanupOnRefusal = (req) => { if (req.file) fsPromises.unlink(req.file.path).catch(() => {}); };

  // ---- Admin (any task) ----------------------------------------------------
  const adminBase = "/api/production/:projectId/tasks/:taskId";
  const adminCtx = (req) => ({ projectId: num(req.params.projectId), taskId: num(req.params.taskId), actor: { userId: req.user.id, name: req.user.name } });
  const adminOk = (req, res) => {
    const c = adminCtx(req);
    if (!(c.projectId > 0 && c.taskId > 0)) {
      cleanupOnRefusal(req);
      res.status(400).json({ error: "Not a valid project or task." });
      return null;
    }
    return c;
  };
  app.post(`${adminBase}/uploads`, requireRole("admin"), receive, guard(async (req, res) => { const c = adminOk(req, res); if (c) await actions.upload(req, res, c); }));
  app.delete(`${adminBase}/uploads/:fileId`, requireRole("admin"), guard(async (req, res) => { const c = adminOk(req, res); if (c) await actions.remove(req, res, c); }));
  app.patch(`${adminBase}/uploads/:fileId`, requireRole("admin"), guard(async (req, res) => { const c = adminOk(req, res); if (c) await actions.relabel(req, res, c); }));
  app.post(`${adminBase}/submit`, requireRole("admin"), guard(async (req, res) => { const c = adminOk(req, res); if (c) await actions.submit(req, res, c); }));
  app.get("/api/production/designers", requireRole("admin"), async (req, res) => {
    const rows = (await db.query("SELECT id, name, username FROM users WHERE role = $1 ORDER BY name", [DESIGNER_ROLE])).rows;
    res.json({ designers: rows });
  });

  // ---- Designer (own tasks only) ---------------------------------------------
  const designerBase = "/api/designer/tasks/:taskId";
  // Loads the task only if it is assigned to the caller. A task that exists
  // but belongs to someone else looks exactly like one that doesn't exist.
  const mine = async (req, res) => {
    const taskId = num(req.params.taskId);
    const task = await taskAssignedTo(db, taskId, req.user.id);
    if (!task) {
      cleanupOnRefusal(req);
      res.status(404).json({ error: "Not found." });
      return null;
    }
    return { projectId: task.project_id, taskId, actor: { userId: req.user.id, name: req.user.name } };
  };

  app.get("/api/designer/tasks", requireRole(DESIGNER_ROLE), guard(async (req, res) => {
    const rows = (
      await db.query("SELECT id, project_id FROM production_design_tasks WHERE assignee_user_id = $1 AND state <> 'cancelled' ORDER BY id", [req.user.id])
    ).rows;
    const byProject = new Map();
    for (const r of rows) byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), r.id]);
    const tasks = [];
    for (const [projectId, ids] of byProject) {
      for (const t of await listDesignerTasks(db, projectId)) if (ids.includes(t.id)) tasks.push({ ...t, projectId });
    }
    // Designers never see assets of other tasks or dossier contents.
    res.json({ tasks: tasks.sort((a, b) => a.id - b.id) });
  }));

  app.get(designerBase, requireRole(DESIGNER_ROLE), guard(async (req, res) => {
    const c = await mine(req, res);
    if (!c) return;
    res.json(await getDesignerTask(db, c.projectId, c.taskId));
  }));
  app.post(`${designerBase}/uploads`, requireRole(DESIGNER_ROLE), receive, guard(async (req, res) => { const c = await mine(req, res); if (c) await actions.upload(req, res, c); }));
  app.delete(`${designerBase}/uploads/:fileId`, requireRole(DESIGNER_ROLE), guard(async (req, res) => { const c = await mine(req, res); if (c) await actions.remove(req, res, c); }));
  app.patch(`${designerBase}/uploads/:fileId`, requireRole(DESIGNER_ROLE), guard(async (req, res) => { const c = await mine(req, res); if (c) await actions.relabel(req, res, c); }));
  app.post(`${designerBase}/submit`, requireRole(DESIGNER_ROLE), guard(async (req, res) => { const c = await mine(req, res); if (c) await actions.submit(req, res, c); }));
  app.post(`${designerBase}/comments`, requireRole(DESIGNER_ROLE), guard(async (req, res) => { const c = await mine(req, res); if (c) await actions.comment(req, res, c); }));

  app.get("/api/designer/media/:id", requireRole(DESIGNER_ROLE), async (req, res) => {
    const id = num(req.params.id);
    if (!(id > 0) || !(await designerMayViewMedia(db, id, req.user.id))) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    await serveMedia(req, res, id);
  });
}

export { loadSubmissions };
