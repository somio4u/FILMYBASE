import test from "node:test";
import assert from "node:assert/strict";
import { isQuotaError, fallbackModelsFor, jitter } from "../overloadFallback.js";

test("the 429 messages Google and the SDK send are recognised", () => {
  assert.ok(isQuotaError('got status: 429 Too Many Requests. {"error":{"code":429,"message":"Resource exhausted.","status":"RESOURCE_EXHAUSTED"}}'));
  assert.ok(isQuotaError("RESOURCE_EXHAUSTED"));
  assert.ok(!isQuotaError("got status: 400 Bad Request"));
  assert.ok(!isQuotaError(undefined));
});

test("a model that is out of room falls to another current model — never itself, never a retired one", () => {
  assert.deepEqual(fallbackModelsFor("gemini-3.1-pro-preview"), ["gemini-3.5-flash", "gemini-3.5-flash-lite"]);
  assert.deepEqual(fallbackModelsFor("gemini-3.5-flash"), ["gemini-3.5-flash-lite", "gemini-3.1-pro-preview"]);
  assert.deepEqual(fallbackModelsFor("gemini-3.5-flash-lite"), ["gemini-3.5-flash", "gemini-3.1-pro-preview"]);
  for (const m of ["gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3.5-flash-lite"]) assert.ok(!fallbackModelsFor(m).some((x) => /2\.5/.test(x)));
  process.env.MODEL_429_FALLBACK = "off";
  assert.deepEqual(fallbackModelsFor("gemini-3.5-flash"), []);
  delete process.env.MODEL_429_FALLBACK;
});

test("the wait is spread by about 20% either way", () => {
  assert.equal(jitter(1000, () => 0), 800);
  assert.equal(jitter(1000, () => 1), 1200);
});
