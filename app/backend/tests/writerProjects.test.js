import test from "node:test";
import assert from "node:assert/strict";
import { WRITER_ROLE, matchWriterRoute, userHasConcept, writerGatekeeper } from "../writerAccess.js";

const writer = (extra = {}) => ({ id: 9, role: WRITER_ROLE, concept_id: null, ownedConceptIds: ["12", "15"], ...extra });

test("a writer may work on the projects he created and on the one the admin assigned — never on anyone else's", () => {
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

test("the routes that start a new project are for a writer, the automatic AI run and importing are not", () => {
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

test("the gatekeeper lets a writer open his own projects, start a new one, and refuses other people's projects", async () => {
  const own = await run(writer(), "GET", "/api/concepts/12/full");
  assert.equal(own.passed, true);
  assert.equal(String(own.conceptId), "12");
  const other = await run(writer(), "GET", "/api/concepts/13/full");
  assert.equal(other.passed, false);
  assert.equal(other.status, 403);
  const fresh = await run(writer({ ownedConceptIds: [] }), "POST", "/api/generate-storylines", { body: { concept: "x" } });
  assert.equal(fresh.passed, true);
  const assigned = await run(writer({ concept_id: 40, ownedConceptIds: [] }), "GET", "/api/concepts/40/full");
  assert.equal(assigned.passed, true);
  const viaSceneList = await run(writer(), "GET", "/api/scene-lists/7/screenplay-pdf", { sceneListConcept: { 7: 15 } });
  assert.equal(viaSceneList.passed, true);
  const viaOthersSceneList = await run(writer(), "GET", "/api/scene-lists/8/screenplay-pdf", { sceneListConcept: { 8: 99 } });
  assert.equal(viaOthersSceneList.status, 403);
  const production = await run(writer(), "GET", "/api/crew");
  assert.equal(production.status, 403);
});
