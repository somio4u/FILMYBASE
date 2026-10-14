// Start from Synopsis / Bit Sheet / Scene One-Liners for a web series or vertical drama.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { ensureAllProductionSchemas } from "../productionSchema.js";
import { buildSeriesSkip, saveSeriesSkip, seriesFormatFrom } from "../skipSeries.js";

let db;
before(async () => {
  db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER ?? "root", host: process.env.PGHOST ?? "/var/run/postgresql" });
  await ensureAllProductionSchemas(db).catch(() => {});
});
after(async () => { await db.end(); });

const eps = (n, label = "story") => Array.from({ length: n }, (_, i) => `Episode ${i + 1}: Title ${i + 1}\nThe ${label} of episode ${i + 1} happens here, with Soumya and the village.\n\n`).join("");
const B = (en) => ({ en, or: en, hi: en });

function fakeModels() {
  const calls = [];
  const models = {
    calls,
    async overview({ stage, format, parts }) { calls.push(["overview", stage, format.episodeCount, parts.length]); return { concept: "A doctor and a goddess.", storylineTitle: B("Mahakali"), storylineLogline: B("L"), storylineSummary: B("S"), premise: B("P"), toneGenre: B("T"), targetAudience: B("A"), majorCharacters: [{ name: "Soumya" }] }; },
    async episodes({ parts, startIndex }) { calls.push(["episodes", startIndex, parts.length]); return parts.map((p) => ({ title: B(p.title || `E${p.number}`), synopsis: B(p.text), hook: B("hook") })); },
    async characterSheet(deck) { calls.push(["characterSheet", deck.episodes.length]); return { characters: [{ name: "Soumya" }] }; },
    async threeAct(deck) { calls.push(["threeAct", deck.episodes.length]); return { controllingIdea: B("Faith"), episodeStructures: deck.episodes.map(() => ({ setup: B("s"), confrontation: B("c"), resolution: B("r") })) }; },
    async bitSheet(threeAct, deck) { calls.push(["bitSheet", deck.episodes.length]); return { episodeBits: deck.episodes.map(() => ({ bits: [] })), controllingIdea: threeAct.controllingIdea }; },
    async bits({ parts, startIndex }) { calls.push(["bits", startIndex, parts.length]); return parts.map((p) => ({ bits: [{ actNumber: 1, beatType: "catalyst", title: B(`bit ${p.number}`), description: B(p.text) }] })); },
    async scenes({ parts, startIndex }) { calls.push(["scenes", startIndex, parts.length]); return parts.map((p) => ({ scenes: [{ actNumber: 1, intExt: "INT", location: B("Temple"), timeOfDay: "DAY", oneLiner: B(p.text), estimatedMinutes: 2, purpose: "plot_advancing", turn: B("t") }] })); },
    async finishSceneList(content) { calls.push(["finishSceneList", content.episodeScenes.length]); return { ...content, annotated: true }; },
  };
  return models;
}

test("format: web series and vertical drama get the same defaults as the Idea stage", () => {
  assert.deepEqual(seriesFormatFrom({ type: "series" }), { type: "series", episodeCount: 10, episodeMinutes: 10 });
  assert.deepEqual(seriesFormatFrom({ type: "vertical" }), { type: "vertical", episodeCount: 60, episodeMinutes: 1.5 });
  assert.deepEqual(seriesFormatFrom({ type: "series", episodeCount: "8", episodeMinutes: "20" }), { type: "series", episodeCount: 8, episodeMinutes: 20 });
});

test("SYNOPSIS stage: one synopsis per pasted episode (the pasted episodes decide the count); nothing past the pitch deck is made", async () => {
  const m = fakeModels();
  const built = await buildSeriesSkip({ stage: "synopsis", text: eps(7), format: { type: "series", episodeCount: 10, episodeMinutes: 20 }, models: m });
  assert.equal(built.deck.episodes.length, 7); assert.equal(built.deck.format.episodeCount, 7); assert.equal(built.deck.format.type, "series"); assert.equal(built.deck.format.episodeMinutes, 20);
  assert.match(built.note, /chose 10 episodes but pasted 7/);
  assert.match(built.deck.episodes[2].synopsis.en, /episode 3 happens here/);
  assert.deepEqual(m.calls.map((c) => c[0]), ["overview", "episodes", "episodes"], "7 episodes = 2 batches of 5; no characters or structure yet");
  assert.equal(built.characterSheet, undefined);
});

