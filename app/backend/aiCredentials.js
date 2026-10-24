// The AI connection (Google Vertex service-account key): where the app reads it from, and how the admin can change it from Settings
// without touching the server's settings or redeploying.
//
// Order of use:  1. the key the admin saved in Settings (kept in the database, encrypted)  2. the server's own GOOGLE_SERVICE_ACCOUNT_JSON  3. the plain
// Gemini key (GEMINI_API_KEY).  A saved key that cannot be read is NOT silently replaced by another one (that could bill another account):
// the problem is shown in Settings, and the admin can remove the saved key to go back to the server's.
//
// The key is never sent back to the browser and never written to the log.
import crypto from "node:crypto";

// ---- locking the key in the database (AES-256-GCM) -------------------------------------------------------------------------------------

// SETTINGS_ENCRYPTION_KEY (a long secret kept only on the server) gives the strongest protection. Without it the lock is made from the server's
// database address, which a copy of the database alone does not contain; Settings says which of the two is in use.
export function lockSecret(env = process.env) {
  if (env.SETTINGS_ENCRYPTION_KEY && env.SETTINGS_ENCRYPTION_KEY.length >= 16) return { secret: env.SETTINGS_ENCRYPTION_KEY, strength: "strong" };
  return { secret: env.DATABASE_URL || "filmybase-local-development", strength: "basic" };
}

const keyFrom = (secret) => crypto.scryptSync(String(secret), "filmybase-ai-credentials-v1", 32);

