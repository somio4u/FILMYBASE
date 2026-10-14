// STOP / RESUME for a running story. Each running job carries the "generation" of its run. Stopping a run raises the generation, so the old job
// notices at its next step (before every AI call and every save) and quietly ends. Resuming starts a NEW job on the new generation, so the
// old and the new job can never both run.
import { AsyncLocalStorage } from "node:async_hooks";

const runContext = new AsyncLocalStorage();
const runGeneration = new Map();

export class RunStopped extends Error {
  constructor() { super("This run was stopped."); this.name = "RunStopped"; }
}

// Called at every step of a running job. Does nothing outside a run.
export function assertRunActive() {
  const c = runContext.getStore();
  if (c && (runGeneration.get(c.runId) ?? 0) !== c.gen) throw new RunStopped();
}

// Runs fn as a job of this run (on the run's current generation).
export const inRunContext = (runId, fn) => runContext.run({ runId: Number(runId), gen: runGeneration.get(Number(runId)) ?? 0 }, fn);

// Makes every job started so far for this run end at its next step.
export function stopRunJobs(runId) {
  runGeneration.set(Number(runId), (runGeneration.get(Number(runId)) ?? 0) + 1);
}
