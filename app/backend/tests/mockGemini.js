// A LOCAL IMITATION of Google's picture / voice / video service, for tests only.
// It proves the app's own logic (what it sends, how it reads answers, how it
// handles failures) — NOT that the real Google service accepts the same
// requests. FIXTURE ONLY.
import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function crc(buf) { return zlib.crc32(buf) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
}
// A real, valid, solid-colour PNG whose colour comes from the text.
export function solidPng(seed, w = 64, h = 36) {
  const hash = crypto.createHash("sha256").update(String(seed)).digest();
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [hash[0], hash[1], hash[2]]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function sinePcm(seconds, hz = 220, rate = 24000) {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), i * 2);
  return buf;
}

let mp4Dir;
export function makeMp4(seed, seconds = 2) {
  mp4Dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "mock-mp4-"));
  const hash = crypto.createHash("sha256").update(String(seed)).digest("hex");
  const out = path.join(mp4Dir, `${hash.slice(0, 12)}.mp4`);
  if (!fs.existsSync(out)) {
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=0x${hash.slice(0, 6)}:s=320x180:d=${seconds}:r=24`, "-f", "lavfi", "-i", `sine=f=440:d=${seconds}`, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out]);
    if (r.status !== 0) throw new Error("ffmpeg is needed for the video tests: " + r.stderr);
  }
  return fs.readFileSync(out);
}

export async function startMockGemini({ port = 0 } = {}) {
  const state = { requests: [], failNext: null, ops: new Map(), opCounter: 0, videoPollsBeforeDone: 1 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, "http://x");
    state.requests.push({ method: req.method, path: url.pathname, body, key: req.headers["x-goog-api-key"] ?? null });
    const json = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers["x-goog-api-key"] !== "test-key") return json(400, { error: { message: "API key not valid", status: "INVALID_ARGUMENT" } });
    if (state.failNext) { const f = state.failNext; state.failNext = null; return json(f.status, f.body ?? { error: { message: "failure" } }); }

    let m = /^\/v1beta\/models\/([^:]+):generateContent$/.exec(url.pathname);
    if (m && req.method === "POST") {
      const modalities = body?.generationConfig?.responseModalities ?? [];
      const text = body.contents?.[0]?.parts?.find((p) => p.text)?.text ?? "";
      if (modalities.includes("IMAGE")) {
        if (/FORBIDDEN/.test(text)) return json(200, { candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "no" }] } }] });
        const refs = body.contents[0].parts.filter((p) => p.inlineData).map((p) => p.inlineData.data);
        return json(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: solidPng(text + refs.join("")).toString("base64") } }] } }] });
      }
      if (modalities.includes("AUDIO")) {
        const seconds = Math.max(0.5, Math.min(3, text.length / 40));
        return json(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: sinePcm(seconds, 200 + text.length).toString("base64") } }] } }] });
      }
      return json(200, { candidates: [{ content: { parts: [{ text: "{}" }] } }] });
    }
    m = /^\/v1beta\/models\/([^:]+):predictLongRunning$/.exec(url.pathname);
    if (m && req.method === "POST") {
      const name = `operations/op${++state.opCounter}`;
      state.ops.set(name, { polls: 0, prompt: body.instances[0].prompt, hadImage: Boolean(body.instances[0].image), seconds: body.parameters?.durationSeconds });
      return json(200, { name });
    }
    m = /^\/v1beta\/(operations\/op\d+)$/.exec(url.pathname);
    if (m && req.method === "GET") {
      const op = state.ops.get(m[1]);
      if (!op) return json(404, { error: { message: "no such operation" } });
      if (++op.polls <= state.videoPollsBeforeDone) return json(200, { name: m[1], done: false });
      if (/FORBIDDEN/.test(op.prompt)) return json(200, { name: m[1], done: true, response: { generateVideoResponse: { raiMediaFilteredReasons: ["blocked by policy"] } } });
      return json(200, { name: m[1], done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `http://127.0.0.1:${server.address().port}/files/${m[1].split("/")[1]}.mp4` } }] } } });
    }
    m = /^\/files\/(op\d+)\.mp4$/.exec(url.pathname);
    if (m) {
      const bytes = makeMp4(m[1] + (state.ops.get(`operations/${m[1]}`)?.prompt ?? ""));
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
      return res.end(bytes);
    }
    json(404, { error: { message: "not found: " + url.pathname } });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    state, port: server.address().port, base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
