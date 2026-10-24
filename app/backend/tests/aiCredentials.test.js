import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import { cleanLocation, createAiCredentials, safeDetails, decryptJson, describeAiError, encryptJson, ensureAiCredentialsSchema, lockSecret, parseServiceAccount } from "../aiCredentials.js";
import { registerAiSettingsRoutes } from "../aiSettingsRoutes.js";

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const key = (project, extra = {}) => ({ type: "service_account", project_id: project, private_key_id: `kid-${project}`, client_email: `svc@${project}.iam.gserviceaccount.com`, private_key: privateKey, ...extra });

test("the saved key is locked: it opens with the right secret only, and any change to it is noticed", () => {
  const blob = encryptJson(key("p1"), "a long server secret");
  assert.ok(!blob.includes("BEGIN"));
  assert.equal(decryptJson(blob, "a long server secret").project_id, "p1");
  assert.equal(decryptJson(blob, "another secret"), null);
  const parts = blob.split(".");
  parts[3] = Buffer.from("tampered").toString("base64");
  assert.equal(decryptJson(parts.join("."), "a long server secret"), null);
  assert.equal(decryptJson("garbage", "x"), null);
});

test("lock strength: a real server secret is 'strong', otherwise 'basic'", () => {
  assert.equal(lockSecret({ SETTINGS_ENCRYPTION_KEY: "x".repeat(20) }).strength, "strong");
  assert.equal(lockSecret({ SETTINGS_ENCRYPTION_KEY: "short", DATABASE_URL: "postgres://a" }).strength, "basic");
});

test("what is pasted is checked with plain messages", () => {
  assert.equal(parseServiceAccount(JSON.stringify(key("p1"))).ok, true);
  assert.match(parseServiceAccount("not json").error, /does not look like the key file/);
  assert.match(parseServiceAccount(JSON.stringify({ type: "authorized_user" })).error, /authorized_user/);
  assert.match(parseServiceAccount(JSON.stringify(key("p1", { client_email: "" }))).error, /client_email/);
  assert.match(parseServiceAccount(JSON.stringify(key("p1", { private_key: "oops" }))).error, /private_key/);
  assert.equal(cleanLocation("europe-west4"), "europe-west4");
  assert.equal(cleanLocation("drop table"), "us-central1");
});

