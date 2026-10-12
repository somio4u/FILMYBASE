// Draft Management, phase 1: groups, Draft 1 backfill, copy-on-write branching (Film and AI Movie), alternatives, promotion,
// status protection, saved stage, comparison. REAL Postgres, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { ensureAllProductionSchemas } from "../productionSchema.js";
import { analyzeScreenplay } from "../screenplayAnalysis.js";
import { backfillDrafts, branchDraft, compareDrafts, diffUnits, draftUnits, ensureDraftFor, getDashboard, getDraft, promoteAlternative, registerDraftRoutes, saveResume, updateDraft } from "../drafts.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let server, base, film, ai;
const requireRole = () => (req, res, next) => ((req.user = { id: 1 }), next());
const http = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const J = (v) => JSON.stringify(v);
const scene = (h, text) => ({ sceneHeading: { en: h }, content: [{ type: "action", text: { en: text } }, { type: "dialogue", character: "RAHUL", text: { en: "Stay back." } }] });

async function makeFixtures() {
  await db.query("DELETE FROM concepts WHERE title LIKE '[DR-TEST]%'");
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[DR-TEST]%'");
  film = (await db.query("INSERT INTO concepts (concept_text, storylines, title) VALUES ($1,$2,$3) RETURNING id", ["A keeper fights smugglers.", J([{ title: { en: "The Last Light" } }]), "[DR-TEST] Film"])).rows[0].id;
  const deck = (await db.query("INSERT INTO pitch_decks (concept_id, content, status) VALUES ($1,$2,'approved') RETURNING id", [film, J({ logline: { en: "An old keeper fights smugglers." } })])).rows[0].id;
  await db.query("INSERT INTO character_sheets (pitch_deck_id, content, status) VALUES ($1,$2,'approved')", [deck, J([{ name: "Harbinder", want: { en: "peace" } }])]);
  const act = (await db.query("INSERT INTO three_act_structures (pitch_deck_id, content, status) VALUES ($1,$2,'locked') RETURNING id", [deck, J([{ actName: { en: "Act One" } }])])).rows[0].id;
  const bits = (await db.query("INSERT INTO bit_sheets (three_act_structure_id, content, status) VALUES ($1,$2,'approved') RETURNING id", [act, J({ bits: [{ title: { en: "First boat" } }] })])).rows[0].id;
  const list = (await db.query("INSERT INTO scene_lists (bit_sheet_id, content, status) VALUES ($1,$2,'approved') RETURNING id", [bits, J({ scenes: [{ oneLiner: { en: "A lantern at sea." } }] })])).rows[0].id;
  await db.query("INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content) VALUES ($1,NULL,0,$2)", [list, J({ heading: "EXT. HARBOUR - NIGHT", elements: [{ type: "action", text: "OLD version of the lantern scene." }] })]);
  await db.query("INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content) VALUES ($1,NULL,0,$2)", [list, J({ heading: "EXT. HARBOUR - NIGHT", elements: [{ type: "action", text: "A lantern bobs in the dark." }] })]);
  await db.query("INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content) VALUES ($1,NULL,1,$2)", [list, J({ heading: "INT. LIGHTHOUSE - DAWN", elements: [{ type: "action", text: "Harbinder climbs the stairs." }] })]);
  const backfill = {
    story: { title: { en: "Storm Dancer" } }, synopsis: { logline: { en: "A dancer defies a cyclone." } },
    characterArc: [{ name: "Mala", arc: { en: "fear to courage" } }], threeAct: [{ actName: { en: "Act One" }, description: { en: "The warning." } }], plot: [{ title: { en: "The gust" }, description: { en: "Wind rises." } }],
    screenplayBeats: [{ status: "approved", scenes: [scene("EXT. TEMPLE - DAY", "Mala dances before the storm."), scene("INT. TEMPLE - NIGHT", "Wind shakes the doors.")] }, { status: "generating", generatingSince: "2026-01-01", scenes: null }],
    scriptCheck: { status: "running" },
  };
  ai = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, backfill, assets, stage_status) VALUES ($1,$2,$3,$4,$5) RETURNING id", ["[DR-TEST] AI", "A dancer fights a cyclone.", J(backfill), J({ characters: [{ name: "Mala" }] }), J({ story: { status: "approved" }, synopsis: { status: "approved" }, characterArc: { status: "approved" }, threeAct: { status: "approved" }, plot: { status: "approved" }, screenplay: { status: "approved" } })])).rows[0].id;
  await db.query("INSERT INTO ai_movie_reference_files (project_id, category, label, content) VALUES ($1,'book','Notes','Tribhanga posture.')", [ai]);
}
const snapshotOf = async (table, id) => J((await db.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0]);

