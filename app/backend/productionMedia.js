// Wires the media store (mediaStore.js) into the server: Google Drive
// sign-in, storage status, and the route that streams stored media to the
// browser. Drive links are never given to the browser — it always goes
// through the backend, after the login/role check.

import crypto from "node:crypto";
import path from "node:path";
import { createDriveBackend, createLocalBackend, createMediaStore, ensureMediaSchema, backendNameFromEnv } from "./mediaStore.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"; // only files this app creates
const OAUTH_STATE_PREFIX = "drive.";
const NONCE_TTL_MS = 10 * 60 * 1000;

// Types that could run script if a browser rendered them inside our own
// origin. They are only ever sent as downloads.
const DOWNLOAD_ONLY = new Set(["text/html", "application/json", "text/plain", "application/zip", "application/pdf"]);

export function setupProductionMedia({ app, db, requireRole, backendDir, frontendUrl, redirectUri, env = process.env, driveOverrides = {}, googleOverrides = {} }) {
  const tokenUrl = googleOverrides.tokenUrl ?? GOOGLE_TOKEN_URL;
  const revokeUrl = googleOverrides.revokeUrl ?? GOOGLE_REVOKE_URL;
  const nonces = new Map(); // nonce -> expiry (one backend process)
  let accountCache = null; // { at, value } — who the connected Drive belongs to

  async function getDriveAccessToken() {
    const row = (await db.query("SELECT * FROM production_drive_tokens ORDER BY id DESC LIMIT 1")).rows[0];
    if (!row) return null;
    if (row.access_token && Date.now() < Number(row.expiry_date) - 60000) return row.access_token;
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID ?? "",
        client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
        refresh_token: row.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    const tokens = await response.json().catch(() => ({}));
    if (!tokens.access_token) return null; // revoked/expired (e.g. invalid_grant): shows as "reconnect needed"
    await db.query("UPDATE production_drive_tokens SET access_token = $1, expiry_date = $2, updated_at = now() WHERE id = $3", [
      tokens.access_token, Date.now() + (tokens.expires_in ?? 3600) * 1000, row.id,
    ]);
    return tokens.access_token;
  }

  const backendName = backendNameFromEnv(env);
  const backend =
    backendName === "gdrive"
      ? createDriveBackend({ db, getAccessToken: getDriveAccessToken, rootFolderId: env.GOOGLE_DRIVE_ROOT_FOLDER_ID || null, ...driveOverrides })
      : createLocalBackend({ root: env.MEDIA_ROOT || path.join(backendDir, "media") });
  const store = createMediaStore({ db, backend, spoolDir: path.join(env.MEDIA_SPOOL_DIR || path.join(backendDir, "media-spool")) });

  // --- Google Drive sign-in (separate from the Contacts sign-in) -----------

  app.get("/api/production/drive/connect", requireRole("admin"), (req, res) => {
    if (!env.GOOGLE_CLIENT_ID) {
      res.status(500).send("GOOGLE_CLIENT_ID is not set on the server yet.");
      return;
    }
    for (const [n, exp] of nonces) if (exp < Date.now()) nonces.delete(n);
    const nonce = crypto.randomBytes(16).toString("hex");
    nonces.set(nonce, Date.now() + NONCE_TTL_MS);
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: DRIVE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state: `${OAUTH_STATE_PREFIX}${nonce}`,
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  // Called from the existing /api/auth/google/callback when state starts
  // with "drive." (one registered redirect address serves both sign-ins).
  async function handleDriveCallback(req, res) {
    const nonce = String(req.query.state ?? "").slice(OAUTH_STATE_PREFIX.length);
    const expiry = nonces.get(nonce);
    nonces.delete(nonce);
    if (req.query.error) {
      res.redirect(`${frontendUrl}/?googleDriveError=1&reason=denied`);
      return;
    }
    if (!expiry || expiry < Date.now() || !req.query.code) {
      res.redirect(`${frontendUrl}/?googleDriveError=1&reason=expired`);
      return;
    }
    try {
      const response = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: String(req.query.code),
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      const tokens = await response.json();
      if (!tokens.access_token) {
        console.error("Google Drive connect failed:", tokens.error_description || tokens.error || "no access token");
        res.redirect(`${frontendUrl}/?googleDriveError=1&reason=token`);
        return;
      }
      const previous = (await db.query("SELECT refresh_token FROM production_drive_tokens ORDER BY id DESC LIMIT 1")).rows[0];
      const refresh = tokens.refresh_token || previous?.refresh_token;
      if (!refresh) {
        res.redirect(`${frontendUrl}/?googleDriveError=1&reason=no_refresh`);
        return;
      }
      await db.query("DELETE FROM production_drive_tokens");
      await db.query("INSERT INTO production_drive_tokens (access_token, refresh_token, expiry_date) VALUES ($1,$2,$3)", [
        tokens.access_token, refresh, Date.now() + (tokens.expires_in ?? 3600) * 1000,
      ]);
      accountCache = null;
      res.redirect(`${frontendUrl}/?googleDriveConnected=1`);
    } catch (error) {
      console.error("Google Drive connect failed:", error.message);
      res.redirect(`${frontendUrl}/?googleDriveError=1&reason=token`);
    }
  }

  // --- Status, connection test, disconnect ------------------------------------

  app.get("/api/production/storage/status", requireRole("admin"), async (req, res) => {
    const counts = (await db.query("SELECT status, count(*)::int AS n FROM production_media_files GROUP BY status")).rows;
    const status = {
      backend: backendName,
      configured: backendName !== "gdrive" || Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      driveConnected: null,
      reconnectNeeded: false,
      account: null,
      rootFolderSet: Boolean(env.GOOGLE_DRIVE_ROOT_FOLDER_ID),
      files: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      // Honest warning for the one setup that loses data.
      warning: backendName === "local" && env.RENDER ? "Local storage on Render is erased on every deploy." : null,
      // What to enter at Google if the sign-in page complains (no secrets here).
      setup: { redirectUri, permission: DRIVE_SCOPE },
    };
    if (backendName === "gdrive") {
      const hasTokens = (await db.query("SELECT 1 FROM production_drive_tokens LIMIT 1")).rowCount > 0;
      if (!hasTokens) {
        status.driveConnected = false;
      } else if (!(await getDriveAccessToken())) {
        // Saved sign-in no longer works (revoked, expired after 7 days in Google's "Testing" mode, ...).
        status.driveConnected = false;
        status.reconnectNeeded = true;
      } else {
        status.driveConnected = true;
        if (!accountCache || Date.now() - accountCache.at > 5 * 60 * 1000) accountCache = { at: Date.now(), value: await backend.about() };
        status.account = accountCache.value;
      }
    }
    res.json(status);
  });

  // Proves the storage really works end to end (small file in, same file out,
  // then deleted) and explains any failure in plain English.
  app.post("/api/production/storage/test", requireRole("admin"), async (req, res) => {
    if (backendName === "gdrive" && !(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)) {
      res.json({ ok: false, code: "not_configured", message: "The server has no Google sign-in credentials yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)." });
      return;
    }
    res.json({ backend: backendName, ...(await backend.selfTest()) });
  });

  // Forgets the Drive sign-in (and asks Google to cancel it). Files already in
  // Drive stay there; they stop being readable by the app until the SAME
  // Google account is connected again.
  app.post("/api/production/drive/disconnect", requireRole("admin"), async (req, res) => {
    const row = (await db.query("SELECT refresh_token FROM production_drive_tokens ORDER BY id DESC LIMIT 1")).rows[0];
    let revoked = null;
    if (row) {
      try {
        const response = await fetch(`${revokeUrl}?token=${encodeURIComponent(row.refresh_token)}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        revoked = response.ok;
      } catch {
        revoked = false; // Google unreachable: we still forget it on our side
      }
    }
    await db.query("DELETE FROM production_drive_tokens");
    await db.query("DELETE FROM production_drive_folders");
    accountCache = null;
    res.json({ ok: true, wasConnected: Boolean(row), revokedAtGoogle: revoked });
  });

  // --- Streaming media to the browser ---------------------------------------

  // Streams one stored file. The CALLER must already have checked that this
  // person may see this file.
  async function serveMedia(req, res, id) {
    let range = null;
    const header = req.headers.range;
    if (header) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(header);
      if (!m || (m[1] === "" && m[2] === "")) {
        res.status(416).end();
        return;
      }
      range = m[1] === "" ? null : { start: Number(m[1]), end: m[2] === "" ? undefined : Number(m[2]) };
      if (m[1] === "") { // suffix range: last N bytes
        const row = (await db.query("SELECT bytes FROM production_media_files WHERE id = $1", [id])).rows[0];
        if (row) range = { start: Math.max(0, Number(row.bytes) - Number(m[2])), end: undefined };
      }
    }
    let opened;
    try {
      opened = await store.openMedia(id, range);
    } catch (error) {
      if (error.code === "RANGE") {
        res.status(416).end();
        return;
      }
      console.error("Media read failed:", error.message);
      res.status(502).json({ error: "The file could not be read from storage right now." });
      return;
    }
    if (!opened) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    if (opened.unavailable) {
      res.status(503).json({ error: "This file is not available (upload failed and the temporary copy is gone)." });
      return;
    }
    const { row, stream, size, start, end } = opened;
    const partial = Boolean(header);
    res.status(partial ? 206 : 200);
    res.setHeader("Content-Type", row.mime);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(end - start + 1));
    if (partial) res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    const disposition = DOWNLOAD_ONLY.has(row.mime) ? "attachment" : "inline";
    res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(row.stored_name)}`);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  app.get("/api/production/media/:id", requireRole("admin"), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Not a valid file." });
      return;
    }
    await serveMedia(req, res, id);
  });

  // --- Background retry of uploads that failed earlier -----------------------

  const flush = () => store.flushPendingUploads().catch((error) => console.error("Pending media upload retry failed:", error.message));
  const timer = setInterval(flush, 2 * 60 * 1000);
  timer.unref?.();

  return { store, backendName, serveMedia, handleDriveCallback, getDriveAccessToken, flush, ensureSchema: () => ensureMediaSchema(db) };
}
