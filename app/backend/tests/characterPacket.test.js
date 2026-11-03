import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import ScriptAwarePDF from "../mixedScriptPdf.js";
import {
  sameCharacter, presenceIn, scenesFromSourceText, scenesFromWrittenScreenplay, scenesWithCharacter, cleanInsights, buildCharacterPacket,
  sheetFacts, writeCharacterPacketPdf, writeCharacterPacketExcel,
} from "../characterPacket.js";

const SCRIPT = `SCENE 1
INT. TEMPLE COMMITTEE OFFICE - NIGHT
Balaram sits behind a heavy table. The old priest Jagannath stands with folded hands. Rain taps on the tin roof.
BALARAM
(softly)
Give me the temple land, Jagannath.
JAGANNATH
I will die before I sign.
Cut to....
SCENE 2
EXT. OLD KALI TEMPLE - NIGHT
Balaram and his men push through the gate. A lamp falls and goes out.
SCENE 3
EXT. VILLAGE ROAD - NIGHT
Deba runs through the dark road, afraid.
DEBA
Who is there?
SCENE 4
INT. JAGANNATH HOUSE - DAY
Jagannath prays alone, a tired old man.
JAGANNATH
Mother, give me strength.`;

test("who is who: same name or part of the name; different names never match", () => {
  assert.equal(sameCharacter("BISWA BABU (V.O.)", "Biswa babu"), true);
  assert.equal(sameCharacter("BISWA", "Biswa Babu"), true);
  assert.equal(sameCharacter("Anita", "Ankita"), false);
  assert.equal(sameCharacter("Smita", "Anita"), false);
  assert.equal(sameCharacter("Al", "Alok"), false); // a name of fewer than 3 letters is never matched loosely
  assert.equal(sameCharacter("", "Anita"), false);
});

test("the scenes are cut out whole: heading, action lines and EVERY character's dialogue, in order", () => {
  const scenes = scenesFromSourceText(SCRIPT);
  assert.equal(scenes.length, 4);
  const mine = scenesWithCharacter(scenes, "Jagannath");
  assert.deepEqual(mine.map((s) => s.sceneLabel), ["Scene 1", "Scene 4"]); // not scene 2 (he is absent) or scene 3
  assert.equal(mine[0].presence, "speaks");
  const first = mine[0];
  assert.match(first.heading, /TEMPLE COMMITTEE OFFICE/);
  assert.deepEqual(first.elements.map((e) => e.type), ["action", "dialogue", "dialogue", "transition"]);
  assert.match(first.elements[0].text, /Rain taps on the tin roof/); // the action line the old packet left out
  assert.equal(first.elements[1].character, "BALARAM"); // the other actor's cue is kept
  assert.equal(first.elements[1].parenthetical, "softly");
  assert.equal(first.elements[2].text, "I will die before I sign.");
});

test("a character who is only named in the action lines is present in that scene, silently", () => {
  const scenes = scenesFromSourceText(SCRIPT);
  const balaram = scenesWithCharacter(scenes, "Balaram");
  assert.deepEqual(balaram.map((s) => [s.sceneLabel, s.presence]), [["Scene 1", "speaks"], ["Scene 2", "present"]]);
  assert.equal(presenceIn(scenes[2], "Balaram"), null);
  assert.equal(scenesFromSourceText("just some words with no scenes at all"), null);
});

test("scenes written inside the app: the scene list gives where and when, the written scene gives what happens", async () => {
  const rows = [
    { episode_index: 0, scene_index: 0, content: { elements: [{ type: "action", text: "Meera opens the door." }, { type: "dialogue", character: "MEERA", text: "Who is it?" }], charactersPresent: ["MEERA"] } },
    { episode_index: 1, scene_index: 0, content: { elements: [{ type: "dialogue", character: "RAVI", text: "I am back." }] } },
  ];
  const db = { query: async () => ({ rows }) };
  const list = { episodeScenes: [{ scenes: [{ sceneNumber: "1", intExt: "INT", location: { en: "HOUSE" }, timeOfDay: "DAY" }] }, { scenes: [{ intExt: "EXT", location: { en: "ROAD" }, timeOfDay: "NIGHT" }] }] };
  const scenes = await scenesFromWrittenScreenplay(db, 7, list);
  assert.equal(scenes[0].episodeLabel, "Episode 1");
  assert.equal(scenes[0].heading, "INT. HOUSE - DAY");
  assert.equal(scenes[1].heading, "EXT. ROAD - NIGHT");
  assert.equal(scenes[0].elements[0].text, "Meera opens the door.");
  assert.equal(await scenesFromWrittenScreenplay({ query: async () => ({ rows: [] }) }, 7, list), null);
});

