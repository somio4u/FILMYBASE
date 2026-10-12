// Production planning: everything that is decided BEFORE any paid image / video / voice is made.
//   1. the prompt library        one model-sheet prompt per asset, a first-frame and a video prompt per shot, an audio prompt per spoken line
//   2. validation                IDs, durations, prompt completeness, dependencies, screenplay version, estimated cost
//   3. Blueprint approval        creates the Timeline placeholders at once (see timeline.js)
//   4. reopening                 back to draft; prompts, media and the timeline are kept (never deleted), outputs show as stale
// All of it is free: no model is called here.

import { effectiveDetails } from "./production.js";
import { unitIndex } from "./generationUnits.js";
import { GENRE_PROFILES, inferGenre } from "./shotOptimizer.js";
import { listShots } from "./shots.js";
import { audioSpec, estimateCost, frameSpec, sheetSpec, veoSecondsFor, videoSpec, voiceForSpeaker } from "./generations.js";
import { currentScreenplayVersion, ensureDraftBlueprint, httpError, latestBlueprint, registerScreenplayVersion } from "./blueprint.js";
import { editPrompt, ensurePrompt, hashInputs, promptHistory, promptView } from "./prompts.js";
import { getSettings, spendSummary } from "./pipelineSettings.js";
import { syncTimelineFromBlueprint } from "./timeline.js";
import { publish } from "./events.js";

// What every prompt SHOULD say right now, from the project's current facts.
export async function computeSpecs(db, projectId) {
  const settings = await getSettings(db, projectId);
  const style = settings.stylePrompt;
  const shots = await listShots(db, projectId);
  const assets = (await db.query("SELECT * FROM production_assets WHERE project_id = $1 AND in_latest_import ORDER BY kind, code", [projectId])).rows;
  const used = new Set(shots.flatMap((s) => s.assets.map((a) => a.id)));
  const lines = (await db.query(
    `SELECT e.* FROM production_scene_elements e JOIN production_scenes s ON s.id = e.scene_id WHERE e.project_id = $1 AND e.kind = 'dialogue' AND s.in_latest ORDER BY s.order_index, e.order_index`, [projectId]
  )).rows;
  const specs = [];
  for (const a of assets) specs.push({ ...sheetSpec(a, style), _asset: a, _used: used.has(a.id) });
  const units = await unitIndex(db, projectId);
  for (const s of shots) {
    const u = units.get(s.id);
    if (u && u.members.length > 1) {
      // several shots share ONE generation: only the lead has a picture and a video request; the others read from it
      if (!u.isLead) continue;
      const rows = shots.filter((x) => u.members.includes(x.id));
      const whole = { ...s, description: u.members.map((id) => rows.find((r) => r.id === id)?.description).filter(Boolean).join(" Then "), durationSec: u.unit.duration_ms / 1000 };
      specs.push({ ...frameSpec(s, style, settings.aspectRatio), _shot: s });
      specs.push({ ...videoSpec(whole, style, settings.aspectRatio), _shot: s });
      continue;
    }
    specs.push({ ...frameSpec(s, style, settings.aspectRatio), _shot: s });
    specs.push({ ...videoSpec(s, style, settings.aspectRatio), _shot: s });
  }
  for (const l of lines) specs.push({ ...audioSpec(l, await voiceForSpeaker(db, projectId, l.speaker)), _line: l });
  return { specs, shots, assets, lines, settings };
}

const keyOf = (x) => `${x.purpose}:${x.assetId ?? x.asset_id ?? 0}:${x.shotId ?? x.shot_id ?? 0}:${x.elementId ?? x.element_id ?? 0}`;

// Plans (or refreshes) the whole prompt library. Safe to repeat: same inputs = same prompts, changed inputs = a new
// version (old kept), a person's edited prompt is never overwritten.
export async function planPrompts(db, projectId, { actorUserId = null } = {}) {
  const { specs } = await computeSpecs(db, projectId);
  const counts = { created: 0, updated: 0, unchanged: 0, kept_edited: 0, total: specs.length };
  for (const spec of specs) {
    const { _asset, _shot, _line, _used, ...rest } = spec;
    const r = await ensurePrompt(db, projectId, { ...rest, actorUserId });
    counts[r.outcome]++;
  }
  publish(projectId, { type: "prompts_planned", ...counts });
  return counts;
}

