import test from "node:test";
import assert from "node:assert/strict";
import { renameLocationInList, undoLocationRename } from "../locationRename.js";

const series = () => ({
  episodeScenes: [
    { scenes: [
      { intExt: "INT", location: { en: "Temple Sanctum" }, oneLiner: { en: "a" } },
      { intExt: "EXT", location: { en: "Temple Exterior" }, oneLiner: { en: "b" } },
      { intExt: "INT", location: { en: "Clinic" }, oneLiner: { en: "c" } },
    ] },
    { scenes: [{ intExt: "INT", location: { en: "TEMPLE KUTIYAR", hi: "मंदिर" }, oneLiner: { en: "d" } }] },
  ],
});

test("every variant becomes the one place; INT/EXT of each scene stays", () => {
  const r = renameLocationInList(series(), ["TEMPLE SANCTUM", "TEMPLE", "TEMPLE KUTIYAR"], "TEMPLE");
  assert.equal(r.changes.length, 3);
  const [a, b, c] = r.content.episodeScenes[0].scenes;
  assert.equal(a.location.en, "TEMPLE"); assert.equal(a.intExt, "INT");
  assert.equal(b.location.en, "TEMPLE"); assert.equal(b.intExt, "EXT");
  assert.equal(c.location.en, "Clinic");
  assert.deepEqual(r.content.episodeScenes[1].scenes[0].location, { en: "TEMPLE", hi: "TEMPLE" });
});

test("the original content is not modified, and a scene already named so is not counted", () => {
  const original = series();
  renameLocationInList(original, ["TEMPLE SANCTUM"], "TEMPLE");
  assert.equal(original.episodeScenes[0].scenes[0].location.en, "Temple Sanctum");
  const once = renameLocationInList(original, ["TEMPLE SANCTUM", "TEMPLE", "TEMPLE KUTIYAR"], "TEMPLE").content;
  assert.equal(renameLocationInList(once, ["TEMPLE"], "TEMPLE").changes.length, 0);
});

test("undo puts the old headings back, but not where the scene was changed again since", () => {
  const r = renameLocationInList(series(), ["TEMPLE SANCTUM", "TEMPLE KUTIYAR"], "TEMPLE");
  r.content.episodeScenes[1].scenes[0].location = { en: "SOMEWHERE NEW" };
  const u = undoLocationRename(r.content, r.changes);
  assert.equal(u.restored, 1);
  assert.equal(u.content.episodeScenes[0].scenes[0].location.en, "Temple Sanctum");
  assert.equal(u.content.episodeScenes[1].scenes[0].location.en, "SOMEWHERE NEW");
});

test("a film (not a series) works too", () => {
  const film = { scenes: [{ intExt: "INT", location: { en: "Temple Interior" } }, { intExt: "EXT", location: { en: "Road" } }] };
  const r = renameLocationInList(film, ["TEMPLE"], "KALI TEMPLE");
  assert.equal(r.content.scenes[0].location.en, "KALI TEMPLE");
  assert.equal(r.changes[0].episodeIndex, null);
  assert.equal(undoLocationRename(r.content, r.changes).content.scenes[0].location.en, "Temple Interior");
});
