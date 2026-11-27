import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { aiMovieToFilm, filmToAiMovie, filmEpisodeFromAiMovie, chooseLanguage, aiMovieBackfillFromFilm } from "../convertProject.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const J = JSON.stringify;
const both = (t) => ({ en: t, hi: t });
const scene = (n) => ({ sceneHeading: { en: `INT. ROOM ${n} - DAY`, hi: `INT. ROOM ${n} - DAY` }, estimatedMinutes: 2, content: [
  { type: "action", text: { en: `Raju enters room ${n}.`, hi: `राजू कमरा ${n} में आता है।` } },
  { type: "dialogue", character: "RAJU", line: { en: `Hello ${n}.`, hi: `नमस्ते ${n}।` }, parenthetical: { en: "softly", hi: "धीरे से" } },
  { type: "dialogue", character: "MEERA", line: { en: `Bye ${n}.`, hi: `अलविदा ${n}।` } },
] });
let aiId; const made = { concepts: [], ai: [] };
test.before(async () => {
  const backfill = { story: { title: both("Akhada") }, synopsis: { en: "A wrestler returns.", hi: "एक पहलवान लौटता है।" }, characterArc: [{ name: "Raju" }, { name: "Meera" }, { name: "Guru" }],
    plot: [{ title: both("B1"), runtimeMinutes: 5 }, { title: both("B2"), runtimeMinutes: 5 }], screenplayBeats: [{ status: "approved", scenes: [scene(1), scene(2), scene(3)] }, { status: "approved", scenes: [scene(4), scene(5), scene(6), scene(7), scene(8)] }] };
  aiId = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, backfill, stage_status) VALUES ('[CONVERT-TEST] Akhada','x',$1,$2) RETURNING id", [J(backfill), J({ screenplay: { status: "approved" } })])).rows[0].id;
});
test.after(async () => {
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[CONVERT-TEST]%'");
  await db.query("DELETE FROM concepts WHERE title LIKE '[CONVERT-TEST]%'");
  await db.end();
});

test("the language with the most text is chosen", () => {
  assert.equal(chooseLanguage({ screenplayBeats: [{ scenes: [scene(1)] }] }), "en", "equal counts: English");
  assert.equal(chooseLanguage({ screenplayBeats: [{ scenes: [{ content: [{ type: "action", text: { hi: "क" } }, { type: "action", text: { hi: "ख" } }] }] }] }), "hi");
});

test("AI Movie scenes become a film episode word for word: heading, action, dialogue with its bracket, in order", () => {
  const ep = filmEpisodeFromAiMovie({ screenplayBeats: [{ scenes: [scene(1), scene(2)] }] }, "en");
  assert.equal(ep.scenes.length, 2);
  assert.deepEqual(ep.scenes[0].elements.map((e) => `${e.type}:${e.character}:${e.text}`), ["action::Raju enters room 1.", "dialogue:RAJU:Hello 1.", "dialogue:MEERA:Bye 1."]);
  assert.equal(ep.scenes[0].elements[1].parenthetical, "softly");
  assert.equal(ep.scenes[0].intExt, "INT"); assert.equal(ep.scenes[0].location, "ROOM 1"); assert.equal(ep.scenes[0].timeOfDay, "DAY");
  assert.deepEqual(ep.scenes[0].characters, ["RAJU", "MEERA"]);
  const hi = filmEpisodeFromAiMovie({ screenplayBeats: [{ scenes: [scene(1)] }] }, "hi");
  assert.equal(hi.scenes[0].elements[1].text, "नमस्ते 1।");
});