test.before(async () => {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS concepts (id SERIAL PRIMARY KEY, concept_text TEXT NOT NULL, storylines JSONB NOT NULL, title TEXT, pinned BOOLEAN NOT NULL DEFAULT false, project_type TEXT NOT NULL DEFAULT 'story', clapboard_banner_path TEXT, owner_user_id INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS pitch_decks (id SERIAL PRIMARY KEY, concept_id INTEGER REFERENCES concepts(id) ON DELETE CASCADE, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS character_sheets (id SERIAL PRIMARY KEY, pitch_deck_id INTEGER REFERENCES pitch_decks(id) ON DELETE CASCADE, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS three_act_structures (id SERIAL PRIMARY KEY, pitch_deck_id INTEGER REFERENCES pitch_decks(id) ON DELETE CASCADE, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS bit_sheets (id SERIAL PRIMARY KEY, three_act_structure_id INTEGER REFERENCES three_act_structures(id) ON DELETE CASCADE, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS scene_lists (id SERIAL PRIMARY KEY, bit_sheet_id INTEGER REFERENCES bit_sheets(id) ON DELETE CASCADE, three_act_structure_id INTEGER, concept_id INTEGER REFERENCES concepts(id) ON DELETE CASCADE, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS screenplay_scenes (id SERIAL PRIMARY KEY, scene_list_id INTEGER REFERENCES scene_lists(id) ON DELETE CASCADE, episode_index INTEGER, scene_index INTEGER NOT NULL, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS ai_movie_projects (id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB, stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS ai_movie_reference_files (id SERIAL PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE, category TEXT NOT NULL DEFAULT 'other', label TEXT, content TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  ]) await db.query(sql);
  assert.deepEqual(await ensureAllProductionSchemas(db), []);
  const app = express();
  app.use(express.json());
  registerDraftRoutes(app, db, requireRole);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => { await makeFixtures(); });
test.after(async () => { server.close(); await db.query("DELETE FROM concepts WHERE title LIKE '[DR-TEST]%'"); await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[DR-TEST]%'"); await db.end(); });

test("an existing project is automatically Draft 1 of its own project, with no change to its data, and doing it twice (or at once) changes nothing", async () => {
  const before = [await snapshotOf("concepts", film), await snapshotOf("ai_movie_projects", ai)];
  const [a, b] = await Promise.all([ensureDraftFor(db, "film", film), ensureDraftFor(db, "film", film)]);
  assert.equal(a.id, b.id, "two simultaneous opens make ONE draft");
  const ai1 = await ensureDraftFor(db, "ai_movie", ai);
  assert.equal(a.draft_number, 1); assert.equal(ai1.draft_number, 1);
  assert.notEqual(a.group_id, ai1.group_id, "Film and AI Movie are never in the same project");
  assert.equal(ai1.status, "approved"); assert.equal(ai1.current_stage, "screenplay");
  assert.equal(a.current_stage, "screenplay");
  assert.deepEqual([await snapshotOf("concepts", film), await snapshotOf("ai_movie_projects", ai)], before, "no project data changed");
  assert.ok((await backfillDrafts(db)) >= 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM project_drafts WHERE module = 'film' AND project_ref = $1", [film])).rows[0].n, 1);
  const dash = await getDashboard(db, "ai_movie", ai);
  assert.equal(dash.drafts.length, 1); assert.equal(dash.drafts[0].title, "Draft 1"); assert.equal(dash.activeDraftId, ai1.id);
  await assert.rejects(ensureDraftFor(db, "film", 987654), /not found/i);
  await assert.rejects(ensureDraftFor(db, "weird", 1), /module/i);
});

test("AI Movie: Draft 2 is an independent copy; Draft 1 (and its production work) is never touched; a running job is not carried over", async () => {
  const d1 = await ensureDraftFor(db, "ai_movie", ai);
  await analyzeScreenplay(db, ai); // Draft 1 has production scenes
  const scenes1 = (await db.query("SELECT count(*)::int AS n FROM production_scenes WHERE project_id = $1", [ai])).rows[0].n;
  assert.ok(scenes1 > 0);
  await db.query("INSERT INTO production_settings (project_id, style_prompt, aspect_ratio) VALUES ($1,'noir','16:9') ON CONFLICT (project_id) DO NOTHING", [ai]);
  const parentBefore = await snapshotOf("ai_movie_projects", ai);
  const d2 = await branchDraft(db, d1.id, { actorUserId: 1 });
  assert.equal(d2.draft_number, 2); assert.equal(d2.parent_draft_id, d1.id); assert.equal(d2.kind, "numbered"); assert.equal(d2.status, "working");
  assert.notEqual(d2.project_ref, ai);
  assert.equal(await snapshotOf("ai_movie_projects", ai), parentBefore, "Draft 1's project row is byte-for-byte unchanged");
  const child = (await db.query("SELECT * FROM ai_movie_projects WHERE id = $1", [d2.project_ref])).rows[0];
  assert.match(child.title, /— Draft 2$/);
  assert.equal(child.backfill.story.title.en, "Storm Dancer");
  assert.equal(child.backfill.scriptCheck, undefined, "a running script check is not copied");
  assert.notEqual(child.backfill.screenplayBeats[1].status, "generating", "a beat that was generating in the parent is not stuck generating in the copy");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM ai_movie_reference_files WHERE project_id = $1", [d2.project_ref])).rows[0].n, 1, "reference files are copied");
  // production isolation
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_scenes WHERE project_id = $1", [d2.project_ref])).rows[0].n, 0, "Draft 2 starts with no production records");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_scenes WHERE project_id = $1", [ai])).rows[0].n, scenes1);
  // editing the copy never changes the parent
  await db.query("UPDATE ai_movie_projects SET backfill = jsonb_set(backfill, '{synopsis,logline,en}', '\"CHANGED\"') WHERE id = $1", [d2.project_ref]);
  assert.equal(await snapshotOf("ai_movie_projects", ai), parentBefore);
  // a third draft can branch from ANY draft, not just the latest
  const d3 = await branchDraft(db, d1.id);
  assert.equal(d3.draft_number, 3); assert.equal(d3.parent_draft_id, d1.id);
  const d4 = await branchDraft(db, d2.id);
  assert.equal(d4.parent_draft_id, d2.id);
  assert.equal((await getDashboard(db, "ai_movie", ai)).drafts.length, 4);
  assert.equal((await getDashboard(db, "ai_movie", d4.project_ref)).drafts.length, 4, "any draft's project row opens the same dashboard");
});

test("Film: Draft 2 copies the latest chain with new ids; older scene versions are not carried; the parent chain is untouched", async () => {
  const d1 = await ensureDraftFor(db, "film", film);
  const before = (await db.query("SELECT (SELECT count(*) FROM pitch_decks WHERE concept_id=$1)::int AS decks, (SELECT count(*) FROM screenplay_scenes ss JOIN scene_lists sl ON sl.id = ss.scene_list_id JOIN bit_sheets b ON b.id = sl.bit_sheet_id JOIN three_act_structures t ON t.id = b.three_act_structure_id JOIN pitch_decks p ON p.id = t.pitch_deck_id WHERE p.concept_id = $1)::int AS scenes", [film])).rows[0];
  const d2 = await branchDraft(db, d1.id, { label: "Villain rewrite" });
  const child = d2.project_ref;
  assert.notEqual(child, film);
  const units = await draftUnits(db, "film", child);
  const parentUnits = await draftUnits(db, "film", film);
  assert.deepEqual(units.map((u) => [u.key, u.hash]), parentUnits.map((u) => [u.key, u.hash]), "same content, as separate rows");
  assert.ok(units.some((u) => u.section === "screenplay" && /lantern bobs/.test(u.text)));
  assert.ok(!units.some((u) => /OLD version/.test(u.text)), "only the newest version of each scene is copied");
  const after = (await db.query("SELECT (SELECT count(*) FROM pitch_decks WHERE concept_id=$1)::int AS decks, (SELECT count(*) FROM screenplay_scenes ss JOIN scene_lists sl ON sl.id = ss.scene_list_id JOIN bit_sheets b ON b.id = sl.bit_sheet_id JOIN three_act_structures t ON t.id = b.three_act_structure_id JOIN pitch_decks p ON p.id = t.pitch_deck_id WHERE p.concept_id = $1)::int AS scenes", [film])).rows[0];
  assert.deepEqual(after, before, "the parent chain gained and lost nothing");
  const copiedStatuses = (await db.query("SELECT pd.status AS deck, (SELECT status FROM three_act_structures WHERE pitch_deck_id = pd.id LIMIT 1) AS act FROM pitch_decks pd WHERE concept_id = $1", [child])).rows[0];
  assert.deepEqual(copiedStatuses, { deck: "approved", act: "locked" }, "approvals carry over");
  assert.equal(d2.label, "Villain rewrite");
  await db.query("DELETE FROM concepts WHERE id = $1", [child]); // deleting a draft's project leaves the parent alone
  assert.equal((await draftUnits(db, "film", film)).length, parentUnits.length);
  assert.equal((await getDashboard(db, "film", film)).drafts.length, 1, "a deleted draft's project drops out of the dashboard");
});

test("alternatives take no draft number until promoted; promotion gives the next number once", async () => {
  const d1 = await ensureDraftFor(db, "ai_movie", ai);
  const alt = await branchDraft(db, d1.id, { kind: "alternative", note: "villain survives" });
  assert.equal(alt.draft_number, null); assert.equal(alt.kind, "alternative");
  const d2 = await branchDraft(db, d1.id);
  assert.equal(d2.draft_number, 2, "the alternative did not use a number");
  const promoted = await promoteAlternative(db, alt.id, { label: "Villain survives" });
  assert.equal(promoted.draft_number, 3); assert.equal(promoted.kind, "numbered");
  assert.match((await db.query("SELECT title FROM ai_movie_projects WHERE id = $1", [alt.project_ref])).rows[0].title, /— Draft 3$/);
  await assert.rejects(promoteAlternative(db, alt.id), /Only an alternative/);
  await assert.rejects(branchDraft(db, d1.id, { kind: "weird" }), /kind/);
});

test("status protection: archive needs confirmation, the last draft cannot be archived, stale edits are refused, archived drafts cannot be branched", async () => {
  const d1 = await ensureDraftFor(db, "ai_movie", ai);
  await assert.rejects(updateDraft(db, d1.id, { status: "archived" }), /Confirm/);
  await assert.rejects(updateDraft(db, d1.id, { status: "archived", confirm: true }), /last remaining/);
  const d2 = await branchDraft(db, d1.id);
  const locked = await updateDraft(db, d2.id, { status: "locked" });
  assert.equal(locked.status, "locked"); assert.equal(locked.approval.status, "locked");
  await assert.rejects(updateDraft(db, d2.id, { label: "x", expectedRevision: locked.revision - 1 }), /changed since you loaded/);
  assert.equal((await updateDraft(db, d2.id, { label: "Final cut", expectedRevision: locked.revision })).label, "Final cut");
  await updateDraft(db, d2.id, { status: "archived", confirm: true });
  await assert.rejects(branchDraft(db, d2.id), /archived/);
  await assert.rejects(updateDraft(db, d2.id, { status: "nonsense" }), /status must be/);
});

test("saved stage and context: a draft remembers where it was, and the project remembers the last draft used", async () => {
  const d1 = await ensureDraftFor(db, "ai_movie", ai);
  const d2 = await branchDraft(db, d1.id);
  const r = await saveResume(db, d2.id, { stage: "screenplay", context: { sceneKey: "b0s1", beat: 0 } });
  assert.equal(r.current_stage, "screenplay"); assert.deepEqual(r.resume_context, { sceneKey: "b0s1", beat: 0 });
  const dash = await getDashboard(db, "ai_movie", ai);
  assert.equal(dash.activeDraftId, d2.id);
  assert.deepEqual(dash.drafts.find((d) => d.id === d2.id).resumeContext, { sceneKey: "b0s1", beat: 0 });
  assert.ok(dash.drafts.find((d) => d.id === d2.id).lastOpenedAt);
});

test("comparison marks preserved, modified, added and removed sections", async () => {
  const d1 = await ensureDraftFor(db, "ai_movie", ai);
  const d2 = await branchDraft(db, d1.id);
  await db.query(`UPDATE ai_movie_projects SET backfill = jsonb_set(jsonb_set(backfill, '{screenplayBeats,0,scenes,1,content,0,text,en}', '"Rain hammers the temple doors."'), '{plot}', (backfill->'plot') || '[{"title":{"en":"New twist"},"description":{"en":"The villain returns."}}]'::jsonb) WHERE id = $1`, [d2.project_ref]);
  await db.query("UPDATE ai_movie_projects SET backfill = jsonb_set(backfill, '{characterArc}', '[]'::jsonb) WHERE id = $1", [d2.project_ref]);
  const cmp = await compareDrafts(db, d1.id, d2.id);
  const by = (k) => cmp.rows.find((r) => r.key === k);
  assert.equal(by("b0s1").status, "modified"); assert.match(by("b0s1").after, /Rain hammers/); assert.match(by("b0s1").before, /Wind shakes/);
  assert.equal(by("b0s0").status, "preserved");
  assert.equal(by("beat1").status, "added");
  assert.equal(by("char0").status, "removed");
  assert.deepEqual(cmp.counts, { preserved: cmp.counts.preserved, modified: 1, added: 1, removed: 1 });
  assert.deepEqual(diffUnits([{ key: "a", hash: "1", text: "x", section: "s", label: "a" }], [{ key: "a", hash: "1", text: "x", section: "s", label: "a" }]).counts, { preserved: 1, modified: 0, added: 0, removed: 0 });
  const filmD = await ensureDraftFor(db, "film", film);
  await assert.rejects(compareDrafts(db, d1.id, filmD.id), /different modules/);
});

test("routes: dashboard, branch, promote, patch, resume, compare — plain errors, nothing for the wrong module", async () => {
  const dash = await http("GET", `/api/drafts?module=ai_movie&projectRef=${ai}`);
  assert.equal(dash.status, 200);
  const d1 = dash.json.drafts[0].id;
  assert.equal((await http("GET", "/api/drafts?module=film")).status, 400);
  const b = await http("POST", `/api/drafts/${d1}/branch`, { kind: "alternative", label: "Try villain survives" });
  assert.equal(b.status, 201); assert.equal(b.json.draft.draftNumber, null);
  assert.equal((await http("POST", `/api/drafts/${b.json.draft.id}/promote`, {})).json.draft.draftNumber, 2);
  assert.equal((await http("PUT", `/api/drafts/${b.json.draft.id}/resume`, { stage: "synopsis", context: { x: 1 } })).json.draft.currentStage, "synopsis");
  assert.equal((await http("PATCH", `/api/drafts/${b.json.draft.id}`, { status: "archived" })).status, 409);
  const cmp = await http("GET", `/api/drafts/compare?a=${d1}&b=${b.json.draft.id}`);
  assert.equal(cmp.status, 200); assert.ok(cmp.json.counts.preserved > 0);
  assert.equal((await http("POST", "/api/drafts/999999/branch", {})).status, 404);
  assert.equal((await http("GET", "/api/drafts/compare?a=1")).status, 400);
});
