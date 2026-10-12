// The AI Cinematic Spectacle & Mass Entertainment Director: proposals only, approval before anything changes,
// stale-direction protection, and what reaches the Silent Agent / Shot Cutter. MOCK TESTS: the Pro model is a scripted fake.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { ensureAiMovieStorySchema, createAiMovieAsker } from "../aiMovieStory.js";
import { ensurePipelineSettingsSchema, saveSettings, spendSummary } from "../pipelineSettings.js";
import { ensureCinematicSchema, registerSpectacleRoutes, approvedDirectionFor, cinematicAssetNotesText, sceneHash, directionPromptBlock, directionToText, AGENT_ID } from "../spectacleDirector.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let server, base, pid, calls, scenes, applied, refreshed, revisions, script, backfillSaved, bible;

const dirFor = (over = {}) => ({
  spectacleLevel: "major", purpose: "The hero arrives as a storm.", heroIntroduction: "Rudra walks out of the lightning.", villainPresentation: "",
  massMoments: [{ name: "Thunder walk", visual: "Wide slow-motion, rain parting", payoff: "Whistles" }],
  fights: [{ identity: "Fight on the burning bridge", motivation: "Save the child", fightingStyles: "Rudra: grappler; Kaal: whip", spatialGeography: "Bridge east-west, river below", environmentInteraction: ["planks collapse"], progression: [{ phase: "opening", action: "whip lash", camera: "low tracking" }], reversals: ["Rudra loses his sword"], signatureBeats: ["Fights blind in the smoke"], payoff: "Bridge falls" }],
  dialogueToAction: [{ original: "I am angry!", replacement: "He crushes the cup", why: "Show it" }],
  camera: { openingShot: "Lightning silhouette", signatureMoves: ["360 orbit"], lensNotes: "Cold teal" },
  aiProduction: { shotPlan: [{ n: 1, description: "Wide of the bridge", framing: "Wide", cameraMove: "Static", durationSec: 4, continuityNotes: "same red turban" }], continuity: { characters: "c", costumes: "red turban", weapons: "whip", locations: "bridge", cameraDirection: "left to right", geography: "east-west" }, alternatives: [{ situation: "contact", approach: "cut on impact" }], risks: ["fire"] },
  newAssets: [{ kind: "prop", name: "Burning bridge", description: "rope bridge, flames" }],
  enhancedHeading: "EXT. BURNING BRIDGE - NIGHT",
  enhancedBlocks: [{ type: "action", character: "", parenthetical: "", text: "Rudra steps through the fire." }, { type: "dialogue", character: "RUDRA", parenthetical: "calm", text: "Come." }],
  ...over,
});
async function callTier(tier, params) {
  calls.push({ tier, params });
  const text = String(params.contents);
  if (/SCENE (b\d+s\d+)/.test(text)) { const key = /SCENE (b\d+s\d+)/.exec(text)[1]; if (script[key] === "THROW") throw new Error("model down"); return script[key] ?? dirFor(); }
  if (/Story Bible and propose/.test(text)) return { summary: "Big potential", recommendations: [{ area: "climax", title: "Storm climax", suggestion: "The sea rises", whyItWorks: "Scale", storyRisk: "none" }, { area: "hero_introduction", title: "Lightning entrance", suggestion: "He walks out of lightning", whyItWorks: "Goosebumps", storyRisk: "keep him human" }] };
  return {};
}
const requireRole = () => (req, res, next) => ((req.user = { id: 7 }), next());
const api = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
};
const until = async (fn, what, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 30)); } };
const cin = (suffix = "") => `/api/ai-movie/projects/${pid}/cinematic${suffix}`;
const settled = () => until(async () => (await api("GET", cin())).json.job?.status !== "running", "director job", 8000);

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await ensureAiMovieStorySchema(db);
  await ensurePipelineSettingsSchema(db);
  await ensureCinematicSchema(db);
  await ensureCinematicSchema(db); // idempotent
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] cin%'");
  const ask = createAiMovieAsker({ db, callTier });
  const app = express();
  app.use(express.json());
  registerSpectacleRoutes(app, db, requireRole, {
    ask,
    getScenes: async () => scenes,
    getContext: async () => ({ bibleMarkdown: bible, contextText: "context", characterBriefs: "Rudra: hero" }),
    applyScene: async (projectId, b, s, { heading, blocks }) => {
      applied.push({ b, s, heading, blocks });
      const sc = scenes.find((x) => x.beatIndex === b && x.sceneIndex === s);
      sc.heading = heading;
      sc.text = `${heading}\n${blocks.map((x) => x.text).join("\n\n")}`;
      await db.query("UPDATE ai_movie_projects SET stage_status = stage_status - 'screenplay' WHERE id = $1", [projectId]);
    },
    refreshAssets: async (projectId) => { refreshed.push(projectId); },
    saveBackfillField: async (projectId, key, value) => { backfillSaved[key] = value; },
    requestStoryRevision: async (projectId, note) => { revisions.push(note); },
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  calls = []; applied = []; refreshed = []; revisions = []; backfillSaved = {};
  // the quiet house scene needs no rewrite; the bridge fight does
  script = { b0s0: dirFor({ spectacleLevel: "none", fights: [], massMoments: [], enhancedBlocks: [], enhancedHeading: "", newAssets: [], dialogueToAction: [] }) }; bible = "# Test — Story Bible\nbody";
  scenes = [
    { key: "b0s0", beatIndex: 0, sceneIndex: 0, heading: "INT. HOUSE - DAY", text: "INT. HOUSE - DAY\nRudra talks to his mother at the table.", characters: ["RUDRA"] },
    { key: "b1s0", beatIndex: 1, sceneIndex: 0, heading: "EXT. BRIDGE - NIGHT", text: "EXT. BRIDGE - NIGHT\nRudra fights Kaal on the rope bridge.", characters: ["RUDRA", "KAAL"] },
  ];
  pid = (await db.query("INSERT INTO ai_movie_projects (pasted_text, title) VALUES ('idea','[TEST] cin') RETURNING id")).rows[0].id;
});
test.after(async () => { server.close(); await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] cin%'"); await db.end(); });

test("story phase: the Director (Pro) reads the Bible and makes recommendations; nothing is overwritten; sending them goes to the Story Brain as a note", async () => {
  bible = "";
  assert.equal((await api("POST", cin("/story-recommendations"))).status, 400);
  bible = "# Test — Story Bible\nbody";
  const r = await api("POST", cin("/story-recommendations"));
  assert.equal(r.json.created, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tier, "pro");
  assert.match(calls[0].params.systemInstruction, /SHOW MORE\. TALK LESS/);
  assert.match(calls[0].params.systemInstruction, /MASS SPECTACLE/, "default creative mode is Mass Spectacle");
  const v = (await api("GET", cin())).json;
  const recs = v.items.filter((i) => i.kind === "story_rec");
  assert.equal(recs.length, 2);
  assert.ok(recs.every((i) => i.status === "pending" && i.model === "Gemini 3.1 Pro"));
  assert.equal((await api("POST", cin("/story-recommendations/send"), { ids: [] })).status, 400);
  const sent = await api("POST", cin("/story-recommendations/send"), { ids: [recs[1].id] });
  assert.equal(sent.json.sent, 1);
  assert.equal(revisions.length, 1);
  assert.match(revisions[0], /Lightning entrance: He walks out of lightning/);
  assert.match(revisions[0], /keep every fixed fact and the ending/);
  const after = (await api("GET", cin())).json.items;
  assert.equal(after.find((i) => i.id === recs[1].id).status, "sent");
  assert.equal(after.find((i) => i.id === recs[0].id).status, "pending");
  // asking again replaces the open ones
  await api("POST", cin("/story-recommendations"));
  assert.equal((await api("GET", cin())).json.items.filter((i) => i.kind === "story_rec" && i.status === "pending").length, 2);
});

test("creative mode: Balanced Cinematic changes the Director's brief, independently of quality mode", async () => {
  await db.query("UPDATE ai_movie_projects SET cinematic_mode = 'balanced', quality_mode = 'economy' WHERE id = $1", [pid]);
  await api("POST", cin("/story-recommendations"));
  assert.match(calls[0].params.systemInstruction, /BALANCED CINEMATIC/);
  assert.equal(calls[0].tier, "pro", "the Director is Pro even in Economy quality mode");
});

test("screenplay phase: analyze makes a direction per scene (and a side-by-side rewrite only where the Director proposes one); nothing in the screenplay changes yet", async () => {
  script.b0s0 = dirFor({ spectacleLevel: "none", fights: [], massMoments: [], enhancedBlocks: [], enhancedHeading: "", newAssets: [], dialogueToAction: [] });
  const r = await api("POST", cin("/analyze"), {});
  assert.equal(r.json.started, true);
  assert.equal(r.json.scenes, 2);
  await settled();
  const v = (await api("GET", cin())).json;
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.tier === "pro"));
  const directions = v.items.filter((i) => i.kind === "cinematic_direction");
  const changes = v.items.filter((i) => i.kind === "screenplay_change");
  assert.equal(directions.length, 2);
  assert.equal(changes.length, 1, "only the bridge scene gets a rewrite proposal; the quiet scene needs none");
  assert.equal(changes[0].sceneKey, "b1s0");
  assert.match(changes[0].originalText, /fights Kaal/, "the original scene is kept for the side-by-side view");
  assert.match(changes[0].enhancedText, /Rudra steps through the fire/);
  assert.equal(directions.find((d) => d.sceneKey === "b0s0").payload.spectacleLevel, "none");
  assert.match(directions.find((d) => d.sceneKey === "b1s0").directionText, /FIGHT — Fight on the burning bridge/);
  assert.ok(directions.every((d) => d.status === "pending"), "everything waits for approval");
  assert.equal(applied.length, 0, "the screenplay was not touched");
  assert.equal(scenes[1].text.includes("steps through the fire"), false);
  const prompt = calls.find((c) => /SCENE b1s0/.test(c.params.contents)).params.contents;
  assert.match(prompt, /COMPLETE rewritten scene/);
  assert.ok((await spendSummary(db, pid)).byKind.text.count >= 2, "the Pro calls were written to the spend ledger");
});

