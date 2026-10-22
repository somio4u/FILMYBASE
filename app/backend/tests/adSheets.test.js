import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import ExcelJS from "exceljs";
import { buildDocument, DOCUMENTS } from "../adSheets.js";
import { renderPdf, renderXlsx } from "../adRender.js";
import { buildPlan, ensureSmartSchedulerSchema, registerSmartSchedulerRoutes, sceneFingerprints } from "../smartScheduler.js";
import { registerAdRoutes } from "../adRoutes.js";

const scene = (i, loc, intExt, tod, minutes, artists, gist, extra = {}) => ({ id: `film-${i}`, label: String(i + 1), episode: null, minutes, location: loc, rawLocation: loc, intExt, timeOfDay: tod, night: tod === "NIGHT", artists, written: true, gist, body: "", ...extra });
const rows = [
  scene(0, "TEMPLE", "INT", "DAY", 2, ["SOUMYA", "RAVI"], "Prayer at the temple."),
  scene(1, "TEMPLE", "EXT", "NIGHT", 3, ["SOUMYA"], "A crowd of villagers gathers.", { body: "Villagers gather. He drops the brass lamp." }),
  scene(2, "CLINIC", "INT", "DAY", 2, ["RAVI"], "ଡାକ୍ତର ଆସନ୍ତି।"),
  scene(3, "MALATI HOUSE", "INT", "DAY", 1.5, [], "Not written yet.", { written: false }),
];
const brief = { days: 2, maxMinutesPerDay: null, artists: { SOUMYA: "costly" }, locations: { TEMPLE: "paid" } };
const plan = buildPlan(rows, brief, null);
const ctx = (over = {}) => ({
  title: "Maha Kali", rows, plan, stale: false, changedIds: [],
  adSheet: rows.map((_, i) => ({ mainCharacters: [], extras: { en: i === 0 ? "10 devotees" : "" }, property: { en: i === 1 ? "brass lamp" : "" }, costumeRemarks: { en: "" } })),
  breakdown: { props: [{ label: "Brass lamp", notes: { en: "old" } }], costumes: [{ character: "SOUMYA", description: { en: "White saree" } }] },
  tags: [[null, 1, "change", "shorten the speech", "admin", null]], contacts: new Map([["RAVI", { contact_number: "98765" }]]),
  ...over,
});
const flat = (spec) => spec.sections.flatMap((s) => s.rows.map((r) => r.join(" | "))).join("\n");

test("every document builds, and every one has rows and a consistent column count", () => {
  for (const d of DOCUMENTS) {
    const spec = buildDocument(d.kind, ctx());
    assert.ok(spec.sections.length > 0, d.kind);
    for (const s of spec.sections) for (const r of s.rows) assert.equal(r.length, s.columns.length, `${d.kind}: ${s.heading}`);
  }
});

test("location-wise artist list: scenes and artists per place (the owner's question)", () => {
  const spec = buildDocument("location-artists", ctx());
  const temple = spec.sections[0].rows.find((r) => r[0] === "TEMPLE");
  assert.equal(temple[1], 2); // scenes
  assert.equal(temple[2], 2); // artists: SOUMYA, RAVI
  assert.match(temple[3], /SOUMYA \(2\)/);
  const detail = spec.sections.find((s) => s.heading.startsWith("TEMPLE"));
  assert.deepEqual(detail.rows.map((r) => r[0]), ["SOUMYA", "RAVI"]);
});

test("D sheet has one block per day with totals; location schedule lists days; call sheet carries contacts and costume", () => {
  const d = buildDocument("d-sheet", ctx());
  const days = plan.days.filter((x) => x.sceneIds.length);
  assert.equal(d.sections.length, 1 + days.length);
  assert.ok(d.sections[1].rows.at(-1).includes("TOTAL"));
  const ls = buildDocument("location-schedule", ctx());
  assert.match(flat(ls), /Day \d/);
  const call = buildDocument("call-sheet", ctx());
  assert.match(flat(call), /98765/);
  assert.match(flat(call), /White saree/);
});

test("plan-based sheets say so plainly when there is no plan; others still work", () => {
  assert.throws(() => buildDocument("d-sheet", ctx({ plan: null })), /shoot schedule first/);
  assert.ok(buildDocument("one-liner", ctx({ plan: null })).sections[0].rows.length === 4);
  assert.ok(buildDocument("location-artists", ctx({ plan: null })).sections.length > 1);
});

