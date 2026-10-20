import test from "node:test";
import assert from "node:assert/strict";
import { linesOf, sourceOf, summariseHistory } from "../changeHistory.js";
import { byLabel } from "../sceneAuthors.js";

test("a scene is read as plain lines", () => {
  const lines = linesOf({ elements: [
    { type: "action", text: "Ram enters." },
    { type: "dialogue", character: "RAM", characterModifier: "V.O.", parenthetical: "softly", text: "Hello." },
  ] });
  assert.deepEqual(lines, ["Ram enters.", "RAM (V.O.) (softly): Hello."]);
});

test("a version says how it came to be", () => {
  assert.equal(sourceOf({ importedFromFile: true, editedByUser: true }), "imported");
  assert.equal(sourceOf({ editedByUser: true }), "edited");
  assert.equal(sourceOf({}), "ai");
});

test("each episode counts its changed scenes and first/last times", () => {
  const list = { episodeScenes: [
    { scenes: [{ sceneNumber: "E1S1", location: { en: "TEMPLE" } }, { sceneNumber: "E1S2", location: { en: "GHAT" } }] },
    { scenes: [{ sceneNumber: "E2S1", location: { en: "HOUSE" } }] },
  ] };
  const d = (day) => new Date(`2026-10-${String(day).padStart(2, "0")}T10:00:00Z`);
  const rows = [
    { episode_index: 0, scene_index: 0, created_at: d(1), source: "ai", by: "Kumar" },
    { episode_index: 0, scene_index: 0, created_at: d(5), source: "edited", by: "Kumar" },
    { episode_index: 0, scene_index: 0, created_at: d(9), source: "imported", by: "admin (Somio)" },
    { episode_index: 0, scene_index: 1, created_at: d(2), source: "ai" },
    { episode_index: 1, scene_index: 0, created_at: d(3), source: "ai" },
  ];
  const [e1, e2] = summariseHistory(list, rows);
  assert.equal(e1.totalChanges, 2);
  assert.equal(e1.changedScenes, 1);
  assert.equal(e1.scenes[0].lastSource, "imported");
  assert.equal(e1.scenes[0].lastBy, "admin (Somio)");
  assert.deepEqual(e1.people, [{ label: "Kumar", changes: 1 }, { label: "admin (Somio)", changes: 1 }]);
  assert.equal(e1.firstAt.getTime(), d(1).getTime());
  assert.equal(e1.lastAt.getTime(), d(9).getTime());
  assert.equal(e2.totalChanges, 0);
  assert.equal(e2.scenes[0].location, "HOUSE");
});

test("a person is shown by name; the admin as admin (name); nobody when not recorded", () => {
  assert.equal(byLabel({ name: "Kumar", role: "screenplay_writer" }), "Kumar");
  assert.equal(byLabel({ name: "Somio", role: "admin" }), "admin (Somio)");
  assert.equal(byLabel({ role: "admin" }), "admin");
  assert.equal(byLabel(undefined), null);
});
