// Read models for the Image / Video / Audio studios. Each studio shows ONE canonical (approved) result per slot and keeps
// every other version in a history; this file builds exactly that picture from the Shot Manifest, the prompt library and
// the generation records, so a screen never has to stitch five endpoints together (and never disagrees with the timeline).
//
//   assetLibrary(type)   characters | environments | properties: canonical reference sheet, versions, prompt, where it is used
//   frameScenes()        the scenes with how many of their first frames are approved / ready to make / blocked
//   frameSlots(scene)    one slot per PLANNED shot: first-frame prompt, the references it depends on, state, versions

import { buildShotManifest, httpError } from "./blueprint.js";
import { promptStatus } from "./planning.js";
import { promptView } from "./prompts.js";
import { estimateCost } from "./generations.js";

const mediaUrl = (g) => (g?.media_id ? `/api/production/media/${g.media_id}` : null);
const keyOf = (purpose, assetId, shotId, elementId) => `${purpose}:${assetId ?? 0}:${shotId ?? 0}:${elementId ?? 0}`;

function versionView(g, currentPromptId, outdatedRefs = null) {
  return {
    id: g.id, version: g.version, status: g.status, review: g.review, mediaUrl: mediaUrl(g), costUsd: Number(g.cost_usd), error: g.error, createdAt: g.created_at,
    promptId: g.prompt_id, promptCurrent: g.prompt_id === null ? null : g.prompt_id === currentPromptId, mime: g.mime ?? null,
    outdated: outdatedRefs,
  };
}

async function loadGenerations(db, projectId, kinds, where = "", params = []) {
  return (await db.query(
    `SELECT g.*, m.mime FROM production_generations g LEFT JOIN production_media_files m ON m.id = g.media_id
     WHERE g.project_id = $1 AND g.kind = ANY($2) ${where} ORDER BY g.id DESC`, [projectId, kinds, ...params]
  )).rows;
}

function promptFor(status, hashFor, current, purpose, assetId, shotId, elementId) {
  const p = current.get(keyOf(purpose, assetId, shotId, elementId));
  return p ? promptView(p, hashFor.get(keyOf(purpose, assetId, shotId, elementId)) ?? null) : null;
}

export async function assetLibrary(db, projectId, type) {
  const wanted = type === "property" ? ["prop", "other"] : [type];
  if (!["character", "environment", "property"].includes(type)) throw httpError("Type must be character, environment or property.", 400);
  const manifest = await buildShotManifest(db, projectId);
  const status = await promptStatus(db, projectId);
  const hashFor = new Map(status.specs.map((s) => [keyOf(s.purpose, s.assetId, s.shotId, s.elementId), s.sourceHash]));
  const current = new Map(status.current.map((p) => [keyOf(p.purpose, p.asset_id, p.shot_id, p.element_id), p]));
  const assets = manifest.assets.filter((a) => wanted.includes(a.type));
  const gens = await loadGenerations(db, projectId, ["character", "prop", "environment"], "AND g.asset_id = ANY($3)", [assets.map((a) => a.db_id)]);
  const detail = new Map((await db.query("SELECT id, agent_details, human_edits FROM production_assets WHERE project_id = $1", [projectId])).rows.map((r) => [r.id, { ...r.agent_details, ...r.human_edits }]));
  const out = assets.map((a) => {
    const list = gens.filter((g) => g.asset_id === a.db_id);
    const canonical = list.find((g) => g.review === "approved" && g.status === "ready") ?? null;
    const prompt = promptFor(status, hashFor, current, "model_sheet", a.db_id, null, null);
    const others = list.filter((g) => g !== canonical);
    const latest = list[0] ?? null;
    return {
      assetId: a.asset_id, dbId: a.db_id, type: a.type, name: a.name, state: a.state,
      prompt, canonical: canonical && versionView(canonical, prompt?.id ?? null),
      latestReady: latest && latest.status === "ready" && latest.review === "pending" ? versionView(latest, prompt?.id ?? null) : null,
      running: list.some((g) => g.status === "running"),
      history: others.filter((g) => g.id !== (latest && latest.status === "ready" && latest.review === "pending" ? latest.id : -1)).map((g) => versionView(g, prompt?.id ?? null)),
      versions: list.length,
      usedInShots: a.shot_ids, usedCount: a.shot_ids.length,
      note: detail.get(a.db_id)?.description ?? detail.get(a.db_id)?.notes ?? null,
      estimateUsd: estimateCost("character"),
    };
  });
  const approved = out.filter((a) => a.state === "approved").length;
  const missing = out.filter((a) => a.state !== "approved" && !a.running && a.usedCount > 0).length;
  return { type, assets: out, counts: { inProject: out.length, approved, missing, running: out.filter((a) => a.running).length, estimateMissingUsd: Math.round(missing * estimateCost("character") * 100) / 100 } };
}

export async function frameScenes(db, projectId) {
  const manifest = await buildShotManifest(db, projectId);
  const byScene = new Map();
  for (const s of manifest.shots) {
    const scene = byScene.get(s.scene_id) ?? { code: s.scene_id, dbId: s.scene_db_id, number: s.scene_number, shots: 0, approved: 0, ready: 0, blocked: 0, generating: 0, review: 0 };
    scene.shots++;
    if (s.image.state === "approved") scene.approved++;
    else if (s.image.state === "generating") scene.generating++;
    else if (s.image.state === "ready_for_review") scene.review++;
    else if (s.image.state === "blocked") scene.blocked++;
    else scene.ready++;
    byScene.set(s.scene_id, scene);
  }
  const headings = new Map((await db.query("SELECT code, heading FROM production_scenes WHERE project_id = $1 AND in_latest", [projectId])).rows.map((r) => [r.code, r.heading]));
  return { scenes: [...byScene.values()].map((s) => ({ ...s, heading: headings.get(s.code) ?? "" })) };
}

