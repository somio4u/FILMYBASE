import test from "node:test";
import assert from "node:assert/strict";
import { parseEpisodesFromText } from "../screenplayImport.js";
import { buildScreenplayProject, saveScreenplayProject } from "../screenplayProject.js";

const FILM = `SCENE 1
INT. TEMPLE COMMITTEE OFFICE - NIGHT
ବଳରାମ ପୂଜକ ଜଗନ୍ନାଥଙ୍କୁ ଚାହିଁ ରହିଛି।
BALARAM
(ଧୀରେ)
ମନ୍ଦିର ଜମି ଦେଇଦିଅ, ଜଗନ୍ନାଥ।
JAGANNATH
ମୁଁ ମରିଯିବି, ତଥାପି ଦେବି ନାହିଁ।
Cut to....
SCENE 2
EXT. OLD KALI TEMPLE - NIGHT
ବଳରାମ ଓ ତାର ସାଙ୍ଗମାନେ ମନ୍ଦିରରେ ପଶିଲେ।
SCENE 3
EXT. VILLAGE ROAD - NIGHT
ମାତାଲ ଦେବା ଅନ୍ଧାର ରାସ୍ତାରେ ଡରୁଛି।
DEBA
କିଏ ଅଛୁ ସେଠି?`;

const SERIES = `EPISODE 1: ଆରମ୍ଭ
SCENE 1
INT. HOUSE - DAY
ସେ ଘରେ ଅଛି।
MEERA
ମୁଁ ଆସିଲି।
EPISODE 2: ଶେଷ
SCENE 1
EXT. ROAD - DAY
ରାସ୍ତା ଖାଲି।
SCENE 2
INT. SHOP - DAY
ଦୋକାନ ବନ୍ଦ ଅଛି।
MEERA
କେହି ନାହାନ୍ତି?`;

test("a film: every scene is in the scene list; only the written scenes get a screenplay row, word for word", () => {
  const built = buildScreenplayProject(parseEpisodesFromText(FILM), { title: "MAHAKALI" });
  assert.equal(built.isSeries, false);
  assert.equal(built.language, "or");
  assert.deepEqual(built.summary, { scenes: 3, written: 2, notWritten: 1, episodes: 1, cast: 3 });
  assert.equal(built.sceneList.scenes.length, 3);
  assert.deepEqual(built.rows.map((r) => [r.episodeIndex, r.sceneIndex]), [[null, 0], [null, 2]]);
  const first = built.rows[0].content;
  assert.equal(first.elements.find((e) => e.type === "dialogue" && e.character === "BALARAM").text, "ମନ୍ଦିର ଜମି ଦେଇଦିଅ, ଜଗନ୍ନାଥ।");
  assert.equal(first.elements.find((e) => e.type === "dialogue" && e.character === "BALARAM").parenthetical, "ଧୀରେ");
  assert.equal(first.elements.at(-1).type, "transition");
  assert.equal(first.dialogueLanguage, "or");
  // the scene without written lines keeps its text as the one-line summary, so "not written yet" still tells what happens
  assert.equal(built.sceneList.scenes[1].oneLiner.en, "ବଳରାମ ଓ ତାର ସାଙ୍ଗମାନେ ମନ୍ଦିରରେ ପଶିଲେ।");
  assert.equal(built.sceneList.scenes[1].intExt, "EXT");
  assert.equal(built.deck.format.type, "film");
  assert.equal(built.deck.episodes, null);
  assert.deepEqual(built.characterSheet.characters.map((c) => c.name).sort(), ["BALARAM", "DEBA", "JAGANNATH"]);
});

test("a series: episodes keep their own scene numbering and each written scene is stored under its episode", () => {
  const built = buildScreenplayProject(parseEpisodesFromText(SERIES), {});
  assert.equal(built.isSeries, true);
  assert.equal(built.deck.format.episodeCount, 2);
  assert.equal(built.deck.episodes.length, 2);
  assert.equal(built.deck.episodes[1].title.en, "ଶେଷ");
  assert.equal(built.sceneList.episodeScenes.length, 2);
  assert.deepEqual(built.sceneList.episodeScenes.map((e) => e.scenes.length), [1, 2]);
  assert.deepEqual(built.sceneList.episodeScenes[1].scenes.map((s) => s.sceneNumber), ["1", "2"]);
  assert.deepEqual(built.rows.map((r) => [r.episodeIndex, r.sceneIndex]), [[0, 0], [1, 1]]);
  assert.equal(built.bitSheet.episodeBits.length, 2);
});

