import test from "node:test";
import assert from "node:assert/strict";
import { beatIsComplete, planApproveAll, planWriteAll, sceneHasDialogue, writeWholeBeat } from "../aiMovieWriteAll.js";
import { createWriteScenesJobs } from "../writeScenesJobs.js";

const scene = (withDialogue) => ({ sceneHeading: { en: "INT. HOUSE - DAY" }, action: { en: "Something happens." }, ...(withDialogue ? { content: [{ type: "dialogue", character: "ASHA", text: { en: "Hi" } }] } : {}) });
const beatMeta = (title) => ({ title: { en: title }, description: { en: "x" } });

test("what counts as finished: approved, with scenes, and (unless it is a song beat) dialogue in every scene", () => {
  assert.equal(sceneHasDialogue(scene(true)), true);
  assert.equal(sceneHasDialogue(scene(false)), false);
  assert.equal(beatIsComplete({ status: "approved", scenes: [scene(true), scene(true)] }), true);
  assert.equal(beatIsComplete({ status: "approved", scenes: [scene(true), scene(false)] }), false);
  assert.equal(beatIsComplete({ status: "pending", scenes: [scene(true)] }), false); // written but not approved
  assert.equal(beatIsComplete({ status: "approved", scenes: [scene(false)] }, { dialogue: false }), true); // dialogue not wanted
  assert.equal(beatIsComplete({ status: "approved", scenes: [scene(false)] }, { isSong: true }), true); // a song beat is the song sheet
  assert.equal(beatIsComplete({ status: "not_started", scenes: null }), false);
  assert.equal(beatIsComplete(undefined), false);
});

test("the plan: only the beats that are not finished, in story order, already-approved beats with their dialogue are left alone", () => {
  const beats = ["Opening", "Meeting", "The Song of Love", "Climax"].map(beatMeta);
  const screenplayBeats = [
    { status: "approved", scenes: [scene(true)] }, // done
    { status: "approved", scenes: [scene(true), scene(false)] }, // approved, a scene still without dialogue
    { status: "approved", scenes: [scene(false)] }, // a song beat: done as it is
    { status: "not_started", scenes: null },
  ];
  const items = planWriteAll({ beats, screenplayBeats, isSong: (i) => i === 2, dialogue: true, projectId: 9 });
  assert.deepEqual(items.map((i) => i.beatIndex), [1, 3]);
  assert.equal(items[0].label, "Beat 2");
  assert.equal(items[0].sceneListId, 9);
  assert.equal(items[0].totalBeats, 4);
  assert.equal(items[1].title, "Climax");
  assert.deepEqual(planWriteAll({ beats, screenplayBeats, isSong: (i) => i === 2, dialogue: false, projectId: 9 }).map((i) => i.beatIndex), [3]); // without dialogue beat 2 is done
});

// a scripted project: beats move not_started -> pending -> approved, scenes gain dialogue
function fakeProject(beatsInit, { isSong = () => false } = {}) {
  const beats = beatsInit.map((b) => ({ ...b }));
  const log = [];
  let clock = 0;
  const deps = {
    getBeat: async (i) => (beats[i] ? { ...beats[i], scenes: beats[i].scenes?.map((s) => ({ ...s })) ?? beats[i].scenes } : null),
    reviveStuck: async (i) => { log.push(`revive ${i}`); if (beats[i].status === "generating" && beats[i].stuck) beats[i] = { status: "not_started", scenes: null }; },
    generateBeat: async (i) => { log.push(`write ${i}`); if (beats[i].failWrite) { beats[i].status = "error"; beats[i].feedback = "quota"; return "error"; } beats[i] = { status: "pending", scenes: [scene(false), scene(false)] }; return "generated"; },
    approveBeat: async (i) => { log.push(`approve ${i}`); beats[i] = { ...beats[i], status: "approved", autoApproved: true }; },
    writeDialogue: async (i, j) => { log.push(`dialogue ${i}.${j}`); if (beats[i].failDialogue === j) throw new Error("bad json"); beats[i].scenes[j] = scene(true); },
    isSong, sleep: async (ms) => { clock += ms; if (beats.some((b) => b.status === "generating" && b.finishesAfter && clock >= b.finishesAfter)) beats.forEach((b, i) => { if (b.status === "generating" && b.finishesAfter && clock >= b.finishesAfter) beats[i] = { status: "pending", scenes: [scene(false)] }; }); },
    now: () => clock,
  };
  return { beats, log, deps };
}
const item = (i, extra = {}) => ({ beatIndex: i, totalBeats: 3, title: `T${i}`, dialogue: true, ...extra });

