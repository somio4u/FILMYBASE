// The Story Brain — the app's "writers' room". It designs the whole story
// (the Story Bible) before anything is written; see STORY_BRAIN_DESIGN.md.
//
// This file starts with the Brain's own access to the strongest Gemini model.
// The rest of the app still uses the @google/genai library (version 0.3),
// which can't reach Google's "global" endpoint where Gemini 3.1 Pro lives, so
// the Brain calls the Gemini REST API directly instead of upgrading that
// library under 17,000 lines of working code.

import { GoogleAuth } from "google-auth-library";

// Best model first. Checked on the project on 2026-10-07: gemini-3.1-pro-preview
// works on the "global" endpoint; gemini-2.5-pro is the fallback if the
// preview is unavailable or overloaded.
export const STORY_BRAIN_MODELS = [
  { model: "gemini-3.1-pro-preview", location: "global" },
  { model: "gemini-2.5-pro", location: "us-central1" },
];

// A Pro model thinks before it answers; a big design request can take minutes.
const BRAIN_CALL_TIMEOUT_MS = 10 * 60 * 1000;
const BRAIN_MAX_OUTPUT_TOKENS = 65536;
const RETRIES_PER_MODEL = 3;

const serviceAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  : null;
let googleAuth = null;

async function accessToken() {
  googleAuth ??= new GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await googleAuth.getClient();
  return (await client.getAccessToken()).token;
}

// Vertex AI (the service account) when it's set up, like the rest of the
// app; otherwise the AI Studio key.
async function endpointFor(model, location) {
  if (!serviceAccount) {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
    };
  }
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return {
    url: `https://${host}/v1/projects/${serviceAccount.project_id}/locations/${location}/publishers/google/models/${model}:generateContent`,
    headers: { Authorization: `Bearer ${await accessToken()}` },
  };
}

class BrainCallError extends Error {
  constructor(message, { status, retryable }) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

async function callModelOnce({ model, location }, { systemInstruction, contents, responseSchema, maxOutputTokens }) {
  const { url, headers } = await endpointFor(model, location);
  const body = {
    contents: [{ role: "user", parts: [{ text: contents }] }],
    generationConfig: {
      maxOutputTokens,
      responseMimeType: "application/json",
      ...(responseSchema ? { responseSchema } : {}),
    },
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BRAIN_CALL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new BrainCallError(`${model}: ${error.message}`, { status: 0, retryable: true });
  }

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = `${model}: ${response.status} ${json.error?.message ?? response.statusText}`.slice(0, 300);
    // 429 busy, 500/503 server trouble: try again. 404 (model not on this
    // project) or 400/403: no point retrying this model.
    throw new BrainCallError(message, { status: response.status, retryable: [429, 500, 502, 503, 504].includes(response.status) });
  }

  const candidate = json.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("");
  return { text, finishReason: candidate?.finishReason, usage: json.usageMetadata ?? {}, modelVersion: json.modelVersion ?? model };
}

// One JSON answer from the best available model. Returns
// { data, model, usage } — usage is the token count, so a run's cost can be
// shown. Tries each model in STORY_BRAIN_MODELS in turn.
export async function generateBrainJson({ systemInstruction, contents, responseSchema, maxOutputTokens = BRAIN_MAX_OUTPUT_TOKENS, label = "Story Brain" }) {
  let lastError;
  for (const target of STORY_BRAIN_MODELS) {
    for (let attempt = 0; attempt < RETRIES_PER_MODEL; attempt++) {
      try {
        const result = await callModelOnce(target, { systemInstruction, contents, responseSchema, maxOutputTokens });
        if (result.finishReason === "MAX_TOKENS") {
          throw new BrainCallError(`${target.model}: answer was cut off (MAX_TOKENS)`, { status: 0, retryable: true });
        }
        const data = JSON.parse(result.text);
        console.log(
          `${label}: ${result.modelVersion} — ${result.usage.promptTokenCount ?? 0} in, ${result.usage.candidatesTokenCount ?? 0} out, ${result.usage.thoughtsTokenCount ?? 0} thinking tokens`
        );
        return { data, model: result.modelVersion, usage: result.usage };
      } catch (error) {
        lastError = error;
        // A bad JSON answer is worth one more try; so is a busy server.
        const retryable = error instanceof SyntaxError || error.retryable;
        console.error(`${label}: ${error.message.slice(0, 200)}${retryable ? " — retrying" : " — trying the next model"}`);
        if (!retryable) break;
        await new Promise((resolve) => setTimeout(resolve, 3000 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}
