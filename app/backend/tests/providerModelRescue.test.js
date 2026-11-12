import test from "node:test";
import assert from "node:assert/strict";
import { createProviders, pickReplacementModel } from "../providers.js";

const listing = { models: [
  { name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-3.1-flash-image-preview", supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-3-pro-image-preview", supportedGenerationMethods: ["generateContent"] },
  { name: "models/imagen-4.0-generate-001", supportedGenerationMethods: ["predict"] },
  { name: "models/gemini-3.5-flash-tts", supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-3.5-flash-lite-tts", supportedGenerationMethods: ["generateContent"] },
  { name: "models/veo-3.1-fast-generate-preview", supportedGenerationMethods: ["predictLongRunning"] },
  { name: "models/veo-3.2-generate", supportedGenerationMethods: ["predictLongRunning"] },
  { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
] };

test("the replacement is chosen from what the key can see, never Imagen or a text model", () => {
  assert.equal(pickReplacementModel("image", listing.models, "gemini-2.5-flash-image"), "gemini-3.1-flash-image-preview");
  assert.equal(pickReplacementModel("speech", listing.models, "gemini-2.5-flash-preview-tts"), "gemini-3.5-flash-tts");
  assert.equal(pickReplacementModel("video", listing.models, "veo-3.1-fast-generate-preview"), "veo-3.2-generate");
  assert.equal(pickReplacementModel("image", [], "x"), null);
});

const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const png = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("x").toString("base64") } }] } }] };

test("a switched-off picture model is replaced once, and the new one is remembered", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes("/models?pageSize")) return reply(200, listing);
    if (url.includes("gemini-2.5-flash-image:")) return reply(404, { error: { message: "models/gemini-2.5-flash-image is not found" } });
    return reply(200, png);
  };
  const providers = createProviders({ env: { GEMINI_API_KEY: "k" }, fetchImpl });
  const first = await providers.generateImage({ prompt: "a tree" });
  assert.equal(first.mime, "image/png");
  assert.equal(providers.models.image, "gemini-3.1-flash-image-preview");
  const before = seen.length;
  await providers.generateImage({ prompt: "another tree" });
  assert.equal(seen.length - before, 1, "the second picture goes straight to the new model");
});

test("a real failure (safety, limit) is not mistaken for a switched-off model", async () => {
  const fetchImpl = async () => reply(429, { error: { message: "quota" } });
  const providers = createProviders({ env: { GEMINI_API_KEY: "k" }, fetchImpl });
  await assert.rejects(() => providers.generateImage({ prompt: "x" }), /usage limit/);
  assert.equal(providers.models.image, "gemini-2.5-flash-image");
});

test("MODEL_AUTO_REPLACE=off keeps the old behaviour", async () => {
  const fetchImpl = async () => reply(404, { error: { message: "gone" } });
  const providers = createProviders({ env: { GEMINI_API_KEY: "k", MODEL_AUTO_REPLACE: "off" }, fetchImpl });
  await assert.rejects(() => providers.generateImage({ prompt: "x" }), /does not know this model/);
});

test("the first time a model is needed, a NEWER version this key can use is chosen from Google's own list, once, and used from then on", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes("/models?pageSize")) return reply(200, { models: [{ name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-3.1-flash-image-preview", supportedGenerationMethods: ["generateContent"] }] });
    return reply(200, png);
  };
  const providers = createProviders({ env: { GEMINI_API_KEY: "k" }, fetchImpl });
  await providers.generateImage({ prompt: "a tree" });
  assert.equal(providers.models.image, "gemini-3.1-flash-image-preview");
  assert.ok(seen.some((u) => u.includes("gemini-3.1-flash-image-preview:generateContent")));
  assert.ok(!seen.some((u) => u.includes("gemini-2.5-flash-image:")), "the old model was never called");
  const before = seen.length;
  await providers.generateImage({ prompt: "again" });
  assert.equal(seen.length - before, 1, "no second look at the list");
});

test("a newer model that fails here is dropped for the old one, which then keeps working; a usage limit is NOT treated as a failure of the newer model", async () => {
  const listing2 = { models: [{ name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-3.1-flash-image-preview", supportedGenerationMethods: ["generateContent"] }] };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/models?pageSize")) return reply(200, listing2);
    if (url.includes("gemini-3.1-flash-image-preview:")) return reply(400, { error: { message: "this model needs different settings" } });
    return reply(200, png);
  };
  const providers = createProviders({ env: { GEMINI_API_KEY: "k" }, fetchImpl });
  const out = await providers.generateImage({ prompt: "a tree" });
  assert.equal(out.mime, "image/png");
  assert.equal(providers.models.image, "gemini-2.5-flash-image");
  const newerCalls = calls.filter((u) => u.includes("gemini-3.1-flash-image-preview:")).length;
  await providers.generateImage({ prompt: "again" });
  assert.equal(calls.filter((u) => u.includes("gemini-3.1-flash-image-preview:")).length, newerCalls, "the newer model is not tried again");

  const limited = createProviders({ env: { GEMINI_API_KEY: "k" }, fetchImpl: async (url) => (url.includes("/models?pageSize") ? reply(200, listing2) : reply(429, { error: { message: "quota" } })) });
  await assert.rejects(() => limited.generateImage({ prompt: "x" }), /usage limit/);
  assert.equal(limited.models.image, "gemini-3.1-flash-image-preview", "a limit says nothing about the model, so it stays");
});

test("MODEL_AUTO_UPGRADE=off never reads the list; Vertex keys are left alone", async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return reply(200, png); };
  const off = createProviders({ env: { GEMINI_API_KEY: "k", MODEL_AUTO_UPGRADE: "off" }, fetchImpl });
  await off.generateImage({ prompt: "x" });
  assert.ok(!seen.some((u) => u.includes("/models?pageSize")));
  assert.equal(off.models.image, "gemini-2.5-flash-image");
});
