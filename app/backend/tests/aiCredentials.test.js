import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import { summariseModels, cleanLocation, createAiCredentials, providerEnv, detectKind, parseApiKey, safeDetails, decryptJson, describeAiError, encryptJson, ensureAiCredentialsSchema, lockSecret, parseServiceAccount } from "../aiCredentials.js";
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
    testCandidate: async (candidate, location, report) => { tested.push([candidate.kind === "apikey" ? `apikey:${candidate.apiKey.slice(-4)}` : candidate.serviceAccount.project_id, location]); report?.("signin", "ok"); if (failWith) { const e = new Error(failWith); e.step = "vertex"; throw e; } report?.("vertex", "answered"); if (proWarning) report?.("pro", proWarning, { warn: true }); else report?.("pro", "answered"); return { model: "m" }; },
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
  } finally { server.close(); await db.query("DELETE FROM ai_credentials"); }
});

const REAL_LOOKING_KEY = "AIzaSyD" + "x".repeat(32);

test("a plain Google API key: found inside whatever was pasted, and the other kinds are told apart", () => {
  assert.equal(parseApiKey(REAL_LOOKING_KEY).ok, true);
  assert.equal(parseApiKey(`  GEMINI_API_KEY="${REAL_LOOKING_KEY}"\n`).apiKey, REAL_LOOKING_KEY);
  assert.equal(parseApiKey(`key = ${REAL_LOOKING_KEY.slice(0, 20)} \n ${REAL_LOOKING_KEY.slice(20)}`).ok, true); // a line break in the middle of a pasted key
  assert.equal(parseApiKey(REAL_LOOKING_KEY).hint, "…xxxx");
  assert.match(parseApiKey("").error, /Nothing was pasted/);
  assert.match(parseApiKey("hello").error, /does not look like a Google API key/);
  assert.match(parseApiKey(JSON.stringify(key("p1"))).error, /service-account file/);
  assert.equal(detectKind(REAL_LOOKING_KEY), "apikey");
  assert.equal(detectKind(JSON.stringify(key("p1"))), "vertex");
  assert.equal(detectKind("hello"), null);
  assert.equal(detectKind(""), null);
});

const AQ_KEY = "AQ.Ab8RN6" + "z".repeat(44);

test("Google's newer AQ. keys are accepted as keys (found in messy text, kind detected), and Google's 401 for them is explained without over-claiming", () => {
  const r = parseApiKey(AQ_KEY);
  assert.equal(r.ok, true); assert.equal(r.apiKey, AQ_KEY); assert.equal(r.format, "AQ"); assert.equal(r.hint, "…zzzz");
  assert.equal(parseApiKey(`export GEMINI_API_KEY="${AQ_KEY}"\n`).apiKey, AQ_KEY);
  assert.equal(parseApiKey(`${AQ_KEY.slice(0, 15)}\n${AQ_KEY.slice(15)}`).apiKey, AQ_KEY); // broken over two lines
  assert.equal(parseApiKey(REAL_LOOKING_KEY).format, "AIza");
  assert.equal(detectKind(AQ_KEY), "apikey");
  assert.equal(parseApiKey("AQ.short").ok, false);
  // the exact reply Google's real server gave for a made-up AQ. key
  const raw = 'got status: 401 Unauthorized. {"error":{"code":401,"message":"API key not valid. Please pass a valid API key.","status":"UNAUTHENTICATED","details":[{"reason":"ACCESS_TOKEN_TYPE_UNSUPPORTED"}]}}';
  const said = describeAiError(new Error(raw));
  assert.match(said, /cannot be told from here/); assert.match(said, /last 4 characters/); assert.match(said, /Credentials/); assert.match(said, /Vertex/);
  assert.doesNotMatch(said, /^This is a Google problem/);
});

test("API-key problems get plain sentences (invalid key, restricted key, no prepaid credit)", () => {
  assert.match(describeAiError(new Error('400 API key not valid. Please pass a valid API key. {"status":"INVALID_ARGUMENT","reason":"API_KEY_INVALID"}')), /not valid.*AIza/);
  assert.match(describeAiError(new Error('403 Requests from referer <empty> are blocked. {"reason":"API_KEY_HTTP_REFERRER_BLOCKED"}')), /restrictions/);
  assert.match(describeAiError(new Error("429 Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.")), /out of prepaid credit/);
});