test("a good key is not refused for how it was copied (phone, chat, editors): every common mangling is put right", () => {
  const good = key("p1");
  const pretty = JSON.stringify(good, null, 2);
  const mangled = {
    "plain file": pretty,
    "byte-order mark": "\uFEFF" + pretty,
    "curly quotes": pretty.replace(/"/g, (m, i) => (i % 2 ? "”" : "“")),
    "real line breaks inside the private key": pretty.replace(/\\n/g, "\n"),
    "line breaks written twice": pretty.replace(/\\n/g, "\\\\n"),
    "wrapped in quotes": JSON.stringify(pretty),
    "text around it": `Here is the key:\n${pretty}\nthanks!`,
    "no type field": JSON.stringify({ ...good, type: undefined }),
    "spaces and no-break spaces at the ends": `\u00A0 ${pretty} \u00A0`,
  };
  for (const [name, text] of Object.entries(mangled)) {
    const r = parseServiceAccount(text);
    assert.equal(r.ok, true, `${name}: ${r.error}`);
    assert.equal(r.serviceAccount.private_key, good.private_key, `${name}: the private key must come out exactly as it was`);
    assert.doesNotThrow(() => crypto.createPrivateKey(r.serviceAccount.private_key), `${name}: the private key must be usable for signing`);
  }
});

test("when a key really cannot be used, the message says exactly why", () => {
  assert.match(parseServiceAccount("   ").error, /Nothing was pasted/);
  assert.match(parseServiceAccount("AIzaSyA1234567890abcdefghijklmnopqrstuvw").error, /API key/);
  assert.match(parseServiceAccount("just some words").error, /does not look like the key file/);
  assert.match(parseServiceAccount(JSON.stringify(key("p1"), null, 2).slice(0, 400)).error, /cut off/);
  assert.match(parseServiceAccount(JSON.stringify({ type: "authorized_user", project_id: "x" })).error, /authorized_user/);
  assert.match(parseServiceAccount(JSON.stringify(key("p1", { private_key: "-----BEGIN PRIVATE KEY-----\nabc" }))).error, /incomplete or changed/);
});

test("the technical details never carry the key; a failed step is named in the message", () => {
  const leaky = new Error(`bad ${"A".repeat(200)} and -----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----`);
  const shown = safeDetails(leaky);
  assert.ok(!shown.includes("AAAAAAAAAA") && !shown.includes("MIIE"));
  assert.match(describeAiError(new Error("something odd"), "signin"), /did not accept this key at sign-in/);
  assert.match(describeAiError(new Error("something odd"), "vertex"), /Google refused the test call/);
});

test("Google's raw errors become a sentence that says what to do", () => {
  const billing = describeAiError(new Error('got status: 403 Forbidden. {"error":{"code":403,"message":"There are issues with your billing account, please resolve / pay your outstanding balance for project: projects/1075011609674","status":"PERMISSION_DENIED"}}'));
  assert.match(billing, /billing/i); assert.match(billing, /1075011609674/); assert.match(billing, /Billing/);
  // the exact words Google used when an unpaid balance stopped the project (it said PERMISSION_DENIED too — but this is billing, not a role)
  const dunning = describeAiError(new Error('got status: 403 Forbidden. {"error":{"code":403,"message":"Lightning dunning decision is deny for project: projects/1075011609674","status":"PERMISSION_DENIED"}}'));
  assert.match(dunning, /billing account/); assert.match(dunning, /unpaid balance/); assert.doesNotMatch(dunning, /Vertex AI User/);
  assert.match(describeAiError(new Error("Vertex AI API has not been used in project 123 before or it is disabled")), /switched off/);
  assert.match(describeAiError(new Error("403 PERMISSION_DENIED: Permission 'aiplatform.endpoints.predict' denied")), /Vertex AI User/);
  assert.match(describeAiError(new Error("invalid_grant: Invalid JWT Signature")), /new JSON key/);
  assert.match(describeAiError(new Error("fetch failed ETIMEDOUT")), /could not reach Google/);
});

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let up = true;
try { await db.query("SELECT 1"); } catch { up = false; }

test("the key saved in Settings wins over the server's, survives a restart, and removing it goes back", { skip: !up }, async () => {
  await ensureAiCredentialsSchema(db);
  await db.query("DELETE FROM ai_credentials");
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(key("server-project")), SETTINGS_ENCRYPTION_KEY: "x".repeat(24), GOOGLE_CLOUD_LOCATION: "us-central1" };
  try {
    const a = createAiCredentials({ env }); a.attach(db);
    await a.load();
    assert.equal(a.current().source, "server");
    assert.equal(a.current().serviceAccount.project_id, "server-project");
    const changes = []; a.onChange((s) => changes.push(s.source));
    await a.save({ serviceAccount: key("saved-project"), location: "europe-west4", userName: "Admin Asha" });
    assert.equal(a.current().source, "saved");
    assert.equal(a.current().serviceAccount.project_id, "saved-project");
    assert.equal(a.current().location, "europe-west4");
    assert.deepEqual(changes, ["saved"]);

    // the database holds it locked, never in the clear
    const raw = (await db.query("SELECT locked, saved_by FROM ai_credentials")).rows[0];
    assert.ok(!raw.locked.includes("BEGIN") && !raw.locked.includes("saved-project"));
    assert.equal(raw.saved_by, "Admin Asha");

    // "restart": a fresh holder reads the same key; a holder with another lock secret reports a problem instead of using another key
    const b = createAiCredentials({ env }); b.attach(db); await b.load();
    assert.equal(b.current().serviceAccount.project_id, "saved-project");
    const c = createAiCredentials({ env: { ...env, SETTINGS_ENCRYPTION_KEY: "y".repeat(24) } }); c.attach(db); await c.load();
    assert.equal(c.current().source, "saved-unreadable");
    assert.equal(c.current().serviceAccount, null);
    assert.match(c.current().problem, /can no longer be read/);

    // a change made elsewhere is picked up by the next look
    await db.query("DELETE FROM ai_credentials");
    await a.load();
    assert.equal(a.current().source, "server");
    await a.save({ serviceAccount: key("again"), location: "us-central1", userName: "x" });
    await a.clear();
    assert.equal(a.current().serviceAccount.project_id, "server-project");
  } finally { await db.query("DELETE FROM ai_credentials"); }
});