test("props, extras, continuity, tags and not-written scenes are picked up", () => {
  assert.match(flat(buildDocument("props-costume", ctx())), /Brass lamp \| old \| 2/); // found in scene 2's text
  assert.match(flat(buildDocument("extras", ctx())), /devotees/);
  assert.match(flat(buildDocument("extras", ctx())), /villagers/);
  const cont = buildDocument("continuity", ctx()).sections[0].rows;
  assert.equal(cont.length, 4); // 2 + 1 + 1 artist-scene pairs
  const ch = buildDocument("changed-scenes", ctx());
  assert.match(flat(ch), /RED — change \| shorten the speech/);
  assert.match(flat(ch), /Malati House|MALATI HOUSE/);
  const dn = buildDocument("day-night", ctx()).sections[0].rows;
  assert.equal(dn.at(-1)[3], "4 sc · 8.5 min");
});

test("an out-of-date breakdown (different scene count) is ignored, not mis-joined", () => {
  const spec = buildDocument("scene-breakdown", ctx({ adSheet: [{ extras: { en: "x" } }] }));
  assert.ok(!flat(spec).includes("| x |"));
});

test("PDF and Excel are real files with the same rows (Odia text included)", async () => {
  const spec = buildDocument("one-liner", ctx());
  const pdf = await renderPdf(spec);
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await renderXlsx(spec));
  const text = [];
  wb.worksheets[0].eachRow((row) => text.push(row.values.join(" ")));
  assert.ok(text.some((t) => t.includes("ଡାକ୍ତର")));
  assert.ok(text.some((t) => t.includes("Prayer at the temple.")));
  for (const d of DOCUMENTS) assert.equal((await renderPdf(buildDocument(d.kind, ctx()))).subarray(0, 4).toString(), "%PDF", d.kind);
});

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let up = true;
try { await db.query("SELECT 1"); } catch { up = false; }

