// Script Doctor → "Analyse my screenplay": both doctors run one after the other (fake doctors here), ONE read comes out with both lists and the verdicts.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createAnalyse } from "../scriptDoctorAnalyse.js";
import { ensureReportSchema, getRead } from "../scriptDoctorReport.js";
import { createJobStore, ensureJobSchema } from "../jobStore.js";
import { createWriteScenesJobs } from "../writeScenesJobs.js";
import { condensePrompt, CONDENSE_SYSTEM, impactSummary, annotateItems } from "../scriptDoctorApply.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`).catch(() => {});
  await ensureJobSchema(db); await ensureReportSchema(db);
});
let projectId;
test.before(async () => { projectId = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text) VALUES ('[ANALYSE-TEST]', 'x') RETURNING id")).rows[0].id; });
test.after(async () => { await db.query("DELETE FROM adu_report_reads WHERE project_ref = $1", [projectId]); await db.query("DELETE FROM ai_movie_projects WHERE id = $1", [projectId]); await db.end(); });

// a fake doctor: start() begins a "job" that finishes after a moment and leaves a run with a verdict and a list of changes
function fakeDoctor(name, overview, items, { fail = false } = {}) {
  let status = "idle", run = null;
  return {
    calls: [],
    jobs: { currentFor: async () => (status === "idle" ? null : { status, step: `${name} step`, failed: fail ? [{ error: "no AI" }] : [] }) },
    async start(projectId, opts) { this.calls.push(opts); status = "running"; run = null; setTimeout(() => { status = "done"; if (!fail) run = { id: name === "dialogue" ? 11 : 22, overview }; }, 120); return { run: { id: 1 } }; },
    latestRun: async () => run,
    async itemsFor() { return { items, overview }; },
  };
}

test("both doctors run one after the other, then ONE read holds both lists, and it carries the verdicts and top fixes", async () => {
  const dialogue = fakeDoctor("dialogue", { verdict: "Dialogue pass", verdictReason: "Voices are close.", topFixes: ["Cut narration"], scores: [] }, [{ kind: "scene", title: "Scene 3: TRIM", action: "Cut the speech.", scenes: [3], pages: [], severity: "minor" }]);
  const screenplay = fakeDoctor("screenplay", { verdict: "Revise", verdictReason: "The villain is late.", biggestFix: "Plant the villain", overall: 5.5, scores: [] }, [{ kind: "structure", title: "Antagonist: late", action: "Plant him early.", scenes: [7], pages: [], severity: "critical" }]);
  const analyse = createAnalyse({ db, jobStore: createJobStore(db), dialogueDoctor: dialogue, screenplayDoctor: screenplay, pollMs: 20 });
  const out = await analyse.start(projectId, { userId: 1, genre: "drama", market: "indian_commercial" });
  assert.equal(out.alreadyRunning, false);
  let job;
  for (let i = 0; i < 200; i++) { job = await analyse.jobs.currentFor(projectId); if (job.status !== "running") break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(job.status, "done", JSON.stringify(job.failed));
  assert.equal(dialogue.calls[0].genre, "drama"); assert.equal(screenplay.calls[0].market, "indian_commercial");
  const readId = (await db.query("SELECT id FROM adu_report_reads WHERE project_ref = $1 ORDER BY id DESC LIMIT 1", [projectId])).rows[0].id;
  const read = await getRead(db, readId, { projectRef: projectId });
  assert.equal(read.items.length, 2); assert.equal(read.partsDone, read.parts);
  assert.equal(read.analysis.dialogue.verdict, "Dialogue pass"); assert.equal(read.analysis.screenplay.verdict, "Revise"); assert.deepEqual(read.analysis.dialogue.topFixes, ["Cut narration"]);
  assert.ok(read.items.some((i) => i.severity === "critical" && i.scenes[0] === 7));
});

test("when a doctor cannot finish, the analysis stops with its reason instead of pretending", async () => {
  const bad = fakeDoctor("dialogue", null, [], { fail: true });
  const ok = fakeDoctor("screenplay", { verdict: "Polish" }, []);
  const analyse = createAnalyse({ db, jobStore: createJobStore(db), dialogueDoctor: bad, screenplayDoctor: ok, pollMs: 20 });
  await analyse.start(projectId, { userId: 1 });
  let job;
  for (let i = 0; i < 200; i++) { job = await analyse.jobs.currentFor(projectId); if (job.status !== "running") break; await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(job.failed.some((f) => /Dialogue Doctor could not finish: no AI/.test(f.error)), JSON.stringify(job.failed));
});

test("'create another draft with ALL the changes': the merge step is told to restate old-scene fixes as story moments, and the summary counts every change", () => {
  assert.ok(/names an OLD scene/.test(CONDENSE_SYSTEM) && /scene numbers differ/.test(CONDENSE_SYSTEM));
  assert.ok(condensePrompt([{ id: 1, severity: "minor", kind: "scene", title: "Scene 3: TRIM", action: "Cut the speech." }]).includes("Scene 3: TRIM"));
  const summary = impactSummary(annotateItems([{ id: 1, kind: "scene", title: "Scene 3", action: "Trim the speech", scenes: [3], pages: [], severity: "minor" }, { id: 2, kind: "keep", title: "Protect", action: "x", scenes: [], pages: [], severity: "note" }, { id: 3, kind: "global", title: "Cut narration", action: "Cut it", scenes: [], pages: [], severity: "major" }].map((x) => ({ ...x }))));
  assert.equal(summary.allChanges, 2);
});