test("a saved Google API key: kept locked, used by the app, never sent back, and removing it goes back to the server's", { skip: !up }, async () => {
  await ensureAiCredentialsSchema(db);
  await db.query("DELETE FROM ai_credentials");
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(key("server-project")), SETTINGS_ENCRYPTION_KEY: "x".repeat(24) };
  try {
    const a = createAiCredentials({ env }); a.attach(db); await a.load();
    assert.equal(a.current().kind, "vertex");
    await a.save({ kind: "apikey", apiKey: REAL_LOOKING_KEY, userName: "Admin Asha" });
    assert.equal(a.current().kind, "apikey");
    assert.equal(a.current().apiKey, REAL_LOOKING_KEY);
    assert.equal(a.current().serviceAccount, null); // the server's Vertex key is not used while a plain key is saved
    const raw = (await db.query("SELECT locked, mode FROM ai_credentials")).rows[0];
    assert.equal(raw.mode, "apikey");
    assert.ok(!raw.locked.includes("AIza"));
    const status = await a.publicStatus();
    assert.equal(status.kind, "apikey"); assert.equal(status.activeKeyHint, "…xxxx"); assert.equal(status.saved.kind, "apikey"); assert.equal(status.saved.keyHint, "…xxxx");
    assert.ok(!JSON.stringify(status).includes(REAL_LOOKING_KEY), "the key must never be sent back");
    assert.deepEqual(status.serverKey, { kind: "vertex", project: "server-project", keyHint: null });
    // after a "restart" it is still there; with another lock secret it is reported, not replaced quietly
    const b = createAiCredentials({ env }); b.attach(db); await b.load();
    assert.equal(b.current().apiKey, REAL_LOOKING_KEY);
    const c = createAiCredentials({ env: { ...env, SETTINGS_ENCRYPTION_KEY: "y".repeat(24) } }); c.attach(db); await c.load();
    assert.equal(c.current().source, "saved-unreadable");
    assert.equal(c.current().apiKey, null);
    await a.clear();
    assert.equal(a.current().kind, "vertex");
    // an API key can also be the server's own (GEMINI_API_KEY) when there is no Vertex key
    const d = createAiCredentials({ env: { GEMINI_API_KEY: REAL_LOOKING_KEY } });
    assert.equal(d.current().kind, "apikey"); assert.equal(d.current().source, "apikey");
  } finally { await db.query("DELETE FROM ai_credentials"); }
});

test("Settings routes with a Google API key: tested and saved like the other kind; mixing the kinds up is explained, not guessed", { skip: !up }, async () => {
  await ensureAiCredentialsSchema(db);
  await db.query("DELETE FROM ai_credentials");
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(key("server-project")), SETTINGS_ENCRYPTION_KEY: "x".repeat(24) };
  const creds = createAiCredentials({ env }); creds.attach(db); await creds.load();
  const seen = []; let fail = null;
  const app = express(); app.use(express.json());
  registerAiSettingsRoutes(app, db, {
    requireRole: () => (req, res, next) => { req.user = { id: 1, name: "Admin Asha" }; next(); },
    aiCredentials: creds,
    testCandidate: async (candidate, location, report) => { seen.push(candidate.kind); report?.("answer", "ok"); if (fail) { const e = new Error(fail); e.step = "answer"; throw e; } report?.("pro", "answered"); return { model: "m" }; },
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, text: await r.text() }; };
  try {
    const ok = JSON.parse((await call("POST", "/api/settings/ai/test", { kind: "apikey", key: REAL_LOOKING_KEY })).text);
    assert.equal(ok.ok, true); assert.equal(ok.kind, "apikey"); assert.equal(ok.keyHint, "…xxxx");
    assert.deepEqual(ok.steps.map((s) => s.key), ["format", "answer", "pro"]);
    // the wrong kind selected: refused with a pointer
    const wrong1 = await call("POST", "/api/settings/ai/test", { kind: "vertex", key: REAL_LOOKING_KEY });
    assert.equal(wrong1.status, 400); assert.match(JSON.parse(wrong1.text).error, /looks like an API key/);
    const wrong2 = await call("POST", "/api/settings/ai/test", { kind: "apikey", key: JSON.stringify(key("p1")) });
    assert.equal(wrong2.status, 400); assert.match(JSON.parse(wrong2.text).error, /looks like a JSON key file/);
    // a bad key is not saved
    fail = "400 API key not valid. Please pass a valid API key. API_KEY_INVALID";
    const bad = await call("PUT", "/api/settings/ai", { kind: "apikey", key: REAL_LOOKING_KEY });
    assert.equal(bad.status, 422); assert.match(JSON.parse(bad.text).error, /not valid/);
    assert.equal(JSON.parse((await call("GET", "/api/settings/ai")).text).kind, "vertex");
    fail = null;
    const saved = await call("PUT", "/api/settings/ai", { kind: "apikey", key: REAL_LOOKING_KEY });
    const s = JSON.parse(saved.text);
    assert.equal(s.source, "saved"); assert.equal(s.kind, "apikey"); assert.equal(s.activeKeyHint, "…xxxx"); assert.equal(s.saved.savedBy, "Admin Asha");
    assert.ok(!saved.text.includes(REAL_LOOKING_KEY));
    // the newer AQ. key goes the same way, and the kind is worked out from it
    const aq = JSON.parse((await call("POST", "/api/settings/ai/test", { key: AQ_KEY })).text);
    assert.equal(aq.ok, true); assert.equal(aq.kind, "apikey"); assert.equal(aq.keyHint, "…zzzz");
    const aqSaved = JSON.parse((await call("PUT", "/api/settings/ai", { key: `  ${AQ_KEY}\n` })).text);
    assert.equal(aqSaved.kind, "apikey"); assert.equal(aqSaved.activeKeyHint, "…zzzz");
    // kind left out: it is worked out from what was pasted
    const auto = JSON.parse((await call("POST", "/api/settings/ai/test", { key: JSON.stringify(key("auto-project")) })).text);
    assert.equal(auto.kind, "vertex"); assert.equal(auto.projectId, "auto-project");
    assert.equal(JSON.parse((await call("DELETE", "/api/settings/ai")).text).kind, "vertex");
  } finally { server.close(); await db.query("DELETE FROM ai_credentials"); }
});

