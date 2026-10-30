import test from "node:test";
import assert from "node:assert/strict";
import { ADD_KIND, createWriteScenesJobs, publicView, WRITE_KIND } from "../writeScenesJobs.js";

function fakeStore() {
  const rows = new Map();
  let clock = Date.now();
  return {
    rows,
    async insert(id, kind, sceneListId, key, state) { rows.set(id, { id, kind, sceneListId, key, status: "running", state: JSON.parse(JSON.stringify(state)), resumes: 0, startedAt: clock++, finishedAt: null }); },
    async save(id, state, status) { const r = rows.get(id); r.state = JSON.parse(JSON.stringify(state)); r.status = status; if (status !== "running") r.finishedAt = clock++; },
    async get(id) { return rows.get(id) ?? null; },
    async latest(kind, sceneListId, key) { return [...rows.values()].filter((r) => r.kind === kind && r.sceneListId === sceneListId && String(r.key) === String(key)).sort((a, b) => b.startedAt - a.startedAt).map((r) => ({ ...r }))[0] ?? null; },
    async running(kind) { return [...rows.values()].filter((r) => r.kind === kind && r.status === "running").map((r) => ({ ...r })); },
    async countResume(id) { rows.get(id).resumes += 1; },
  };
}
const quiet = { error() {}, log() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settled(jobs, id) { for (let i = 0; i < 200; i++) { const j = await jobs.get(id); if (j.status !== "running") return j; await tick(); } throw new Error("job did not finish"); }
const items = (n) => Array.from({ length: n }, (_, i) => ({ episodeIndex: null, sceneIndex: i, label: String(i + 1), heading: `INT. PLACE ${i + 1} - DAY` }));

test("scenes are written one after the other, progress is visible meanwhile, and the answer to start comes at once", async () => {
  const store = fakeStore();
  const written = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const jobs = createWriteScenesJobs({ jobStore: store, log: quiet, isWritten: async () => false, writeOne: async (item) => { if (item.sceneIndex === 1) await gate; written.push(item.sceneIndex); } });
  const { job, alreadyRunning } = await jobs.start({ sceneListId: 5, userId: 1, items: items(3), language: "or" });
  assert.equal(alreadyRunning, false);
  assert.equal(job.status, "running");
  for (let i = 0; i < 10; i++) await tick();
  const mid = publicView(await jobs.get(job.id));
  assert.equal(mid.status, "running");
  assert.equal(mid.total, 3);
  assert.equal(mid.done, 1);
  assert.match(mid.step, /Writing scene 2 \(2 of 3\) — INT\. PLACE 2 - DAY/);
  assert.equal(mid.current.sceneIndex, 1);
  release();
  const end = publicView(await settled(jobs, job.id));
  assert.equal(end.status, "done");
  assert.equal(end.done, 3);
  assert.deepEqual(written, [0, 1, 2]);
  assert.equal(store.rows.get(job.id).status, "done");
});

test("a second start while one is running returns the running job (no scene is written twice)", async () => {
  const store = fakeStore();
  let release; const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const jobs = createWriteScenesJobs({ jobStore: store, log: quiet, isWritten: async () => false, writeOne: async () => { calls += 1; await gate; } });
  const a = await jobs.start({ sceneListId: 5, userId: 1, items: items(2), language: "or" });
  const b = await jobs.start({ sceneListId: 5, userId: 1, items: items(2), language: "or" });
  assert.equal(b.alreadyRunning, true);
  assert.equal(b.job.id, a.job.id);
  release();
  await settled(jobs, a.job.id);
  assert.equal(calls, 2);
  // another scene list is independent
  const c = await jobs.start({ sceneListId: 6, userId: 1, items: items(1), language: "or" });
  assert.equal(c.alreadyRunning, false);
});

test("a scene that is already written is skipped; one that fails is reported and the rest carry on", async () => {
  const store = fakeStore();
  const jobs = createWriteScenesJobs({
    jobStore: store, log: quiet,
    isWritten: async (item) => item.sceneIndex === 0,
    writeOne: async (item) => { if (item.sceneIndex === 1) throw new Error("The AI is busy"); },
  });
  const { job } = await jobs.start({ sceneListId: 5, userId: 1, items: items(3), language: "or" });
  const end = publicView(await settled(jobs, job.id));
  assert.equal(end.status, "done");
  assert.equal(end.done, 2); // scene 1 skipped (counted as done), scene 3 written
  assert.deepEqual(end.failed.map((f) => [f.label, f.error]), [["2", "The AI is busy"]]);
});

test("three scenes in a row that fail stop the job with a plain reason", async () => {
  const store = fakeStore();
  let calls = 0;
  const jobs = createWriteScenesJobs({ jobStore: store, log: quiet, isWritten: async () => false, writeOne: async () => { calls += 1; throw new Error("billing account is not active"); } });
  const { job } = await jobs.start({ sceneListId: 5, userId: 1, items: items(6), language: "or" });
  const end = publicView(await settled(jobs, job.id));
  assert.equal(end.status, "error");
  assert.equal(calls, 3);
  assert.match(end.error, /Three scenes in a row could not be written[\s\S]*billing account/);
});

test("Stop ends the job after the scene being written; what is written stays", async () => {
  const store = fakeStore();
  let release; const gate = new Promise((r) => { release = r; });
  const written = [];
  const jobs = createWriteScenesJobs({ jobStore: store, log: quiet, isWritten: async () => false, writeOne: async (item) => { if (item.sceneIndex === 0) await gate; written.push(item.sceneIndex); } });
  const { job } = await jobs.start({ sceneListId: 5, userId: 1, items: items(4), language: "or" });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(await jobs.stop(job.id), true);
  assert.match(publicView(await jobs.get(job.id)).step, /Stopping/);
  release();
  const end = publicView(await settled(jobs, job.id));
  assert.equal(end.status, "stopped");
  assert.deepEqual(written, [0]);
  assert.equal(end.done, 1);
  assert.equal(await jobs.stop(job.id), false); // nothing left to stop
});

test("after a server restart the job carries on and skips scenes already written; a job restarted too often is given up", async () => {
  const store = fakeStore();
  const writtenAlready = new Set([0, 1]);
  const first = createWriteScenesJobs({ jobStore: store, log: quiet, isWritten: async (i) => writtenAlready.has(i.sceneIndex), writeOne: async () => new Promise(() => {}) }); // hangs: the "server" dies
  const { job } = await first.start({ sceneListId: 5, userId: 1, items: items(4), language: "or" });
  for (let i = 0; i < 10; i++) await tick();
  const written = [];
  const second = createWriteScenesJobs({ jobStore: store, log: quiet, isWritten: async (i) => writtenAlready.has(i.sceneIndex), writeOne: async (i) => { written.push(i.sceneIndex); writtenAlready.add(i.sceneIndex); } });
  await second.resume();
  const end = await settled(second, job.id);
  assert.equal(end.status, "done");
  assert.deepEqual(written, [2, 3]);
  assert.match(end.notice, /restart 1/);
  // too many restarts
  const store2 = fakeStore();
  const x = createWriteScenesJobs({ jobStore: store2, log: quiet, isWritten: async () => false, writeOne: async () => new Promise(() => {}) });
  const started = await x.start({ sceneListId: 9, userId: 1, items: items(2), language: "or" });
  store2.rows.get(started.job.id).resumes = 3;
  const y = createWriteScenesJobs({ jobStore: store2, log: quiet, isWritten: async () => false, writeOne: async () => {} });
  await y.resume();
  const gaveUp = publicView(await y.get(started.job.id));
  assert.equal(gaveUp.status, "error");
  assert.match(gaveUp.error, /given up/);
});

test("a reloaded screen finds the newest job of its scene list, and the kind is stable", async () => {
  const store = fakeStore();
  const jobs = createWriteScenesJobs({ jobStore: store, log: quiet, isWritten: async () => false, writeOne: async () => {} });
  const a = await jobs.start({ sceneListId: 5, userId: 1, items: items(1), language: "or" });
  await settled(jobs, a.job.id);
  const b = await jobs.start({ sceneListId: 5, userId: 1, items: items(2), language: "or" });
  await settled(jobs, b.job.id);
  const fresh = createWriteScenesJobs({ jobStore: store, log: quiet, isWritten: async () => false, writeOne: async () => {} }); // a restarted server: only the database remembers
  const found = publicView(await fresh.currentFor(5));
  assert.equal(found.jobId, b.job.id);
  assert.equal(found.total, 2);
  assert.equal(WRITE_KIND, "write-scenes");
  assert.equal(await fresh.currentFor(77), null);
});

test("another kind of job (adding scenes) has its own table kind, its own sentence, rewrites are marked, and the view says the kind", async () => {
  const store = fakeStore();
  const jobs = createWriteScenesJobs({ jobStore: store, kind: ADD_KIND, log: quiet, isWritten: async () => false, describe: (item, n, total) => `Planning ${item.count} new scenes (part ${n} of ${total})`, writeOne: async () => {} });
  const a = await jobs.start({ sceneListId: 5, userId: 1, items: [{ episodeIndex: null, sceneIndex: 0, label: "+10", count: 10 }, { episodeIndex: null, sceneIndex: 1, label: "+15", count: 5 }], language: "or" });
  const end = publicView(await settled(jobs, a.job.id));
  assert.equal(end.kind, "add-scenes");
  assert.equal(end.status, "done");
  assert.equal(store.rows.get(a.job.id).kind, "add-scenes");
  assert.equal(ADD_KIND, "add-scenes");
  // a write job of the same scene list is a different job (kinds do not mix)
  const write = createWriteScenesJobs({ jobStore: store, log: quiet, isWritten: async () => false, writeOne: async () => {} });
  assert.equal(await write.currentFor(5), null);
  // rewrite items are never skipped as "already written" and are marked in the done list
  const rewriting = createWriteScenesJobs({ jobStore: store, log: quiet, isWritten: async (i) => !i.rewrite, writeOne: async () => {} });
  const r = await rewriting.start({ sceneListId: 6, userId: 1, items: [{ episodeIndex: null, sceneIndex: 3, label: "4", rewrite: true, feedback: "tenser" }], language: "or" });
  await settled(rewriting, r.job.id);
  const stored = store.rows.get(r.job.id).state;
  assert.equal(stored.done[0].rewrite, true);
  assert.equal(stored.done[0].skipped, undefined);
});
