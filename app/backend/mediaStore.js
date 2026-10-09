// Media storage for the production workflow: every image / video / audio /
// export lives in the user's own storage — Google Drive (default on Render,
// whose disk is wiped on every deploy) or a local folder (own computer).
// Nothing is kept only at an AI provider, and no provider URL is ever stored.
//
// The rest of the app only calls the functions at the bottom (putMedia /
// openMedia / flushPendingUploads). Which backend is used is configuration.

import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function ensureMediaSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS production_media_files (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      backend TEXT NOT NULL,
      storage_key TEXT,
      stored_name TEXT NOT NULL,
      original_name TEXT,
      mime TEXT NOT NULL,
      bytes BIGINT NOT NULL,
      sha256 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'stored',
      spool_path TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (project_id, sha256)
    )`,
    `ALTER TABLE production_media_files ADD COLUMN IF NOT EXISTS subfolder TEXT`,
    // The folder name each project has in storage (kept stable; renamed on purpose).
    `CREATE TABLE IF NOT EXISTS production_project_folders (
      project_id INTEGER PRIMARY KEY REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      folder_name TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Drive folder ids already created, so a folder is never made twice.
    `CREATE TABLE IF NOT EXISTS production_drive_folders (
      path_key TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Single-row Drive sign-in (separate from the Contacts sign-in on purpose,
    // so connecting one never disconnects the other).
    `CREATE TABLE IF NOT EXISTS production_drive_tokens (
      id SERIAL PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT NOT NULL,
      expiry_date BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  ];
  for (const sql of statements) await db.query(sql);
}

// ---------------------------------------------------------------------------
// What may be stored
// ---------------------------------------------------------------------------

const EXT_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
  ".zip": "application/zip", ".json": "application/json", ".txt": "text/plain", ".html": "text/html", ".pdf": "application/pdf",
};

// The fixed, numbered order every project folder is arranged in.
export const PROJECT_FOLDER_LAYOUT = [
  "01 Characters", "02 Props", "03 Environments", "04 Shot images", "05 Audio", "06 Video", "07 Exports", "08 Designer uploads",
];
// Which numbered folder each kind of file goes into.
const ROLE_FOLDERS = {
  character: "01 Characters", prop: "02 Props", environment: "03 Environments", location: "03 Environments",
  keyframe: "04 Shot images", storyboard: "04 Shot images", audio: "05 Audio", video_take: "06 Video",
  export: "07 Exports", design: "08 Designer uploads",
};

// A name safe to use as a Drive / disk folder name: keeps letters of every
// language (Hindi, Odia...), brackets and spaces; removes characters that
// folders cannot hold.
export function safeFolderName(text, fallback = "Untitled") {
  const cleaned = String(text ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 100)
    .trim();
  return cleaned || fallback;
}

// Checks the first bytes really look like what the extension claims, for the
// formats we can recognise cheaply. Returns true when it can't tell.
export function magicMatches(mime, head) {
  const starts = (...bytes) => bytes.every((b, i) => head[i] === b);
  switch (mime) {
    case "image/png": return starts(0x89, 0x50, 0x4e, 0x47);
    case "image/jpeg": return starts(0xff, 0xd8, 0xff);
    case "image/gif": return starts(0x47, 0x49, 0x46, 0x38);
    case "image/webp": return head.slice(0, 4).toString() === "RIFF" && head.slice(8, 12).toString() === "WEBP";
    case "application/pdf": return head.slice(0, 4).toString() === "%PDF";
    case "application/zip": return starts(0x50, 0x4b);
    case "video/mp4": case "video/quicktime": return head.slice(4, 8).toString() === "ftyp";
    default: return true;
  }
}

function safeName(text) {
  return String(text ?? "file").normalize("NFC").replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "file";
}

