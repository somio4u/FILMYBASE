// Dialogue Doctor: the exact counting, the cleaning of the AI's answers, and a whole run with a fake AI (no real AI is used).
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { sceneStats, ruleHints, filmStats, normalizeNotes, normalizeOverview, chunksOf, toReportItems, chunkPrompt, blocksOf, FLAGS, MUST_HAVE_BEATS, SCORE_AREAS } from "../dialogueDoctor.js";
import { createDialogueDoctor, ensureDialogueDoctorSchema } from "../dialogueDoctorRun.js";
import { ensureReportSchema, getRead } from "../scriptDoctorReport.js";
import { createJobStore, ensureJobSchema } from "../jobStore.js";

const d = (character, hi) => ({ type: "dialogue", character, line: { en: hi, hi } });
const a = (en) => ({ type: "action", text: { en, hi: en } });
const scene = (n, content) => ({ sceneHeading: { en: `INT. ROOM ${n} - DAY`, hi: "" }, content });

test("the counts are exact: lines, words, dialogue share, speakers, long speech, ping-pong, narration, pairs", () => {
  const s = sceneStats(scene(1, [a("Rain on the window. Rama waits."), d("RAMA", "तुम आ गए"), d("SITA", "हाँ"), d("RAMA", "ठीक है"), d("SITA", "हाँ."), d("NARRATOR", "यह उस रात की बात है")]), 1);
  assert.equal(s.dialogueLines, 5); assert.equal(s.actionLines, 1);
  assert.equal(s.actionWords, 6); assert.equal(s.dialogueWords, 3 + 1 + 2 + 1 + 6);
  assert.equal(s.dialoguePct, Math.round((13 / 19) * 100));
  assert.deepEqual(s.speakers, { RAMA: 2, SITA: 2, NARRATOR: 1 });
  assert.equal(s.pingPong, 4); assert.equal(s.narrationLines, 1); assert.equal(s.silent, false);
  assert.equal(s.pairs["RAMA ↔ SITA"], 3);
  const speech = sceneStats(scene(2, Array.from({ length: 9 }, (_, i) => d("MAKAR", `line number ${i} of a long speech here`))), 2);
  assert.equal(speech.longestSpeech, 9);
  assert.equal(sceneStats(scene(3, [a("Silence.")]), 3).silent, true);
});

test("the older scene shape is read too, and hints say why in plain words", () => {
  const old = { sceneHeading: { en: "EXT. FIELD - DAY" }, action: { en: "He walks." }, dialogue: [{ character: "omm", line: { en: "Hello", hi: "नमस्ते" } }] };
  assert.deepEqual(blocksOf(old).map((b) => b.type), ["action", "dialogue"]);
  assert.equal(blocksOf(old)[1].character, "OMM");
  const hints = ruleHints({ dialogueLines: 3, dialoguePct: 95, longestSpeech: 9, pingPong: 10, narrationLines: 2 }, "drama");
  assert.equal(hints.length, 4);
  assert.ok(hints[0].includes("95%") && hints[0].includes("55–70%"));
  assert.deepEqual(ruleHints({ dialogueLines: 3, dialoguePct: 60, longestSpeech: 2, pingPong: 1, narrationLines: 0 }, "drama"), []);
});

test("the film's numbers: who speaks how much, pairs, silent scenes, narration", () => {
  const f = filmStats([scene(1, [d("A", "one two"), d("B", "three")]), scene(2, [a("Quiet.")]), scene(3, [d("A", "four"), d("NARRATOR", "five")])]);
  assert.equal(f.scenes, 3); assert.deepEqual(f.silentScenes, [2]); assert.equal(f.narrationLines, 1);
  assert.equal(f.characters.A.lines, 2); assert.equal(f.characters.A.first, 1); assert.equal(f.characters.A.last, 3);
  assert.equal(f.pairs["A ↔ B"], 1);
});

test("the AI's answers are cleaned: a bad flag, a scene that is not in the group, a repeat and a score outside 1–10 are handled", () => {
  const notes = normalizeNotes({ scenes: [
    { number: 3, flag: "TRIM", problem: " too  much ", fix: "Cut the second speech", peak: { is: true, verdict: "Misses", reason: "no earned bond" }, comedy: { add: true, idea: "Omm jokes" }, bestLine: { character: "OMM", line: "खाना खाया?" } },
    { number: 3, flag: "KEEP", problem: "x", fix: "y" },
    { number: 99, flag: "KEEP", problem: "x", fix: "y" },
    { number: 4, flag: "BORING", problem: "x", fix: "y" },
  ] }, [3, 4]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].problem, "too much"); assert.equal(notes[0].peak.verdict, "Misses"); assert.equal(notes[0].bestLine.line, "खाना खाया?");
  const o = normalizeOverview({ verdict: "Dialogue pass", scores: [{ area: "Subtext", score: 14, reason: "r" }, { area: "Nonsense", score: 5 }], mustHave: [{ beat: "The interval line", status: "Missing", scene: 40, note: "none" }, { beat: "x", status: "Maybe" }] });
  assert.equal(o.scores.length, 1); assert.equal(o.scores[0].score, 10); assert.equal(o.mustHave.length, 1);
  assert.equal(normalizeOverview({ verdict: "Burn it" }).verdict, null);
  assert.equal(FLAGS.length, 9); assert.equal(MUST_HAVE_BEATS.length, 13); assert.equal(SCORE_AREAS.length, 8);
  assert.deepEqual(chunksOf(20, 8), [{ chunk: 1, from: 1, to: 8 }, { chunk: 2, from: 9, to: 16 }, { chunk: 3, from: 17, to: 20 }]);
});

