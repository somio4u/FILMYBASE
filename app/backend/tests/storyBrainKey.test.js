import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { generateBrainJson, useAccessTokenSource, useServiceAccountSource } from "../storyBrain.js";

// The Pro "Story Brain" model must follow the key chosen in Settings at the moment of each call.
// A fake Google endpoint records which project each call went to (no real Google call is made).
test("Story Brain sends each call to the project of the key in use right now", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const sa = (project) => ({ type: "service_account", project_id: project, private_key_id: `kid-${project}`, client_email: `svc@${project}.iam.gserviceaccount.com`, private_key: privateKey });
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] }, finishReason: "STOP" }], usageMetadata: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const tokensFor = [];
  useAccessTokenSource(async (account) => { tokensFor.push(account.project_id); return "fake-token"; });
  try {
    useServiceAccountSource(() => sa("project-one"));
    await generateBrainJson({ systemInstruction: "x", contents: "y", responseSchema: { type: "OBJECT", properties: { ok: { type: "BOOLEAN" } } }, maxOutputTokens: 16, label: "test" });
    useServiceAccountSource(() => sa("project-two"));
    await generateBrainJson({ systemInstruction: "x", contents: "y", responseSchema: { type: "OBJECT", properties: { ok: { type: "BOOLEAN" } } }, maxOutputTokens: 16, label: "test" });
    assert.ok(urls[0].includes("/projects/project-one/"), urls[0]);
    assert.ok(urls[1].includes("/projects/project-two/"), urls[1]);
    assert.deepEqual(tokensFor, ["project-one", "project-two"]); // and each call signed in with its own key
  } finally { globalThis.fetch = realFetch; useServiceAccountSource(() => null); useAccessTokenSource(null); }
});