test("Settings routes: test first, a failing key is not saved (unless insisted on), the key is never sent back", { skip: !up }, async () => {
  await ensureAiCredentialsSchema(db);
  await db.query("DELETE FROM ai_credentials");
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(key("server-project")), SETTINGS_ENCRYPTION_KEY: "x".repeat(24) };
  const creds = createAiCredentials({ env }); creds.attach(db); await creds.load();
  let failWith = null; let proWarning = null; const tested = [];
  const app = express(); app.use(express.json());
  registerAiSettingsRoutes(app, db, {
    requireRole: () => (req, res, next) => { req.user = { id: 1, name: "Admin Asha" }; next(); },
    aiCredentials: creds,
    testCandidate: async (sa, location, report) => { tested.push([sa.project_id, location]); report?.("signin", "ok"); if (failWith) { const e = new Error(failWith); e.step = "vertex"; throw e; } report?.("vertex", "answered"); if (proWarning) report?.("pro", proWarning, { warn: true }); else report?.("pro", "answered"); return { model: "m" }; },
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, text: await r.text() }; };
  try {
    const first = await call("GET", "/api/settings/ai");
    assert.equal(JSON.parse(first.text).source, "server");
    assert.equal(JSON.parse(first.text).activeProject, "server-project");

    assert.equal((await call("POST", "/api/settings/ai/test", { key: "nonsense" })).status, 400);
    const ok = JSON.parse((await call("POST", "/api/settings/ai/test", { key: JSON.stringify(key("new-project")), location: "us-central1" })).text);
    assert.equal(ok.ok, true); assert.equal(ok.projectId, "new-project");
    assert.deepEqual(ok.steps.map((s) => [s.key, s.ok]), [["format", true], ["signin", true], ["vertex", true], ["pro", true]]);
    proWarning = "The Pro model is not available in this project.";
    const warned = JSON.parse((await call("POST", "/api/settings/ai/test", { key: JSON.stringify(key("new-project")) })).text);
    assert.equal(warned.ok, true); // a warning never blocks
    assert.deepEqual(warned.warnings, ["The Pro model is not available in this project."]);
    proWarning = null;
    assert.equal((await call("GET", "/api/settings/ai")).text.includes("new-project"), false); // testing saves nothing

    failWith = "403 There are issues with your billing account, please pay your outstanding balance for project: projects/42";
    const bad = await call("PUT", "/api/settings/ai", { key: JSON.stringify(key("broke-project")) });
    assert.equal(bad.status, 422);
    const badTest = JSON.parse(bad.text).test;
    assert.equal(badTest.step, "vertex"); assert.deepEqual(badTest.steps.map((s) => [s.key, s.ok]), [["format", true], ["signin", true], ["vertex", false]]); assert.match(badTest.details, /billing account/);
    assert.match(JSON.parse(bad.text).error, /billing account of this project/);
    assert.equal(JSON.parse((await call("GET", "/api/settings/ai")).text).source, "server"); // nothing replaced

    const forced = await call("PUT", "/api/settings/ai", { key: JSON.stringify(key("broke-project")), saveAnyway: true });
    assert.equal(forced.status, 200);
    assert.equal(JSON.parse(forced.text).activeProject, "broke-project");

    failWith = null;
    const saved = await call("PUT", "/api/settings/ai", { key: JSON.stringify(key("good-project")), location: "europe-west4" });
    const s = JSON.parse(saved.text);
    assert.equal(s.source, "saved"); assert.equal(s.activeProject, "good-project"); assert.equal(s.location, "europe-west4"); assert.equal(s.saved.savedBy, "Admin Asha");
    assert.ok(!saved.text.includes("BEGIN") && !saved.text.includes("private_key"), "the key must never be sent back");
    assert.deepEqual(tested.at(-1), ["good-project", "europe-west4"]);

    const removed = JSON.parse((await call("DELETE", "/api/settings/ai")).text);
    assert.equal(removed.source, "server");
    assert.equal(removed.saved, null);
  } finally { server.close(); await db.query("DELETE FROM ai_credentials"); await db.end(); }
});
