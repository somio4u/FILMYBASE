import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { ensureWriterLearningSchema, recordWriterEdit, diffWriterLines, flattenLines } from "../writerLearning.js";

test("the diff finds reworded, added and cut lines, and ignores unchanged ones", () => {
  const before = flattenLines([
    { type: "action", text: "Raju enters." },
    { type: "dialogue", character: "RAJU", text: "I shall not tolerate this." },
    { type: "dialogue", character: "MEERA", text: "Please calm down." },
  ], "en");
  const after = flattenLines([
    { type: "action", text: "Raju enters." },
    { type: "dialogue", character: "RAJU", text: "Bas. Aur nahi." },
    { type: "dialogue", character: "MEERA", text: "Please calm down." },
    { type: "dialogue", character: "MEERA", text: "Raju?" },
  ], "en");
  assert.deepEqual(diffWriterLines(before, after), [
    { type: "dialogue", character: "RAJU", before: "I shall not tolerate this.", after: "Bas. Aur nahi." },
    { type: "dialogue", character: "MEERA", before: "", after: "Raju?" },
  ]);
  assert.deepEqual(diffWriterLines(before, before), []);
  assert.deepEqual(diffWriterLines(before, before.slice(0, 2)), [{ type: "dialogue", character: "MEERA", before: "Please calm down.", after: "" }]);
});

test("lines kept as { en, hi } are read in the scene's language", () => {
  assert.deepEqual(flattenLines([{ type: "dialogue", character: "raju", line: { en: "Go.", hi: "जा।" } }], "hi"), [{ type: "dialogue", character: "RAJU", text: "जा।" }]);
});

test("edits are remembered per writer; autosave of one scene stays ONE record; a failure never throws", async () => {
  const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
  try {
    await ensureWriterLearningSchema(db);
    const uid = (await db.query("INSERT INTO users (name, username, password_hash, password_salt, role) VALUES ('Chandan T','chandan_t_wl','x','x','independent_writer') RETURNING id")).rows[0].id;
    const user = { id: uid, name: "Chandan T" };
    const before = [{ type: "dialogue", character: "RAJU", text: "I shall not tolerate this." }];
    const id1 = await recordWriterEdit(db, { user, module: "screenplay", projectRef: 1, sceneRef: 5, before, after: [{ type: "dialogue", character: "RAJU", text: "Bas." }] });
    const id2 = await recordWriterEdit(db, { user, module: "screenplay", projectRef: 1, sceneRef: 5, before: [{ type: "dialogue", character: "RAJU", text: "Bas." }], after: [{ type: "dialogue", character: "RAJU", text: "Bas. Aur nahi." }] });
    assert.equal(id1, id2, "same scene, same session: one record");
    const rows = (await db.query("SELECT pairs FROM writer_edits WHERE user_id = $1", [uid])).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].pairs, [{ type: "dialogue", character: "RAJU", before: "I shall not tolerate this.", after: "Bas. Aur nahi." }], "compared with the scene as the session began");
    assert.equal(await recordWriterEdit(db, { user, module: "screenplay", projectRef: 1, sceneRef: 6, before, after: before }), null, "no change, nothing saved");
    assert.equal(await recordWriterEdit({ query: async () => { throw new Error("db down"); } }, { user, module: "screenplay", before, after: [] }), null);
    await db.query("DELETE FROM writer_edits WHERE user_id = $1", [uid]); await db.query("DELETE FROM users WHERE id = $1", [uid]);
  } finally { await db.end(); }
});

import { buildStyleBlock, runWithWriterStyle, currentWriterStyle, MIN_STYLE_EXAMPLES } from "../writerLearning.js";
import { withWritingStyle, dialogueStyleText } from "../writingStyleGuide.js";

const rows = (n) => [{ pairs: Array.from({ length: n }, (_, i) => ({ type: "dialogue", character: "RAJU", before: `I shall not tolerate this ${i}.`, after: `Bas. Aur nahi ${i}.` })) }];

