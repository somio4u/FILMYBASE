import test from "node:test";
import assert from "node:assert/strict";
import { tokenCostUsd, priceFor, installGeminiMetering, mirrorSpend, withUsageContext } from "../usageLedger.js";

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

test("project money-log entries are copied once: pictures yes, token-measured text no", async () => {
  const db = fakeDb();
  await mirrorSpend(db, 3, { kind: "image", provider: "Gemini image", costUsd: 0.04 });
  await mirrorSpend(db, 3, { kind: "text", provider: "Gemini 2.5 Flash (voice writer)", costUsd: 0.01 }); // already measured by tokens
  await mirrorSpend(db, 3, { kind: "text", provider: "Gemini 3.1 Pro", costUsd: 0.2 }); // Story Brain: not seen by the token meter
  assert.deepEqual(db.rows.map((r) => [r[2], r[3], r[4], r[11]]), [["ai_movie", 3, "image", "spend-log"], ["ai_movie", 3, "text", "spend-log"]]);
});
