// "429 Too Many Requests / RESOURCE_EXHAUSTED" from Google: the shared capacity of ONE model is used up for a moment. Waiting a bit (the app already does) often
// works, but when it does not, another model of the same family usually still has room — so after the waiting is over, the call is tried once on the next model.
// (The old gemini-2.5-* models are retired — only the current ones are listed.) Switch it off with MODEL_429_FALLBACK=off.

const CHAIN = ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"];

export const isQuotaError = (message) => /RESOURCE_EXHAUSTED|"code":\s*429|\b429\b.*Too Many Requests/i.test(String(message ?? ""));

// the models to try after `model` has run out of room, best match first (a Pro call falls to Flash before Flash-Lite; Flash-Lite to Flash before Pro)
export function fallbackModelsFor(model) {
  if (String(process.env.MODEL_429_FALLBACK ?? "").toLowerCase() === "off") return [];
  const m = String(model ?? "");
  const order = /pro/i.test(m) ? ["gemini-3.5-flash", "gemini-3.5-flash-lite"] : /lite/i.test(m) ? ["gemini-3.5-flash", "gemini-3.1-pro-preview"] : ["gemini-3.5-flash-lite", "gemini-3.1-pro-preview"];
  return order.filter((x) => x !== m && CHAIN.includes(x));
}

// the same wait with a little random spread, so many parallel calls do not all come back at the same second
export const jitter = (ms, random = Math.random) => Math.round(ms * (0.8 + random() * 0.4));
