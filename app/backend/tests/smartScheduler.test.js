import test from "node:test";
import assert from "node:assert/strict";
import { applyAnalysis, briefLists, buildPlan, categoriesFor, changedSince, cleanAnalysis, sceneFingerprints, sceneRowsFromList, analysisInput } from "../smartScheduler.js";

const list = {
  episodeScenes: [
    { scenes: [
      { sceneNumber: "E1S1", intExt: "EXT", location: { en: "Kali Temple" }, timeOfDay: "NIGHT", estimatedMinutes: 2, oneLiner: { en: "The child draws." } },
      { sceneNumber: "E1S2", intExt: "INT", location: { en: "Temple Courtyard" }, timeOfDay: "DAY", estimatedMinutes: 3, oneLiner: { en: "Prayer." } },
      { sceneNumber: "E1S3", intExt: "INT", location: { or: "Clinic" }, timeOfDay: "DAY", estimatedMinutes: 1.5, oneLiner: { en: "Not written yet." } },
    ] },
    { scenes: [{ intExt: "INT", location: { en: "Clinic" }, timeOfDay: "EVENING", estimatedMinutes: 2, oneLiner: { en: "x" } }] },
  ],
};
const written = new Map([
  ["0-0", { charactersPresent: ["Soumya", "Nayana"], elements: [{ type: "action", text: "x" }] }],
  ["0-1", { charactersPresent: ["SOUMYA"], elements: [{ type: "dialogue", character: "NARRATOR", characterModifier: "V.O.", text: "..." }, { type: "dialogue", character: "PRIEST", characterModifier: "none", text: "..." }] }],
  ["1-0", { charactersPresent: [], elements: [{ type: "action", text: "x" }] }],
]);

test("the screenplay is read into scenes: place, night, minutes and who is in it (a V.O. voice is not 'on set')", () => {
  const rows = sceneRowsFromList(list, written);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.id), ["0-0", "0-1", "0-2", "1-0"]);
  assert.equal(rows[0].location, "KALI TEMPLE");
  assert.equal(rows[0].night, true);
  assert.deepEqual(rows[0].artists, ["NAYANA", "SOUMYA"]);
  assert.deepEqual(rows[1].artists, ["PRIEST", "SOUMYA"]);
  assert.equal(rows[2].written, false);
  assert.deepEqual(rows[2].artists, []);
  assert.equal(rows[3].night, true); // evening counts as night
  assert.equal(rows[3].label, "E2S1");
});

test("the owner sees each artist and place with scenes, minutes and the category he gave (normal / free if none)", () => {
  const rows = sceneRowsFromList(list, written);
  const lists = briefLists(rows, { artists: { SOUMYA: "costly" }, locations: { CLINIC: "paid" } });
  assert.equal(lists.artists.find((a) => a.name === "SOUMYA").category, "costly");
  assert.equal(lists.artists.find((a) => a.name === "NAYANA").category, "normal");
  assert.equal(lists.artists.find((a) => a.name === "SOUMYA").scenes, 2);
  assert.equal(lists.locations.find((l) => l.name === "CLINIC").category, "paid");
  assert.equal(lists.locations.find((l) => l.name === "KALI TEMPLE").category, "free");
});

test("a change in the screenplay is noticed per scene", () => {
  const rows = sceneRowsFromList(list, written);
  const prints = sceneFingerprints(rows);
  assert.deepEqual(changedSince(prints, rows), []);
  const edited = rows.map((r) => (r.id === "0-1" ? { ...r, minutes: 5 } : r)).concat([{ ...rows[0], id: "0-9" }]);
  assert.deepEqual(changedSince(prints, edited).sort(), ["0-1", "0-9"]);
  assert.deepEqual(changedSince(prints, rows.slice(0, 3)), ["1-0"]);
});

test("the AI's answer keeps only real ids and names", () => {
  const rows = sceneRowsFromList(list, written);
  const a = cleanAnalysis({
    locationAliases: [{ canonical: "KALI TEMPLE", aliases: ["Temple Courtyard", "Moon Palace"] }, { canonical: "NOWHERE", aliases: ["CLINIC"] }],
    characterAliases: [{ canonical: "SOUMYA", aliases: ["NAYANA"] }],
    voiceOnly: ["PRIEST", "GHOST"],
    artistKinds: [{ name: "Nayana", kind: "child" }, { name: "PRIEST", kind: "wizard" }],
    sameDay: [{ sceneIds: ["0-0", "0-1", "9-9"], reason: "x" }, { sceneIds: ["0-0"], reason: "single" }],
    order: [{ before: "0-0", after: "0-1", reason: "x" }, { before: "0-0", after: "0-0", reason: "same" }, { before: "z", after: "0-1", reason: "x" }],
    notes: ["Many night scenes.", "", 5],
  }, rows);
  assert.deepEqual(a.locationAliases, { "TEMPLE COURTYARD": "KALI TEMPLE" });
  assert.deepEqual(a.characterAliases, { NAYANA: "SOUMYA" });
  assert.deepEqual(a.voiceOnly, ["PRIEST"]);
  assert.deepEqual(a.artistKinds, { NAYANA: "child" });
  assert.deepEqual(a.sameDay, [["0-0", "0-1"]]);
  assert.deepEqual(a.order, [["0-0", "0-1"]]);
  assert.deepEqual(a.notes, ["Many night scenes."]);
});

test("merged names become one place / one artist, voice-only names need no call", () => {
  const rows = sceneRowsFromList(list, written);
  const merged = applyAnalysis(rows, { locationAliases: { "TEMPLE COURTYARD": "KALI TEMPLE" }, characterAliases: {}, voiceOnly: ["PRIEST"] });
  assert.equal(merged[1].location, "KALI TEMPLE");
  assert.deepEqual(merged[1].artists, ["SOUMYA"]);
});

test("a merged name takes the category of its most expensive member", () => {
  const c = categoriesFor({ artists: { NAYANA: "cheap", SOUMYA: "costly" }, locations: { "TEMPLE COURTYARD": "paid", "KALI TEMPLE": "free" } }, { characterAliases: { NAYANA: "SOUMYA" }, locationAliases: { "TEMPLE COURTYARD": "KALI TEMPLE" } });
  assert.equal(c.artistCategory.SOUMYA, "costly");
  assert.equal(c.locationCategory["KALI TEMPLE"], "paid");
});

test("the plan is built from the screenplay and the owner's days; the AI analysis is optional", () => {
  const rows = sceneRowsFromList(list, written);
  const plan = buildPlan(rows, { days: 2, maxMinutesPerDay: null, artists: { SOUMYA: "costly" }, locations: {} }, null);
  assert.equal(plan.days.length, 2);
  assert.equal(plan.aiUsed, false);
  assert.equal(Object.keys(plan.scenes).length, 4);
  assert.ok(plan.warnings.some((w) => /1 scene is not written yet/.test(w)));
  assert.equal(plan.artists.find((a) => a.name === "SOUMYA").category, "costly");
  assert.match(analysisInput(rows), /0-0 \| E1S1 \| EXT\. KALI TEMPLE - NIGHT \| 2 min \| NAYANA, SOUMYA/);
});
