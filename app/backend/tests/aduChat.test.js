// Adu, the friendly front door of AI Movie (aduChat.js), step H1: sorting what is said, answering in words, the Draft Agent's reading of edits, the proposals
// for "write the whole screenplay" and "make a beat longer", and the memory of the conversation. REAL Postgres; the MODEL IS A SCRIPTED MOCK (nothing here
// proves how good the real model's answers are).
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { ensureAllProductionSchemas } from "../productionSchema.js";
import { ensureAduChatSchema, registerAduChatRoutes, handleAduMessage, loadHistory, clearHistory, looksLikeQuestion, sortWithoutAi, answerPrompt } from "../aduChat.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const J = (v) => JSON.stringify(v);
const t = (en) => ({ en, hi: en });
let ai, calls, server, base;

function models(over = {}) {
  calls = [];
  return {
    async json(draft, agent, prompt, opts) {
      const kind = prompt.includes("routing step") ? "classify" : prompt.includes("You are Adu") ? "answer" : "other";
      calls.push({ agent, kind, prompt, module: draft.module });
      if (over.json) { const r = await over.json(kind, prompt); if (r !== undefined) return r; }
      if (kind === "classify") return over.classify ?? { intent: "LOCAL_EDIT", summary: "Make the line colder.", targets: [{ type: "selection" }] };
      if (kind === "answer") return over.answer ?? { reply: "This scene is about a minute long." };
      return {};
    },
  };
}

async function fixtures() {
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[ADU-TEST]%'");
  const scene = (h, text) => ({ sceneHeading: t(h), content: [{ type: "action", text: t(text) }, { type: "dialogue", character: "MALA", text: t("Stay back.") }], estimatedMinutes: 1 });
  const backfill = {
    story: t("A dancer defies a cyclone."), synopsis: t("A village temple stands in a storm's path."),
    plot: [{ title: t("The warning"), description: t("Mala hears the bells.") }, { title: t("The storm"), description: t("The cyclone arrives.") }],
    screenplayBeats: [{ status: "approved", autoApproved: true, scenes: [scene("EXT. TEMPLE - DAY", "Mala dances before the storm."), scene("INT. TEMPLE - NIGHT", "Wind shakes the doors.")] }, { status: "not_started", scenes: null }],
  };
  ai = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, backfill, stage_status) VALUES ($1,$2,$3,$4) RETURNING id", ["[ADU-TEST] AI", "A dancer fights a cyclone.", J(backfill), J({})])).rows[0].id;
  await db.query("DELETE FROM adu_chat_messages WHERE project_ref = $1", [ai]);
}