test("the findings become a list of changes for Script Doctor: protected lines, scene fixes, missing beats, narration, a voice that sounds alike", () => {
  const items = toReportItems(
    [{ number: 3, flag: "TRIM", problem: "talky", fix: "Cut the second speech", peak: { is: true, verdict: "Misses" }, comedy: { add: false }, bestLine: null }, { number: 5, flag: "KEEP", problem: "works", fix: "keep", peak: { is: false }, comedy: { add: false }, bestLine: { character: "OMM", line: "खाना खाया?" } }],
    { mustHave: [{ beat: "The interval line", status: "Missing", scene: 0, note: "No interval line." }, { beat: "The last line", status: "Present", scene: 100, note: "" }], voices: [{ character: "KALI", voice: "formal", distinct: false }] },
    { narrationLines: 9 });
  assert.deepEqual(items.map((i) => i.kind), ["scene", "keep", "structure", "global", "global"]);
  assert.deepEqual(items[0].scenes, [3]); assert.equal(items[0].severity, "major");
  assert.ok(items[1].action.includes("खाना खाया?"));
});

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let projectId;
test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`).catch(() => {});
  await ensureJobSchema(db); await ensureReportSchema(db); await ensureDialogueDoctorSchema(db);
  const scenes = Array.from({ length: 11 }, (_, i) => scene(i + 1, [a("Something happens."), d("RAMA", `संवाद नंबर ${i + 1}`), d("SITA", "हाँ")]));
  projectId = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, backfill) VALUES ('[DOC-TEST]', 'x', $1) RETURNING id", [JSON.stringify({ screenplayBeats: [{ scenes: scenes.slice(0, 6) }, { scenes: scenes.slice(6) }] })])).rows[0].id;
});
test.after(async () => {
  await db.query("DELETE FROM dialogue_doctor_runs WHERE project_ref = $1", [projectId]);
  await db.query("DELETE FROM adu_report_reads WHERE project_ref = $1", [projectId]);
  await db.query("DELETE FROM ai_movie_projects WHERE id = $1", [projectId]);
  await db.end();
});

const fakeAsk = (calls) => async (label, prompt, schema) => {
  calls.push(label);
  if (schema.properties.verdict) return { verdict: "Dialogue pass", verdictReason: "Voices are close.", topFixes: ["Cut narration"], mustHave: [{ beat: "The interval line", status: "Missing", scene: 0, note: "none" }], scores: [{ area: "Subtext", score: 6, reason: "ok" }], voices: [{ character: "RAMA", voice: "plain", distinct: true }], comedyMap: [], pairGaps: [] };
  const numbers = [...prompt.matchAll(/SCENE (\d+) —/g)].map((m) => Number(m[1]));
  return { scenes: numbers.map((n) => ({ number: n, flag: n === 2 ? "TRIM" : "KEEP", problem: "p", fix: "f", peak: { is: false }, comedy: { add: false }, bestLine: n === 1 ? { character: "RAMA", line: "संवाद नंबर 1" } : null })) };
};

test("a whole run with a fake AI: groups of 8 scenes, then the overview; results saved; then sent to Script Doctor", async () => {
  const calls = [];
  const doctor = createDialogueDoctor({ db, jobStore: createJobStore(db), makeAsk: () => fakeAsk(calls) });
  const out = await doctor.start(projectId, { userId: 1, genre: "drama" });
  assert.equal(out.alreadyRunning, false);
  let job;
  for (let i = 0; i < 100; i++) { job = await doctor.jobs.currentFor(projectId); if (job.status !== "running") break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(job.status, "done", JSON.stringify(job.failed));
  assert.equal(calls.length, 3); // scenes 1–8, scenes 9–11, the whole film
  const run = await doctor.latestRun(projectId);
  assert.equal(run.notes.length, 11); assert.equal(run.overview.verdict, "Dialogue pass"); assert.equal(run.film.scenes, 11);
  assert.equal(run.notes.find((n) => n.number === 2).flag, "TRIM");
  const sent = await doctor.sendToScriptDoctor(projectId, run.id, 1);
  assert.ok(sent.items >= 3);
  const read = await getRead(db, sent.readId, { projectRef: projectId });
  assert.ok(read.items.some((i) => i.title === "Scene 2: TRIM" && i.scenes[0] === 2));
  assert.ok(read.items.some((i) => i.kind === "keep"));
  assert.equal(read.partsDone, read.parts, "Script Doctor must see the report as fully read");
});

test("refused when there is no dialogue yet", async () => {
  const empty = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, backfill) VALUES ('[DOC-TEST] empty', 'x', $1) RETURNING id", [JSON.stringify({ screenplayBeats: [{ scenes: [scene(1, [a("Quiet.")])] }] })])).rows[0].id;
  const doctor = createDialogueDoctor({ db, jobStore: createJobStore(db), makeAsk: () => fakeAsk([]) });
  await assert.rejects(() => doctor.start(empty, { userId: 1 }), /dialogue/);
  await db.query("DELETE FROM ai_movie_projects WHERE id = $1", [empty]);
});
