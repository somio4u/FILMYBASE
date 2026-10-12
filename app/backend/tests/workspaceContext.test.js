// Workspace Reader: the Auto Screenplay agent can look through Film projects and AI Movie projects (read-only).
// REAL Postgres. The Film tables are created here in minimal form if this test database does not have them yet.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { flatten, listSources, findRelated, readSource, buildReferenceBlock, ideaWithReferences, registerWorkspaceRoutes } from "../workspaceContext.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let server, base, filmId, aiId;
const requireRole = () => (req, res, next) => ((req.user = { id: 1 }), next());
const get = async (url, method = "GET", body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};

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
  await db.query("DELETE FROM concepts WHERE title LIKE '[WS-TEST]%'");
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[WS-TEST]%'");
  filmId = (await db.query("INSERT INTO concepts (concept_text, storylines, title) VALUES ($1,$2,$3) RETURNING id", ["A retired lighthouse keeper discovers smugglers using the abandoned harbour at night.", JSON.stringify([{ title: { en: "The Last Light" } }]), "[WS-TEST] The Last Light"])).rows[0].id;
  const deck = (await db.query("INSERT INTO pitch_decks (concept_id, content) VALUES ($1,$2) RETURNING id", [filmId, JSON.stringify({ logline: { en: "An old keeper fights smugglers in a storm.", hi: "x" }, premise: { en: "Lighthouse smugglers harbour conflict." } })])).rows[0].id;
  await db.query("INSERT INTO character_sheets (pitch_deck_id, content) VALUES ($1,$2)", [deck, JSON.stringify([{ name: "Harbinder", want: { en: "peace" }, id: 77 }])]);
  const act = (await db.query("INSERT INTO three_act_structures (pitch_deck_id, content) VALUES ($1,$2) RETURNING id", [deck, JSON.stringify([{ actName: { en: "Act One" }, description: { en: "Smugglers arrive." } }])])).rows[0].id;
  const bits = (await db.query("INSERT INTO bit_sheets (three_act_structure_id, content) VALUES ($1,$2) RETURNING id", [act, JSON.stringify({ bits: [{ title: { en: "The first boat" } }] })])).rows[0].id;
  const list = (await db.query("INSERT INTO scene_lists (bit_sheet_id, content) VALUES ($1,$2) RETURNING id", [bits, JSON.stringify({ scenes: [{ oneLiner: { en: "Harbinder spots a lantern at sea." } }] })])).rows[0].id;
  await db.query("INSERT INTO screenplay_scenes (scene_list_id, scene_index, content) VALUES ($1,0,$2)", [list, JSON.stringify({ heading: "EXT. HARBOUR - NIGHT", elements: [{ type: "action", text: "A lantern bobs in the dark." }] })]);
  await db.query("INSERT INTO screenplay_scenes (scene_list_id, scene_index, content) VALUES ($1,0,$2)", [list, JSON.stringify({ heading: "EXT. HARBOUR - NIGHT", elements: [{ type: "action", text: "A lantern bobs in the dark, closer now." }] })]); // newer version of scene 0
  aiId = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, backfill, assets) VALUES ($1,$2,$3,$4) RETURNING id", ["[WS-TEST] Tandava Storm", "A dancer fights a cyclone to save her village temple.", JSON.stringify({ synopsis: { logline: { en: "A dancer defies a cyclone." } }, story: { title: { en: "Storm Dancer" } }, screenplayBeats: [{ title: { en: "The first gust" } }] }), JSON.stringify({ characters: [{ name: "Mala", description: "temple dancer" }] })])).rows[0].id;
  await db.query("INSERT INTO ai_movie_reference_files (project_id, category, label, content) VALUES ($1,'book','Odissi notes','Tribhanga posture and temple ritual.')", [aiId]);
  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, db, requireRole);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await db.query("DELETE FROM concepts WHERE title LIKE '[WS-TEST]%'"); await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[WS-TEST]%'"); await db.end(); });

test("flatten reads bilingual objects, arrays and nested sections as plain text, and skips ids", () => {
  assert.equal(flatten({ en: "Hello", hi: "नमस्ते" }), "Hello");
  assert.match(flatten({ logline: { en: "A" }, id: 5, nested: [{ name: "X" }, { name: "Y" }] }), /logline: A[\s\S]*name: X/);
  assert.doesNotMatch(flatten({ id: 5, url: "http://x", real: "yes" }), /id:|url:/);
  assert.equal(flatten(null), "");
});

