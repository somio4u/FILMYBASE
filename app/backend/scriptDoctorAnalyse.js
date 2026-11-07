// Script Doctor → "Analyse my screenplay": the Dialogue Doctor and the Screenplay Doctor each read the film (one after the other, in the background) and their findings
// are put together into ONE list of changes — exactly like an uploaded report — with their verdicts, scores and biggest fixes shown at the top. From there the owner
// can make the changes inside this draft (▶) or create another draft with all of them (⚡).
import { createWriteScenesJobs, publicView } from "./writeScenesJobs.js";
import { createRead, saveParts } from "./scriptDoctorReport.js";

export const ANALYSE_KIND = "script-doctor-analyse";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createAnalyse({ db, jobStore, dialogueDoctor, screenplayDoctor, pollMs = 2000 }) {
  // runs one doctor and waits until it has finished; the doctor's own step is shown as this job's step
  async function runDoctor(doctor, label, item, tools) {
    const started = await doctor.start(item.projectId, { userId: item.userId, genre: item.genre, market: item.market });
    const runId = started.run?.id ?? (await doctor.latestRun(item.projectId))?.id;
    for (;;) {
      const job = await doctor.jobs.currentFor(item.projectId);
      if (!job || job.status !== "running") {
        const run = await doctor.latestRun(item.projectId);
        if (!run?.overview) throw new Error(`${label} could not finish: ${job?.failed?.[0]?.error || job?.error || "it gave no result"}`);
        return run;
      }
      await tools.say(`${label}: ${job.step ?? "working"}`);
      await sleep(pollMs);
    }
  }

  const jobs = createWriteScenesJobs({
    jobStore,
    kind: ANALYSE_KIND,
    isWritten: async () => false,
    describe: (item, n, total) => (item.phase === "combine" ? `Putting the findings together (${n} of ${total})` : `${item.phase === "dialogue" ? "Dialogue Doctor" : "Screenplay Doctor"} (${n} of ${total})`),
    writeOne: async (item, tools) => {
      if (item.phase === "dialogue") { await runDoctor(dialogueDoctor, "Dialogue Doctor", item, tools); return; }
      if (item.phase === "screenplay") { await runDoctor(screenplayDoctor, "Screenplay Doctor", item, tools); return; }
      await tools.say("Putting both doctors' findings into one list of changes");
      const d = await dialogueDoctor.latestRun(item.projectId), s = await screenplayDoctor.latestRun(item.projectId);
      if (!d?.overview || !s?.overview) throw new Error("One of the doctors has no result, so there is nothing to put together.");
      const dd = await dialogueDoctor.itemsFor(item.projectId, d.id), ss = await screenplayDoctor.itemsFor(item.projectId, s.id);
      const items = [...ss.items, ...dd.items];
      if (items.length === 0) throw new Error("The doctors found nothing to change.");
      const analysis = {
        dialogue: { runId: d.id, verdict: d.overview.verdict, reason: d.overview.verdictReason, topFixes: d.overview.topFixes ?? [], scores: d.overview.scores ?? [] },
        screenplay: { runId: s.id, verdict: s.overview.verdict, reason: s.overview.verdictReason, biggestFix: s.overview.biggestFix, overall: s.overview.overall ?? null, scores: s.overview.scores ?? [] },
      };
      const text = `Analysis by the Dialogue Doctor (${analysis.dialogue.verdict}) and the Screenplay Doctor (${analysis.screenplay.verdict}).\n\n${items.map((i) => `${i.title}\n${i.action}`).join("\n\n")}`;
      const read = await createRead(db, { projectRef: item.projectId, userId: item.userId, filename: `Script Doctor analysis (${new Date().toISOString().slice(0, 10)})`, text, analysis });
      for (let part = 1; part <= read.parts; part++) await saveParts(db, read.id, part, part === 1 ? items : []);
    },
  });

  async function start(projectId, { userId, genre, market }) {
    const running = await jobs.currentFor(projectId).catch(() => null);
    if (running?.status === "running") return { job: running, alreadyRunning: true };
    const base = { episodeIndex: null, projectId, userId, genre, market };
    const items = [{ ...base, sceneIndex: 1, label: "Dialogue Doctor", phase: "dialogue" }, { ...base, sceneIndex: 2, label: "Screenplay Doctor", phase: "screenplay" }, { ...base, sceneIndex: 3, label: "Putting it together", phase: "combine" }];
    return jobs.start({ sceneListId: projectId, userId, items, language: "en" });
  }
  return { jobs, start, publicView };
}
