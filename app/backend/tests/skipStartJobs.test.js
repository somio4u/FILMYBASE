import test from "node:test";
import assert from "node:assert/strict";
import { createSkipStartJobs, publicView, SKIP_KIND } from "../skipStartJobs.js";

// a tiny stand-in for the background_jobs table
function fakeStore() {
  const rows = new Map();
  let clock = 1000;
  return {
    rows,
    async insert(id, kind, sceneListId, key, state) { rows.set(id, { id, kind, sceneListId, key, status: "running", state: JSON.parse(JSON.stringify(state)), resumes: 0, startedAt: clock++, finishedAt: null }); },
    async save(id, state, status) { const r = rows.get(id); r.state = JSON.parse(JSON.stringify(state)); r.status = status; if (status !== "running") r.finishedAt = r.finishedAt ?? clock++; },
    async get(id) { return rows.get(id) ?? null; },
    async latest(kind, sceneListId, key) { return [...rows.values()].filter((r) => r.kind === kind && String(r.key) === String(key)).sort((a, b) => b.startedAt - a.startedAt)[0] ?? null; },
    async running(kind) { return [...rows.values()].filter((r) => r.kind === kind && r.status === "running").map((r) => ({ ...r })); }, // copies, like the real table
    async countResume(id) { rows.get(id).resumes += 1; },
  };
}
const quiet = { error() {}, log() {} };
const later = () => new Promise((resolve) => setImmediate(resolve));
const gate = () => { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; };

test("starting answers at once, the job runs on in the background, and the pasted text is dropped when it is finished", async () => {
  const store = fakeStore();
  const g = gate();
  const seen = [];
  const jobs = createSkipStartJobs({ jobStore: store, log: quiet, run: async (stage, input, tools) => { seen.push([stage, input.body.pastedText]); tools.progress("Reading with AI…"); await g.promise; tools.markSaving(); tools.progress("Saving your project…"); return { conceptId: 77 }; } });
  const { job, alreadyRunning } = await jobs.start({ userId: 5, stage: "scenelist", input: { body: { pastedText: "long text" }, ownerUserId: 5 } });
  assert.equal(alreadyRunning, false);
  assert.equal(job.status, "running");
  await later();
  assert.equal((await jobs.get(job.id)).step, "Reading with AI…");
  assert.equal(store.rows.get(job.id).state.input.body.pastedText, "long text"); // kept while it can still be restarted
  g.open();
  await later(); await later();
  const done = await jobs.get(job.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result, { conceptId: 77 });
  assert.equal(store.rows.get(job.id).status, "done");
  assert.equal(store.rows.get(job.id).state.input, undefined);
  assert.deepEqual(seen, [["scenelist", "long text"]]);
  assert.equal(store.rows.get(job.id).kind, SKIP_KIND);
  assert.equal(store.rows.get(job.id).key, "5");
});

test("a second tap while one runs returns the running job, not a second project; another person's job is separate", async () => {
  const store = fakeStore();
  const g = gate(); let runs = 0;
  const jobs = createSkipStartJobs({ jobStore: store, log: quiet, run: async () => { runs++; await g.promise; return { conceptId: 1 }; } });
  const a = await jobs.start({ userId: 5, stage: "synopsis", input: { body: { pastedText: "x" } } });
  const again = await jobs.start({ userId: 5, stage: "synopsis", input: { body: { pastedText: "x" } } });
  assert.equal(again.alreadyRunning, true);
  assert.equal(again.job.id, a.job.id);
  const other = await jobs.start({ userId: 6, stage: "synopsis", input: { body: { pastedText: "y" } } });
  assert.notEqual(other.job.id, a.job.id);
  assert.equal(runs, 2);
  g.open(); await later(); await later();
  // once it has finished, a new start is a new job
  const next = await jobs.start({ userId: 5, stage: "synopsis", input: { body: { pastedText: "x" } } });
  assert.equal(next.alreadyRunning, false);
});

test("a failure is kept as a plain message (also when the error has none), and never shows the pasted text", async () => {
  const store = fakeStore();
  let fail = new Error("billing account problem");
  const jobs = createSkipStartJobs({ jobStore: store, log: quiet, run: async () => { throw fail; } });
  const { job } = await jobs.start({ userId: 1, stage: "bitsheet", input: { body: { pastedText: "SECRET TEXT" } } });
  await later(); await later();
  const view = publicView(await jobs.get(job.id));
  assert.equal(view.status, "error");
  assert.equal(view.error, "billing account problem");
  assert.ok(!JSON.stringify(view).includes("SECRET TEXT"));
  fail = new Error("");
  const second = await jobs.start({ userId: 1, stage: "bitsheet", input: { body: { pastedText: "t" } } });
  await later(); await later();
  assert.match((await jobs.get(second.job.id)).error, /could not make the project/);
});

test("the newest job of a person is found again (a reloaded screen), also from the database after a restart", async () => {
  const store = fakeStore();
  const jobs1 = createSkipStartJobs({ jobStore: store, log: quiet, run: async () => ({ conceptId: 9 }) });
  const { job } = await jobs1.start({ userId: 3, stage: "synopsis", input: { body: { pastedText: "x" } } });
  await later(); await later();
  const jobs2 = createSkipStartJobs({ jobStore: store, log: quiet, run: async () => ({}) }); // "the server restarted"
  const found = await jobs2.currentFor(3);
  assert.equal(found.id, job.id);
  assert.equal(found.status, "done");
  assert.deepEqual(found.result, { conceptId: 9 });
  assert.equal(await jobs2.currentFor(4), null);
  assert.equal((await jobs2.get(job.id)).userId, 3);
});

test("after a restart: a job not yet saving starts again; one that was saving is reported; too many restarts give up", async () => {
  const store = fakeStore();
  const mk = (id, state, resumes = 0) => store.rows.set(id, { id, kind: SKIP_KIND, sceneListId: 0, key: "8", status: "running", state: { id, userId: 8, stage: "synopsis", step: "x", ...state }, resumes, startedAt: Date.now() - 60000, finishedAt: null });
  mk("again", { input: { body: { pastedText: "text A" }, ownerUserId: 8 }, saving: false });
  mk("saving", { input: { body: { pastedText: "text B" } }, saving: true });
  mk("tired", { input: { body: { pastedText: "text C" } }, saving: false }, 3);
  mk("lost", { saving: false });
  const ran = [];
  const jobs = createSkipStartJobs({ jobStore: store, log: quiet, run: async (stage, input) => { ran.push(input.body.pastedText); return { conceptId: 5 }; } });
  await jobs.resume();
  await later(); await later();
  assert.deepEqual(ran, ["text A"]);
  assert.equal(store.rows.get("again").status, "done");
  assert.equal(store.rows.get("again").resumes, 1);
  assert.match((await jobs.get("again")).notice, /restart 1/);
  assert.equal(store.rows.get("saving").status, "error");
  assert.match(store.rows.get("saving").state.error, /YOUR PROJECTS/);
  assert.equal(store.rows.get("tired").status, "error");
  assert.match(store.rows.get("tired").state.error, /given up/);
  assert.equal(store.rows.get("lost").status, "error");
});
