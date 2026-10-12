// Timeline editing. Every edit is one explicit operation with explicit behaviour, recorded so it can be undone and redone,
// and none of them ever touches the source media or the planned durations:
//
//   trim      change how long a clip plays on the timeline (not its planned length, not the file)
//   slip      change where in the source file the clip starts (source in), without moving it
//   split     cut a clip in two at a time inside it (both halves keep playing the same source, back to back)
//   reorder   move a shot to a new place in the film. V1 is repacked without gaps; the shot's dialogue / effects move with it
//   move      move a dialogue / sound-effect / music clip to a new start time
//   take      play a different finished take of a shot (or go back to "whatever is approved")
//   delete    remove a sound-effect / music clip from the timeline (the cue itself stays in the Audio Studio)
//   track     mute / solo a track (affects preview and export)
//
// RIPPLE is always chosen by the caller, never assumed:
//   ripple = true   everything that starts at or after the edited clip's end moves by the same amount, on EVERY track
//   ripple = false  nothing else moves. A trim that would make a clip run into the next clip on the same track is refused.

import { publish } from "./events.js";
import { httpError } from "./blueprint.js";

export const MIN_CLIP_MS = 300;
const MAX_MS = 6 * 60 * 60 * 1000;
export const HISTORY_LIMIT = 100;

export async function ensureTimelineEditSchema(db) {
  const statements = [
    `ALTER TABLE production_timeline_clips ADD COLUMN IF NOT EXISTS part INTEGER NOT NULL DEFAULT 0`,
    // a shot can now be split into parts: unique per (shot, part)
    `DROP INDEX IF EXISTS production_timeline_clip_shot`,
    `CREATE UNIQUE INDEX IF NOT EXISTS production_timeline_clip_shot_part ON production_timeline_clips (timeline_id, shot_id, part) WHERE kind = 'shot' AND shot_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS production_timeline_edits (
      id SERIAL PRIMARY KEY,
      timeline_id INTEGER NOT NULL REFERENCES production_timelines(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      label TEXT NOT NULL,
      op JSONB NOT NULL,
      before_state JSONB NOT NULL,
      after_state JSONB NOT NULL,
      undone BOOLEAN NOT NULL DEFAULT FALSE,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS production_timeline_edits_idx ON production_timeline_edits (timeline_id, id)`,
  ];
  for (const sql of statements) await db.query(sql);
}

const CLIP_COLUMNS = ["id", "track_id", "kind", "shot_id", "element_id", "cue_id", "label", "order_index", "start_ms", "duration_ms", "planned_duration_ms", "source_in_ms", "media_generation_id", "edited", "orphaned", "part"];

async function captureState(client, timelineId) {
  const clips = (await client.query(`SELECT ${CLIP_COLUMNS.join(", ")} FROM production_timeline_clips WHERE timeline_id = $1 ORDER BY id`, [timelineId])).rows;
  const tracks = (await client.query("SELECT id, muted, solo FROM production_timeline_tracks WHERE timeline_id = $1 ORDER BY id", [timelineId])).rows;
  return { clips, tracks };
}

