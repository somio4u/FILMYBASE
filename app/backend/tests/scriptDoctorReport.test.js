// A script doctor's report -> a checklist of changes (scriptDoctorReport.js): the cutting, the cleaning, the joining and the storage. No AI here (the AI's answers are scripted).
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { chunkReportText, normalizeItems, joinItems, groupByKind, instructionFor, ensureReportSchema, createRead, saveParts, getRead, saveSelection, REPORT_SCHEMA } from "../scriptDoctorReport.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB, stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await ensureReportSchema(db);
});
test.after(async () => { await db.query("DELETE FROM adu_report_reads WHERE filename LIKE '[REP-TEST]%'"); await db.end(); });

test("the report is cut at paragraph borders into parts under the size; a huge block is cut anywhere; nothing is lost", () => {
  const para = (n) => `Paragraph ${n}. ` + "word ".repeat(40);
  const text = Array.from({ length: 30 }, (_, i) => para(i)).join("\n\n");
  const parts = chunkReportText(text, 1500);
  assert.ok(parts.length > 3);
  assert.ok(parts.every((p) => p.length <= 1500));
  assert.ok(parts.every((p) => /^Paragraph \d+\./.test(p))); // every part starts at a paragraph
  const squash = (x) => x.replace(/\s+/g, " ").trim();
  assert.equal(squash(parts.join("\n\n")), squash(text)); // nothing is lost (only the spaces at the ends of paragraphs)
  const huge = chunkReportText("x".repeat(5000), 2000);
  assert.deepEqual(huge.map((p) => p.length), [2000, 2000, 1000]);
  assert.deepEqual(chunkReportText("   \n\n  "), []);
  assert.deepEqual(chunkReportText("Scene 1\u0000 is\u0001 fine\n\nNext\tpart"), ["Scene 1 is fine\n\nNext\tpart"]); // hidden control characters from a PDF are dropped (a NUL would break the database)
});

test("cleaning: bad kinds and empty actions are dropped; scene numbers are whole numbers; text is limited", () => {
  const items = normalizeItems([
    { kind: "scene", title: "Trim the narrator", action: "  Cut the narrator\ncues in scene 63. ", scenes: [63, "63", 0, -2, "x", 1e6, 64.4], pages: [46], severity: "major" },
    { kind: "nonsense", title: "x", action: "y" },
    { kind: "global", title: "", action: "no title" },
    { kind: "risk", title: "Brahma extraction", action: "Show light through the cloth, never the opened idol.", severity: "weird" },
    null,
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].action, "Cut the narrator cues in scene 63.");
  assert.deepEqual(items[0].scenes, [63, 64]);
  assert.equal(items[1].severity, "note");
  assert.equal(normalizeItems([{ kind: "keep", title: "t", action: "a".repeat(5000) }])[0].action.length, 900);
  assert.deepEqual(normalizeItems("not a list"), []);
});

test("joining: the same change named in two parts is kept once, every change gets a number, groups follow the fixed order", () => {
  const a = [{ kind: "structure", title: "Plant Kalapahada early", action: "a", scenes: [], pages: [], severity: "critical" }, { kind: "keep", title: "Keep “payment?”", action: "Samir: payment?", scenes: [], pages: [], severity: "note" }];
  const b = [{ kind: "structure", title: "Plant  Kalapahada EARLY!", action: "b", scenes: [], pages: [], severity: "critical" }, { kind: "scene", title: "Trim narrator", action: "c", scenes: [63], pages: [], severity: "major" }];
  const joined = joinItems([a, b, undefined]);
  assert.deepEqual(joined.map((i) => [i.id, i.kind]), [[1, "structure"], [2, "keep"], [3, "scene"]]);
  assert.deepEqual(groupByKind(joined).map((g) => g.kind), ["structure", "scene", "keep"]); // fixed order, empty groups left out
});

test("the instruction handed to Adu: what to do, the scenes, and the lines that must stay untouched (not itself)", () => {
  const keep = [{ id: 2, kind: "keep", action: "Samir: “payment?” (p16)" }, { id: 3, kind: "keep", action: "Rudra: “Transaction poora hua.”" }];
  const text = instructionFor({ id: 9, kind: "scene", action: "Cut the narrator cues.", scenes: [63, 64] }, keep);
  assert.match(text, /^Cut the narrator cues\. \(scenes 63, 64\)/);
  assert.match(text, /keep these untouched: “Samir: “payment\?” \(p16\)”; “Rudra/);
  assert.equal(instructionFor({ id: 2, kind: "keep", action: "Samir: x", scenes: [] }, keep).includes("Samir: x”"), false); // a keep item is not told to keep itself
  assert.equal(instructionFor({ id: 1, action: "Do it", scenes: [5] }, []), "Do it (scene 5)");
});