test("routes: document list and downloads on the real database", { skip: !up }, async () => {
  await db.query("CREATE TABLE IF NOT EXISTS auto_pipeline_runs (id SERIAL PRIMARY KEY, scene_list_id INTEGER, status TEXT)").catch(() => {});
  await db.query("ALTER TABLE auto_pipeline_runs ADD COLUMN IF NOT EXISTS scene_list_id INTEGER");
  await ensureSmartSchedulerSchema(db);
  await db.query("CREATE TABLE IF NOT EXISTS scene_tags (id SERIAL PRIMARY KEY, scene_list_id INTEGER NOT NULL, episode_index INTEGER, scene_index INTEGER NOT NULL, tag TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', set_by_name TEXT, set_by_role TEXT, set_at TIMESTAMPTZ NOT NULL DEFAULT now(), done_by TEXT, done_at TIMESTAMPTZ)");
  await db.query("CREATE TABLE IF NOT EXISTS shoot_schedules (id SERIAL PRIMARY KEY, scene_list_id INTEGER, content JSONB, status TEXT, feedback TEXT, created_at TIMESTAMPTZ DEFAULT now())");
  await db.query("CREATE TABLE IF NOT EXISTS crew_members (id SERIAL PRIMARY KEY, scene_list_id INTEGER, category TEXT, character_name TEXT, name TEXT, contact_number TEXT)");
  await db.query("CREATE TABLE IF NOT EXISTS script_breakdowns (id SERIAL PRIMARY KEY, scene_list_id INTEGER, content JSONB, status TEXT, feedback TEXT, created_at TIMESTAMPTZ DEFAULT now())");
  const content = { scenes: [
    { sceneNumber: "1", intExt: "INT", location: { en: "Temple" }, timeOfDay: "DAY", estimatedMinutes: 2, oneLiner: { en: "Prayer" } },
    { sceneNumber: "2", intExt: "EXT", location: { en: "Temple Exterior" }, timeOfDay: "NIGHT", estimatedMinutes: 3, oneLiner: { en: "Crowd" } },
  ] };
  const id = (await db.query("INSERT INTO scene_lists (content, status) VALUES ($1, 'approved') RETURNING id", [JSON.stringify(content)])).rows[0].id;
  const app = express();
  app.use(express.json());
  const requireRole = () => (req, res, next) => { req.user = { id: 1 }; next(); };
  const { loadRows } = registerSmartSchedulerRoutes(app, db, { requireRole, askModel: async () => ({}) });
  registerAdRoutes(app, db, { requireRole, loadRows });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(`${base}/api/ad/${id}/documents`)).json();
    assert.equal(list.hasPlan, false);
    assert.equal(list.documents.length, 12);
    assert.equal((await fetch(`${base}/api/ad/${id}/d-sheet/pdf`)).status, 409); // no schedule yet
    // Production Management's own shoot schedule is used first, with its dates and per-scene costume / props
    await db.query("INSERT INTO shoot_schedules (scene_list_id, content, status) VALUES ($1, $2, 'approved')", [id, JSON.stringify({ scheduleDays: [{ dayNumber: 1, date: "2026-11-02", location: { en: "Temple" }, sceneRefs: [{ episodeIndex: null, sceneIndex: 1, costume: "red saree", properties: "brass lamp", adRemark: "" }, { episodeIndex: null, sceneIndex: 0, costume: "", properties: "", adRemark: "" }] }] })]);
    const withShoot = await (await fetch(`${base}/api/ad/${id}/documents`)).json();
    assert.equal(withShoot.planSource, "production");
    assert.equal(withShoot.hasPlan, true);
    const dsheet = await fetch(`${base}/api/ad/${id}/d-sheet/xlsx`);
    assert.equal(dsheet.status, 200);
    const wbx = new ExcelJS.Workbook();
    await wbx.xlsx.load(await dsheet.arrayBuffer());
    const cells = [];
    wbx.worksheets[0].eachRow((row) => cells.push(row.values.join(" ")));
    assert.ok(cells.some((c) => c.includes("2026-11-02")));
    const props = await fetch(`${base}/api/ad/${id}/props-costume/xlsx`);
    const wbp = new ExcelJS.Workbook();
    await wbp.xlsx.load(await props.arrayBuffer());
    const pc = [];
    wbp.worksheets[0].eachRow((row) => pc.push(row.values.join(" ")));
    assert.ok(pc.some((c) => c.includes("brass lamp") && c.includes("red saree")));
    await db.query("DELETE FROM shoot_schedules WHERE scene_list_id = $1", [id]);
    assert.equal((await (await fetch(`${base}/api/ad/${id}/documents`)).json()).planSource, null);
    const loaded = await loadRows(id);
    await db.query("INSERT INTO scheduler_runs (scene_list_id, brief, result, fingerprints) VALUES ($1, $2, $3, $4)", [id, JSON.stringify(brief), JSON.stringify(buildPlan(loaded.rows, { ...brief, days: 1 }, null)), JSON.stringify(sceneFingerprints(loaded.rows))]);
    assert.equal((await (await fetch(`${base}/api/ad/${id}/documents`)).json()).planSource, "smart"); // no shoot schedule: the Smart Scheduler plan is used
    for (const [kind, fmt, type] of [["d-sheet", "pdf", "application/pdf"], ["location-artists", "xlsx", "spreadsheetml"], ["location-schedule", "pdf", "application/pdf"]]) {
      const r = await fetch(`${base}/api/ad/${id}/${kind}/${fmt}`);
      assert.equal(r.status, 200, kind);
      assert.match(r.headers.get("content-type"), new RegExp(type));
      assert.match(r.headers.get("content-disposition"), new RegExp(`\\.${fmt}"`));
      assert.ok((await r.arrayBuffer()).byteLength > 1000);
    }
    assert.equal((await fetch(`${base}/api/ad/${id}/nonsense/pdf`)).status, 404);
    assert.equal((await fetch(`${base}/api/ad/${id}/d-sheet/doc`)).status, 404);
    assert.equal((await fetch(`${base}/api/ad/999999/documents`)).status, 404);
  } finally {
    server.close();
    await db.query("DELETE FROM shoot_schedules WHERE scene_list_id = $1", [id]);
    for (const t of ["scheduler_runs", "scheduler_briefs", "scheduler_name_map", "scheduler_name_dismissed"]) await db.query(`DELETE FROM ${t} WHERE scene_list_id = $1`, [id]);
    await db.query("DELETE FROM scene_lists WHERE id = $1", [id]);
    await db.end();
  }
});

test("the owner's cost categories (costly / normal, free / paid) never appear on any AD paper", () => {
  const planWithCats = { ...plan, artists: [{ name: "SOUMYA", category: "costly" }], locations: [{ name: "TEMPLE", category: "paid" }] };
  for (const d of DOCUMENTS) {
    const spec = buildDocument(d.kind, ctx({ plan: planWithCats }));
    const all = JSON.stringify(spec).toLowerCase();
    assert.ok(!all.includes("costly"), `${d.kind} shows costly`);
    assert.ok(!all.includes('"category"') && !all.includes("free/paid") && !all.includes('"paid"'), `${d.kind} shows a category column`);
  }
});

test('"None" written by the AI is an empty box, not an extra or a prop', () => {
  const noneSheet = rows.map(() => ({ mainCharacters: [], extras: { en: "None" }, property: { en: "N/A" }, costumeRemarks: { en: "none." } }));
  const extras = buildDocument("extras", ctx({ adSheet: noneSheet }));
  assert.ok(!flat(extras).toLowerCase().includes("none"));
  assert.equal(extras.sections[0].rows.length, 1); // only scene 2, from the crowd words in its text
});
