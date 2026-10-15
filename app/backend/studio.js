// Read models for the Image / Video / Audio studios. Each studio shows ONE canonical (approved) result per slot and keeps
// every other version in a history; this file builds exactly that picture from the Shot Manifest, the prompt library and
// the generation records, so a screen never has to stitch five endpoints together (and never disagrees with the timeline).
//
//   assetLibrary(type)   characters | environments | properties: canonical reference sheet, versions, prompt, where it is used
//   frameScenes()        the scenes with how many of their first frames are approved / ready to make / blocked
//   frameSlots(scene)    one slot per PLANNED shot: first-frame prompt, the references it depends on, state, versions

import { foreignOrigin } from "./castRule.js";
import { unitIndex } from "./generationUnits.js";
import { buildShotManifest, httpError } from "./blueprint.js";
import { promptStatus } from "./planning.js";
import { promptView } from "./prompts.js";
import { estimateCost, veoSecondsFor } from "./generations.js";

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
      origin: a.type === "character" ? (foreignOrigin(detail.get(a.db_id)) ?? null) : undefined, // a character from outside India, or null (Indian is the default)
      estimateUsd: estimateCost("character"),
    };
  });
  const approved = out.filter((a) => a.state === "approved").length;
  const missing = out.filter((a) => a.state !== "approved" && !a.running && a.usedCount > 0).length;
  return { type, assets: out, counts: { inProject: out.length, approved, missing, running: out.filter((a) => a.running).length, estimateMissingUsd: Math.round(missing * estimateCost("character") * 100) / 100 } };
}

// The Image Studio only shows shots whose shot division the director approved in the Storyboard Designer.
// Until then a scene does not appear here at all; `waiting` says how many are still to be approved there.
const approvedShot = (s) => s.shot_status === "approved";

