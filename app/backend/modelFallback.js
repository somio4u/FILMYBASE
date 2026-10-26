// Google switches old Gemini models off for NEW API keys ("This model models/gemini-2.5-flash-lite is no longer available to new users").
// The app's code names the 2.5 models in many places, so instead of editing each one, an API-key client is wrapped here: when Google says a
// model is gone, the same call is repeated once with its newer replacement, and the replacement is remembered for the next calls.
// Only used for plain API keys — a Vertex key is left exactly as it was.

export const MODEL_REPLACEMENTS = {
  "gemini-2.5-flash-lite": "gemini-3.5-flash-lite", // named by Google's own error message
  "gemini-2.5-flash": "gemini-3.5-flash",
  "gemini-2.5-pro": "gemini-3.1-pro-preview",
};

export const isModelRetiredError = (error) => /no longer available|not found for API version|is not found|NOT_FOUND/i.test(String(error?.message ?? error ?? "")) && /models?\//i.test(String(error?.message ?? ""));

export function withModelFallback(client, { replacements = MODEL_REPLACEMENTS, onSwitch = () => {} } = {}) {
  const remembered = new Map(); // old model -> replacement that worked
  const models = client.models;
  for (const method of ["generateContent", "generateContentStream"]) {
    const original = models[method]?.bind(models);
    if (!original) continue;
    models[method] = async (params, ...rest) => {
      const first = remembered.get(params?.model) ?? params?.model;
      try {
        return await original({ ...params, model: first }, ...rest);
      } catch (error) {
        const next = replacements[first];
        if (!next || !isModelRetiredError(error)) throw error;
        remembered.set(params.model, next);
        onSwitch(first, next);
        return original({ ...params, model: next }, ...rest);
      }
    };
  }
  return client;
}
