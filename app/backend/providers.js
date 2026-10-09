// The AI "tool makers": one small function each for pictures, voices and video.
// They talk to Google's Gemini (pictures: "Nano Banana", voices: Gemini speech,
// video: Veo) with the same key the app already uses. Everything the outside
// world answers is checked, and every failure is turned into a plain sentence.
//
// The web addresses and model names can be changed with settings so tests can
// point them at a local imitation (tests/mockGemini.mjs).

const GOOGLE_API = "https://generativelanguage.googleapis.com";

function fail(message, status = 502, code = "provider_error") {
  return Object.assign(new Error(message), { status, code });
}

function explainHttp(status, body, what) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  if (status === 400 && /API key|API_KEY/i.test(text)) return `${what}: the Gemini API key was refused. Check GEMINI_API_KEY on the server.`;
  if (status === 401 || status === 403) return `${what}: Google refused this request (${status}). The key may not have access to this model yet, or billing is off.`;
  if (status === 404) return `${what}: Google does not know this model name. It may have been renamed — the model name can be changed in the server settings.`;
  if (status === 429) return `${what}: Google says the usage limit was reached. Wait a little and try again.`;
  if (/SAFETY|blocked|PROHIBITED/i.test(text)) return `${what}: Google's safety check blocked this prompt. Try describing it differently.`;
  return `${what} failed (HTTP ${status}). ${text.slice(0, 200)}`;
}

// Wraps raw 16-bit mono PCM (what Gemini speech returns) into a real .wav file.
export function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function wavDurationMs(wav) {
  if (wav.length < 44) return null;
  const rate = wav.readUInt32LE(24);
  const bytesPerSecond = wav.readUInt32LE(28) || rate * 2;
  return Math.round(((wav.length - 44) / bytesPerSecond) * 1000);
}

