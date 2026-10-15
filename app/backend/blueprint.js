// Production Blueprint foundation: screenplay versions, the Shot Manifest, and (later phases) the prompt library,
// Blueprint validation/approval and the Timeline hook.
//
// Nothing here is a second source of truth. The facts live where they always lived:
//   scenes / dialogue  -> production_scenes, production_scene_elements   (stable codes SC001, D001)
//   shots              -> production_shots                                (stable codes SH001; manifest id "SC001_SH001")
//   assets             -> production_assets                               (CHAR001, PROP001, LOC001 ...)
//   media + jobs       -> production_generations                          (immutable versions, review state, cost)
// The Shot Manifest is a READ MODEL that joins them, so every screen, agent and the timeline read the same picture.

import crypto from "node:crypto";
import { analyzeScreenplay } from "./screenplayAnalysis.js";
import { listShots } from "./shots.js";

const sha = (text) => crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 32);
export const httpError = (message, status = 400, code = "bad_request") => Object.assign(new Error(message), { status, code });

export async function ensureBlueprintSchema(db) {
  const statements = [
    // One row each time the approved screenplay actually changed (same text approved twice = same version).
    `CREATE TABLE IF NOT EXISTS production_screenplay_versions (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      scene_count INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'approval',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (project_id, version)
    )`,
    // The plan for making the film. Prompts are stored separately and never deleted.
    `CREATE TABLE IF NOT EXISTS production_blueprints (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded')),
      screenplay_version INTEGER NOT NULL,
      validation JSONB,
      estimate JSONB,
      shot_fingerprint TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      approved_at TIMESTAMPTZ,
      approved_by INTEGER,
      UNIQUE (project_id, version)
    )`,
    `CREATE TABLE IF NOT EXISTS production_prompts (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('model_sheet','first_frame','video','audio')),
      asset_id INTEGER REFERENCES production_assets(id) ON DELETE CASCADE,
      shot_id INTEGER REFERENCES production_shots(id) ON DELETE CASCADE,
      element_id INTEGER REFERENCES production_scene_elements(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','superseded')),
      text TEXT NOT NULL,
      params JSONB NOT NULL DEFAULT '{}',
      source_hash TEXT NOT NULL DEFAULT '',
      edited BOOLEAN NOT NULL DEFAULT FALSE,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS production_prompts_project_idx ON production_prompts (project_id, purpose)`,
    // At most one CURRENT prompt per target and purpose; older versions stay forever.
    `CREATE UNIQUE INDEX IF NOT EXISTS production_prompts_one_current ON production_prompts
       (purpose, COALESCE(asset_id, 0), COALESCE(shot_id, 0), COALESCE(element_id, 0)) WHERE status = 'current'`,
    // Two simultaneous requests for the same target can never both start a job (double click, two tabs, a retry on refresh).
    `CREATE UNIQUE INDEX IF NOT EXISTS production_generations_one_running ON production_generations
       (kind, COALESCE(asset_id, 0), COALESCE(shot_id, 0), COALESCE(element_id, 0)) WHERE status = 'running'`,
    // Which prompt (and which Blueprint) a generated file was made from.
    `ALTER TABLE production_generations ADD COLUMN IF NOT EXISTS prompt_id INTEGER REFERENCES production_prompts(id) ON DELETE SET NULL`,
  ];
  for (const sql of statements) await db.query(sql);
}

// ---------------------------------------------------------------------------
// Screenplay versions
// ---------------------------------------------------------------------------

// A fingerprint of the screenplay as production sees it: every current scene's content hash, in order.
export async function screenplayFingerprint(db, projectId) {
  const rows = (await db.query("SELECT source_key, content_hash FROM production_scenes WHERE project_id = $1 AND in_latest ORDER BY order_index", [projectId])).rows;
  return { fingerprint: sha(rows.map((r) => `${r.source_key}:${r.content_hash}`).join("|")), sceneCount: rows.length };
}

export async function currentScreenplayVersion(db, projectId) {
  return (await db.query("SELECT * FROM production_screenplay_versions WHERE project_id = $1 ORDER BY version DESC LIMIT 1", [projectId])).rows[0] ?? null;
}

