// "Synchronize with the latest screenplay": Production Management is built from the screenplay (the Script Breakdown, the AD scene sheet,
// the Shoot Schedule). When the screenplay changes afterwards they still describe the OLD one. This runs the whole chain again from the
// CURRENT screenplay, in one go, as a background job the screen follows step by step:
//   1. the Script Breakdown (artists, locations, props, costumes, cast tiers, episode numbers)
//   2. the AD scene sheet (extras / props / costume remarks per scene)
//   3. the Shoot Schedule (only if there is one) — availability, target days and instructions typed earlier are reused, days already marked
//      completed are kept untouched, and only the remaining scenes are planned again
//   4. a check of the cast: characters without an actor yet / actors whose character is gone
// Everything is saved as NEW versions (nothing is deleted), the approval status of the breakdown and the schedule is carried over, and the
// cast already assigned to characters is kept. The AI work itself is done by the same functions the individual buttons use.

import crypto from "node:crypto";
import { shouldResume } from "./jobStore.js";

const jobs = new Map();
const lower = (s) => String(s ?? "").trim().toLowerCase();

export const STEPS = [
  { key: "breakdown", label: "Script Breakdown from the new screenplay" },
  { key: "adSheet", label: "AD scene sheet (extras, props, costume per scene)" },
  { key: "schedule", label: "Shoot Schedule" },
  { key: "cast", label: "Cast check" },
];

// the availability typed for the old script, matched to the NEW characters and places: kept where the name still exists, "unknown" for new ones
export function mergeAvailability(previous, characterNames, locationNames) {
  const oldChars = new Map((previous?.characters ?? []).map((c) => [lower(c.name), c]));
  const oldLocs = new Map((previous?.locations ?? []).map((l) => [lower(l.location), l]));
  return {
    ...(previous ?? {}),
    characters: characterNames.map((name) => oldChars.get(lower(name)) ?? { name, unknown: true }),
    locations: locationNames.map((location) => oldLocs.get(lower(location)) ?? { location, unknown: true }),
  };
}

// who is in the new breakdown but has no actor yet, and which actors' characters no longer exist
export function castCheck(artistLabels, crewRows) {
  const labels = new Set(artistLabels.map(lower));
  const cast = new Set(crewRows.map((r) => lower(r.character_name)).filter(Boolean));
  return {
    withoutActor: artistLabels.filter((l) => !cast.has(lower(l))),
    orphanedActors: crewRows.filter((r) => r.character_name && !labels.has(lower(r.character_name))).map((r) => ({ character: r.character_name, actor: r.name })),
  };
}

