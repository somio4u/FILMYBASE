import test from "node:test";
import assert from "node:assert/strict";
import { runAutoProduction } from "../autoProduction.js";

// A scripted app: records every call and answers from a table.
function harness(overrides = {}) {
  const calls = [];
  const jobs = [];
  let cinematicPolls = 0;
  const api = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    const o = overrides[`${method} ${path}`] ?? overrides[path];
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
    if (method === "GET" && path.endsWith("/shots")) return { ok: true, status: 200, data: { shots: (overrides.shotStatuses ?? ["approved", "approved"]).map((shotStatus) => ({ shotStatus })) } };
    if (path.endsWith("/validate")) return { ok: true, status: 200, data: { ok: true, errors: [] } };
    return { ok: true, status: 200, data: {} };
  };
  const setJob = async (patch) => jobs.push(patch);
  return { calls, jobs, run: () => runAutoProduction({ projectId: 7, api, listScenes: async () => [101, 102], setJob, sleep: async () => {}, pollMs: 1 }) };
}

test("runs the whole sequence in order and ends with an approved blueprint", async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.status, "done");
  const order = ["blueprint/sync", "cinematic/analyze", "cinematic/items/11/approve", "cinematic/send-to-production", "scenes/101/divide", "scenes/102/divide", "production/7/shots", "prompts/plan", "blueprint/validate", "blueprint/approve"];
  let at = -1;
  for (const part of order) { const i = h.calls.findIndex((c, idx) => idx > at && c.includes(part)); assert.ok(i > at, `${part} should come after the previous step`); at = i; }
  assert.ok(!h.calls.some((c) => c.includes("items/12/approve")), "a stale direction is never approved");
  assert.ok(!h.calls.some((c) => c.includes("items/13/approve")), "story ideas are never auto-approved");
  assert.equal(h.jobs.at(-1).status, "done");
});

test("a scene that already has shots is fine and is left as it is", async () => {
  const h = harness({ "POST /api/production/7/scenes/101/divide": { ok: false, status: 409, data: { code: "exists", error: "already" } } });
  assert.equal((await h.run()).status, "done");
});

test("Adu NEVER approves the shot division himself: he cuts, then waits for the director, and does not plan prompts or approve the blueprint yet", async () => {
  const h = harness({ shotStatuses: ["draft", "approved", "draft"] });
  const result = await h.run();
  assert.equal(result.status, "waiting_for_you");
  assert.match(result.message, /Storyboard Designer/);
  assert.match(result.message, /2 shots still waiting/);
  assert.ok(!h.calls.some((c) => c.includes("shots/approve")), "no shot is ever approved by Adu");
  assert.ok(!h.calls.some((c) => c.includes("prompts/plan") || c.includes("blueprint/approve")), "nothing after the shots happens before the director approves");
  assert.equal(h.jobs.at(-1).status, "waiting_for_you");
});

test("stops cleanly, and says so, when the money limit is reached while cutting shots", async () => {
  const h = harness({ "POST /api/production/7/scenes/102/divide": { ok: false, status: 402, data: { error: "limit" } } });
  const result = await h.run();
  assert.equal(result.status, "needs_attention");
  assert.match(result.message, /money limit/);
  assert.ok(!h.calls.some((c) => c.includes("blueprint/approve")));
});

test("a blueprint that does not validate is not approved, and the problems are shown", async () => {
  const h = harness({ "POST /api/production/7/blueprint/validate": { ok: true, status: 200, data: { ok: false, errors: [{ message: "Scene 2 has no shots." }] } } });
  const result = await h.run();
  assert.equal(result.status, "needs_attention");
  assert.match(result.message, /Scene 2 has no shots/);
  assert.ok(!h.calls.some((c) => c.includes("blueprint/approve")));
});

test("a failing Cinematic Director does not stop the plan; it is only noted", async () => {
  const h = harness({ "POST /api/ai-movie/projects/7/cinematic/analyze": { ok: false, status: 500, data: { error: "boom" } } });
  const result = await h.run();
  assert.equal(result.status, "done");
  assert.match(result.warnings[0], /Cinematic Director could not start/);
});

test("if the screenplay cannot be read into production the job fails with the reason", async () => {
  const h = harness({ "POST /api/production/7/blueprint/sync": { ok: true, status: 200, data: { analyzed: false, reason: "no scenes" } } });
  const result = await h.run();
  assert.equal(result.status, "failed");
  assert.match(result.message, /no scenes/);
});