export async function frameSlots(db, projectId, sceneDbId) {
  const manifest = await buildShotManifest(db, projectId);
  const status = await promptStatus(db, projectId);
  const hashFor = new Map(status.specs.map((s) => [keyOf(s.purpose, s.assetId, s.shotId, s.elementId), s.sourceHash]));
  const current = new Map(status.current.map((p) => [keyOf(p.purpose, p.asset_id, p.shot_id, p.element_id), p]));
  const shots = manifest.shots.filter((s) => s.scene_db_id === sceneDbId);
  if (shots.length === 0) return { slots: [], counts: { shots: 0, approved: 0, readyToMake: 0, blocked: 0, estimateUsd: 0 } };
  const gens = await loadGenerations(db, projectId, ["keyframe"], "AND g.shot_id = ANY($3)", [shots.map((s) => s.db_id)]);
  const assetByCode = new Map(manifest.assets.map((a) => [a.asset_id, a]));
  const approvedRefIds = new Set((await db.query("SELECT id FROM production_generations WHERE project_id = $1 AND review = 'approved' AND asset_id IS NOT NULL", [projectId])).rows.map((r) => r.id));
  const slots = shots.map((s) => {
    const list = gens.filter((g) => g.shot_id === s.db_id);
    const canonical = list.find((g) => g.review === "approved" && g.status === "ready") ?? null;
    const prompt = promptFor(status, hashFor, current, "first_frame", null, s.db_id, null);
    const deps = [...s.character_ids, ...s.environment_ids, ...s.prop_ids].map((code) => {
      const a = assetByCode.get(code);
      return { code, name: a?.name ?? code, type: a?.type ?? "other", approved: a?.state === "approved" };
    });
    const outdated = (g) => g.kind === "keyframe" && Array.isArray(g.params?.refs) && g.params.refs.some((r) => !approvedRefIds.has(r));
    const canonicalView = canonical && versionView(canonical, prompt?.id ?? null, outdated(canonical));
    const ready = s.shot_status === "approved" && deps.every((d) => d.approved);
    return {
      shotId: s.shot_id, dbId: s.db_id, number: s.number, sequence: s.sequence, action: s.action, framing: s.framing, cameraAngle: s.camera_angle, cameraMove: s.camera_move,
      plannedDurationMs: s.planned_duration_ms, state: s.image.state, prompt, dependencies: deps,
      readiness: { ok: ready, shotDivisionApproved: s.shot_status === "approved", missing: deps.filter((d) => !d.approved).map((d) => `${d.code} ${d.name}`) },
      canonical: canonicalView, stale: Boolean(canonicalView?.outdated) || Boolean(prompt?.stale),
      latestReady: list[0] && list[0].status === "ready" && list[0].review === "pending" ? versionView(list[0], prompt?.id ?? null, outdated(list[0])) : null,
      history: list.filter((g) => g !== canonical && g !== (list[0].status === "ready" && list[0].review === "pending" ? list[0] : null)).map((g) => versionView(g, prompt?.id ?? null, outdated(g))),
      running: list.some((g) => g.status === "running"), versions: list.length,
    };
  });
  const open = slots.filter((x) => x.state !== "approved" && !x.running);
  const makeable = open.filter((x) => x.readiness.ok);
  return {
    slots,
    counts: {
      shots: slots.length, approved: slots.filter((x) => x.state === "approved").length, review: slots.filter((x) => x.state === "ready_for_review").length,
      readyToMake: makeable.length, blocked: open.length - makeable.length, running: slots.filter((x) => x.running).length,
      estimateUsd: Math.round(makeable.length * estimateCost("keyframe") * 100) / 100,
    },
  };
}

export function registerStudioRoutes(app, db, requireRole) {
  const admin = requireRole("admin");
  const id = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error("Studio route failed:", error);
      res.status(status).json({ error: status >= 500 && !error.status ? "Something went wrong on the server." : error.message, code: error.code ?? null });
    }
  };
  const project = async (req) => {
    const projectId = id(req.params.projectId);
    if (!projectId) throw httpError("Not a valid project.", 400);
    if ((await db.query("SELECT 1 FROM ai_movie_projects WHERE id = $1", [projectId])).rowCount === 0) throw httpError("Project not found.", 404);
    return projectId;
  };
  app.get("/api/production/:projectId/studio/assets", admin, wrap(async (req, res) => res.json(await assetLibrary(db, await project(req), String(req.query.type ?? "")))));
  app.get("/api/production/:projectId/studio/frames/scenes", admin, wrap(async (req, res) => res.json(await frameScenes(db, await project(req)))));
  app.get("/api/production/:projectId/studio/frames", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    const sceneId = id(req.query.sceneId);
    if (!sceneId) throw httpError("Choose a scene (sceneId).", 400);
    res.json(await frameSlots(db, projectId, sceneId));
  }));
}