export function registerProductionSyncRoutes(app, db, tools) {
  const { jobStore, requireRole, userOwnsSceneList, buildBreakdownSourceText, generateDeepScriptBreakdownContent,
    flattenScenesForAdSheet, generateAdSheetDetails, fetchCharacterNamesForSceneList, generateShootScheduleContent } = tools;
  const allowed = requireRole("admin", "production_manager");

  // every change of a job is also written to the database, so a restart of the server cannot make it vanish
  const persist = (job) => jobStore.save(job.id, job, job.status).catch((e) => console.error("Saving the synchronization state failed:", e.message));

  async function run(job, sceneListId) {
    const step = (key) => job.steps.find((s) => s.key === key);
    const begin = (key, note) => { const s = step(key); s.state = "working"; s.note = note ?? ""; s.startedAt = Date.now(); persist(job); };
    const say = (key, note) => { step(key).note = note; persist(job); };
    const end = (key, state, note) => { const s = step(key); s.state = state; s.note = note ?? ""; persist(job); };
    try {
      const sceneList = (await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId])).rows[0].content;
      const sourceText = await buildBreakdownSourceText(sceneList, sceneListId);
      const previousBreakdown = (await db.query("SELECT status FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1", [sceneListId])).rows[0];

      // 1 + 2 — one new breakdown row, with the AD scene sheet in it
      begin("breakdown", "reading the whole screenplay: characters, places, props, costumes, cast tiers, episode numbers — the longest part, several minutes");
      let content = await generateDeepScriptBreakdownContent(sourceText);
      // (the generator itself already sorts the cast into tiers and tags the episode numbers)
      end("breakdown", "done", `${(content.artistList ?? []).length} characters, ${(content.locationList ?? []).length} places`);

      begin("adSheet", "starting");
      const entries = flattenScenesForAdSheet(sceneList);
      let firstError = null;
      const details = await generateAdSheetDetails(entries, content, sourceText, (e) => { firstError ??= e.message; }, (done, total) => say("adSheet", `scenes analysed in ${total} parts — part ${Math.min(done + 1, total)} of ${total} is being worked on (${done} done)`));
      const failed = details.filter((d) => d.failed).length;
      // an AD sheet the AI could not read at all is never saved (the old breakdown stays); a partly blank one is saved and said so
      if (entries.length > 0 && failed === entries.length) throw new Error(`The AI could not read the script for the AD sheet${firstError ? ` (${firstError})` : ""}. Nothing was changed — please try again in a minute.`);
      content = { ...content, adSheet: entries.map((e, i) => { const { failed: _failed, ...rest } = details[i]; return { ...e, ...rest }; }) };
      const status = previousBreakdown?.status === "approved" ? "approved" : "pending";
      await db.query("INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4)", [sceneListId, JSON.stringify(content), status, "Synchronized with the latest screenplay"]);
      end("adSheet", failed ? "warning" : "done", failed ? `${entries.length - failed} of ${entries.length} scenes analysed — ${failed} could not be (press Synchronize again to retry)` : `${entries.length} scenes`);

      // 3 — the schedule, only when one exists
      begin("schedule", "checking for an existing Shoot Schedule");
      const previousSchedule = (await db.query("SELECT content, status FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1", [sceneListId])).rows[0];
      if (!previousSchedule) {
        end("schedule", "skipped", "no Shoot Schedule yet — nothing to rebuild");
      } else {
        try {
          say("schedule", "planning the remaining days — several minutes");
          const characterNames = await fetchCharacterNamesForSceneList(sceneListId, sceneList);
          const locationNames = (content.locationList ?? []).map((l) => l.location?.en).filter(Boolean);
          const prev = previousSchedule.content ?? {};
          const completedDays = (prev.scheduleDays ?? []).filter((d) => d.completed);
          const schedule = await generateShootScheduleContent(sceneList, characterNames, mergeAvailability(prev.availability, characterNames, locationNames), prev.targetDays, null, {
            specialInstructions: prev.specialInstructions, completedDays, sourceText, breakdownContent: content,
          });
          await db.query("INSERT INTO shoot_schedules (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4)", [sceneListId, JSON.stringify(schedule), previousSchedule.status === "approved" ? "approved" : "pending", "Synchronized with the latest screenplay"]);
          end("schedule", "done", `${(schedule.scheduleDays ?? []).length} days${completedDays.length ? `, ${completedDays.length} completed day(s) kept` : ""}`);
        } catch (error) {
          console.error("Sync: the schedule failed:", error.message);
          end("schedule", "error", "the old Shoot Schedule was kept — press Synchronize again or rebuild it from the Shoot Schedule section");
        }
      }

      // 4 — the cast
      begin("cast", "comparing the characters with the actors you assigned");
      const crew = (await db.query("SELECT character_name, name FROM crew_members WHERE scene_list_id = $1 AND category = 'artist'", [sceneListId])).rows;
      job.cast = castCheck((content.artistList ?? []).map((a) => a.label), crew);
      end("cast", "done", `${job.cast.withoutActor.length} character(s) without an actor yet`);
      job.status = "done";
      job.finishedAt = Date.now();
      await persist(job);
    } catch (error) {
      console.error("Production sync failed:", error.message);
      const working = job.steps.find((s) => s.state === "working");
      if (working) { working.state = "error"; working.note = error.message; }
      job.status = "error";
      job.error = error.message;
      job.finishedAt = Date.now();
      await persist(job);
    }
  }

  app.post("/api/scene-lists/:id/sync-production", allowed, async (req, res) => {
    try {
    const id = Number(req.params.id);
    if (!(await userOwnsSceneList(req.user, id))) { res.status(403).json({ error: "You don't have access to this project." }); return; }
    const list = (await db.query("SELECT status FROM scene_lists WHERE id = $1", [id])).rows[0];
    if (!list) { res.status(404).json({ error: "Scene list not found" }); return; }
    if (list.status !== "approved") { res.status(400).json({ error: "The screenplay must be approved first." }); return; }
    for (const [k, j] of jobs) if (j.status !== "running" && Date.now() - j.startedAt > 60 * 60 * 1000) jobs.delete(k);
    for (const [k, j] of jobs) if (j.sceneListId === id && j.status === "running") { res.json({ jobId: k, alreadyRunning: true }); return; }
    // a running one may be known only to the database (the server restarted since): the screen follows that one
    const known = await jobStore.latest("sync", id);
    if (known && known.status === "running" && !jobs.has(known.id)) { res.json({ jobId: known.id, alreadyRunning: true, serverNow: Date.now() }); return; }
    const jobId = crypto.randomUUID();
    const job = { id: jobId, sceneListId: id, status: "running", startedAt: Date.now(), steps: STEPS.map((s) => ({ ...s, state: "waiting", note: "" })), cast: null, error: null, notice: "", resumes: 0 };
    jobs.set(jobId, job);
    await jobStore.insert(jobId, "sync", id, "", job);
    run(job, id);
    res.json({ jobId, serverNow: Date.now() });
    } catch (error) {
      // never let a mistake here take the whole server down (an uncaught error in an async route ends the process)
      console.error("Starting the synchronization failed:", error.message);
      res.status(500).json({ error: `The synchronization could not be started: ${error.message}` });
    }
  });

  const view = (id, job) => ({ jobId: id, status: job.status, steps: job.steps, cast: job.cast, error: job.error, notice: job.notice ?? "", startedAt: job.startedAt, finishedAt: job.finishedAt ?? null, now: Date.now() });

  // the newest synchronization of this project (running, or finished within the last hour): lets the screen pick it up again after the
  // page reloaded or refreshed itself, or after the server restarted, instead of looking as if nothing is happening
  app.get("/api/scene-lists/:id/sync-production/current", allowed, async (req, res) => {
    const id = Number(req.params.id);
    const stored = await jobStore.latest("sync", id);
    if (!stored) { res.json({ jobId: null }); return; }
    const job = jobs.get(stored.id) ?? stored.state;
    if (job.status !== "running" && Date.now() - (job.finishedAt ?? job.startedAt) > 60 * 60 * 1000) { res.json({ jobId: null }); return; }
    res.json(view(stored.id, job));
  });

  app.get("/api/scene-lists/:id/sync-production/:jobId", allowed, async (req, res) => {
    const stored = jobs.has(req.params.jobId) ? null : await jobStore.get(req.params.jobId);
    const job = jobs.get(req.params.jobId) ?? stored?.state;
    if (!job || job.sceneListId !== Number(req.params.id)) { res.status(404).json({ error: "That synchronization is no longer available." }); return; }
    res.json(view(req.params.jobId, job));
  });

  // at start-up: a synchronization that was running when the server stopped (a deploy, a restart) is started again from the beginning
  async function resume() {
    for (const stored of await jobStore.running("sync")) {
      const verdict = shouldResume(stored);
      const job = { ...stored.state, id: stored.id, sceneListId: stored.sceneListId };
      if (!verdict.resume) {
        job.status = "error"; job.error = `This synchronization was given up: ${verdict.why}. Nothing was changed — press Synchronize again.`; job.finishedAt = Date.now();
        await persist(job);
        continue;
      }
      await jobStore.countResume(stored.id);
      job.resumes = stored.resumes + 1;
      job.status = "running";
      job.steps = STEPS.map((s) => ({ ...s, state: "waiting", note: "" }));
      job.notice = `The server was restarted (an update), so this started again from the beginning — restart ${job.resumes}. Nothing was lost.`;
      jobs.set(stored.id, job);
      await persist(job);
      console.log(`Resuming the synchronization of scene list ${stored.sceneListId} (restart ${job.resumes}).`);
      run(job, stored.sceneListId);
    }
  }

  return { resume };
}