test("analyze only pays again for scenes that changed or have no current direction (and only when asked: redo)", async () => {
  await api("POST", cin("/analyze"), {}); await settled();
  calls = [];
  const none = await api("POST", cin("/analyze"), {});
  assert.equal(none.json.started, false);
  assert.equal(calls.length, 0);
  scenes[0].text += "\nA thunderclap.";
  const one = await api("POST", cin("/analyze"), {}); assert.equal(one.json.scenes, 1);
  await settled();
  assert.equal(calls.length, 1);
  assert.match(calls[0].params.contents, /SCENE b0s0/);
  calls = [];
  const redo = await api("POST", cin("/analyze"), { redo: true, sceneKeys: ["b1s0"] });
  assert.equal(redo.json.scenes, 1);
  await settled();
  assert.equal(calls.length, 1);
});

test("approving the rewrite is what changes the scene — and it reopens the screenplay approval; the paired direction then becomes current", async () => {
  await db.query("UPDATE ai_movie_projects SET stage_status = $2 WHERE id = $1", [pid, JSON.stringify({ screenplay: { status: "approved" } })]);
  await api("POST", cin("/analyze"), { allowScreenplayChanges: true }); await settled();
  let v = (await api("GET", cin())).json;
  const change = v.items.find((i) => i.kind === "screenplay_change");
  const direction = v.items.find((i) => i.kind === "cinematic_direction" && i.sceneKey === "b1s0");
  assert.equal(direction.waitingForChange, true);
  assert.equal((await api("POST", cin(`/items/${direction.id}/approve`))).status, 409, "approve the rewrite decision first");
  const ok = await api("POST", cin(`/items/${change.id}/approve`));
  assert.equal(ok.json.status, "applied");
  assert.equal(ok.json.reviewReopened, true);
  assert.equal(applied.length, 1);
  assert.deepEqual([applied[0].b, applied[0].s, applied[0].heading], [1, 0, "EXT. BURNING BRIDGE - NIGHT"]);
  assert.equal(applied[0].blocks.length, 2);
  assert.equal((await db.query("SELECT stage_status FROM ai_movie_projects WHERE id = $1", [pid])).rows[0].stage_status.screenplay, undefined, "the screenplay must be approved again");
  v = (await api("GET", cin())).json;
  const d2 = v.items.find((i) => i.id === direction.id);
  assert.equal(d2.waitingForChange, false);
  assert.equal(d2.stale, false);
  assert.match(d2.originalText, /steps through the fire/, "the direction now refers to the applied scene");
  assert.equal((await api("POST", cin(`/items/${direction.id}/approve`))).json.status, "approved");
  assert.equal((await api("POST", cin(`/items/${change.id}/approve`))).status, 409, "an already applied rewrite cannot be applied twice");
});

