// Saving, reviewing and applying Shot Optimization plans (the engine itself is shotOptimizer.js).
//
// A plan is a saved, numbered proposal. Nothing about the project changes until the person approves one:
//   - draft      can be re-computed in another mode, have merge groups switched on/off, and be reviewed by the model
//   - approved   the merges were applied to the shots; the original shots are kept inside the plan so they can be restored
//   - superseded / restored  history, never deleted
// Approving never starts paid work, and never touches a shot that already has generated pictures, voices or video.

import { getSettings } from "./pipelineSettings.js";
import { buildOptimizationPlan, baselineHash, providerCapabilities, reviewPlanWithModel, MODES, GENRE_PROFILES } from "./shotOptimizer.js";
import { listShots } from "./shots.js";
import { spendSummary } from "./pipelineSettings.js";
import { planPrompts } from "./planning.js";
import { latestBlueprint, httpError } from "./blueprint.js";
import { publish } from "./events.js";
import { activeUnits } from "./generationUnits.js";

export async function ensureShotPlanSchema(db) {
  const statements = [
    `ALTER TABLE production_shots ADD COLUMN IF NOT EXISTS purpose TEXT`,
    `ALTER TABLE production_shots ADD COLUMN IF NOT EXISTS is_signature BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE production_shots ADD COLUMN IF NOT EXISTS continuous_with_prev BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE production_shots ADD COLUMN IF NOT EXISTS beats JSONB`,
    `ALTER TABLE production_shots ADD COLUMN IF NOT EXISTS merged_from JSONB`,
    `CREATE TABLE IF NOT EXISTS production_shot_plans (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      mode TEXT NOT NULL,
      genre TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded','restored')),
      screenplay_version INTEGER,
      baseline JSONB NOT NULL,
      baseline_hash TEXT NOT NULL,
      decisions JSONB NOT NULL DEFAULT '{}',
      plan JSONB NOT NULL,
      review JSONB,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      approved_at TIMESTAMPTZ,
      UNIQUE (project_id, version)
    )`,
    `CREATE TABLE IF NOT EXISTS production_generation_units (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      plan_id INTEGER NOT NULL REFERENCES production_shot_plans(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      scene_id INTEGER REFERENCES production_scenes(id) ON DELETE CASCADE,
      lead_shot_id INTEGER REFERENCES production_shots(id) ON DELETE CASCADE,
      shot_ids INTEGER[] NOT NULL,
      duration_ms INTEGER NOT NULL,
      requested_seconds INTEGER NOT NULL,
      spec JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','split')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (plan_id, code)
    )`,
    `CREATE INDEX IF NOT EXISTS production_generation_units_lead ON production_generation_units (project_id, lead_shot_id) WHERE status = 'active'`,
  ];
  for (const sql of statements) await db.query(sql);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
async function currentShots(db, projectId) {
  const shots = await listShots(db, projectId);
  if (shots.length === 0) return [];
  const ids = shots.map((s) => s.id);
  const extra = new Map((await db.query("SELECT id, is_signature, continuous_with_prev, purpose FROM production_shots WHERE id = ANY($1)", [ids])).rows.map((r) => [r.id, r]));
  const made = new Set((await db.query("SELECT DISTINCT shot_id FROM production_generations WHERE shot_id = ANY($1)", [ids])).rows.map((r) => r.shot_id));
  return shots.map((s) => ({ ...s, isSignature: extra.get(s.id)?.is_signature ?? false, continuousWithPrev: extra.get(s.id)?.continuous_with_prev ?? false, purpose: extra.get(s.id)?.purpose ?? null, locked: made.has(s.id) }));
}

async function genreHint(db, projectId) {
  try {
    const row = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0];
    const b = row?.backfill ?? {};
    return [b?.genre, b?.story?.genre, b?.format].filter((x) => typeof x === "string").join(" ") || null;
  } catch { return null; }
}

