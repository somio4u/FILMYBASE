// Saving the timeline (an immutable snapshot) and exporting from it.
//
// A SNAPSHOT is the timeline written down exactly as it was at one moment: every clip, where it sits, how long it plays, where
// in its source it starts, and WHICH media file it plays. Nothing can change it afterwards (there is no update route), so an
// export made from it is repeatable and cannot be changed by a later approval, edit or re-plan.
//
// The ffmpeg render reads ONLY the snapshot — it never looks at shots, takes or approvals itself, so it cannot disagree with
// the Timeline. Before anything is rendered the snapshot is checked (overlaps, missing or unreadable files, placeholders, muted
// tracks), and after rendering the length of the output is measured against the timeline's length. The result says plainly
// whether the film contains placeholders or only approved media.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import AdmZip from "adm-zip";
import { findFfmpeg, runFfmpeg, SIZES } from "./assemble.js";
import { getSettings } from "./pipelineSettings.js";
import { getTimeline } from "./timeline.js";
import { httpError } from "./blueprint.js";
import { publish } from "./events.js";

export async function ensureSnapshotSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS production_timeline_snapshots (
    id SERIAL PRIMARY KEY,
    timeline_id INTEGER NOT NULL REFERENCES production_timelines(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    edit_revision INTEGER NOT NULL,
    layout JSONB NOT NULL,
    summary JSONB NOT NULL,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (timeline_id, version)
  )`);
  // immutable: the database itself refuses any change to a saved snapshot
  await db.query(`CREATE OR REPLACE FUNCTION forbid_snapshot_change() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'A saved timeline snapshot cannot be changed. Save a new one instead.'; END $$ LANGUAGE plpgsql`);
  await db.query("DROP TRIGGER IF EXISTS production_snapshot_immutable ON production_timeline_snapshots");
  await db.query("CREATE TRIGGER production_snapshot_immutable BEFORE UPDATE ON production_timeline_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_snapshot_change()");
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export async function saveSnapshot(db, projectId, { label = "", actorUserId = null } = {}) {
  const timeline = await getTimeline(db, projectId);
  if (!timeline.exists) throw httpError("There is no timeline yet. Approve the Production Blueprint first.", 409, "no_timeline");
  const gens = new Map((await db.query(
    "SELECT id, kind, media_id, review, status, duration_ms, params FROM production_generations WHERE project_id = $1 AND kind IN ('keyframe','video','audio')", [projectId]
  )).rows.map((g) => [g.id, g]));
  const cues = new Map((await db.query("SELECT id, media_id, approved FROM production_audio_cues WHERE project_id = $1", [projectId])).rows.map((c) => [c.id, c]));
  const trackById = new Map(timeline.tracks.map((t) => [t.id, t]));
  const clips = [];
  for (const c of timeline.clips) {
    if (c.orphaned && !c.media) continue; // a shot that left the Blueprint and has no media is not part of the film
    const track = trackById.get(c.trackId);
    let media = null;
    let unapproved = false;
    if (c.kind === "sfx" || c.kind === "music") {
      const cue = cues.get(c.cueId);
      if (cue?.media_id) { media = { type: "audio", mediaId: cue.media_id, generationId: null, source: "cue" }; unapproved = !cue.approved; }
    } else if (c.media) {
      const g = gens.get(c.media.generationId);
      if (g?.media_id) {
        media = { type: c.media.type, mediaId: g.media_id, generationId: g.id, source: c.takeOverride ? "chosen-take" : "approved", sourceDurationMs: c.kind === "shot" && c.media.type === "video" ? (g.params?.seconds ? Number(g.params.seconds) * 1000 : g.duration_ms ?? null) : g.duration_ms ?? null };
        unapproved = g.review !== "approved";
      }
    }
    clips.push({
      clipId: c.id, track: track?.name ?? "?", trackKind: track?.kind ?? "video", kind: c.kind, part: c.part ?? 0, shotRef: c.shotRef ?? null, label: c.label, shotId: c.shotId, elementId: c.elementId, cueId: c.cueId ?? null,
      startMs: c.startMs, durationMs: c.durationMs, sourceInMs: c.sourceInMs, plannedDurationMs: c.plannedDurationMs,
      media, placeholder: c.kind === "shot" && !media, unapprovedMedia: unapproved,
    });
  }
  const tracks = timeline.tracks.map((t) => ({ name: t.name, kind: t.kind, muted: t.muted, solo: t.solo }));
  const shotClips = clips.filter((c) => c.kind === "shot");
  const summary = {
    clips: clips.length, shots: shotClips.length, placeholders: shotClips.filter((c) => c.placeholder).length,
    videos: shotClips.filter((c) => c.media?.type === "video").length, stills: shotClips.filter((c) => c.media?.type === "image").length,
    audioClips: clips.filter((c) => c.trackKind !== "video" && c.media).length, unapprovedMedia: clips.filter((c) => c.unapprovedMedia).length,
    durationMs: Math.max(0, ...shotClips.map((c) => c.startMs + c.durationMs)),
  };
  summary.containsPlaceholders = summary.placeholders > 0;
  summary.approvedOnly = summary.placeholders === 0 && summary.unapprovedMedia === 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const version = Number((await db.query("SELECT COALESCE(MAX(version),0) + 1 AS n FROM production_timeline_snapshots WHERE timeline_id = $1", [timeline.id])).rows[0].n);
    try {
      const row = (await db.query(
        "INSERT INTO production_timeline_snapshots (timeline_id, version, label, edit_revision, layout, summary, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, version, label, created_at",
        [timeline.id, version, String(label).trim().slice(0, 120), timeline.editRevision, JSON.stringify({ clips, tracks, blueprintVersion: timeline.blueprintVersion }), JSON.stringify(summary), actorUserId]
      )).rows[0];
      publish(projectId, { type: "snapshot_saved", snapshotId: row.id, version: row.version });
      return { id: row.id, version: row.version, label: row.label, createdAt: row.created_at, summary };
    } catch (error) {
      if (error.code !== "23505") throw error;
    }
  }
  throw httpError("Could not save the snapshot, try again.", 409);
}

export async function listSnapshots(db, projectId) {
  return (await db.query(
    `SELECT s.id, s.version, s.label, s.edit_revision, s.summary, s.created_at,
       (SELECT count(*)::int FROM production_exports e WHERE e.snapshot_id = s.id AND e.status = 'ready') AS exports
     FROM production_timeline_snapshots s JOIN production_timelines t ON t.id = s.timeline_id WHERE t.project_id = $1 ORDER BY s.version DESC`, [projectId]
  )).rows.map((r) => ({ id: r.id, version: r.version, label: r.label, editRevision: r.edit_revision, summary: r.summary, createdAt: r.created_at, exports: r.exports }));
}

async function loadSnapshot(db, projectId, snapshotId) {
  const row = (await db.query(
    "SELECT s.* FROM production_timeline_snapshots s JOIN production_timelines t ON t.id = s.timeline_id WHERE s.id = $1 AND t.project_id = $2", [snapshotId, projectId]
  )).rows[0];
  if (!row) throw httpError("That snapshot does not exist.", 404, "not_found");
  return row;
}

// ---------------------------------------------------------------------------
// Checking a snapshot before export
// ---------------------------------------------------------------------------

// Which audio clips are heard: if any track is on solo, only solo tracks; otherwise every track that is not muted.
export function audibleTracks(tracks) {
  const solo = tracks.filter((t) => t.solo && t.kind !== "video");
  return new Set((solo.length ? solo : tracks.filter((t) => !t.muted)).filter((t) => t.kind !== "video").map((t) => t.name));
}

export async function validateSnapshot(db, store, projectId, snapshotId, { placeholders = "black" } = {}) {
  const snap = await loadSnapshot(db, projectId, snapshotId);
  const { clips, tracks } = snap.layout;
  const errors = [];
  const warnings = [];
  const add = (list, code, message, extra = {}) => list.push({ code, message, ...extra });
  const shots = clips.filter((c) => c.kind === "shot").sort((a, b) => a.startMs - b.startMs);
  if (shots.length === 0) add(errors, "no_shots", "The timeline has no shots to export.");
  for (let i = 1; i < shots.length; i++) {
    if (shots[i].startMs < shots[i - 1].startMs + shots[i - 1].durationMs) add(errors, "overlap", `${shots[i].shotRef ?? shots[i].label} overlaps ${shots[i - 1].shotRef ?? shots[i - 1].label} on the picture track.`, { clip: shots[i].clipId });
  }
  const placeholderClips = shots.filter((c) => c.placeholder);
  if (placeholderClips.length) {
    const text = `${placeholderClips.length} shot${placeholderClips.length === 1 ? " has" : "s have"} no approved picture or video yet (${placeholderClips.slice(0, 4).map((c) => c.shotRef).join(", ")}${placeholderClips.length > 4 ? "…" : ""}). `;
    if (placeholders === "refuse") add(errors, "placeholders", `${text}You asked for approved media only, so nothing was exported.`);
    else add(warnings, "placeholders", `${text}They will appear as dark grey cards for their planned length, with no sound.`);
  }
  const unapproved = clips.filter((c) => c.unapprovedMedia && c.media);
  if (unapproved.length) add(warnings, "unapproved_media", `${unapproved.length} clip${unapproved.length === 1 ? " plays" : "s play"} a file that is not the approved one (${unapproved.slice(0, 3).map((c) => c.label).join(", ")}${unapproved.length > 3 ? "…" : ""}).`);
  // every file must be readable now
  const checked = new Map();
  for (const c of clips) {
    if (!c.media?.mediaId || checked.has(c.media.mediaId)) continue;
    let ok = false;
    try {
      const opened = await store.openMedia(c.media.mediaId);
      ok = Boolean(opened) && !opened.unavailable;
      opened?.stream?.destroy?.();
    } catch { ok = false; }
    checked.set(c.media.mediaId, ok);
    if (!ok) add(errors, "file_unavailable", `The file for ${c.label || c.shotRef} (media #${c.media.mediaId}) cannot be read from storage right now.`, { clip: c.clipId, mediaId: c.media.mediaId });
  }
  const tooShort = clips.filter((c) => c.media?.sourceDurationMs && c.sourceInMs + c.durationMs > c.media.sourceDurationMs + 50);
  if (tooShort.length) add(warnings, "source_too_short", `${tooShort.length} clip${tooShort.length === 1 ? " is" : "s are"} set longer than the made video (${tooShort.slice(0, 3).map((c) => c.shotRef ?? c.label).join(", ")}${tooShort.length > 3 ? "…" : ""}): the last frame is held.`);
  const heard = audibleTracks(tracks);
  const audioClips = clips.filter((c) => c.trackKind !== "video" && c.media);
  const audible = audioClips.filter((c) => heard.has(c.track));
  if (audioClips.length > 0 && audible.length === 0) add(warnings, "all_muted", "Every track that has sound is muted (or another track is on solo), so the export will be silent.");
  else if (audioClips.length > audible.length) add(warnings, "some_muted", `${audioClips.length - audible.length} sound clip${audioClips.length - audible.length === 1 ? " is" : "s are"} on a muted track and will not be heard.`);
  const total = Math.max(0, ...shots.map((c) => c.startMs + c.durationMs));
  const late = audible.filter((c) => c.startMs + c.durationMs > total + 100);
  if (late.length) add(warnings, "audio_past_end", `${late.length} sound clip${late.length === 1 ? " runs" : "s run"} past the end of the picture and will be cut off.`);
  return {
    ok: errors.length === 0, errors, warnings, snapshotId: snap.id, version: snap.version, expectedDurationMs: total,
    contains: { placeholders: placeholderClips.length, unapprovedMedia: unapproved.length, approvedOnly: placeholderClips.length === 0 && unapproved.length === 0 },
    audibleClips: audible.length,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export async function probeDurationMs(bin, file) {
  return new Promise((resolve) => {
    const p = spawn(bin, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", () => resolve(null));
    p.on("exit", () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
      resolve(m ? Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) : null);
    });
  });
}

const sec = (ms) => (ms / 1000).toFixed(3);

export function createSnapshotExporter({ db, store, env = process.env }) {
  async function download(mediaId, dir, name) {
    const opened = await store.openMedia(mediaId);
    if (!opened || opened.unavailable) throw new Error(`File #${mediaId} could not be read from storage.`);
    const file = path.join(dir, `${name}${path.extname(opened.row.stored_name)}`);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      opened.stream.on("error", reject); out.on("error", reject); out.on("finish", resolve);
      opened.stream.pipe(out);
    });
    return file;
  }

  async function renderPicture(bin, shots, files, size, tmp, onStep) {
    const [w, h] = size;
    const scale = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p`;
    const encode = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-r", "24"];
    const parts = [];
    let cursor = 0;
    let n = 0;
    const black = async (ms, color) => {
      const out = path.join(tmp, `p${++n}.mp4`);
      await runFfmpeg(bin, ["-f", "lavfi", "-t", sec(ms), "-i", `color=c=${color}:s=${w}x${h}:r=24`, ...encode, out]);
      parts.push(out);
    };
    for (const c of shots) {
      onStep?.(c);
      if (c.startMs > cursor + 20) await black(c.startMs - cursor, "black"); // a gap the editor left: black
      const out = path.join(tmp, `p${++n}.mp4`);
      const file = c.media?.mediaId ? files.get(c.media.mediaId) : null;
      if (!file) await black(c.durationMs, "0x202020");
      else if (c.media.type === "video") {
        await runFfmpeg(bin, ["-ss", sec(c.sourceInMs), "-i", file, "-vf", `${scale},tpad=stop_mode=clone:stop_duration=120`, "-t", sec(c.durationMs), ...encode, out]);
        parts.push(out);
      } else {
        await runFfmpeg(bin, ["-loop", "1", "-framerate", "24", "-i", file, "-vf", scale, "-t", sec(c.durationMs), ...encode, out]);
        parts.push(out);
      }
      cursor = c.startMs + c.durationMs;
    }
    const list = path.join(tmp, "parts.txt");
    await fs.promises.writeFile(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
    const picture = path.join(tmp, "picture.mp4");
    await runFfmpeg(bin, ["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", picture]);
    return picture;
  }

  async function mixAudio(bin, clips, files, totalMs, tmp) {
    const out = path.join(tmp, "mix.m4a");
    if (clips.length === 0) {
      await runFfmpeg(bin, ["-f", "lavfi", "-t", sec(totalMs), "-i", "anullsrc=r=44100:cl=stereo", "-c:a", "aac", out]);
      return out;
    }
    const args = [];
    const chains = [];
    clips.forEach((c, i) => {
      args.push("-ss", sec(c.sourceInMs), "-i", files.get(c.media.mediaId));
      const delay = Math.max(0, Math.round(c.startMs));
      chains.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo,atrim=duration=${sec(c.durationMs)},asetpts=PTS-STARTPTS,adelay=${delay}|${delay}[a${i}]`);
    });
    const mixed = chains.length === 1 ? "[a0]anull[m]" : `${clips.map((_, i) => `[a${i}]`).join("")}amix=inputs=${clips.length}:duration=longest:normalize=0[m]`;
    args.push("-filter_complex", `${chains.join(";")};${mixed};[m]apad,atrim=duration=${sec(totalMs)}[outa]`, "-map", "[outa]", "-c:a", "aac", "-ar", "44100", "-ac", "2", out);
    await runFfmpeg(bin, args);
    return out;
  }

  async function run(row, projectId, snap, options, actorUserId) {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "filmybase-tlexport-"));
    try {
      const validation = await validateSnapshot(db, store, projectId, snap.id, options);
      if (!validation.ok) {
        await db.query("UPDATE production_exports SET status = 'failed', error = $1, report = $2, finished_at = now() WHERE id = $3", [validation.errors.map((e) => e.message).join(" ").slice(0, 800), JSON.stringify({ validation }), row.id]);
        return;
      }
      const { clips, tracks } = snap.layout;
      const settings = await getSettings(db, projectId);
      const size = SIZES[settings.aspectRatio] ?? SIZES["16:9"];
      const shots = clips.filter((c) => c.kind === "shot").sort((a, b) => a.startMs - b.startMs);
      const heard = audibleTracks(tracks);
      const audio = clips.filter((c) => c.trackKind !== "video" && c.media && heard.has(c.track)).sort((a, b) => a.startMs - b.startMs);
      const ids = new Set(clips.filter((c) => c.media?.mediaId).map((c) => c.media.mediaId));
      const files = new Map();
      let k = 0;
      for (const id of ids) files.set(id, await download(id, tmp, `m${++k}`));
      const totalMs = validation.expectedDurationMs;
      const bin = await findFfmpeg(env);
      let videoMedia = null;
      let durationCheck = null;
      let note = null;
      if (bin) {
        const picture = await renderPicture(bin, shots, files, size, tmp);
        const mix = await mixAudio(bin, audio, files, totalMs, tmp);
        const cut = path.join(tmp, "rough-cut.mp4");
        await runFfmpeg(bin, ["-i", picture, "-i", mix, "-map", "0:v", "-map", "1:a", "-t", sec(totalMs), "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", cut]);
        const measured = await probeDurationMs(bin, cut);
        durationCheck = { expectedMs: totalMs, measuredMs: measured, withinTolerance: measured !== null && Math.abs(measured - totalMs) <= 700 };
        videoMedia = await store.putMedia({ projectId, role: "export", filePath: cut, originalName: `timeline-v${snap.version}.mp4`, label: `timeline-v${snap.version}-${row.id}`, subfolder: "Rough cuts", createdBy: actorUserId });
      } else {
        note = "The rough-cut video could not be made because ffmpeg is not installed on the server. The edit package was made instead.";
      }
      // edit package: the snapshot itself, a shot list with times, and the media
      const zip = new AdmZip();
      const names = new Map();
      for (const [id, file] of files) { const name = `media/${path.basename(file)}`; names.set(id, name); zip.addLocalFile(file, "media"); }
      const csvRows = [["Track", "Clip", "Start (s)", "Length (s)", "Source in (s)", "State", "File"]];
      for (const c of clips.sort((a, b) => a.startMs - b.startMs)) csvRows.push([c.track, c.shotRef ?? c.label, sec(c.startMs), sec(c.durationMs), sec(c.sourceInMs), c.placeholder ? "PLACEHOLDER" : c.unapprovedMedia ? "not approved" : "approved", c.media ? names.get(c.media.mediaId) ?? "" : ""]);
      zip.addFile("timeline.csv", Buffer.from(csvRows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")).join("\n") + "\n"));
      zip.addFile("timeline.json", Buffer.from(JSON.stringify({ snapshot: { id: snap.id, version: snap.version, label: snap.label, savedAt: snap.created_at }, summary: snap.summary, tracks, clips, mediaFiles: Object.fromEntries([...names].map(([id, n]) => [id, n])) }, null, 2)));
      zip.addFile("README.txt", Buffer.from(`Edit package for timeline snapshot v${snap.version}.\n\n${validation.contains.approvedOnly ? "Every clip uses approved media." : `This timeline contains ${validation.contains.placeholders} placeholder shot(s) and ${validation.contains.unapprovedMedia} clip(s) using media that is not the approved one.`}\n\ntimeline.csv lists every clip with its track, start, length and file. timeline.json is the exact saved timeline.\n`));
      const zipFile = path.join(tmp, "edit-package.zip");
      zip.writeZip(zipFile);
      const packageMedia = await store.putMedia({ projectId, role: "export", filePath: zipFile, originalName: `edit-package-timeline-v${snap.version}.zip`, label: `edit-package-timeline-v${snap.version}-${row.id}`, subfolder: "Edit packages", createdBy: actorUserId });
      const report = { validation, durationCheck, containsPlaceholders: validation.contains.placeholders > 0, approvedOnly: validation.contains.approvedOnly, audibleClips: audio.length };
      await db.query(
        "UPDATE production_exports SET status = 'ready', video_media_id = $1, package_media_id = $2, manifest = $3, report = $4, note = $5, finished_at = now() WHERE id = $6",
        [videoMedia?.id ?? null, packageMedia.id, JSON.stringify({ shots: shots.length, used: shots.length - validation.contains.placeholders, gaps: validation.warnings.map((w) => w.message), includeMedia: true, snapshotVersion: snap.version }), JSON.stringify(report), note, row.id]
      );
    } finally {
      fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    async start(projectId, snapshotId, { placeholders = "black", actorUserId = null } = {}) {
      const snap = await loadSnapshot(db, projectId, snapshotId);
      if (!["black", "refuse"].includes(placeholders)) throw httpError('placeholders must be "black" or "refuse".', 400);
      const busy = (await db.query("SELECT 1 FROM production_exports WHERE project_id = $1 AND status = 'running'", [projectId])).rowCount > 0;
      if (busy) throw httpError("An export is already running for this project. Wait for it to finish.", 409, "already_running");
      let row;
      try {
        row = (await db.query("INSERT INTO production_exports (project_id, created_by, snapshot_id) VALUES ($1,$2,$3) RETURNING *", [projectId, actorUserId, snap.id])).rows[0];
      } catch (error) { throw error; }
      const done = run(row, projectId, snap, { placeholders }, actorUserId).catch(async (error) => {
        await db.query("UPDATE production_exports SET status = 'failed', error = $1, finished_at = now() WHERE id = $2", [String(error.message ?? error).slice(0, 800), row.id]);
      }).finally(() => publish(projectId, { type: "export_finished", exportId: row.id }));
      return { row, done };
    },
  };
}

export function registerTimelineExportRoutes(app, db, requireRole, { store, env = process.env }) {
  const admin = requireRole("admin");
  const exporter = createSnapshotExporter({ db, store, env });
  const id = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error("Timeline export route failed:", error);
      res.status(status).json({ error: status >= 500 && !error.status ? "Something went wrong on the server." : error.message, code: error.code ?? null });
    }
  };
  const project = async (req) => {
    const projectId = id(req.params.projectId);
    if (!projectId) throw httpError("Not a valid project.", 400);
    if ((await db.query("SELECT 1 FROM ai_movie_projects WHERE id = $1", [projectId])).rowCount === 0) throw httpError("Project not found.", 404);
    return projectId;
  };
  app.post("/api/production/:projectId/timeline/snapshots", admin, wrap(async (req, res) => res.status(201).json({ snapshot: await saveSnapshot(db, await project(req), { label: req.body?.label, actorUserId: req.user?.id }) })));
  app.get("/api/production/:projectId/timeline/snapshots", admin, wrap(async (req, res) => res.json({ snapshots: await listSnapshots(db, await project(req)), ffmpeg: Boolean(await findFfmpeg(env)) })));
  app.get("/api/production/:projectId/timeline/snapshots/:snapshotId", admin, wrap(async (req, res) => {
    const row = await loadSnapshot(db, await project(req), id(req.params.snapshotId) ?? 0);
    res.json({ id: row.id, version: row.version, label: row.label, createdAt: row.created_at, editRevision: row.edit_revision, summary: row.summary, layout: row.layout });
  }));
  app.get("/api/production/:projectId/timeline/snapshots/:snapshotId/validate", admin, wrap(async (req, res) => {
    res.json(await validateSnapshot(db, store, await project(req), id(req.params.snapshotId) ?? 0, { placeholders: req.query.placeholders === "refuse" ? "refuse" : "black" }));
  }));
  app.post("/api/production/:projectId/timeline/snapshots/:snapshotId/export", admin, wrap(async (req, res) => {
    const { row } = await exporter.start(await project(req), id(req.params.snapshotId) ?? 0, { placeholders: req.body?.placeholders === "refuse" ? "refuse" : "black", actorUserId: req.user?.id });
    res.status(202).json({ export: { id: row.id, status: row.status } });
  }));
}
