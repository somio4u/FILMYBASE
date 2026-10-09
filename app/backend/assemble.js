// Pipeline step 8: assemble and export.
//
// Takes everything approved so far — for each shot, its chosen video take (or
// its approved still picture when there is no video yet) and the approved
// voices of its dialogue lines — and makes:
//   * a rough-cut video (.mp4), if the ffmpeg program is available, and
//   * an "edit package" (.zip): shot list (CSV), a manifest (JSON) and the media
//     files, ready to open in a normal video editor.
// Both are saved to the project's "07 Exports" Drive folder. Anything missing
// is listed as a "gap" instead of being silently skipped.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { getSettings } from "./pipelineSettings.js";

const httpError = (message, status = 400, code = "bad_request") => Object.assign(new Error(message), { status, code });
const SIZES = { "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [1024, 1024], "4:3": [960, 720], "3:4": [720, 960] };
const GAP_SECONDS = 0.3;
const PACKAGE_MEDIA_LIMIT = 150 * 1024 * 1024;

export async function ensureExportSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS production_exports (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
    scene_id INTEGER REFERENCES production_scenes(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ready','failed')),
    video_media_id INTEGER REFERENCES production_media_files(id) ON DELETE SET NULL,
    package_media_id INTEGER REFERENCES production_media_files(id) ON DELETE SET NULL,
    manifest JSONB,
    note TEXT,
    error TEXT,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
  )`);
}

export async function failStaleExports(db) {
  await db.query("UPDATE production_exports SET status = 'failed', error = 'The server restarted while this was being made. Press Export again.', finished_at = now() WHERE status = 'running'");
}

let ffmpegCache;
export async function findFfmpeg(env = process.env) {
  if (ffmpegCache !== undefined && !env.FFMPEG_PATH) return ffmpegCache;
  const candidates = [];
  if (env.FFMPEG_PATH) candidates.push(env.FFMPEG_PATH);
  try {
    const mod = await import("ffmpeg-static");
    if (mod.default) candidates.push(mod.default);
  } catch { /* optional */ }
  candidates.push("ffmpeg");
  for (const bin of candidates) {
    const ok = await new Promise((resolve) => {
      const p = spawn(bin, ["-version"], { stdio: "ignore" });
      p.on("error", () => resolve(false));
      p.on("exit", (code) => resolve(code === 0));
    });
    if (ok) { if (!env.FFMPEG_PATH) ffmpegCache = bin; return bin; }
  }
  if (!env.FFMPEG_PATH) ffmpegCache = null;
  return null;
}

function runFfmpeg(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    p.on("error", (e) => reject(new Error(`ffmpeg could not start: ${e.message}`)));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.trim().split("\n").slice(-3).join(" ") || `exit ${code}`}`))));
  });
}

// ---------------------------------------------------------------------------
// The plan: what goes in, what is missing (pure given the data)
// ---------------------------------------------------------------------------