async function remainingBudget(db, projectId) {
  try { const s = await spendSummary(db, projectId); return Number.isFinite(s.remainingUsd) ? s.remainingUsd : null; } catch { return null; }
}

const view = (row) => ({
  id: row.id, version: row.version, mode: row.mode, genre: row.genre, status: row.status, screenplayVersion: row.screenplay_version, createdAt: row.created_at, approvedAt: row.approved_at,
  decisions: row.decisions, review: row.review, stale: row.stale ?? false, plan: row.plan,
  // the shots as they were when the plan was made, so the screen can show before and after
  baseline: (row.baseline ?? []).map((s) => ({ id: s.id, code: s.code, sceneId: s.sceneId, sceneCode: s.sceneCode, framing: s.framing, cameraMove: s.cameraMove, description: s.description, durationSec: s.durationSec, dialogue: (s.dialogue ?? []).length, isSignature: Boolean(s.isSignature), locked: Boolean(s.locked) })),
});

export async function listPlans(db, projectId) {
  return (await db.query("SELECT id, version, mode, genre, status, created_at, approved_at, plan->'initial_editorial_shot_count' AS before, plan->'optimized_editorial_shot_count' AS after FROM production_shot_plans WHERE project_id = $1 ORDER BY version DESC", [projectId])).rows
    .map((r) => ({ id: r.id, version: r.version, mode: r.mode, genre: r.genre, status: r.status, createdAt: r.created_at, approvedAt: r.approved_at, before: r.before, after: r.after }));
}

export async function getPlan(db, projectId, planId) {
  const row = (await db.query("SELECT * FROM production_shot_plans WHERE id = $1 AND project_id = $2", [planId, projectId])).rows[0];
  if (!row) throw httpError("Shot plan not found.", 404, "not_found");
  const now = baselineHash(await currentShots(db, projectId));
  return view({ ...row, stale: row.status === "draft" && now !== row.baseline_hash });
}

// ---------------------------------------------------------------------------
// Creating / adjusting a draft
// ---------------------------------------------------------------------------
async function compute(db, projectId, shots, { mode, genre, decisions, env }) {
  const bp = await latestBlueprint(db, projectId).catch(() => null);
  const settings = await getSettings(db, projectId);
  return buildOptimizationPlan({
    shots, mode, genre, genreHint: await genreHint(db, projectId), decisions, projectId, screenplayVersion: bp?.screenplay_version ?? null,
    style: settings.look, aspectRatio: settings.aspectRatio ?? "16:9", remainingBudgetUsd: await remainingBudget(db, projectId), caps: providerCapabilities(env), env,
  });
}