test("AI Movie -> Movie: a normal film project appears (deck, characters, scene list, written scenes), the AI Movie is untouched", async () => {
  const out = await aiMovieToFilm(db, aiId, { language: "en" });
  made.concepts.push(out.projectRef);
  assert.equal(out.module, "film"); assert.equal(out.scenes, 8);
  const list = (await db.query("SELECT sl.id, sl.content, sl.status FROM scene_lists sl JOIN bit_sheets bs ON bs.id = sl.bit_sheet_id JOIN three_act_structures t ON t.id = bs.three_act_structure_id JOIN pitch_decks pd ON pd.id = t.pitch_deck_id WHERE pd.concept_id = $1", [out.projectRef])).rows[0];
  assert.equal(list.status, "approved"); assert.equal(list.content.scenes.length, 8);
  const rows = (await db.query("SELECT scene_index, content FROM screenplay_scenes WHERE scene_list_id = $1 ORDER BY scene_index", [list.id])).rows;
  assert.equal(rows.length, 8);
  assert.equal(rows[0].content.elements[1].text, "Hello 1.");
  assert.equal(rows[0].content.elements[1].character, "RAJU");
  const deck = (await db.query("SELECT content FROM pitch_decks WHERE concept_id = $1", [out.projectRef])).rows[0].content;
  assert.equal(deck.format.type, "film"); assert.match(deck.logline.en, /wrestler/);
  const sheet = (await db.query("SELECT cs.content FROM character_sheets cs JOIN pitch_decks pd ON pd.id = cs.pitch_deck_id WHERE pd.concept_id = $1", [out.projectRef])).rows[0].content;
  assert.ok(["RAJU", "MEERA"].every((n) => sheet.characters.some((c) => c.name === n)) && sheet.characters.some((c) => c.name === "Guru"));
  const untouched = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [aiId])).rows[0].backfill;
  assert.equal(untouched.screenplayBeats.reduce((n, b) => n + b.scenes.length, 0), 8);
});

test("Movie -> AI Movie: the written scenes become four beats with the same words; a project with nothing written says so", async () => {
  const film = made.concepts[0];
  const out = await filmToAiMovie(db, film, { actorUserId: null });
  made.ai.push(out.projectRef);
  assert.equal(out.module, "ai_movie"); assert.equal(out.scenes, 8); assert.equal(out.scenesLeftOut, 0);
  const row = (await db.query("SELECT title, backfill, stage_status FROM ai_movie_projects WHERE id = $1", [out.projectRef])).rows[0];
  assert.equal(row.backfill.screenplayBeats.length, 4);
  assert.equal(row.backfill.screenplayBeats.reduce((n, b) => n + b.scenes.length, 0), 8);
  const first = row.backfill.screenplayBeats[0].scenes[0];
  assert.equal(first.sceneHeading.en, "INT. ROOM 1 - DAY");
  assert.equal(first.content[1].character, "RAJU"); assert.equal(first.content[1].line.en, "Hello 1."); assert.equal(first.content[1].parenthetical.en, "softly");
  assert.equal(row.stage_status.screenplay.status, "approved");
  assert.equal(row.backfill.plot.length, 4);
  assert.ok(row.backfill.characterArc.some((c) => c.name === "Guru") || row.backfill.characterArc.length >= 2);
  await db.query("UPDATE ai_movie_projects SET title = '[CONVERT-TEST] copy' WHERE id = $1", [out.projectRef]);
  await assert.rejects(() => aiMovieToFilm(db, 999999999), /not found/);
  const empty = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, backfill) VALUES ('[CONVERT-TEST] empty','x',$1) RETURNING id", [J({ screenplayBeats: [] })])).rows[0].id;
  await assert.rejects(() => aiMovieToFilm(db, empty), /no written scenes/);
});

test("the back-conversion keeps only scenes that really have lines and says how many were left out", () => {
  const b = aiMovieBackfillFromFilm({ title: "T", deck: {}, characterNames: ["A"], outlines: [{ intExt: "INT", location: both("X"), timeOfDay: "DAY", estimatedMinutes: 2 }, { intExt: "EXT", location: both("Y"), timeOfDay: "NIGHT", estimatedMinutes: 2 }], written: new Map([[0, { elements: [{ type: "action", text: "A thing." }] }]]) });
  assert.equal(b.scenesLeftOut, 1);
  assert.equal(b.screenplayBeats.reduce((n, x) => n + x.scenes.length, 0), 1);
  assert.equal(b.screenplayBeats.length, 1, "one scene: one beat, never an empty beat");
  assert.throws(() => aiMovieBackfillFromFilm({ title: "T", deck: {}, characterNames: [], outlines: [], written: new Map() }), /no written scenes/);
});
