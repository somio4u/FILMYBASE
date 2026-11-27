import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { aiMovieToFilm, filmToAiMovie } from "../convertProject.js";
import { ensureProjectLinkSchema, syncAllLinks, mergeFilmIntoAiBeats } from "../projectLinks.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const J = JSON.stringify;
const both = (t) => ({ en: t, hi: t });
const scene = (n) => ({ sceneHeading: both(`INT. ROOM ${n} - DAY`), estimatedMinutes: 2, card: { keep: `card ${n}` }, content: [
  { type: "action", text: both(`Raju enters room ${n}.`) },
  { type: "dialogue", character: "RAJU", line: both(`Hello ${n}.`) },
  { type: "dialogue", character: "MEERA", line: both(`Bye ${n}.`) },
] });
const fresh = async () => {
  const backfill = { story: { title: both("T") }, synopsis: both("S"), characterArc: [{ name: "Raju" }], plot: [{ title: both("B1"), runtimeMinutes: 5 }, { title: both("B2"), runtimeMinutes: 5 }],
    screenplayBeats: [{ status: "approved", scenes: [scene(1), scene(2)] }, { status: "approved", scenes: [scene(3), scene(4)] }] };
  const aiId = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, backfill, stage_status) VALUES ('[LINK-TEST] P','x',$1,$2) RETURNING id", [J(backfill), J({ screenplay: { status: "approved" } })])).rows[0].id;
  return aiId;
};
const aiBackfill = async (id) => (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [id])).rows[0].backfill;
const setAi = async (id, fn) => { const b = await aiBackfill(id); fn(b); await db.query("UPDATE ai_movie_projects SET backfill = $2, updated_at = now() WHERE id = $1", [id, J(b)]); };
const filmList = async (conceptId) => (await db.query("SELECT sl.id, sl.content FROM scene_lists sl JOIN bit_sheets bs ON bs.id = sl.bit_sheet_id JOIN three_act_structures t ON t.id = bs.three_act_structure_id JOIN pitch_decks pd ON pd.id = t.pitch_deck_id WHERE pd.concept_id = $1", [conceptId])).rows[0];
const filmScene = async (listId, index) => (await db.query("SELECT content FROM screenplay_scenes WHERE scene_list_id = $1 AND episode_index IS NULL AND scene_index = $2 ORDER BY created_at DESC, id DESC LIMIT 1", [listId, index])).rows[0]?.content;
const pause = () => new Promise((r) => setTimeout(r, 15));
const sync = async () => Object.fromEntries((await syncAllLinks(db)).map(([id, r]) => [id, r]));