// shots: from listShots. gens: from generation list (approved + ready only).
export function buildPlan(shots, gens) {
  const approved = gens.filter((g) => g.review === "approved" && g.status === "ready" && g.mediaId);
  const items = [];
  const gaps = [];
  for (const s of shots) {
    const video = approved.find((g) => g.kind === "video" && g.shotId === s.id);
    const still = approved.find((g) => g.kind === "keyframe" && g.shotId === s.id);
    const audio = s.dialogue.map((d) => ({ d, g: approved.find((g) => g.kind === "audio" && g.elementId === d.id) }));
    const visual = video ? "video" : still ? "still" : null;
    const voices = audio.filter((a) => a.g).map((a) => ({ code: a.d.code, speaker: a.d.speaker, mediaId: a.g.mediaId, durationMs: a.g.durationMs ?? null }));
    if (!visual) gaps.push(`${s.code} (scene ${s.sceneNumber}): no approved video take or picture yet`);
    for (const a of audio) if (!a.g) gaps.push(`${s.code}: dialogue ${a.d.code} (${a.d.speaker}) has no approved voice yet`);
    items.push({
      shotId: s.id, code: s.code, number: s.number, sceneCode: s.sceneCode, sceneNumber: s.sceneNumber, framing: s.framing, description: s.description,
      durationSec: s.durationSec, visual, visualMediaId: video?.mediaId ?? still?.mediaId ?? null, voices,
    });
  }
  return { items, gaps, usable: items.filter((i) => i.visual).length };
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function shotListCsv(plan) {
  const rows = [["Scene", "Shot", "Code", "Framing", "Length (s)", "Picture source", "Picture file", "Voice files", "Description"]];
  for (const i of plan.items) rows.push([i.sceneNumber, i.number, i.code, i.framing, i.durationSec, i.visual ?? "MISSING", i.visualFile ?? "", (i.voices ?? []).map((v) => v.file ?? "").join(" | "), i.description]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createAssembler({ db, store, listShots, listGenerations, env = process.env }) {
  async function download(mediaId, dir, name) {
    const opened = await store.openMedia(mediaId);
    if (!opened || opened.unavailable) throw new Error("A file could not be read from storage.");
    const file = path.join(dir, `${name}${path.extname(opened.row.stored_name)}`);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      opened.stream.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      opened.stream.pipe(out);
    });
    return { file, row: opened.row };
  }

  async function gather(projectId, sceneId) {
    const shots = await listShots(db, projectId, { sceneId });
    const gens = sceneId ? await listGenerations(projectId, { sceneId }) : await listGenerations(projectId, {});
    return { shots, plan: buildPlan(shots, gens) };
  }

  async function renderClip(bin, item, named, outFile, [w, h]) {
    const voiceFiles = item.voices.map((v) => named.get(v.mediaId)?.file).filter(Boolean);
    const voiceMs = item.voices.reduce((n, v) => n + (v.durationMs ?? 2000) + GAP_SECONDS * 1000, 0);
    const duration = Math.max(item.durationSec, voiceMs / 1000, 1);
    const visual = named.get(item.visualMediaId).file;
    const args = [];
    if (item.visual === "still") args.push("-loop", "1", "-framerate", "24", "-i", visual);
    else args.push("-i", visual);
    for (const v of voiceFiles) args.push("-i", v);
    const scale = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p`;
    const pad = item.visual === "video" ? ",tpad=stop_mode=clone:stop_duration=30" : "";
    let filter = `[0:v]${scale}${pad}[v]`;
    if (voiceFiles.length > 0) {
      const parts = voiceFiles.map((_, i) => `[${i + 1}:a]aresample=44100,aformat=channel_layouts=stereo,apad=pad_dur=${GAP_SECONDS}[a${i}]`).join(";");
      filter += `;${parts};${voiceFiles.map((_, i) => `[a${i}]`).join("")}concat=n=${voiceFiles.length}:v=0:a=1,apad[a]`;
    } else {
      filter += `;anullsrc=r=44100:cl=stereo[a]`;
    }
    args.push("-filter_complex", filter, "-map", "[v]", "-map", "[a]", "-t", String(duration), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-ar", "44100", "-ac", "2", "-movflags", "+faststart", outFile);
    await runFfmpeg(bin, args);
  }

  async function run(row, projectId, sceneId, actorUserId) {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "filmybase-export-"));
    try {
      const { shots, plan } = await gather(projectId, sceneId);
      if (plan.usable === 0) throw new Error("Nothing can be assembled yet: no shot has an approved video take or picture.");
      const settings = await getSettings(db, projectId);
      const size = SIZES[settings.aspectRatio] ?? SIZES["16:9"];
      const scope = sceneId ? shots[0]?.sceneCode ?? "scene" : "all";

      // download every file used, once
      const ids = new Set();
      for (const i of plan.items) {
        if (i.visualMediaId) ids.add(i.visualMediaId);
        for (const v of i.voices) ids.add(v.mediaId);
      }
      const named = new Map();
      let n = 0;
      for (const id of ids) named.set(id, await download(id, tmp, `m${++n}`));

      // rough cut
      let videoMedia = null;
      let note = null;
      const bin = await findFfmpeg(env);
      if (bin) {
        const clips = [];
        for (const item of plan.items.filter((i) => i.visual)) {
          const out = path.join(tmp, `clip-${item.code}.mp4`);
          await renderClip(bin, item, named, out, size);
          clips.push(out);
        }
        const listFile = path.join(tmp, "clips.txt");
        await fs.promises.writeFile(listFile, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n"));
        const cut = path.join(tmp, "rough-cut.mp4");
        await runFfmpeg(bin, ["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", cut]);
        videoMedia = await store.putMedia({
          projectId, role: "export", filePath: cut, originalName: `rough-cut-${scope}.mp4`, label: `rough-cut-${scope}-${row.id}`, subfolder: `Rough cuts`, createdBy: actorUserId,
        });
      } else {
        note = "The rough-cut video could not be made because the video-joining program (ffmpeg) is not installed on the server. The edit package was made instead.";
      }

      // edit package (zip)
      const zip = new AdmZip();
      let total = 0;
      for (const [, v] of named) total += (await fs.promises.stat(v.file)).size;
      const includeMedia = total <= PACKAGE_MEDIA_LIMIT;
      const packaged = { ...plan, items: plan.items.map((i) => ({ ...i, voices: i.voices.map((v) => ({ ...v })) })) };
      if (includeMedia) {
        for (const i of packaged.items) {
          if (i.visualMediaId) {
            const v = named.get(i.visualMediaId);
            i.visualFile = `media/${i.code}_${i.visual}${path.extname(v.file)}`;
            zip.addLocalFile(v.file, "media", path.basename(i.visualFile));
          }
          for (const voice of i.voices) {
            const v = named.get(voice.mediaId);
            voice.file = `media/${i.code}_${voice.code}${path.extname(v.file)}`;
            zip.addLocalFile(v.file, "media", path.basename(voice.file));
          }
        }
      }
      zip.addFile("shotlist.csv", Buffer.from(shotListCsv(packaged)));
      zip.addFile("manifest.json", Buffer.from(JSON.stringify({ project: projectId, scope, aspectRatio: settings.aspectRatio, madeAt: new Date().toISOString(), includeMedia, ...packaged }, null, 2)));
      zip.addFile("README.txt", Buffer.from("Edit package\n\nshotlist.csv lists every shot in order with its picture/video and voice files.\nThe media folder holds the files. Import them into your video editor in the order of the list.\nGaps (missing items) are listed in manifest.json.\n"));
      const zipFile = path.join(tmp, "edit-package.zip");
      zip.writeZip(zipFile);
      const packageMedia = await store.putMedia({
        projectId, role: "export", filePath: zipFile, originalName: `edit-package-${scope}.zip`, label: `edit-package-${scope}-${row.id}`, subfolder: "Edit packages", createdBy: actorUserId,
      });
      await db.query(
        "UPDATE production_exports SET status = 'ready', video_media_id = $1, package_media_id = $2, manifest = $3, note = $4, finished_at = now() WHERE id = $5",
        [videoMedia?.id ?? null, packageMedia.id, JSON.stringify({ shots: plan.items.length, used: plan.usable, gaps: plan.gaps, includeMedia }), note, row.id]
      );
    } finally {
      fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    async plan(projectId, sceneId = null) {
      const { plan } = await gather(projectId, sceneId);
      return { shots: plan.items.length, usable: plan.usable, gaps: plan.gaps, ffmpeg: Boolean(await findFfmpeg(env)) };
    },

    async start(projectId, { sceneId = null, actorUserId = null } = {}) {
      if (sceneId) {
        const ok = (await db.query("SELECT 1 FROM production_scenes WHERE id = $1 AND project_id = $2", [sceneId, projectId])).rowCount > 0;
        if (!ok) throw httpError("Scene not found.", 404, "not_found");
      }
      const busy = (await db.query("SELECT 1 FROM production_exports WHERE project_id = $1 AND status = 'running'", [projectId])).rowCount > 0;
      if (busy) throw httpError("An export is already running for this project. Wait for it to finish.", 409, "already_running");
      const { plan } = await gather(projectId, sceneId);
      if (plan.usable === 0) throw httpError("Nothing can be assembled yet: no shot has an approved video take or picture.", 409, "nothing_to_assemble");
      const row = (await db.query("INSERT INTO production_exports (project_id, scene_id, created_by) VALUES ($1,$2,$3) RETURNING *", [projectId, sceneId, actorUserId])).rows[0];
      const done = run(row, projectId, sceneId, actorUserId).catch(async (error) => {
        await db.query("UPDATE production_exports SET status = 'failed', error = $1, finished_at = now() WHERE id = $2", [String(error.message ?? error).slice(0, 800), row.id]);
      });
      return { row, done };
    },

    async list(projectId) {
      return (await db.query(
        `SELECT e.*, s.code AS scene_code FROM production_exports e LEFT JOIN production_scenes s ON s.id = e.scene_id WHERE e.project_id = $1 ORDER BY e.id DESC LIMIT 50`, [projectId]
      )).rows.map((e) => ({
        id: e.id, sceneId: e.scene_id, sceneCode: e.scene_code, status: e.status, videoUrl: e.video_media_id ? `/api/production/media/${e.video_media_id}` : null,
        packageUrl: e.package_media_id ? `/api/production/media/${e.package_media_id}` : null, manifest: e.manifest, note: e.note, error: e.error, createdAt: e.created_at, finishedAt: e.finished_at,
      }));
    },
  };
}
