// Settings → AI connection (admin only): see which Google key the app is using, test a new one, save it, or go back to the server's own.
import { cleanLocation, describeAiError, parseServiceAccount, safeDetails } from "./aiCredentials.js";

export function registerAiSettingsRoutes(app, db, { requireRole, aiCredentials, testCandidate }) {
  const admin = requireRole("admin");

  // a real, tiny AI call with the candidate key (nothing is saved): tells plainly whether it will work, and at which step it stops
  // steps: 1 the file was read · 2 Google accepts the key (sign-in) · 3 Vertex AI answers a test question
  async function runTest(parsed, location) {
    const started = Date.now();
    const base = { projectId: parsed.projectId, clientEmail: parsed.clientEmail, location };
    const steps = [{ key: "format", ok: true, note: `project ${parsed.projectId}, service account ${parsed.clientEmail}` }];
    try {
      const info = await testCandidate(parsed.serviceAccount, location, (step, note, opts) => steps.push({ key: step, ok: !opts?.warn, warn: Boolean(opts?.warn), note }));
      return { ok: true, ...base, model: info?.model ?? null, steps, warnings: steps.filter((s) => s.warn).map((s) => s.note), seconds: Math.round((Date.now() - started) / 100) / 10 };
    } catch (error) {
      const step = error?.step ?? "vertex";
      steps.push({ key: step, ok: false });
      console.error(`AI key test failed at "${step}" for project ${parsed.projectId}:`, safeDetails(error));
      return { ok: false, ...base, step, steps, message: describeAiError(error, step), details: safeDetails(error), seconds: Math.round((Date.now() - started) / 100) / 10 };
    }
  }

  app.get("/api/settings/ai", admin, async (req, res) => {
    res.json(await aiCredentials.publicStatus());
  });

  app.post("/api/settings/ai/test", admin, async (req, res) => {
    const parsed = parseServiceAccount(req.body?.key);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
    res.json(await runTest(parsed, cleanLocation(req.body?.location)));
  });

  // saving tests the key again first (so a key that does not work can never replace one that does), unless the admin insists
  app.put("/api/settings/ai", admin, async (req, res) => {
    const parsed = parseServiceAccount(req.body?.key);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
    const location = cleanLocation(req.body?.location);
    if (req.body?.saveAnyway !== true) {
      const test = await runTest(parsed, location);
      if (!test.ok) { res.status(422).json({ error: test.message, test }); return; }
    }
    await aiCredentials.save({ serviceAccount: parsed.serviceAccount, location, userName: req.user?.name ?? req.user?.username ?? null });
    console.log(`AI connection changed by ${req.user?.name ?? req.user?.id}: now project ${parsed.projectId} (${location}).`);
    res.json(await aiCredentials.publicStatus());
  });

  app.delete("/api/settings/ai", admin, async (req, res) => {
    await aiCredentials.clear();
    console.log(`The saved AI key was removed by ${req.user?.name ?? req.user?.id}: the server's own key is used again.`);
    res.json(await aiCredentials.publicStatus());
  });
}