test("every Film project and every AI Movie project is visible, with what each one has", async () => {
  const all = await listSources(db);
  assert.ok(all.some((s) => s.kind === "film" && s.id === filmId && /Last Light/.test(s.title)));
  assert.ok(all.some((s) => s.kind === "ai_movie" && s.id === aiId));
  const film = await readSource(db, "film", filmId);
  assert.deepEqual(film.available.map((a) => a.key).sort(), ["beats", "characters", "idea", "sceneList", "screenplay", "structure", "synopsis"].sort());
  assert.match(film.parts.idea, /lighthouse keeper/);
  assert.match(film.parts.synopsis, /An old keeper fights smugglers/);
  assert.doesNotMatch(film.parts.synopsis, /x$/, "the English text is used, not the second language");
  assert.match(film.parts.characters, /Harbinder/);
  assert.doesNotMatch(film.parts.characters, /77/, "ids are not shown");
  assert.match(film.parts.screenplay, /closer now/, "the newest version of a scene is the one read");
  assert.doesNotMatch(film.parts.screenplay, /dark\.\s*\n?[\s\S]*A lantern bobs in the dark\.$/, "older versions are not repeated");
  const ai = await readSource(db, "ai_movie", aiId);
  assert.match(ai.parts.idea, /cyclone/); assert.match(ai.parts.story, /Storm Dancer/); assert.match(ai.parts.assets, /Mala/); assert.match(ai.parts.reference, /Tribhanga/);
  assert.equal(await readSource(db, "film", 999999), null);
  assert.equal(await readSource(db, "nonsense", 1), null);
  const only = await readSource(db, "film", filmId, { parts: ["idea"] });
  assert.deepEqual(Object.keys(only.parts), ["idea"]);
});

test("related projects are found by real shared words, not by guessing", async () => {
  const hit = await findRelated(db, "A lighthouse keeper in a storm catches smugglers hiding at the harbour");
  assert.ok(hit.some((h) => h.kind === "film" && h.id === filmId), "the lighthouse project is found");
  assert.ok(!hit.some((h) => h.kind === "ai_movie" && h.id === aiId));
  assert.deepEqual(await findRelated(db, "Two astronauts argue about a toaster"), [], "no overlap = nothing found");
  assert.ok(!(await findRelated(db, "lighthouse keeper smugglers harbour", { exclude: [{ kind: "film", id: filmId }] })).some((h) => h.id === filmId), "excluded projects are skipped");
});

test("the reference block is bounded, labelled, read-only material that says the new idea stays in charge, and records what was used", async () => {
  const block = await buildReferenceBlock(db, [{ kind: "film", id: filmId, parts: ["idea", "characters"], how: "chosen" }, { kind: "ai_movie", id: aiId, how: "found by the agent" }, { kind: "film", id: 424242 }]);
  assert.match(block.text, /NEW IDEA above is in charge/);
  assert.match(block.text, /From "\[WS-TEST\] The Last Light"/);
  assert.match(block.text, /Harbinder/);
  assert.doesNotMatch(block.text, /EXT\. HARBOUR/, "only the chosen parts of that project were read");
  assert.match(block.text, /Storm Dancer/);
  assert.deepEqual(block.used.map((u) => [u.kind, u.id, u.how]), [["film", filmId, "chosen"], ["ai_movie", aiId, "found by the agent"]], "a missing project is skipped, and what was used is recorded");
  assert.ok(block.text.length < 16000);
  assert.equal((await buildReferenceBlock(db, [])).text, "");
  assert.equal(ideaWithReferences("my idea", ""), "my idea");
  assert.match(ideaWithReferences("my idea", block.text), /^my idea\n\nREFERENCE MATERIAL/);
  // huge sources are cut
  await db.query("UPDATE ai_movie_projects SET pasted_text = $2 WHERE id = $1", [aiId, "word ".repeat(20000)]);
  const big = await buildReferenceBlock(db, [{ kind: "ai_movie", id: aiId }, { kind: "film", id: filmId }]);
  assert.ok(big.text.length < 16000, `${big.text.length}`);
});

test("routes are read-only JSON: catalogue with search, one project's parts, related", async () => {
  const cat = await get("/api/workspace/sources?q=lighthouse smugglers");
  assert.equal(cat.status, 200);
  assert.equal(cat.json.sources[0].id, filmId, "the best match is first");
  assert.ok(cat.json.parts.screenplay);
  const one = await get(`/api/workspace/sources/film/${filmId}?parts=idea,synopsis`);
  assert.deepEqual(Object.keys(one.json.parts).sort(), ["idea", "synopsis"]);
  assert.equal((await get("/api/workspace/sources/film/999999")).status, 404);
  assert.equal((await get("/api/workspace/sources/bad/1")).status, 400);
  const rel = await get("/api/workspace/related", "POST", { idea: "lighthouse keeper and smugglers at the old harbour" });
  assert.ok(rel.json.related.some((r) => r.id === filmId));
  const before = (await db.query("SELECT count(*)::int AS n FROM concepts")).rows[0].n;
  await get("/api/workspace/sources?q=x");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM concepts")).rows[0].n, before, "nothing is ever written");
});
