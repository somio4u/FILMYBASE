// Approved cinematic directions reaching production: the Shot Cutter (real shots.js + real routes, real Postgres) and the
// Silent Agent's asset notes. MOCK TESTS: the model is a scripted fake; no Google service is contacted.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { ensureAllProductionSchemas } from "../productionSchema.js";
import { analyzeScreenplay } from "../screenplayAnalysis.js";
import { registerPipelineRoutes } from "../pipelineRoutes.js";
import { ensureAiMovieStorySchema, createAiMovieAsker } from "../aiMovieStory.js";
import { ensureCinematicSchema, createShotCutterHook, sceneHash } from "../spectacleDirector.js";
import { saveSettings, spendSummary } from "../pipelineSettings.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let server, base, pid, calls, scenes, sceneIds;
const bil = (en) => ({ en, hi: en });
const mkScene = (heading, action) => ({ sceneHeading: bil(heading), action: bil(action), estimatedMinutes: 1 });
const QUIET = "INT. HOUSE - DAY\nRudra sits at the table and drinks tea. His mother watches.";
const FIGHT = "EXT. BRIDGE - NIGHT\nRudra and Kaal fight on the bridge. Swords clash. A battle erupts and the planks collapse.";

async function callTier(tier, params) {
  calls.push({ tier, params });
  return { shots: [{ framing: "Wide", cameraAngle: "Eye level", cameraMove: "Static", description: "Rudra stands on the bridge.", durationSec: 4, characters: [], props: [], dialogueCodes: [] }] };
}
const requireRole = () => (req, res, next) => ((req.user = { id: 1 }), next());
const api = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json };
};
const divide = (key) => api("POST", `/api/production/${pid}/scenes/${sceneIds[key]}/divide`, { mode: "ai", replace: true });

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  assert.deepEqual(await ensureAllProductionSchemas(db), []);
  await ensureAiMovieStorySchema(db);
  await ensureCinematicSchema(db);
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] cinpipe%'");
  const ask = createAiMovieAsker({ db, callTier });
  const getScenes = async () => scenes;
  const hook = createShotCutterHook({ db, ask, getScenes });
  const app = express();
  app.use(express.json());
  registerPipelineRoutes(app, db, requireRole, {
    store: {}, providers: { models: { image: "i", speech: "s", video: "v" }, textJson: async () => { throw new Error("the plain (unrouted) cutter must not run for an AI Movie screenplay"); } },
    cinematic: { shotCutterFor: hook },
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  calls = [];
  const backfill = { screenplayBeats: [{ status: "approved", scenes: [mkScene("INT. HOUSE - DAY", "Rudra sits at the table and drinks tea. His mother watches."), mkScene("EXT. BRIDGE - NIGHT", "Rudra and Kaal fight on the bridge. Swords clash. A battle erupts and the planks collapse.")] }] };
  pid = (await db.query("INSERT INTO ai_movie_projects (pasted_text, title, backfill) VALUES ('idea','[TEST] cinpipe',$1) RETURNING id", [JSON.stringify(backfill)])).rows[0].id;
  scenes = [
    { key: "b0s0", beatIndex: 0, sceneIndex: 0, heading: "INT. HOUSE - DAY", text: QUIET, characters: ["RUDRA"] },
    { key: "b0s1", beatIndex: 0, sceneIndex: 1, heading: "EXT. BRIDGE - NIGHT", text: FIGHT, characters: ["RUDRA", "KAAL"] },
  ];
  await analyzeScreenplay(db, pid);
  const rows = (await db.query("SELECT id, source_key, source_kind FROM production_scenes WHERE project_id = $1", [pid])).rows;
  assert.ok(rows.every((r) => r.source_kind === "beats"));
  sceneIds = Object.fromEntries(rows.map((r) => [r.source_key, r.id]));
});
test.after(async () => { server.close(); await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] cinpipe%'"); await db.end(); });

const addDirection = (key, text, status = "approved", payload = {}) => db.query(
  "INSERT INTO ai_movie_cinematic_items (project_id, kind, scene_key, scene_hash, status, payload) VALUES ($1,'cinematic_direction',$2,$3,$4,$5)",
  [pid, key, sceneHash(text), status, JSON.stringify({ spectacleLevel: "major", purpose: "x", fights: [{ identity: "Bridge duel", motivation: "m", fightingStyles: "s", spatialGeography: "g", environmentInteraction: [], progression: [], reversals: [], signatureBeats: ["Blind fight in smoke"], payoff: "p" }], aiProduction: { shotPlan: [{ n: 1, description: "Wide of the burning bridge", framing: "Wide", cameraMove: "Static", durationSec: 4, continuityNotes: "red turban" }], continuity: {}, alternatives: [], risks: [] }, ...payload })]
);

test("Shot Cutter: a complex fight scene with an approved direction gets the direction in its brief and Gemini 3.1 Pro (Professional mode)", async () => {
  await addDirection("b0s1", FIGHT);
  const r = await divide("b0s1");
  assert.equal(r.status, 200);
  assert.equal(r.json.mode, "ai");
  assert.equal(r.json.model, "Gemini 3.1 Pro");
  assert.equal(r.json.usedCinematicDirections, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tier, "pro");
  assert.match(calls[0].params.contents, /APPROVED CINEMATIC DIRECTIONS FOR THIS SCENE/);
  assert.match(calls[0].params.contents, /Signature beats: Blind fight in smoke/);
  assert.match(calls[0].params.contents, /SHOT 1: Wide of the burning bridge/);
  assert.equal(r.json.shots.length, 1);
  assert.ok((await spendSummary(db, pid)).byKind.text.usd > 0, "Pro cost written to the ledger");
});

test("Shot Cutter: a quiet scene (no direction) stays on Flash with no direction block — routine work is not upgraded", async () => {
  const r = await divide("b0s0");
  assert.equal(r.status, 200);
  assert.equal(r.json.model, "Gemini 2.5 Flash");
  assert.equal(r.json.usedCinematicDirections, false);
  assert.equal(calls[0].tier, "flash");
  assert.doesNotMatch(calls[0].params.contents, /APPROVED CINEMATIC DIRECTIONS/);
});

test("Shot Cutter: an action scene WITHOUT a direction is still recognised as complex in Professional mode, but stays Flash in Economy", async () => {
  assert.equal((await divide("b0s1")).json.model, "Gemini 3.1 Pro");
  await db.query("UPDATE ai_movie_projects SET quality_mode = 'economy' WHERE id = $1", [pid]);
  assert.equal((await divide("b0s1")).json.model, "Gemini 2.5 Flash");
});

test("Shot Cutter: Maximum quality uses Pro even for a quiet scene", async () => {
  await db.query("UPDATE ai_movie_projects SET quality_mode = 'maximum' WHERE id = $1", [pid]);
  assert.equal((await divide("b0s0")).json.model, "Gemini 3.1 Pro");
});

test("Shot Cutter: a STALE direction (scene edited after approval) and an unapproved one never reach the brief", async () => {
  await addDirection("b0s1", "OLD TEXT OF THE SCENE");
  await addDirection("b0s0", QUIET, "pending");
  assert.equal((await divide("b0s1")).json.usedCinematicDirections, false);
  assert.equal((await divide("b0s0")).json.usedCinematicDirections, false);
  assert.ok(calls.every((c) => !/APPROVED CINEMATIC DIRECTIONS/.test(c.params.contents)));
});

test("Shot Cutter: a direction approved for one project never leaks into another project's scene", async () => {
  await addDirection("b0s1", FIGHT);
  const other = (await db.query("INSERT INTO ai_movie_projects (pasted_text, title, backfill) VALUES ('i','[TEST] cinpipe other',$1) RETURNING id", [JSON.stringify({ screenplayBeats: [{ status: "approved", scenes: [mkScene("INT. HOUSE - DAY", "x"), mkScene("EXT. BRIDGE - NIGHT", "y")] }] })])).rows[0].id;
  await analyzeScreenplay(db, other);
  const row = (await db.query("SELECT id FROM production_scenes WHERE project_id = $1 AND source_key = 'b0s1'", [other])).rows[0];
  const r = await api("POST", `/api/production/${other}/scenes/${row.id}/divide`, { mode: "ai", replace: true });
  assert.equal(r.json.usedCinematicDirections, false);
});

test("Shot Cutter: the money limit is enforced before the Pro call — the cut is refused with 402 and nothing is called or spent", async () => {
  await saveSettings(db, pid, { budgetLimitUsd: 0.05 });
  const r = await divide("b0s1");
  assert.equal(r.status, 402);
  assert.equal(calls.length, 0);
  assert.equal((await spendSummary(db, pid)).spentUsd, 0);
});