// Compares the stored current prompts with what the project's facts say they should be.
export async function promptStatus(db, projectId) {
  const { specs, shots, assets, lines } = await computeSpecs(db, projectId);
  const current = (await db.query("SELECT * FROM production_prompts WHERE project_id = $1 AND status = 'current'", [projectId])).rows;
  const byKey = new Map(current.map((p) => [keyOf(p), p]));
  const missing = [];
  const stale = [];
  for (const spec of specs) {
    const p = byKey.get(keyOf(spec));
    if (!p) missing.push(spec);
    else if (p.source_hash !== spec.sourceHash) stale.push({ spec, prompt: p });
  }
  return { specs, current, missing, stale, shots, assets, lines };
}

export function estimateBlueprint({ shots, assets, lines, approved, spend }) {
  const references = assets.filter((a) => !approved.assets.has(a.id) && approved.used.has(a.id)).length;
  const frames = shots.filter((s) => !approved.frames.has(s.id)).length;
  const videoShots = shots.filter((s) => !approved.videos.has(s.id));
  const videoSeconds = videoShots.reduce((n, s) => n + veoSecondsFor(s.durationSec), 0);
  const audioChars = lines.filter((l) => !approved.audio.has(l.id)).reduce((n, l) => n + ((l.text_en || l.text_hi || "").length), 0);
  const referencesUsd = estimateCost("character") * references;
  const framesUsd = estimateCost("keyframe") * frames;
  const videoUsd = estimateCost("video", { seconds: videoSeconds });
  const audioUsd = estimateCost("audio", { chars: audioChars });
  const total = Math.round((referencesUsd + framesUsd + videoUsd + audioUsd) * 100) / 100;
  return {
    references, frames, videoShots: videoShots.length, videoSeconds, audioChars,
    referencesUsd: Math.round(referencesUsd * 100) / 100, framesUsd: Math.round(framesUsd * 100) / 100, videoUsd: Math.round(videoUsd * 100) / 100, audioUsd: Math.round(audioUsd * 100) / 100,
    totalUsd: total, remainingBudgetUsd: spend.remainingUsd, fitsBudget: total <= spend.remainingUsd + 1e-9,
    note: "Estimates from the app's price table, not bills. Nothing is generated until you press a generate button, and every job is checked against the money limit first.",
  };
}

