// AI Movie language conversion (Odia / Hindi / English) and the Voice Writer route. MOCK TESTS: the translator and
// the model are scripted fakes, so what is checked is the app's own logic — validation, retry, staleness, money guard, storage.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { ensureAiMovieStorySchema, createAiMovieAsker } from "../aiMovieStory.js";
import { ensurePipelineSettingsSchema, saveSettings, spendSummary } from "../pipelineSettings.js";
import { ensureAiMovieLanguageSchema, registerAiMovieLanguageRoutes, validateConversion } from "../aiMovieLanguage.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let server, base, pid, scenes, translateCalls, askCalls, translate, voice, spoken;

const ODIA = (t) => String(t).split(/\s+/).map(() => "ଓଡ଼ିଆ").join(" "); // every word becomes an Odia word
const src = [
  { type: "action", character: "", parenthetical: "", text: "Rudra enters the hall." },
  { type: "dialogue", character: "RUDRA", parenthetical: "softly", text: "Where is she?" },
  { type: "transition", character: "", parenthetical: "", text: "CUT TO:" },
];
const goodOdia = (els) => els.map((e) => (e.type === "transition" ? e : { ...e, text: ODIA(e.text), parenthetical: e.parenthetical ? ODIA(e.parenthetical) : e.parenthetical }));