test("rejecting the rewrite means the direction made for it can no longer be used (stale), and the scene stays as written", async () => {
  await api("POST", cin("/analyze"), {}); await settled();
  const v = (await api("GET", cin())).json;
  const change = v.items.find((i) => i.kind === "screenplay_change");
  await api("POST", cin(`/items/${change.id}/reject`));
  const after = (await api("GET", cin())).json;
  assert.equal(after.items.find((i) => i.kind === "cinematic_direction" && i.sceneKey === "b1s0").stale, true);
  assert.equal(applied.length, 0);
});

test("after the screenplay is approved the Director only gives directions — a rewrite the model sends anyway is ignored", async () => {
  await db.query("UPDATE ai_movie_projects SET stage_status = $2 WHERE id = $1", [pid, JSON.stringify({ screenplay: { status: "approved" } })]);
  await api("POST", cin("/analyze"), {}); await settled();
  const v = (await api("GET", cin())).json;
  assert.equal(v.screenplayApproved, true);
  assert.equal(v.items.filter((i) => i.kind === "screenplay_change").length, 0);
  assert.equal(v.items.filter((i) => i.kind === "cinematic_direction").length, 2);
  assert.match(calls[0].params.contents, /APPROVED and locked/);
  assert.equal(JSON.stringify(v.items).includes("enhancedBlocks"), false, "no rewrite text is stored on a direction");
});