async function approvedSets(db, projectId) {
  const rows = (await db.query("SELECT kind, asset_id, shot_id, element_id FROM production_generations WHERE project_id = $1 AND review = 'approved' AND status = 'ready'", [projectId])).rows;
  const pick = (kinds, col) => new Set(rows.filter((r) => kinds.includes(r.kind)).map((r) => r[col]));
  const shotsRows = (await db.query("SELECT sa.asset_id FROM production_shot_assets sa JOIN production_shots s ON s.id = sa.shot_id WHERE s.project_id = $1", [projectId])).rows;
  return { assets: pick(["character", "prop", "environment"], "asset_id"), frames: pick(["keyframe"], "shot_id"), videos: pick(["video"], "shot_id"), audio: pick(["audio"], "element_id"), used: new Set(shotsRows.map((r) => r.asset_id)) };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export async function validateBlueprint(db, projectId) {
  const errors = [];
  const warnings = [];
  const add = (list, code, message, extra = {}) => list.push({ code, message, ...extra });
  const status = await promptStatus(db, projectId);
  const { shots, assets, lines } = status;
  const scenes = (await db.query("SELECT id, code, scene_number, heading, estimated_minutes FROM production_scenes WHERE project_id = $1 AND in_latest ORDER BY order_index", [projectId])).rows;
  const version = await currentScreenplayVersion(db, projectId);
  const blueprint = await latestBlueprint(db, projectId);

  if (scenes.length === 0) add(errors, "no_scenes", "The approved screenplay has not been read into production yet. Approve the screenplay (or press Sync) first.");
  if (shots.length === 0) add(errors, "no_shots", "There are no shots yet. Cut the scenes into shots first (Shots tab).");
  if (blueprint && version && blueprint.screenplay_version < version.version) add(errors, "screenplay_changed", `The screenplay changed (version ${version.version}) after this Blueprint was started on version ${blueprint.screenplay_version}. Re-sync and review the shots.`);

  const shotsByScene = new Map();
  for (const s of shots) shotsByScene.set(s.sceneId, [...(shotsByScene.get(s.sceneId) ?? []), s]);
  for (const sc of scenes) {
    const list = shotsByScene.get(sc.id) ?? [];
    if (shots.length > 0 && list.length === 0) add(errors, "scene_without_shots", `Scene ${sc.scene_number} (${sc.heading}) has no shots.`, { scene: sc.code });
    else if (list.some((s) => s.shotStatus !== "approved")) add(errors, "shots_not_approved", `The shot division of scene ${sc.scene_number} is not approved yet.`, { scene: sc.code });
  }
  const dupes = shots.map((s) => `${s.sceneCode}_${s.code}`).filter((id, i, all) => all.indexOf(id) !== i);
  if (dupes.length) add(errors, "duplicate_ids", `Duplicate shot ids: ${[...new Set(dupes)].join(", ")}.`);
  for (const s of shots) {
    if (!(s.durationSec >= 1 && s.durationSec <= 30)) add(errors, "bad_duration", `Shot ${s.sceneCode}_${s.code} has an invalid length (${s.durationSec}s).`, { shot: `${s.sceneCode}_${s.code}` });
    if (!s.description?.trim()) add(errors, "empty_shot", `Shot ${s.sceneCode}_${s.code} has no description.`, { shot: `${s.sceneCode}_${s.code}` });
  }
  // prompts: complete and current
  const missingBy = (purpose) => status.missing.filter((m) => m.purpose === purpose);
  const frames = missingBy("first_frame"), videos = missingBy("video"), sheets = missingBy("model_sheet").filter((m) => m._used), audio = missingBy("audio");
  if (frames.length) add(errors, "missing_frame_prompts", `${frames.length} shot${frames.length === 1 ? " has" : "s have"} no first-frame prompt. Plan the prompts.`, { count: frames.length });
  if (videos.length) add(errors, "missing_video_prompts", `${videos.length} shot${videos.length === 1 ? " has" : "s have"} no video prompt. Plan the prompts.`, { count: videos.length });
  if (sheets.length) add(errors, "missing_sheet_prompts", `${sheets.length} asset${sheets.length === 1 ? " used by the shots has" : "s used by the shots have"} no model-sheet prompt. Plan the prompts.`, { count: sheets.length });
  if (audio.length) add(errors, "missing_audio_prompts", `${audio.length} spoken line${audio.length === 1 ? " has" : "s have"} no audio instruction. Plan the prompts.`, { count: audio.length });
  if (status.stale.length) add(errors, "stale_prompts", `${status.stale.length} prompt${status.stale.length === 1 ? " is" : "s are"} out of date (the shot, asset or film look changed). Plan the prompts again to refresh them; prompts you edited are kept and shown as out of date.`, { count: status.stale.length });
  // dependencies
  const inShot = new Set(shots.flatMap((s) => s.dialogue.map((d) => d.id)));
  const loose = lines.filter((l) => !inShot.has(l.id));
  if (loose.length) add(warnings, "dialogue_not_in_shot", `${loose.length} spoken line${loose.length === 1 ? " is" : "s are"} not covered by any shot (${loose.slice(0, 5).map((l) => l.code).join(", ")}${loose.length > 5 ? "…" : ""}); they will not appear on the timeline.`, { count: loose.length });
  const unused = assets.filter((a) => !shots.some((s) => s.assets.some((x) => x.id === a.id)));
  if (unused.length) add(warnings, "unused_assets", `${unused.length} dossier item${unused.length === 1 ? " is" : "s are"} not used by any shot (${unused.slice(0, 4).map((a) => a.name).join(", ")}${unused.length > 4 ? "…" : ""}).`, { count: unused.length });
  const noCast = shots.filter((s) => !s.assets.some((a) => a.kind === "location"));
  if (noCast.length) add(warnings, "shots_without_environment", `${noCast.length} shot${noCast.length === 1 ? " has" : "s have"} no environment linked, so there is no place reference to keep the setting consistent.`, { count: noCast.length });
  const planned = shots.reduce((n, s) => n + s.durationSec, 0) / 60;
  const wanted = scenes.reduce((n, s) => n + Number(s.estimated_minutes ?? 0), 0);
  if (wanted > 0 && planned < wanted * 0.5) add(warnings, "short_runtime", `The planned shots add up to ${planned.toFixed(1)} minutes but the screenplay estimates about ${wanted.toFixed(1)}.`);
  // an unusually dense shot list costs a lot: point at the AI Shot Optimization review before any paid work is planned
  const filmSeconds = shots.reduce((n, s) => n + s.durationSec, 0);
  const range = GENRE_PROFILES[inferGenre(shots)];
  const approvedPlan = (await db.query("SELECT 1 FROM production_shot_plans WHERE project_id = $1 AND status = 'approved'", [projectId]).catch(() => ({ rowCount: 0 }))).rowCount > 0;
  if (!approvedPlan && filmSeconds > 0 && shots.length > range.max * (filmSeconds / 300) * 1.25) add(warnings, "dense_shot_plan", `${shots.length} shots for ${Math.round(filmSeconds)} seconds is unusually dense (a film like this usually needs ${Math.round(range.min * filmSeconds / 300)}–${Math.round(range.max * filmSeconds / 300)}). Each shot is a separate paid video request: run the AI Shot Optimization review (Shots tab) before approving.`, { count: shots.length });
  const spend = await spendSummary(db, projectId);
  const estimate = estimateBlueprint({ shots, assets, lines, approved: await approvedSets(db, projectId), spend });
  if (!estimate.fitsBudget) add(warnings, "over_budget", `Making everything would cost about $${estimate.totalUsd.toFixed(2)} but only $${estimate.remainingBudgetUsd.toFixed(2)} is left of the money limit. You can raise the limit later or generate in stages.`);
  return {
    ok: errors.length === 0, errors, warnings, estimate,
    counts: { scenes: scenes.length, shots: shots.length, assets: assets.length, dialogue: lines.length, plannedSeconds: Math.round(shots.reduce((n, s) => n + s.durationSec, 0)), prompts: status.current.length, stalePrompts: status.stale.length, missingPrompts: status.missing.length },
  };
}

const shotFingerprint = (shots) => hashInputs(shots.map((s) => [s.id, s.revision, s.durationSec]));

// ---------------------------------------------------------------------------
// Approve / reopen
// ---------------------------------------------------------------------------

export async function approveBlueprint(db, projectId, { actorUserId = null } = {}) {
  const validation = await validateBlueprint(db, projectId);
  if (!validation.ok) throw Object.assign(httpError(`The Blueprint cannot be approved yet: ${validation.errors.length} problem${validation.errors.length === 1 ? "" : "s"} to fix.`, 409, "not_valid"), { validation });
  const shots = await listShots(db, projectId);
  const version = await currentScreenplayVersion(db, projectId) ?? (await registerScreenplayVersion(db, projectId, "approval"), await currentScreenplayVersion(db, projectId));
  let blueprint = await ensureDraftBlueprint(db, projectId, version?.version ?? 1);
  if (blueprint.status === "approved") return { blueprint, validation, timeline: { created: 0, updated: 0, orphaned: 0, dialogue: 0 }, alreadyApproved: true };
  blueprint = (await db.query(
    "UPDATE production_blueprints SET status = 'approved', screenplay_version = $2, validation = $3, estimate = $4, shot_fingerprint = $5, approved_at = now(), approved_by = $6 WHERE id = $1 RETURNING *",
    [blueprint.id, version?.version ?? blueprint.screenplay_version, JSON.stringify(validation), JSON.stringify(validation.estimate), shotFingerprint(shots), actorUserId]
  )).rows[0];
  // the Timeline exists from this moment — no media needed
  const timeline = await syncTimelineFromBlueprint(db, projectId, blueprint.version);
  publish(projectId, { type: "blueprint_approved", version: blueprint.version });
  return { blueprint, validation, timeline };
}

// Back to planning: the approved Blueprint becomes history, a new draft opens. Prompts, media and the timeline are kept.
export async function reopenBlueprint(db, projectId, { reason = "" } = {}) {
  const current = await latestBlueprint(db, projectId);
  if (!current || current.status !== "approved") throw httpError("There is no approved Blueprint to reopen.", 409, "not_approved");
  const version = await currentScreenplayVersion(db, projectId);
  await db.query("UPDATE production_blueprints SET status = 'superseded', validation = COALESCE(validation, '{}'::jsonb) || $2::jsonb WHERE id = $1", [current.id, JSON.stringify({ reopenedBecause: String(reason).slice(0, 300) })]);
  const draft = (await db.query("INSERT INTO production_blueprints (project_id, version, status, screenplay_version) VALUES ($1,$2,'draft',$3) RETURNING *", [projectId, current.version + 1, version?.version ?? current.screenplay_version])).rows[0];
  publish(projectId, { type: "blueprint_reopened", version: draft.version });
  return draft;
}

// Why an approved Blueprint no longer matches the project (shown as "stale"; nothing is deleted).
export async function blueprintStaleness(db, projectId) {
  const blueprint = await latestBlueprint(db, projectId);
  const reasons = [];
  if (!blueprint || blueprint.status !== "approved") return { stale: false, reasons };
  const version = await currentScreenplayVersion(db, projectId);
  if (version && blueprint.screenplay_version < version.version) reasons.push({ code: "screenplay_changed", message: `The screenplay changed after this Blueprint was approved (Blueprint on version ${blueprint.screenplay_version}, screenplay now version ${version.version}).` });
  const shots = await listShots(db, projectId);
  if (blueprint.shot_fingerprint && blueprint.shot_fingerprint !== shotFingerprint(shots)) reasons.push({ code: "shots_changed", message: "Shots were added, removed, edited or re-timed after this Blueprint was approved." });
  const status = await promptStatus(db, projectId);
  if (status.stale.length) reasons.push({ code: "prompts_stale", message: `${status.stale.length} prompt${status.stale.length === 1 ? " is" : "s are"} out of date.`, count: status.stale.length });
  return { stale: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerPlanningRoutes(app, db, requireRole) {
  const admin = requireRole("admin");
  const id = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error("Planning route failed:", error);
      res.status(status).json({ error: status >= 500 && !error.status ? "Something went wrong on the server." : error.message, code: error.code ?? null, validation: error.validation });
    }
  };
  const project = async (req) => {
    const projectId = id(req.params.projectId);
    if (!projectId) throw httpError("Not a valid project.", 400);
    if ((await db.query("SELECT 1 FROM ai_movie_projects WHERE id = $1", [projectId])).rowCount === 0) throw httpError("Project not found.", 404);
    return projectId;
  };
  const targetFrom = (q) => ({ assetId: id(q.assetId), shotId: id(q.shotId), elementId: id(q.elementId) });
  const checkTarget = (purpose, t) => {
    const ok = (purpose === "model_sheet" && t.assetId) || ((purpose === "first_frame" || purpose === "video") && t.shotId) || (purpose === "audio" && t.elementId);
    if (!ok) throw httpError("Name the thing the prompt is for (assetId, shotId or elementId) and its purpose.", 400);
  };

  app.get("/api/production/:projectId/blueprint", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    const blueprint = await latestBlueprint(db, projectId);
    const version = await currentScreenplayVersion(db, projectId);
    const validation = await validateBlueprint(db, projectId);
    res.json({
      blueprint: blueprint && { version: blueprint.version, status: blueprint.status, screenplayVersion: blueprint.screenplay_version, approvedAt: blueprint.approved_at },
      screenplayVersion: version?.version ?? null, staleness: await blueprintStaleness(db, projectId), validation,
    });
  }));

  app.post("/api/production/:projectId/blueprint/prompts/plan", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    res.json(await planPrompts(db, projectId, { actorUserId: req.user?.id }));
  }));

  // The prompt library: current prompts (with whether they are out of date) and, per target, the full history.
  app.get("/api/production/:projectId/blueprint/prompts", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    const purpose = req.query.purpose ? String(req.query.purpose) : null;
    const status = await promptStatus(db, projectId);
    const hashFor = new Map(status.specs.map((s) => [keyOf(s), s.sourceHash]));
    const order = new Map(status.specs.map((spec, i) => [keyOf(spec), i]));
    const prompts = status.current.filter((p) => !purpose || p.purpose === purpose).sort((a, b) => (order.get(keyOf(a)) ?? 1e9) - (order.get(keyOf(b)) ?? 1e9)).map((p) => ({ ...promptView(p, hashFor.get(keyOf(p)) ?? null), assetId: p.asset_id, shotId: p.shot_id, elementId: p.element_id }));
    res.json({ prompts, missing: status.missing.length, stale: status.stale.length });
  }));

  app.get("/api/production/:projectId/blueprint/prompts/history", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    const purpose = String(req.query.purpose ?? "");
    const target = targetFrom(req.query);
    checkTarget(purpose, target);
    res.json({ versions: await promptHistory(db, projectId, purpose, target) });
  }));

  app.put("/api/production/:projectId/blueprint/prompts", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    const purpose = String(req.body?.purpose ?? "");
    const target = targetFrom(req.body ?? {});
    checkTarget(purpose, target);
    const row = await editPrompt(db, projectId, purpose, target, req.body?.text, { actorUserId: req.user?.id });
    publish(projectId, { type: "prompt_edited", purpose, ...target, version: row.version });
    res.json({ prompt: promptView(row) });
  }));

  app.post("/api/production/:projectId/blueprint/validate", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    const validation = await validateBlueprint(db, projectId);
    const draft = await latestBlueprint(db, projectId);
    if (draft && draft.status === "draft") await db.query("UPDATE production_blueprints SET validation = $2, estimate = $3 WHERE id = $1", [draft.id, JSON.stringify(validation), JSON.stringify(validation.estimate)]);
    res.json(validation);
  }));

  app.post("/api/production/:projectId/blueprint/approve", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    res.json(await approveBlueprint(db, projectId, { actorUserId: req.user?.id }));
  }));

  app.post("/api/production/:projectId/blueprint/reopen", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    res.json({ blueprint: await reopenBlueprint(db, projectId, { reason: req.body?.reason }) });
  }));
}