test("a beat that is not started: written, approved automatically, then the dialogue of EVERY scene — in that order", async () => {
  const { beats, log, deps } = fakeProject([{ status: "not_started", scenes: null }]);
  const said = [];
  await writeWholeBeat({ item: item(0), say: async (t) => said.push(t), deps });
  assert.deepEqual(log, ["write 0", "approve 0", "dialogue 0.0", "dialogue 0.1"]);
  assert.equal(beats[0].status, "approved");
  assert.equal(beats[0].autoApproved, true); // marked, so it can still be told apart and read
  assert.ok(beats[0].scenes.every(sceneHasDialogue));
  assert.match(said[0], /writing its scenes/);
  assert.ok(said.some((t) => /dialogue for scene 2 of 2/.test(t)));
});

test("a beat already written and waiting for approval only gets approved and its dialogue; a scene that already has dialogue is not written again; a song beat gets no dialogue", async () => {
  const a = fakeProject([{ status: "pending", scenes: [scene(true), scene(false)] }]);
  await writeWholeBeat({ item: item(0), deps: a.deps });
  assert.deepEqual(a.log, ["approve 0", "dialogue 0.1"]);
  const song = fakeProject([{ status: "pending", scenes: [scene(false)] }], { isSong: () => true });
  await writeWholeBeat({ item: item(0), deps: song.deps });
  assert.deepEqual(song.log, ["approve 0"]);
  const noDialogue = fakeProject([{ status: "not_started", scenes: null }]);
  await writeWholeBeat({ item: item(0, { dialogue: false }), deps: noDialogue.deps });
  assert.deepEqual(noDialogue.log, ["write 0", "approve 0"]);
});

test("a beat the older 4-beat writer is busy with is waited for, not written twice; a beat stuck for too long is revived and written", async () => {
  const waiting = fakeProject([{ status: "generating", scenes: null, finishesAfter: 10000 }]);
  await writeWholeBeat({ item: item(0), deps: waiting.deps });
  assert.ok(!waiting.log.includes("write 0"));
  assert.ok(waiting.log.includes("approve 0"));
  const stuck = fakeProject([{ status: "generating", scenes: null, stuck: true }]);
  await writeWholeBeat({ item: item(0), deps: stuck.deps });
  assert.ok(stuck.log.includes("write 0"));
  const never = fakeProject([{ status: "generating", scenes: null }]);
  await assert.rejects(() => writeWholeBeat({ item: item(0), deps: never.deps }), /still being written by another run/);
});

test("failures are reported plainly: a beat the AI could not write, and scenes whose dialogue failed (the other scenes still get theirs)", async () => {
  const fail = fakeProject([{ status: "not_started", scenes: null, failWrite: true }]);
  await assert.rejects(() => writeWholeBeat({ item: item(0), deps: fail.deps }), /Beat 1 could not be written: quota/);
  const partial = fakeProject([{ status: "pending", scenes: [scene(false), scene(false), scene(false)], failDialogue: 0 }]);
  await assert.rejects(() => writeWholeBeat({ item: item(0), deps: partial.deps }), /dialogue could not be written for scene 1: bad json/);
  assert.deepEqual(partial.log.filter((l) => l.startsWith("dialogue")), ["dialogue 0.0", "dialogue 0.1", "dialogue 0.2"]);
  assert.equal(sceneHasDialogue(partial.beats[0].scenes[1]), true);
  const money = fakeProject([{ status: "pending", scenes: [scene(false), scene(false)] }]);
  money.deps.writeDialogue = async () => { throw new Error("The money limit for this project has been reached."); };
  await assert.rejects(() => writeWholeBeat({ item: item(0), deps: money.deps }), /money limit/);
});

