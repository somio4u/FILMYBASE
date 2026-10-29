// "Let's go" on the Idea screen when the writer starts FROM a synopsis / bit sheet / scene one-liners (film, web series, vertical drama):
// it reads the pasted text with AI and makes the project. That takes minutes, so it is a BACKGROUND job: the request only starts it and
// returns at once; the screen follows it (what it is doing now, how long it has run), picks it up again after a reload, and it survives
// a server restart (the pasted text is kept in the job until it finishes; a job interrupted BEFORE the project was saved starts again,
// one interrupted while saving is reported instead of risking a second copy of the project).
// Jobs live in the same table as the other background jobs (jobStore.js): kind "skip-start", scene_list_id 0, key = the user's id.

import crypto from "node:crypto";
import { shouldResume } from "./jobStore.js";

export const SKIP_KIND = "skip-start";

// what the screen is allowed to see (never the pasted text)
export function publicView(job, now = Date.now()) {
  if (!job) return null;
  return {
    jobId: job.id, stage: job.stage, status: job.status, step: job.step, notice: job.notice ?? "",
    startedAt: job.startedAt, finishedAt: job.finishedAt ?? null, now,
    result: job.status === "done" ? job.result : null,
    error: job.status === "error" ? job.error : null,
  };
}

export function createSkipStartJobs({ jobStore, run, now = () => Date.now(), log = console }) {
  const jobs = new Map(); // id -> job, for the jobs of this server run; the database answers for the rest

  // saves of one job run one after another, so an old "running" save can never land after the final one
  const chains = new Map();
  const persist = (job) => {
    const toSave = { ...job, input: job.status === "running" ? job.input : undefined }; // the pasted text is only needed while the job can still be (re)started
    const next = (chains.get(job.id) ?? Promise.resolve()).then(() => jobStore.save(job.id, toSave, job.status)).catch((error) => log.error("Saving a start job failed:", error.message));
    chains.set(job.id, next);
    return next;
  };

  async function execute(job) {
    const tools = {
      progress: (label) => { job.step = label; persist(job); },
      markSaving: () => { job.saving = true; persist(job); },
    };
    try {
      job.result = await run(job.stage, job.input, tools);
      job.status = "done";
      job.step = "Done";
    } catch (error) {
      log.error(`Start from ${job.stage} failed:`, error.message);
      job.status = "error";
      job.error = error.message ? String(error.message).slice(0, 600) : "The AI could not make the project from this text. Please try again.";
    }
    job.finishedAt = now();
    delete job.input;
    await persist(job);
  }

  const fromRow = (row) => (row ? { id: row.id, ...row.state, status: row.status, startedAt: row.startedAt, finishedAt: row.finishedAt, resumes: row.resumes } : null);

  return {
    // starts a job for this user — or returns the one already running (a double tap must not make two projects)
    async start({ userId, stage, input }) {
      const latest = await this.currentFor(userId);
      if (latest?.status === "running") return { job: latest, alreadyRunning: true };
      const job = { id: crypto.randomUUID(), userId, stage, status: "running", step: "Starting…", startedAt: now(), input, saving: false, notice: "" };
      jobs.set(job.id, job);
      await jobStore.insert(job.id, SKIP_KIND, 0, String(userId), { ...job });
      execute(job); // not awaited: the request is answered now
      return { job, alreadyRunning: false };
    },

    async get(id) {
      const mine = jobs.get(id);
      if (mine) return mine;
      return fromRow(await jobStore.get(id));
    },

    // the newest job of this user (a screen that was reloaded asks for it)
    async currentFor(userId) {
      let best = null;
      for (const job of jobs.values()) if (job.userId === userId && (!best || job.startedAt > best.startedAt)) best = job;
      const stored = fromRow(await jobStore.latest(SKIP_KIND, 0, String(userId)));
      return best && (!stored || best.startedAt >= stored.startedAt) ? best : stored;
    },

    // at server start: jobs that were running when the server stopped
    async resume() {
      for (const row of await jobStore.running(SKIP_KIND)) {
        const job = fromRow(row);
        const verdict = shouldResume(row);
        if (job.saving) {
          job.status = "error"; job.finishedAt = now(); delete job.input;
          job.error = "The server was restarted while your project was being saved. Look in YOUR PROJECTS: it may already be there (then do not start it again).";
          await persist(job);
        } else if (!verdict.resume || !job.input) {
          job.status = "error"; job.finishedAt = now(); delete job.input;
          job.error = `This was given up: ${verdict.resume ? "its text was lost in a restart" : verdict.why}. Your text is not lost from the page — press Let's go again.`;
          await persist(job);
        } else {
          await jobStore.countResume(job.id);
          job.resumes = row.resumes + 1;
          job.notice = `The server was restarted (an update), so this started again from the beginning — restart ${job.resumes}. Nothing was lost.`;
          jobs.set(job.id, job);
          log.log?.(`Resuming the start-from-${job.stage} job of user ${job.userId} (restart ${job.resumes}).`);
          execute(job);
        }
      }
    },
  };
}
