import test from "node:test";
import assert from "node:assert/strict";
import { runPrepare, runShotDivision, runFinish } from "../autoProduction.js";

// A scripted app: records every call and answers from a table.
function harness(overrides = {}) {
  const calls = [];
  const jobs = [];
  let cinematicPolls = 0;
  const api = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    const o = overrides[`${method} ${path}`];
    if (o) return typeof o === "function" ? o(body) : o;
    if (path.endsWith("/blueprint/sync")) return { ok: true, status: 200, data: { analyzed: true } };
    if (method === "POST" && path.endsWith("/cinematic/analyze")) return { ok: true, status: 200, data: { started: true } };
    if (method === "GET" && path.endsWith("/cinematic")) {
      cinematicPolls++;
      return { ok: true, status: 200, data: { job: cinematicPolls < 2 ? { status: "running", done: 1, total: 2 } : { status: "idle" }, items: [
        { id: 11, kind: "cinematic_direction", status: "pending", stale: false, waitingForChange: false },
        { id: 12, kind: "cinematic_direction", status: "pending", stale: true, waitingForChange: false },
        { id: 13, kind: "story_rec", status: "pending", stale: false },
      ] } };
    }
    if (method === "GET" && path.endsWith("/shots")) return { ok: true, status: 200, data: { shots: (overrides.shotStatuses ?? ["draft", "draft"]).map((shotStatus) => ({ shotStatus })) } };
    if (path.endsWith("/validate")) return { ok: true, status: 200, data: { ok: true, errors: [] } };
    return { ok: true, status: 200, data: {} };
  };
  const setJob = async (patch) => jobs.push(patch);
  const args = { projectId: 7, api, listScenes: async () => [101, 102], setJob, sleep: async () => {}, pollMs: 1 };
  return { calls, jobs, args };
}
const never = (calls, ...parts) => parts.forEach((part) => assert.ok(!calls.some((c) => c.includes(part)), `"${part}" must not be called`));

test("PREPARE only reads the screenplay (scenes, characters, environments, properties) and then waits: no cinematic work, no shots", async () => {
  const h = harness();
  const result = await runPrepare(h.args);
  assert.equal(result.status, "waiting_for_you");
  assert.equal(result.next, "create_shots");
  assert.match(result.message, /Create shot division from screenplay/);
  assert.deepEqual(h.calls, ["POST /api/production/7/blueprint/sync"]);
  never(h.calls, "divide", "cinematic", "shots/approve", "prompts/plan", "blueprint/approve");
});

test("PREPARE says why when the screenplay cannot be read", async () => {
  const h = harness({ "POST /api/production/7/blueprint/sync": { ok: true, status: 200, data: { analyzed: false, reason: "no scenes" } } });
  const result = await runPrepare(h.args);
  assert.equal(result.status, "failed");
  assert.match(result.message, /no scenes/);
});

test("SHOTS: directions approved (never a stale one or a story idea), every scene cut, then WAITS: no shot is approved, nothing after it runs", async () => {
  const h = harness();
  const result = await runShotDivision(h.args);
  assert.equal(result.status, "waiting_for_you");
  assert.equal(result.next, "approve_shots");
  assert.match(result.message, /Storyboard Designer/);
  const order = ["blueprint/sync", "cinematic/analyze", "cinematic/items/11/approve", "cinematic/send-to-production", "scenes/101/divide", "scenes/102/divide", "production/7/shots"];
  let at = -1;
  for (const part of order) { const i = h.calls.findIndex((c, idx) => idx > at && c.includes(part)); assert.ok(i > at, `${part} should come after the previous step`); at = i; }
  never(h.calls, "items/12/approve", "items/13/approve", "shots/approve", "prompts/plan", "blueprint/validate", "blueprint/approve");
});

test("SHOTS: a scene that already has shots is left as it is", async () => {
  const h = harness({ "POST /api/production/7/scenes/101/divide": { ok: false, status: 409, data: { code: "exists", error: "already" } } });
  assert.equal((await runShotDivision(h.args)).status, "waiting_for_you");
});

test("SHOTS: stops cleanly, and says so, when the money limit is reached while cutting", async () => {
  const h = harness({ "POST /api/production/7/scenes/102/divide": { ok: false, status: 402, data: { error: "limit" } } });
  const result = await runShotDivision(h.args);
  assert.equal(result.status, "needs_attention");
  assert.match(result.message, /money limit/);
});

test("SHOTS: a failing Cinematic Director only adds a note; the shots are still made", async () => {
  const h = harness({ "POST /api/ai-movie/projects/7/cinematic/analyze": { ok: false, status: 500, data: { error: "boom" } } });
  const result = await runShotDivision(h.args);
  assert.equal(result.status, "waiting_for_you");
  assert.match(result.warnings[0], /Cinematic Director could not start/);
});