test.before(async () => {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS concepts (id SERIAL PRIMARY KEY, concept_text TEXT NOT NULL, storylines JSONB NOT NULL, title TEXT, pinned BOOLEAN NOT NULL DEFAULT false, project_type TEXT NOT NULL DEFAULT 'story', clapboard_banner_path TEXT, owner_user_id INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS pitch_decks (id SERIAL PRIMARY KEY, concept_id INTEGER REFERENCES concepts(id) ON DELETE CASCADE, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS character_sheets (id SERIAL PRIMARY KEY, pitch_deck_id INTEGER REFERENCES pitch_decks(id) ON DELETE CASCADE, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS three_act_structures (id SERIAL PRIMARY KEY, pitch_deck_id INTEGER REFERENCES pitch_decks(id) ON DELETE CASCADE, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS bit_sheets (id SERIAL PRIMARY KEY, three_act_structure_id INTEGER REFERENCES three_act_structures(id) ON DELETE CASCADE, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS scene_lists (id SERIAL PRIMARY KEY, bit_sheet_id INTEGER REFERENCES bit_sheets(id) ON DELETE CASCADE, three_act_structure_id INTEGER, concept_id INTEGER REFERENCES concepts(id) ON DELETE CASCADE, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS screenplay_scenes (id SERIAL PRIMARY KEY, scene_list_id INTEGER REFERENCES scene_lists(id) ON DELETE CASCADE, episode_index INTEGER, scene_index INTEGER NOT NULL, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS ai_movie_projects (id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB, stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS ai_movie_reference_files (id SERIAL PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE, category TEXT NOT NULL DEFAULT 'other', label TEXT, content TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  ]) await db.query(sql);
  assert.deepEqual(await ensureAllProductionSchemas(db), []);
  await ensureAduChatSchema(db);
});
test.beforeEach(fixtures);
test.after(async () => { server?.close(); await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[ADU-TEST]%'"); await db.end(); });

test("sorting without the AI: questions and greetings are talk; commands are not; 'write the whole screenplay' and 'make beat 3 longer, 8 minutes' are recognised", () => {
  for (const q of ["How long is this scene?", "what can you help me with", "Why does Mala run away?", "kya yeh scene theek hai", "Hello", "thanks!", "କେମିତି ଏହି ସିନ୍ ଲମ୍ବା କରିବି", "यह scene कितना लंबा है", "क्या यह ठीक है?"]) assert.equal(looksLikeQuestion(q), true, q);
  for (const c of ["Make the villain colder", "Can you make the villain colder?", "please rewrite scene 2", "Change the ending"]) assert.equal(looksLikeQuestion(c), false, c);
  assert.deepEqual(sortWithoutAi("Write the whole screenplay"), { kind: "write", dialogue: true });
  assert.deepEqual(sortWithoutAi("write all the remaining scenes without dialogue"), { kind: "write", dialogue: false });
  assert.deepEqual(sortWithoutAi("please write the rest of the script"), { kind: "write", dialogue: true });
  assert.deepEqual(sortWithoutAi("Make beat 3 longer, about 8 minutes"), { kind: "extend", beatIndex: 2, minutes: 8 });
  assert.deepEqual(sortWithoutAi("extend this beat to 6 minutes", { beatIndex: 1 }), { kind: "extend", beatIndex: 1, minutes: 6 });
  assert.equal(sortWithoutAi("extend this beat to 6 minutes").beatIndex, null); // which beat? it will ask
  assert.deepEqual(sortWithoutAi("make it longer, 6 minutes", { beatIndex: 0 }), { kind: "extend", beatIndex: 0, minutes: 6 }); // the beat on screen
  assert.equal(sortWithoutAi("make it longer, 6 minutes").kind, "agent"); // no beat, no scene, nothing on screen: the Agent's classifier decides
  // the starter buttons of the chat in Hindi and Odia are commands too
  assert.deepEqual(sortWithoutAi("पूरी screenplay लिखो"), { kind: "write", dialogue: true });
  assert.deepEqual(sortWithoutAi("बाकी सारे scenes लिखो"), { kind: "write", dialogue: true });
  assert.deepEqual(sortWithoutAi("ପୁରା ସ୍କ୍ରିନପ୍ଲେ ଲେଖ"), { kind: "write", dialogue: true });
  assert.deepEqual(sortWithoutAi("beat 3 को 8 मिनट लंबा करो"), { kind: "extend", beatIndex: 2, minutes: 8 });
  assert.equal(sortWithoutAi("मैं जिस beat पर हूँ वह कितना लंबा है?").kind, "chat"); // a question about length is not an order to lengthen
  assert.equal(sortWithoutAi("How do I write the whole screenplay?").kind, "chat"); // a question about it is not the command
  assert.equal(sortWithoutAi("How do I make this scene longer?").kind, "chat");
  assert.equal(sortWithoutAi("Make the villain colder").kind, "agent");
  assert.equal(sortWithoutAi("   ").kind, "empty");
  assert.equal(sortWithoutAi("rewrite this dialogue so it sounds angrier", {}).kind, "agent");
});

test("a question is answered in words: the model sees the story, the beats, the scene on screen and the earlier conversation; nothing is proposed and the language is asked for", async () => {
  const m = models({ answer: { reply: "Scene 1 of beat 1 is about a minute long." } });
  const first = await handleAduMessage(db, m, { projectId: ai, userId: 7, text: "How long is this scene?", language: "or", context: { beatIndex: 0, sceneIndex: 0 } });
  assert.equal(first.sortedAs, "chat");
  assert.equal(first.assistant.content, "Scene 1 of beat 1 is about a minute long.");
  assert.equal(first.assistant.action, null);
  assert.equal(calls.length, 1); // one small call: the answer (no classifier for plain talk)
  assert.equal(calls[0].kind, "answer");
  assert.equal(calls[0].agent, "writing-assistant");
  assert.equal(calls[0].module, "ai_movie");
  const prompt = calls[0].prompt;
  assert.match(prompt, /Reply in Odia \(Odia script\)/);
  assert.match(prompt, /A dancer defies a cyclone/);
  assert.match(prompt, /Beat 1: The warning — approved \(automatically\), 2 scenes, with dialogue/);
  assert.match(prompt, /Beat 2: The storm — not written/);
  assert.match(prompt, /beat 1, scene 1:[\s\S]*Mala dances before the storm/);
  assert.match(prompt, /Write the whole screenplay/); // the app's guide is in it
  // the second question carries the first exchange
  await handleAduMessage(db, m, { projectId: ai, userId: 7, text: "And the next one?", language: "en" });
  assert.match(calls[1].prompt, /PERSON: How long is this scene\?[\s\S]*ADU: Scene 1 of beat 1 is about a minute long\./);
  assert.match(calls[1].prompt, /Reply in English/);
});

test("an edit is NOT done: the Draft Agent's classifier says what it understood and what it would touch, and the answer carries an action card for step H3", async () => {
  const m = models({ classify: { intent: "SCOPED_REWRITE", confidence: 0.9, summary: "Make Mala braver in the temple scenes.", targets: [{ type: "scenes", from: 1, to: 2 }] } });
  const before = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [ai])).rows[0].backfill;
  const r = await handleAduMessage(db, m, { projectId: ai, userId: 7, text: "Make Mala braver in scenes 1-2", language: "en" });
  assert.equal(r.sortedAs, "agent");
  assert.equal(r.assistant.action.type, "agent");
  assert.equal(r.assistant.action.intent, "SCOPED_REWRITE");
  assert.equal(r.assistant.action.big, false);
  assert.equal(r.assistant.action.targets.length, 2);
  assert.deepEqual(r.assistant.action.targets.map((x) => x.key), ["b0s0", "b0s1"]);
  assert.match(r.assistant.content, /I understood: Make Mala braver/);
  assert.match(r.assistant.content, /Nothing changes until you press a button/);
  assert.deepEqual(calls.map((c) => c.kind), ["classify"]);
  const after = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [ai])).rows[0].backfill;
  assert.deepEqual(after, before, "the screenplay is exactly as it was");
});

test("a big change is marked big and only promised after confirmation; an unclear instruction asks, with the choices; the words overrule a careless model", async () => {
  const bigOne = await handleAduMessage(db, models({ classify: { intent: "ALTERNATIVE", summary: "Try an ending where the villain survives.", targets: [{ type: "ending" }] } }), { projectId: ai, userId: 7, text: "Try an ending where the villain survives.", language: "en" });
  assert.equal(bigOne.assistant.action.big, true);
  assert.match(bigOne.assistant.content, /only start it after you confirm/);
  const careless = await handleAduMessage(db, models({ classify: { intent: "LOCAL_EDIT", summary: "x", targets: [] } }), { projectId: ai, userId: 7, text: "Keep the opening and the hero, change the villain and create a second draft", language: "hi" });
  assert.equal(careless.assistant.action.intent, "NEW_DRAFT"); // the Agent's safety net: "second draft" outranks "just edit"
  assert.equal(careless.assistant.action.big, true);
  assert.match(careless.assistant.content, /पक्का करने के बाद/);
  const unclear = await handleAduMessage(db, models({ classify: { intent: "UNCLEAR", summary: "Cannot tell.", targets: [] } }), { projectId: ai, userId: 7, text: "Fix it", language: "en" });
  assert.equal(unclear.assistant.action.needsClarification, true);
  assert.ok(unclear.assistant.action.options.length >= 4); // edit / new draft / alternative / new story
  assert.match(unclear.assistant.content, /not sure what you want/);
});

test("'write the whole screenplay' and 'make a beat longer' become proposals (no AI call at all); a missing beat number is asked for", async () => {
  const m = models();
  const w = await handleAduMessage(db, m, { projectId: ai, userId: 7, text: "Write the whole screenplay with dialogue", language: "en" });
  assert.deepEqual(w.assistant.action, { type: "write_all", dialogue: true });
  assert.match(w.assistant.content, /every beat that is not finished yet, with the dialogue of every scene/);
  const w2 = await handleAduMessage(db, m, { projectId: ai, userId: 7, text: "write all remaining scenes without dialogue", language: "or" });
  assert.deepEqual(w2.assistant.action, { type: "write_all", dialogue: false });
  const e = await handleAduMessage(db, m, { projectId: ai, userId: 7, text: "Make beat 2 longer, 6 minutes", language: "en" });
  assert.deepEqual(e.assistant.action, { type: "extend_beat", beatIndex: 1, minutes: 6, needsClarification: false });
  const e2 = await handleAduMessage(db, m, { projectId: ai, userId: 7, text: "make this beat longer, 6 minutes please", language: "en" });
  assert.equal(e2.assistant.action.needsClarification, true);
  assert.match(e2.assistant.content, /Which beat/);
  assert.equal(calls.length, 0, "none of this needs the AI to sort or answer");
});

test("the conversation is remembered per person and per project, can be cleared, and a failed answer saves nothing", async () => {
  const m = models();
  await handleAduMessage(db, m, { projectId: ai, userId: 7, text: "Hi", language: "en" });
  await handleAduMessage(db, m, { projectId: ai, userId: 8, text: "Hello there", language: "en" });
  const mine = await loadHistory(db, ai, 7);
  assert.deepEqual(mine.map((x) => x.role), ["user", "assistant"]);
  assert.equal(mine[0].content, "Hi");
  assert.equal((await loadHistory(db, ai, 8))[0].content, "Hello there"); // another person's conversation is their own
  const failing = models({ json: async () => { throw Object.assign(new Error("quota"), { status: 429 }); } });
  await assert.rejects(() => handleAduMessage(db, failing, { projectId: ai, userId: 7, text: "How are you?", language: "en" }), /could not answer just now/);
  assert.equal((await loadHistory(db, ai, 7)).length, 2, "nothing half-said was saved");
  const money = models({ json: async () => { throw Object.assign(new Error("The money limit for this project has been reached."), { status: 402 }); } });
  await assert.rejects(() => handleAduMessage(db, money, { projectId: ai, userId: 7, text: "How are you?", language: "en" }), /money limit/);
  await clearHistory(db, ai, 7);
  assert.equal((await loadHistory(db, ai, 7)).length, 0);
  assert.equal((await loadHistory(db, ai, 8)).length, 2);
});

test("plain refusals: empty, too long, unknown project", async () => {
  await assert.rejects(() => handleAduMessage(db, models(), { projectId: ai, userId: 7, text: "  " }), /Write or say something/);
  await assert.rejects(() => handleAduMessage(db, models(), { projectId: ai, userId: 7, text: "x".repeat(4001) }), /too long/);
  await assert.rejects(() => handleAduMessage(db, models(), { projectId: 99999999, userId: 7, text: "Hi" }), /Project not found/);
  assert.match(answerPrompt({ project: { title: "T", pasted_text: "i", backfill: {} }, history: [], text: "Hi", language: "xx", context: {} }), /Reply in English/); // an unknown language falls back to English
});

test("the web routes: history, message and clear", async () => {
  const app = express();
  app.use(express.json());
  registerAduChatRoutes(app, db, () => (req, res, next) => ((req.user = { id: 7 }), next()), { models: models({ answer: { reply: "Hello! I am Adu." } }) });
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/ai-movie/assistant/${ai}`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: J(body) }).then(async (r) => [r.status, await r.json()]);
  const [s1, a] = await post("/message", { text: "Hi", language: "hi", context: { beatIndex: 0 } });
  assert.equal(s1, 200);
  assert.equal(a.assistant.content, "Hello! I am Adu.");
  assert.equal((await post("/message", { text: "" }))[0], 400);
  const history = await (await fetch(`${base}/history`)).json();
  assert.equal(history.messages.length, 2);
  assert.equal((await (await fetch(`${base}/history`, { method: "DELETE" })).json()).ok, true);
  assert.equal((await (await fetch(`${base}/history`)).json()).messages.length, 0);
  assert.equal((await post("/message", { text: "Hi" }).then(() => fetch(`http://localhost:${server.address().port}/api/ai-movie/assistant/abc/history`))).status, 400);
});

test("when the classifier's model cannot be asked, Adu says the person's own words instead of 'Interpreted as …'", async () => {
  const m = models({ json: async (kind) => { if (kind === "classify") throw new Error("model down"); } });
  const r = await handleAduMessage(db, m, { projectId: ai, userId: 7, text: "Rewrite scenes 1-1 so the hero is braver", language: "en", context: { stage: "screenplay" } });
  assert.equal(r.assistant.action.intent, "SCOPED_REWRITE"); // from the words alone
  assert.match(r.assistant.content, /I understood: “Rewrite scenes 1-1 so the hero is braver”/);
  assert.ok(!/Interpreted as/.test(r.assistant.content));
});
