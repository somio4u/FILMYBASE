import test from "node:test";
import assert from "node:assert/strict";
import { WRITER_ROLE, INDEPENDENT_WRITER_ROLE, isWriterRole, matchWriterRoute, userHasConcept, writerGatekeeper } from "../writerAccess.js";

// the Independent Writer: no project given, he owns the ones he creates
const writer = (extra = {}) => ({ id: 9, role: INDEPENDENT_WRITER_ROLE, concept_id: null, ownedConceptIds: ["12", "15"], ...extra });
// the Story & Screenplay Writer: one project given by the admin
const assignedWriter = (extra = {}) => ({ id: 10, role: WRITER_ROLE, concept_id: 40, ownedConceptIds: [], ...extra });

test("the two writer roles, and what each may open — never anyone else's project", () => {
  assert.equal(INDEPENDENT_WRITER_ROLE, "independent_writer");
  assert.equal(WRITER_ROLE, "screenplay_writer");
  assert.ok(isWriterRole("independent_writer") && isWriterRole("screenplay_writer"));
  assert.ok(!isWriterRole("director") && !isWriterRole("admin") && !isWriterRole(undefined));
  assert.equal(userHasConcept(assignedWriter(), 40), true);
  assert.equal(userHasConcept(assignedWriter(), 12), false);
  assert.equal(userHasConcept(writer(), 12), true);
  assert.equal(userHasConcept(writer(), "15"), true);
  assert.equal(userHasConcept(writer(), 13), false);
  assert.equal(userHasConcept(writer({ concept_id: 40 }), 40), true); // assigned by the admin
  assert.equal(userHasConcept(writer({ concept_id: 40 }), 41), false);
  assert.equal(userHasConcept(writer({ ownedConceptIds: [] }), 12), false);
  assert.equal(userHasConcept({ id: 1, role: "admin" }, 99), true);
  assert.equal(userHasConcept({ id: 2, role: "director", concept_id: 5 }, 5), true);
  assert.equal(userHasConcept({ id: 2, role: "director", concept_id: 5 }, 6), false);
  assert.equal(userHasConcept(writer(), null), false);
  assert.equal(userHasConcept(null, 12), false);
});

test("the routes that start a new project are matched as such; the automatic AI run and importing are not writer routes", () => {
  for (const path of ["/api/generate-storylines", "/api/skip-to-synopsis", "/api/skip-to-bitsheet", "/api/skip-to-scenelist"]) assert.equal(matchWriterRoute("POST", path)?.kind, "newProject", path);
  assert.equal(matchWriterRoute("GET", "/api/generate-storylines"), null);
  assert.equal(matchWriterRoute("POST", "/api/auto-pipeline/start"), null);
  assert.equal(matchWriterRoute("POST", "/api/concepts/import"), null);
  assert.equal(matchWriterRoute("DELETE", "/api/concepts/12"), null);
});

// runs the gatekeeper for one request: -> { status, passed, conceptId }
async function run(user, method, path, { body = {}, sceneListConcept = {} } = {}) {
  const gate = writerGatekeeper({ query: async () => ({ rows: [] }), on: () => {} }, async (id) => sceneListConcept[id] ?? null);
  const req = { user, method, path, body, query: {} };
  const result = { status: null, passed: false };
  const res = { status(code) { result.status = code; return this; }, json() { return this; }, on() {} };
  await gate(req, res, () => { result.passed = true; });
  result.conceptId = req.writerConceptId;
  return result;
}

test("an Independent Writer opens his own projects and starts new ones; other people's projects are refused", async () => {
  const own = await run(writer(), "GET", "/api/concepts/12/full");
  assert.equal(own.passed, true);
  assert.equal(String(own.conceptId), "12");
  const other = await run(writer(), "GET", "/api/concepts/13/full");
  assert.equal(other.passed, false);
  assert.equal(other.status, 403);
  const fresh = await run(writer({ ownedConceptIds: [] }), "POST", "/api/generate-storylines", { body: { concept: "x" } });
  assert.equal(fresh.passed, true);
  const viaSceneList = await run(writer(), "GET", "/api/scene-lists/7/screenplay-pdf", { sceneListConcept: { 7: 15 } });
  assert.equal(viaSceneList.passed, true);
  const viaOthersSceneList = await run(writer(), "GET", "/api/scene-lists/8/screenplay-pdf", { sceneListConcept: { 8: 99 } });
  assert.equal(viaOthersSceneList.status, 403);
  assert.equal((await run(writer(), "GET", "/api/crew")).status, 403);
});

test("the Story & Screenplay Writer keeps to the project he was given and cannot start new projects", async () => {
  assert.equal((await run(assignedWriter(), "GET", "/api/concepts/40/full")).passed, true);
  assert.equal((await run(assignedWriter(), "GET", "/api/concepts/12/full")).status, 403);
  const start = await run(assignedWriter(), "POST", "/api/generate-storylines", { body: { concept: "x" } });
  assert.equal(start.passed, false);
  assert.equal(start.status, 403);
  for (const path of ["/api/skip-to-synopsis", "/api/skip-to-bitsheet", "/api/skip-to-scenelist"]) assert.equal((await run(assignedWriter(), "POST", path)).status, 403, path);
});