test("FINISH does nothing until EVERY shot is approved", async () => {
  const h = harness({ shotStatuses: ["approved", "draft"] });
  const result = await runFinish(h.args);
  assert.equal(result.status, "waiting_for_you");
  assert.equal(result.next, "approve_shots");
  never(h.calls, "prompts/plan", "blueprint/approve");
});

test("FINISH with every shot approved plans the prompts and approves the blueprint", async () => {
  const h = harness({ shotStatuses: ["approved", "approved"] });
  const result = await runFinish(h.args);
  assert.equal(result.status, "done");
  const plan = h.calls.findIndex((c) => c.includes("prompts/plan")), validate = h.calls.findIndex((c) => c.includes("blueprint/validate")), approve = h.calls.findIndex((c) => c.includes("blueprint/approve"));
  assert.ok(plan >= 0 && plan < validate && validate < approve);
  never(h.calls, "divide", "cinematic");
});

test("FINISH: a blueprint that does not validate is not approved, and the problems are shown", async () => {
  const h = harness({ shotStatuses: ["approved"], "POST /api/production/7/blueprint/validate": { ok: true, status: 200, data: { ok: false, errors: [{ message: "Scene 2 has no shots." }] } } });
  const result = await runFinish(h.args);
  assert.equal(result.status, "needs_attention");
  assert.match(result.message, /Scene 2 has no shots/);
  never(h.calls, "blueprint/approve");
});

test("CANCEL while cutting: stops before the next scene, keeps what was made, nothing is approved or planned after", async () => {
  const h = harness();
  let cutSoFar = 0;
  h.args.api = ((original) => async (method, path, body) => { if (path.includes("/divide")) cutSoFar++; return original(method, path, body); })(h.args.api);
  h.args.isCancelled = async () => cutSoFar >= 1; // pressed Cancel after the first scene was cut
  const result = await runShotDivision(h.args);
  assert.equal(result.status, "cancelled");
  assert.match(result.message, /already made is kept/);
  assert.equal(h.jobs.at(-1).status, "cancelled");
  assert.equal(cutSoFar, 1, "the second scene is never cut");
  never(h.calls.filter((c) => !c.includes("scenes/101")), "scenes/102/divide");
  never(h.calls, "shots/approve", "prompts/plan", "blueprint/approve");
});

test("CANCEL during the Cinematic Director asks it to stop and ends the job as cancelled", async () => {
  const h = harness();
  h.args.isCancelled = async () => h.calls.some((c) => c.endsWith("/cinematic/analyze")); // pressed right after it started
  const result = await runShotDivision(h.args);
  assert.equal(result.status, "cancelled");
  assert.ok(h.calls.some((c) => c.endsWith("/cinematic/stop")), "the Director is told to stop");
  never(h.calls, "divide");
});

test("a Cinematic Director that stopped because the director cancelled ends the job as cancelled", async () => {
  const h = harness({ "GET /api/ai-movie/projects/7/cinematic": { ok: true, status: 200, data: { job: { status: "idle", stoppedBy: "user" }, items: [] } } });
  const result = await runShotDivision(h.args);
  assert.equal(result.status, "cancelled");
  never(h.calls, "divide");
});

test("SCREENPLAY-ONLY project: Adu reads the final screenplay for characters / environments / properties FIRST, never runs the Cinematic Director, and still waits for the director", async () => {
  const h = harness();
  h.args.screenplayOnly = true;
  const result = await runShotDivision(h.args);
  assert.equal(result.status, "waiting_for_you");
  const analyze = h.calls.findIndex((c) => c.endsWith("/analyze-screenplay-assets"));
  const divide = h.calls.findIndex((c) => c.includes("/divide"));
  assert.ok(analyze >= 0 && analyze < divide, "the screenplay is analysed before any shot is cut");
  never(h.calls, "/cinematic", "shots/approve", "prompts/plan", "blueprint/approve");
});

test("the screenplay analysis failing stops with a plain message instead of cutting shots blindly", async () => {
  const h = harness({ "POST /api/ai-movie/projects/7/analyze-screenplay-assets": { ok: false, status: 502, data: { error: "AI busy" } } });
  const result = await runShotDivision(h.args);
  assert.equal(result.status, "failed");
  assert.match(result.message, /characters, environments and properties/);
  never(h.calls, "divide");
});

test("a money limit while analysing the screenplay ends as needs_attention", async () => {
  const h = harness({ "POST /api/ai-movie/projects/7/analyze-screenplay-assets": { ok: false, status: 402, data: { error: "limit" } } });
  assert.equal((await runShotDivision(h.args)).status, "needs_attention");
});
