import test from "node:test";
import assert from "node:assert/strict";
import { tokenCostUsd, priceFor, installGeminiMetering, mirrorSpend, withUsageContext, estimateEarlierStoryWork, recordBrainCall } from "../usageLedger.js";

// a stand-in database that just remembers what was written
function fakeDb() {
  const rows = [];
  return { rows, query: async (sql, params) => { if (/INSERT INTO ai_usage_ledger/.test(sql)) rows.push(params); return { rows: [] }; } };
}

test("token prices turn into dollars", () => {
  assert.equal(priceFor("gemini-2.5-flash-lite").tier, "flash-lite");
  assert.equal(priceFor("gemini-2.5-flash").tier, "flash");
  assert.equal(priceFor("gemini-3.1-pro-preview").tier, "pro");
  assert.equal(priceFor("something-new").known, false);
  // 1M input + 1M output on Flash = 0.30 + 2.50
  assert.ok(Math.abs(tokenCostUsd("gemini-2.5-flash", 1e6, 1e6) - 2.8) < 1e-9);
});

test("every Gemini text call is written with its tokens, its cost and who asked", async () => {
  const db = fakeDb();
  const ai = { models: { generateContent: async () => ({ text: "ok", usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 300 } }) } };
  installGeminiMetering(ai, db);
  const req = { method: "POST", originalUrl: "/api/ai-movie/projects/7/screenplay", body: {}, query: {} };
  const response = await withUsageContext({ user: { id: 5, name: "Asha" }, req }, () => ai.models.generateContent({ model: "gemini-2.5-flash", contents: "hi" }));
  assert.equal(response.text, "ok"); // the answer is passed through untouched
  assert.equal(db.rows.length, 1);
  const [userId, userName, projectType, projectId, kind, , model, , promptTokens, outputTokens, cost, via] = db.rows[0];
  assert.deepEqual([userId, userName, projectType, projectId, kind, model, promptTokens, outputTokens, via], [5, "Asha", "ai_movie", 7, "text", "gemini-2.5-flash", 1000, 500, "metered"]);
  assert.ok(Math.abs(cost - (1000 * 0.3 + 500 * 2.5) / 1e6) < 1e-9);
});

test("a failing money-meter write never breaks the AI call", async () => {
  const db = { query: async () => { throw new Error("db down"); } };
  const ai = { models: { generateContent: async () => ({ text: "fine", usageMetadata: {} }) } };
  installGeminiMetering(ai, db);
  assert.equal((await ai.models.generateContent({ model: "gemini-2.5-flash" })).text, "fine");
});

test("project money-log entries are copied once: pictures yes, text never (text is measured by tokens)", async () => {
  const db = fakeDb();
  await mirrorSpend(db, 3, { kind: "image", provider: "Gemini image", costUsd: 0.04 });
  await mirrorSpend(db, 3, { kind: "text", provider: "Gemini 2.5 Flash (voice writer)", costUsd: 0.01 });
  await mirrorSpend(db, 3, { kind: "text", provider: "Gemini 3.1 Pro", costUsd: 0.2 });
  assert.deepEqual(db.rows.map((r) => [r[2], r[3], r[4], r[11]]), [["ai_movie", 3, "image", "spend-log"]]);
});

test("a Pro Story Brain answer is written with its real tokens, the user and the project", async () => {
  const db = fakeDb();
  const ai = { models: { generateContent: async () => ({}) } };
  installGeminiMetering(ai, db); // gives the meter its database
  const req = { method: "POST", originalUrl: "/api/concepts/9/pitch-deck", body: {}, query: {} };
  await withUsageContext({ user: { id: 2, name: "Ravi" }, req }, () => recordBrainCall({ model: "gemini-3.1-pro-preview", usage: { promptTokenCount: 10000, candidatesTokenCount: 2000, thoughtsTokenCount: 3000 }, label: "Story Brain" }));
  const [userId, , projectType, projectId, , , model, , promptTokens, outputTokens, cost] = db.rows[0];
  assert.deepEqual([userId, projectType, projectId, model, promptTokens, outputTokens], [2, "story", 9, "gemini-3.1-pro-preview", 10000, 5000]);
  assert.ok(Math.abs(cost - (10000 * 2 + 5000 * 12) / 1e6) < 1e-9);
});

test("earlier Movie work is estimated from what is saved: a bigger saved script costs more, a Pro judge is added, nothing is zero", async () => {
  const rows = [
    { concept_id: 4, stage: "screenplay", n: 100, len: 300000, asc_len: 30000 },
    { concept_id: 4, stage: "pitch", n: 2, len: 8000, asc_len: 8000 },
    { concept_id: 5, stage: "pitch", n: 1, len: 4000, asc_len: 4000 },
  ];
  const db = { query: async (sql) => ({ rows: /FROM auto_pipeline_runs/.test(sql) ? [{ concept_id: 4, u: { calls: 3, promptTokens: 100000, outputTokens: 20000, thinkingTokens: 30000 } }] : rows }) };
  const est = await estimateEarlierStoryWork(db, new Date());
  const big = est.get(4), small = est.get(5);
  assert.ok(big.usd > small.usd && small.usd > 0);
  assert.ok(big.stages.some((s) => s.stage === "pitch-judge" && /Pro/.test(s.label)));
  const brain = big.stages.find((s) => s.stage === "storyBrain");
  assert.ok(Math.abs(brain.usd - (100000 * 2 + 50000 * 12) / 1e6) < 1e-6); // real counts, real Pro price
  assert.ok(big.proUsd > 0);
  assert.equal((await estimateEarlierStoryWork(db, null)).size, 0); // nothing to estimate before there is a start date
});
