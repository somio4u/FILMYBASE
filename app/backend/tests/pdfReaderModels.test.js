import test from "node:test";
import assert from "node:assert/strict";
import { generateBrainJson, PDF_READER_MODELS, setRetryDelayForTests, useApiKeySource, useServiceAccountSource } from "../storyBrain.js";

const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] }, finishReason: "STOP" }], usageMetadata: {} }), { status: 200, headers: { "content-type": "application/json" } });
const fail = (status, message) => new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
const ask = (models) => generateBrainJson({ systemInstruction: "x", contents: "y", maxOutputTokens: 16, label: "test", models });

test("the PDF reader chain starts with the light Flash models, Pro models last", () => {
  assert.match(PDF_READER_MODELS[0].model, /flash/);
  assert.match(PDF_READER_MODELS.at(-1).model, /pro/);
});

test("a model that is switched off (404) is skipped and the next one answers", async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => { const m = /models\/([^:]+):/.exec(String(url))[1]; asked.push(m); return m === "gemini-3.5-flash" ? fail(404, "no longer available") : ok(); };
  try {
    useServiceAccountSource(() => null); useApiKeySource(() => "AIza-test");
    const result = await ask(PDF_READER_MODELS);
    assert.deepEqual(asked, ["gemini-3.5-flash", "gemini-2.5-flash"]);
    assert.equal(result.data.ok, true);
  } finally { globalThis.fetch = realFetch; }
});

test("when every model fails, the message lists the reason of EACH model, not only the last", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => fail(String(url).includes("3.1-pro") ? 403 : 404, String(url).includes("3.1-pro") ? "no access to this model" : "no longer available to new users");
  try {
    useServiceAccountSource(() => null); useApiKeySource(() => "AIza-test");
    await assert.rejects(() => ask([{ model: "gemini-3.1-pro-preview", location: "global" }, { model: "gemini-2.5-pro", location: "us-central1" }]), (error) => {
      assert.match(error.message, /gemini-3\.1-pro-preview: 403 no access/);
      assert.match(error.message, /gemini-2\.5-pro: 404 no longer available/);
      return true;
    });
  } finally { globalThis.fetch = realFetch; }
});

test("a busy model (429) is retried and its last reason is kept too", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return fail(429, "quota"); };
  setRetryDelayForTests(1);
  try {
    useServiceAccountSource(() => null); useApiKeySource(() => "AIza-test");
    await assert.rejects(() => ask([{ model: "gemini-3.5-flash", location: "global" }]), /429 quota/);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = realFetch; setRetryDelayForTests(3000); }
});