test("storage: a read is created, parts are saved and joined in order, a selection keeps only real numbers, and another project cannot read it", async () => {
  const r = await createRead(db, { projectRef: 4242, userId: 7, filename: "[REP-TEST] report.pdf", text: Array.from({ length: 10 }, (_, i) => `Part text ${i} ` + "x".repeat(2000)).join("\n\n") });
  assert.ok(r.parts >= 2);
  await saveParts(db, r.id, 2, [{ kind: "scene", title: "Second", action: "b", scenes: [2], pages: [], severity: "minor" }]);
  await saveParts(db, r.id, 1, [{ kind: "structure", title: "First", action: "a", scenes: [], pages: [], severity: "critical" }]);
  let read = await getRead(db, r.id, { projectRef: 4242 });
  assert.equal(read.partsDone, 2);
  assert.deepEqual(read.items.map((i) => [i.id, i.title]), [[1, "First"], [2, "Second"]]); // joined in the report's order, whatever order the parts finished
  assert.deepEqual(read.groups.map((g) => g.kind), ["structure", "scene"]);
  await saveParts(db, r.id, 2, [{ kind: "scene", title: "Second", action: "b", scenes: [2], pages: [], severity: "minor" }]); // the same part again: no duplicates
  assert.equal((await getRead(db, r.id, { projectRef: 4242 })).items.length, 2);
  assert.deepEqual(await saveSelection(db, r.id, [1, 2, 2, 99, "x"]), [1, 2]);
  assert.deepEqual(await saveSelection(db, r.id, [2], { sent: [2, 77] }), [2]);
  read = await getRead(db, r.id, { projectRef: 4242 });
  assert.deepEqual([read.selected, read.sent], [[2], [2]]);
  assert.equal(await getRead(db, r.id, { projectRef: 1 }), null);
  await assert.rejects(createRead(db, { projectRef: 1, filename: "[REP-TEST] e", text: "  " }), /could not read any text/);
  assert.equal(REPORT_SCHEMA.properties.items.type, "ARRAY");
});

test("a new draft from the report: all ticked changes (or all, if none ticked) in one request, the most serious first; protected lines become must-keep; size is limited", async () => {
  const { revisionFromReport } = await import("../scriptDoctorReport.js");
  const items = [
    { id: 1, kind: "scene", title: "Trim narrator", action: "Cut the narrator cues.", scenes: [63], pages: [], severity: "minor" },
    { id: 2, kind: "structure", title: "Plant Kalapahada early", action: "Show his silhouette in act one.", scenes: [], pages: [], severity: "critical" },
    { id: 3, kind: "keep", title: "Keep payment", action: "Samir: “payment?” (p16)", scenes: [], pages: [], severity: "note" },
    { id: 4, kind: "global", title: "One voice each", action: "Jargon for Meera only.", scenes: [], pages: [], severity: "major" },
  ];
  const all = revisionFromReport(items, []);
  assert.equal(all.included, 3);
  assert.match(all.instruction, /1\. \(critical, structure\) Plant Kalapahada early: Show his silhouette in act one\.\n2\. \(major, global\) One voice each/);
  assert.match(all.instruction, /3\. \(minor, scene\) Trim narrator \[scene 63\]/);
  assert.deepEqual(all.constraints.mustKeep, ["Samir: “payment?” (p16)"]); // a protected line is never a change
  const some = revisionFromReport(items, [1, 3]);
  assert.equal(some.included, 1); // a "keep" item that is ticked is still not a change
  assert.match(some.instruction, /Trim narrator/);
  const many = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, kind: "scene", title: `Change ${i}`, action: "x".repeat(300), scenes: [], pages: [], severity: "minor" }));
  const capped = revisionFromReport(many, []);
  assert.ok(capped.instruction.length <= 9300);
  assert.equal(capped.included + capped.left, 200);
  assert.ok(capped.left > 0);
  assert.equal(revisionFromReport([], []).included, 0);
});
