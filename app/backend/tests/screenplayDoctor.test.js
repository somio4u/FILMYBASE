// Screenplay Doctor: where the beats fall (counted by code), the cleaning of the AI's answers, the conversion to Script Doctor, and a whole run with a fake AI.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { timeline, characterLedger, beatPositions, lateEntrances, normalizeRows, normalizeOverview, overallScore, chunksOf, toReportItems, LENSES, VERDICTS } from "../screenplayDoctor.js";
import { createScreenplayDoctor, ensureScreenplayDoctorSchema } from "../screenplayDoctorRun.js";
import { ensureReportSchema, getRead } from "../scriptDoctorReport.js";
import { createJobStore, ensureJobSchema } from "../jobStore.js";

const d = (character, hi) => ({ type: "dialogue", character, line: { en: hi, hi } });
const scene = (n, minutes, content) => ({ sceneHeading: { en: `INT. ROOM ${n} - DAY`, hi: "" }, estimatedMinutes: minutes, content });

test("the timeline turns running time into a share of the film, and the ledger says who speaks first and last", () => {
  const scenes = [scene(1, 10, [d("RAMA", "one two three four")]), scene(2, 30, [d("RAMA", "x"), d("VILLAIN", "y")]), scene(3, 60, [d("VILLAIN", "z")])];
  const tl = timeline(scenes);
  assert.deepEqual(tl.map((t) => [t.startPct, t.endPct]), [[0, 10], [10, 40], [40, 100]]);
  const ledger = characterLedger(scenes);
  assert.deepEqual(ledger.RAMA, { first: 1, last: 2, scenes: 2, lines: 2 });
  assert.equal(ledger.VILLAIN.first, 2);
  assert.equal(chunksOf(23, 10).length, 3);
});

test("beat positions: on target, early, late, not found; and late entrances of lead characters", () => {
  const scenes = Array.from({ length: 10 }, (_, i) => scene(i + 1, 10, [d(i < 6 ? "HERO" : "VILLAIN", "a b c d e")]));
  const tl = timeline(scenes);
  const pos = beatPositions({ hook: 1, incitingIncident: 2, lockIn: 3, midpoint: 8, lowPoint: 0, climax: 10 }, tl, "indian_commercial");
  const by = Object.fromEntries(pos.map((p) => [p.key, p.verdict]));
  assert.equal(by.hook, "on target"); assert.equal(by.midpoint, "late"); assert.equal(by.lowPoint, "not found");
  assert.equal(pos.find((p) => p.key === "midpoint").pct, 70);
  const ledger = { HERO: { first: 1, last: 6, scenes: 6, lines: 6 }, VILLAIN: { first: 7, last: 10, scenes: 4, lines: 4 }, EXTRA: { first: 9, last: 9, scenes: 1, lines: 1 } };
  assert.deepEqual(lateEntrances(ledger, tl).map((l) => l.character), ["VILLAIN"]);
});

test("the AI's answers are cleaned: numbers outside the film, a bad verdict, a score of 14, unknown lenses", () => {
  assert.equal(normalizeRows({ scenes: [{ number: 2, purpose: " the vow ", changes: false, plants: ["a knife"] }, { number: 2, purpose: "dup" }, { number: 50, purpose: "x" }] }, [1, 2, 3]).length, 1);
  const o = normalizeOverview({ verdict: "Rewrite", beats: { midpoint: 5, climax: 99 }, issues: [{ severity: "Critical", lens: "Antagonist", problem: "Villain appears late", scenes: [4, 400], fixes: ["a", "b", "c", "d"] }, { severity: "Huge", problem: "x" }],
    scores: [{ lens: "Antagonist", score: 14, reason: "r" }, { lens: "Nonsense", score: 3 }] }, 20);
  assert.equal(o.verdict, "Rewrite"); assert.equal(o.beats.midpoint, 5); assert.equal(o.beats.climax, 0);
  assert.equal(o.issues.length, 1); assert.deepEqual(o.issues[0].scenes, [4]); assert.equal(o.issues[0].fixes.length, 3);
  assert.deepEqual(o.scores, [{ lens: "Antagonist", score: 10, reason: "r" }]);
  assert.equal(normalizeOverview({ verdict: "Burn it" }, 5).verdict, null);
  assert.equal(overallScore([{ score: 6 }, { score: 7 }]), 6.5); assert.equal(overallScore([]), null);
  assert.equal(LENSES.length, 14); assert.equal(VERDICTS.length, 5);
});