test.before(() => ensureProjectLinkSchema(db));
test.after(async () => { await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[LINK-TEST]%'"); await db.query("DELETE FROM concepts WHERE title LIKE '[LINK-TEST]%'"); await db.end(); });

test("a plain bring-across is NOT linked; only when the owner asks", async () => {
  const aiId = await fresh();
  const plain = await aiMovieToFilm(db, aiId, { language: "en" });
  assert.equal(plain.linked, false);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM project_links WHERE ai_movie_id = $1", [aiId])).rows[0].n, 0);
  await db.query("UPDATE concepts SET title = '[LINK-TEST] plain' WHERE id = $1", [plain.projectRef]);
});

test("linked: a change in the AI Movie shows in the Movie (once), a change in the Movie shows in the AI Movie, and nothing bounces back", async () => {
  const aiId = await fresh();
  const out = await aiMovieToFilm(db, aiId, { language: "en", link: true });
  await db.query("UPDATE concepts SET title = '[LINK-TEST] linked' WHERE id = $1", [out.projectRef]);
  const link = (await db.query("SELECT id FROM project_links WHERE ai_movie_id = $1", [aiId])).rows[0].id;
  assert.equal((await sync())[link], "same");
  const list = await filmList(out.projectRef);

  // AI Movie -> Movie
  await pause();
  await setAi(aiId, (b) => { b.screenplayBeats[0].scenes[0].content[1].line = both("Hello, new words."); });
  assert.equal((await sync())[link], "ai_to_film");
  assert.equal((await filmScene(list.id, 0)).elements[1].text, "Hello, new words.");
  assert.equal((await sync())[link], "same", "the change does not bounce back");

  // Movie -> AI Movie (a new version of scene 3 = index 2, as every save of the Movie makes)
  await pause();
  const prev = await filmScene(list.id, 2);
  const elements = prev.elements.map((e, i) => (i === 2 ? { ...e, text: "Bye, changed in Movie." } : e));
  await db.query("INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content) VALUES ($1, NULL, 2, $2)", [list.id, J({ ...prev, elements, editedByUser: true })]);
  assert.equal((await sync())[link], "film_to_ai");
  const b = await aiBackfill(aiId);
  const third = b.screenplayBeats[1].scenes[0];
  assert.equal(third.content[2].line.en, "Bye, changed in Movie.");
  assert.equal(third.content[2].line.hi, "Bye, changed in Movie.", "both language slots follow the change");
  assert.equal(third.card?.keep, undefined, "the old scene card described the old words; it is rebuilt later, as for any edit");
  assert.equal(b.screenplayBeats[0].scenes[1].card.keep, "card 2", "scenes that did not change keep everything the AI Movie knows about them");
  assert.equal(b.screenplayBeats.map((x) => x.scenes.length).join(), "2,2");
  assert.equal((await sync())[link], "same");
});

test("scenes added or removed on one side are added or removed on the other", async () => {
  const aiId = await fresh();
  const out = await aiMovieToFilm(db, aiId, { language: "en", link: true });
  await db.query("UPDATE concepts SET title = '[LINK-TEST] add' WHERE id = $1", [out.projectRef]);
  const link = (await db.query("SELECT id FROM project_links WHERE ai_movie_id = $1", [aiId])).rows[0].id;
  const list = await filmList(out.projectRef);
  await pause();
  await setAi(aiId, (b) => { b.screenplayBeats[1].scenes.push(scene(5)); });
  assert.equal((await sync())[link], "ai_to_film");
  const after = await filmList(out.projectRef);
  assert.equal(after.content.scenes.length, 5);
  assert.equal((await filmScene(list.id, 4)).elements[0].text, "Raju enters room 5.");
  await pause();
  await setAi(aiId, (b) => { b.screenplayBeats[1].scenes.pop(); b.screenplayBeats[0].scenes.shift(); });
  assert.equal((await sync())[link], "ai_to_film");
  assert.equal((await filmScene(list.id, 0)).elements[0].text, "Raju enters room 2.", "the others move up, in order");
  assert.equal(await filmScene(list.id, 3), undefined, "the last scenes are no longer written in the Movie");
  assert.equal((await sync())[link], "same");
});

test("when both sides were changed, the change made last wins", async () => {
  const aiId = await fresh();
  const out = await aiMovieToFilm(db, aiId, { language: "en", link: true });
  await db.query("UPDATE concepts SET title = '[LINK-TEST] both' WHERE id = $1", [out.projectRef]);
  const link = (await db.query("SELECT id FROM project_links WHERE ai_movie_id = $1", [aiId])).rows[0].id;
  const list = await filmList(out.projectRef);
  await pause();
  await setAi(aiId, (b) => { b.screenplayBeats[0].scenes[0].content[1].line = both("AI edit (older)"); });
  await pause();
  const prev = await filmScene(list.id, 1);
  await db.query("INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content) VALUES ($1, NULL, 1, $2)", [list.id, J({ ...prev, elements: prev.elements.map((e, i) => (i === 1 ? { ...e, text: "Movie edit (newer)" } : e)) })]);
  assert.equal((await sync())[link], "film_to_ai");
  assert.equal((await aiBackfill(aiId)).screenplayBeats[0].scenes[1].content[1].line.en, "Movie edit (newer)");
});

test("Movie -> AI Movie with the link: the pair follows each other from the start", async () => {
  const aiId = await fresh();
  const film = await aiMovieToFilm(db, aiId, { language: "en" });
  await db.query("UPDATE concepts SET title = '[LINK-TEST] m2a' WHERE id = $1", [film.projectRef]);
  const out = await filmToAiMovie(db, film.projectRef, { link: true });
  await db.query("UPDATE ai_movie_projects SET title = '[LINK-TEST] m2a copy' WHERE id = $1", [out.projectRef]);
  assert.equal(out.linked, true);
  const link = (await db.query("SELECT id FROM project_links WHERE film_concept_id = $1", [film.projectRef])).rows[0].id;
  assert.equal((await sync())[link], "same");
});

test("merging a Movie's written scenes into the AI Movie's beats keeps unwritten slots in place and adds extras to the last beat", () => {
  const w = (n) => ({ sceneHeading: both(`H${n}`), content: [{ type: "action", text: both(`t${n}`) }] });
  const empty = { sceneHeading: both("EMPTY"), content: [] };
  const seq = [1, 2, 3].map((n) => ({ heading: `N${n}`, content: [{ type: "action", text: both(`n${n}`) }], estimatedMinutes: 2 }));
  const out = mergeFilmIntoAiBeats([{ scenes: [w(1), empty] }, { scenes: [w(2)] }], seq, "en");
  assert.deepEqual(out.map((b) => b.scenes.map((s) => s.sceneHeading.en)), [["N1", "EMPTY"], ["N2", "N3"]]);
});
