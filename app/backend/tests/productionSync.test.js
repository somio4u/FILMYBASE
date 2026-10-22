import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { castCheck, mergeAvailability, registerProductionSyncRoutes } from "../productionSync.js";
import { createJobStore, ensureJobSchema, shouldResume, MAX_RESUMES } from "../jobStore.js";

test("availability typed for the old script is kept for names that still exist, new names are unknown", () => {
  const prev = { startDate: "2026-11-01", characters: [{ name: "Soumya", availableDates: "1-5 Nov" }, { name: "Gone", unknown: true }], locations: [{ location: "Temple", availableDates: "all" }] };
  const merged = mergeAvailability(prev, ["SOUMYA", "Ravi"], ["TEMPLE", "Clinic"]);
  assert.equal(merged.startDate, "2026-11-01");
  assert.deepEqual(merged.characters, [{ name: "Soumya", availableDates: "1-5 Nov" }, { name: "Ravi", unknown: true }]);
  assert.deepEqual(merged.locations, [{ location: "Temple", availableDates: "all" }, { location: "Clinic", unknown: true }]);
  assert.deepEqual(mergeAvailability(undefined, ["A"], []).characters, [{ name: "A", unknown: true }]);
});

test("cast check: characters with no actor, and actors whose character is gone", () => {
  const r = castCheck(["Soumya", "Ravi", "New One"], [{ character_name: "SOUMYA", name: "Anu" }, { character_name: "Old One", name: "Bibhu" }, { character_name: null, name: "Extra" }]);
  assert.deepEqual(r.withoutActor, ["Ravi", "New One"]);
  assert.deepEqual(r.orphanedActors, [{ character: "Old One", actor: "Bibhu" }]);
});

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let up = true;
try { await db.query("SELECT 1"); } catch { up = false; }

