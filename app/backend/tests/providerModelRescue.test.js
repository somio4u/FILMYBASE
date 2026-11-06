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
