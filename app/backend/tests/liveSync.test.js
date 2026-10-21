import test from "node:test";
import assert from "node:assert/strict";
import { notePresence, othersEditing, parseSceneKey } from "../liveSync.js";

const admin = { id: 1, name: "Somio", role: "admin" };
const kumar = { id: 2, name: "Kumar", role: "screenplay_writer" };

test("a scene key is read back into episode and scene", () => {
  assert.deepEqual(parseSceneKey("2-5"), { episodeIndex: 2, sceneIndex: 5 });
  assert.deepEqual(parseSceneKey("film-0"), { episodeIndex: null, sceneIndex: 0 });
  assert.equal(parseSceneKey("x-1"), null);
  assert.equal(parseSceneKey(""), null);
});

test("each person sees the OTHERS who are editing, never themselves", () => {
  const presence = new Map();
  notePresence(presence, 7, kumar, "3-2", 1000);
  notePresence(presence, 7, admin, "3-0", 1000);
  assert.deepEqual(othersEditing(presence, 7, admin.id, 2000), [{ name: "Kumar", role: "screenplay_writer", label: "Kumar", key: "3-2" }]);
  assert.deepEqual(othersEditing(presence, 7, kumar.id, 2000).map((p) => p.label), ["admin (Somio)"]);
});

test("someone who stopped editing, or went quiet for a minute, disappears; another project is separate", () => {
  const presence = new Map();
  notePresence(presence, 7, kumar, "3-2", 1000);
  assert.equal(othersEditing(presence, 7, admin.id, 1000 + 59_000).length, 1);
  assert.equal(othersEditing(presence, 7, admin.id, 1000 + 61_000).length, 0);
  notePresence(presence, 7, kumar, "3-2", 5000);
  notePresence(presence, 7, kumar, null, 6000);
  assert.equal(othersEditing(presence, 7, admin.id, 6500).length, 0);
  notePresence(presence, 8, kumar, "0-0", 7000);
  assert.equal(othersEditing(presence, 7, admin.id, 7100).length, 0);
});