test("the findings become a list of changes for Script Doctor", () => {
  const overview = normalizeOverview({ verdict: "Revise", issues: [{ severity: "Major", lens: "Structure and pacing", problem: "The interval is flat", scenes: [], fixes: ["Add a twist"] }, { severity: "Minor", lens: "Scene craft", problem: "Scene 3 repeats scene 2", scenes: [3], fixes: ["Merge them"] }], merits: ["The opening image"], orphans: ["The knife in scene 2 never pays off"], risks: ["Religious procession needs care"] }, 10);
  const items = toReportItems(overview, [{ key: "midpoint", name: "Midpoint / interval", scene: 8, pct: 70, range: [47, 58], verdict: "late" }], [{ character: "VILLAIN", scene: 7, pct: 60 }]);
  assert.deepEqual(items.map((i) => i.kind), ["structure", "scene", "structure", "structure", "structure", "risk", "keep"]);
  assert.equal(items[0].severity, "major"); assert.deepEqual(items[1].scenes, [3]);
});

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let projectId;
test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`).catch(() => {});
  await ensureJobSchema(db); await ensureReportSchema(db); await ensureScreenplayDoctorSchema(db);
  const scenes = Array.from({ length: 12 }, (_, i) => scene(i + 1, 5, [d(i < 6 ? "HERO" : "VILLAIN", `संवाद ${i + 1}`)]));
  projectId = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, backfill) VALUES ('[SPD-TEST]', 'x', $1) RETURNING id", [JSON.stringify({ synopsis: "A hero rises.", screenplayBeats: [{ scenes: scenes.slice(0, 7) }, { scenes: scenes.slice(7) }] })])).rows[0].id;
});
test.after(async () => {
  await db.query("DELETE FROM screenplay_doctor_runs WHERE project_ref = $1", [projectId]);
  await db.query("DELETE FROM adu_report_reads WHERE project_ref = $1", [projectId]);
  await db.query("DELETE FROM ai_movie_projects WHERE id = $1", [projectId]);
  await db.end();
});

const fakeAsk = (calls) => async (label, prompt, schema) => {
  calls.push(label);
  if (schema.properties.verdict) return { verdict: "Revise", verdictReason: "The villain comes late.", biggestFix: "Plant the villain early", logline: "A hero rises.", assumptions: "Indian commercial", beats: { hook: 1, incitingIncident: 2, lockIn: 3, midpoint: 9, lowPoint: 10, climax: 12 }, merits: ["The opening"], issues: [{ severity: "Critical", lens: "Antagonist", problem: "The villain appears at 50%", scenes: [7], fixes: ["Show him in act one"] }], scores: LENSES_SCORES(), orphans: [], commercial: [], risks: [], revisionPlan: ["Plant the villain"] };
  const numbers = [...prompt.matchAll(/SCENE (\d+) —/g)].map((m) => Number(m[1]));
  return { scenes: numbers.map((n) => ({ number: n, purpose: `purpose ${n}`, changes: true, plants: [], payoffs: [], rules: [], heroic: false })) };
};
const LENSES_SCORES = () => [{ lens: "Antagonist", score: 4, reason: "late" }, { lens: "Structure and pacing", score: 6, reason: "ok" }];

test("a whole run with a fake AI: groups of 10 scenes, then the whole film; positions and the overall score are worked out by code; then sent to Script Doctor", async () => {
  const calls = [];
  const doctor = createScreenplayDoctor({ db, jobStore: createJobStore(db), makeAsk: () => fakeAsk(calls) });
  const out = await doctor.start(projectId, { userId: 1, market: "indian_commercial" });
  assert.equal(out.alreadyRunning, false);
  let job;
  for (let i = 0; i < 100; i++) { job = await doctor.jobs.currentFor(projectId); if (job.status !== "running") break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(job.status, "done", JSON.stringify(job.failed));
  assert.equal(calls.length, 3); // scenes 1–10, scenes 11–12, the whole film
  const run = await doctor.latestRun(projectId);
  assert.equal(run.rows.length, 12); assert.equal(run.overview.verdict, "Revise"); assert.equal(run.overview.overall, 5);
  assert.equal(run.overview.positions.find((p) => p.key === "midpoint").scene, 9);
  assert.equal(run.film.scenes, 12);
  const sent = await doctor.sendToScriptDoctor(projectId, run.id, 1);
  const read = await getRead(db, sent.readId, { projectRef: projectId });
  assert.ok(read.items.some((i) => i.severity === "critical" && i.scenes[0] === 7));
  assert.equal(read.partsDone, read.parts);
});

test("refused when the film has fewer than 3 scenes", async () => {
  const tiny = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, backfill) VALUES ('[SPD-TEST] tiny', 'x', $1) RETURNING id", [JSON.stringify({ screenplayBeats: [{ scenes: [scene(1, 1, [d("A", "x")])] }] })])).rows[0].id;
  const doctor = createScreenplayDoctor({ db, jobStore: createJobStore(db), makeAsk: () => fakeAsk([]) });
  await assert.rejects(() => doctor.start(tiny, { userId: 1 }), /at least 3/);
  await db.query("DELETE FROM ai_movie_projects WHERE id = $1", [tiny]);
});