const requireRole = () => (req, res, next) => ((req.user = { id: 1 }), next());
const api = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, json, text };
};
const L = (suffix = "") => `/api/ai-movie/projects/${pid}/language${suffix}`;

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await ensureAiMovieStorySchema(db);
  await ensurePipelineSettingsSchema(db);
  await ensureAiMovieLanguageSchema(db);
  await ensureAiMovieLanguageSchema(db);
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] lang%'");
  const ask = createAiMovieAsker({
    db,
    callTier: async (tier, params) => { askCalls.push({ tier, params }); return spoken(params); },
  });
  const app = express();
  app.use(express.json());
  registerAiMovieLanguageRoutes(app, db, requireRole, {
    translateElements: async (els, from, to) => { translateCalls.push({ from, to }); return translate(els, to, translateCalls.length); },
    getSceneBlocks: async () => scenes,
    ask: (projectId, agent, params) => ask.ask(projectId, agent, params),
    spokenRule: "ODIA RULE",
    voiceToElements: async (args) => voice(args),
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  translateCalls = []; askCalls = [];
  translate = (els) => goodOdia(els);
  spoken = (params) => ({ lines: JSON.parse(String(params.contents).slice(String(params.contents).lastIndexOf("[\"") ).replace(/^[^[]*/, "")).map((t) => `${t}`) });
  voice = async () => ({ transcript: "t", elements: [{ type: "dialogue", character: "RUDRA", text: "Hello" }], insertAfter: 1, note: "done" });
  scenes = [
    { key: "b0s0", beatIndex: 0, sceneIndex: 0, heading: "INT. HALL - DAY", blocks: src },
    { key: "b0s1", beatIndex: 0, sceneIndex: 1, heading: "EXT. GARDEN - NIGHT", blocks: [{ type: "action", character: "", parenthetical: "", text: "Rain falls." }] },
  ];
  pid = (await db.query("INSERT INTO ai_movie_projects (pasted_text, title) VALUES ('idea','[TEST] lang') RETURNING id")).rows[0].id;
});
test.after(async () => { server.close(); await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] lang%'"); await db.end(); });

test("validateConversion: accepts a faithful conversion; flags changed blocks, changed speakers, empty lines and untranslated lines", () => {
  assert.deepEqual(validateConversion(src, goodOdia(src), "or"), []);
  assert.match(validateConversion(src, goodOdia(src).slice(0, 2), "or")[0].problem, /Expected 3 blocks/);
  const wrongType = goodOdia(src); wrongType[1] = { ...wrongType[1], type: "action" };
  assert.match(validateConversion(src, wrongType, "or")[0].problem, /block type changed/);
  const wrongName = goodOdia(src); wrongName[1] = { ...wrongName[1], character: "KAAL" };
  assert.match(validateConversion(src, wrongName, "or")[0].problem, /speaker name changed/);
  const empty = goodOdia(src); empty[0] = { ...empty[0], text: "  " };
  assert.match(validateConversion(src, empty, "or")[0].problem, /came back empty/);
  const english = goodOdia(src); english[1] = { ...english[1], text: "Where is she?" };
  assert.match(validateConversion(src, english, "or")[0].problem, /does not look like Odia/);
  assert.deepEqual(validateConversion(src, goodOdia(src).map((b) => ({ ...b, text: b.type === "dialogue" ? "ଆଉ English ଶବ୍ଦ ମିଶା ଓଡ଼ିଆ" : b.text })), "or"), [], "code-mixed English inside real Odia is fine");
  assert.match(validateConversion(src, src.map((b) => ({ ...b, text: b.type === "transition" ? b.text : `${b.text} हिंदी` })), "en")[0].problem, /still contains Hindi/);
  assert.deepEqual(validateConversion([{ type: "dialogue", character: "RUDRA", text: "RUDRA" }], [{ type: "dialogue", character: "RUDRA", text: "RUDRA" }], "or"), [], "a cue that is only a NAME stays as it is");
});

test("convert to Odia: one scene is converted, validated, stored; transitions stay English; the spoken-language pass runs", async () => {
  spoken = () => ({ lines: [ODIA("Rudra enters the hall."), "ଓଡ଼ିଆ ପଲିସ୍ ହେଲା"] });
  const r = await api("POST", L("/convert"), { language: "or", scope: "scene", beatIndex: 0, sceneIndex: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.json.converted, 1);
  assert.equal(r.json.withIssues, 0);
  assert.equal(r.json.results[0].spokenChecked, true);
  assert.equal(translateCalls.length, 1);
  assert.deepEqual(translateCalls[0], { from: "en", to: "or" });
  assert.equal(askCalls.length, 1);
  assert.equal(askCalls[0].tier, "flash", "the Language Checker stays on Flash in every mode");
  assert.match(askCalls[0].params.contents, /ODIA RULE/);
  const ex = await api("GET", L("/export?language=or&format=json"));
  const s0 = ex.json.scenes[0];
  assert.equal(s0.blocks[2].text, "CUT TO:");
  assert.equal(s0.blocks[1].text, "ଓଡ଼ିଆ ପଲିସ୍ ହେଲା", "the spoken-language pass result is what is stored");
  assert.equal(ex.json.scenes[1].missing, true, "the other scene is not converted yet");
  const txt = await api("GET", L("/export?language=or"));
  assert.match(txt.text, /INT\. HALL - DAY/);
  assert.match(txt.text, /\[not converted yet\]/);
  assert.ok((await spendSummary(db, pid)).byKind.text.usd > 0);
});

test("convert all: every scene; a bad translation is retried once for the failing blocks, and what still fails is REPORTED, not hidden", async () => {
  let n = 0;
  translate = (els) => { n++; return n === 1 ? els.map((e) => (e.type === "dialogue" ? { ...e, text: "Where is she?" } : e.type === "action" ? { ...e, text: ODIA(e.text) } : e)) : goodOdia(els); };
  const r = await api("POST", L("/convert"), { language: "or", scope: "all" });
  assert.equal(r.json.converted, 2);
  assert.equal(r.json.withIssues, 0, "the retry fixed the dialogue line");
  assert.equal(translateCalls.length, 3, "scene 1 needed a retry; scene 2 did not");
  translate = (els) => els.map((e) => ({ ...e })); // never translates: stays English
  const bad = await api("POST", L("/convert"), { language: "or", scope: "scene", beatIndex: 0, sceneIndex: 0 });
  assert.equal(bad.json.withIssues, 1);
  assert.match(bad.json.results[0].issues[0].problem, /does not look like Odia/);
  assert.equal(bad.json.results[0].spokenChecked, false, "the spoken pass is not run on a conversion that failed validation");
  const status = (await api("GET", L())).json;
  assert.ok(status.conversions.find((c) => c.sceneKey === "b0s0").issues.length > 0, "the issues are kept on the stored conversion");
});

test("a converted scene whose English changes afterwards is marked OUT OF DATE (never silently reused)", async () => {
  await api("POST", L("/convert"), { language: "or", scope: "scene", beatIndex: 0, sceneIndex: 0 });
  assert.equal((await api("GET", L())).json.conversions[0].outOfDate, false);
  scenes[0].blocks = [...src, { type: "action", character: "", parenthetical: "", text: "A bell rings." }];
  assert.equal((await api("GET", L())).json.conversions[0].outOfDate, true);
  assert.match((await api("GET", L("/export?language=or"))).text, /OUT OF DATE/);
  await api("POST", L("/convert"), { language: "or", scope: "scene", beatIndex: 0, sceneIndex: 0 });
  assert.equal((await api("GET", L())).json.conversions[0].outOfDate, false);
});

test("Hindi and English already live inside every AI Movie scene: converting to them makes no AI call and says so", async () => {
  for (const language of ["hi", "en"]) {
    const r = await api("POST", L("/convert"), { language, scope: "all" });
    assert.equal(r.json.alreadyInside, true);
  }
  assert.equal(translateCalls.length + askCalls.length, 0);
  assert.equal((await api("GET", L("/export?language=en&format=json"))).json.scenes[0].blocks.length, 3);
});

test("convert: bad language / scope / no scenes are refused with plain messages", async () => {
  assert.equal((await api("POST", L("/convert"), { language: "fr" })).status, 400);
  assert.equal((await api("POST", L("/convert"), { language: "or", scope: "weird" })).status, 400);
  assert.equal((await api("POST", L("/convert"), { language: "or", scope: "scene", beatIndex: 9, sceneIndex: 9 })).status, 400);
  assert.equal((await api("GET", "/api/ai-movie/projects/999999/language")).status, 404);
  assert.equal((await api("GET", L("/export?language=zz"))).status, 400);
});

test("money limit: conversion stops cleanly at the limit (nothing translated, nothing spent); the spend is recorded otherwise", async () => {
  await saveSettings(db, pid, { budgetLimitUsd: 0.001 });
  const r = await api("POST", L("/convert"), { language: "or", scope: "all" });
  assert.equal(r.json.stoppedByMoneyLimit, true);
  assert.equal(translateCalls.length, 0);
  assert.equal((await spendSummary(db, pid)).spentUsd, 0);
});

test("Voice Writer (Speak Here): a recording becomes draft lines for the scene editor; nothing is saved; bad recordings and money limit are refused", async () => {
  const audio = "A".repeat(400);
  let seen;
  voice = async (args) => { seen = args; return { transcript: "Rudra says hello", elements: [{ type: "dialogue", character: "RUDRA", text: "Hello" }], insertAfter: 2, note: "added" }; };
  const body = { audio, mimeType: "audio/webm;codecs=opus", beatIndex: 0, sceneIndex: 0, language: "hi", cursorAfter: 1, liveText: "rudra hello" };
  const ok = await api("POST", `/api/ai-movie/projects/${pid}/scene/voice`, body);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.draft, true);
  assert.equal(ok.json.added, 1);
  assert.equal(seen.dialogueLanguage, "hi");
  assert.equal(seen.sceneOutline, "INT. HALL - DAY");
  assert.equal(seen.existingElements.length, 3, "the scene's own blocks are the context");
  assert.equal(seen.defaultInsertAfter, 1);
  const withDraft = await api("POST", `/api/ai-movie/projects/${pid}/scene/voice`, { ...body, draftBlocks: [{ type: "action", text: "Only this" }] });
  assert.equal(seen.existingElements.length, 1, "while editing, the unsaved editor copy is the context");
  assert.equal(withDraft.status, 200);
  // the agent can also CHANGE and REMOVE lines of the draft, take a character out, or write the scene again; scene-list actions are not offered here
  voice = async (args) => { seen = args; return { transcript: "change line 1, remove Rudra", elements: [], insertAfter: 0, edits: [{ action: "replace", line: 1, text: "Changed words" }, { action: "remove_character", line: 0, text: "", character: "rudra", to: "" }], rewritten: [], sceneActions: [], note: "done" }; };
  const edited = await api("POST", `/api/ai-movie/projects/${pid}/scene/voice`, { ...body, draftBlocks: [{ type: "action", text: "Old words" }, { type: "dialogue", character: "RUDRA", text: "Hi" }, { type: "dialogue", character: "MEERA", text: "Hello" }] });
  assert.equal(edited.status, 200);
  assert.equal(seen.allowSceneActions, false);
  assert.deepEqual(edited.json.fullElements.map((e) => e.text), ["Changed words", "Hello"]);
  assert.equal(edited.json.changes.changed, 1);
  assert.equal(edited.json.changes.removed, 1);
  voice = async (args) => { seen = args; return { transcript: "Rudra says hello", elements: [{ type: "dialogue", character: "RUDRA", text: "Hello" }], insertAfter: 2, note: "added" }; };
  // the writer confirmed the words on screen: no recording is needed, the confirmed words are the instruction
  const confirmed = await api("POST", `/api/ai-movie/projects/${pid}/scene/voice`, { beatIndex: 0, sceneIndex: 0, language: "en", instruction: "  Add a line where Rudra says hello  " });
  assert.equal(confirmed.status, 200);
  assert.equal(seen.instructionText, "Add a line where Rudra says hello");
  assert.equal((await api("POST", `/api/ai-movie/projects/${pid}/scene/voice`, { ...body, audio: "short" })).status, 400);
  assert.equal((await api("POST", `/api/ai-movie/projects/${pid}/scene/voice`, { ...body, mimeType: "text/plain" })).status, 400);
  assert.equal((await api("POST", `/api/ai-movie/projects/${pid}/scene/voice`, { ...body, beatIndex: 7 })).status, 400);
  voice = async () => ({ transcript: "", elements: [], insertAfter: 0, note: "Nothing heard" });
  const empty = await api("POST", `/api/ai-movie/projects/${pid}/scene/voice`, body);
  assert.equal(empty.status, 422);
  assert.equal(empty.json.error, "Nothing heard");
  await saveSettings(db, pid, { budgetLimitUsd: 0.001 });
  assert.equal((await api("POST", `/api/ai-movie/projects/${pid}/scene/voice`, body)).status, 402);
});