test("editing: the user can edit a pending rewrite or direction before approving; bad edits are refused; decided items cannot be edited", async () => {
  await api("POST", cin("/analyze"), {}); await settled();
  const items = (await api("GET", cin())).json.items;
  const change = items.find((i) => i.kind === "screenplay_change");
  const bad = await api("PATCH", cin(`/items/${change.id}`), { payload: { enhancedBlocks: [] } });
  assert.equal(bad.status, 400);
  const good = await api("PATCH", cin(`/items/${change.id}`), { payload: { enhancedBlocks: [{ type: "action", text: "Rudra leaps the flames." }] } });
  assert.equal(good.status, 200);
  assert.equal((await api("POST", cin(`/items/${change.id}/approve`))).json.status, "applied");
  assert.match(applied[0].blocks[0].text, /leaps the flames/);
  assert.equal((await api("PATCH", cin(`/items/${change.id}`), { payload: { enhancedHeading: "x" } })).status, 409);
  const dir = items.find((i) => i.kind === "cinematic_direction" && i.sceneKey === "b0s0");
  assert.equal((await api("PATCH", cin(`/items/${dir.id}`), { payload: { purpose: "Edited purpose" } })).status, 200);
  const after = (await api("GET", cin())).json.items.find((i) => i.id === dir.id);
  assert.equal(after.payload.purpose, "Edited purpose");
  assert.equal(after.edited, true);
  assert.equal((await api("PATCH", cin(`/items/${dir.id}`), { payload: "nope" })).status, 400);
});

test("stale protection: editing a scene after the Director looked at it makes its direction stale — it cannot be approved and never reaches production", async () => {
  await db.query("UPDATE ai_movie_projects SET stage_status = $2 WHERE id = $1", [pid, JSON.stringify({ screenplay: { status: "approved" } })]);
  await api("POST", cin("/analyze"), {}); await settled();
  const dir = (await api("GET", cin())).json.items.find((i) => i.kind === "cinematic_direction" && i.sceneKey === "b1s0");
  await api("POST", cin(`/items/${dir.id}/approve`));
  assert.ok(await approvedDirectionFor(db, pid, "b1s0", scenes[1].text), "fresh and approved: visible to the Shot Cutter");
  scenes[1].text += "\nHe is wounded."; // the user edits the scene
  assert.equal(await approvedDirectionFor(db, pid, "b1s0", scenes[1].text), null, "stale: hidden from the Shot Cutter");
  const v = (await api("GET", cin())).json;
  assert.equal(v.items.find((i) => i.id === dir.id).stale, true);
  assert.equal(v.counts.stale, 1);
  assert.equal(v.counts.approvedDirections, 0);
  const send = await api("POST", cin("/send-to-production"));
  assert.equal(send.json.sentDirections, 0);
  assert.equal(send.json.skippedStale, 1);
  const pendingOther = (await api("GET", cin())).json.items.find((i) => i.kind === "cinematic_direction" && i.sceneKey === "b0s0");
  scenes[0].text += " changed";
  assert.equal((await api("POST", cin(`/items/${pendingOther.id}/approve`))).status, 409);
});