test("the AI's answer is made safe: intensity 1–10, one entry per scene, blanks for what is missing", () => {
  const scenes = [{}, {}, {}];
  const out = cleanInsights({
    profile: { summary: " An old priest ", age: "60s" },
    arc: { start: "Upright", turningPoints: ["Loses the land", "", "Stands up again"], end: "At peace" },
    scenes: [{ key: "1", emotion: "Fear", intensity: 14, objective: "Hold on", note: "Quiet" }, { key: "3", emotion: "Calm", intensity: 0 }, { key: "9", emotion: "stray" }],
  }, scenes);
  assert.equal(out.profile.summary, "An old priest");
  assert.equal(out.profile.want, "");
  assert.deepEqual(out.arc.turningPoints, ["Loses the land", "Stands up again"]);
  assert.deepEqual(out.perScene.map((s) => s.intensity), [10, null, 1]);
  assert.equal(out.perScene[1].emotion, ""); // no entry for key 2
});

test("the packet: the AI is asked once with the scenes and the sheet facts; if it fails the scenes still come, with a note", async () => {
  const scenes = scenesFromSourceText(SCRIPT);
  const asked = [];
  const sheet = { characters: [{ name: "JAGANNATH", age: "62", want: { en: "to keep the temple land", or: "" }, flaw: { en: "stubborn" } }] };
  assert.match(sheetFacts(sheet, "Jagannath"), /wants: to keep the temple land/);
  const packet = await buildCharacterPacket({
    scenes, label: "Jagannath", lang: "hi", sheetContent: sheet, now: 1,
    askModel: async (contents) => { asked.push(contents); return { profile: { summary: "Priest" }, arc: { start: "a", turningPoints: [], end: "b" }, scenes: [{ key: "1", emotion: "Fear", intensity: 8 }, { key: "2", emotion: "Peace", intensity: 3 }] }; },
  });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Hindi/);
  assert.match(asked[0], /wants: to keep the temple land/);
  assert.match(asked[0], /Rain taps on the tin roof/);
  assert.equal(packet.scenes.length, 2);
  assert.deepEqual(packet.insights.perScene.map((s) => s.intensity), [8, 3]);

  const failed = await buildCharacterPacket({ scenes, label: "Deba", askModel: async () => { throw new Error("quota"); } });
  assert.equal(failed.insights, null);
  assert.match(failed.note, /could not be prepared/);
  assert.equal(failed.scenes.length, 1);
  assert.equal((await buildCharacterPacket({ scenes, label: "Nobody", askModel: async () => ({}) })).scenes.length, 0);
});

const pdfText = async (packet) => {
  const doc = new ScriptAwarePDF({ size: "A4", margin: 50 });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", resolve));
  writeCharacterPacketPdf(doc, packet);
  doc.end();
  await done;
  const file = path.join(mkdtempSync(path.join(tmpdir(), "packet-")), "p.pdf");
  writeFileSync(file, Buffer.concat(chunks));
  return execFileSync("pdftotext", ["-layout", file, "-"]).toString().replace(/\s+/g, " "); // lines wrap on the page: compare the words only
};

test("the PDF: details, arc, emotional graph, then every scene in full (action lines and other actors' dialogue too)", async () => {
  const scenes = scenesFromSourceText(SCRIPT);
  const packet = await buildCharacterPacket({
    scenes, label: "Jagannath", now: 5,
    askModel: async () => ({
      profile: { summary: "An upright old priest", age: "60s", look: "white beard", relationships: "Balaram pressures him", want: "keep the land", need: "trust the goddess", flaw: "pride", voice: "slow and firm" },
      arc: { start: "Proud keeper of the temple", turningPoints: ["Refuses Balaram in scene 1"], end: "Finds peace in prayer" },
      scenes: [{ key: "1", emotion: "Defiance", intensity: 8, objective: "Refuse to sign", note: "Hold the stare" }, { key: "2", emotion: "Calm", intensity: 3, objective: "Pray", note: "Soft" }],
    }),
  });
  const text = await pdfText(packet);
  for (const part of ["CHARACTER SCRIPT", "Character details", "An upright old priest", "Character arc", "Finds peace in prayer", "Emotional graph", "Defiance", "(8/10)", "The scenes", "TEMPLE COMMITTEE OFFICE", "Rain taps on the tin roof", "BALARAM", "Give me the temple land", "I will die before I sign.", "Mother, give me strength.", "Objective: Refuse to sign"]) {
    assert.ok(text.includes(part), `the PDF should contain “${part}”`);
  }
  assert.ok(!text.includes("Deba runs through"), "scenes without the character are not included");
});

