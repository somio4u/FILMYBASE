// Pipeline steps 4-7: the AI "makers" and the review of what they make.
//
//   4  reference pictures: characters first, then props, then environments
//   5  one picture (keyframe) per shot, drawn from the APPROVED references
//   6  voice for every dialogue line
//   7  video takes from the approved shot picture; one take is chosen per shot
//
// Everything made is one row in production_generations: what was asked (the
// prompt), what came back (a stored file), what it cost, and its review state
// (pending / approved / rejected). Only ONE result per target can be approved
// at a time (enforced by the database), and every file goes to the project's
// Drive folder through the media store.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { effectiveDetails } from "./production.js";
import { assertWithinBudget, getSettings, priceTable, recordSpend, VOICES } from "./pipelineSettings.js";

const httpError = (message, status = 400, code = "bad_request") => Object.assign(new Error(message), { status, code });

export const KINDS = ["character", "prop", "environment", "keyframe", "audio", "video"];
const VEO_SECONDS = [4, 6, 8];

export async function ensureGenerationSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS production_generations (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('character','prop','environment','keyframe','audio','video')),
      asset_id INTEGER REFERENCES production_assets(id) ON DELETE CASCADE,
      shot_id INTEGER REFERENCES production_shots(id) ON DELETE CASCADE,
      element_id INTEGER REFERENCES production_scene_elements(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ready','failed')),
      review TEXT NOT NULL DEFAULT 'pending' CHECK (review IN ('pending','approved','rejected')),
      review_note TEXT,
      prompt TEXT NOT NULL,
      params JSONB NOT NULL DEFAULT '{}',
      media_id INTEGER REFERENCES production_media_files(id) ON DELETE SET NULL,
      provider TEXT,
      model TEXT,
      cost_usd NUMERIC NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      error TEXT,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS production_generations_project_idx ON production_generations (project_id, kind)`,
    // One approved result per target (a character, a shot, a spoken line).
    `CREATE UNIQUE INDEX IF NOT EXISTS production_generations_one_approved ON production_generations
       (kind, COALESCE(asset_id, 0), COALESCE(shot_id, 0), COALESCE(element_id, 0)) WHERE review = 'approved'`,
  ];
  for (const sql of statements) await db.query(sql);
}

// Anything still "running" when the server starts was cut off by a restart.
export async function failStaleGenerations(db) {
  await db.query("UPDATE production_generations SET status = 'failed', error = 'The server restarted while this was being made. Press Make again.', finished_at = now() WHERE status = 'running'");
}

// ---------------------------------------------------------------------------
// Prompts (pure)
// ---------------------------------------------------------------------------

const SKIP_KEYS = new Set(["sceneRefs", "missing", "aliases", "notes", "confidence", "id", "code", "name"]);

export function describeDetails(details, max = 1500) {
  const lines = [];
  for (const [key, value] of Object.entries(details ?? {})) {
    if (SKIP_KEYS.has(key) || value === null || value === undefined || value === "") continue;
    let text;
    if (typeof value === "string") text = value;
    else if (typeof value === "number") text = String(value);
    else if (Array.isArray(value)) {
      text = value.map((v) => (typeof v === "string" ? v : v && typeof v === "object" ? Object.values(v).filter((x) => typeof x === "string").join(" - ") : "")).filter(Boolean).join("; ");
    } else continue;
    if (text.trim()) lines.push(`${key.replace(/([A-Z])/g, " $1").toLowerCase()}: ${text.trim()}`);
  }
  return lines.join(". ").slice(0, max);
}

const NO_TEXT = "No text, letters, captions, logos or watermarks anywhere in the picture.";

const SHEET_LAYOUT = "Make ONE single image laid out as a clean professional model sheet on a plain light-grey background, with every view clearly separated and labelled only by position (no written text).";

// One sheet per item holding every view a later shot picture could need, so
// each shot can be drawn from it and the item always looks the same.
export function assetPrompt(asset, style) {
  const details = describeDetails(effectiveDetails(asset));
  const look = style ? ` Overall look of the film: ${style}.` : "";
  if (asset.kind === "character") {
    return `Character model sheet for "${asset.name}" for a film. ${details}.${look} ${SHEET_LAYOUT} Include: a frontal close-up of the face; a side profile of the face; a three-quarter view; a full-body long shot from the front, one from the side and one from the back; and a row of facial expressions (neutral, happy, angry, sad, afraid, surprised). Same person, same face, same clothes, hair, build and age in every view. Realistic proportions. ${NO_TEXT}`;
  }
  if (asset.kind === "location") {
    return `Environment model sheet for the place "${asset.name}" for a film. ${details}.${look} ${SHEET_LAYOUT} Include: a wide establishing view of the whole space; views from two or three other camera positions; a close view of the most important detail or furniture; and the same space in its typical lighting (and a second lighting mood if the details mention one). Same architecture, layout, colours and objects in every view. No people. ${NO_TEXT}`;
  }
  return `Prop model sheet for the object "${asset.name}" for a film. ${details}.${look} ${SHEET_LAYOUT} Include: a front view, a side view, a back view, a top view, a three-quarter hero view, a close-up of its most important detail or texture, and a small view of it being held or placed in a normal setting to show its size. Same object, material, colour and wear in every view. ${NO_TEXT}`;
}

export function keyframePrompt(shot, style, refNames) {
  const camera = [shot.framing, shot.cameraAngle, shot.cameraMove && shot.cameraMove !== "Static" ? `(camera: ${shot.cameraMove})` : null].filter(Boolean).join(", ");
  const refs = refNames.length ? ` The attached pictures are model sheets (several views of each item). Use them to keep the exact same face, clothes, object design and place layout for: ${refNames.join(", ")}. Draw ONLY the single requested frame, never a sheet, and do not copy the sheet layout.` : "";
  return `A single film frame (keyframe). Camera: ${camera || "natural framing"}. ${shot.storyboardText || shot.description}${style ? ` Overall look of the film: ${style}.` : ""}${refs} Cinematic, natural film lighting, photographic detail. ${NO_TEXT}`;
}

export function videoPrompt(shot, style) {
  const move = shot.cameraMove && shot.cameraMove !== "Static" ? ` Camera movement: ${shot.cameraMove}.` : " The camera is steady.";
  return `${shot.storyboardText || shot.description}${move}${style ? ` Overall look: ${style}.` : ""} Start exactly from the given picture and keep the people, objects and place looking the same. Natural, believable motion. No speech, no subtitles, no on-screen text.`;
}

export function speechText(element) {
  const text = (element.text_en || element.text_hi || "").trim();
  const how = element.parenthetical ? `Say ${element.parenthetical.replace(/[()]/g, "")}: ` : "";
  return `${how}${text}`;
}

const kindForAsset = (assetKind) => (assetKind === "character" ? "character" : assetKind === "location" ? "environment" : "prop");

export function estimateCost(kind, { chars = 0, seconds = 0 } = {}, prices = priceTable()) {
  const raw = kind === "audio" ? Math.max(0.001, (chars / 1000) * prices.audioPerThousandChars) : kind === "video" ? seconds * prices.videoPerSecond : prices.image;
  return Math.round(raw * 10000) / 10000;
}

function pickVeoSeconds(durationSec) {
  return VEO_SECONDS.find((s) => s >= Math.round(Number(durationSec) || 4)) ?? VEO_SECONDS[VEO_SECONDS.length - 1];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createGenerationService({ db, store, providers, env = process.env, concurrency = Number(env.PIPELINE_CONCURRENCY || 2), videoPollMs = 10000 }) {
  const waiting = [];
  let active = 0;
  function enqueue(job) {
    return new Promise((resolve) => {
      waiting.push({ job, resolve });
      pump();
    });
  }
  function pump() {
    while (active < concurrency && waiting.length > 0) {
      const { job, resolve } = waiting.shift();
      active++;
      job().catch(() => {}).finally(() => { active--; resolve(); pump(); });
    }
  }

  const tmpDir = path.join(os.tmpdir(), "filmybase-generations");
  fs.mkdirSync(tmpDir, { recursive: true });

  async function readMediaBuffer(mediaId) {
    const opened = await store.openMedia(mediaId);
    if (!opened || opened.unavailable) throw httpError("A reference picture could not be read from storage right now.", 502, "storage");
    const parts = [];
    for await (const chunk of opened.stream) parts.push(chunk);
    return { bytes: Buffer.concat(parts), mime: opened.row.mime };
  }

  async function approvedRef(assetId) {
    return (await db.query("SELECT * FROM production_generations WHERE asset_id = $1 AND review = 'approved' AND status = 'ready' AND kind IN ('character','prop','environment')", [assetId])).rows[0] ?? null;
  }

  async function inflightEstimate(projectId) {
    return Number((await db.query("SELECT COALESCE(sum(cost_usd),0) AS n FROM production_generations WHERE project_id = $1 AND status = 'running'", [projectId])).rows[0].n);
  }

  async function nextVersion(where, params) {
    return Number((await db.query(`SELECT COALESCE(MAX(version),0) + 1 AS n FROM production_generations WHERE ${where}`, params)).rows[0].n);
  }

  async function alreadyRunning(where, params) {
    return (await db.query(`SELECT 1 FROM production_generations WHERE status = 'running' AND ${where}`, params)).rowCount > 0;
  }

  // Inserts the row, checks the money limit, and starts the work in the background.
  // Returns { row, done } — `done` resolves when the work has finished (tests wait on it).
  async function start({ projectId, kind, assetId = null, shotId = null, elementId = null, prompt, params, estimate, actorUserId, run, label, subfolder, role, ext }) {
    const targetWhere = "kind = $1 AND COALESCE(asset_id,0) = $2 AND COALESCE(shot_id,0) = $3 AND COALESCE(element_id,0) = $4";
    const targetParams = [kind, assetId ?? 0, shotId ?? 0, elementId ?? 0];
    if (await alreadyRunning(targetWhere, targetParams)) throw httpError("This is already being made. Wait for it to finish first.", 409, "already_running");
    await assertWithinBudget(db, projectId, estimate + (await inflightEstimate(projectId)));
    const version = await nextVersion(targetWhere, targetParams);
    const providerName = "gemini";
    const model = kind === "audio" ? providers.models.speech : kind === "video" ? providers.models.video : providers.models.image;
    const row = (await db.query(
        `INSERT INTO production_generations (project_id, kind, asset_id, shot_id, element_id, version, prompt, params, provider, model, cost_usd, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [projectId, kind, assetId, shotId, elementId, version, prompt, JSON.stringify(params ?? {}), providerName, model, estimate, actorUserId ?? null]
      )).rows[0];
    const done = enqueue(async () => {
      const started = Date.now();
      let tmpFile = null;
      try {
        const made = await run();
        tmpFile = path.join(tmpDir, `${row.id}-${Date.now()}${made.ext ?? ext}`);
        await fs.promises.writeFile(tmpFile, made.bytes);
        const media = await store.putMedia({
          projectId, role, filePath: tmpFile, originalName: `${label}${made.ext ?? ext}`, label, subfolder, createdBy: actorUserId ?? null,
          dimensions: made.durationMs ? { durationMs: made.durationMs } : {},
        });
        await db.query(
          "UPDATE production_generations SET status = 'ready', media_id = $1, duration_ms = $2, finished_at = now() WHERE id = $3",
          [media.id, made.durationMs ?? Date.now() - started, row.id]
        );
        await recordSpend(db, projectId, { kind, provider: providerName, units: params?.seconds ?? params?.chars ?? 1, costUsd: estimate, ref: `generation ${row.id}` });
      } catch (error) {
        await db.query("UPDATE production_generations SET status = 'failed', error = $1, finished_at = now() WHERE id = $2", [String(error.message ?? error).slice(0, 800), row.id]);
      } finally {
        if (tmpFile) fs.promises.rm(tmpFile, { force: true }).catch(() => {});
      }
    });
    return { row, done };
  }

  const service = {
    // ---- step 4: reference pictures ----
    async generateReference(projectId, assetId, { actorUserId = null, note = "" } = {}) {
      const asset = (await db.query("SELECT * FROM production_assets WHERE id = $1 AND project_id = $2", [assetId, projectId])).rows[0];
      if (!asset) throw httpError("Item not found.", 404, "not_found");
      const settings = await getSettings(db, projectId);
      const kind = kindForAsset(asset.kind);
      const prompt = `${assetPrompt(asset, settings.stylePrompt)}${note ? ` Extra direction: ${String(note).slice(0, 500)}` : ""}`;
      const aspect = "16:9"; // model sheets are wide so every view fits
      const version = await nextVersion("asset_id = $1", [assetId]);
      return start({
        projectId, kind, assetId, prompt, params: { aspectRatio: aspect }, estimate: estimateCost(kind), actorUserId,
        label: `${asset.code}_v${version}`, subfolder: `${asset.code} ${asset.name}`, role: kind, ext: ".png",
        run: () => providers.generateImage({ prompt, aspectRatio: aspect }),
      });
    },

    // ---- step 5: a picture per shot, from the approved references ----
    async checkKeyframeReady(projectId, shot) {
      if (shot.storyboardStatus !== "approved") return { ok: false, reason: `Approve the text storyboard for scene ${shot.sceneNumber} first (shot ${shot.code}).`, missing: [] };
      const needed = shot.assets.filter((a) => ["character", "location", "prop"].includes(a.kind));
      const missing = [];
      const refs = [];
      for (const a of needed) {
        const ref = await approvedRef(a.id);
        if (ref?.media_id) refs.push({ asset: a, generation: ref });
        else missing.push(a);
      }
      return { ok: missing.length === 0, missing, refs, reason: missing.length ? `These need an approved reference picture first: ${missing.map((m) => `${m.code} ${m.name}`).join(", ")}.` : null };
    },

    async generateKeyframe(projectId, shot, { actorUserId = null, allowMissing = false } = {}) {
      const settings = await getSettings(db, projectId);
      const ready = await this.checkKeyframeReady(projectId, shot);
      if (!ready.ok && (!allowMissing || shot.storyboardStatus !== "approved")) throw httpError(ready.reason, 409, "not_ready");
      // characters first, then the place, then objects; the AI takes at most 4
      const order = { character: 0, location: 1, prop: 2 };
      const chosen = [...ready.refs].sort((a, b) => order[a.asset.kind] - order[b.asset.kind]).slice(0, 4);
      const prompt = keyframePrompt(shot, settings.stylePrompt, chosen.map((c) => c.asset.name));
      const version = await nextVersion("shot_id = $1 AND kind = 'keyframe'", [shot.id]);
      return start({
        projectId, kind: "keyframe", shotId: shot.id, prompt, params: { aspectRatio: settings.aspectRatio, refs: chosen.map((c) => c.generation.id) }, estimate: estimateCost("keyframe"), actorUserId,
        label: `${shot.code}_v${version}`, subfolder: `${shot.sceneCode}`, role: "keyframe", ext: ".png",
        run: async () => {
          const references = [];
          for (const c of chosen) references.push(await readMediaBuffer(c.generation.media_id));
          return providers.generateImage({ prompt, references, aspectRatio: settings.aspectRatio });
        },
      });
    },

    // ---- step 6: voices ----
    async voiceFor(projectId, speaker) {
      const settings = await getSettings(db, projectId);
      const key = String(speaker ?? "").trim();
      if (settings.voices[key]) return settings.voices[key];
      const speakers = (await db.query("SELECT DISTINCT speaker FROM production_scene_elements WHERE project_id = $1 AND kind = 'dialogue' AND speaker IS NOT NULL ORDER BY speaker", [projectId])).rows.map((r) => r.speaker);
      const index = Math.max(0, speakers.indexOf(key));
      return VOICES[index % VOICES.length];
    },

    async generateVoice(projectId, elementId, { actorUserId = null } = {}) {
      const element = (await db.query(
        `SELECT e.*, s.code AS scene_code FROM production_scene_elements e JOIN production_scenes s ON s.id = e.scene_id WHERE e.id = $1 AND e.project_id = $2 AND e.kind = 'dialogue'`, [elementId, projectId]
      )).rows[0];
      if (!element) throw httpError("Dialogue line not found.", 404, "not_found");
      const text = speechText(element);
      if (!text.trim()) throw httpError("This line has no words to speak.");
      const voice = await this.voiceFor(projectId, element.speaker);
      const version = await nextVersion("element_id = $1", [elementId]);
      return start({
        projectId, kind: "audio", elementId, prompt: text, params: { voice, chars: text.length, speaker: element.speaker }, estimate: estimateCost("audio", { chars: text.length }), actorUserId,
        label: `${element.code}_${String(element.speaker ?? "voice").slice(0, 20)}_v${version}`, subfolder: element.scene_code, role: "audio", ext: ".wav",
        run: () => providers.generateSpeech({ text, voice }),
      });
    },

    // ---- step 7: video takes ----
    async generateTake(projectId, shot, { actorUserId = null, durationSec = null } = {}) {
      const keyframe = (await db.query("SELECT * FROM production_generations WHERE shot_id = $1 AND kind = 'keyframe' AND review = 'approved' AND status = 'ready'", [shot.id])).rows[0];
      if (!keyframe?.media_id) throw httpError(`Shot ${shot.code} needs an approved picture first. Approve one of its pictures, then make video.`, 409, "not_ready");
      const settings = await getSettings(db, projectId);
      const seconds = durationSec ? pickVeoSeconds(durationSec) : pickVeoSeconds(shot.durationSec);
      const prompt = videoPrompt(shot, settings.stylePrompt);
      const version = await nextVersion("shot_id = $1 AND kind = 'video'", [shot.id]);
      return start({
        projectId, kind: "video", shotId: shot.id, prompt, params: { seconds, fromGeneration: keyframe.id, aspectRatio: settings.aspectRatio }, estimate: estimateCost("video", { seconds }), actorUserId,
        label: `${shot.code}_take${version}`, subfolder: shot.sceneCode, role: "video_take", ext: ".mp4",
        run: async () => {
          const image = await readMediaBuffer(keyframe.media_id);
          return providers.generateVideo({ prompt, image, durationSec: seconds, aspectRatio: settings.aspectRatio, pollMs: videoPollMs });
        },
      });
    },

    // ---- review ----
    async review(projectId, generationId, { decision, note = "" }) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const row = (await client.query("SELECT * FROM production_generations WHERE id = $1 AND project_id = $2 FOR UPDATE", [generationId, projectId])).rows[0];
        if (!row) throw httpError("Result not found.", 404, "not_found");
        if (!["approve", "reject", "reset"].includes(decision)) throw httpError("Decision must be approve, reject or reset.");
        if (decision === "approve") {
          if (row.status !== "ready") throw httpError("Only a finished result can be approved.", 409, "not_ready");
          await client.query(
            `UPDATE production_generations SET review = 'pending' WHERE review = 'approved' AND id <> $1 AND kind = $2
             AND COALESCE(asset_id,0) = $3 AND COALESCE(shot_id,0) = $4 AND COALESCE(element_id,0) = $5`,
            [row.id, row.kind, row.asset_id ?? 0, row.shot_id ?? 0, row.element_id ?? 0]
          );
        }
        await client.query("UPDATE production_generations SET review = $1, review_note = $2 WHERE id = $3", [decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "pending", String(note).slice(0, 500) || null, row.id]);
        await client.query("COMMIT");
        return (await service.list(projectId, { id: generationId }))[0];
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async list(projectId, { id = null, kind = null, assetId = null, shotId = null, elementId = null, sceneId = null } = {}) {
      const where = ["g.project_id = $1"];
      const params = [projectId];
      const add = (sql, v) => { params.push(v); where.push(sql.replaceAll("?", `$${params.length}`)); };
      if (id) add("g.id = ?", id);
      if (kind) add("g.kind = ?", kind);
      if (assetId) add("g.asset_id = ?", assetId);
      if (shotId) add("g.shot_id = ?", shotId);
      if (elementId) add("g.element_id = ?", elementId);
      if (sceneId) add("(g.shot_id IN (SELECT id FROM production_shots WHERE scene_id = ?) OR g.element_id IN (SELECT id FROM production_scene_elements WHERE scene_id = ?))", sceneId);
      const rows = (await db.query(
        `SELECT g.*, m.status AS media_status, m.mime FROM production_generations g LEFT JOIN production_media_files m ON m.id = g.media_id WHERE ${where.join(" AND ")} ORDER BY g.id DESC LIMIT 500`,
        params
      )).rows;
      const approved = new Set((await db.query("SELECT id FROM production_generations WHERE project_id = $1 AND review = 'approved' AND asset_id IS NOT NULL", [projectId])).rows.map((r) => r.id));
      return rows.map((g) => ({
        id: g.id, kind: g.kind, assetId: g.asset_id, shotId: g.shot_id, elementId: g.element_id, version: g.version, status: g.status, review: g.review, reviewNote: g.review_note,
        prompt: g.prompt, params: g.params, mediaId: g.media_id, mediaUrl: g.media_id ? `/api/production/media/${g.media_id}` : null, mime: g.mime ?? null, mediaStatus: g.media_status ?? null,
        costUsd: Number(g.cost_usd), durationMs: g.duration_ms, error: g.error, createdAt: g.created_at, finishedAt: g.finished_at,
        // a keyframe drawn from a reference picture that has since been replaced
        outdated: g.kind === "keyframe" && Array.isArray(g.params?.refs) && g.params.refs.some((r) => !approved.has(r)),
      }));
    },

    // How far the whole pipeline has got (for the progress strip).
    async status(projectId) {
      const q = async (sql) => (await db.query(sql, [projectId])).rows[0];
      const scenes = await q("SELECT count(*)::int AS n FROM production_scenes WHERE project_id = $1 AND in_latest");
      const shots = await q(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE s.storyboard_status = 'approved')::int AS approved, count(*) FILTER (WHERE s.storyboard_text <> '')::int AS written
         FROM production_shots s JOIN production_scenes sc ON sc.id = s.scene_id WHERE s.project_id = $1 AND sc.in_latest`
      );
      const assets = (await db.query(
        `SELECT a.kind, count(*)::int AS total,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM production_generations g WHERE g.asset_id = a.id AND g.review = 'approved'))::int AS approved
         FROM production_assets a WHERE a.project_id = $1 AND a.in_latest_import GROUP BY a.kind`, [projectId]
      )).rows;
      const per = (kind) => {
        const r = assets.find((x) => x.kind === kind);
        return { total: r?.total ?? 0, approved: r?.approved ?? 0 };
      };
      const approvedFor = async (kind, col) => Number((await db.query(`SELECT count(DISTINCT ${col})::int AS n FROM production_generations WHERE project_id = $1 AND kind = $2 AND review = 'approved'`, [projectId, kind])).rows[0].n);
      const dialogue = await q("SELECT count(*)::int AS n FROM production_scene_elements WHERE project_id = $1 AND kind = 'dialogue'");
      return {
        scenes: scenes.n,
        shots: { total: shots.n, storyboardWritten: shots.written, storyboardApproved: shots.approved },
        references: { characters: per("character"), props: per("prop"), environments: per("location") },
        keyframes: { approved: await approvedFor("keyframe", "shot_id"), of: shots.n },
        audio: { approved: await approvedFor("audio", "element_id"), of: dialogue.n },
        video: { approved: await approvedFor("video", "shot_id"), of: shots.n },
      };
    },
  };
  return service;
}