test("sync job: rebuilds breakdown + AD sheet + schedule from the CURRENT screenplay, keeps approval, completed days and the cast", { skip: !up }, async () => {
  await ensureJobSchema(db);
  await db.query("DELETE FROM background_jobs"); // resume() looks at every project: start from a clean list
  await db.query("CREATE TABLE IF NOT EXISTS script_breakdowns (id SERIAL PRIMARY KEY, scene_list_id INTEGER, content JSONB, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ DEFAULT now())");
  await db.query("CREATE TABLE IF NOT EXISTS shoot_schedules (id SERIAL PRIMARY KEY, scene_list_id INTEGER, content JSONB, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ DEFAULT now())");
  await db.query("CREATE TABLE IF NOT EXISTS crew_members (id SERIAL PRIMARY KEY, scene_list_id INTEGER, category TEXT, character_name TEXT, name TEXT, contact_number TEXT)");
  const content = { scenes: [{ intExt: "INT", location: { en: "Temple" }, oneLiner: { en: "new scene one" } }, { intExt: "EXT", location: { en: "River" }, oneLiner: { en: "new scene two" } }] };
  const id = (await db.query("INSERT INTO scene_lists (content, status) VALUES ($1, 'approved') RETURNING id", [JSON.stringify(content)])).rows[0].id;
  await db.query("INSERT INTO script_breakdowns (scene_list_id, content, status) VALUES ($1, $2, 'approved')", [id, JSON.stringify({ artistList: [{ label: "OLD HERO" }] })]);
  const completed = { dayNumber: 1, completed: true, sceneRefs: [{ episodeIndex: null, sceneIndex: 0 }] };
  await db.query("INSERT INTO shoot_schedules (scene_list_id, content, status) VALUES ($1, $2, 'approved')", [id, JSON.stringify({ scheduleDays: [completed], availability: { characters: [{ name: "OLD HERO", availableDates: "x" }], locations: [] }, targetDays: 7, specialInstructions: "no night shoots" })]);
  await db.query("INSERT INTO crew_members (scene_list_id, category, character_name, name) VALUES ($1, 'artist', 'ANU', 'Anu Actor'), ($1, 'artist', 'OLD HERO', 'Old Actor')", [id]);

  const seen = {};
  const tools = {
    jobStore: createJobStore(db),
    requireRole: () => (req, res, next) => { req.user = { id: 1 }; next(); },
    userOwnsSceneList: async () => true,
    buildBreakdownSourceText: async () => "THE NEW SCREENPLAY TEXT",
    generateDeepScriptBreakdownContent: async (text) => { if (seen.fail) throw new Error("AI unavailable"); seen.text = text; return { artistList: [{ label: "ANU", tier: "lead" }, { label: "NEW HERO" }], locationList: [{ location: { en: "Temple" } }, { location: { en: "River" } }] }; },
    flattenScenesForAdSheet: (sl) => sl.scenes.map((s, i) => ({ sceneNumber: String(i + 1) })),
    generateAdSheetDetails: async (entries) => entries.map(() => ({ mainCharacters: ["ANU"], extras: { en: "crowd" }, property: { en: "" }, costumeRemarks: { en: "" } })),
    fetchCharacterNamesForSceneList: async () => ["ANU", "NEW HERO"],
    generateShootScheduleContent: async (sl, names, availability, targetDays, rev, opts) => { seen.schedule = { names, availability, targetDays, opts }; return { scheduleDays: [...opts.completedDays, { dayNumber: 2, sceneRefs: [{ sceneIndex: 1 }] }], availability, targetDays, specialInstructions: opts.specialInstructions }; },
  };
  const app = express(); app.use(express.json());
  const sync = registerProductionSyncRoutes(app, db, tools);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { jobId } = await (await fetch(`${base}/api/scene-lists/${id}/sync-production`, { method: "POST" })).json();
    // a page opened (or reloaded) while the job runs can pick it up again, with the live note of the step in progress
    const live = await (await fetch(`${base}/api/scene-lists/${id}/sync-production/current`)).json();
    assert.equal(live.jobId, jobId);
    assert.ok(["running", "done"].includes(live.status));
    assert.ok(live.startedAt && live.now);
    let st;
    for (let i = 0; i < 50; i++) { st = await (await fetch(`${base}/api/scene-lists/${id}/sync-production/${jobId}`)).json(); if (st.status !== "running") break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(st.status, "done", JSON.stringify(st));
    assert.deepEqual(st.steps.map((s) => s.state), ["done", "done", "done", "done"]);
    assert.equal(seen.text, "THE NEW SCREENPLAY TEXT");
    const bd = (await db.query("SELECT content, status, feedback FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY id DESC LIMIT 1", [id])).rows[0];
    assert.equal(bd.status, "approved"); // approval carried over
    assert.deepEqual(bd.content.artistList.map((a) => a.label), ["ANU", "NEW HERO"]);
    assert.equal(bd.content.artistList[0].tier, "lead");
    assert.equal(bd.content.adSheet.length, 2);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM script_breakdowns WHERE scene_list_id = $1", [id])).rows[0].n, 2); // old kept as history
    const sch = (await db.query("SELECT content, status FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY id DESC LIMIT 1", [id])).rows[0];
    assert.equal(sch.status, "approved");
    assert.equal(sch.content.scheduleDays.length, 2);
    assert.equal(seen.schedule.targetDays, 7);
    assert.equal(seen.schedule.opts.specialInstructions, "no night shoots");
    assert.equal(seen.schedule.opts.completedDays.length, 1); // the shot day is kept
    assert.deepEqual(seen.schedule.availability.characters.map((c) => c.name), ["ANU", "NEW HERO"]);
    assert.deepEqual(st.cast.withoutActor, ["NEW HERO"]);
    assert.deepEqual(st.cast.orphanedActors, [{ character: "OLD HERO", actor: "Old Actor" }]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM crew_members WHERE scene_list_id = $1", [id])).rows[0].n, 2); // the cast is untouched

    // no schedule yet: that step is skipped, the rest runs
    await db.query("DELETE FROM shoot_schedules WHERE scene_list_id = $1", [id]);
    const again = await (await fetch(`${base}/api/scene-lists/${id}/sync-production`, { method: "POST" })).json();
    for (let i = 0; i < 50; i++) { st = await (await fetch(`${base}/api/scene-lists/${id}/sync-production/${again.jobId}`)).json(); if (st.status !== "running") break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(st.steps[2].state, "skipped");
    assert.equal(st.status, "done");

    // a SERVER RESTART in the middle: the job was running when the old server stopped; the new server starts it again by itself
    await db.query("DELETE FROM script_breakdowns WHERE scene_list_id = $1", [id]);
    const orphan = { id: "orphan-job-1", sceneListId: id, status: "running", startedAt: Date.now() - 5 * 60 * 1000, steps: [{ key: "breakdown", label: "x", state: "working", note: "half way" }], cast: null, error: null, notice: "", resumes: 0 };
    await tools.jobStore.insert(orphan.id, "sync", id, "", orphan);
    const beforeRestart = await (await fetch(`${base}/api/scene-lists/${id}/sync-production/${orphan.id}`)).json();
    assert.equal(beforeRestart.status, "running"); // the screen can still see it (from the database) before the new server resumes it
    await sync.resume();
    for (let i = 0; i < 50; i++) { st = await (await fetch(`${base}/api/scene-lists/${id}/sync-production/${orphan.id}`)).json(); if (st.status !== "running") break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(st.status, "done", JSON.stringify(st));
    assert.match(st.notice, /restarted .* started again from the beginning — restart 1/);
    assert.equal(st.steps[0].state, "done");
    assert.ok((await db.query("SELECT count(*)::int AS n FROM script_breakdowns WHERE scene_list_id = $1", [id])).rows[0].n >= 1); // the work was really done again
    // and after yet another restart the finished job is simply there, not run a second time
    const cur = await (await fetch(`${base}/api/scene-lists/${id}/sync-production/current`)).json();
    assert.equal(cur.status, "done");

    // a job interrupted too many times is given up with a plain message, not started again forever
    const tired = { ...orphan, id: "orphan-job-2" };
    await tools.jobStore.insert(tired.id, "sync", id, "", tired);
    await db.query("UPDATE background_jobs SET resumes = $2 WHERE id = $1", [tired.id, MAX_RESUMES]);
    await sync.resume();
    const gaveUp = await (await fetch(`${base}/api/scene-lists/${id}/sync-production/${tired.id}`)).json();
    assert.equal(gaveUp.status, "error");
    assert.match(gaveUp.error, /given up/);

    // a failing breakdown leaves everything as it was and says so
    seen.fail = true;
    const before = (await db.query("SELECT count(*)::int AS n FROM script_breakdowns WHERE scene_list_id = $1", [id])).rows[0].n;
    const bad = await (await fetch(`${base}/api/scene-lists/${id}/sync-production`, { method: "POST" })).json();
    for (let i = 0; i < 50; i++) { st = await (await fetch(`${base}/api/scene-lists/${id}/sync-production/${bad.jobId}`)).json(); if (st.status !== "running") break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(st.status, "error", JSON.stringify({ bad, st }).slice(0, 600));
    assert.match(st.error, /AI unavailable/);
    assert.equal(st.steps[0].state, "error");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM script_breakdowns WHERE scene_list_id = $1", [id])).rows[0].n, before);
    assert.equal((await fetch(`${base}/api/scene-lists/${id}/sync-production/nope`)).status, 404);
  } finally {
    server.close();
    for (const t of ["script_breakdowns", "shoot_schedules", "crew_members", "background_jobs"]) await db.query(`DELETE FROM ${t} WHERE scene_list_id = $1`, [id]);
    await db.query("DELETE FROM scene_lists WHERE id = $1", [id]);
    await db.end();
  }
});

test("which interrupted jobs are started again: not too many times, not when very old", () => {
  assert.deepEqual(shouldResume({ resumes: 0, startedAt: Date.now() - 60000 }), { resume: true });
  assert.equal(shouldResume({ resumes: MAX_RESUMES, startedAt: Date.now() }).resume, false);
  assert.equal(shouldResume({ resumes: 0, startedAt: Date.now() - 4 * 60 * 60 * 1000 }).resume, false);
});