test("nothing to import is refused plainly", () => {
  assert.throws(() => buildScreenplayProject({ episodes: [] }), /No scenes were found/);
});

test("saving writes the project in one transaction, in order, and rolls back when a step fails", async () => {
  const built = buildScreenplayProject(parseEpisodesFromText(FILM), { title: "MAHAKALI" });
  const calls = [];
  let id = 100;
  const fakeDb = (failOn) => ({
    async connect() {
      return {
        async query(sql, params) {
          const verb = String(sql).trim().split(/\s+/).slice(0, 3).join(" ");
          calls.push(verb);
          if (failOn && sql.includes(failOn)) throw new Error("boom");
          return { rows: /RETURNING id/.test(sql) ? [{ id: id++ }] : [] };
        },
        release() { calls.push("RELEASE"); },
      };
    },
  });
  const titled = [];
  const conceptId = await saveScreenplayProject(fakeDb(), built, { ownerUserId: 7, setTitle: async (c, t) => titled.push([c, t]) });
  assert.equal(conceptId, 100);
  assert.deepEqual(titled, [[100, "MAHAKALI"]]);
  assert.deepEqual(calls.filter((c) => c.startsWith("INSERT INTO")).map((c) => c.split(" ")[2]), ["concepts", "pitch_decks", "character_sheets", "three_act_structures", "bit_sheets", "scene_lists", "screenplay_scenes", "screenplay_scenes"]);
  assert.equal(calls[0], "BEGIN");
  assert.ok(calls.includes("COMMIT"));
  assert.equal(calls.at(-1), "RELEASE");

  calls.length = 0;
  await assert.rejects(() => saveScreenplayProject(fakeDb("INSERT INTO scene_lists"), built, {}), /boom/);
  assert.ok(calls.includes("ROLLBACK"));
  assert.ok(!calls.includes("COMMIT"));
  assert.equal(calls.at(-1), "RELEASE");
});

test("a numbered one-liner list becomes a project whose scenes are all 'not written yet'; the wanted scene total is kept for a film", async () => {
  const { numberedHeadingsToPlain } = await import("../importAnalysis.js");
  const list = `1. INT. TEMPLE OFFICE - NIGHT — Balaram pressures the priest.
2. EXT. OLD KALI TEMPLE - NIGHT — The eyes are stolen.
3. EXT. VILLAGE ROAD - NIGHT — Deba is terrorized.`;
  const built = buildScreenplayProject(parseEpisodesFromText(numberedHeadingsToPlain(list)), { title: "LIST", targetScenes: 45 });
  assert.deepEqual(built.summary, { scenes: 3, written: 0, notWritten: 3, episodes: 1, cast: 0 });
  assert.equal(built.rows.length, 0);
  assert.equal(built.sceneList.scenes[1].oneLiner.en, "The eyes are stolen.");
  assert.equal(built.sceneList.scenes[1].location.en, "OLD KALI TEMPLE");
  assert.equal(built.sceneList.targetScenes, 45);
  assert.equal(buildScreenplayProject(parseEpisodesFromText(numberedHeadingsToPlain(list)), { targetScenes: "abc" }).sceneList.targetScenes, undefined);
});

test("writers may analyse a draft and read a non-PDF file's text, but not use the AI Movie import", async () => {
  const { matchWriterRoute } = await import("../writerAccess.js");
  assert.ok(matchWriterRoute("POST", "/api/draft/analyze"));
  assert.ok(matchWriterRoute("POST", "/api/draft/read-file"));
  assert.equal(matchWriterRoute("POST", "/api/ai-movie/import-screenplay-file"), null); // the AI Movie import stays admin's
});