test("a writer's style is only used after enough real rewrites, and carries their own before/after lines", () => {
  assert.equal(buildStyleBlock("Chandan", rows(MIN_STYLE_EXAMPLES - 1)), "");
  const block = buildStyleBlock("Chandan", rows(8));
  assert.match(block, /Chandan/);
  assert.match(block, /AI wrote: "I shall not tolerate this 0\."/);
  assert.match(block, /Bas\. Aur nahi 0\./);
  assert.match(block, /never let this change the story/);
  // unchanged lines and pure additions/cuts teach nothing
  assert.equal(buildStyleBlock("C", [{ pairs: Array.from({ length: 9 }, () => ({ type: "dialogue", character: "R", before: "same", after: "same" })).concat(Array.from({ length: 9 }, () => ({ type: "dialogue", character: "R", before: "", after: "added" }))) }]), "");
});

test("the writer's style reaches the writing prompts of the request that is running (even after awaits), and of nobody else", async () => {
  const plainPrompt = withWritingStyle("BASE");
  assert.doesNotMatch(plainPrompt, /THIS WRITER'S OWN STYLE/);
  const block = buildStyleBlock("Chandan", rows(8));
  await runWithWriterStyle(block, async () => {
    await new Promise((r) => setTimeout(r, 5));
    assert.match(withWritingStyle("BASE"), /THIS WRITER'S OWN STYLE/);
    assert.match(dialogueStyleText(), /Bas\. Aur nahi 0\./);
    assert.equal(currentWriterStyle(), block);
  });
  assert.equal(currentWriterStyle(), "", "outside that request nothing leaks");
  assert.doesNotMatch(withWritingStyle("BASE"), /THIS WRITER'S OWN STYLE/);
});

import { importWriterStyle, styleBlockFor } from "../writerLearning.js";
import { readFileSync } from "node:fs";

test("a written style card is enough on its own, and shows up in the writing prompt together with the examples", () => {
  const card = "KUMAR'S STYLE: close people say ତୁ.";
  const block = buildStyleBlock("Kumar", [{ pairs: [{ type: "dialogue", character: "SOUMYA", before: "", after: "ଭାଇ... ମୁଁ କ'ଣ ମରିଯିବି?" }] }], card);
  assert.match(block, /KUMAR'S STYLE: close people say ତୁ\./);
  assert.match(block, /Kumar added: "ଭାଇ\.\.\. ମୁଁ କ'ଣ ମରିଯିବି\?"/);
  assert.equal(buildStyleBlock("Kumar", [], ""), "");
});

test("the ready-made Kumar style file is well formed (a card plus before/after pairs in Odia)", () => {
  const seed = JSON.parse(readFileSync(new URL("../seeds/kumar-style.json", import.meta.url), "utf8"));
  assert.ok(seed.card.length > 1000 && /ତୁ/.test(seed.card) && /ସୋମୁ/.test(seed.card));
  assert.ok(seed.pairs.length >= 50);
  assert.ok(seed.pairs.every((p) => p.type === "dialogue" && typeof p.after === "string" && p.after.trim() && /[଀-୿]/.test(p.after)));
  assert.ok(seed.pairs.some((p) => p.before) && seed.pairs.some((p) => !p.before));
});

test("importing a style gives the writer a card and pairs; importing again replaces, never doubles", async () => {
  const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
  try {
    await ensureWriterLearningSchema(db);
    const uid = (await db.query("INSERT INTO users (name, username, password_hash, password_salt, role) VALUES ('Kumar Test','kumar_t_wl','x','x','independent_writer') RETURNING id")).rows[0].id;
    const style = { card: "CARD TEXT", pairs: [{ type: "dialogue", character: "A", before: "x one", after: "ଏକ ଦୁଇ" }, { type: "dialogue", character: "B", before: "", after: "ତିନି ଚାରି" }] };
    await importWriterStyle(db, uid, style);
    const r = await importWriterStyle(db, uid, style);
    assert.deepEqual(r, { userId: uid, name: "Kumar Test", pairs: 2, card: true });
    assert.equal((await db.query("SELECT count(*)::int AS n FROM writer_edits WHERE user_id = $1", [uid])).rows[0].n, 1);
    const block = await styleBlockFor(db, { id: uid, name: "Kumar Test" });
    assert.match(block, /CARD TEXT/); assert.match(block, /ଏକ ଦୁଇ/);
    assert.equal(await styleBlockFor(db, { id: uid + 99999, name: "Nobody" }), "");
    await assert.rejects(() => importWriterStyle(db, uid + 99999, style), /No such login/);
    await db.query("DELETE FROM users WHERE id = $1", [uid]);
  } finally { await db.end(); }
});

import { applyStyleSeeds } from "../writerLearning.js";
test("a ready-made style goes only to the exact username, only once, and a restart never overwrites a changed card", async () => {
  const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
  try {
    await ensureWriterLearningSchema(db);
    const a = (await db.query("INSERT INTO users (name, username, password_hash, password_salt, role) VALUES ('Kumar Bro','kumar_seed_t','x','x','screenplay_writer') RETURNING id")).rows[0].id;
    const b = (await db.query("INSERT INTO users (name, username, password_hash, password_salt, role) VALUES ('Chandan Kumar T','chandan_seed_t','x','x','independent_writer') RETURNING id")).rows[0].id;
    const read = async () => ({ card: "SEED CARD", pairs: [{ type: "dialogue", character: "A", before: "x", after: "ଯ" }] });
    const seeds = [{ username: "kumar_seed_t", seed: "kumar" }];
    assert.equal((await applyStyleSeeds(db, read, seeds)).length, 1);
    assert.equal((await db.query("SELECT card FROM writer_style_cards WHERE user_id = $1", [a])).rows[0].card, "SEED CARD");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM writer_style_cards WHERE user_id = $1", [b])).rows[0].n, 0, "the other 'Kumar' got nothing");
    await db.query("UPDATE writer_style_cards SET card = 'EDITED' WHERE user_id = $1", [a]);
    assert.equal((await applyStyleSeeds(db, read, seeds)).length, 0, "second start does nothing");
    assert.equal((await db.query("SELECT card FROM writer_style_cards WHERE user_id = $1", [a])).rows[0].card, "EDITED");
    assert.deepEqual(await applyStyleSeeds(db, read, [{ username: "nobody_here", seed: "kumar" }]), []);
    await db.query("DELETE FROM users WHERE id = ANY($1)", [[a, b]]);
  } finally { await db.end(); }
});

import { buildTeamStyleBlock, projectIdOfRequest, teamStyleBlock } from "../writerLearning.js";
test("the team style blends every writer who has learned something, keeps characters' voices apart, and skips writers with nothing yet", () => {
  const rewrites = (n, tag) => [{ pairs: Array.from({ length: n }, (_, i) => ({ type: "dialogue", character: "R", before: `${tag} old ${i}`, after: `${tag} new ${i}` })) }];
  const block = buildTeamStyleBlock([
    { name: "Kumar", rows: [], card: "KUMAR CARD" },
    { name: "Chandan", rows: rewrites(8, "C"), card: "" },
    { name: "Newbie", rows: rewrites(2, "N"), card: "" },
  ]);
  assert.match(block, /ALL its dialogue and screenplay writers \(Kumar, Chandan\)/);
  assert.match(block, /KUMAR CARD/);
  assert.match(block, /C new 0/);
  assert.doesNotMatch(block, /N new/);
  assert.match(block, /every CHARACTER's own voice distinct/);
  assert.equal((block.match(/Chandan made it:/g) ?? []).length, 6, "at most 6 examples per writer");
  assert.equal(buildTeamStyleBlock([{ name: "A", rows: [], card: "" }]), "");
});

test("the AI Movie project of a request is found from the path, the body or the query", () => {
  assert.equal(projectIdOfRequest({ path: "/api/ai-movie/projects/42/dialogue-doctor" }), 42);
  assert.equal(projectIdOfRequest({ path: "/api/ai-movie/stages/screenplay/beats/1/scenes/2/dialogue", body: { projectId: 7 } }), 7);
  assert.equal(projectIdOfRequest({ path: "/api/ai-movie/x", query: { projectId: "9" } }), 9);
  assert.equal(projectIdOfRequest({ path: "/api/ai-movie/x" }), null);
});

test("the team style of a project is read from every writer in the database", async () => {
  const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
  try {
    await ensureWriterLearningSchema(db);
    const a = (await db.query("INSERT INTO users (name, username, password_hash, password_salt, role) VALUES ('Team A','team_a_t','x','x','independent_writer') RETURNING id")).rows[0].id;
    await importWriterStyle(db, a, { card: "TEAM A CARD", pairs: [] });
    const block = await teamStyleBlock(db);
    assert.match(block, /TEAM A CARD/);
    await db.query("DELETE FROM users WHERE id = $1", [a]);
  } finally { await db.end(); }
});