// Records a new version only when the screenplay really changed. Safe to call any number of times.
export async function registerScreenplayVersion(db, projectId, source = "approval") {
  const { fingerprint, sceneCount } = await screenplayFingerprint(db, projectId);
  if (sceneCount === 0) return { version: null, changed: false, sceneCount };
  const latest = await currentScreenplayVersion(db, projectId);
  if (latest && latest.fingerprint === fingerprint) return { version: latest.version, changed: false, sceneCount };
  const version = (latest?.version ?? 0) + 1;
  try {
    await db.query("INSERT INTO production_screenplay_versions (project_id, version, fingerprint, scene_count, source) VALUES ($1,$2,$3,$4,$5)", [projectId, version, fingerprint, sceneCount, source]);
  } catch (error) {
    if (error.code === "23505") return registerScreenplayVersion(db, projectId, source); // two callers at once: the other one won
    throw error;
  }
  return { version, changed: true, sceneCount };
}

// The hook the screenplay approval calls: read the approved screenplay into production, record its version and make
// sure a draft Blueprint exists for it. Everything here is free (no AI call). Existing approved work is NOT touched:
// if the screenplay changed, the newer version is recorded and the Blueprint / prompts / media made from the older
// one are reported as stale by the manifest (never deleted).
export async function onScreenplayApproved(db, projectId, { actorUserId = null } = {}) {
  const analysis = await analyzeScreenplay(db, projectId, { actorUserId });
  if (analysis.outcome !== "analyzed") return { analyzed: false, reason: analysis.message ?? analysis.outcome };
  const version = await registerScreenplayVersion(db, projectId, "approval");
  const blueprint = await ensureDraftBlueprint(db, projectId, version.version);
  return { analyzed: true, summary: analysis.summary, screenplayVersion: version.version, screenplayChanged: version.changed, blueprintVersion: blueprint.version, blueprintStatus: blueprint.status };
}

export async function latestBlueprint(db, projectId) {
  return (await db.query("SELECT * FROM production_blueprints WHERE project_id = $1 AND status <> 'superseded' ORDER BY version DESC LIMIT 1", [projectId])).rows[0] ?? null;
}

