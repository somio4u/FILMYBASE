// Settings → AI connection (admin only): see which Google key the app is using, test a new one, save it, or go back to the server's own.
// Two kinds of key: "vertex" (a service-account JSON file from Google Cloud) and "apikey" (a plain Google AI Studio API key, AIza…).
import { cleanLocation, describeAiError, detectKind, parseApiKey, parseServiceAccount, safeDetails } from "./aiCredentials.js";

export function registerAiSettingsRoutes(app, db, { requireRole, aiCredentials, testCandidate }) {
  const admin = requireRole("admin");

  // what was sent -> { ok, kind, ... } or { ok: false, error }. The kind is the one chosen on the screen; if the text is clearly the other kind it is
  // refused with a pointer, never guessed silently.
  function readKey(body) {
    const kind = body?.kind === "apikey" || body?.kind === "vertex" ? body.kind : detectKind(body?.key) ?? "vertex";
    const looks = detectKind(body?.key);
    if (looks && looks !== kind) {
      return { ok: false, error: kind === "vertex"
        ? "This looks like an API key (AIza…), but “Vertex (JSON file)” is selected. Choose “Google API key” above."
        : "This looks like a JSON key file, but “Google API key” is selected. Choose “Vertex (JSON file)” above." };
    }
    if (kind === "apikey") {
      const parsed = parseApiKey(body?.key);
      return parsed.ok ? { ok: true, kind, apiKey: parsed.apiKey, keyHint: parsed.hint } : parsed;
    }
    const parsed = parseServiceAccount(body?.key);
    return parsed.ok ? { ok: true, kind, serviceAccount: parsed.serviceAccount, projectId: parsed.projectId, clientEmail: parsed.clientEmail } : parsed;
  }

  // a real, tiny AI call with the candidate key (nothing is saved): tells plainly whether it will work, and at which step it stops
  // vertex steps: 1 the file was read · 2 Google accepts the key (sign-in) · 3 Vertex AI answers · 4 the Pro model (warning only)
  // apikey steps: 1 the key was read · 2 Google answers with it · 3 the Pro model (warning only)
  async function runTest(key, location) {
    const started = Date.now();
    const base = key.kind === "apikey" ? { kind: "apikey", keyHint: key.keyHint } : { kind: "vertex", projectId: key.projectId, clientEmail: key.clientEmail, location };
    const steps = [{ key: "format", ok: true, note: key.kind === "apikey" ? `API key ${key.keyHint}` : `project ${key.projectId}, service account ${key.clientEmail}` }];
    try {
      const info = await testCandidate(key.kind === "apikey" ? { kind: "apikey", apiKey: key.apiKey } : { kind: "vertex", serviceAccount: key.serviceAccount }, location, (step, note, opts) => steps.push({ key: step, ok: !opts?.warn, warn: Boolean(opts?.warn), note }));
      return { ok: true, ...base, model: info?.model ?? null, steps, warnings: steps.filter((s) => s.warn).map((s) => s.note), seconds: Math.round((Date.now() - started) / 100) / 10 };
    } catch (error) {
      const step = error?.step ?? "vertex";
      steps.push({ key: step, ok: false });
      console.error(`AI key test (${key.kind}) failed at "${step}":`, safeDetails(error));
      return { ok: false, ...base, step, steps, message: describeAiError(error, step), details: safeDetails(error), seconds: Math.round((Date.now() - started) / 100) / 10 };
    }
  }

  app.get("/api/settings/ai", admin, async (req, res) => {
    res.json(await aiCredentials.publicStatus());
  });

  app.post("/api/settings/ai/test", admin, async (req, res) => {
    const key = readKey(req.body);
    if (!key.ok) { res.status(400).json({ error: key.error }); return; }
    res.json(await runTest(key, cleanLocation(req.body?.location)));
  });

  // saving tests the key again first (so a key that does not work can never replace one that does), unless the admin insists
  app.put("/api/settings/ai", admin, async (req, res) => {
    const key = readKey(req.body);
    if (!key.ok) { res.status(400).json({ error: key.error }); return; }
    const location = cleanLocation(req.body?.location);
    if (req.body?.saveAnyway !== true) {
      const test = await runTest(key, location);
      if (!test.ok) { res.status(422).json({ error: test.message, test }); return; }
    }
    await aiCredentials.save({ kind: key.kind, serviceAccount: key.serviceAccount, apiKey: key.apiKey, location, userName: req.user?.name ?? req.user?.username ?? null });
    console.log(`AI connection changed by ${req.user?.name ?? req.user?.id}: now ${key.kind === "apikey" ? `a Google API key ${key.keyHint}` : `Vertex project ${key.projectId} (${location})`}.`);
    res.json(await aiCredentials.publicStatus());
  });

  app.delete("/api/settings/ai", admin, async (req, res) => {
    await aiCredentials.clear();
    console.log(`The saved AI key was removed by ${req.user?.name ?? req.user?.id}: the server's own key is used again.`);
    res.json(await aiCredentials.publicStatus());
  });
}
