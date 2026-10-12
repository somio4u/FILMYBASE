// AI Movie's Story Bible stage, the Pro judges + Script Editor, the stage judge loop, quality modes and the
// money guard. MOCK TESTS: the Story Brain and the model calls are scripted fakes (no Google service is
// contacted), the database is a real local Postgres.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { ensureAiMovieStorySchema, registerAiMovieStoryRoutes, judgedStage, createAiMovieAsker, runJudgePanel, stageJudgeText } from "../aiMovieStory.js";
import { ensurePipelineSettingsSchema, saveSettings, spendSummary } from "../pipelineSettings.js";
import { modelFor, QUALITY_MODES, AGENT_ROUTES, isComplexActionScene, shotCutterRoute, estimateCost } from "../modelRouting.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let server, base, pid, calls, judgeScores, bibleApproved;

const FAKE_BIBLE = { promise: { title: "Test Film" }, units: { kind: "sequence", label: "a film" }, review: { passed: true, scores: { a: 8, b: 9 } } };
const storyBrain = {
  BIBLE_PASS_SCORE: 8,
  storyBibleToMarkdown: (b) => `# ${b.promise.title} — Story Bible\n\nhello`,
  designStoryBible: async (idea, format, { onProgress }) => {
    onProgress("Pitch room");
    return { bible: { ...FAKE_BIBLE, idea, format }, usage: { calls: 3, promptTokens: 1000, outputTokens: 2000, thinkingTokens: 500, models: ["gemini-3.1-pro-preview"] } };
  },
  reviseBibleWithNote: async (bible, note, { onProgress }) => {
    onProgress("Head writer follows your note");
    return { bible: { ...bible, userNotes: [note] }, usage: { calls: 2, promptTokens: 500, outputTokens: 700, thinkingTokens: 100, models: ["gemini-3.1-pro-preview"] } };
  },
};
// Scripted model: records every call (tier + prompt) and answers by what the prompt asks for.
async function callTier(tier, params) {
  calls.push({ tier, params });
  const text = String(params.contents);
  if (/You are the (Story|Audience|Cinematic) Judge/.test(text)) {
    const score = judgeScores.length ? judgeScores.shift() : 8;
    return { score, verdict: `verdict ${score}`, strengths: ["good"], problems: score < 7 ? [{ where: "Beat 2", severity: "major", issue: "sags", fix: "cut the repeat" }] : [], criticalProblem: "" };
  }
  if (/Script Editor|Consolidate/.test(text)) {
    return { summary: "ok", recommendation: "revise", contradictions: [{ between: "Story vs Audience", issue: "pace", resolution: "trim" }], consolidatedFixes: [{ target: "Beat 2", fix: "trim", priority: "high", fromJudges: ["story-judge"] }] };
  }
  return {};
}
const requireRole = () => (req, res, next) => ((req.user = { id: 1 }), next());
const api = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text };
};
const until = async (fn, what, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 30)); }
};
const newProject = async (text = "A dancer fights a storm.") => {
  const row = (await db.query("INSERT INTO ai_movie_projects (pasted_text, title) VALUES ($1,'[TEST] story') RETURNING id", [text])).rows[0];
  return row.id;
};

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await ensureAiMovieStorySchema(db);
  await ensureAiMovieStorySchema(db); // idempotent
  await ensurePipelineSettingsSchema(db);
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] story%'");
  const app = express();
  app.use(express.json());
  registerAiMovieStoryRoutes(app, db, requireRole, {
    storyBrain, callTier, sceneText: (s) => s.text ?? "", checklists: { pitchDeck: "- true to idea", threeAct: "- act", bitSheet: "- beats" },
    onBibleApproved: async (projectId) => { bibleApproved.push(projectId); },
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => { calls = []; judgeScores = []; bibleApproved = []; pid = await newProject(); });
test.after(async () => { server.close(); await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] story%'"); await db.end(); });

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------

test("model routing: every agent has a route for all three quality modes, and the default is Professional", () => {
  for (const [agent, route] of Object.entries(AGENT_ROUTES)) for (const mode of QUALITY_MODES) assert.ok(["pro", "flash", "flashLite"].includes(route[mode]), `${agent}/${mode}`);
  assert.equal(modelFor("story-judge").tier, "pro");
  assert.throws(() => modelFor("no-such-agent"), /Unknown AI agent/);
});

test("model routing: the required Pro agents are Pro in EVERY mode; routine agents stay Flash / Flash-Lite", () => {
  for (const mode of QUALITY_MODES) {
    for (const a of ["story-brain-head-writer", "story-brain-critics", "story-judge", "audience-judge", "cinematic-judge", "script-editor", "ai-cinematic-spectacle-director"]) assert.equal(modelFor(a, mode).tier, "pro", `${a} in ${mode}`);
    for (const a of ["silent-agent", "language-checker", "storyboard-writer", "voice-writer", "writing-assistant"]) assert.equal(modelFor(a, mode).tier, "flash", `${a} in ${mode}`);
    assert.equal(modelFor("production-assistant", mode).tier, "flashLite");
  }
});

test("model routing: the three quality modes differ where the brief says they should", () => {
  assert.equal(modelFor("story-writer", "economy").tier, "flash");
  assert.equal(modelFor("story-writer", "professional").tier, "pro");
  assert.equal(modelFor("dialogue-draft", "professional").tier, "flash");
  assert.equal(modelFor("dialogue-polish", "professional").tier, "pro");
  assert.equal(modelFor("dialogue-polish", "economy").tier, "flash");
  assert.equal(modelFor("dialogue-draft", "maximum").tier, "pro");
  assert.equal(modelFor("scene-writer", "maximum").tier, "pro");
  assert.equal(modelFor("scene-writer", "professional").tier, "flash");
  assert.equal(modelFor("scene-writer-key", "professional").tier, "pro");
  assert.equal(modelFor("story-judge", "story-judge" && "economy", { forcePro: true }).tier, "pro");
});

test("model routing: Shot Cutter uses Pro for complex action in Professional, Flash for a quiet scene, Pro for everything in Maximum", () => {
  const quiet = { text: "Rahul sits at his desk and drinks tea.", characterCount: 1 };
  const fight = { text: "The two warriors fight. Swords clash. A battle begins and the bridge collapses.", characterCount: 3 };
  assert.equal(isComplexActionScene(quiet), false);
  assert.equal(isComplexActionScene(fight), true);
  assert.equal(isComplexActionScene({ text: "calm", direction: { fight: { motivation: "x" } } }), true);
  assert.equal(shotCutterRoute("professional", quiet).tier, "flash");
  assert.equal(shotCutterRoute("professional", fight).tier, "pro");
  assert.equal(shotCutterRoute("economy", fight).tier, "flash");
  assert.equal(shotCutterRoute("maximum", quiet).tier, "pro");
});

// ---------------------------------------------------------------------------
// Story Bible stage
// ---------------------------------------------------------------------------

test("Story Bible: design runs in the background, saves the bible, spend is recorded and the screen can read progress", async () => {
  assert.equal((await api("GET", `/api/ai-movie/projects/${pid}/story-bible`)).json.status, "none");
  const start = await api("POST", `/api/ai-movie/projects/${pid}/story-bible/design`, { format: { type: "film", runtimeMinutes: 90 } });
  assert.equal(start.status, 200);
  const view = await until(async () => { const r = (await api("GET", `/api/ai-movie/projects/${pid}/story-bible`)).json; return r.bible && r.job.status === "idle" ? r : null; }, "design finish");
  assert.equal(view.status, "pending");
  assert.match(view.markdown, /Test Film/);
  assert.equal(view.bible.format.runtimeMinutes, 90);
  assert.ok(view.job.notes.some((n) => /Pitch room/.test(n)) && view.job.notes.some((n) => /critics passed it/.test(n)));
  const spend = await spendSummary(db, pid);
  assert.ok(spend.byKind.text.usd > 0, "the Story Brain's tokens were written to the spend ledger");
});

test("Story Bible: your note revises it; approval marks the stage and tells the project; approve without a bible is refused", async () => {
  assert.equal((await api("POST", `/api/ai-movie/projects/${pid}/story-bible/approve`)).status, 400);
  assert.equal((await api("POST", `/api/ai-movie/projects/${pid}/story-bible/note`, { note: "x" })).status, 400);
  await api("POST", `/api/ai-movie/projects/${pid}/story-bible/design`, {});
  await until(async () => (await api("GET", `/api/ai-movie/projects/${pid}/story-bible`)).json.job.status === "idle", "design");
  assert.equal((await api("POST", `/api/ai-movie/projects/${pid}/story-bible/note`, { note: "  " })).status, 400);
  assert.equal((await api("POST", `/api/ai-movie/projects/${pid}/story-bible/note`, { note: "Make the villain a sister." })).status, 200);
  const after = await until(async () => { const r = (await api("GET", `/api/ai-movie/projects/${pid}/story-bible`)).json; return r.bible.userNotes && r.job.status === "idle" ? r : null; }, "revision");
  assert.deepEqual(after.bible.userNotes, ["Make the villain a sister."]);
  assert.equal((await api("POST", `/api/ai-movie/projects/${pid}/story-bible/approve`)).status, 200);
  assert.deepEqual(bibleApproved, [pid]);
  assert.equal((await api("GET", `/api/ai-movie/projects/${pid}/story-bible`)).json.status, "approved");
  const html = await api("GET", `/api/ai-movie/projects/${pid}/story-bible.html`);
  assert.match(html.text, /<h1>Test Film/);
});

test("Story Bible: money limit is checked BEFORE the Pro-model run (nothing starts, nothing is spent)", async () => {
  await saveSettings(db, pid, { budgetLimitUsd: 0.5 });
  const r = await api("POST", `/api/ai-movie/projects/${pid}/story-bible/design`, {});
  assert.equal(r.status, 402);
  assert.equal(r.json.code, "over_budget");
  assert.equal((await api("GET", `/api/ai-movie/projects/${pid}/story-bible`)).json.status, "none");
  assert.equal((await spendSummary(db, pid)).spentUsd, 0);
});

test("Story Bible: a second design click while one is running is refused; an empty idea is refused", async () => {
  await db.query("UPDATE ai_movie_projects SET story_bible_job = $2 WHERE id = $1", [pid, JSON.stringify({ status: "running", startedAt: new Date().toISOString() })]);
  assert.equal((await api("POST", `/api/ai-movie/projects/${pid}/story-bible/design`, {})).status, 409);
  const empty = await db.query("INSERT INTO ai_movie_projects (pasted_text, title) VALUES ('   ','[TEST] story empty') RETURNING id");
  assert.equal((await api("POST", `/api/ai-movie/projects/${empty.rows[0].id}/story-bible/design`, {})).status, 400);
});

// ---------------------------------------------------------------------------
// Settings: quality + creative mode
// ---------------------------------------------------------------------------

test("settings: new projects default to Professional quality + Mass Spectacle; both can be changed independently; bad values refused", async () => {
  const first = (await api("GET", `/api/ai-movie/projects/${pid}/ai-settings`)).json;
  assert.equal(first.qualityMode, "professional");
  assert.equal(first.cinematicMode, "mass");
  assert.equal(first.qualityModes.length, 3);
  assert.ok(first.routing.find((r) => r.agent === "story-judge"));
  await api("PATCH", `/api/ai-movie/projects/${pid}/ai-settings`, { qualityMode: "economy" });
  let now = (await api("GET", `/api/ai-movie/projects/${pid}/ai-settings`)).json;
  assert.deepEqual([now.qualityMode, now.cinematicMode], ["economy", "mass"]);
  await api("PATCH", `/api/ai-movie/projects/${pid}/ai-settings`, { cinematicMode: "balanced" });
  now = (await api("GET", `/api/ai-movie/projects/${pid}/ai-settings`)).json;
  assert.deepEqual([now.qualityMode, now.cinematicMode], ["economy", "balanced"]);
  assert.equal((await api("PATCH", `/api/ai-movie/projects/${pid}/ai-settings`, { qualityMode: "turbo" })).status, 400);
  assert.equal((await api("PATCH", `/api/ai-movie/projects/${pid}/ai-settings`, { cinematicMode: "wild" })).status, 400);
  assert.equal((await api("GET", `/api/ai-movie/projects/999999/ai-settings`)).status, 404);
});

// ---------------------------------------------------------------------------
// Stage judge loop
// ---------------------------------------------------------------------------

const SYN = { logline: { en: "L", hi: "L" }, premise: { en: "P", hi: "P" }, toneGenre: { en: "T", hi: "T" }, targetAudience: { en: "A", hi: "A" } };
const makeAsk = () => createAiMovieAsker({ db, callTier });

test("stage judge loop: a good first draft passes with one Pro judge call and no revision", async () => {
  judgeScores = [8];
  let revisions = 0;
  const out = await judgedStage({ ask: makeAsk(), projectId: pid, stageKey: "synopsis", idea: "idea", firstDraft: SYN, revise: async () => { revisions++; return SYN; } });
  assert.equal(revisions, 0);
  assert.equal(out.judge.versions.length, 1);
  assert.equal(out.judge.passed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tier, "pro");
  assert.match(calls[0].params.contents, /THE USER'S ORIGINAL IDEA/);
});

test("stage judge loop: revisions are capped per quality mode (economy 1, professional 2, maximum 3) and the BEST version is kept", async () => {
  for (const [mode, cap] of [["economy", 1], ["professional", 2], ["maximum", 3]]) {
    await db.query("UPDATE ai_movie_projects SET quality_mode = $2 WHERE id = $1", [pid, mode]);
    judgeScores = [4, 6, 5, 5, 5];
    let n = 0;
    const out = await judgedStage({ ask: makeAsk(), projectId: pid, stageKey: "plot", idea: "i", firstDraft: [{ title: { en: "v1" }, description: { en: "d" } }], revise: async (d, fb) => { n++; assert.match(fb, /Beat 2: sags/); return [{ title: { en: `v${n + 1}` }, description: { en: "d" } }]; } });
    assert.equal(n, cap, `${mode} revisions`);
    assert.equal(out.judge.versions.length, cap + 1);
    assert.equal(out.judge.passed, false);
    assert.equal(out.judge.kept, 2, "version 2 scored 6 — the best");
    assert.equal(out.content[0].title.en, "v2");
  }
});

test("stage judge loop: money limit is checked before every Pro judge call", async () => {
  await saveSettings(db, pid, { budgetLimitUsd: 0.05 });
  await assert.rejects(judgedStage({ ask: makeAsk(), projectId: pid, stageKey: "synopsis", idea: "i", firstDraft: SYN, revise: async () => SYN }), (e) => e.status === 402);
  assert.equal(calls.length, 0, "no model was called");
});

test("stageJudgeText reads the AI Movie layer shapes", () => {
  assert.match(stageJudgeText("synopsis", SYN), /LOGLINE: L/);
  assert.match(stageJudgeText("characterArc", [{ name: "Rudra", want: { en: "w" }, need: { en: "n" }, arc: { en: "a" } }]), /Rudra: wants w/);
  assert.match(stageJudgeText("threeAct", [{ actName: { en: "Act 1" }, description: { en: "d" }, turningPoint: { en: "t" } }]), /Act 1: d/);
  assert.match(stageJudgeText("plot", [{ title: { en: "B" }, description: { en: "d" }, runtimeMinutes: 3 }]), /Beat 1 — B \(3 min\)/);
});

// ---------------------------------------------------------------------------
// Three judges + Script Editor
// ---------------------------------------------------------------------------

test("judge panel: three independent Pro judges (no judge sees another's answer) + the Pro Script Editor; actionable fixes", async () => {
  judgeScores = [5, 9, 7];
  await db.query("UPDATE ai_movie_projects SET story_bible = $2 WHERE id = $1", [pid, JSON.stringify(FAKE_BIBLE)]);
  const r = await api("POST", `/api/ai-movie/projects/${pid}/judge-panel`, { target: "bible" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.judges.map((j) => j.role).sort(), ["audience-judge", "cinematic-judge", "story-judge"]);
  assert.equal(calls.length, 4, "3 judges + 1 editor");
  assert.ok(calls.every((c) => c.tier === "pro"));
  const judgeCalls = calls.filter((c) => /You are the/.test(c.params.contents));
  assert.equal(judgeCalls.length, 3);
  for (const c of judgeCalls) assert.doesNotMatch(c.params.contents, /verdict \d/, "a judge's prompt never contains another judge's verdict");
  assert.match(judgeCalls.find((c) => /Cinematic Judge/.test(c.params.contents)).params.contents, /AI filmmaking feasibility/);
  assert.match(judgeCalls.find((c) => /Audience Judge/.test(c.params.contents)).params.contents, /Mass audience appeal/);
  assert.match(judgeCalls.find((c) => /Story Judge/.test(c.params.contents)).params.contents, /Plot logic and continuity/);
  assert.equal(calls.at(-1).params.contents.includes("THE THREE INDEPENDENT JUDGES' REPORTS"), true, "the editor sees all three reports");
  assert.equal(r.json.editor.consolidatedFixes[0].target, "Beat 2");
  assert.equal(r.json.editor.contradictions.length, 1);
  assert.equal(r.json.cached, false);
  assert.ok(r.json.judges.find((j) => j.score < 7).problems[0].fix, "problems carry a concrete fix, not just a score");
});

test("judge panel: an unchanged target is answered from the cache (no model calls, no spend); changed text or force re-runs", async () => {
  await db.query("UPDATE ai_movie_projects SET story_bible = $2 WHERE id = $1", [pid, JSON.stringify(FAKE_BIBLE)]);
  await api("POST", `/api/ai-movie/projects/${pid}/judge-panel`, { target: "bible" });
  const spent = (await spendSummary(db, pid)).spentUsd;
  calls = [];
  const again = await api("POST", `/api/ai-movie/projects/${pid}/judge-panel`, { target: "bible" });
  assert.equal(again.json.cached, true);
  assert.equal(calls.length, 0);
  assert.equal((await spendSummary(db, pid)).spentUsd, spent);
  await api("POST", `/api/ai-movie/projects/${pid}/judge-panel`, { target: "bible", force: true });
  assert.equal(calls.length, 4);
  calls = [];
  await db.query("UPDATE ai_movie_projects SET story_bible = $2 WHERE id = $1", [pid, JSON.stringify({ ...FAKE_BIBLE, promise: { title: "Changed" } })]);
  await api("POST", `/api/ai-movie/projects/${pid}/judge-panel`, { target: "bible" });
  assert.equal(calls.length, 4, "changed input is judged again");
});

test("judge panel: only the changed beat is re-judged (beat:N targets are cached separately)", async () => {
  const beats = [0, 1].map((i) => ({ status: "approved", scenes: [{ text: `Scene of beat ${i}` }] }));
  await db.query("UPDATE ai_movie_projects SET backfill = $2 WHERE id = $1", [pid, JSON.stringify({ screenplayBeats: beats })]);
  await api("POST", `/api/ai-movie/projects/${pid}/judge-panel`, { target: "beat:0" });
  await api("POST", `/api/ai-movie/projects/${pid}/judge-panel`, { target: "beat:1" });
  calls = [];
  beats[1].scenes[0].text = "Beat 1 was rewritten";
  await db.query("UPDATE ai_movie_projects SET backfill = $2 WHERE id = $1", [pid, JSON.stringify({ screenplayBeats: beats })]);
  const r0 = await api("POST", `/api/ai-movie/projects/${pid}/judge-panel`, { target: "beat:0" });
  assert.equal(r0.json.cached, true);
  const r1 = await api("POST", `/api/ai-movie/projects/${pid}/judge-panel`, { target: "beat:1" });
  assert.equal(r1.json.cached, false);
  assert.equal(calls.length, 4);
});

test("judge panel: money limit is checked before the whole panel; bad targets and missing material are refused", async () => {
  await db.query("UPDATE ai_movie_projects SET story_bible = $2 WHERE id = $1", [pid, JSON.stringify(FAKE_BIBLE)]);
  await saveSettings(db, pid, { budgetLimitUsd: 0.3 });
  const r = await api("POST", `/api/ai-movie/projects/${pid}/judge-panel`, { target: "bible" });
  assert.equal(r.status, 402);
  assert.equal(calls.length, 0);
  assert.equal((await api("POST", `/api/ai-movie/projects/${pid}/judge-panel`, { target: "nonsense" })).status, 400);
  assert.equal((await api("POST", `/api/ai-movie/projects/${pid}/judge-panel`, { target: "screenplay" })).status, 400);
  assert.equal((await api("POST", `/api/ai-movie/projects/${pid}/judge-panel`, { target: "stage:synopsis" })).status, 400);
});

test("cost estimates: Pro costs more than Flash, which costs more than Flash-Lite", () => {
  assert.ok(estimateCost("pro") > estimateCost("flash") && estimateCost("flash") > estimateCost("flashLite"));
});
