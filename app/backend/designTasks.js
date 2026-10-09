// Designer tasks: turns a Production Dossier asset into a brief a designer can
// act on. Every brief has three clearly separate parts:
//   MUST KEEP         — facts from the screenplay/agent and decisions a person confirmed
//   DESIGNER MAY EXPLORE — details the screenplay leaves open
//   NEEDS DECISION    — choices left open or contradictions that change the result
//
// A task stores a snapshot of its brief (so it does not shift under the
// designer) plus the asset revision it was made from, so the screen can say
// "this brief is out of date" instead of silently changing it.

import { effectiveDetails } from "./production.js";

export const ACTIVE_TASK_STATES = ["open", "claimed", "submitted", "changes_requested"];
const EDITABLE_STATES = ["open", "claimed", "changes_requested"];
const PRIORITIES = ["low", "normal", "high"];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function ensureDesignTaskSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS production_design_tasks (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      asset_id INTEGER NOT NULL REFERENCES production_assets(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      assignee TEXT,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
      due_date DATE,
      brief JSONB NOT NULL,
      brief_asset_revision INTEGER NOT NULL,
      brief_imported_revision INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (project_id, code)
    )`,
    // At most one live task per asset (finished or cancelled ones don't count).
    `CREATE UNIQUE INDEX IF NOT EXISTS production_design_tasks_one_active
       ON production_design_tasks (project_id, asset_id)
       WHERE state IN ('open','claimed','submitted','changes_requested')`,
    `CREATE TABLE IF NOT EXISTS production_task_comments (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES production_design_tasks(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      author_user_id INTEGER,
      author_name TEXT,
      kind TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','clarification')),
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  ];
  for (const sql of statements) await db.query(sql);
}

// ---------------------------------------------------------------------------
// The brief (pure function — easy to test)
// ---------------------------------------------------------------------------

const DECISION_PREFIX = /^(DECISION|CONFLICT)\b/;

function isDecisionIssue(issue) {
  return DECISION_PREFIX.test(issue.message) || issue.category === "ambiguous_match" || issue.category === "agent_update";
}

// What the designer must deliver, by asset type. Follows the production
// brief's asset-type deliverables; the reviewer can trim to real shot coverage.
function deliverablesFor(asset, details) {
  const out = [];
  const states = details.states ?? [];
  if (asset.kind === "character") {
    out.push(
      "Neutral front portrait", "Three-quarter portrait", "Side profile", "Full-body front view",
      "Expression references (calm, uneasy, and any the scenes need)"
    );
    for (const c of details.costumes ?? []) out.push(`Costume view: ${c.name}`);
    const costumeNames = new Set((details.costumes ?? []).map((c) => c.name.toLowerCase()));
    for (const s of states) if (!costumeNames.has(s.toLowerCase())) out.push(`Condition variant: ${s}`);
    out.push("Annotated contact sheet for review (kept separate from the clean individual images)");
  } else if (asset.kind === "prop") {
    out.push("Hero view (three-quarter)", "Front view", "Close-up of distinguishing details", "Scale reference (size against a hand or known object)");
    for (const s of states) out.push(`State: ${s}`);
  } else if (asset.kind === "location") {
    out.push("Establishing view", "Reverse view (opposite direction)", "Simple floor plan or relative layout", "Light sources and fixed dressing noted");
    for (const s of states) out.push(`Time / condition variant: ${s}`);
  } else {
    const k = (details.otherKind ?? "").toLowerCase();
    if (/sign|graphic|text|screen|letter/.test(k)) {
      out.push("Editable graphic with the exact approved wording (do not rely on text inside a generated image)");
    } else if (/sound|audio|music|song|voice/.test(k)) {
      out.push("Reference audio or a written sound description for approval");
    } else {
      out.push("Design reference views (front and one alternate angle)");
    }
    for (const s of states) out.push(`Variant: ${s}`);
  }
  return out;
}

// openIssues: [{ id, category, message }] for this asset.
export function buildBrief(asset, openIssues) {
  const d = effectiveDetails(asset);
  const edited = asset.human_edits ?? {};
  const sourceFor = (field) => (edited[field] !== undefined ? "confirmed by a person" : "from the screenplay / agent output");

  const mustKeep = [];
  if (d.description?.en) mustKeep.push({ label: "Description (English)", text: d.description.en, source: sourceFor("description") });
  if (d.description?.hi) mustKeep.push({ label: "Description (Hindi)", text: d.description.hi, source: sourceFor("description") });
  if ((d.states ?? []).length) mustKeep.push({ label: "Conditions it appears in", text: d.states.join("; "), source: sourceFor("states") });
  for (const c of d.costumes ?? []) mustKeep.push({ label: `Costume: ${c.name}`, text: c.description || "(no description given)", source: sourceFor("costumes") });
  if (d.notes) mustKeep.push({ label: "Notes from the production team", text: d.notes, source: "confirmed by a person" });

  const needsDecision = [];
  const mayExplore = [];
  for (const issue of openIssues) {
    if (isDecisionIssue(issue)) needsDecision.push({ issueId: issue.id, text: issue.message });
    else if (issue.category === "missing_info") mayExplore.push({ issueId: issue.id, text: issue.message });
  }

  const hasText = asset.kind === "other" && /sign|graphic|text|screen|letter/i.test(d.otherKind ?? "");
  return {
    version: 1,
    asset: { code: asset.code, name: asset.name, kind: asset.kind, aliases: asset.aliases ?? [] },
    sceneUsage: d.sceneRefs ?? [],
    mustKeep,
    mayExplore,
    needsDecision,
    deliverables: deliverablesFor(asset, d),
    format: {
      fileTypes: ["PNG", "JPG", "WebP"],
      minimumLongSidePixels: 1500,
      background: asset.kind === "prop" || hasText ? "Plain or transparent background" : "As designed; keep reference images clean (no captions or arrows)",
      note: "Defaults; the reviewer can change them per task.",
    },
    acceptance: [
      "Every MUST KEEP item is visible and unchanged",
      "Each DESIGNER MAY EXPLORE detail is decided in the design (not left blank)",
      "Every NEEDS DECISION item is answered by the reviewer before approval",
      "Clean individual files are supplied separately from any annotated sheet",
      "Same identity, colours and proportions across every view",
    ],
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function loadAssetWithIssues(client, projectId, assetId) {
  const asset = (await client.query("SELECT * FROM production_assets WHERE id = $1 AND project_id = $2", [assetId, projectId])).rows[0];
  if (!asset) return null;
  const issues = (
    await client.query("SELECT id, category, message FROM production_issues WHERE asset_id = $1 AND status = 'open' ORDER BY id", [assetId])
  ).rows;
  return { asset, issues };
}

async function audit(client, projectId, actorUserId, action, taskId, detail) {
  await client.query(
    "INSERT INTO production_audit_events (project_id, actor_user_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,'design_task',$4,$5)",
    [projectId, actorUserId ?? null, action, taskId, detail ? JSON.stringify(detail) : null]
  );
}

function cleanPriority(value) {
  if (value === undefined) return undefined;
  if (!PRIORITIES.includes(value)) throw httpError(400, "Priority must be low, normal or high.");
  return value;
}
function cleanDueDate(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw httpError(400, "Due date must look like 2026-12-31.");
  return value;
}
function cleanAssignee(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 100) throw httpError(400, "Assignee must be a name under 100 characters.");
  return value.trim();
}

// assetIds: array of asset ids, or null for "every asset that has no live task".
export async function createDesignerTasks(db, projectId, { assetIds = null, priority, assignee, dueDate, actorUserId = null } = {}) {
  const prio = cleanPriority(priority) ?? "normal";
  const who = cleanAssignee(assignee) ?? null;
  const due = cleanDueDate(dueDate) ?? null;
  if (assetIds !== null && (!Array.isArray(assetIds) || assetIds.length === 0 || assetIds.length > 500 || assetIds.some((id) => !Number.isInteger(id)))) {
    throw httpError(400, "assetIds must be a list of asset ids.");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Serialises task creation per project (also guards the code counter).
    const project = (await client.query("SELECT id FROM ai_movie_projects WHERE id = $1 FOR UPDATE", [projectId])).rows[0];
    if (!project) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    const candidates = assetIds
      ? (await client.query("SELECT id FROM production_assets WHERE project_id = $1 AND id = ANY($2) ORDER BY kind, code", [projectId, assetIds])).rows.map((r) => r.id)
      : (await client.query("SELECT id FROM production_assets WHERE project_id = $1 ORDER BY kind, code", [projectId])).rows.map((r) => r.id);

    const created = [];
    const skipped = [];
    if (assetIds) for (const id of assetIds) if (!candidates.includes(id)) skipped.push({ assetId: id, reason: "not_in_project" });

    let counter = Number((await client.query("SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::int), 0) AS n FROM production_design_tasks WHERE project_id = $1", [projectId])).rows[0].n);
    for (const assetId of candidates) {
      const live = await client.query(
        "SELECT 1 FROM production_design_tasks WHERE asset_id = $1 AND state = ANY($2)", [assetId, ACTIVE_TASK_STATES]
      );
      if (live.rowCount > 0) {
        skipped.push({ assetId, reason: "already_has_task" });
        continue;
      }
      const { asset, issues } = await loadAssetWithIssues(client, projectId, assetId);
      const brief = buildBrief(asset, issues);
      counter += 1;
      const code = `TASK${String(counter).padStart(3, "0")}`;
      const row = (
        await client.query(
          `INSERT INTO production_design_tasks (project_id, asset_id, code, assignee, state, priority, due_date, brief, brief_asset_revision, brief_imported_revision, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, code`,
          [projectId, assetId, code, who, who ? "claimed" : "open", prio, due, JSON.stringify(brief), asset.revision, asset.imported_revision, actorUserId]
        )
      ).rows[0];
      await audit(client, projectId, actorUserId, "task_created", row.id, { code, assetId, assetCode: asset.code });
      created.push({ taskId: row.id, code: row.code, assetId });
    }
    await client.query("COMMIT");
    return { outcome: "ok", created, skipped };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function serializeTask(row) {
  return {
    id: row.id,
    code: row.code,
    state: row.state,
    assignee: row.assignee,
    priority: row.priority,
    dueDate: row.due_date ? String(row.due_date.toISOString?.().slice(0, 10) ?? row.due_date) : null,
    revision: row.revision,
    asset: { id: row.asset_id, code: row.asset_code, name: row.asset_name, kind: row.asset_kind },
    // The brief is a snapshot. It is stale when the asset was edited or
    // re-imported with different details after the snapshot was taken.
    briefStale: row.brief_asset_revision !== row.asset_revision || row.brief_imported_revision !== row.asset_imported_revision,
    needsDecisionCount: (row.brief?.needsDecision ?? []).length,
    commentCount: row.comment_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const TASK_SELECT = `
  SELECT t.*, a.code AS asset_code, a.name AS asset_name, a.kind AS asset_kind,
         a.revision AS asset_revision, a.imported_revision AS asset_imported_revision,
         (SELECT count(*)::int FROM production_task_comments c WHERE c.task_id = t.id) AS comment_count
  FROM production_design_tasks t JOIN production_assets a ON a.id = t.asset_id`;

export async function listDesignerTasks(db, projectId) {
  const rows = (await db.query(`${TASK_SELECT} WHERE t.project_id = $1 ORDER BY t.id`, [projectId])).rows;
  return rows.map(serializeTask);
}

export async function getDesignerTask(db, projectId, taskId) {
  const row = (await db.query(`${TASK_SELECT} WHERE t.project_id = $1 AND t.id = $2`, [projectId, taskId])).rows[0];
  if (!row) return null;
  const comments = (
    await db.query("SELECT id, author_name, kind, body, created_at FROM production_task_comments WHERE task_id = $1 ORDER BY id", [taskId])
  ).rows;
  return { ...serializeTask(row), brief: row.brief, comments };
}

// Locks the task row, checks the revision the person was looking at, and
// runs `change` inside the same transaction.
async function withTask(db, projectId, taskId, expectedRevision, { allowedStates, change }) {
  if (!Number.isInteger(expectedRevision)) throw httpError(400, "expectedRevision is required.");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const task = (await client.query("SELECT * FROM production_design_tasks WHERE id = $1 AND project_id = $2 FOR UPDATE", [taskId, projectId])).rows[0];
    if (!task) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (task.revision !== expectedRevision) {
      await client.query("ROLLBACK");
      return { outcome: "conflict", currentRevision: task.revision };
    }
    if (allowedStates && !allowedStates.includes(task.state)) {
      await client.query("ROLLBACK");
      return { outcome: "wrong_state", state: task.state };
    }
    const result = await change(client, task);
    await client.query("COMMIT");
    return { outcome: "ok", ...result };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function updateDesignerTask(db, projectId, taskId, { expectedRevision, assignee, priority, dueDate, actorUserId = null }) {
  const changes = { assignee: cleanAssignee(assignee), priority: cleanPriority(priority), dueDate: cleanDueDate(dueDate) };
  if (Object.values(changes).every((v) => v === undefined)) throw httpError(400, "Nothing to change.");
  return withTask(db, projectId, taskId, expectedRevision, {
    allowedStates: EDITABLE_STATES,
    async change(client, task) {
      const next = {
        assignee: changes.assignee === undefined ? task.assignee : changes.assignee,
        priority: changes.priority ?? task.priority,
        due: changes.dueDate === undefined ? task.due_date : changes.dueDate,
      };
      // Naming someone on an open task means it is now taken.
      const state = task.state === "open" && next.assignee ? "claimed" : task.state === "claimed" && !next.assignee ? "open" : task.state;
      const updated = (
        await client.query(
          "UPDATE production_design_tasks SET assignee=$1, priority=$2, due_date=$3, state=$4, revision=revision+1, updated_at=now() WHERE id=$5 RETURNING revision, state",
          [next.assignee, next.priority, next.due, state, taskId]
        )
      ).rows[0];
      await audit(client, projectId, actorUserId, "task_updated", taskId, { assignee: next.assignee, priority: next.priority, dueDate: changes.dueDate });
      return { revision: updated.revision, state: updated.state };
    },
  });
}

export async function cancelDesignerTask(db, projectId, taskId, { expectedRevision, actorUserId = null }) {
  return withTask(db, projectId, taskId, expectedRevision, {
    allowedStates: EDITABLE_STATES,
    async change(client) {
      const updated = (await client.query("UPDATE production_design_tasks SET state='cancelled', revision=revision+1, updated_at=now() WHERE id=$1 RETURNING revision", [taskId])).rows[0];
      await audit(client, projectId, actorUserId, "task_cancelled", taskId, null);
      return { revision: updated.revision, state: "cancelled" };
    },
  });
}

// Re-reads the asset and rebuilds the brief. Only the designer-facing text
// changes; assignee, comments and state stay.
export async function refreshDesignerBrief(db, projectId, taskId, { expectedRevision, actorUserId = null }) {
  return withTask(db, projectId, taskId, expectedRevision, {
    allowedStates: EDITABLE_STATES,
    async change(client, task) {
      const loaded = await loadAssetWithIssues(client, projectId, task.asset_id);
      const brief = buildBrief(loaded.asset, loaded.issues);
      const updated = (
        await client.query(
          `UPDATE production_design_tasks SET brief=$1, brief_asset_revision=$2, brief_imported_revision=$3, revision=revision+1, updated_at=now()
           WHERE id=$4 RETURNING revision`,
          [JSON.stringify(brief), loaded.asset.revision, loaded.asset.imported_revision, taskId]
        )
      ).rows[0];
      await audit(client, projectId, actorUserId, "task_brief_refreshed", taskId, null);
      return { revision: updated.revision };
    },
  });
}

export async function addTaskComment(db, projectId, taskId, { body, kind = "comment", actorUserId = null, authorName = null }) {
  const text = typeof body === "string" ? body.trim() : "";
  if (!text || text.length > 4000) throw httpError(400, "A comment must be 1 to 4000 characters.");
  if (!["comment", "clarification"].includes(kind)) throw httpError(400, "Not a valid comment type.");
  const task = (await db.query("SELECT id FROM production_design_tasks WHERE id = $1 AND project_id = $2", [taskId, projectId])).rows[0];
  if (!task) return { outcome: "not_found" };
  const row = (
    await db.query(
      "INSERT INTO production_task_comments (task_id, project_id, author_user_id, author_name, kind, body) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at",
      [taskId, projectId, actorUserId, authorName, kind, text]
    )
  ).rows[0];
  return { outcome: "ok", id: row.id, createdAt: row.created_at };
}

// ---------------------------------------------------------------------------
// Routes (admin only until designer logins arrive with the upload step)
// ---------------------------------------------------------------------------

export function registerDesignTaskRoutes(app, db, requireRole) {
  const ids = (req, res, withTaskId = false) => {
    const projectId = Number(req.params.projectId);
    const taskId = withTaskId ? Number(req.params.taskId) : null;
    if (!Number.isInteger(projectId) || projectId <= 0 || (withTaskId && (!Number.isInteger(taskId) || taskId <= 0))) {
      res.status(400).json({ error: "Not a valid project or task." });
      return null;
    }
    return { projectId, taskId };
  };
  // Runs an operation and turns its outcome into an HTTP answer.
  const respond = (res, result) => {
    if (result.outcome === "not_found") return res.status(404).json({ error: "Not found." });
    if (result.outcome === "conflict") {
      return res.status(409).json({ error: "This task was changed by someone else. Reload and try again.", currentRevision: result.currentRevision });
    }
    if (result.outcome === "wrong_state") return res.status(409).json({ error: `This can't be done while the task is "${result.state}".`, state: result.state });
    return res.json(result);
  };
  const guard = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ error: error.message });
      throw error;
    }
  };

  app.post("/api/production/:projectId/tasks", requireRole("admin"), guard(async (req, res) => {
    const p = ids(req, res);
    if (!p) return;
    const result = await createDesignerTasks(db, p.projectId, {
      assetIds: req.body?.assetIds ?? null, priority: req.body?.priority, assignee: req.body?.assignee, dueDate: req.body?.dueDate, actorUserId: req.user?.id,
    });
    respond(res, result);
  }));

  app.get("/api/production/:projectId/tasks", requireRole("admin"), guard(async (req, res) => {
    const p = ids(req, res);
    if (!p) return;
    res.json({ tasks: await listDesignerTasks(db, p.projectId) });
  }));

  app.get("/api/production/:projectId/tasks/:taskId", requireRole("admin"), guard(async (req, res) => {
    const p = ids(req, res, true);
    if (!p) return;
    const task = await getDesignerTask(db, p.projectId, p.taskId);
    if (!task) return res.status(404).json({ error: "Task not found." });
    res.json(task);
  }));

  app.patch("/api/production/:projectId/tasks/:taskId", requireRole("admin"), guard(async (req, res) => {
    const p = ids(req, res, true);
    if (!p) return;
    respond(res, await updateDesignerTask(db, p.projectId, p.taskId, {
      expectedRevision: req.body?.expectedRevision, assignee: req.body?.assignee, priority: req.body?.priority, dueDate: req.body?.dueDate, actorUserId: req.user?.id,
    }));
  }));

  app.post("/api/production/:projectId/tasks/:taskId/cancel", requireRole("admin"), guard(async (req, res) => {
    const p = ids(req, res, true);
    if (!p) return;
    respond(res, await cancelDesignerTask(db, p.projectId, p.taskId, { expectedRevision: req.body?.expectedRevision, actorUserId: req.user?.id }));
  }));

  app.post("/api/production/:projectId/tasks/:taskId/refresh-brief", requireRole("admin"), guard(async (req, res) => {
    const p = ids(req, res, true);
    if (!p) return;
    respond(res, await refreshDesignerBrief(db, p.projectId, p.taskId, { expectedRevision: req.body?.expectedRevision, actorUserId: req.user?.id }));
  }));

  app.post("/api/production/:projectId/tasks/:taskId/comments", requireRole("admin"), guard(async (req, res) => {
    const p = ids(req, res, true);
    if (!p) return;
    respond(res, await addTaskComment(db, p.projectId, p.taskId, {
      body: req.body?.body, kind: req.body?.kind, actorUserId: req.user?.id, authorName: req.user?.name ?? null,
    }));
  }));
}