// Turns any storage error into a code + plain-English sentence a person can act on.
export function explainStorageError(error) {
  const text = String(error?.googleMessage ?? error?.message ?? "");
  const reason = error?.reason ?? "";
  if (error?.code === "DRIVE_NOT_CONNECTED") return { code: "not_connected", message: "Google Drive is not connected yet. Press Connect Google Drive." };
  if (error?.status === 401) return { code: "reconnect_needed", message: "Google rejected the saved sign-in. Press Connect Google Drive again." };
  if (error?.status === 403 && (/accessNotConfigured|SERVICE_DISABLED/i.test(reason) || /has not been used in project|is disabled|API has not been enabled/i.test(text))) {
    return { code: "api_not_enabled", message: "The Google Drive API is not switched on for your Google Cloud project. Enable it in Google Cloud Console (APIs & Services > Library > Google Drive API), wait a minute, then test again." };
  }
  if (error?.status === 403 && /storageQuotaExceeded|quotaExceeded/i.test(reason + text)) return { code: "drive_full", message: "Your Google Drive storage is full." };
  if (error?.status === 403 && /rateLimit|userRateLimit/i.test(reason)) return { code: "rate_limited", message: "Google is asking us to slow down. Try again in a minute." };
  if (error?.status === 403) return { code: "permission", message: "Google refused permission for this action. Press Connect Google Drive again and accept every permission it asks for." };
  if (error?.status === 404) return { code: "folder_missing", message: "The Google Drive folder could not be found (it may have been deleted, or GOOGLE_DRIVE_ROOT_FOLDER_ID is wrong)." };
  if (error?.status === 429) return { code: "rate_limited", message: "Google is asking us to slow down. Try again in a minute." };
  if (error?.status >= 500) return { code: "google_down", message: "Google Drive is having trouble right now. Try again in a few minutes." };
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network/i.test(text)) return { code: "network", message: "The server could not reach Google. Try again in a minute." };
  return { code: "unknown", message: text || "Something went wrong talking to Google Drive." };
}

// ---------------------------------------------------------------------------
// Backend: local folder
// ---------------------------------------------------------------------------

export function createLocalBackend({ root }) {
  const resolveSafe = (key) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error("Unsafe storage path.");
    return full;
  };
  return {
    name: "local",
    // Local disk keeps the folder name it was created with (no renaming).
    async ensureProjectTree({ projectName, layout }) {
      for (const sub of layout) await fsPromises.mkdir(resolveSafe(path.posix.join(projectName, sub)), { recursive: true });
      return { created: true };
    },
    folderLink() { return null; },
    async put({ folderParts, fileName, filePath }) {
      const key = path.posix.join(...folderParts.map((part) => part.name ?? part), fileName);
      const dest = resolveSafe(key);
      await fsPromises.mkdir(path.dirname(dest), { recursive: true });
      await fsPromises.copyFile(filePath, dest);
      return { key };
    },
    async open(key, range) {
      const full = resolveSafe(key);
      const { size } = await fsPromises.stat(full);
      const { start, end } = clampRange(range, size);
      return { stream: fs.createReadStream(full, { start, end }), size, start, end };
    },
    async remove(key) {
      await fsPromises.unlink(resolveSafe(key)).catch(() => {});
    },
    // Writes, reads back and deletes a small file, to prove the folder works.
    async selfTest() {
      const src = path.join(os.tmpdir(), `filmybase-local-test-${crypto.randomUUID()}.txt`);
      const body = `FilmyBase storage test ${new Date().toISOString()}`;
      try {
        await fsPromises.writeFile(src, body);
        const { key } = await this.put({ folderParts: ["_connection-test"], fileName: "connection-test.txt", filePath: src });
        const back = await fsPromises.readFile(resolveSafe(key), "utf8");
        await this.remove(key);
        await fsPromises.rmdir(path.dirname(resolveSafe(key))).catch(() => {});
        return back === body ? { ok: true, steps: ["write", "read", "cleanup"] } : { ok: false, code: "mismatch", message: "The file read back did not match what was written." };
      } catch (error) {
        return { ok: false, ...explainStorageError(error) };
      } finally {
        await fsPromises.unlink(src).catch(() => {});
      }
    },
  };
}