export function encryptJson(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${body.toString("base64")}`;
}

// -> the value, or null when the lock does not open (wrong secret, damaged data)
export function decryptJson(blob, secret) {
  try {
    const [version, iv, tag, body] = String(blob).split(".");
    if (version !== "v1") return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8"));
  } catch { return null; }
}

// ---- checking what the admin pasted ----------------------------------------------------------------------------------------------------

// What arrives is often not the file exactly as Google made it — especially from a phone: an invisible byte-order mark, curly quotes, real line
// breaks inside the private key, text around it, the whole thing wrapped in quotes. These are cleaned up before reading, so a good key is not refused
// for how it was copied.
function straighten(text) {
  let t = String(text ?? "").replace(/^\uFEFF/, "").replace(/[\u200B-\u200D\u2060\u00A0]/g, " ").trim();
  t = t.replace(/[“”„‟]/g, '"').replace(/[‘’]/g, "'");
  // wrapped in quotes with the inside escaped ("{\"type\": …}")
  if (t.startsWith('"') && t.endsWith('"') && t.length > 2) {
    try { const inner = JSON.parse(t); if (typeof inner === "string") t = inner.trim(); } catch { /* not a wrapped string */ }
  }
  // text before or after the braces
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first && (first > 0 || last < t.length - 1)) t = t.slice(first, last + 1);
  return t;
}

// raw line breaks / tabs inside a "string" are not allowed in JSON: write them as \n and \t
function escapeRawBreaksInStrings(t) {
  let out = "";
  let inString = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (ch === "\\") { out += ch + (t[++i] ?? ""); continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") continue;
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

export function parseServiceAccount(input) {
  let json = input;
  if (typeof input === "string") {
    const text = straighten(input);
    if (!text) return { ok: false, error: "Nothing was pasted. Choose the key file, or paste the whole content of it." };
    if (/^AIza[\w-]{20,}$/.test(text)) return { ok: false, error: "That is an API key (it starts with AIza…), not a service-account file. Here a service-account JSON file is needed: in Google Cloud open IAM → Service accounts → your account → Keys → Add key → Create new key → JSON." };
    if (!text.includes("{")) return { ok: false, error: "That does not look like the key file: it should start with { and end with }. Open the downloaded .json file, select ALL of its text and paste it, or use “Choose the JSON file”." };
    try { json = JSON.parse(text); } catch {
      try { json = JSON.parse(escapeRawBreaksInStrings(text)); } catch {
        const cutOff = (text.match(/{/g) || []).length > (text.match(/}/g) || []).length;
        return { ok: false, error: cutOff
          ? "The text looks cut off — the closing } is missing. The copy stopped early (long text can be cut on a phone). Use “Choose the JSON file” instead, or copy the whole file again."
          : "The text could not be read as a key file. It may have been changed while copying. Use “Choose the JSON file” with the file exactly as downloaded from Google Cloud." };
      }
    }
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, error: "That is not a Google service-account key." };
  if (json.type && json.type !== "service_account") return { ok: false, error: `This file is a “${json.type}” key, not a service-account key. In Google Cloud use IAM → Service accounts → Keys → Add key → Create new key → JSON.` };
  for (const field of ["project_id", "client_email", "private_key"]) {
    if (typeof json[field] !== "string" || !json[field].trim()) return { ok: false, error: `The key is missing "${field}". Download the key file again from Google Cloud and use all of it.` };
  }
  // a private key whose line breaks were written twice ("\\n" as two letters) is put right
  let privateKey = json.private_key.replace(/^\s+/, ""); // the trailing line break of the key is kept exactly as Google wrote it
  if (!privateKey.includes("\n") && privateKey.includes("\\n")) privateKey = privateKey.replace(/\\n/g, "\n");
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey) || !/-----END [A-Z ]*PRIVATE KEY-----/.test(privateKey)) return { ok: false, error: 'The "private_key" in this file is incomplete or changed (it must start with -----BEGIN PRIVATE KEY----- and end with -----END PRIVATE KEY-----). Use the file exactly as downloaded.' };
  const serviceAccount = { ...json, type: "service_account", private_key: privateKey };
  return { ok: true, serviceAccount, projectId: serviceAccount.project_id.trim(), clientEmail: serviceAccount.client_email.trim() };
}

export const cleanLocation = (value) => (/^[a-z]+(?:-[a-z]+\d+)?$/.test(String(value ?? "").trim()) ? String(value).trim() : "us-central1");

// Google's raw error -> a plain sentence that says what to do
export function describeAiError(error, step = null) {
  const raw = String(error?.message ?? error ?? "");
  const project = /projects\/([\w-]+)/.exec(raw)?.[1];
  if (/billing|dunning/i.test(raw)) return `Google says the billing account of this project${project ? ` (${project})` : ""} has a problem — usually an unpaid balance (Google calls it “dunning”), a closed or suspended account, or no billing account linked. Open Google Cloud → Billing, fix or link the billing account, then test again.`;
  if (/API has not been used|SERVICE_DISABLED|is not enabled|has not been enabled/i.test(raw)) return "The Vertex AI API is switched off in this Google project. Open Google Cloud → APIs & Services → enable “Vertex AI API”, wait a minute, then test again.";
  if (/PERMISSION_DENIED|permission .* denied|403/i.test(raw)) return "This key is not allowed to use Vertex AI. In Google Cloud → IAM, give this service account the role “Vertex AI User”, then test again.";
  if (/invalid_grant|invalid_client|UNAUTHENTICATED|401|could not load the default credentials|Invalid JWT|DECODER routines|private key/i.test(raw)) return "Google did not accept this key (it may have been deleted or disabled, or the file was changed). Create a new JSON key for the service account and paste that.";
  if (/NOT_FOUND|404/i.test(raw)) return "Google could not find the AI model in this location. Check the Location (for example us-central1) and that the Vertex AI API is enabled in this project.";
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(raw)) return "Google says this project is out of AI quota right now. Wait a few minutes, or raise the quota in Google Cloud.";
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed|timed out/i.test(raw)) return "The server could not reach Google just now. Try again in a minute.";
  if (step === "signin") return "Google did not accept this key at sign-in (it may be disabled, deleted, or changed while copying). Create a new JSON key for the service account and use that file exactly as downloaded.";
  return `Google refused the test call: ${raw.slice(0, 300)}`;
}

// the raw text for the “Technical details” box: shortened, and any long secret-looking run removed
export function safeDetails(error) {
  return String(error?.message ?? error ?? "").replace(/-----BEGIN[\s\S]*?-----END [A-Z ]*-----/g, "[key removed]").replace(/[A-Za-z0-9+\/=_-]{60,}/g, "[long text removed]").slice(0, 700);
}

// ---- the live holder --------------------------------------------------------------------------------------------------------------------

export async function ensureAiCredentialsSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    locked TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT 'us-central1',
    project_id TEXT NOT NULL,
    client_email TEXT NOT NULL,
    saved_by TEXT,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

export function createAiCredentials({ env = process.env } = {}) {
  const fromServer = () => {
    let serviceAccount = null;
    try { serviceAccount = env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) : null; } catch { /* a broken server key is reported at start-up */ }
    return { source: serviceAccount ? "server" : env.GEMINI_API_KEY ? "apikey" : "none", serviceAccount, location: env.GOOGLE_CLOUD_LOCATION || "us-central1", savedBy: null, savedAt: null, problem: null };
  };
  let state = fromServer();
  let db = null;
  let timer = null;
  const listeners = new Set();
  const same = (a, b) => a.source === b.source && a.location === b.location && a.serviceAccount?.private_key_id === b.serviceAccount?.private_key_id && a.serviceAccount?.client_email === b.serviceAccount?.client_email && a.problem === b.problem;
  const set = (next) => { const changed = !same(state, next); state = next; if (changed) for (const fn of listeners) { try { fn(state); } catch { /* a listener must not break the others */ } } };

  async function load() {
    if (!db) return state;
    const row = (await db.query("SELECT locked, location, saved_by, saved_at FROM ai_credentials WHERE id = 1")).rows[0];
    if (!row) { set(fromServer()); return state; }
    const opened = decryptJson(row.locked, lockSecret(env).secret);
    const parsed = opened ? parseServiceAccount(opened) : null;
    if (!parsed?.ok) {
      // do not fall back to another key quietly: say so
      set({ ...fromServer(), source: "saved-unreadable", serviceAccount: null, problem: "The key saved in Settings can no longer be read (the server's lock changed or the data is damaged). Paste the key again, or remove the saved key to use the server's own.", savedBy: row.saved_by, savedAt: row.saved_at });
      return state;
    }
    set({ source: "saved", serviceAccount: parsed.serviceAccount, location: row.location, savedBy: row.saved_by, savedAt: row.saved_at, problem: null });
    return state;
  }

  return {
    current: () => state,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    attach(database) { db = database; },
    load,
    // another copy of the server may have changed it: look again every half minute
    startRefresh(everyMs = 30000) { if (!timer) { timer = setInterval(() => load().catch(() => {}), everyMs); timer.unref?.(); } },
    async save({ serviceAccount, location, userName }) {
      const lock = lockSecret(env);
      await db.query(
        `INSERT INTO ai_credentials (id, locked, location, project_id, client_email, saved_by, saved_at) VALUES (1, $1, $2, $3, $4, $5, now())
         ON CONFLICT (id) DO UPDATE SET locked = EXCLUDED.locked, location = EXCLUDED.location, project_id = EXCLUDED.project_id, client_email = EXCLUDED.client_email, saved_by = EXCLUDED.saved_by, saved_at = now()`,
        [encryptJson(serviceAccount, lock.secret), cleanLocation(location), serviceAccount.project_id, serviceAccount.client_email, userName ?? null]);
      return load();
    },
    async clear() { await db.query("DELETE FROM ai_credentials WHERE id = 1"); return load(); },
    // what the browser may see (never the key itself)
    async publicStatus() {
      const row = db ? (await db.query("SELECT project_id, client_email, saved_by, saved_at FROM ai_credentials WHERE id = 1")).rows[0] : null;
      const sa = state.serviceAccount;
      return {
        source: state.source,
        activeProject: sa?.project_id ?? null,
        activeEmail: sa?.client_email ?? null,
        location: state.location,
        problem: state.problem,
        saved: row ? { projectId: row.project_id, clientEmail: row.client_email, savedBy: row.saved_by, savedAt: row.saved_at } : null,
        serverKeyProject: (() => { try { return env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON).project_id : null; } catch { return null; } })(),
        lock: lockSecret(env).strength,
      };
    },
  };
}