// Puts the timeline back to a captured state: clips that did not exist are removed, removed ones are re-created with their ids.
async function restoreState(client, timelineId, state) {
  const wanted = new Set(state.clips.map((c) => c.id));
  const present = (await client.query("SELECT id FROM production_timeline_clips WHERE timeline_id = $1", [timelineId])).rows.map((r) => r.id);
  const extra = present.filter((id) => !wanted.has(id));
  if (extra.length) await client.query("DELETE FROM production_timeline_clips WHERE timeline_id = $1 AND id = ANY($2)", [timelineId, extra]);
  const have = new Set(present);
  for (const c of state.clips) {
    if (have.has(c.id)) {
      await client.query(
        `UPDATE production_timeline_clips SET track_id=$2, label=$3, order_index=$4, start_ms=$5, duration_ms=$6, planned_duration_ms=$7, source_in_ms=$8, media_generation_id=$9, edited=$10, orphaned=$11, part=$12, shot_id=$13, element_id=$14, cue_id=$15, updated_at=now() WHERE id=$1`,
        [c.id, c.track_id, c.label, c.order_index, c.start_ms, c.duration_ms, c.planned_duration_ms, c.source_in_ms, c.media_generation_id, c.edited, c.orphaned, c.part, c.shot_id, c.element_id, c.cue_id]
      );
    } else {
      // a shot / cue / line that no longer exists cannot be re-linked; the clip comes back unlinked rather than failing the undo
      const live = async (table, id) => (id && (await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount > 0 ? id : null);
      await client.query(
        `INSERT INTO production_timeline_clips (id, timeline_id, track_id, kind, shot_id, element_id, cue_id, label, order_index, start_ms, duration_ms, planned_duration_ms, source_in_ms, media_generation_id, edited, orphaned, part)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [c.id, timelineId, c.track_id, c.kind, await live("production_shots", c.shot_id), await live("production_scene_elements", c.element_id), await live("production_audio_cues", c.cue_id), c.label, c.order_index, c.start_ms, c.duration_ms, c.planned_duration_ms, c.source_in_ms, await live("production_generations", c.media_generation_id), c.edited, c.orphaned, c.part]
      );
    }
  }
  for (const t of state.tracks) await client.query("UPDATE production_timeline_tracks SET muted = $2, solo = $3 WHERE id = $1 AND timeline_id = $4", [t.id, t.muted, t.solo, timelineId]);
  await client.query("SELECT setval(pg_get_serial_sequence('production_timeline_clips', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM production_timeline_clips), 1))");
}

const int = (v, min, max, what) => {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.round(n) !== n || n < min || n > max) throw httpError(`${what} must be a whole number of milliseconds from ${min} to ${max}.`, 400);
  return n;
};

// ---------------------------------------------------------------------------
// The operations (pure over the clip rows they are given; they only run inside a transaction)
// ---------------------------------------------------------------------------

async function loadClip(client, timelineId, clipId) {
  const clip = (await client.query("SELECT * FROM production_timeline_clips WHERE id = $1 AND timeline_id = $2 FOR UPDATE", [clipId, timelineId])).rows[0];
  if (!clip) throw httpError("That clip is not on the timeline.", 404, "not_found");
  return clip;
}
const trackKindOf = async (client, trackId) => (await client.query("SELECT kind FROM production_timeline_tracks WHERE id = $1", [trackId])).rows[0]?.kind;

async function shiftLater(client, timelineId, fromMs, delta, exceptIds) {
  if (delta === 0) return 0;
  const r = await client.query(
    "UPDATE production_timeline_clips SET start_ms = GREATEST(0, start_ms + $3), edited = TRUE, updated_at = now() WHERE timeline_id = $1 AND start_ms >= $2 AND NOT (id = ANY($4))",
    [timelineId, fromMs, delta, exceptIds]
  );
  return r.rowCount;
}

async function opTrim(client, tl, op) {
  const clip = await loadClip(client, tl, op.clipId);
  const duration = int(op.durationMs, MIN_CLIP_MS, MAX_MS, "The length");
  const delta = duration - clip.duration_ms;
  const oldEnd = clip.start_ms + clip.duration_ms;
  if (delta === 0) return { label: "Trim (no change)", changed: 0, moved: 0 };
  let moved = 0;
  if (op.ripple === true) {
    await client.query("UPDATE production_timeline_clips SET duration_ms = $2, edited = TRUE, updated_at = now() WHERE id = $1", [clip.id, duration]);
    moved = await shiftLater(client, tl, oldEnd, delta, [clip.id]);
  } else if (op.ripple === false) {
    if (delta > 0) {
      const next = (await client.query("SELECT label, start_ms FROM production_timeline_clips WHERE timeline_id = $1 AND track_id = $2 AND id <> $3 AND start_ms >= $4 AND NOT orphaned ORDER BY start_ms LIMIT 1", [tl, clip.track_id, clip.id, oldEnd])).rows[0];
      if (next && clip.start_ms + duration > next.start_ms) throw httpError(`Making this clip ${(delta / 1000).toFixed(1)} s longer would run into “${next.label}”. Turn ripple on to push the later clips back, or shorten this one.`, 409, "overlap");
    }
    await client.query("UPDATE production_timeline_clips SET duration_ms = $2, edited = TRUE, updated_at = now() WHERE id = $1", [clip.id, duration]);
  } else {
    throw httpError("Say whether the later clips should move (ripple: true) or stay (ripple: false).", 400, "ripple_required");
  }
  return { label: `Trim ${clip.label || "clip"} to ${(duration / 1000).toFixed(1)} s${op.ripple ? " (ripple)" : ""}`, changed: 1, moved };
}

async function opSlip(client, tl, op) {
  const clip = await loadClip(client, tl, op.clipId);
  const sourceIn = int(op.sourceInMs, 0, MAX_MS, "The source start");
  await client.query("UPDATE production_timeline_clips SET source_in_ms = $2, edited = TRUE, updated_at = now() WHERE id = $1", [clip.id, sourceIn]);
  return { label: `Start ${clip.label || "clip"} ${(sourceIn / 1000).toFixed(1)} s into its source`, changed: 1, moved: 0 };
}

async function opSplit(client, tl, op) {
  const clip = await loadClip(client, tl, op.clipId);
  if (clip.kind !== "shot") throw httpError("Only shot clips can be split.", 400);
  const at = int(op.atMs, 0, MAX_MS, "The split time");
  const first = at - clip.start_ms;
  const second = clip.duration_ms - first;
  if (first < MIN_CLIP_MS || second < MIN_CLIP_MS) throw httpError(`Split inside the clip, at least ${MIN_CLIP_MS / 1000} s from either end.`, 400, "bad_split");
  const part = Number((await client.query("SELECT COALESCE(MAX(part), 0) + 1 AS n FROM production_timeline_clips WHERE timeline_id = $1 AND kind = 'shot' AND shot_id = $2", [tl, clip.shot_id])).rows[0].n);
  await client.query("UPDATE production_timeline_clips SET duration_ms = $2, edited = TRUE, updated_at = now() WHERE id = $1", [clip.id, first]);
  await client.query(
    `INSERT INTO production_timeline_clips (timeline_id, track_id, kind, shot_id, label, order_index, start_ms, duration_ms, planned_duration_ms, source_in_ms, media_generation_id, edited, part)
     VALUES ($1,$2,'shot',$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11)`,
    [tl, clip.track_id, clip.shot_id, `${clip.label} (part ${part + 1})`, clip.order_index, at, second, clip.planned_duration_ms, clip.source_in_ms + first, clip.media_generation_id, part]
  );
  return { label: `Split ${clip.label || "clip"} at ${(at / 1000).toFixed(1)} s`, changed: 2, moved: 0 };
}

// Moves a shot (all of its parts) before another shot, or to the end. V1 is repacked without gaps; each shot's dialogue,
// effects and music (everything tied to that shot) moves by the same amount as the shot, keeping its offset inside it.
async function opReorder(client, tl, op) {
  const clip = await loadClip(client, tl, op.clipId);
  if (clip.kind !== "shot") throw httpError("Only shots can be reordered. Use “move” for dialogue, effects and music.", 400);
  const v1 = (await client.query("SELECT * FROM production_timeline_clips WHERE timeline_id = $1 AND kind = 'shot' AND NOT orphaned ORDER BY start_ms, part, id", [tl])).rows;
  const groups = [];
  for (const c of v1) {
    const g = groups.find((x) => x.shotId === c.shot_id);
    if (g) g.clips.push(c); else groups.push({ shotId: c.shot_id, clips: [c] });
  }
  const mine = groups.find((g) => g.shotId === clip.shot_id);
  const rest = groups.filter((g) => g !== mine);
  let index = rest.length;
  if (op.beforeClipId) {
    const before = await loadClip(client, tl, op.beforeClipId);
    if (before.kind !== "shot") throw httpError("Choose another shot to place it before.", 400);
    if (before.shot_id === clip.shot_id) throw httpError("A shot cannot be placed before itself.", 400);
    index = rest.findIndex((g) => g.shotId === before.shot_id);
    if (index < 0) throw httpError("That shot is not on the timeline.", 404);
  }
  rest.splice(index, 0, mine);
  const origin = Math.min(...v1.map((c) => c.start_ms));
  let cursor = origin;
  const delta = new Map(); // shot id -> how far its linked clips move
  let order = 0;
  for (const g of rest) {
    const oldStart = Math.min(...g.clips.map((c) => c.start_ms));
    const groupStart = cursor;
    for (const c of g.clips) {
      await client.query("UPDATE production_timeline_clips SET start_ms = $2, order_index = $3, edited = TRUE, updated_at = now() WHERE id = $1", [c.id, cursor, ++order]);
      cursor += c.duration_ms;
    }
    delta.set(g.shotId, groupStart - oldStart);
  }
  // clips tied to a shot (dialogue, effects, music) keep their offset inside it
  let moved = 0;
  for (const [shotId, d] of delta) {
    if (d === 0) continue;
    const r = await client.query("UPDATE production_timeline_clips SET start_ms = GREATEST(0, start_ms + $3), edited = TRUE, updated_at = now() WHERE timeline_id = $1 AND shot_id = $2 AND kind <> 'shot'", [tl, shotId, d]);
    moved += r.rowCount;
  }
  return { label: `Move ${clip.label?.split(" — ")[0] || "shot"} ${op.beforeClipId ? "earlier" : "to the end"}`, changed: rest.length, moved };
}

async function opMove(client, tl, op) {
  const clip = await loadClip(client, tl, op.clipId);
  if (clip.kind === "shot") throw httpError("Shots are moved with “reorder” so the picture track never overlaps or leaves hidden gaps.", 400);
  const start = int(op.startMs, 0, MAX_MS, "The start time");
  await client.query("UPDATE production_timeline_clips SET start_ms = $2, edited = TRUE, updated_at = now() WHERE id = $1", [clip.id, start]);
  return { label: `Move ${clip.label || "clip"} to ${(start / 1000).toFixed(1)} s`, changed: 1, moved: 0 };
}

async function opTake(client, tl, op) {
  const clip = await loadClip(client, tl, op.clipId);
  if (clip.kind !== "shot") throw httpError("Only a shot's video can be switched to another take.", 400);
  if (op.generationId === null || op.generationId === undefined) {
    await client.query("UPDATE production_timeline_clips SET media_generation_id = NULL, edited = TRUE, updated_at = now() WHERE id = $1", [clip.id]);
    return { label: `${clip.label || "Clip"}: use the approved take`, changed: 1, moved: 0 };
  }
  const g = (await client.query("SELECT id, kind, shot_id, status, review FROM production_generations WHERE id = $1", [Number(op.generationId)])).rows[0];
  if (!g || g.kind !== "video" || g.shot_id !== clip.shot_id) throw httpError("That is not a take of this shot.", 400, "wrong_take");
  if (g.status !== "ready") throw httpError("That take is not finished.", 409, "not_ready");
  if (g.review === "rejected") throw httpError("That take was rejected. Approve it in the Video Studio first, or choose another.", 409, "rejected");
  await client.query("UPDATE production_timeline_clips SET media_generation_id = $2, edited = TRUE, updated_at = now() WHERE id = $1", [clip.id, g.id]);
  return { label: `${clip.label || "Clip"}: play take ${g.id}`, changed: 1, moved: 0 };
}

async function opDelete(client, tl, op) {
  const clip = await loadClip(client, tl, op.clipId);
  if (clip.kind !== "sfx" && clip.kind !== "music") throw httpError("Only sound-effect and music clips can be removed from the timeline. Mute a dialogue track instead, or edit the Blueprint.", 400);
  await client.query("DELETE FROM production_timeline_clips WHERE id = $1", [clip.id]);
  return { label: `Remove ${clip.label || "clip"} from the timeline`, changed: 1, moved: 0 };
}

async function opTrack(client, tl, op) {
  const t = (await client.query("SELECT * FROM production_timeline_tracks WHERE id = $1 AND timeline_id = $2 FOR UPDATE", [Number(op.trackId), tl])).rows[0];
  if (!t) throw httpError("That track does not exist.", 404);
  const muted = op.muted === undefined ? t.muted : Boolean(op.muted);
  const solo = op.solo === undefined ? t.solo : Boolean(op.solo);
  await client.query("UPDATE production_timeline_tracks SET muted = $2, solo = $3 WHERE id = $1", [t.id, muted, solo]);
  return { label: `${t.name}: ${muted ? "muted" : solo ? "solo" : "normal"}`, changed: 1, moved: 0 };
}

const OPS = { trim: opTrim, slip: opSlip, split: opSplit, reorder: opReorder, move: opMove, take: opTake, delete: opDelete, track: opTrack };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function lockTimeline(client, projectId) {
  const timeline = (await client.query("SELECT * FROM production_timelines WHERE project_id = $1 FOR UPDATE", [projectId])).rows[0];
  if (!timeline) throw httpError("There is no timeline yet. Approve the Production Blueprint first.", 409, "no_timeline");
  return timeline;
}

export async function applyEdit(db, projectId, op, { actorUserId = null, expectedRevision = null } = {}) {
  if (!op || !OPS[op.type]) throw httpError(`Unknown edit "${op?.type}". Choose one of: ${Object.keys(OPS).join(", ")}.`, 400);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const timeline = await lockTimeline(client, projectId);
    if (expectedRevision !== null && Number(expectedRevision) !== timeline.edit_revision) throw httpError("The timeline changed since you opened it (another edit, or the plan changed). Reload and try again.", 409, "stale");
    const before = await captureState(client, timeline.id);
    const result = await OPS[op.type](client, timeline.id, op);
    const after = await captureState(client, timeline.id);
    // a new edit ends the redo chain
    await client.query("DELETE FROM production_timeline_edits WHERE timeline_id = $1 AND undone", [timeline.id]);
    const revision = timeline.edit_revision + 1;
    await client.query("UPDATE production_timelines SET edit_revision = $2, updated_at = now() WHERE id = $1", [timeline.id, revision]);
    await client.query("INSERT INTO production_timeline_edits (timeline_id, revision, label, op, before_state, after_state, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [timeline.id, revision, result.label, JSON.stringify(op), JSON.stringify(before), JSON.stringify(after), actorUserId]);
    await client.query("DELETE FROM production_timeline_edits WHERE timeline_id = $1 AND id NOT IN (SELECT id FROM production_timeline_edits WHERE timeline_id = $1 ORDER BY id DESC LIMIT $2)", [timeline.id, HISTORY_LIMIT]);
    await client.query("COMMIT");
    publish(projectId, { type: "timeline_changed", reason: "edit", op: op.type });
    return { ...result, revision };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function step(db, projectId, direction) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const timeline = await lockTimeline(client, projectId);
    const edit = direction === "undo"
      ? (await client.query("SELECT * FROM production_timeline_edits WHERE timeline_id = $1 AND NOT undone ORDER BY id DESC LIMIT 1 FOR UPDATE", [timeline.id])).rows[0]
      : (await client.query("SELECT * FROM production_timeline_edits WHERE timeline_id = $1 AND undone ORDER BY id ASC LIMIT 1 FOR UPDATE", [timeline.id])).rows[0];
    if (!edit) throw httpError(direction === "undo" ? "There is nothing to undo." : "There is nothing to redo.", 409, "nothing_to_do");
    await restoreState(client, timeline.id, direction === "undo" ? edit.before_state : edit.after_state);
    await client.query("UPDATE production_timeline_edits SET undone = $2 WHERE id = $1", [edit.id, direction === "undo"]);
    const revision = timeline.edit_revision + 1;
    await client.query("UPDATE production_timelines SET edit_revision = $2, updated_at = now() WHERE id = $1", [timeline.id, revision]);
    await client.query("COMMIT");
    publish(projectId, { type: "timeline_changed", reason: direction });
    return { label: edit.label, revision };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
export const undoEdit = (db, projectId) => step(db, projectId, "undo");
export const redoEdit = (db, projectId) => step(db, projectId, "redo");

export async function editHistory(db, projectId) {
  const timeline = (await db.query("SELECT id, edit_revision FROM production_timelines WHERE project_id = $1", [projectId])).rows[0];
  if (!timeline) return { canUndo: false, canRedo: false, edits: [], revision: null };
  const edits = (await db.query("SELECT id, label, undone, created_at FROM production_timeline_edits WHERE timeline_id = $1 ORDER BY id DESC LIMIT 30", [timeline.id])).rows;
  return { canUndo: edits.some((e) => !e.undone), canRedo: edits.some((e) => e.undone), revision: timeline.edit_revision, edits: edits.map((e) => ({ id: e.id, label: e.label, undone: e.undone, at: e.created_at })) };
}

export function registerTimelineEditRoutes(app, db, requireRole) {
  const admin = requireRole("admin");
  const id = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error("Timeline edit route failed:", error);
      res.status(status).json({ error: status >= 500 && !error.status ? "Something went wrong on the server." : error.message, code: error.code ?? null });
    }
  };
  const project = async (req) => {
    const projectId = id(req.params.projectId);
    if (!projectId) throw httpError("Not a valid project.", 400);
    if ((await db.query("SELECT 1 FROM ai_movie_projects WHERE id = $1", [projectId])).rowCount === 0) throw httpError("Project not found.", 404);
    return projectId;
  };
  app.post("/api/production/:projectId/timeline/edit", admin, wrap(async (req, res) => {
    const projectId = await project(req);
    res.json(await applyEdit(db, projectId, req.body?.op, { actorUserId: req.user?.id, expectedRevision: req.body?.expectedRevision ?? null }));
  }));
  app.post("/api/production/:projectId/timeline/undo", admin, wrap(async (req, res) => res.json(await undoEdit(db, await project(req)))));
  app.post("/api/production/:projectId/timeline/redo", admin, wrap(async (req, res) => res.json(await redoEdit(db, await project(req)))));
  app.get("/api/production/:projectId/timeline/history", admin, wrap(async (req, res) => res.json(await editHistory(db, await project(req)))));
}