export async function createPlan(db, projectId, { mode = "balanced", genre = null, actorUserId = null, env = process.env } = {}) {
  const shots = await currentShots(db, projectId);
  if (shots.length === 0) throw httpError("There are no shots yet. Cut the scenes into shots first.", 409, "no_shots");
  const plan = await compute(db, projectId, shots, { mode, genre, decisions: {}, env });
  const version = Number((await db.query("SELECT COALESCE(MAX(version),0)+1 AS v FROM production_shot_plans WHERE project_id = $1", [projectId])).rows[0].v);
  await db.query("UPDATE production_shot_plans SET status = 'superseded' WHERE project_id = $1 AND status = 'draft'", [projectId]);
  const row = (await db.query(
    `INSERT INTO production_shot_plans (project_id, version, mode, genre, screenplay_version, baseline, baseline_hash, plan, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [projectId, version, mode, plan.genre, plan.screenplay_version, JSON.stringify(shots), plan.stale_hash, JSON.stringify(plan), actorUserId]
  )).rows[0];
  publish(projectId, { type: "shot_plan_changed", planId: row.id });
  return view(row);
}

// Change mode / genre and/or switch merge groups on or off. The plan is recomputed from the SAME saved baseline shots.
export async function adjustPlan(db, projectId, planId, { mode = null, genre = null, decisions = null, env = process.env } = {}) {
  const row = (await db.query("SELECT * FROM production_shot_plans WHERE id = $1 AND project_id = $2", [planId, projectId])).rows[0];
  if (!row) throw httpError("Shot plan not found.", 404, "not_found");
  if (row.status !== "draft") throw httpError("Only a draft plan can be changed. Make a new plan instead.", 409, "not_draft");
  if (mode && !MODES[mode]) throw httpError(`Unknown mode "${mode}".`, 400);
  if (genre && !GENRE_PROFILES[genre]) throw httpError(`Unknown film type "${genre}".`, 400);
  const shots = row.baseline;
  const newMode = mode ?? row.mode;
  // a new mode finds different groups, so earlier on/off choices no longer apply
  const merged = mode && mode !== row.mode ? {} : { ...row.decisions, ...(decisions ?? {}) };
  const plan = await compute(db, projectId, shots, { mode: newMode, genre: genre ?? row.genre, decisions: merged, env });
  const updated = (await db.query("UPDATE production_shot_plans SET mode = $2, genre = $3, decisions = $4, plan = $5 WHERE id = $1 RETURNING *", [planId, newMode, plan.genre, JSON.stringify(merged), JSON.stringify(plan)])).rows[0];
  publish(projectId, { type: "shot_plan_changed", planId });
  return view(updated);
}

// Marks a shot as a signature moment (never merged away) or not. The Shot Cutter's AI also sets this from the Spectacle Director's brief.
export async function setSignature(db, projectId, shotId, signature) {
  const r = await db.query("UPDATE production_shots SET is_signature = $3 WHERE id = $1 AND project_id = $2 RETURNING id", [shotId, projectId, Boolean(signature)]);
  if (r.rowCount === 0) throw httpError("Shot not found.", 404, "not_found");
  return { ok: true };
}

// The model reads each scene's proposed merges and may reject some. Goes through the money guard inside textJson.
export async function reviewPlan(db, projectId, planId, textJson, { env = process.env } = {}) {
  if (!textJson) throw httpError("The AI is not available on this server right now.", 503, "not_configured");
  const row = (await db.query("SELECT * FROM production_shot_plans WHERE id = $1 AND project_id = $2", [planId, projectId])).rows[0];
  if (!row) throw httpError("Shot plan not found.", 404, "not_found");
  if (row.status !== "draft") throw httpError("Only a draft plan can be reviewed.", 409, "not_draft");
  const result = await reviewPlanWithModel(row.plan, row.baseline, textJson);
  const decisions = { ...row.decisions };
  for (const [id, v] of Object.entries(result.verdicts)) if (v.verdict === "reject_join") decisions[id] = false;
  const plan = await compute(db, projectId, row.baseline, { mode: row.mode, genre: row.genre, decisions, env });
  plan.review = { reviewed_scenes: result.reviewed, failures: result.failures, rejected: Object.entries(result.verdicts).filter(([, v]) => v.verdict === "reject_join").map(([id, v]) => ({ group: id, reason: v.reason })), notes: result.notes };
  plan.review.reviewed_groups = result.reviewed; plan.review.total_groups = result.total; plan.review.stopped_by_budget = result.stoppedByBudget;
  if (result.failures) plan.warnings.push({ code: "review_incomplete", level: "warning", message: `The AI review could not read ${result.failures} merge(s); those were not reviewed.` });
  if (result.stoppedByBudget) plan.warnings.push({ code: "review_stopped_by_budget", level: "warning", message: `The money limit stopped the AI review after ${result.reviewed} of ${result.total} merges. Raise the limit and review again to check the rest.` });
  plan.optimization_notes.push(`AI review: ${plan.review.rejected.length} merge(s) rejected, ${result.reviewed} of ${result.total} merges read.`);
  const updated = (await db.query("UPDATE production_shot_plans SET decisions = $2, plan = $3, review = $4 WHERE id = $1 RETURNING *", [planId, JSON.stringify(decisions), JSON.stringify(plan), JSON.stringify(plan.review)])).rows[0];
  publish(projectId, { type: "shot_plan_changed", planId });
  return view(updated);
}

// ---------------------------------------------------------------------------
// Approving: apply the merges to the real shots
// ---------------------------------------------------------------------------
export async function approvePlan(db, projectId, planId, { actorUserId = null, env = process.env } = {}) {
  const row = (await db.query("SELECT * FROM production_shot_plans WHERE id = $1 AND project_id = $2", [planId, projectId])).rows[0];
  if (!row) throw httpError("Shot plan not found.", 404, "not_found");
  if (row.status !== "draft") throw httpError("This plan is not a draft any more.", 409, "not_draft");
  const blueprint = await latestBlueprint(db, projectId).catch(() => null);
  if (blueprint?.status === "approved") throw httpError("The Blueprint is already approved. Reopen it first (Production Blueprint → Overview), then approve the shot plan.", 409, "blueprint_approved");
  const shots = await currentShots(db, projectId);
  if (baselineHash(shots) !== row.baseline_hash) throw httpError("The shots changed after this plan was made. Make a new plan.", 409, "stale_plan");
  const plan = row.plan;
  if (plan.warnings.some((w) => w.level === "error")) throw httpError("This plan loses story material (see its errors). Switch some merges off or choose another mode.", 409, "plan_has_errors");
  const byId = new Map(shots.map((s) => [s.id, s]));
  const client = await db.connect();
  const applied = { merged_groups: 0, shots_removed: 0 };
  try {
    await client.query("BEGIN");
    const touchedScenes = new Set();
    for (const g of plan.groups.filter((x) => x.accepted)) {
      const members = g.shotIds.map((id) => byId.get(id));
      if (members.some((m) => !m || m.locked || m.isSignature)) throw httpError(`A shot in group ${g.id} has approved or generated work, so it cannot be merged.`, 409, "locked");
      const merged = plan.editorial_shots.find((e) => e.id === g.shotIds[0]);
      const [lead, ...rest] = members;
      await client.query(
        `UPDATE production_shots SET description = $2, duration_sec = $3, camera_move = COALESCE($4, camera_move), beats = $5, merged_from = $6, source = 'optimized', edited = TRUE, revision = revision + 1, updated_at = now() WHERE id = $1`,
        [lead.id, merged.description, merged.duration_ms / 1000, merged.camera_move, JSON.stringify(merged.internal_beats), JSON.stringify(members.map((m) => m.id))]
      );
      for (const m of rest) {
        await client.query("UPDATE production_shot_dialogue SET shot_id = $1 WHERE shot_id = $2 AND NOT EXISTS (SELECT 1 FROM production_shot_dialogue d WHERE d.shot_id = $1 AND d.element_id = production_shot_dialogue.element_id)", [lead.id, m.id]);
        await client.query("INSERT INTO production_shot_assets (shot_id, asset_id) SELECT $1, asset_id FROM production_shot_assets WHERE shot_id = $2 ON CONFLICT DO NOTHING", [lead.id, m.id]);
        await client.query("DELETE FROM production_shots WHERE id = $1", [m.id]);
        applied.shots_removed++;
      }
      touchedScenes.add(lead.sceneId);
      applied.merged_groups++;
    }
    for (const sceneId of touchedScenes) {
      const left = (await client.query("SELECT id FROM production_shots WHERE scene_id = $1 ORDER BY order_index, id", [sceneId])).rows;
      for (let i = 0; i < left.length; i++) await client.query("UPDATE production_shots SET order_index = $2 WHERE id = $1", [left[i].id, i]);
    }
    // generation units, now tied to the real shot rows
    await client.query("UPDATE production_generation_units SET status = 'split' WHERE project_id = $1 AND status = 'active'", [projectId]);
    for (const u of plan.generation_units) {
      await client.query(
        `INSERT INTO production_generation_units (project_id, plan_id, code, scene_id, lead_shot_id, shot_ids, duration_ms, requested_seconds, spec) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [projectId, planId, u.generation_unit_id, u.scene_id, u.editorial_shot_ids[0], u.editorial_shot_ids, u.duration, u.requested_seconds, JSON.stringify(u)]
      );
    }
    await client.query("UPDATE production_shot_plans SET status = 'approved', approved_at = now() WHERE id = $1", [planId]);
    await client.query("UPDATE production_shot_plans SET status = 'superseded' WHERE project_id = $1 AND id <> $2 AND status = 'approved'", [projectId, planId]);
    // the person approved this plan, so the shot division counts as approved for the scenes it touched
    await client.query("UPDATE production_shots SET shot_status = 'approved' WHERE project_id = $1 AND scene_id IN (SELECT scene_id FROM production_generation_units WHERE plan_id = $2)", [projectId, planId]);
    await client.query("INSERT INTO production_audit_events (project_id, actor_user_id, action, entity, entity_id, detail) VALUES ($1,$2,'shot_plan_approved','shot_plan',$3,$4)", [projectId, actorUserId, String(planId), JSON.stringify({ mode: row.mode, ...applied })]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  // prompts are free to write; nothing paid starts here
  await planPrompts(db, projectId, { actorUserId });
  publish(projectId, { type: "shot_plan_changed", planId, approved: true });
  return { ...applied, units: plan.generation_units.length, plan: await getPlan(db, projectId, planId) };
}

// Puts the ORIGINAL shots back (same codes) — only while nothing was generated for them and the Blueprint is open.
export async function restorePlan(db, projectId, planId, { actorUserId = null } = {}) {
  const row = (await db.query("SELECT * FROM production_shot_plans WHERE id = $1 AND project_id = $2", [planId, projectId])).rows[0];
  if (!row) throw httpError("Shot plan not found.", 404, "not_found");
  if (row.status !== "approved") throw httpError("Only the approved plan can be restored.", 409, "not_approved");
  const blueprint = await latestBlueprint(db, projectId).catch(() => null);
  if (blueprint?.status === "approved") throw httpError("The Blueprint is approved. Reopen it first.", 409, "blueprint_approved");
  const ids = (await db.query("SELECT id FROM production_shots WHERE project_id = $1", [projectId])).rows.map((r) => r.id);
  const made = (await db.query("SELECT count(*)::int AS n FROM production_generations WHERE shot_id = ANY($1)", [ids])).rows[0].n;
  if (made > 0) throw httpError("Pictures or video were already made for these shots. Split the merged shots one by one instead.", 409, "has_generations");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const baseline = row.baseline;
    const mergedLeads = baseline.filter((s) => row.plan.groups.some((g) => g.accepted && g.shotIds[0] === s.id));
    for (const g of row.plan.groups.filter((x) => x.accepted)) {
      for (const sid of g.shotIds.slice(1)) {
        const s = baseline.find((b) => b.id === sid);
        const created = (await client.query(
          `INSERT INTO production_shots (project_id, scene_id, code, order_index, framing, camera_angle, camera_move, description, duration_sec, source, shot_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'approved') RETURNING id`,
          [projectId, s.sceneId, s.code, 9000 + sid, s.framing, s.cameraAngle, s.cameraMove, s.description, s.durationSec, s.source ?? "restored"]
        )).rows[0];
        for (const d of s.dialogue) await client.query("UPDATE production_shot_dialogue SET shot_id = $1 WHERE element_id = $2", [created.id, d.id]);
        for (const a of s.assets) await client.query("INSERT INTO production_shot_assets (shot_id, asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [created.id, a.id]);
      }
    }
    for (const lead of mergedLeads) {
      await client.query("UPDATE production_shots SET description = $2, duration_sec = $3, camera_move = $4, beats = NULL, merged_from = NULL, source = $5, revision = revision + 1 WHERE id = $1", [lead.id, lead.description, lead.durationSec, lead.cameraMove, lead.source]);
      for (const d of lead.dialogue) await client.query("UPDATE production_shot_dialogue SET shot_id = $1 WHERE element_id = $2", [lead.id, d.id]);
    }
    // original order: the baseline list is already in order
    const order = new Map(baseline.map((s, i) => [s.code, i]));
    const scenes = [...new Set(baseline.map((s) => s.sceneId))];
    for (const sceneId of scenes) {
      const rows = (await client.query("SELECT id, code FROM production_shots WHERE scene_id = $1", [sceneId])).rows.sort((a, b) => (order.get(a.code) ?? 9999) - (order.get(b.code) ?? 9999));
      for (let i = 0; i < rows.length; i++) await client.query("UPDATE production_shots SET order_index = $2 WHERE id = $1", [rows[i].id, i]);
    }
    await client.query("UPDATE production_generation_units SET status = 'split' WHERE project_id = $1 AND status = 'active'", [projectId]);
    await client.query("UPDATE production_shot_plans SET status = 'restored' WHERE id = $1", [planId]);
    await client.query("INSERT INTO production_audit_events (project_id, actor_user_id, action, entity, entity_id, detail) VALUES ($1,$2,'shot_plan_restored','shot_plan',$3,'{}')", [projectId, actorUserId, String(planId)]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await planPrompts(db, projectId, { actorUserId });
  publish(projectId, { type: "shot_plan_changed", planId, restored: true });
  return { restored: true };
}

// ---------------------------------------------------------------------------
// Generation units: lookup for prompts / timeline, and the failure fallback
// ---------------------------------------------------------------------------

// A combined generation that failed can be split into one unit per shot without touching anything else.
export async function splitUnit(db, projectId, unitId) {
  const unit = (await db.query("SELECT * FROM production_generation_units WHERE id = $1 AND project_id = $2 AND status = 'active'", [unitId, projectId])).rows[0];
  if (!unit) throw httpError("That generation unit was not found.", 404, "not_found");
  if (unit.shot_ids.length < 2) throw httpError("This unit already covers a single shot.", 409, "single");
  const approved = (await db.query("SELECT 1 FROM production_generations WHERE shot_id = $1 AND kind = 'video' AND review = 'approved' AND status = 'ready'", [unit.lead_shot_id])).rowCount > 0;
  if (approved) throw httpError("This combined video is already approved; its clips keep using it. Make new takes in the Video Studio instead.", 409, "approved");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE production_generation_units SET status = 'split' WHERE id = $1", [unit.id]);
    const base = Number((await client.query("SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::int),0) AS n FROM production_generation_units WHERE plan_id = $1", [unit.plan_id])).rows[0].n);
    for (let i = 0; i < unit.shot_ids.length; i++) {
      const shot = (await client.query("SELECT id, scene_id, duration_sec FROM production_shots WHERE id = $1", [unit.shot_ids[i]])).rows[0];
      if (!shot) continue;
      const ms = Math.round(Number(shot.duration_sec) * 1000);
      await client.query(
        "INSERT INTO production_generation_units (project_id, plan_id, code, scene_id, lead_shot_id, shot_ids, duration_ms, requested_seconds, spec) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [projectId, unit.plan_id, `GU${String(base + i + 1).padStart(3, "0")}`, shot.scene_id, shot.id, [shot.id], ms, Math.min(8, Math.max(4, Math.ceil(ms / 2000) * 2)), JSON.stringify({ splitFrom: unit.code })]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await db.query("UPDATE production_timeline_clips SET source_in_ms = 0 WHERE shot_id = ANY($1) AND kind = 'shot' AND NOT edited", [unit.shot_ids]).catch(() => {});
  await planPrompts(db, projectId);
  publish(projectId, { type: "shot_plan_changed", unitSplit: unitId });
  return { split: true, units: (await activeUnits(db, projectId)).length };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function registerShotPlanRoutes(app, db, requireRole, { getTextJson = null, env = process.env } = {}) {
  const admin = requireRole("admin");
  const id = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
  const wrap = (handler) => async (req, res) => {
    try { await handler(req, res); } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error("Shot plan route failed:", error);
      res.status(status).json({ error: status >= 500 && !error.status ? "Something went wrong on the server." : error.message, code: error.code ?? null });
    }
  };
  const project = async (req) => {
    const projectId = id(req.params.projectId);
    if (!projectId) throw httpError("Not a valid project.", 400);
    if ((await db.query("SELECT 1 FROM ai_movie_projects WHERE id = $1", [projectId])).rowCount === 0) throw httpError("Project not found.", 404);
    return projectId;
  };
  const planId = (req) => id(req.params.planId) ?? 0;
  const base = "/api/production/:projectId/shot-plans";
  app.get(base, admin, wrap(async (req, res) => {
    const projectId = await project(req);
    const plans = await listPlans(db, projectId);
    const current = plans.find((p) => p.status === "draft") ?? plans.find((p) => p.status === "approved") ?? null;
    res.json({ plans, current: current ? await getPlan(db, projectId, current.id) : null, capabilities: providerCapabilities(env), modes: Object.entries(MODES).map(([key, v]) => ({ key, ...v })), genres: Object.entries(GENRE_PROFILES).map(([key, v]) => ({ key, ...v })) });
  }));
  app.post(base, admin, wrap(async (req, res) => res.status(201).json({ plan: await createPlan(db, await project(req), { mode: req.body?.mode ?? "balanced", genre: req.body?.genre ?? null, actorUserId: req.user?.id, env }) })));
  app.get(`${base}/:planId`, admin, wrap(async (req, res) => res.json({ plan: await getPlan(db, await project(req), planId(req)) })));
  app.patch(`${base}/:planId`, admin, wrap(async (req, res) => res.json({ plan: await adjustPlan(db, await project(req), planId(req), { mode: req.body?.mode ?? null, genre: req.body?.genre ?? null, decisions: req.body?.decisions ?? null, env }) })));
  app.post(`${base}/:planId/review`, admin, wrap(async (req, res) => {
    const projectId = await project(req);
    const textJson = getTextJson ? await getTextJson(projectId) : null;
    res.json({ plan: await reviewPlan(db, projectId, planId(req), textJson, { env }) });
  }));
  app.post(`${base}/:planId/approve`, admin, wrap(async (req, res) => res.json(await approvePlan(db, await project(req), planId(req), { actorUserId: req.user?.id, env }))));
  app.post(`${base}/:planId/restore`, admin, wrap(async (req, res) => res.json(await restorePlan(db, await project(req), planId(req), { actorUserId: req.user?.id }))));
  app.get("/api/production/:projectId/generation-units", admin, wrap(async (req, res) => {
    const rows = await activeUnits(db, await project(req));
    res.json({ units: rows.map((u) => ({ id: u.id, code: u.code, sceneId: u.scene_id, leadShotId: u.lead_shot_id, shotIds: u.shot_ids, durationMs: u.duration_ms, requestedSeconds: u.requested_seconds, spec: u.spec })) });
  }));
  app.post("/api/production/:projectId/generation-units/:unitId/split", admin, wrap(async (req, res) => res.json(await splitUnit(db, await project(req), id(req.params.unitId) ?? 0))));
  app.put("/api/production/:projectId/shots/:shotId/signature", admin, wrap(async (req, res) => res.json(await setSignature(db, await project(req), id(req.params.shotId) ?? 0, req.body?.signature === true))));
}
