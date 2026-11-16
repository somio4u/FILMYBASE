import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { securityHeaders } from "../securityHeaders.js";

async function headersOf(production) {
  const app = express();
  app.use(securityHeaders({ production }));
  app.get("/x", (req, res) => res.json({ ok: true }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/x`);
    return res.headers;
  } finally { server.close(); }
}

test("every answer says nosniff and a safe referrer policy; the server does not announce itself", async () => {
  const h = await headersOf(false);
  assert.equal(h.get("x-content-type-options"), "nosniff");
  assert.equal(h.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(h.get("x-powered-by"), null);
  assert.equal(h.get("strict-transport-security"), null, "HSTS only in production");
});

test("in production the browser is also told to use HTTPS only", async () => {
  const h = await headersOf(true);
  assert.match(h.get("strict-transport-security"), /max-age=\d+/);
  assert.equal(h.get("x-content-type-options"), "nosniff");
});