test("the PDF without the AI part still holds every scene, and a character with no scenes says so", async () => {
  const scenes = scenesFromSourceText(SCRIPT);
  const failed = await buildCharacterPacket({ scenes, label: "Deba", askModel: async () => { throw new Error("x"); } });
  const text = await pdfText(failed);
  assert.ok(text.includes("could not be prepared") && text.includes("Deba runs through the dark road") && text.includes("Who is there?"));
  assert.ok(!text.includes("Emotional graph"));
  const none = await pdfText({ character: "Nobody", lang: "en", scenes: [], insights: null, note: "" });
  assert.ok(none.includes("No scenes were found for this character."));
});

test("a long script's graph (many scenes, some without a number) draws without breaking", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ episodeLabel: null, sceneLabel: `Scene ${i + 1}`, heading: "INT. ROOM - DAY", presence: "speaks", elements: [{ type: "dialogue", character: "ASHA", parenthetical: "", text: `Line ${i + 1}` }] }));
  const insights = cleanInsights({ profile: {}, arc: { start: "s", turningPoints: [], end: "e" }, scenes: many.map((_, i) => ({ key: String(i + 1), emotion: "x", intensity: i % 7 === 0 ? 0 : (i % 10) + 1 })) }, many);
  insights.perScene[5].intensity = null;
  const text = await pdfText({ character: "Asha", lang: "en", scenes: many, insights, note: "" });
  assert.ok(text.includes("Line 40"));
});

test("the Excel file: the character, the emotional graph as a table, and the scenes in full", async () => {
  const scenes = scenesFromSourceText(SCRIPT);
  const packet = await buildCharacterPacket({ scenes, label: "Jagannath", now: 1e12, askModel: async () => ({ profile: { summary: "Priest" }, arc: { start: "a", turningPoints: ["t"], end: "b" }, scenes: [{ key: "1", emotion: "Fear", intensity: 7, objective: "o", note: "n" }, { key: "2", emotion: "Calm", intensity: 2, objective: "o2", note: "n2" }] }) });
  const workbook = new ExcelJS.Workbook();
  writeCharacterPacketExcel(workbook, packet);
  assert.deepEqual(workbook.worksheets.map((w) => w.name), ["Character details", "Emotional graph", "The scenes"]);
  const graph = workbook.getWorksheet("Emotional graph");
  assert.equal(graph.getRow(2).getCell(2).value, "Fear");
  assert.equal(graph.getRow(3).getCell(3).value, 2);
  const full = String(workbook.getWorksheet("The scenes").getRow(2).getCell(3).value);
  assert.match(full, /Rain taps on the tin roof/);
  assert.match(full, /BALARAM: \(softly\) Give me the temple land/);
  const buffer = await workbook.xlsx.writeBuffer(); // it really can be written
  assert.ok(buffer.byteLength > 1000);
});

// ---- kept for good (the database) ----
import pg from "pg";
import { ensurePacketCacheSchema, createPacketStore, packetKey, packetCharacters } from "../characterPacket.js";

