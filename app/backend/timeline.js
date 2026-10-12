// The Timeline: a first-class workspace that exists as soon as the Production Blueprint is approved.
//
// Source of truth: the Timeline stores only LAYOUT (which shot sits where, for how long, trims). It never copies media.
// What a clip shows is derived each time it is read from the approved media in production_generations, so approving a
// picture / take / voice changes the right slot by itself and nothing can drift:
//
//   planned               empty labelled block (image prompt + video prompt in the inspector)
//   first frame approved  still picture in the block
//   video approved        video clip in the block
//   audio approved        clip on the dialogue track
//
// Media that is only generated (not approved) is reported as "review needed" and never replaces the canonical media.
// Durations are kept apart: planned (from the Shot Cutter), source (what the provider made), timeline (what the edit uses).

import { unitIndex } from "./generationUnits.js";
import { audioDurationFallbackMs } from "./timelineMath.js";
import { publish } from "./events.js";
import { buildShotManifest } from "./blueprint.js";

const httpError = (message, status = 400, code = "bad_request") => Object.assign(new Error(message), { status, code });

export const TRACKS = [
  { name: "V1", kind: "video", label: "Video" },
  { name: "A1", kind: "dialogue", label: "Dialogue" },
  { name: "A2", kind: "sfx", label: "Sound effects" },
  { name: "A3", kind: "music", label: "Music" },
];