export function createProviders({ env = process.env, fetchImpl = fetch, getVertexToken = null, vertex = null, textJson = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const apiBase = env.GEMINI_API_BASE || GOOGLE_API;
  const key = env.GEMINI_API_KEY || "";
  const models = {
    image: env.IMAGE_MODEL || "gemini-2.5-flash-image",
    speech: env.SPEECH_MODEL || "gemini-2.5-flash-preview-tts",
    video: env.VIDEO_MODEL || "veo-3.1-fast-generate-preview",
  };
  const useVertex = Boolean(vertex && getVertexToken && !key);

  function needAccess(what) {
    if (!key && !useVertex) throw fail(`${what} needs the Gemini key (GEMINI_API_KEY) on the server, and it is not set.`, 503, "not_configured");
  }

  async function call(what, url, { method = "POST", body, headers = {} } = {}) {
    let response;
    try {
      const auth = useVertex ? { Authorization: `Bearer ${await getVertexToken()}` } : { "x-goog-api-key": key };
      response = await fetchImpl(url, { method, headers: { "Content-Type": "application/json", ...auth, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) {
      throw fail(`${what}: could not reach Google (${error.message}).`, 502, "unreachable");
    }
    const raw = await response.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
    if (!response.ok) throw fail(explainHttp(response.status, json ?? raw, what), response.status === 429 ? 429 : 502, response.status === 429 ? "rate_limited" : "provider_error");
    return json;
  }

  function modelUrl(model, action) {
    if (useVertex) return `https://${vertex.location}-aiplatform.googleapis.com/v1/projects/${vertex.project}/locations/${vertex.location}/publishers/google/models/${model}:${action}`;
    return `${apiBase}/v1beta/models/${model}:${action}`;
  }

  const partsOf = (json) => json?.candidates?.[0]?.content?.parts ?? [];
  const inline = (part) => part.inlineData ?? part.inline_data ?? null;

  return {
    models,
    textJson,

    // A picture from words, optionally guided by reference pictures (so the same
    // face / prop / place stays the same). Returns { bytes, mime, ext }.
    async generateImage({ prompt, references = [], aspectRatio = "16:9" }) {
      needAccess("Picture generation");
      const parts = [{ text: prompt }];
      for (const ref of references.slice(0, 4)) parts.push({ inlineData: { mimeType: ref.mime, data: ref.bytes.toString("base64") } });
      const json = await call("Picture generation", modelUrl(models.image, "generateContent"), {
        body: { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio } } },
      });
      const image = partsOf(json).map(inline).find((p) => p?.data && /^image\//.test(p.mimeType ?? p.mime_type ?? ""));
      if (!image) {
        const reason = json?.candidates?.[0]?.finishReason || json?.promptFeedback?.blockReason || "no picture came back";
        throw fail(`Picture generation: Google returned no picture (${reason}). Try rewording the description.`, 502, "no_output");
      }
      const mime = image.mimeType ?? image.mime_type;
      return { bytes: Buffer.from(image.data, "base64"), mime, ext: mime === "image/jpeg" ? ".jpg" : mime === "image/webp" ? ".webp" : ".png" };
    },

    // Speech from text in one voice. Returns { bytes (a .wav file), ext, durationMs }.
    async generateSpeech({ text, voice = "Kore" }) {
      needAccess("Voice generation");
      const json = await call("Voice generation", modelUrl(models.speech, "generateContent"), {
        body: {
          contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
        },
      });
      const audio = partsOf(json).map(inline).find((p) => p?.data);
      if (!audio) throw fail("Voice generation: Google returned no audio. Try again.", 502, "no_output");
      const pcm = Buffer.from(audio.data, "base64");
      const rate = Number(/rate=(\d+)/.exec(audio.mimeType ?? audio.mime_type ?? "")?.[1] ?? 24000);
      const wav = pcmToWav(pcm, rate);
      return { bytes: wav, ext: ".wav", durationMs: wavDurationMs(wav) };
    },

    // A short video clip that starts from a picture. This takes minutes: it
    // starts the job, then checks back until it is done.
    async generateVideo({ prompt, image = null, durationSec = 6, aspectRatio = "16:9", pollMs = 10000, maxWaitMs = 12 * 60 * 1000 }) {
      needAccess("Video generation");
      const instance = { prompt };
      if (image) instance.image = useVertex ? { bytesBase64Encoded: image.bytes.toString("base64"), mimeType: image.mime } : { bytesBase64Encoded: image.bytes.toString("base64"), mimeType: image.mime };
      const started = await call("Video generation", modelUrl(models.video, "predictLongRunning"), {
        body: { instances: [instance], parameters: { aspectRatio, durationSeconds: durationSec, ...(useVertex ? { sampleCount: 1 } : {}) } },
      });
      const operation = started?.name;
      if (!operation) throw fail("Video generation: Google did not start the job.", 502, "no_output");
      const deadline = Date.now() + maxWaitMs;
      for (;;) {
        let state;
        if (useVertex) {
          state = await call("Video generation", modelUrl(models.video, "fetchPredictOperation"), { body: { operationName: operation } });
        } else {
          state = await call("Video generation", `${apiBase}/v1beta/${operation}`, { method: "GET" });
        }
        if (state?.done) {
          if (state.error) throw fail(`Video generation failed: ${state.error.message ?? "unknown reason"}.`, 502, "provider_error");
          const response = state.response ?? {};
          const sample = response.generateVideoResponse?.generatedSamples?.[0]?.video ?? response.videos?.[0] ?? response.generatedVideos?.[0]?.video ?? null;
          if (!sample) {
            const filtered = response.generateVideoResponse?.raiMediaFilteredReasons?.[0] ?? response.raiMediaFilteredReasons?.[0];
            throw fail(`Video generation: Google returned no video${filtered ? ` (${filtered})` : ""}. Try different wording.`, 502, "no_output");
          }
          if (sample.bytesBase64Encoded) return { bytes: Buffer.from(sample.bytesBase64Encoded, "base64"), ext: ".mp4" };
          const uri = sample.uri;
          if (!uri) throw fail("Video generation: Google returned no video file.", 502, "no_output");
          let download;
          try {
            download = await fetchImpl(uri, { headers: useVertex ? { Authorization: `Bearer ${await getVertexToken()}` } : { "x-goog-api-key": key } });
          } catch (error) {
            throw fail(`Video download: could not reach Google (${error.message}).`, 502, "unreachable");
          }
          if (!download.ok) throw fail(explainHttp(download.status, "", "Video download"), 502);
          return { bytes: Buffer.from(await download.arrayBuffer()), ext: ".mp4" };
        }
        if (Date.now() > deadline) throw fail("Video generation took too long and was stopped. Nothing was charged by the app; try again.", 504, "timeout");
        await sleep(pollMs);
      }
    },
  };
}