export async function frameScenes(db, projectId) {
  const manifest = await buildShotManifest(db, projectId);
  const byScene = new Map();
  const waiting = { shots: manifest.shots.filter((s) => !approvedShot(s)).length, scenes: new Set(manifest.shots.filter((s) => !approvedShot(s)).map((s) => s.scene_id)).size };
  for (const s of manifest.shots.filter(approvedShot)) {
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
  return { scenes: [...byScene.values()].map((s) => ({ ...s, heading: headings.get(s.code) ?? "" })), waiting };
}

export async function frameSlots(db, projectId, sceneDbId) {
  const manifest = await buildShotManifest(db, projectId);
  const status = await promptStatus(db, projectId);
  const hashFor = new Map(status.specs.map((s) => [keyOf(s.purpose, s.assetId, s.shotId, s.elementId), s.sourceHash]));
  const current = new Map(status.current.map((p) => [keyOf(p.purpose, p.asset_id, p.shot_id, p.element_id), p]));
  const shots = manifest.shots.filter((s) => s.scene_db_id === sceneDbId && approvedShot(s));
  if (shots.length === 0) return { slots: [], counts: { shots: 0, approved: 0, readyToMake: 0, blocked: 0, estimateUsd: 0 } };
  const gens = await loadGenerations(db, projectId, ["keyframe"], "AND g.shot_id = ANY($3)", [shots.map((s) => s.db_id)]);
  const assetByCode = new Map(manifest.assets.map((a) => [a.asset_id, a]));
  const approvedRefIds = new Set((await db.query("SELECT id FROM production_generations WHERE project_id = $1 AND review = 'approved' AND asset_id IS NOT NULL", [projectId])).rows.map((r) => r.id));
  const units = await unitIndex(db, projectId);
  const codeOfShot = new Map(manifest.shots.map((x) => [x.db_id, x.shot_id]));
  const slots = shots.map((s) => {
    const unit = units.get(s.db_id);
    const covered = unit && unit.members.length > 1 && !unit.isLead ? codeOfShot.get(unit.leadId) : null;
    const list = gens.filter((g) => g.shot_id === s.db_id);
    const canonical = list.find((g) => g.review === "approved" && g.status === "ready") ?? null;
    const prompt = promptFor(status, hashFor, current, "first_frame", null, s.db_id, null);
    const deps = [...s.character_ids, ...s.environment_ids, ...s.prop_ids].map((code) => {
      const a = assetByCode.get(code);
      return { code, name: a?.name ?? code, type: a?.type ?? "other", approved: a?.state === "approved" };
    });
    const outdated = (g) => g.kind === "keyframe" && Array.isArray(g.params?.refs) && g.params.refs.some((r) => !approvedRefIds.has(r));
    const canonicalView = canonical && versionView(canonical, prompt?.id ?? null, outdated(canonical));
    const ready = s.shot_status === "approved" && deps.every((d) => d.approved) && !covered;
    return {
      generationUnit: unit ? { code: unit.unit.code, members: unit.members.length, isLead: unit.isLead } : null, coveredBy: covered,
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

// ---------------------------------------------------------------------------
// Video Studio
// ---------------------------------------------------------------------------

export async function videoScenes(db, projectId) {
  const manifest = await buildShotManifest(db, projectId);
  const byScene = new Map();
  for (const s of manifest.shots) {
    const scene = byScene.get(s.scene_id) ?? { code: s.scene_id, dbId: s.scene_db_id, number: s.scene_number, shots: 0, approved: 0, ready: 0, blocked: 0, review: 0, generating: 0 };
    scene.shots++;
    const v = s.video.state;
    if (v === "approved") scene.approved++;
    else if (v === "generating") scene.generating++;
    else if (v === "ready_for_review") scene.review++;
    else if (v === "blocked") scene.blocked++;
    else scene.ready++;
    byScene.set(s.scene_id, scene);
  }
  return { scenes: [...byScene.values()] };
}

export async function videoSlots(db, projectId, sceneDbId) {
  const manifest = await buildShotManifest(db, projectId);
  const status = await promptStatus(db, projectId);
  const hashFor = new Map(status.specs.map((s) => [keyOf(s.purpose, s.assetId, s.shotId, s.elementId), s.sourceHash]));
  const current = new Map(status.current.map((p) => [keyOf(p.purpose, p.asset_id, p.shot_id, p.element_id), p]));
  const shots = manifest.shots.filter((s) => s.scene_db_id === sceneDbId);
  if (shots.length === 0) return { slots: [], counts: { shots: 0, approved: 0, readyToMake: 0, blocked: 0, review: 0, estimateUsd: 0 } };
  const ids = shots.map((s) => s.db_id);
  const takes = await loadGenerations(db, projectId, ["video"], "AND g.shot_id = ANY($3)", [ids]);
  const frames = await loadGenerations(db, projectId, ["keyframe"], "AND g.shot_id = ANY($3) AND g.review = 'approved' AND g.status = 'ready'", [ids]);
  const frameOf = new Map(frames.map((g) => [g.shot_id, g]));
  const units = await unitIndex(db, projectId);
  const codeOf = new Map(manifest.shots.map((x) => [x.db_id, x.shot_id]));
  const slots = shots.map((s) => {
    const unit = units.get(s.db_id);
    const covered = unit && unit.members.length > 1 && !unit.isLead ? codeOf.get(unit.leadId) : null;
    const list = takes.filter((g) => g.shot_id === s.db_id);
    const canonical = list.find((g) => g.review === "approved" && g.status === "ready") ?? null;
    const frame = frameOf.get(s.db_id) ?? null;
    const prompt = promptFor(status, hashFor, current, "video", null, s.db_id, null);
    const seconds = unit && unit.members.length > 1 && unit.isLead ? unit.unit.requested_seconds : veoSecondsFor(s.planned_duration_ms / 1000);
    // a take made from a first frame that has since been replaced no longer matches the approved picture
    const fromOld = (g) => Boolean(frame && g.params?.fromGeneration && g.params.fromGeneration !== frame.id);
    const latest = list[0];
    const latestReady = latest && latest.status === "ready" && latest.review === "pending" ? latest : null;
    return {
      shotId: s.shot_id, dbId: s.db_id, number: s.number, sequence: s.sequence, action: s.action, framing: s.framing, cameraMove: s.camera_move,
      plannedDurationMs: s.planned_duration_ms, targetSeconds: seconds, allowedSeconds: [4, 6, 8],
      firstFrame: frame ? { id: frame.id, mediaUrl: mediaUrl(frame), version: frame.version } : null,
      prompt, state: s.video.state,
      generationUnit: unit ? { code: unit.unit.code, leadShot: codeOf.get(unit.leadId), members: unit.members.length, isLead: unit.isLead, requestedSeconds: unit.unit.requested_seconds, offsetMs: unit.offsetMs } : null, coveredBy: covered,
      readiness: covered ? { ok: false, reason: `Covered by the combined video of ${covered}.` } : { ok: Boolean(frame), reason: frame ? null : "Approve this shot's first frame in the Image Studio first." },
      characterIds: s.character_ids, environmentIds: s.environment_ids, propIds: s.prop_ids,
      canonical: canonical && { ...versionView(canonical, prompt?.id ?? null, fromOld(canonical)), seconds: canonical.params?.seconds ?? null },
      latestReady: latestReady && { ...versionView(latestReady, prompt?.id ?? null, fromOld(latestReady)), seconds: latestReady.params?.seconds ?? null },
      history: list.filter((g) => g !== canonical && g !== latestReady).map((g) => ({ ...versionView(g, prompt?.id ?? null, fromOld(g)), seconds: g.params?.seconds ?? null })),
      stale: Boolean(prompt?.stale) || Boolean(canonical && fromOld(canonical)),
      running: list.some((g) => g.status === "running"), versions: list.length,
      estimateUsd: estimateCost("video", { seconds }),
    };
  });
  const open = slots.filter((x) => x.state !== "approved" && !x.running && !x.latestReady);
  const makeable = open.filter((x) => x.readiness.ok);
  return {
    slots,
    counts: { shots: slots.length, approved: slots.filter((x) => x.state === "approved").length, review: slots.filter((x) => x.latestReady).length, readyToMake: makeable.length, blocked: open.length - makeable.length, running: slots.filter((x) => x.running).length, estimateUsd: Math.round(makeable.reduce((n, x) => n + x.estimateUsd, 0) * 100) / 100 },
  };
}

// ---------------------------------------------------------------------------
// Audio Studio (spoken lines; sound effects and music are cues, see audioCues.js)
// ---------------------------------------------------------------------------

export async function audioScenes(db, projectId) {
  const rows = (await db.query(
    `SELECT s.id, s.code, s.scene_number, s.heading,
       count(e.id)::int AS lines,
       count(e.id) FILTER (WHERE EXISTS (SELECT 1 FROM production_generations g WHERE g.element_id = e.id AND g.review = 'approved' AND g.status = 'ready'))::int AS approved,
       count(e.id) FILTER (WHERE EXISTS (SELECT 1 FROM production_generations g WHERE g.element_id = e.id AND g.review = 'pending' AND g.status = 'ready'))::int AS review
     FROM production_scenes s LEFT JOIN production_scene_elements e ON e.scene_id = s.id AND e.kind = 'dialogue'
     WHERE s.project_id = $1 AND s.in_latest GROUP BY s.id ORDER BY s.order_index`, [projectId]
  )).rows;
  return { scenes: rows.filter((r) => r.lines > 0).map((r) => ({ code: r.code, dbId: r.id, number: r.scene_number, heading: r.heading, lines: r.lines, approved: r.approved, review: r.review })) };
}

export async function audioLines(db, projectId, sceneDbId) {
  const status = await promptStatus(db, projectId);
  const hashFor = new Map(status.specs.map((s) => [keyOf(s.purpose, s.assetId, s.shotId, s.elementId), s.sourceHash]));
  const current = new Map(status.current.map((p) => [keyOf(p.purpose, p.asset_id, p.shot_id, p.element_id), p]));
  const lines = (await db.query("SELECT * FROM production_scene_elements WHERE project_id = $1 AND scene_id = $2 AND kind = 'dialogue' ORDER BY order_index", [projectId, sceneDbId])).rows;
  if (lines.length === 0) return { lines: [], counts: { lines: 0, approved: 0, review: 0, estimateUsd: 0 } };
  const ids = lines.map((l) => l.id);
  const gens = await loadGenerations(db, projectId, ["audio"], "AND g.element_id = ANY($3)", [ids]);
  const shotOf = new Map((await db.query(
    `SELECT sd.element_id, s.id AS shot_db_id, s.code, sc.code AS scene_code, s.duration_sec, s.framing FROM production_shot_dialogue sd JOIN production_shots s ON s.id = sd.shot_id JOIN production_scenes sc ON sc.id = s.scene_id WHERE sd.element_id = ANY($1)`, [ids]
  )).rows.map((r) => [r.element_id, r]));
  const clips = new Map((await db.query(
    `SELECT c.element_id, c.start_ms, c.duration_ms, sc.start_ms AS shot_start, sc.duration_ms AS shot_duration FROM production_timeline_clips c
     LEFT JOIN production_timeline_clips sc ON sc.timeline_id = c.timeline_id AND sc.kind = 'shot' AND sc.shot_id = c.shot_id
     WHERE c.element_id = ANY($1) AND c.kind = 'dialogue'`, [ids]
  )).rows.map((r) => [r.element_id, r]));
  const out = lines.map((l) => {
    const list = gens.filter((g) => g.element_id === l.id);
    const canonical = list.find((g) => g.review === "approved" && g.status === "ready") ?? null;
    const prompt = promptFor(status, hashFor, current, "audio", null, null, l.id);
    const latest = list[0];
    const latestReady = latest && latest.status === "ready" && latest.review === "pending" ? latest : null;
    const shot = shotOf.get(l.id) ?? null;
    const clip = clips.get(l.id) ?? null;
    const shotMs = clip?.shot_duration ?? (shot ? Math.round(Number(shot.duration_sec) * 1000) : null);
    const offsetMs = clip && clip.shot_start !== null && clip.shot_start !== undefined ? clip.start_ms - clip.shot_start : 0;
    const audioMs = canonical?.duration_ms ?? null;
    const overflow = audioMs !== null && shotMs !== null && offsetMs + audioMs > shotMs;
    const closeUp = shot && /close/i.test(shot.framing ?? "");
    return {
      lineId: l.code, dbId: l.id, speaker: l.speaker, extension: l.extension, text: l.text_en || l.text_hi || "", parenthetical: l.parenthetical,
      shotId: shot ? `${shot.scene_code}_${shot.code}` : null, shotDbId: shot?.shot_db_id ?? null,
      voice: prompt?.params?.voice ?? null, prompt, state: canonical ? "approved" : latestReady ? "ready_for_review" : list.some((g) => g.status === "running") ? "generating" : list[0]?.status === "failed" ? "failed" : "planned",
      canonical: canonical && { ...versionView(canonical, prompt?.id ?? null), durationMs: canonical.duration_ms },
      latestReady: latestReady && { ...versionView(latestReady, prompt?.id ?? null), durationMs: latestReady.duration_ms },
      history: list.filter((g) => g !== canonical && g !== latestReady).map((g) => ({ ...versionView(g, prompt?.id ?? null), durationMs: g.duration_ms })),
      running: list.some((g) => g.status === "running"), versions: list.length, stale: Boolean(prompt?.stale),
      timing: { shotMs, offsetMs, audioMs, plannedMs: clip?.duration_ms ?? null, fits: !overflow, overflowMs: overflow ? offsetMs + audioMs - shotMs : 0 },
      // The video model does not lip-sync: the voice is laid over the picture. Say so where the speaker's face is likely on screen.
      lipSync: closeUp ? "This shot is a close-up. Generated video is not lip-synced to the voice — check the timing before you approve." : null,
      estimateUsd: estimateCost("audio", { chars: (l.text_en || l.text_hi || "").length }),
    };
  });
  const open = out.filter((x) => x.state !== "approved" && !x.running);
  return { lines: out, counts: { lines: out.length, approved: out.filter((x) => x.state === "approved").length, review: out.filter((x) => x.latestReady).length, estimateUsd: Math.round(open.filter((x) => !x.latestReady).reduce((n, x) => n + x.estimateUsd, 0) * 100) / 100, overflowing: out.filter((x) => !x.timing.fits).length } };
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
  app.get("/api/production/:projectId/studio/video/scenes", admin, wrap(async (req, res) => res.json(await videoScenes(db, await project(req)))));
  app.get("/api/production/:projectId/studio/video", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    const sceneId = id(req.query.sceneId);
    if (!sceneId) throw httpError("Choose a scene (sceneId).", 400);
    res.json(await videoSlots(db, projectId, sceneId));
  }));
  app.get("/api/production/:projectId/studio/audio/scenes", admin, wrap(async (req, res) => res.json(await audioScenes(db, await project(req)))));
  app.get("/api/production/:projectId/studio/audio", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    const sceneId = id(req.query.sceneId);
    if (!sceneId) throw httpError("Choose a scene (sceneId).", 400);
    res.json(await audioLines(db, projectId, sceneId));
  }));
  app.get("/api/production/:projectId/studio/frames", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    const sceneId = id(req.query.sceneId);
    if (!sceneId) throw httpError("Choose a scene (sceneId).", 400);
    res.json(await frameSlots(db, projectId, sceneId));
  }));
}
