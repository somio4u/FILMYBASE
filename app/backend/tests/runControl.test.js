// Stopping a running story: the job really ends at its next step, and a resumed job runs alone.
import test from "node:test";
import assert from "node:assert/strict";
import { RunStopped, assertRunActive, inRunContext, stopRunJobs } from "../runControl.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// a job that works in steps, checking in before each one (as every AI call and save does)
function job(log, name, steps = 20) {
  return async () => {
    try {
      for (let i = 1; i <= steps; i += 1) { assertRunActive(); await tick(); log.push(`${name}:${i}`); }
      log.push(`${name}:done`);
    } catch (error) {
      if (error instanceof RunStopped) { log.push(`${name}:stopped`); return; }
      throw error;
    }
  };
}

test("stopping ends the job at its next step; nothing more is done after that", async () => {
  const log = [];
  const running = inRunContext(7001, job(log, "a"));
  await tick(30); stopRunJobs(7001);
  const at = log.length;
  await running;
  assert.equal(log.at(-1), "a:stopped"); assert.ok(log.length <= at + 2, "it stopped within a step or two");
  assert.ok(!log.includes("a:done"));
});

test("a job that was stopped and a job that was resumed never run together; only the new one finishes", async () => {
  const log = [];
  const oldJob = inRunContext(7002, job(log, "old", 40));
  await tick(25);
  stopRunJobs(7002);                                  // the user pressed Stop
  const newJob = inRunContext(7002, job(log, "new", 5)); // ...then Resume right away, while the old job is still winding down
  await Promise.all([oldJob, newJob]);
  assert.ok(log.includes("old:stopped") && !log.includes("old:done"));
  assert.ok(log.includes("new:done"), "the resumed job ran to the end");
  const lastOld = log.map((x, i) => [x, i]).filter(([x]) => x.startsWith("old:") && x !== "old:stopped").map(([, i]) => i).at(-1);
  const firstNew = log.findIndex((x) => x.startsWith("new:"));
  assert.ok(lastOld === undefined || firstNew === -1 || lastOld < firstNew + 2, "the old job did not keep working alongside the new one");
});

test("other runs are not affected; outside a run the check does nothing", async () => {
  const log = [];
  const other = inRunContext(7003, job(log, "other", 5));
  stopRunJobs(7004);
  await other;
  assert.ok(log.includes("other:done"));
  assert.doesNotThrow(() => assertRunActive());
});