// There is always at most one open blueprint: the approved one, or the draft being prepared.
export async function ensureDraftBlueprint(db, projectId, screenplayVersion) {
  const open = await latestBlueprint(db, projectId);
  if (open) return open;
  const last = (await db.query("SELECT COALESCE(MAX(version),0) AS n FROM production_blueprints WHERE project_id = $1", [projectId])).rows[0].n;
  try {
    return (await db.query("INSERT INTO production_blueprints (project_id, version, status, screenplay_version) VALUES ($1,$2,'draft',$3) RETURNING *", [projectId, last + 1, screenplayVersion ?? 1])).rows[0];
  } catch (error) {
    if (error.code === "23505") return ensureDraftBlueprint(db, projectId, screenplayVersion);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The Shot Manifest
// ---------------------------------------------------------------------------

export const shotRefId = (shot) => `${shot.sceneCode}_${shot.code}`;

const ASSET_GROUP = { character: "character_ids", location: "environment_ids", prop: "prop_ids" };

// What a media slot (a shot's first frame, a shot's video, a dialogue line's voice, a reference sheet) looks like right now.
// planned -> blocked / generating -> ready_for_review -> approved; failed is reported separately; stale is added by the caller.
export function slotState({ approved, generations, blocked }) {
  if (approved) return "approved";
  if (generations.some((g) => g.status === "running")) return "generating";
  if (generations.some((g) => g.status === "ready" && g.review === "pending")) return "ready_for_review";
  const latest = generations[0];
  if (latest && latest.status === "failed") return "failed";
  return blocked ? "blocked" : "planned";
}

export async function buildShotManifest(db, projectId) {
  // Projects made before screenplay versions existed get version 1 the first time they are read.
  let version = await currentScreenplayVersion(db, projectId);
  if (!version) {
    const registered = await registerScreenplayVersion(db, projectId, "migrated");
    if (registered.version) version = await currentScreenplayVersion(db, projectId);
  }
  const blueprint = await latestBlueprint(db, projectId);
  const shots = await listShots(db, projectId);
  const assetRows = (await db.query(
    "SELECT id, code, name, kind FROM production_assets WHERE project_id = $1 AND in_latest_import AND grouped_into IS NULL ORDER BY kind, code", [projectId]
  )).rows;
  const gens = (await db.query(
    `SELECT id, kind, asset_id, shot_id, element_id, status, review, version, media_id, duration_ms, params, prompt_id, cost_usd, error
     FROM production_generations WHERE project_id = $1 ORDER BY id DESC`, [projectId]
  )).rows;
  const prompts = (await db.query(
    "SELECT id, purpose, asset_id, shot_id, element_id, version, source_hash, edited FROM production_prompts WHERE project_id = $1 AND status = 'current'", [projectId]
  )).rows;

  const byShot = (kind) => {
    const map = new Map();
    for (const g of gens) if (g.kind === kind && g.shot_id) map.set(g.shot_id, [...(map.get(g.shot_id) ?? []), g]);
    return map;
  };
  const frames = byShot("keyframe");
  const videos = byShot("video");
  const byAsset = new Map();
  for (const g of gens) if (g.asset_id && ["character", "prop", "environment"].includes(g.kind)) byAsset.set(g.asset_id, [...(byAsset.get(g.asset_id) ?? []), g]);
  const byElement = new Map();
  for (const g of gens) if (g.kind === "audio" && g.element_id) byElement.set(g.element_id, [...(byElement.get(g.element_id) ?? []), g]);
  const approvedOf = (list) => (list ?? []).find((g) => g.review === "approved" && g.status === "ready") ?? null;
  const promptOf = (purpose, key, id) => prompts.find((p) => p.purpose === purpose && p[key] === id) ?? null;

  const assetApproved = new Set(assetRows.filter((a) => approvedOf(byAsset.get(a.id))).map((a) => a.id));
  let cursor = 0;
  const shotEntries = shots.map((s, index) => {
    const durationMs = Math.round(s.durationSec * 1000);
    const start = cursor;
    cursor += durationMs;
    const ids = { character_ids: [], environment_ids: [], prop_ids: [], other_ids: [] };
    for (const a of s.assets) (ids[ASSET_GROUP[a.kind]] ?? ids.other_ids).push(a.code);
    const missingRefs = s.assets.filter((a) => ["character", "location", "prop"].includes(a.kind) && !assetApproved.has(a.id));
    const frame = approvedOf(frames.get(s.id));
    const video = approvedOf(videos.get(s.id));
    const imagePrompt = promptOf("first_frame", "shot_id", s.id);
    const videoPrompt = promptOf("video", "shot_id", s.id);
    return {
      shot_id: shotRefId(s), db_id: s.id, code: s.code, scene_id: s.sceneCode, scene_db_id: s.sceneId, scene_number: s.sceneNumber, number: s.number,
      screenplay_version: version?.version ?? null, sequence: index + 1,
      planned_start_ms: start, planned_duration_ms: durationMs,
      purpose: s.storyboardText || "", frame_description: s.frameDescription || "", action: s.description, framing: s.framing, camera_angle: s.cameraAngle, camera_move: s.cameraMove,
      character_ids: ids.character_ids, environment_id: ids.environment_ids[0] ?? null, environment_ids: ids.environment_ids, prop_ids: ids.prop_ids, other_ids: ids.other_ids,
      dialogue: s.dialogue.map((d) => ({ id: d.id, code: d.code, speaker: d.speaker })),
      audio_cue_ids: s.dialogue.map((d) => d.code),
      shot_status: s.shotStatus, revision: s.revision,
      image: { prompt_id: imagePrompt?.id ?? null, prompt_version: imagePrompt?.version ?? null, approved_asset_id: frame?.id ?? null, state: slotState({ approved: frame, generations: frames.get(s.id) ?? [], blocked: missingRefs.length > 0 }), blocked_by: missingRefs.map((a) => a.code) },
      video: { prompt_id: videoPrompt?.id ?? null, prompt_version: videoPrompt?.version ?? null, approved_asset_id: video?.id ?? null, state: slotState({ approved: video, generations: videos.get(s.id) ?? [], blocked: !frame }), blocked_by: frame ? [] : ["first frame"] },
      timeline: { track_id: "V1", source_in_ms: 0, duration_ms: durationMs },
    };
  });

  const assetEntries = assetRows.map((a) => {
    const list = byAsset.get(a.id) ?? [];
    const approved = approvedOf(list);
    const prompt = promptOf("model_sheet", "asset_id", a.id);
    return {
      asset_id: a.code, db_id: a.id, type: a.kind === "location" ? "environment" : a.kind, name: a.name,
      prompt_id: prompt?.id ?? null, approved_asset_id: approved?.id ?? null, versions: list.length,
      state: slotState({ approved, generations: list, blocked: false }),
      shot_ids: shotEntries.filter((s) => [...s.character_ids, ...s.environment_ids, ...s.prop_ids, ...s.other_ids].includes(a.code)).map((s) => s.shot_id),
    };
  });

  const dialogueLines = (await db.query("SELECT id FROM production_scene_elements WHERE project_id = $1 AND kind = 'dialogue'", [projectId])).rows;
  const audioApproved = dialogueLines.filter((d) => approvedOf(byElement.get(d.id))).length;
  const count = (list, state) => list.filter((x) => x.state === state).length;
  const sceneCodes = [...new Set(shotEntries.map((s) => s.scene_id))];
  return {
    project_id: projectId,
    screenplay_version: version?.version ?? null,
    blueprint: blueprint ? { version: blueprint.version, status: blueprint.status, screenplay_version: blueprint.screenplay_version } : null,
    totals: {
      scenes: sceneCodes.length, shots: shotEntries.length, planned_duration_ms: cursor,
      assets: { characters: assetEntries.filter((a) => a.type === "character").length, environments: assetEntries.filter((a) => a.type === "environment").length, props: assetEntries.filter((a) => a.type === "prop").length },
      approved_references: { characters: assetEntries.filter((a) => a.type === "character" && a.state === "approved").length, environments: assetEntries.filter((a) => a.type === "environment" && a.state === "approved").length, props: assetEntries.filter((a) => a.type === "prop" && a.state === "approved").length },
      first_frames_approved: count(shotEntries.map((s) => s.image), "approved"), videos_approved: count(shotEntries.map((s) => s.video), "approved"),
      dialogue_lines: dialogueLines.length, audio_approved: audioApproved,
      jobs_running: gens.filter((g) => g.status === "running").length,
    },
    shots: shotEntries,
    assets: assetEntries,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerBlueprintRoutes(app, db, requireRole) {
  const admin = requireRole("admin");
  const id = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error("Blueprint route failed:", error);
      res.status(status).json({ error: status >= 500 && !error.status ? "Something went wrong on the server." : error.message, code: error.code ?? null });
    }
  };
  const project = async (req) => {
    const projectId = id(req.params.projectId);
    if (!projectId) throw httpError("Not a valid project.", 400);
    if ((await db.query("SELECT 1 FROM ai_movie_projects WHERE id = $1", [projectId])).rowCount === 0) throw httpError("Project not found.", 404);
    return projectId;
  };

  app.get("/api/production/:projectId/manifest", admin, wrap(async (req, res) => {
    res.json(await buildShotManifest(db, await project(req)));
  }));

  app.get("/api/production/:projectId/screenplay-versions", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    res.json({ versions: (await db.query("SELECT version, fingerprint, scene_count, source, created_at FROM production_screenplay_versions WHERE project_id = $1 ORDER BY version DESC", [projectId])).rows });
  }));

  // Re-read the approved screenplay into production (also what approving the screenplay does automatically).
  app.post("/api/production/:projectId/blueprint/sync", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    res.json(await onScreenplayApproved(db, projectId, { actorUserId: req.user?.id }));
  }));
}
