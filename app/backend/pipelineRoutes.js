// All the web routes for pipeline steps 2-8 (admin only): shots, text storyboard,
// settings and money limit, AI generation, review, and export.

import { addShot, autoLinkShots, setShotLinks, shotLinkChoices, approveShots, approveStoryboard, deleteShot, divideScene, generateStoryboard, listShots, mergeShotWithNext, splitShot, updateShot } from "./shots.js";
import { getSettings, saveSettings, spendSummary, VOICES } from "./pipelineSettings.js";
import { createGenerationService, KINDS } from "./generations.js";
import { createAssembler } from "./assemble.js";
import { planPrompts } from "./planning.js";
import { writeFrameDescriptions, setFrameDescription } from "./frameDescriptions.js";
import { VISUAL_STYLES } from "./visualStyles.js";
import { combineProps, previewPropGroups, splitProps, DEFAULT_PROPS_PER_PICTURE } from "./propGroups.js";
import { priceTable } from "./pipelineSettings.js";
import { publish } from "./events.js";
import multer from "multer";
import { importPictures } from "./pictureImport.js";
import { foreignOrigin } from "./castRule.js";
import { REF_KINDS, detectReferenceNeeds, listReferenceImages, parseKeywords, slugName } from "./referenceImages.js";
import { imageKind } from "./pictureNames.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function registerPipelineRoutes(app, db, requireRole, { store, providers, cinematic = null, onShotsApproved = null }) {
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
      visualStyles: VISUAL_STYLES.map(({ id, label }) => ({ id, label })),
      providers: { image: providers.models.image, speech: providers.models.speech, video: providers.models.video, textAvailable: Boolean(textJson) },
    });
  }));

  app.patch("/api/production/:projectId/settings", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    await projectExists(projectId);
    const before = await getSettings(db, projectId);
    const settings = await saveSettings(db, projectId, req.body ?? {});
    // The visual style is written into every picture command, so a changed look refreshes all the commands (free: no AI call).
    let promptsRefreshed = false;
    if (settings.stylePrompt !== before.stylePrompt || settings.castOrigin !== before.castOrigin) {
      try { await planPrompts(db, projectId, { actorUserId: req.user?.id }); promptsRefreshed = true; } catch (error) { console.error("Prompts could not be refreshed after the style changed:", error.message); }
    }
    res.json({ settings, spend: await spendSummary(db, projectId), promptsRefreshed });
  }));

  // ---- pictures made OUTSIDE the app (see pictureNames.js / pictureImport.js) ----
  const pictureUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 300 } });
  app.post("/api/production/:projectId/import-pictures", admin, pictureUpload.array("files", 300), wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    await projectExists(projectId);
    if (!req.files?.length) throw Object.assign(new Error("Choose the pictures (or a .zip of them) first."), { status: 400 });
    const files = req.files.map((f) => ({ name: Buffer.from(f.originalname, "latin1").toString("utf8"), bytes: f.buffer }));
    res.json(await importPictures({ db, gens, projectId, files, actorUserId: req.user?.id, autoApprove: req.body?.autoApprove === "true" }));
  }));

  // The CAST RULE makes every character Indian unless the director says otherwise: this sets (or clears) a character's origin.
  app.put("/api/production/:projectId/assets/:assetId/origin", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    const assetId = need(id(req.params.assetId), "item");
    const asset = (await db.query("SELECT * FROM production_assets WHERE id = $1 AND project_id = $2", [assetId, projectId])).rows[0];
    if (!asset) throw Object.assign(new Error("Item not found."), { status: 404 });
    if (asset.kind !== "character") throw Object.assign(new Error("Only a character has an origin."), { status: 400 });
    const origin = String(req.body?.origin ?? "").trim().slice(0, 80);
    const edits = { ...(asset.human_edits ?? {}) };
    if (!origin || foreignOrigin({ origin }) === null) delete edits.origin; else edits.origin = origin; // Indian = the default: nothing to store
    await db.query("UPDATE production_assets SET human_edits = $1, revision = revision + 1, updated_at = now() WHERE id = $2", [JSON.stringify(edits), assetId]);
    try { await planPrompts(db, projectId, { actorUserId: req.user?.id }); } catch (error) { console.error("Prompts could not be refreshed after the origin changed:", error.message); }
    publish(projectId, { type: "assets_changed" });
    res.json({ origin: edits.origin ?? null });
  }));

  // ---- reference images: real logos, brands and titles (see referenceImages.js) ----
  const referenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  const labelsOf = (refs) => new Set(refs.map((r) => r.label.toLowerCase().trim()));

  app.get("/api/production/:projectId/references", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    await projectExists(projectId);
    const references = await listReferenceImages(db, projectId);
    const row = (await db.query("SELECT ref_suggestions, ref_checked_at FROM production_settings WHERE project_id = $1", [projectId])).rows[0];
    const have = labelsOf(references);
    res.json({ references, checked: Boolean(row?.ref_checked_at), suggestions: (row?.ref_suggestions ?? []).filter((x) => !have.has(String(x.name).toLowerCase().trim())) });
  }));

  app.post("/api/production/:projectId/references", admin, referenceUpload.single("file"), wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    await projectExists(projectId);
    const label = String(req.body?.label ?? "").trim().slice(0, 80);
    if (!label) throw Object.assign(new Error("Give the reference a name, for example “Tarang Plus logo”."), { status: 400 });
    if (!req.file) throw Object.assign(new Error("Choose the picture first (PNG, JPG or WebP)."), { status: 400 });
    const kindInfo = imageKind(req.file.buffer);
    if (!kindInfo) throw Object.assign(new Error("That file is not a picture (PNG, JPG or WebP)."), { status: 400 });
    const kind = REF_KINDS.includes(req.body?.kind) ? req.body.kind : "logo";
    const keywords = parseKeywords(req.body?.keywords);
    const next = Number((await db.query("SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::int), 0) + 1 AS n FROM production_reference_images WHERE project_id = $1", [projectId])).rows[0].n);
    const code = `REF${String(next).padStart(2, "0")}`;
    const tmp = path.join(os.tmpdir(), `ref-${Date.now()}-${Math.random().toString(36).slice(2)}${kindInfo.ext}`);
    await fs.promises.writeFile(tmp, req.file.buffer);
    let media;
    try {
      media = await store.putMedia({ projectId, role: "reference", filePath: tmp, originalName: `${code}_${slugName(label)}${kindInfo.ext}`, label: `${code} ${label}`, subfolder: "Reference images", createdBy: req.user?.id ?? null, dimensions: {} });
    } finally {
      fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
    await db.query("INSERT INTO production_reference_images (project_id, code, label, kind, keywords, media_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [projectId, code, label, kind, JSON.stringify(keywords), media.id, req.user?.id ?? null]);
    try { await planPrompts(db, projectId, { actorUserId: req.user?.id }); } catch (error) { console.error("Prompts could not be refreshed after a reference image was added:", error.message); }
    publish(projectId, { type: "assets_changed" });
    res.status(201).json({ references: await listReferenceImages(db, projectId) });
  }));

  app.delete("/api/production/:projectId/references/:refId", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    await projectExists(projectId);
    await db.query("DELETE FROM production_reference_images WHERE id = $1 AND project_id = $2", [need(id(req.params.refId), "reference"), projectId]);
    try { await planPrompts(db, projectId, { actorUserId: req.user?.id }); } catch (error) { console.error("Prompts could not be refreshed after a reference image was removed:", error.message); }
    publish(projectId, { type: "assets_changed" });
    res.json({ references: await listReferenceImages(db, projectId) });
  }));

  // Adu reads the screenplay and suggests the brands, logos and titles that need a real reference image.
  app.post("/api/production/:projectId/references/detect", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    await projectExists(projectId);
    if (!textJson) throw Object.assign(new Error("The text AI is not available right now."), { status: 503 });
    const lines = (await db.query(
      `SELECT sc.heading, e.kind, e.speaker, COALESCE(NULLIF(e.text_en, ''), e.text_hi, '') AS text
       FROM production_scene_elements e JOIN production_scenes sc ON sc.id = e.scene_id
       WHERE e.project_id = $1 AND sc.in_latest ORDER BY sc.order_index, e.order_index`, [projectId]
    )).rows;
    let screenplay = lines.map((l) => `${l.speaker ? `${l.speaker}: ` : ""}${l.text}`).join("\n");
    if (screenplay.length < 80) screenplay = (await db.query("SELECT pasted_text FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0]?.pasted_text ?? "";
    const references = await listReferenceImages(db, projectId);
    let items;
    try {
      items = await detectReferenceNeeds({ textJson, screenplay, have: references.map((r) => r.label) });
    } catch (error) {
      throw Object.assign(new Error(`Adu could not read the screenplay for brands right now (${String(error.message).slice(0, 120)}). You can still add a reference image yourself.`), { status: 502 });
    }
    await db.query(
      `INSERT INTO production_settings (project_id, ref_suggestions, ref_checked_at) VALUES ($1,$2,now())
       ON CONFLICT (project_id) DO UPDATE SET ref_suggestions = EXCLUDED.ref_suggestions, ref_checked_at = now()`, [projectId, JSON.stringify(items)]
    );
    res.json({ references, checked: true, suggestions: items });
  }));

  // ---- small props share one picture (propGroups.js) ----
  app.get("/api/production/:projectId/props/combine-preview", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    await projectExists(projectId);
    res.json(await previewPropGroups(db, projectId, Number(req.query.perImage) || DEFAULT_PROPS_PER_PICTURE, { pricePerPicture: priceTable().image }));
  }));
  app.post("/api/production/:projectId/props/combine", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    await projectExists(projectId);
    const result = await combineProps(db, projectId, { perImage: Number(req.body?.perImage) || DEFAULT_PROPS_PER_PICTURE });
    // the new sheets need their commands (free, no AI call)
    try { await planPrompts(db, projectId, { actorUserId: req.user?.id }); } catch (error) { console.error("Prompts could not be planned after combining props:", error.message); }
    publish(projectId, { type: "assets_changed" });
    res.json(result);
  }));
  app.post("/api/production/:projectId/props/split", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    await projectExists(projectId);
    const result = await splitProps(db, projectId);
    try { await planPrompts(db, projectId, { actorUserId: req.user?.id }); } catch (error) { console.error("Prompts could not be planned after splitting props:", error.message); }
    publish(projectId, { type: "assets_changed" });
    res.json(result);
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
    // AI Movie: approved cinematic directions for this scene, and Pro for complex action (see modelRouting.js), when wired in.
    const cut = (await cinematic?.shotCutterFor?.(projectId, sceneId)) ?? null;
    const result = await divideScene(db, projectId, sceneId, { mode, replace: req.body?.replace === true, textJson: cut?.textJson ?? textJson, extraPrompt: cut?.extraPrompt ?? "", actorUserId: req.user?.id });
    if (result.outcome === "not_found") return res.status(404).json({ error: "Scene not found." });
    if (result.outcome === "exists") return res.status(409).json({ error: `This scene already has ${result.count} shots. Choose "Cut again" to replace them.`, code: "exists" });
    res.json({ ...result, model: cut?.model ?? null, usedCinematicDirections: Boolean(cut?.extraPrompt), shots: await listShots(db, projectId, { sceneId }) });
  }));

  app.patch("/api/production/:projectId/shots/:shotId", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    const shotId = need(id(req.params.shotId), "shot");
    res.json({ shot: await updateShot(db, projectId, shotId, { expectedRevision: req.body?.expectedRevision, edits: req.body?.edits ?? {} }) });
  }));

  // linking shots to the made characters / places / props (does not touch the shot-division approval)
  app.post("/api/production/:projectId/shots/auto-link", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    await projectExists(projectId);
    const result = await autoLinkShots(db, projectId, { sceneId: id(req.body?.sceneId), shotId: id(req.body?.shotId), onlyUnlinked: req.body?.onlyUnlinked !== false });
    if (result.itemsAdded > 0) {
      try { await planPrompts(db, projectId, { actorUserId: req.user?.id }); } catch (error) { console.error("Prompts could not be refreshed after linking:", error.message); }
      publish(projectId, { type: "assets_changed" });
    }
    res.json(result);
  }));
  // the AI re-reads the screenplay and writes the complete first frame of each shot, then links the made characters / place / props it names
  app.post("/api/production/:projectId/shots/write-descriptions", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    await projectExists(projectId);
    // all: every scene that already has shots (no re-dividing), one scene after another; a scene that fails is reported, the rest go on
    if (req.body?.all === true) {
      const scenes = (await db.query("SELECT DISTINCT sc.id, sc.order_index FROM production_scenes sc JOIN production_shots s ON s.scene_id = sc.id WHERE sc.project_id = $1 AND sc.in_latest ORDER BY sc.order_index", [projectId])).rows;
      const total = { written: 0, linked: 0, unknown: [], countUnknown: [], skipped: 0, scenes: scenes.length, failedScenes: [] };
      for (const sc of scenes) {
        try {
          const r = await writeFrameDescriptions(db, projectId, { sceneId: sc.id, overwrite: req.body?.overwrite !== false, textJson, listShots });
          total.written += r.written; total.linked += r.linked; total.skipped += r.skipped; total.unknown.push(...r.unknown); total.countUnknown.push(...r.countUnknown);
        } catch (error) { total.failedScenes.push(`${sc.id}: ${error.message}`); }
      }
      if (total.written > 0) {
        try { await planPrompts(db, projectId, { actorUserId: req.user?.id }); } catch (error) { console.error("Prompts could not be refreshed after the descriptions:", error.message); }
        publish(projectId, { type: "assets_changed" });
      }
      return res.json(total);
    }
    const result = await writeFrameDescriptions(db, projectId, { sceneId: id(req.body?.sceneId), shotId: id(req.body?.shotId), overwrite: req.body?.overwrite !== false, textJson, listShots });
    if (result.written > 0) {
      try { await planPrompts(db, projectId, { actorUserId: req.user?.id }); } catch (error) { console.error("Prompts could not be refreshed after the descriptions:", error.message); }
      publish(projectId, { type: "assets_changed" });
    }
    res.json({ ...result, shots: result.written > 0 ? await listShots(db, projectId, { sceneId: id(req.body?.sceneId) }) : [] });
  }));
  app.put("/api/production/:projectId/shots/:shotId/frame-description", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    const result = await setFrameDescription(db, projectId, need(id(req.params.shotId), "shot"), req.body?.text);
    try { await planPrompts(db, projectId, { actorUserId: req.user?.id }); } catch (error) { console.error("Prompts could not be refreshed after the description:", error.message); }
    publish(projectId, { type: "assets_changed" });
    res.json(result);
  }));
  app.get("/api/production/:projectId/shots/:shotId/links", admin, wrap(async (req, res) => {
    res.json(await shotLinkChoices(db, need(id(req.params.projectId), "project"), need(id(req.params.shotId), "shot")));
  }));
  app.put("/api/production/:projectId/shots/:shotId/links", admin, wrap(async (req, res) => {
    const projectId = need(id(req.params.projectId), "project");
    const result = await setShotLinks(db, projectId, need(id(req.params.shotId), "shot"), req.body?.assetIds);
    try { await planPrompts(db, projectId, { actorUserId: req.user?.id }); } catch (error) { console.error("Prompts could not be refreshed after linking:", error.message); }
    publish(projectId, { type: "assets_changed" });
    res.json(result);
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
    // When the director has approved the LAST scene's shots, Adu carries on with the rest of the production plan.
    if (req.body?.approved !== false && onShotsApproved) {
      const all = await listShots(db, projectId);
      if (all.length > 0 && all.every((shot) => shot.shotStatus === "approved")) Promise.resolve(onShotsApproved(projectId, req)).catch((error) => console.error("Auto production could not continue after the shots were approved:", error.message));
    }
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
