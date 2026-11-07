// The screenplay laid out as ACT 1 / ACT 2 / INTERVAL / ACT 3 (the screen's own logic, a plain module — tested here)
import test from "node:test";
import assert from "node:assert/strict";
import { buildActs, groupLabel } from "../../frontend/src/screenplayActs.js";

const beats = (counts) => counts.map((n) => ({ scenes: Array.from({ length: n }, () => ({ m: 1 })) }));
const minutes = (s) => s.m;

test("acts are 25% / 50% / 25% of the running time; scenes are numbered in one running sequence", () => {
  const acts = buildActs(beats([3, 3, 3, 3, 4, 4]), minutes); // 20 scenes
  const byAct = (n) => acts.flat.filter((f) => f.act === n).length;
  assert.deepEqual([byAct(1), byAct(2), byAct(3)], [5, 10, 5]);
  assert.deepEqual(acts.flat.map((f) => f.number), Array.from({ length: 20 }, (_, i) => i + 1));
});

test("with no interval set, the interval falls in the middle of the film, inside Act 2; Act 2 shows as 'continued' after it", () => {
  const acts = buildActs(beats([5, 5, 5, 5]), minutes);
  assert.equal(acts.intervalAfter, 10);
  assert.deepEqual(acts.sections.map((s) => s.label), ["ACT 1", "ACT 2", "INTERVAL", "ACT 2 (continued)", "ACT 3"]);
  assert.equal(acts.sections.filter((s) => s.kind === "interval").length, 1);
  assert.equal(acts.sections.flatMap((s) => s.scenes ?? []).length, 20, "every scene is in exactly one section");
});

test("an interval the film already has (after a beat) is kept where it is", () => {
  const acts = buildActs(beats([4, 4, 4, 4]), minutes, 1); // after beat 2 = after scene 8
  assert.equal(acts.intervalAfter, 8);
  const before = acts.sections.slice(0, acts.sections.findIndex((s) => s.kind === "interval")).flatMap((s) => s.scenes);
  assert.equal(before.length, 8);
});

test("scene length counts: a long scene takes more of the act than a short one", () => {
  const long = [{ scenes: [{ m: 10 }] }, { scenes: [{ m: 1 }, { m: 1 }, { m: 1 }, { m: 1 }, { m: 1 }, { m: 1 }, { m: 1 }, { m: 1 }, { m: 1 }, { m: 1 }] }];
  const acts = buildActs(long, minutes);
  assert.equal(acts.flat[0].act, 1);
  assert.ok(acts.flat.at(-1).act === 3);
});

test("a very short film, an empty film, and a group's label", () => {
  assert.equal(buildActs([], minutes).sections.length, 0);
  assert.equal(buildActs(beats([1]), minutes).intervalAfter, null);
  const two = buildActs(beats([1, 1]), minutes);
  assert.equal(two.intervalAfter, 1);
  const acts = buildActs(beats([3, 3, 3, 3]), minutes);
  assert.deepEqual(groupLabel(acts, 1), { act: "ACT 2", from: 4, to: 6, of: 12, range: "scenes 4–6" });
  assert.equal(groupLabel(acts, 1).range, "scenes 4–6");
  assert.equal(groupLabel(acts, 9), null);
});
