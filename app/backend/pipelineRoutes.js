// All the web routes for pipeline steps 2-8 (admin only): shots, text storyboard,
// settings and money limit, AI generation, review, and export.

import { addShot, approveShots, approveStoryboard, deleteShot, divideScene, generateStoryboard, listShots, mergeShotWithNext, splitShot, updateShot } from "./shots.js";
import { getSettings, saveSettings, spendSummary, VOICES } from "./pipelineSettings.js";
import { createGenerationService, KINDS } from "./generations.js";
import { createAssembler } from "./assemble.js";

export function registerPipelineRoutes(app, db, requireRole, { store, providers }) {
  const gens = createGenerationService({ db, store, providers });
  const assembler = createAssembler({ db, store, listShots, listGenerations: (projectId, filter) => gens.list(projectId, filter) });
  const id = (value) => (/^\d+$/.test(String(value)) && Number(value) > 0 ? Number(value) : null);
  const admin = requireRole("admin");

  // Turns thrown errors (with a status) into plain JSON answers.
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error("Pipeline route failed:", error);
      res.status(status).json({ error: status >= 500 && !error.status ? "Something went wrong on the server." : error.message, code: error.code ?? null });
    }
  };
  const need = (value, what) => {
    if (!value) throw Object.assign(new Error(`Not a valid ${what}.`), { status: 400 });
    return value;
  };
  const projectExists = async (projectId) => {
    if ((await db.query("SELECT 1 FROM ai_movie_projects WHERE id = $1", [projectId])).rowCount === 0) throw Object.assign(new Error("Project not found."), { status: 404 });
  };
  const textJson = providers.textJson;

  // ---- settings & money ----
  app.get("/api/production/:projectId/pipeline", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    await projectExists(projectId);
    res.json({
      status: await gens.status(projectId), settings: await getSettings(db, projectId), spend: await spendSummary(db, projectId), voices: VOICES,
      providers: { image: providers.models.image, speech: providers.models.speech, video: providers.models.video, textAvailable: Boolean(textJson) },
    });
  }));

  app.patch("/api/production/:projectId/settings", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    await projectExists(projectId);
    res.json({ settings: await saveSettings(db, projectId, req.body ?? {}), spend: await spendSummary(db, projectId) });
  }));

  // ---- step 2: shots ----
  app.get("/api/production/:projectId/shots", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    res.json({ shots: await listShots(db, projectId, { sceneId: id(req.query.sceneId) }) });
  }));

  app.post("/api/production/:projectId/scenes/:sceneId/divide", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    const sceneId = need(id(req.params.sceneId), "scene");
    const mode = ["auto", "script", "ai", "rules"].includes(req.body?.mode) ? req.body.mode : "auto";
    const result = await divideScene(db, projectId, sceneId, { mode, replace: req.body?.replace === true, textJson, actorUserId: req.user?.id });
    if (result.outcome === "not_found") return res.status(404).json({ error: "Scene not found." });
    if (result.outcome === "exists") return res.status(409).json({ error: `This scene already has ${result.count} shots. Choose "Cut again" to replace them.`, code: "exists" });
    res.json({ ...result, shots: await listShots(db, projectId, { sceneId }) });
  }));

  app.patch("/api/production/:projectId/shots/:shotId", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    const shotId = need(id(req.params.shotId), "shot");
    res.json({ shot: await updateShot(db, projectId, shotId, { expectedRevision: req.body?.expectedRevision, edits: req.body?.edits ?? {} }) });
  }));

  app.post("/api/production/:projectId/scenes/:sceneId/shots", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    const sceneId = need(id(req.params.sceneId), "scene");
    res.status(201).json({ shot: await addShot(db, projectId, sceneId, { afterShotId: id(req.body?.afterShotId), description: req.body?.description, framing: req.body?.framing }) });
  }));

  app.delete("/api/production/:projectId/shots/:shotId", admin, wrap(async (req, res) => {
    res.json(await deleteShot(db, need(id(req.params.projectId), "project"), need(id(req.params.shotId), "shot")));
  }));
  app.post("/api/production/:projectId/shots/:shotId/split", admin, wrap(async (req, res) => {
    res.json({ shots: await splitShot(db, need(id(req.params.projectId), "project"), need(id(req.params.shotId), "shot")) });
  }));
  app.post("/api/production/:projectId/shots/:shotId/merge-next", admin, wrap(async (req, res) => {
    res.json({ shot: await mergeShotWithNext(db, need(id(req.params.projectId), "project"), need(id(req.params.shotId), "shot")) });
  }));

  app.post("/api/production/:projectId/scenes/:sceneId/shots/approve", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    const sceneId = need(id(req.params.sceneId), "scene");
    const result = await approveShots(db, projectId, sceneId, { approved: req.body?.approved !== false });
    res.json({ ...result, shots: await listShots(db, projectId, { sceneId }) });
  }));

  // ---- step 3: text storyboard ----
  app.post("/api/production/:projectId/scenes/:sceneId/storyboard", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    const sceneId = need(id(req.params.sceneId), "scene");
    const result = await generateStoryboard(db, projectId, sceneId, { textJson, overwrite: req.body?.overwrite === true });
    res.json({ ...result, shots: await listShots(db, projectId, { sceneId }) });
  }));
  app.post("/api/production/:projectId/scenes/:sceneId/storyboard/approve", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    const sceneId = need(id(req.params.sceneId), "scene");
    const result = await approveStoryboard(db, projectId, sceneId, { approved: req.body?.approved !== false });
    res.json({ ...result, shots: await listShots(db, projectId, { sceneId }) });
  }));

  // ---- steps 4-7: making things ----
  // body: { kind, targetIds: [...], allowMissing?, note?, durationSec? }
  //   character|prop|environment -> targetIds are dossier item ids
  //   keyframe|video             -> targetIds are shot ids
  //   audio                      -> targetIds are dialogue line ids
  app.post("/api/production/:projectId/generate", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    await projectExists(projectId);
    const { kind, targetIds } = req.body ?? {};
    if (!KINDS.includes(kind)) throw Object.assign(new Error(`kind must be one of ${KINDS.join(", ")}.`), { status: 400 });
    const ids = (Array.isArray(targetIds) ? targetIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0 || ids.length > 100) throw Object.assign(new Error("Choose between 1 and 100 things to make."), { status: 400 });
    const started = [];
    const skipped = [];
    const actorUserId = req.user?.id;
    for (const target of ids) {
      try {
        let job;
        if (["character", "prop", "environment"].includes(kind)) job = await gens.generateReference(projectId, target, { actorUserId, note: req.body?.note });
        else if (kind === "audio") job = await gens.generateVoice(projectId, target, { actorUserId });
        else {
          const shot = (await listShots(db, projectId)).find((s) => s.id === target);
          if (!shot) throw Object.assign(new Error("Shot not found."), { status: 404 });
          job = kind === "keyframe"
            ? await gens.generateKeyframe(projectId, shot, { actorUserId, allowMissing: req.body?.allowMissing === true })
            : await gens.generateTake(projectId, shot, { actorUserId, durationSec: req.body?.durationSec });
        }
        started.push(job.row.id);
      } catch (error) {
        if (!error.status) throw error;
        // one blocked item must not hide the others; but if the money limit is hit, stop here
        skipped.push({ targetId: target, reason: error.message, code: error.code ?? null });
        if (error.code === "over_budget") break;
      }
    }
    if (started.length === 0 && skipped.length > 0) {
      const first = skipped[0];
      return res.status(first.code === "over_budget" ? 402 : 409).json({ error: first.reason, code: first.code, skipped });
    }
    res.status(202).json({ started, skipped });
  }));

  app.get("/api/production/:projectId/generations", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
    res.json({
      generations: await gens.list(projectId, { kind, assetId: id(req.query.assetId), shotId: id(req.query.shotId), elementId: id(req.query.elementId), sceneId: id(req.query.sceneId) }),
    });
  }));

  app.post("/api/production/:projectId/generations/:genId/review", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    const genId = need(id(req.params.genId), "result");
    res.json({ generation: await gens.review(projectId, genId, { decision: req.body?.decision, note: req.body?.note ?? "" }) });
  }));

  // ---- step 8: assemble & export ----
  app.get("/api/production/:projectId/export/plan", admin, wrap(async (req, res) => {
    res.json(await assembler.plan(need(id(req.params.projectId), "project"), id(req.query.sceneId)));
  }));
  app.post("/api/production/:projectId/export", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    const { row } = await assembler.start(projectId, { sceneId: id(req.body?.sceneId), actorUserId: req.user?.id });
    res.status(202).json({ export: { id: row.id, status: row.status } });
  }));
  app.get("/api/production/:projectId/exports", admin, wrap(async (req, res) => {
    res.json({ exports: await assembler.list(need(id(req.params.projectId), "project")) });
  }));

  return { gens, assembler };
}