export async function ensureTimelineSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS production_timelines (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL UNIQUE REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      blueprint_version INTEGER,
      edit_revision INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS production_timeline_tracks (
      id SERIAL PRIMARY KEY,
      timeline_id INTEGER NOT NULL REFERENCES production_timelines(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('video','dialogue','sfx','music')),
      position INTEGER NOT NULL,
      muted BOOLEAN NOT NULL DEFAULT FALSE,
      solo BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE (timeline_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS production_timeline_clips (
      id SERIAL PRIMARY KEY,
      timeline_id INTEGER NOT NULL REFERENCES production_timelines(id) ON DELETE CASCADE,
      track_id INTEGER NOT NULL REFERENCES production_timeline_tracks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('shot','dialogue','sfx','music')),
      shot_id INTEGER REFERENCES production_shots(id) ON DELETE SET NULL,
      element_id INTEGER REFERENCES production_scene_elements(id) ON DELETE SET NULL,
      label TEXT NOT NULL DEFAULT '',
      order_index INTEGER NOT NULL DEFAULT 0,
      start_ms INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL,
      planned_duration_ms INTEGER NOT NULL,
      source_in_ms INTEGER NOT NULL DEFAULT 0,
      media_generation_id INTEGER REFERENCES production_generations(id) ON DELETE SET NULL,
      edited BOOLEAN NOT NULL DEFAULT FALSE,
      orphaned BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS production_timeline_clip_line ON production_timeline_clips (timeline_id, element_id) WHERE kind = 'dialogue' AND element_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS production_timeline_clips_idx ON production_timeline_clips (timeline_id, track_id, start_ms)`,
  ];
  for (const sql of statements) await db.query(sql);
}

async function ensureTimeline(client, projectId, blueprintVersion) {
  let timeline = (await client.query("SELECT * FROM production_timelines WHERE project_id = $1", [projectId])).rows[0];
  if (!timeline) {
    timeline = (await client.query("INSERT INTO production_timelines (project_id, blueprint_version) VALUES ($1,$2) ON CONFLICT (project_id) DO UPDATE SET updated_at = now() RETURNING *", [projectId, blueprintVersion])).rows[0];
  }
  for (const [i, t] of TRACKS.entries()) await client.query("INSERT INTO production_timeline_tracks (timeline_id, name, kind, position) VALUES ($1,$2,$3,$4) ON CONFLICT (timeline_id, name) DO NOTHING", [timeline.id, t.name, t.kind, i]);
  return timeline;
}

// Called when a Blueprint is approved. Creates one placeholder per planned shot (in order, sized by the planned duration)
// and one dialogue placeholder per spoken line, WITHOUT waiting for any image, video or voice. Running it again only adds
// what is new: a clip a person has edited keeps its edits; a shot that left the Blueprint keeps its clip, flagged as orphaned.
export async function syncTimelineFromBlueprint(db, projectId, blueprintVersion) {
  const manifest = await buildShotManifest(db, projectId);
  const units = await unitIndex(db, projectId);
  const offsetOf = (shotDbId) => { const u = units.get(shotDbId); return u && u.members.length > 1 ? u.offsetMs : 0; }; // where in the shared video this shot starts
  const client = await db.connect();
  const result = { created: 0, updated: 0, orphaned: 0, dialogue: 0 };
  let committed = false;
  try {
    await client.query("BEGIN");
    const timeline = await ensureTimeline(client, projectId, blueprintVersion);
    await client.query("UPDATE production_timelines SET blueprint_version = $2, updated_at = now() WHERE id = $1", [timeline.id, blueprintVersion]);
    const tracks = Object.fromEntries((await client.query("SELECT id, name FROM production_timeline_tracks WHERE timeline_id = $1", [timeline.id])).rows.map((t) => [t.name, t.id]));
    const existing = new Map((await client.query("SELECT * FROM production_timeline_clips WHERE timeline_id = $1 AND kind = 'shot' AND part = 0", [timeline.id])).rows.map((c) => [c.shot_id, c]));
    const present = new Set();
    // If a person has edited any clip, existing clips keep their place and new shots are appended after the last clip;
    // otherwise the whole layout simply follows the Blueprint's order and durations.
    const anyEdited = [...existing.values()].some((c) => c.edited);
    let tail = Math.max(0, ...[...existing.values()].map((c) => c.start_ms + c.duration_ms));
    for (const shot of manifest.shots) {
      present.add(shot.db_id);
      const old = existing.get(shot.db_id);
      const label = `${shot.shot_id} — ${String(shot.action ?? "").slice(0, 80)}`;
      if (!old) {
        const start = anyEdited ? tail : shot.planned_start_ms;
        await client.query(
          `INSERT INTO production_timeline_clips (timeline_id, track_id, kind, shot_id, label, order_index, start_ms, duration_ms, planned_duration_ms, source_in_ms) VALUES ($1,$2,'shot',$3,$4,$5,$6,$7,$7,$8)`,
          [timeline.id, tracks.V1, shot.db_id, label, shot.sequence, start, shot.planned_duration_ms, offsetOf(shot.db_id)]
        );
        if (anyEdited) tail = start + shot.planned_duration_ms;
        result.created++;
      } else if (!old.edited) {
        await client.query(
          "UPDATE production_timeline_clips SET label = $2, order_index = $3, start_ms = $4, duration_ms = $5, planned_duration_ms = $5, source_in_ms = $6, orphaned = FALSE, updated_at = now() WHERE id = $1",
          [old.id, label, shot.sequence, anyEdited ? old.start_ms : shot.planned_start_ms, shot.planned_duration_ms, offsetOf(shot.db_id)]
        );
        result.updated++;
      } else {
        // edited by a person: only the planned value moves; their timeline duration, trims and place are theirs
        await client.query("UPDATE production_timeline_clips SET label = $2, planned_duration_ms = $3, orphaned = FALSE, updated_at = now() WHERE id = $1", [old.id, label, shot.planned_duration_ms]);
        result.updated++;
      }
    }
    // (a deleted shot leaves its clip with no shot id at all, so orphans are found by clip, not by shot)
    for (const [shotId, clip] of existing) {
      if (!present.has(shotId) && !clip.orphaned) { await client.query("UPDATE production_timeline_clips SET orphaned = TRUE, updated_at = now() WHERE id = $1", [clip.id]); result.orphaned++; }
    }

    // dialogue placeholders: a line starts with its shot, lines in one shot follow each other
    const shotClips = new Map((await client.query("SELECT shot_id, start_ms, duration_ms FROM production_timeline_clips WHERE timeline_id = $1 AND kind = 'shot' AND part = 0", [timeline.id])).rows.map((c) => [c.shot_id, c]));
    const lines = (await client.query("SELECT id, code, speaker, text_en, text_hi FROM production_scene_elements WHERE project_id = $1 AND kind = 'dialogue'", [projectId])).rows;
    const lineMeta = new Map(lines.map((l) => [l.id, l]));
    const existingLines = new Map((await client.query("SELECT * FROM production_timeline_clips WHERE timeline_id = $1 AND kind = 'dialogue'", [timeline.id])).rows.map((c) => [c.element_id, c]));
    for (const shot of manifest.shots) {
      const base = shotClips.get(shot.db_id);
      if (!base) continue;
      let offset = 0;
      for (const d of shot.dialogue) {
        const meta = lineMeta.get(d.id);
        const planned = audioDurationFallbackMs(meta?.text_en || meta?.text_hi || "");
        const label = `${d.code} ${meta?.speaker ?? ""}`.trim();
        const old = existingLines.get(d.id);
        if (!old) {
          await client.query(
            `INSERT INTO production_timeline_clips (timeline_id, track_id, kind, shot_id, element_id, label, order_index, start_ms, duration_ms, planned_duration_ms) VALUES ($1,$2,'dialogue',$3,$4,$5,$6,$7,$8,$8)`,
            [timeline.id, tracks.A1, shot.db_id, d.id, label, shot.sequence, base.start_ms + offset, planned]
          );
          result.dialogue++;
        } else if (!old.edited) {
          await client.query("UPDATE production_timeline_clips SET shot_id = $2, label = $3, start_ms = $4, duration_ms = $5, planned_duration_ms = $5, orphaned = FALSE, updated_at = now() WHERE id = $1", [old.id, shot.db_id, label, base.start_ms + offset, planned]);
        }
        offset += planned;
      }
    }
    await client.query("UPDATE production_timelines SET edit_revision = edit_revision + 1, updated_at = now() WHERE id = $1", [timeline.id]);
    await client.query("COMMIT");
    committed = true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (committed) {
    await db.query("DELETE FROM production_timeline_edits WHERE timeline_id = (SELECT id FROM production_timelines WHERE project_id = $1)", [projectId]).catch(() => {});
    await syncCueClips(db, projectId);
  }
  publish(projectId, { type: "timeline_changed", reason: "blueprint_approved", ...result });
  return result;
}

// Sound-effect and music cues become clips on their own tracks, placed at their shot's start + the cue's offset.
// Safe to call any time; does nothing if the Blueprint has not created the timeline yet.
export async function syncCueClips(db, projectId) {
  const timeline = (await db.query("SELECT * FROM production_timelines WHERE project_id = $1", [projectId])).rows[0];
  if (!timeline) return { clips: 0 };
  const tracks = Object.fromEntries((await db.query("SELECT id, name FROM production_timeline_tracks WHERE timeline_id = $1", [timeline.id])).rows.map((t) => [t.name, t.id]));
  const cues = (await db.query("SELECT * FROM production_audio_cues WHERE project_id = $1 ORDER BY id", [projectId])).rows;
  const shotClips = new Map((await db.query("SELECT shot_id, start_ms FROM production_timeline_clips WHERE timeline_id = $1 AND kind = 'shot' AND part = 0", [timeline.id])).rows.map((c) => [c.shot_id, c.start_ms]));
  const existing = new Map((await db.query("SELECT * FROM production_timeline_clips WHERE timeline_id = $1 AND cue_id IS NOT NULL", [timeline.id])).rows.map((c) => [c.cue_id, c]));
  for (const cue of cues) {
    const start = (cue.shot_id ? shotClips.get(cue.shot_id) ?? 0 : 0) + cue.offset_ms;
    const track = tracks[cue.kind === "sfx" ? "A2" : "A3"];
    const old = existing.get(cue.id);
    if (!old) {
      await db.query(
        `INSERT INTO production_timeline_clips (timeline_id, track_id, kind, shot_id, cue_id, label, order_index, start_ms, duration_ms, planned_duration_ms) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$8)`,
        [timeline.id, track, cue.kind, cue.shot_id, cue.id, cue.label, start, cue.duration_ms]
      );
    } else if (!old.edited) {
      await db.query("UPDATE production_timeline_clips SET track_id = $2, kind = $3, shot_id = $4, label = $5, start_ms = $6, duration_ms = $7, planned_duration_ms = $7, updated_at = now() WHERE id = $1", [old.id, track, cue.kind, cue.shot_id, cue.label, start, cue.duration_ms]);
    } else {
      await db.query("UPDATE production_timeline_clips SET label = $2, planned_duration_ms = $3, updated_at = now() WHERE id = $1", [old.id, cue.label, cue.duration_ms]);
    }
  }
  const gone = [...existing.keys()].filter((cid) => !cues.some((c) => c.id === cid));
  if (gone.length) await db.query("DELETE FROM production_timeline_clips WHERE timeline_id = $1 AND cue_id = ANY($2)", [timeline.id, gone]);
  await db.query("UPDATE production_timelines SET edit_revision = edit_revision + 1, updated_at = now() WHERE id = $1", [timeline.id]);
  await db.query("DELETE FROM production_timeline_edits WHERE timeline_id = $1", [timeline.id]).catch(() => {}); // cues changed outside the editor: start a fresh undo history
  publish(projectId, { type: "timeline_changed", reason: "cues" });
  return { clips: cues.length };
}

// ---------------------------------------------------------------------------
// Reading the timeline (derived view)
// ---------------------------------------------------------------------------

const mediaUrl = (g) => (g?.media_id ? `/api/production/media/${g.media_id}` : null);

export async function getTimeline(db, projectId) {
  const timeline = (await db.query("SELECT * FROM production_timelines WHERE project_id = $1", [projectId])).rows[0];
  if (!timeline) return { exists: false, tracks: [], clips: [], totalMs: 0 };
  const tracks = (await db.query("SELECT * FROM production_timeline_tracks WHERE timeline_id = $1 ORDER BY position", [timeline.id])).rows;
  const clips = (await db.query("SELECT * FROM production_timeline_clips WHERE timeline_id = $1 ORDER BY track_id, start_ms, id", [timeline.id])).rows;
  const manifest = await buildShotManifest(db, projectId);
  const shotById = new Map(manifest.shots.map((s) => [s.db_id, s]));
  const gens = (await db.query(
    `SELECT id, kind, shot_id, element_id, status, review, version, media_id, duration_ms, params, prompt_id FROM production_generations
     WHERE project_id = $1 AND kind IN ('keyframe','video','audio') ORDER BY id DESC`, [projectId]
  )).rows;
  const prompts = new Map((await db.query("SELECT id, purpose, version, text FROM production_prompts WHERE project_id = $1 AND status = 'current'", [projectId])).rows.map((p) => [p.id, p]));
  const approved = (kind, key, id) => gens.find((g) => g.kind === kind && g[key] === id && g.review === "approved" && g.status === "ready") ?? null;
  const pending = (kind, key, id) => gens.filter((g) => g.kind === kind && g[key] === id && g.status === "ready" && g.review === "pending").length;
  const byId = new Map(gens.map((g) => [g.id, g]));
  const units = await unitIndex(db, projectId);
  const cuesById = new Map((await db.query("SELECT id, approved, media_id, prompt FROM production_audio_cues WHERE project_id = $1", [projectId])).rows.map((r) => [r.id, r]));

  const out = clips.map((c) => {
    const base = {
      id: c.id, trackId: c.track_id, kind: c.kind, shotId: c.shot_id, elementId: c.element_id, label: c.label, startMs: c.start_ms, durationMs: c.duration_ms,
      plannedDurationMs: c.planned_duration_ms, sourceInMs: c.source_in_ms, edited: c.edited, orphaned: c.orphaned, part: c.part,
      takeOverride: Boolean(c.media_generation_id),
    };
    if (c.kind === "shot") {
      const shot = shotById.get(c.shot_id);
      // a shot that rides inside another shot's combined generation unit plays a different part of the LEAD shot's video (stored once)
      const ux = units.get(c.shot_id);
      const src = ux && ux.members.length > 1 ? ux.leadId : c.shot_id;
      const frame = approved("keyframe", "shot_id", src);
      let video = approved("video", "shot_id", src);
      // an explicit take chosen in the edit wins, if it still is a finished video of this shot
      const chosen = c.media_generation_id ? byId.get(c.media_generation_id) : null;
      if (chosen && chosen.kind === "video" && chosen.shot_id === src && chosen.status === "ready") video = chosen;
      const sourceMs = video ? (video.params?.seconds ? Number(video.params.seconds) * 1000 : video.duration_ms ?? null) : null;
      const state = video ? "video" : frame ? "first_frame" : "planned";
      return {
        ...base, shotRef: shot?.shot_id ?? null, state, sourceDurationMs: sourceMs,
        generationUnit: ux ? { code: ux.unit.code, members: ux.members.length, isLead: ux.isLead, leadShotId: ux.leadId, requestedSeconds: ux.unit.requested_seconds } : null,
        media: video ? { type: "video", generationId: video.id, url: mediaUrl(video), version: video.version } : frame ? { type: "image", generationId: frame.id, url: mediaUrl(frame), version: frame.version } : null,
        frame: frame ? { generationId: frame.id, url: mediaUrl(frame) } : null,
        reviewNeeded: { frame: pending("keyframe", "shot_id", src), video: pending("video", "shot_id", src) },
        imagePrompt: shot?.image.prompt_id ? prompts.get(shot.image.prompt_id) ?? null : null,
        videoPrompt: shot?.video.prompt_id ? prompts.get(shot.video.prompt_id) ?? null : null,
        flags: { sourceTooShort: Boolean(sourceMs && c.source_in_ms + c.duration_ms > sourceMs), removedFromBlueprint: c.orphaned },
        action: shot?.action ?? null, sceneId: shot?.scene_id ?? null, characterIds: shot?.character_ids ?? [],
      };
    }
    if (c.kind === "dialogue") {
      const audio = approved("audio", "element_id", c.element_id);
      return {
        ...base, state: audio ? "audio" : "planned", sourceDurationMs: audio?.duration_ms ?? null,
        media: audio ? { type: "audio", generationId: audio.id, url: mediaUrl(audio), version: audio.version } : null,
        reviewNeeded: { audio: pending("audio", "element_id", c.element_id) }, flags: { sourceTooShort: Boolean(audio?.duration_ms && c.source_in_ms + c.duration_ms > audio.duration_ms) },
      };
    }
    if (c.kind === "sfx" || c.kind === "music") {
      const cue = cuesById.get(c.cue_id);
      const ok = cue?.approved && cue?.media_id;
      return {
        ...base, cueId: c.cue_id, state: ok ? "audio" : "planned", sourceDurationMs: null,
        media: ok ? { type: "audio", generationId: null, url: `/api/production/media/${cue.media_id}`, version: 1 } : null,
        reviewNeeded: { audio: cue?.media_id && !cue.approved ? 1 : 0 }, flags: {}, prompt: cue?.prompt ?? "",
      };
    }
    return { ...base, state: "planned", media: null };
  });
  const totalMs = Math.max(0, ...out.filter((c) => !c.orphaned).map((c) => c.startMs + c.durationMs));
  return {
    exists: true, id: timeline.id, blueprintVersion: timeline.blueprint_version, editRevision: timeline.edit_revision,
    tracks: tracks.map((t) => ({ id: t.id, name: t.name, kind: t.kind, muted: t.muted, solo: t.solo, label: TRACKS.find((x) => x.name === t.name)?.label ?? t.name })),
    clips: out, totalMs,
    summary: {
      shots: out.filter((c) => c.kind === "shot" && !c.orphaned).length,
      placeholders: out.filter((c) => c.kind === "shot" && !c.orphaned && c.state === "planned").length,
      // every shot with an approved first frame (including those that have since got a video), so it matches the project header
      firstFrames: out.filter((c) => c.kind === "shot" && !c.orphaned && c.frame).length,
      videos: out.filter((c) => c.kind === "shot" && c.state === "video").length,
      audio: out.filter((c) => c.kind === "dialogue" && c.state === "audio").length,
      cues: out.filter((c) => (c.kind === "sfx" || c.kind === "music") && c.state === "audio").length,
      cuesPlanned: out.filter((c) => (c.kind === "sfx" || c.kind === "music") && c.state === "planned").length,
      reviewNeeded: out.reduce((n, c) => n + Object.values(c.reviewNeeded ?? {}).reduce((a, b) => a + b, 0), 0),
    },
  };
}

export function registerTimelineRoutes(app, db, requireRole) {
  const admin = requireRole("admin");
  const id = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error("Timeline route failed:", error);
      res.status(status).json({ error: status >= 500 && !error.status ? "Something went wrong on the server." : error.message, code: error.code ?? null });
    }
  };
  const project = async (req) => {
    const projectId = id(req.params.projectId);
    if (!projectId) throw httpError("Not a valid project.", 400);
    if ((await db.query("SELECT 1 FROM ai_movie_projects WHERE id = $1", [projectId])).rowCount === 0) throw httpError("Project not found.", 404);
    return projectId;
  };
  app.get("/api/production/:projectId/timeline", admin, wrap(async (req, res) => res.json(await getTimeline(db, await project(req)))));
}
