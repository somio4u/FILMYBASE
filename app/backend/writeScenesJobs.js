// "Write the scenes that are not written yet" as a BACKGROUND job (the Buddy offers it; the writer presses Apply). Scenes are written one after the other
// by the same AI writer as the "Write this scene" button. The same machine also runs the other things the Buddy offers that take minutes: writing a
// scene AGAIN with the writer's notes (items marked rewrite) and adding new scene one-liners in batches (kind "add-scenes"). The request only starts the job; the screen follows it: which scene is being written, how many
// are done, how long it has run. It survives a page reload (the job lives on the server) and a server restart (the job starts again and skips every scene
// that is already written), and it can be stopped between two scenes. Jobs live in the shared background_jobs table (jobStore.js): kind "write-scenes".
//
// Everything that touches the database or the AI is passed in, so this file can be tested with a scripted writer and a fake store.
import crypto from "node:crypto";
import { shouldResume } from "./jobStore.js";

export const WRITE_KIND = "write-scenes";
export const ADD_KIND = "add-scenes";
const GIVE_UP_AFTER_FAILURES_IN_A_ROW = 3; // three scenes in a row that could not be written means something is wrong (quota, key): stop and say so

// what the screen may see
export function publicView(job, now = Date.now()) {
  if (!job) return null;
  return {
    jobId: job.id, kind: job.kind ?? WRITE_KIND, sceneListId: job.sceneListId, status: job.status, step: job.step, notice: job.notice ?? "",
    total: job.items.length, done: job.done.length, failed: job.failed, current: job.current ?? null,
    rewrite: job.items.some((item) => item.rewrite), stopRequested: Boolean(job.stopRequested), startedAt: job.startedAt, finishedAt: job.finishedAt ?? null, now,
    error: job.status === "error" ? job.error : null,
  };
}

const keyOf = (item) => `${item.episodeIndex ?? "film"}:${item.sceneIndex}`;
const defaultDescribe = (item, number, total) => `Writing scene ${item.label} (${number} of ${total})${item.heading ? ` — ${item.heading}` : ""}`;

// writeOne(item) writes and saves ONE scene; isWritten(item) says whether a scene already has written lines
// `kind` names the sort of job in the shared table; `describe(item, number, total)` is the plain sentence shown while an item is being worked on
export function createWriteScenesJobs({ jobStore, writeOne, isWritten, kind = WRITE_KIND, describe = defaultDescribe, now = () => Date.now(), log = console }) {
  const jobs = new Map(); // id -> job of this server run; the database answers for the rest
  const chains = new Map();
  const persist = (job) => {
    const next = (chains.get(job.id) ?? Promise.resolve()).then(() => jobStore.save(job.id, job, job.status)).catch((error) => log.error("Saving a write-scenes job failed:", error.message));
    chains.set(job.id, next);
    return next;
  };

  async function execute(job) {
    let failuresInARow = 0;
    try {
      for (const item of job.items) {
        if (job.stopRequested) { job.status = "stopped"; job.step = "Stopped"; break; }
        if (job.done.some((d) => keyOf(d) === keyOf(item)) || job.failed.some((f) => keyOf(f) === keyOf(item))) continue;
        if (await isWritten(item)) { job.done.push({ ...item, skipped: true }); continue; } // already done (written meanwhile by the writer, or before a restart)
        job.current = { ...item, startedAt: now() };
        job.step = describe(item, job.done.length + job.failed.length + 1, job.items.length);
        await persist(job);
        try {
          await writeOne(item);
          job.done.push({ episodeIndex: item.episodeIndex, sceneIndex: item.sceneIndex, label: item.label, ...(item.rewrite ? { rewrite: true } : {}) });
          failuresInARow = 0;
        } catch (error) {
          log.error(`Writing scene ${item.label} failed:`, error.message);
          job.failed.push({ episodeIndex: item.episodeIndex, sceneIndex: item.sceneIndex, label: item.label, error: String(error.message ?? "").slice(0, 300) });
          failuresInARow += 1;
          if (failuresInARow >= GIVE_UP_AFTER_FAILURES_IN_A_ROW) {
            job.status = "error";
            job.error = `Three scenes in a row could not be written, so I stopped. The last reason: ${job.failed.at(-1).error || "unknown"}`;
            break;
          }
        }
        job.current = null;
        await persist(job);
      }
      if (job.status === "running") { job.status = "done"; job.step = "Done"; }
    } catch (error) {
      log.error("A write-scenes job failed:", error.message);
      job.status = "error";
      job.error = String(error.message ?? "The scenes could not be written.").slice(0, 400);
    }
    job.current = null;
    job.finishedAt = now();
    await persist(job);
  }

  const fromRow = (row) => (row ? { ...row.state, id: row.id, status: row.status, startedAt: row.startedAt, finishedAt: row.finishedAt, resumes: row.resumes } : null);

  return {
    // starts a job for this scene list, or returns the one already running (a double tap must not write every scene twice)
    async start({ sceneListId, userId, items, language }) {
      const running = await this.currentFor(sceneListId);
      if (running?.status === "running") return { job: running, alreadyRunning: true };
      const job = { id: crypto.randomUUID(), kind, sceneListId, userId, language, status: "running", step: "Starting…", items, done: [], failed: [], current: null, stopRequested: false, startedAt: now(), notice: "" };
      jobs.set(job.id, job);
      await jobStore.insert(job.id, kind, sceneListId, String(sceneListId), { ...job });
      execute(job); // not awaited: the request is answered now
      return { job, alreadyRunning: false };
    },

    async get(id) {
      return jobs.get(id) ?? fromRow(await jobStore.get(id));
    },

    // the newest job of this scene list (a reloaded screen asks for it)
    async currentFor(sceneListId) {
      let best = null;
      for (const job of jobs.values()) if (job.sceneListId === sceneListId && (!best || job.startedAt > best.startedAt)) best = job;
      const stored = fromRow(await jobStore.latest(kind, sceneListId, String(sceneListId)));
      return best && (!stored || best.startedAt >= stored.startedAt) ? best : stored;
    },

    // "Stop": the scene being written is finished, then the job ends
    async stop(id) {
      const job = jobs.get(id);
      if (!job || job.status !== "running") return false;
      job.stopRequested = true;
      job.step = "Stopping after this scene…";
      await persist(job);
      return true;
    },

    // at server start: jobs that were running when the server stopped start again; scenes already written are skipped
    async resume() {
      for (const row of await jobStore.running(kind)) {
        const job = fromRow(row);
        const verdict = shouldResume(row);
        if (!verdict.resume) {
          job.status = "error"; job.finishedAt = now(); job.current = null;
          job.error = `This was given up: ${verdict.why}. Ask the Buddy to do it again.`;
          await persist(job);
          continue;
        }
        await jobStore.countResume(job.id);
        job.resumes = row.resumes + 1;
        job.current = null;
        job.notice = `The server was restarted (an update), so the writing carried on from where it was — restart ${job.resumes}. Scenes already written are kept.`;
        jobs.set(job.id, job);
        log.log?.(`Resuming the write-scenes job of scene list ${job.sceneListId} (restart ${job.resumes}).`);
        execute(job);
      }
    },
  };
}