test("send to production: refused until the final screenplay is approved; then approved directions go on, asset notes reach the Silent Agent, unreviewed ones are reported", async () => {
  script.b0s0 = dirFor({ spectacleLevel: "light", fights: [], massMoments: [], enhancedBlocks: [], enhancedHeading: "" });
  await api("POST", cin("/analyze"), {}); await settled();
  assert.equal((await api("POST", cin("/send-to-production"))).status, 409);
  await db.query("UPDATE ai_movie_projects SET stage_status = $2 WHERE id = $1", [pid, JSON.stringify({ screenplay: { status: "approved" } })]);
  // the screenplay was approved after the rewrite proposals: apply none, approve the b0s0 direction only
  const items = (await api("GET", cin())).json.items;
  const change = items.find((i) => i.kind === "screenplay_change");
  await api("POST", cin(`/items/${change.id}/reject`));
  const dir0 = items.find((i) => i.kind === "cinematic_direction" && i.sceneKey === "b0s0");
  await api("POST", cin(`/items/${dir0.id}/approve`));
  assert.match(backfillSaved.cinematicAssetNotes, /APPROVED CINEMATIC ADDITIONS/);
  assert.match(backfillSaved.cinematicAssetNotes, /\(prop\) Burning bridge/);
  const send = await api("POST", cin("/send-to-production"));
  assert.equal(send.status, 200);
  assert.equal(send.json.sentDirections, 1);
  assert.deepEqual(send.json.scenes, ["b0s0"]);
  assert.equal(send.json.assetsRefreshed, true);
  assert.deepEqual(refreshed, [pid]);
  assert.equal(send.json.stillUnreviewed, 0);
  assert.ok(await approvedDirectionFor(db, pid, "b0s0", scenes[0].text), "'sent' directions stay available to the Shot Cutter");
});

test("money limit: the Director stops cleanly when the limit is reached (partial results kept, nothing over the limit)", async () => {
  await saveSettings(db, pid, { budgetLimitUsd: 0.15 }); // room for exactly one Pro call ($0.12)
  const r = await api("POST", cin("/analyze"), {});
  assert.equal(r.status, 200);
  await settled();
  const v = (await api("GET", cin())).json;
  assert.equal(calls.length, 1);
  assert.equal(v.job.stoppedBy, "money_limit");
  assert.match(v.job.error, /limit/);
  assert.equal(v.items.filter((i) => i.kind === "cinematic_direction").length, 1);
  assert.ok((await spendSummary(db, pid)).spentUsd <= 0.15);
  await saveSettings(db, pid, { budgetLimitUsd: 0.01 });
  const blocked = await api("POST", cin("/analyze"), {});
  assert.equal(blocked.status, 402);
  calls = [];
  assert.equal((await api("POST", cin("/story-recommendations"))).status, 402);
  assert.equal(calls.length, 0);
});

test("a failure in the model stops the job with a plain message and keeps what was done; routes refuse unknown projects and items", async () => {
  script.b1s0 = "THROW";
  await api("POST", cin("/analyze"), {});
  const v = await until(async () => { const r = (await api("GET", cin())).json; return r.job.status === "failed" ? r : null; }, "failure");
  assert.match(v.job.error, /The Director stopped: model down/);
  assert.equal(v.job.done, 1);
  assert.equal(v.items.filter((i) => i.kind === "cinematic_direction").length, 1);
  assert.equal((await api("GET", `/api/ai-movie/projects/999999/cinematic`)).status, 404);
  assert.equal((await api("POST", cin("/items/999999/approve"))).status, 404);
  assert.equal((await api("POST", cin("/items/abc/approve"))).status, 404);
});

test("what production reads: direction text for the Shot Cutter prompt, and asset notes skip stale directions", async () => {
  const d = dirFor();
  const text = directionPromptBlock(d);
  assert.match(text, /APPROVED CINEMATIC DIRECTIONS FOR THIS SCENE/);
  assert.match(text, /SHOT 1: Wide of the bridge/);
  assert.match(text, /IF HARD TO GENERATE \(contact\): cut on impact/);
  assert.equal(directionPromptBlock(null), "");
  assert.match(directionToText(d), /Signature beats: Fights blind in the smoke/);
  await db.query(
    `INSERT INTO ai_movie_cinematic_items (project_id, kind, scene_key, scene_hash, status, payload) VALUES ($1,'cinematic_direction','b1s0',$2,'approved',$3), ($1,'cinematic_direction','b0s0',$4,'approved',$5)`,
    [pid, sceneHash(scenes[1].text), JSON.stringify(d), "oldhash", JSON.stringify({ newAssets: [{ kind: "prop", name: "STALE PROP", description: "x" }] })]
  );
  const notes = await cinematicAssetNotesText(db, pid, new Map(scenes.map((s) => [s.key, sceneHash(s.text)])));
  assert.match(notes, /Burning bridge/);
  assert.doesNotMatch(notes, /STALE PROP/);
  assert.equal(AGENT_ID, "ai-cinematic-spectacle-director");
});

test("one project's cinematic items never show in another project", async () => {
  await api("POST", cin("/analyze"), {}); await settled();
  const other = (await db.query("INSERT INTO ai_movie_projects (pasted_text, title) VALUES ('x','[TEST] cin other') RETURNING id")).rows[0].id;
  const v = (await api("GET", `/api/ai-movie/projects/${other}/cinematic`)).json;
  assert.equal(v.items.length, 0);
});
