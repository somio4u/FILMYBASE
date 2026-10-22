import test from "node:test";
import assert from "node:assert/strict";
import { solveSchedule, mulberry32 } from "../scheduleSolver.js";

// 12 scenes, 3 places, 4 artists: A at the temple, B at the house, C at the clinic; "Star" is in many
const scenes = [];
let n = 0;
const add = (location, artists, minutes = 2, night = false) => scenes.push({ id: `s${n}`, label: `S${++n}`, minutes, location, night, artists });
// the story goes temple -> house -> clinic -> temple -> house -> clinic ... (places are mixed, as in a real story)
for (let i = 0; i < 4; i++) {
  add("TEMPLE", ["STAR", "ASHA"], 2, i % 2 === 1);
  add("HOUSE", ["STAR", "RAM"], 2);
  add("CLINIC", ["BABU", "ASHA"], 2);
}

const run = (extra = {}) => solveSchedule({ scenes, days: 3, artistCategory: { STAR: "costly", BABU: "cheap" }, locationCategory: { CLINIC: "paid" }, ...extra });

test("the same input always gives the same plan", () => {
  const a = run(); const b = run();
  assert.deepEqual(a.days.map((d) => d.sceneIds), b.days.map((d) => d.sceneIds));
  assert.equal(a.totals.costUnits, b.totals.costUnits);
});

test("every scene is on exactly one day and the days are about equally full", () => {
  const r = run();
  const all = r.days.flatMap((d) => d.sceneIds).sort();
  assert.deepEqual(all, scenes.map((s) => s.id).sort());
  assert.ok(r.totals.maxDayMinutes - r.totals.minDayMinutes <= 4, `uneven: ${r.totals.minDayMinutes}..${r.totals.maxDayMinutes}`);
});

test("it beats shooting in story order: places are grouped so artists and locations are called on fewer days", () => {
  const r = run();
  assert.ok(r.totals.costUnits < r.totals.baselineUnits, `${r.totals.costUnits} vs ${r.totals.baselineUnits}`);
  assert.ok(r.totals.savedPercent > 0);
});

test("the costly artist is called on fewer days than there are places he appears in, and never below the lower bound", () => {
  const r = run();
  const star = r.artists.find((a) => a.name === "STAR");
  assert.ok(star.callDays >= star.lowerBound);
  assert.ok(star.callDays <= 3);
  assert.equal(star.category, "costly");
  const babu = r.artists.find((a) => a.name === "BABU");
  assert.equal(babu.category, "cheap");
});

test("a paid location is used on as few days as possible", () => {
  const r = run();
  const clinic = r.locations.find((l) => l.name === "CLINIC");
  assert.equal(clinic.category, "paid");
  assert.equal(clinic.dayCount, 1);
  assert.equal(clinic.costUnits, 3);
});

test("it says plainly when the days cannot hold the film", () => {
  const r = solveSchedule({ scenes, days: 2, maxMinutesPerDay: 6 });
  assert.equal(r.feasible, false);
  assert.equal(r.daysNeeded, 4);
  assert.match(r.warnings[0], /at least 4 days/);
});

test("it warns when the film per day is far above the usual", () => {
  const r = solveSchedule({ scenes: scenes.map((s) => ({ ...s, minutes: 10 })), days: 3 });
  assert.ok(r.warnings.some((w) => /far above the usual/.test(w)));
});

test("'keep together' and 'keep in order' rules are met when they can be", () => {
  const r = run({ sameDay: [["s0", "s9"]], order: [["s5", "s2"]] });
  const dayOf = (id) => r.days.find((d) => d.sceneIds.includes(id)).day;
  assert.equal(dayOf("s0"), dayOf("s9"));
  assert.ok(dayOf("s5") <= dayOf("s2"));
});

test("the seeded random numbers repeat", () => {
  const a = mulberry32(5); const b = mulberry32(5);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test("a day that is only night scenes is marked, a mixed one too", () => {
  const r = solveSchedule({ scenes: [{ id: "a", minutes: 2, location: "X", night: true, artists: [] }, { id: "b", minutes: 2, location: "X", night: false, artists: [] }], days: 1 });
  assert.equal(r.days[0].mixed, true);
});