test("what the AI made is kept in the database: a second request (even after a restart) does not ask the AI again; a changed screenplay does; a failure is not kept", async () => {
  const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
  try {
    await ensurePacketCacheSchema(db);
    await db.query("DELETE FROM character_packet_cache");
    const store = createPacketStore(db);
    const scenes = scenesFromSourceText(SCRIPT);
    let asked = 0;
    const answer = { profile: { summary: "Priest" }, arc: { start: "a", turningPoints: [], end: "b" }, scenes: [{ key: "1", emotion: "Fear", intensity: 6 }, { key: "2", emotion: "Calm", intensity: 2 }] };
    const ask = async () => { asked += 1; return answer; };

    const first = await buildCharacterPacket({ scenes, label: "Jagannath", store, askModel: ask, now: 2e12, meta: { sceneListId: 5 } });
    assert.equal(asked, 1);
    assert.equal(first.insights.perScene[0].emotion, "Fear");
    const { key } = packetKey({ scenes, label: "Jagannath" });
    assert.equal((await store.get(key)).profile.summary, "Priest");
    assert.equal((await db.query("SELECT scene_list_id, character_name, lang FROM character_packet_cache WHERE cache_key = $1", [key])).rows[0].character_name, "Jagannath");

    // "after a restart": the memory is gone (a much later clock), the database still has it
    const again = await buildCharacterPacket({ scenes, label: "Jagannath", store, askModel: ask, now: 9e12 });
    assert.equal(asked, 1);
    assert.equal(again.insights.perScene[1].emotion, "Calm");

    // the screenplay changed -> another key -> the AI is asked again
    const changed = scenesFromSourceText(SCRIPT.replace("I will die before I sign.", "I will never sign."));
    assert.notEqual(packetKey({ scenes: changed, label: "Jagannath" }).key, key);
    await buildCharacterPacket({ scenes: changed, label: "Jagannath", store, askModel: ask, now: 9e12 });
    assert.equal(asked, 2);

    // another language is another packet
    await buildCharacterPacket({ scenes, label: "Jagannath", lang: "or", store, askModel: ask, now: 9e12 });
    assert.equal(asked, 3);

    // a failure is never kept: the next try asks again
    let calls = 0;
    const failing = await buildCharacterPacket({ scenes, label: "Deba", store, askModel: async () => { calls += 1; throw new Error("quota"); }, now: 9e12 });
    assert.equal(failing.insights, null);
    await buildCharacterPacket({ scenes, label: "Deba", store, askModel: async () => { calls += 1; throw new Error("quota"); }, now: 9e12 });
    assert.equal(calls, 2);
    assert.equal(await store.get(packetKey({ scenes, label: "Deba" }).key), null);
    await db.query("DELETE FROM character_packet_cache");
  } finally { await db.end(); }
});

test("who gets a packet: the artist-list names that are really in the scenes, else the speakers", () => {
  const scenes = scenesFromSourceText(SCRIPT);
  assert.deepEqual(packetCharacters(scenes, ["Jagannath", "Balaram", "Ghost Who Is Nowhere", "jagannath"]), ["Jagannath", "Balaram"]);
  assert.deepEqual(packetCharacters(scenes, []).sort(), ["BALARAM", "DEBA", "JAGANNATH"]);
});

test("an Odia packet: the title, the headings and 'Scene n' are Odia, and the AI is told to write everything in Odia script", async () => {
  const scenes = scenesFromSourceText(SCRIPT);
  let prompt = "";
  const packet = await buildCharacterPacket({
    scenes, label: "Jagannath", lang: "or", now: 3e13,
    askModel: async (contents) => { prompt = contents; return { profile: { summary: "ସଚ୍ଚୋଟ ପୂଜକ" }, arc: { start: "ଗର୍ବୀ", turningPoints: [], end: "ଶାନ୍ତ" }, scenes: [{ key: "1", emotion: "ଅବାଧ୍ୟତା", intensity: 8, objective: "ମନା", note: "ସ୍ଥିର" }, { key: "2", emotion: "ଶାନ୍ତି", intensity: 3, objective: "ପ୍ରାର୍ଥନା", note: "କୋମଳ" }] }; },
  });
  assert.match(prompt, /Odia script \(ଓଡ଼ିଆ ଅକ୍ଷର\)/);
  assert.match(prompt, /no English sentences/);
  // (pdftotext breaks Odia letters into pieces, so the Odia words are checked in the labels; the PDF is checked for what must NOT be English any more)
  const { PACKET_LABELS, sceneTitle } = await import("../characterPacket.js");
  assert.equal(sceneTitle({ sceneLabel: "Scene 4", episodeLabel: "Episode 2" }, PACKET_LABELS.or), "ଏପିସୋଡ୍ 2, ଦୃଶ୍ୟ 4");
  assert.equal(sceneTitle({ sceneLabel: "Scene 4", episodeLabel: null }, PACKET_LABELS.or), "ଦୃଶ୍ୟ 4");
  assert.equal(sceneTitle({ sceneLabel: "Scene 4", episodeLabel: "Episode 2" }), "Episode 2, Scene 4");
  assert.equal(PACKET_LABELS.or.title, "ଚରିତ୍ର ସ୍କ୍ରିପ୍ଟ");
  const text = await pdfText(packet);
  assert.ok(text.includes("Jagannath"));
  for (const english of ["CHARACTER SCRIPT", "Character details", "Character arc", "Emotional graph", "Scene 1", "Scene 4", "The scenes", "Objective"]) assert.ok(!text.includes(english), `no English “${english}” in an Odia packet`);
});