test("BIT SHEET stage: characters and structure are made to match; the user's bits are kept per episode", async () => {
  const m = fakeModels();
  const built = await buildSeriesSkip({ stage: "bitsheet", text: eps(6, "bits"), format: { type: "vertical", episodeCount: 6, episodeMinutes: 1.5 }, models: m });
  assert.equal(built.deck.format.type, "vertical");
  assert.equal(built.bitSheet.episodeBits.length, 6); assert.match(built.bitSheet.episodeBits[4].bits[0].description.en, /bits of episode 5/);
  assert.equal(built.bitSheet.controllingIdea.en, "Faith");
  assert.ok(m.calls.some((c) => c[0] === "characterSheet") && m.calls.some((c) => c[0] === "threeAct"));
  assert.ok(!m.calls.some((c) => c[0] === "bitSheet"), "the bit sheet is the user's, not generated");
});

test("SCENE ONE-LINERS stage: the earlier stages are made to match; the user's scenes are kept per episode", async () => {
  const m = fakeModels();
  const built = await buildSeriesSkip({ stage: "scenelist", text: eps(3, "scenes"), format: { type: "series", episodeCount: 3, episodeMinutes: 10 }, models: m });
  assert.equal(built.sceneList.episodeScenes.length, 3); assert.equal(built.sceneList.annotated, true);
  assert.match(built.sceneList.episodeScenes[1].scenes[0].oneLiner.en, /scenes of episode 2/);
  assert.deepEqual(m.calls.map((c) => c[0]), ["overview", "episodes", "characterSheet", "threeAct", "bitSheet", "scenes", "finishSceneList"]);
});

test("plain messages: no headings, empty text, a model that returns the wrong number of episodes", async () => {
  await assert.rejects(buildSeriesSkip({ stage: "synopsis", text: "just one long paragraph without any heading at all", format: { type: "series" }, models: fakeModels() }), /could not find the episodes.*Episode 1/s);
  await assert.rejects(buildSeriesSkip({ stage: "bitsheet", text: "  ", format: { type: "series" }, models: fakeModels() }), /Paste your Bit Sheet first/);
  const m = fakeModels(); m.episodes = async () => [];
  await assert.rejects(buildSeriesSkip({ stage: "synopsis", text: eps(3), format: { type: "series" }, models: m }), /could not read episodes 1-3/);
  await assert.rejects(buildSeriesSkip({ stage: "nope", text: eps(3), format: { type: "series" }, models: fakeModels() }), /Unknown start stage/);
});

test("saved in the series shape, with the same statuses the film start-from paths use", async () => {
  for (const [stage, expected] of [["synopsis", { deck: null, sheet: 0, act: 0, bits: 0, scenes: 0 }], ["bitsheet", { deck: "approved", sheet: 1, act: 1, bits: 1, scenes: 0 }], ["scenelist", { deck: "approved", sheet: 1, act: 1, bits: 1, scenes: 1 }]]) {
    const built = await buildSeriesSkip({ stage, text: eps(4, stage), format: { type: "series", episodeCount: 4, episodeMinutes: 10 }, models: fakeModels() });
    const id = await saveSeriesSkip(db, built, {});
    const deck = (await db.query("SELECT id, status, content FROM pitch_decks WHERE concept_id = $1", [id])).rows[0];
    assert.equal(deck.content.episodes.length, 4, `${stage}: one synopsis per episode`); assert.equal(deck.content.format.type, "series");
    assert.equal(deck.status ?? null, expected.deck === null ? deck.status : expected.deck);
    const count = async (sql) => (await db.query(sql, [deck.id])).rows[0].n;
    assert.equal(await count("SELECT count(*)::int AS n FROM character_sheets WHERE pitch_deck_id = $1"), expected.sheet, `${stage}: characters`);
    assert.equal(await count("SELECT count(*)::int AS n FROM three_act_structures WHERE pitch_deck_id = $1"), expected.act, `${stage}: structure`);
    assert.equal(await count("SELECT count(*)::int AS n FROM bit_sheets b JOIN three_act_structures t ON t.id = b.three_act_structure_id WHERE t.pitch_deck_id = $1"), expected.bits, `${stage}: bit sheet`);
    assert.equal(await count("SELECT count(*)::int AS n FROM scene_lists s JOIN bit_sheets b ON b.id = s.bit_sheet_id JOIN three_act_structures t ON t.id = b.three_act_structure_id WHERE t.pitch_deck_id = $1"), expected.scenes, `${stage}: scene list`);
    if (stage === "scenelist") {
      const sl = (await db.query("SELECT s.content FROM scene_lists s JOIN bit_sheets b ON b.id = s.bit_sheet_id JOIN three_act_structures t ON t.id = b.three_act_structure_id WHERE t.pitch_deck_id = $1", [deck.id])).rows[0].content;
      assert.equal(sl.episodeScenes.length, 4, "the scene list is in the series shape (episodeScenes)");
    }
    await db.query("DELETE FROM concepts WHERE id = $1", [id]);
  }
});
