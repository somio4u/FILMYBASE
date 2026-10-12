// Sound effects and music cues. Spoken lines come from the screenplay (Voice Maker, see generations.js); sound effects and
// music are planned here as CUES anchored to a shot: what it should sound like (the prompt), when inside the shot it starts
// and how long it lasts. There is NO sound-effect or music generator configured in Filmybase, so a cue's sound comes from a
// file you attach (wav / mp3 / m4a / ogg) and approve — the screen says so plainly. Approved cues sit on the Timeline's
// SFX and Music tracks; planned ones show as labelled blocks there.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publish } from "./events.js";
import { httpError } from "./blueprint.js";
import { syncCueClips } from "./timeline.js";

export const CUE_KINDS = ["sfx", "music"];
const AUDIO_EXT = new Set([".wav", ".mp3", ".m4a", ".ogg"]);

export async function ensureAudioCueSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS production_audio_cues (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('sfx','music')),
      shot_id INTEGER REFERENCES production_shots(id) ON DELETE SET NULL,
      label TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      offset_ms INTEGER NOT NULL DEFAULT 0 CHECK (offset_ms >= 0),
      duration_ms INTEGER NOT NULL DEFAULT 2000 CHECK (duration_ms BETWEEN 200 AND 600000),
      media_id INTEGER REFERENCES production_media_files(id) ON DELETE SET NULL,
      approved BOOLEAN NOT NULL DEFAULT FALSE,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS production_audio_cues_project_idx ON production_audio_cues (project_id, kind)`,
    `ALTER TABLE production_timeline_clips ADD COLUMN IF NOT EXISTS cue_id INTEGER REFERENCES production_audio_cues(id) ON DELETE SET NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS production_timeline_clip_cue ON production_timeline_clips (timeline_id, cue_id) WHERE cue_id IS NOT NULL`,
  ];
  for (const sql of statements) await db.query(sql);
}

const clampText = (v, max, what) => {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw httpError(`${what} must be text.`);
  return v.trim().slice(0, max);
};
const intIn = (v, min, max, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(`${what} must be a whole number from ${min} to ${max}.`);
  return n;
};

export async function listCues(db, projectId) {
  const rows = (await db.query(
    `SELECT c.*, s.code AS shot_code, sc.code AS scene_code, m.mime, m.status AS media_status FROM production_audio_cues c
     LEFT JOIN production_shots s ON s.id = c.shot_id LEFT JOIN production_scenes sc ON sc.id = s.scene_id
     LEFT JOIN production_media_files m ON m.id = c.media_id WHERE c.project_id = $1 ORDER BY c.kind, c.id`, [projectId]
  )).rows;
  return rows.map((c) => ({
    id: c.id, kind: c.kind, shotDbId: c.shot_id, shotId: c.shot_code ? `${c.scene_code}_${c.shot_code}` : null, label: c.label, prompt: c.prompt, offsetMs: c.offset_ms, durationMs: c.duration_ms,
    mediaUrl: c.media_id ? `/api/production/media/${c.media_id}` : null, mime: c.mime ?? null, approved: c.approved,
    state: c.approved && c.media_id ? "approved" : c.media_id ? "ready_for_review" : "planned",
  }));
}

export function registerAudioCueRoutes(app, db, requireRole, { store = null } = {}) {
  const admin = requireRole("admin");
  const id = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error("Audio cue route failed:", error);
      res.status(status).json({ error: status >= 500 && !error.status ? "Something went wrong on the server." : error.message, code: error.code ?? null });
    }
  };
  const project = async (req) => {
    const projectId = id(req.params.projectId);
    if (!projectId) throw httpError("Not a valid project.", 400);
    if ((await db.query("SELECT 1 FROM ai_movie_projects WHERE id = $1", [projectId])).rowCount === 0) throw httpError("Project not found.", 404);
    return projectId;
  };
  const loadCue = async (req) => {
    const projectId = await project(req);
    const cue = (await db.query("SELECT * FROM production_audio_cues WHERE id = $1 AND project_id = $2", [id(req.params.cueId) ?? 0, projectId])).rows[0];
    if (!cue) throw httpError("That cue does not exist.", 404);
    return { projectId, cue };
  };
  const checkShot = async (projectId, shotId) => {
    if (shotId === null || shotId === undefined) return null;
    const n = id(shotId);
    if (!n || (await db.query("SELECT 1 FROM production_shots WHERE id = $1 AND project_id = $2", [n, projectId])).rowCount === 0) throw httpError("That shot does not exist in this project.", 400);
    return n;
  };

  app.get("/api/production/:projectId/audio-cues", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    res.json({ cues: await listCues(db, projectId), generator: { sfx: null, music: null, note: "No sound-effect or music generator is configured. Attach a file to each cue." } });
  }));

  app.post("/api/production/:projectId/audio-cues", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    const b = req.body ?? {};
    if (!CUE_KINDS.includes(b.kind)) throw httpError(`Kind must be ${CUE_KINDS.join(" or ")}.`);
    const label = clampText(b.label, 120, "The name");
    if (!label) throw httpError("Give the cue a short name.");
    const shotId = await checkShot(projectId, b.shotId);
    const row = (await db.query(
      `INSERT INTO production_audio_cues (project_id, kind, shot_id, label, prompt, offset_ms, duration_ms, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [projectId, b.kind, shotId, label, clampText(b.prompt, 2000, "The description") ?? "", b.offsetMs === undefined ? 0 : intIn(b.offsetMs, 0, 600000, "The start offset"), b.durationMs === undefined ? 2000 : intIn(b.durationMs, 200, 600000, "The length"), req.user?.id ?? null]
    )).rows[0];
    await syncCueClips(db, projectId);
    res.status(201).json({ cue: (await listCues(db, projectId)).find((c) => c.id === row.id) });
  }));

  app.patch("/api/production/:projectId/audio-cues/:cueId", admin, wrap(async (req, res) => {
    const { projectId, cue } = await loadCue(req);
    const b = req.body ?? {};
    const sets = []; const vals = [];
    const push = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.label !== undefined) { const l = clampText(b.label, 120, "The name"); if (!l) throw httpError("Give the cue a short name."); push("label", l); }
    if (b.prompt !== undefined) push("prompt", clampText(b.prompt, 2000, "The description"));
    if (b.shotId !== undefined) push("shot_id", await checkShot(projectId, b.shotId));
    if (b.offsetMs !== undefined) push("offset_ms", intIn(b.offsetMs, 0, 600000, "The start offset"));
    if (b.durationMs !== undefined) push("duration_ms", intIn(b.durationMs, 200, 600000, "The length"));
    if (sets.length === 0) throw httpError("Nothing to change.");
    await db.query(`UPDATE production_audio_cues SET ${sets.join(", ")}, updated_at = now() WHERE id = ${Number(cue.id)}`, vals);
    await syncCueClips(db, projectId);
    res.json({ cue: (await listCues(db, projectId)).find((c) => c.id === cue.id) });
  }));

  app.delete("/api/production/:projectId/audio-cues/:cueId", admin, wrap(async (req, res) => {
    const { projectId, cue } = await loadCue(req);
    await db.query("DELETE FROM production_timeline_clips WHERE cue_id = $1", [cue.id]);
    await db.query("DELETE FROM production_audio_cues WHERE id = $1", [cue.id]);
    publish(projectId, { type: "timeline_changed", reason: "cue_deleted" });
    res.json({ deleted: true });
  }));

  // Attach a sound file (sent as base64 JSON, up to about 7 MB). A new file always needs approval again.
  app.post("/api/production/:projectId/audio-cues/:cueId/media", admin, wrap(async (req, res) => {
    const { projectId, cue } = await loadCue(req);
    if (!store) throw httpError("File storage is not available on this server.", 503, "not_configured");
    const ext = path.extname(String(req.body?.filename ?? "")).toLowerCase();
    if (!AUDIO_EXT.has(ext)) throw httpError("Attach a .wav, .mp3, .m4a or .ogg file.");
    const bytes = Buffer.from(String(req.body?.dataBase64 ?? ""), "base64");
    if (bytes.length < 100) throw httpError("The file came through empty. Try attaching it again.");
    const tmp = path.join(os.tmpdir(), `cue-${cue.id}-${Date.now()}${ext}`);
    await fs.promises.writeFile(tmp, bytes);
    try {
      const media = await store.putMedia({ projectId, role: "audio", filePath: tmp, originalName: `${cue.kind}_${cue.label}${ext}`, label: `${cue.kind}_${cue.id}`, subfolder: "Cues", createdBy: req.user?.id ?? null });
      await db.query("UPDATE production_audio_cues SET media_id = $2, approved = FALSE, updated_at = now() WHERE id = $1", [cue.id, media.id]);
    } finally {
      fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
    await syncCueClips(db, projectId);
    res.json({ cue: (await listCues(db, projectId)).find((c) => c.id === cue.id) });
  }));

  app.post("/api/production/:projectId/audio-cues/:cueId/approval", admin, wrap(async (req, res) => {
    const { projectId, cue } = await loadCue(req);
    const approved = req.body?.approved !== false;
    if (approved && !cue.media_id) throw httpError("Attach a sound file first, then approve it.", 409, "no_media");
    await db.query("UPDATE production_audio_cues SET approved = $2, updated_at = now() WHERE id = $1", [cue.id, approved]);
    publish(projectId, { type: "media_review", decision: approved ? "approve" : "reset", kind: cue.kind, cueId: cue.id });
    res.json({ cue: (await listCues(db, projectId)).find((c) => c.id === cue.id) });
  }));
}