function clampRange(range, size) {
  let start = 0;
  let end = size - 1;
  if (range) {
    start = Math.max(0, range.start ?? 0);
    end = Math.min(size - 1, range.end ?? size - 1);
  }
  if (start > end || size === 0) throw Object.assign(new Error("Range not satisfiable"), { code: "RANGE" });
  return { start, end };
}

// ---------------------------------------------------------------------------
// Backend: Google Drive (REST, scope drive.file — the app only sees files it
// created itself). apiBase/uploadBase are overridable so tests can use a mock.
// ---------------------------------------------------------------------------

export function createDriveBackend({
  db,
  getAccessToken,
  rootFolderId = null,
  apiBase = "https://www.googleapis.com/drive/v3",
  uploadBase = "https://www.googleapis.com/upload/drive/v3",
  chunkSize = 8 * 1024 * 1024, // must be a multiple of 256 KiB
  maxChunkRetries = 3,
}) {
  const folderLocks = new Map();

  async function authedFetch(url, options = {}) {
    const token = await getAccessToken();
    if (!token) throw Object.assign(new Error("Google Drive is not connected. An admin must connect it first."), { code: "DRIVE_NOT_CONNECTED" });
    return fetch(url, { ...options, headers: { ...(options.headers ?? {}), Authorization: `Bearer ${token}` } });
  }

  async function driveError(response, what) {
    let detail = "";
    let body = null;
    try { body = await response.json(); detail = body?.error?.message ?? ""; } catch { /* body not JSON */ }
    const error = new Error(`Google Drive ${what} failed (${response.status})${detail ? `: ${detail}` : ""}`);
    error.status = response.status;
    error.googleMessage = detail;
    error.reason = body?.error?.errors?.[0]?.reason ?? body?.error?.details?.[0]?.reason ?? "";
    error.retryable = response.status >= 500 || response.status === 429;
    return error;
  }

  async function createFolder(name, parentId) {
    const response = await authedFetch(`${apiBase}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", ...(parentId ? { parents: [parentId] } : {}) }),
    });
    if (!response.ok) throw await driveError(response, "creating a folder");
    return (await response.json()).id;
  }

  // Creates (once) the chain of folders, remembering each id in the database.
  // A part is a plain name, or { key, name }: the key is what we remember it
  // by (so a folder can be renamed without losing track of it), the name is
  // what it is called in Drive.
  async function ensureFolders(parts) {
    let parent = rootFolderId;
    let pathKey = "";
    for (const raw of parts) {
      const { key, name: part } = typeof raw === "string" ? { key: raw, name: raw } : raw;
      pathKey = pathKey ? `${pathKey}/${key}` : key;
      const known = await db.query("SELECT folder_id FROM production_drive_folders WHERE path_key = $1", [pathKey]);
      if (known.rowCount > 0) {
        parent = known.rows[0].folder_id;
        continue;
      }
      // One creator at a time per path (this backend runs in one process).
      const pending = folderLocks.get(pathKey) ?? Promise.resolve();
      const next = pending.then(async () => {
        const again = await db.query("SELECT folder_id FROM production_drive_folders WHERE path_key = $1", [pathKey]);
        if (again.rowCount > 0) return again.rows[0].folder_id;
        const id = await createFolder(part, parent);
        await db.query("INSERT INTO production_drive_folders (path_key, folder_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [pathKey, id]);
        return id;
      });
      folderLocks.set(pathKey, next.catch(() => {}));
      parent = await next;
    }
    return parent;
  }

  async function uploadResumable({ folderId, fileName, mime, filePath, size }) {
    const init = await authedFetch(`${uploadBase}/files?uploadType=resumable&fields=id,size,md5Checksum`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mime,
        "X-Upload-Content-Length": String(size),
      },
      body: JSON.stringify({ name: fileName, parents: [folderId] }),
    });
    if (!init.ok) throw await driveError(init, "starting an upload");
    const sessionUrl = init.headers.get("location");
    if (!sessionUrl) throw new Error("Google Drive did not return an upload address.");

    const handle = await fsPromises.open(filePath, "r");
    try {
      let offset = 0;
      while (offset < size) {
        const length = Math.min(chunkSize, size - offset);
        const chunk = Buffer.alloc(length);
        await handle.read(chunk, 0, length, offset);
        let attempt = 0;
        for (;;) {
          let response;
          let lastNetworkError;
          try {
            response = await fetch(sessionUrl, {
              method: "PUT",
              redirect: "manual",
              headers: { "Content-Length": String(length), "Content-Range": `bytes ${offset}-${offset + length - 1}/${size}` },
              body: chunk,
            });
          } catch (networkError) {
            response = null;
            lastNetworkError = networkError;
          }
          if (response && (response.status === 308 || response.ok)) {
            if (response.ok) return await response.json();
            const received = /bytes=0-(\d+)/.exec(response.headers.get("range") ?? "");
            offset = received ? Number(received[1]) + 1 : offset;
            break;
          }
          attempt++;
          const retryable = !response || response.status >= 500 || response.status === 429;
          if (!retryable || attempt > maxChunkRetries) {
            throw response ? await driveError(response, "uploading a file") : new Error(`Google Drive upload failed: ${lastNetworkError.message}`);
          }
          // Ask Drive how much it already has, then carry on from there.
          await new Promise((r) => setTimeout(r, Math.min(2000, 200 * 2 ** attempt)));
          try {
            const status = await fetch(sessionUrl, { method: "PUT", redirect: "manual", headers: { "Content-Length": "0", "Content-Range": `bytes */${size}` } });
            if (status.status === 308) {
              const got = /bytes=0-(\d+)/.exec(status.headers.get("range") ?? "");
              const resumeAt = got ? Number(got[1]) + 1 : 0;
              if (resumeAt !== offset) { offset = resumeAt; break; }
            } else if (status.ok) {
              return await status.json();
            }
          } catch { /* try the same chunk again */ }
        }
      }
    } finally {
      await handle.close();
    }
    throw new Error("Google Drive upload ended without a result.");
  }

  return {
    name: "gdrive",
    async put({ folderParts, fileName, filePath, mime, size, md5 }) {
      let folderId = await ensureFolders(folderParts);
      let result;
      try {
        result = await uploadResumable({ folderId, fileName, mime, filePath, size });
      } catch (error) {
        // A remembered folder that no longer exists (deleted, or another Google
        // account was connected): forget what we remembered and start fresh once.
        if (error.status !== 404) throw error;
        await db.query("DELETE FROM production_drive_folders");
        folderId = await ensureFolders(folderParts);
        result = await uploadResumable({ folderId, fileName, mime, filePath, size });
      }
      if (result.md5Checksum && md5 && result.md5Checksum !== md5) {
        await authedFetch(`${apiBase}/files/${result.id}`, { method: "DELETE" }).catch(() => {});
        throw new Error("Google Drive stored a different file than was sent (checksum mismatch).");
      }
      return { key: result.id };
    },
    async open(key, range) {
      const meta = await authedFetch(`${apiBase}/files/${encodeURIComponent(key)}?fields=size`);
      if (!meta.ok) throw await driveError(meta, "reading a file's details");
      const size = Number((await meta.json()).size);
      const { start, end } = clampRange(range, size);
      const response = await authedFetch(`${apiBase}/files/${encodeURIComponent(key)}?alt=media`, {
        headers: { Range: `bytes=${start}-${end}` },
      });
      if (!response.ok) throw await driveError(response, "downloading a file");
      return { stream: Readable.fromWeb(response.body), size, start, end };
    },
    async remove(key) {
      await authedFetch(`${apiBase}/files/${encodeURIComponent(key)}`, { method: "DELETE" }).catch(() => {});
    },
    // Creates the project folder and every numbered sub-folder up front, so
    // the tidy structure is visible in Drive straight away.
    async ensureProjectTree({ projectKey, projectName, layout }) {
      const root = { key: projectKey, name: projectName };
      await ensureFolders([root]);
      for (const sub of layout) await ensureFolders([root, sub]);
      return { created: true };
    },
    // Renames the project folder in Drive (its contents stay where they are).
    async renameProjectFolder({ projectKey, name }) {
      const row = (await db.query("SELECT folder_id FROM production_drive_folders WHERE path_key = $1", [projectKey])).rows[0];
      if (!row) return { renamed: false };
      const response = await authedFetch(`${apiBase}/files/${encodeURIComponent(row.folder_id)}?fields=id`, {
        method: "PATCH", headers: { "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify({ name }),
      });
      if (response.status === 404) {
        await db.query("DELETE FROM production_drive_folders");
        return { renamed: false };
      }
      if (!response.ok) throw await driveError(response, "renaming a folder");
      return { renamed: true };
    },
    // Where the project folder can be opened in Drive (null until it exists).
    async folderLink(projectKey) {
      const row = (await db.query("SELECT folder_id FROM production_drive_folders WHERE path_key = $1", [projectKey])).rows[0];
      return row ? `https://drive.google.com/drive/folders/${row.folder_id}` : null;
    },
    // Whose Drive this is (null if Google will not say).
    async about() {
      try {
        const response = await authedFetch(`${apiBase}/about?fields=user(displayName,emailAddress)`);
        if (!response.ok) return null;
        return (await response.json()).user ?? null;
      } catch {
        return null;
      }
    },
    // Uploads a tiny file, reads it back and deletes it: proves sign-in, the
    // Drive API switch, permission and storage all work. Never throws.
    async selfTest() {
      const src = path.join(os.tmpdir(), `filmybase-drive-test-${crypto.randomUUID()}.txt`);
      const body = `FilmyBase Drive test ${new Date().toISOString()}`;
      const steps = [];
      try {
        await fsPromises.writeFile(src, body);
        const folderId = await ensureFolders(["_connection-test"]);
        steps.push("folder");
        const result = await uploadResumable({ folderId, fileName: "connection-test.txt", mime: "text/plain", filePath: src, size: Buffer.byteLength(body) });
        steps.push("upload");
        const response = await authedFetch(`${apiBase}/files/${encodeURIComponent(result.id)}?alt=media`);
        if (!response.ok) throw await driveError(response, "reading the test file back");
        if ((await response.text()) !== body) return { ok: false, steps, code: "mismatch", message: "Google stored a different file than was sent." };
        steps.push("download");
        const removed = await authedFetch(`${apiBase}/files/${encodeURIComponent(result.id)}`, { method: "DELETE" });
        if (removed.ok || removed.status === 404) {
          // Leave nothing behind: remove the test folder too (and forget it).
          const gone = await authedFetch(`${apiBase}/files/${encodeURIComponent(folderId)}`, { method: "DELETE" });
          if (gone.ok || gone.status === 404) {
            await db.query("DELETE FROM production_drive_folders WHERE path_key = $1", ["_connection-test"]);
            steps.push("cleanup");
          }
        }
        return { ok: true, steps };
      } catch (error) {
        return { ok: false, steps, ...explainStorageError(error) };
      } finally {
        await fsPromises.unlink(src).catch(() => {});
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The store used by the app
// ---------------------------------------------------------------------------

export function createMediaStore({ db, backend, spoolDir, maxBytes = 2 * 1024 * 1024 * 1024 }) {
  fs.mkdirSync(spoolDir, { recursive: true });

  async function hashFile(filePath) {
    const sha = crypto.createHash("sha256");
    const md5 = crypto.createHash("md5");
    let head = Buffer.alloc(0);
    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .on("data", (d) => {
          sha.update(d);
          md5.update(d);
          if (head.length < 16) head = Buffer.concat([head, d]).subarray(0, 16);
        })
        .on("end", resolve)
        .on("error", reject);
    });
    return { sha256: sha.digest("hex"), md5: md5.digest("hex"), head };
  }

  // The name this project's folder should have right now: the project title,
  // or "Title (7)" when another project already uses that exact name.
  async function desiredFolderName(projectId, title) {
    const base = safeFolderName(title, `Project ${projectId}`);
    const clash = await db.query(
      "SELECT 1 FROM production_project_folders WHERE project_id <> $1 AND lower(folder_name) = lower($2) LIMIT 1", [projectId, base]
    );
    return clash.rowCount > 0 ? `${base} (${projectId})` : base;
  }

  // Makes sure the project has a recorded folder name, and renames the folder
  // in storage when the project was renamed. Returns the name to use.
  async function syncProjectFolder(projectId) {
    const project = (await db.query("SELECT title FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0];
    const desired = await desiredFolderName(projectId, project?.title);
    const recorded = (await db.query("SELECT folder_name FROM production_project_folders WHERE project_id = $1", [projectId])).rows[0];
    if (!recorded) {
      await db.query("INSERT INTO production_project_folders (project_id, folder_name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [projectId, desired]);
      return (await db.query("SELECT folder_name FROM production_project_folders WHERE project_id = $1", [projectId])).rows[0].folder_name;
    }
    if (recorded.folder_name === desired || !backend.renameProjectFolder) return recorded.folder_name;
    try {
      const result = await backend.renameProjectFolder({ projectKey: `p${projectId}`, name: desired });
      if (result.renamed === false) {
        // Nothing to rename yet (folder not created): just remember the new name.
      }
      await db.query("UPDATE production_project_folders SET folder_name = $1, updated_at = now() WHERE project_id = $2", [desired, projectId]);
      return desired;
    } catch {
      return recorded.folder_name; // could not rename right now; keep the old name, try again next time
    }
  }

  async function foldersFor(row) {
    const name = await syncProjectFolder(row.project_id);
    const project = backend.name === "gdrive" ? { key: `p${row.project_id}`, name } : { key: name, name };
    const parts = [project, ROLE_FOLDERS[row.role] ?? "99 Other"];
    if (row.subfolder) parts.push(row.subfolder);
    return parts;
  }

  // Sends one stored-by-spool row to the backend. Throws on failure.
  async function sendToBackend(row) {
    const folderParts = await foldersFor(row);
    const md5 = (await hashFile(row.spool_path)).md5;
    const { key } = await backend.put({
      folderParts, fileName: row.stored_name, filePath: row.spool_path, mime: row.mime, size: Number(row.bytes), md5,
    });
    await db.query(
      "UPDATE production_media_files SET status = 'stored', storage_key = $1, backend = $2, last_error = NULL, spool_path = NULL WHERE id = $3",
      [key, backend.name, row.id]
    );
    await fsPromises.unlink(row.spool_path).catch(() => {});
  }

  return {
    backendName: backend.name,

    // Stores a file that is already on disk (uploads and provider downloads
    // are both written to a temp file first, so big videos never sit in
    // memory). Returns the media row. Same content in the same project is
    // stored once.
    async putMedia({ projectId, role, filePath, originalName, label = "file", subfolder = null, createdBy = null, dimensions = {} }) {
      const ext = path.extname(originalName ?? "").toLowerCase();
      const mime = EXT_MIME[ext];
      if (!mime) throw Object.assign(new Error(`Files of type "${ext || "unknown"}" are not allowed.`), { status: 400 });
      const { size } = await fsPromises.stat(filePath);
      if (size === 0) throw Object.assign(new Error("The file is empty."), { status: 400 });
      if (size > maxBytes) throw Object.assign(new Error("The file is too large."), { status: 413 });
      const { sha256, head } = await hashFile(filePath);
      if (!magicMatches(mime, head)) throw Object.assign(new Error(`The file does not look like a real ${ext} file.`), { status: 400 });

      const existing = await db.query("SELECT * FROM production_media_files WHERE project_id = $1 AND sha256 = $2", [projectId, sha256]);
      if (existing.rowCount > 0) return { ...existing.rows[0], deduplicated: true };

      const storedName = `${safeName(label)}_${sha256.slice(0, 8)}${ext}`;
      const spoolPath = path.join(spoolDir, `${sha256}${ext}`);
      await fsPromises.copyFile(filePath, spoolPath);

      let inserted;
      try {
        inserted = await db.query(
          `INSERT INTO production_media_files (project_id, role, backend, stored_name, original_name, mime, bytes, sha256, status, spool_path, created_by, width, height, duration_ms, subfolder)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_upload',$9,$10,$11,$12,$13,$14) RETURNING *`,
          [projectId, role, backend.name, storedName, originalName ?? null, mime, size, sha256, spoolPath, createdBy,
            dimensions.width ?? null, dimensions.height ?? null, dimensions.durationMs ?? null, subfolder ? safeFolderName(subfolder) : null]
        );
      } catch (error) {
        if (error.code === "23505") { // a concurrent identical upload won
          const winner = await db.query("SELECT * FROM production_media_files WHERE project_id = $1 AND sha256 = $2", [projectId, sha256]);
          return { ...winner.rows[0], deduplicated: true };
        }
        throw error;
      }
      const row = inserted.rows[0];
      try {
        await sendToBackend(row);
      } catch (error) {
        // Not lost: stays in the spool, marked pending, retried later.
        await db.query("UPDATE production_media_files SET attempts = attempts + 1, last_error = $1 WHERE id = $2", [error.message.slice(0, 500), row.id]);
      }
      return (await db.query("SELECT * FROM production_media_files WHERE id = $1", [row.id])).rows[0];
    },

    // Retries uploads that failed earlier (Drive was down / not connected).
    async flushPendingUploads({ maxAttempts = 8 } = {}) {
      const rows = (await db.query(
        "SELECT * FROM production_media_files WHERE status = 'pending_upload' AND attempts < $1 ORDER BY id", [maxAttempts]
      )).rows;
      let stored = 0;
      for (const row of rows) {
        try {
          if (!row.spool_path || !fs.existsSync(row.spool_path)) throw new Error("The temporary copy is gone (the server restarted before the upload finished).");
          await sendToBackend(row);
          stored++;
        } catch (error) {
          await db.query(
            "UPDATE production_media_files SET attempts = attempts + 1, last_error = $1, status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE status END WHERE id = $3",
            [error.message.slice(0, 500), maxAttempts, row.id]
          );
        }
      }
      return { tried: rows.length, stored };
    },

    // Creates the project's folder (named after the project) and all the
    // numbered sub-folders in storage, right now. Safe to repeat.
    async prepareProject(projectId) {
      const name = await syncProjectFolder(projectId);
      if (backend.ensureProjectTree) {
        await backend.ensureProjectTree({ projectKey: `p${projectId}`, projectName: name, layout: PROJECT_FOLDER_LAYOUT });
      }
      return this.projectFolderInfo(projectId);
    },

    async projectFolderInfo(projectId) {
      const project = (await db.query("SELECT title FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0];
      if (!project) return null;
      const name = await syncProjectFolder(projectId);
      return {
        folderName: name,
        link: backend.folderLink ? await backend.folderLink(`p${projectId}`) : null,
        layout: PROJECT_FOLDER_LAYOUT,
        backend: backend.name,
      };
    },

    // For serving to the browser. Caller checks login / project first.
    async openMedia(mediaId, range) {
      const row = (await db.query("SELECT * FROM production_media_files WHERE id = $1", [mediaId])).rows[0];
      if (!row) return null;
      if (row.status !== 'stored') {
        // Still only in the spool: serve from there so it is viewable at once.
        if (row.spool_path && fs.existsSync(row.spool_path)) {
          const local = createLocalBackend({ root: path.dirname(row.spool_path) });
          return { row, ...(await local.open(path.basename(row.spool_path), range)) };
        }
        return { row, unavailable: true };
      }
      return { row, ...(await backend.open(row.storage_key, range)) };
    },
  };
}

// Picks the backend from configuration. On Render the disk is wiped on every
// deploy, so Drive is the default there.
export function backendNameFromEnv(env = process.env) {
  if (env.MEDIA_BACKEND === "local" || env.MEDIA_BACKEND === "gdrive") return env.MEDIA_BACKEND;
  return env.RENDER ? "gdrive" : "local";
}
