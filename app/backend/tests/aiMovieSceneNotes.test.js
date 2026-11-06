import test from "node:test";
import assert from "node:assert/strict";
import { withSceneTag, tagOfScene, SCENE_TAGS } from "../aiMovieSceneNotes.js";
import { moveSceneBy, removeSceneAt, insertScene, newBlankScene } from "../aiMovieSceneOps.js";

const scene = (n) => ({ sceneHeading: { en: `INT. ROOM ${n} - DAY`, hi: `INT. ROOM ${n} - DAY` }, content: [] });

test("a tag and note are stored in the scene and read back", () => {
  const s = withSceneTag(scene(1), { tag: "change", note: "  make   the speech shorter " }, { by: "Director", now: new Date("2026-11-06T10:00:00Z") });
  assert.deepEqual(tagOfScene(s), { tag: "change", note: "make the speech shorter", by: "Director", at: "2026-11-06T10:00:00.000Z" });
  assert.equal(s.sceneHeading.en, "INT. ROOM 1 - DAY", "the scene itself is untouched");
});

test("clearing removes it; a wrong tag is refused; the note is capped", () => {
  const tagged = withSceneTag(scene(1), { tag: "done", note: "x".repeat(900) });
  assert.equal(tagOfScene(tagged).note.length, 300);
  assert.equal(tagOfScene(withSceneTag(tagged, null)), null);
  assert.equal("tag" in withSceneTag(tagged, { tag: null }), false);
  assert.throws(() => withSceneTag(scene(1), { tag: "purple" }), /change, check, new or done/);
  assert.deepEqual(SCENE_TAGS, ["change", "check", "new", "done"]);
});

test("the tag travels with its scene when scenes are moved, removed or added", () => {
  let scenes = [scene(1), withSceneTag(scene(2), { tag: "check", note: "timing" }), scene(3)];
  scenes = moveSceneBy(scenes, 1, "up").scenes;
  assert.equal(tagOfScene(scenes[0]).tag, "check");
  scenes = insertScene(scenes, -1, newBlankScene({ location: "TEMPLE" })).scenes;
  assert.equal(tagOfScene(scenes[1]).tag, "check");
  scenes = removeSceneAt(scenes, 0).scenes;
  assert.equal(tagOfScene(scenes[0]).note, "timing");
});