test("in the shared job machine: beats run in order, finished ones are skipped, the progress line is updated by say(), and a failed beat does not stop the next one", async () => {
  const rows = new Map();
  const store = {
    async insert(id, kind, sceneListId, key, state) { rows.set(id, { id, kind, sceneListId, state, status: "running", startedAt: new Date(), finishedAt: null, resumes: 0 }); },
    async save(id, state, status) { const r = rows.get(id); rows.set(id, { ...r, state, status }); },
    async get(id) { return rows.get(id) ?? null; },
    async latest(kind, sceneListId) { return [...rows.values()].filter((r) => r.kind === kind && r.sceneListId === sceneListId).at(-1) ?? null; },
    async running() { return []; },
    async countResume() {},
  };
  const project = fakeProject([{ status: "approved", scenes: [scene(true)] }, { status: "not_started", scenes: null, failWrite: true }, { status: "not_started", scenes: null }]);
  const steps = [];
  const jobs = createWriteScenesJobs({
    jobStore: store, kind: "ai-movie-write-all", log: { error() {}, log() {} },
    isWritten: async (it) => beatIsComplete(await project.deps.getBeat(it.beatIndex), { dialogue: true }),
    describe: (it) => `Beat ${it.beatIndex + 1}`,
    writeOne: (it, tools) => writeWholeBeat({ item: it, say: async (t) => { steps.push(t); await tools.say(t); }, deps: project.deps }),
  });
  const items = planWriteAll({ beats: [beatMeta("a"), beatMeta("b"), beatMeta("c")], screenplayBeats: [{ status: "not_started" }, { status: "not_started" }, { status: "not_started" }], dialogue: true, projectId: 4 });
  const { job } = await jobs.start({ sceneListId: 4, userId: 1, items, language: "en" });
  for (let n = 0; n < 200 && job.status === "running"; n++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(job.status, "done");
  assert.deepEqual(job.done.map((d) => d.sceneIndex), [0, 2]); // beat 1 was skipped as finished, beat 3 written
  assert.equal(job.done[0].skipped, true);
  assert.deepEqual(job.failed.map((f) => f.sceneIndex), [1]);
  assert.match(job.failed[0].error, /Beat 2 could not be written/);
  assert.ok(steps.some((t) => /Beat 3 of 3/.test(t)));
  assert.equal(project.beats[2].status, "approved");
});

test("Approve all: every written beat becomes the person's own approval (the automatic marks go); refused while any beat is not written", () => {
  const beats = [
    { status: "approved", autoApproved: true, scenes: [scene(true)] }, // the machine approved it
    { status: "approved", scenes: [scene(true)] }, // the person approved it by hand
    { status: "pending", scenes: [scene(true)] }, // written, waiting
  ];
  const plan = planApproveAll(beats);
  assert.equal(plan.changed, 2);
  assert.deepEqual(plan.unwritten, []);
  assert.deepEqual(plan.beats.map((b) => b.status), ["approved", "approved", "approved"]);
  assert.ok(plan.beats.every((b) => !("autoApproved" in b)));
  assert.equal(plan.beats[1], beats[1]); // a beat the person already approved is left exactly as it is
  assert.ok("autoApproved" in beats[0]); // the input is not changed

  const blocked = planApproveAll([...beats, { status: "not_started", scenes: null }, { status: "error", scenes: [] }]);
  assert.deepEqual(blocked.unwritten, [4, 5]);
  assert.equal(blocked.changed, 0);
  assert.equal(blocked.beats.length, 5);
  assert.equal(planApproveAll([]).empty, true);
  assert.equal(planApproveAll(undefined).empty, true);
});
