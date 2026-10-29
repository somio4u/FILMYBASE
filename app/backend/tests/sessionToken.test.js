import test from "node:test";
import assert from "node:assert/strict";
import { sessionTokenOf } from "../sessionToken.js";
import { matchWriterRoute } from "../writerAccess.js";

const TOKEN = "ab".repeat(32);
const req = (cookies, authorization) => ({ cookies, get: (name) => (name.toLowerCase() === "authorization" ? authorization : undefined) });

test("the login cookie is used first; without it a Bearer header carrying a real session token is accepted", () => {
  assert.equal(sessionTokenOf(req({ session_token: "cookie-token" }, `Bearer ${TOKEN}`), "session_token"), "cookie-token");
  assert.equal(sessionTokenOf(req({}, `Bearer ${TOKEN}`), "session_token"), TOKEN);
  assert.equal(sessionTokenOf(req(undefined, `Bearer ${TOKEN.toUpperCase()}`), "session_token"), TOKEN.toUpperCase());
  assert.equal(sessionTokenOf({ headers: { authorization: `Bearer ${TOKEN}` } }, "session_token"), TOKEN);
});

test("anything that is not exactly a session token is ignored", () => {
  for (const bad of [undefined, "", "Bearer", "Bearer abc", `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, `Bearer ${"zz".repeat(32)}`, `Bearer  ${TOKEN}`]) {
    assert.equal(sessionTokenOf(req({}, bad), "session_token"), null, String(bad));
  }
});

test("the writers may use \"Upload PDF instead\" (start the reading, then ask how it went)", () => {
  assert.ok(matchWriterRoute("POST", "/api/story-from-pdf"));
  assert.ok(matchWriterRoute("GET", "/api/story-from-pdf/9e4a6f9a-c1a4-4639-9210-54fe3aebcb39"));
  assert.equal(matchWriterRoute("DELETE", "/api/story-from-pdf/abc"), null);
  assert.equal(matchWriterRoute("POST", "/api/ai-movie/import-screenplay-file"), null); // the AI Movie import stays admin's
});