after(async () => { await db.end(); });

test("a refused AQ. key whose Vertex-express probe succeeded is explained as 'the key is fine, this app does not use that route yet'", { skip: !up }, async () => {
  const pg2 = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
  try {
    await ensureAiCredentialsSchema(pg2);
    const creds = createAiCredentials({ env: { SETTINGS_ENCRYPTION_KEY: "x".repeat(24) } }); creds.attach(pg2);
    let probe = { ok: true, status: 200, text: "" };
    const app = express(); app.use(express.json());
    registerAiSettingsRoutes(app, pg2, {
      requireRole: () => (req, res, next) => { req.user = { id: 1, name: "A" }; next(); },
      aiCredentials: creds,
      testCandidate: async () => { const e = new Error('got status: 401 . {"error":{"message":"API key not valid.","details":[{"reason":"ACCESS_TOKEN_TYPE_UNSUPPORTED"}]}}'); e.step = "answer"; e.express = probe; throw e; },
    });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async () => JSON.parse(await (await fetch(`${base}/api/settings/ai/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: AQ_KEY }) })).text());
    try {
      const good = await post();
      assert.equal(good.ok, false);
      assert.deepEqual(good.steps.map((s) => [s.key, s.ok]), [["format", true], ["answer", false], ["express", true]]);
      assert.match(good.message, /GOOD NEWS/); assert.match(good.details, /Vertex express route: HTTP 200 \(accepted\)/);
      probe = { ok: false, status: 401, text: "API key not valid" };
      const bad = await post();
      assert.deepEqual(bad.steps.map((s) => [s.key, s.ok]), [["format", true], ["answer", false], ["express", false]]);
      assert.doesNotMatch(bad.message, /GOOD NEWS/); assert.match(bad.details, /HTTP 401 API key not valid/);
      assert.ok(!JSON.stringify(good).includes(AQ_KEY) && !JSON.stringify(bad).includes(AQ_KEY), "the key must not come back in any reply");
    } finally { server.close(); }
  } finally { await pg2.end(); }
});

test("NOTHING saved in Settings = the app runs exactly as it did before: the server's own key, the server's own settings, untouched", () => {
  // the server has BOTH a Vertex file and a plain key (as some servers do): before Settings existed, the main AI used Vertex and the
  // pictures/voices/video helper read the environment as it was (where a plain key wins). That must stay exactly so.
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(key("server-project")), GEMINI_API_KEY: "AIza-server-plain-key-xxxxxxxxxxxxxxxx", GOOGLE_CLOUD_LOCATION: "europe-west4" };
  const both = createAiCredentials({ env });
  assert.equal(both.current().source, "server");
  assert.equal(both.current().kind, "vertex");
  assert.equal(both.current().serviceAccount.project_id, "server-project");
  assert.equal(both.current().location, "europe-west4");
  assert.equal(providerEnv(env, both.current()), env, "the helper must get the very same environment, not a changed copy");
  // only a plain key on the server
  const plain = createAiCredentials({ env: { GEMINI_API_KEY: "AIza-server-plain-key-xxxxxxxxxxxxxxxx" } });
  assert.equal(plain.current().kind, "apikey"); assert.equal(plain.current().apiKey, "AIza-server-plain-key-xxxxxxxxxxxxxxxx");
  assert.equal(providerEnv({ GEMINI_API_KEY: "k" }, plain.current()).GEMINI_API_KEY, "k");
  // nothing at all
  assert.equal(createAiCredentials({ env: {} }).current().kind, null);
  // once something IS saved, the choice is explicit; an unreadable saved key never lets another key in
  assert.equal(providerEnv(env, { source: "saved", kind: "vertex" }).GEMINI_API_KEY, "");
  assert.equal(providerEnv(env, { source: "saved", kind: "apikey", apiKey: "AQ.mine" }).GEMINI_API_KEY, "AQ.mine");
  assert.equal(providerEnv(env, { source: "saved-unreadable" }).GEMINI_API_KEY, "");
});

test("summariseModels: says which models a key sees and which the app needs are missing", () => {
  const listing = { models: [
    { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] },
    { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
  ] };
  const some = summariseModels(listing, ["gemini-2.5-flash", "gemini-3.8-flash"]);
  assert.deepEqual(some.missing, ["gemini-3.8-flash"]);
  assert.equal(some.warn, true);
  assert.match(some.note, /gemini-2\.5-flash/);
  assert.match(some.note, /does NOT see them: gemini-3\.8-flash/);
  assert.doesNotMatch(some.note, /embedding/);
  const all = summariseModels(listing, ["gemini-2.5-flash"]);
  assert.equal(all.warn, false);
  assert.match(all.note, /All are in Google/);
  assert.equal(summariseModels({}, ["x"]).warn, true);
});
