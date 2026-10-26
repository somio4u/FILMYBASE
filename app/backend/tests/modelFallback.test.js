import test from "node:test";
import assert from "node:assert/strict";
import { withModelFallback, isModelRetiredError } from "../modelFallback.js";

const retired = (m) => new Error(`got status: 404 Not Found. This model models/${m} is no longer available to new users.`);
const fakeClient = (alive) => { const calls = []; return { calls, models: { generateContent: async (p) => { calls.push(p.model); if (!alive.includes(p.model)) throw retired(p.model); return { text: "OK", model: p.model }; } } }; };

test("a switched-off model is retried once with its newer one, and remembered", async () => {
  const c = fakeClient(["gemini-3.5-flash-lite"]);
  const seen = [];
  withModelFallback(c, { onSwitch: (a, b) => seen.push([a, b]) });
  assert.equal((await c.models.generateContent({ model: "gemini-2.5-flash-lite", contents: "x" })).model, "gemini-3.5-flash-lite");
  await c.models.generateContent({ model: "gemini-2.5-flash-lite", contents: "x" });
  assert.deepEqual(c.calls, ["gemini-2.5-flash-lite", "gemini-3.5-flash-lite", "gemini-3.5-flash-lite"]); // second call goes straight to the new one
  assert.deepEqual(seen, [["gemini-2.5-flash-lite", "gemini-3.5-flash-lite"]]);
});

test("a model that still works is left alone; other errors are not swallowed", async () => {
  const c = fakeClient(["gemini-2.5-flash"]);
  withModelFallback(c);
  assert.equal((await c.models.generateContent({ model: "gemini-2.5-flash" })).model, "gemini-2.5-flash");
  const broken = { models: { generateContent: async () => { throw new Error("got status: 429 quota"); } } };
  withModelFallback(broken);
  await assert.rejects(() => broken.models.generateContent({ model: "gemini-2.5-flash" }), /429/);
  const unknown = fakeClient([]);
  withModelFallback(unknown);
  await assert.rejects(() => unknown.models.generateContent({ model: "some-other-model" }), /no longer available/); // no replacement known: error stays
  assert.equal(isModelRetiredError(new Error("429 quota")), false);
});
