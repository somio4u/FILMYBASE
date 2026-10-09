// A stand-in for Google Drive's REST API, for tests only. Implements just
// what mediaStore.js uses: create folder, resumable upload (with status
// query), metadata, ranged download, delete — plus switches to make it fail.
import http from "node:http";
import crypto from "node:crypto";

export function startMockDrive({ token = "test-token" } = {}) {
  const files = new Map(); // id -> { name, parents, data: Buffer, isFolder }
  const sessions = new Map(); // id -> { name, parents, size, chunks: Buffer[], received }
  const state = { down: false, failChunkOnce: 0, uploads: 0, foldersCreated: 0, calls: [], forceError: null, tokenFails: false, revoked: [], tokenCalls: [] };
  let n = 0;
  let base = "";

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    state.calls.push(`${req.method} ${url.pathname}`);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body));
    };
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (state.down) return send(503, { error: { message: "mock outage" } });

      // ---- imitation of Google's sign-in endpoints (no bearer token needed) ----
      if (req.method === "POST" && url.pathname === "/token") {
        const form = new URLSearchParams(body.toString());
        state.tokenCalls.push(form.get("grant_type"));
        if (state.tokenFails) return send(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        if (form.get("grant_type") === "authorization_code") {
          if (form.get("code") !== "good-code") return send(400, { error: "invalid_grant", error_description: "Bad code." });
          return send(200, { access_token: token, expires_in: 3600, refresh_token: "refresh-1" });
        }
        return send(200, { access_token: token, expires_in: 3600 });
      }
      if (req.method === "POST" && url.pathname === "/revoke") {
        state.revoked.push(url.searchParams.get("token"));
        return send(200, {});
      }
      // Real Drive: the resumable-session address is pre-authorised (no token needed).
      const isSession = url.pathname.startsWith("/upload/session/");
      if (!isSession && req.headers.authorization !== `Bearer ${token}`) return send(401, { error: { message: "bad token" } });

      if (state.forceError) return send(state.forceError.status, state.forceError.body);
      if (req.method === "GET" && url.pathname === "/drive/v3/about") return send(200, { user: { displayName: "Test Person", emailAddress: "test@example.com" } });

      if (req.method === "POST" && url.pathname === "/drive/v3/files") {
        const meta = JSON.parse(body.toString());
        // like Google: a parent that does not exist is a 404
        if ((meta.parents ?? []).some((parent) => !files.get(parent)?.isFolder)) return send(404, { error: { code: 404, message: `File not found: ${meta.parents[0]}.`, errors: [{ reason: "notFound" }] } });
        const id = `folder${++n}`;
        files.set(id, { name: meta.name, parents: meta.parents, isFolder: true });
        state.foldersCreated++;
        return send(200, { id });
      }
      if (req.method === "POST" && url.pathname === "/upload/drive/v3/files") {
        const meta = JSON.parse(body.toString());
        if ((meta.parents ?? []).some((parent) => !files.get(parent)?.isFolder)) return send(404, { error: { code: 404, message: `File not found: ${meta.parents[0]}.`, errors: [{ reason: "notFound" }] } });
        const id = `file${++n}`;
        sessions.set(id, { name: meta.name, parents: meta.parents, size: Number(req.headers["x-upload-content-length"]), data: Buffer.alloc(0) });
        return send(200, "{}", { Location: `${base}/upload/session/${id}` });
      }
      const sess = /^\/upload\/session\/(.+)$/.exec(url.pathname);
      if (req.method === "PUT" && sess) {
        const s = sessions.get(sess[1]);
        if (!s) return send(404, { error: { message: "no session" } });
        const range = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(req.headers["content-range"] ?? "");
        if (!range) return send(400, { error: { message: "bad range" } });
        if (range[1] === undefined) { // status query
          return s.data.length === 0 ? send(308, undefined) : send(308, undefined, { Range: `bytes=0-${s.data.length - 1}` });
        }
        if (state.failChunkOnce > 0 && s.data.length > 0) { state.failChunkOnce--; return send(500, { error: { message: "mock hiccup" } }); }
        if (Number(range[1]) !== s.data.length) return send(400, { error: { message: "gap" } });
        s.data = Buffer.concat([s.data, body]);
        if (s.data.length === s.size) {
          files.set(sess[1], { name: s.name, parents: s.parents, data: s.data });
          state.uploads++;
          return send(200, { id: sess[1], size: String(s.size), md5Checksum: crypto.createHash("md5").update(s.data).digest("hex") });
        }
        return send(308, undefined, { Range: `bytes=0-${s.data.length - 1}` });
      }
      const file = /^\/drive\/v3\/files\/(.+)$/.exec(url.pathname);
      if (file) {
        const f = files.get(decodeURIComponent(file[1]));
        if (!f) return send(404, { error: { message: "not found" } });
        if (req.method === "DELETE") { files.delete(decodeURIComponent(file[1])); return send(204); }
        if (url.searchParams.get("alt") === "media") {
          const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
          const slice = m ? f.data.subarray(Number(m[1]), Number(m[2]) + 1) : f.data;
          return send(m ? 206 : 200, slice, { "Content-Type": "application/octet-stream" });
        }
        return send(200, { size: String(f.data?.length ?? 0) });
      }
      return send(404, { error: { message: `unhandled ${req.method} ${url.pathname}` } });
    });
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        apiBase: `${base}/drive/v3`, uploadBase: `${base}/upload/drive/v3`, tokenUrl: `${base}/token`, revokeUrl: `${base}/revoke`, files, state, token,
        close: () => new Promise((r) => server.close(r)),
      });
    })
  );
}
