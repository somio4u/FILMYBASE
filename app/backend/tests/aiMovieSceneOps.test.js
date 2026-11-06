// Adding, removing and moving the scenes of an AI Movie beat by hand (aiMovieSceneOps.js): pure functions, no database and no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { sceneHeadingText, newBlankScene, insertScene, removeSceneAt, moveSceneBy, keepRemoved, restoreRemoved } from "../aiMovieSceneOps.js";

const sc = (n) => ({ sceneHeading: { en: `INT. PLACE ${n} - DAY`, hi: `INT. PLACE ${n} - DAY` }, content: [{ type: "action", text: { en: `s${n}`, hi: `s${n}` } }], estimatedMinutes: 1 });
const names = (scenes) => scenes.map((s) => s.content[0].text.en).join(",");

test("a heading is built from INT/EXT, place and time; a blank scene carries it and the person's own line", () => {
  assert.equal(sceneHeadingText({ intExt: "ext", location: "  village  temple ", timeOfDay: "night" }), "EXT. VILLAGE TEMPLE - NIGHT");
  assert.equal(sceneHeadingText({ location: "kitchen" }), "INT. KITCHEN - DAY");
  assert.equal(sceneHeadingText({ intExt: "INT" }), "");
  const blank = newBlankScene({ intExt: "EXT", location: "Shore", timeOfDay: "Dawn", what: "Mala looks at the sea." });
  assert.equal(blank.sceneHeading.en, "EXT. SHORE - DAWN");
  assert.equal(blank.sceneHeading.hi, "EXT. SHORE - DAWN");
  assert.equal(blank.content[0].text.en, "Mala looks at the sea.");
  assert.equal(blank.estimatedMinutes, 1);
  assert.equal(blank.addedByUser, true);
  assert.equal(newBlankScene({ heading: "INT. HUT - NIGHT", minutes: 2.26 }).estimatedMinutes, 2.3);
  assert.equal(newBlankScene({ heading: "INT. HUT - NIGHT", minutes: 99 }).estimatedMinutes, 1); // an impossible length is ignored
  assert.throws(() => newBlankScene({ what: "no place" }), /place/);
});

test("inserting: at the start (-1), in the middle, at the end; a bad place is refused; the old list is untouched", () => {
  const list = [sc(1), sc(2), sc(3)];
  assert.equal(names(insertScene(list, -1, sc(9)).scenes), "s9,s1,s2,s3");
  assert.equal(names(insertScene(list, 0, sc(9)).scenes), "s1,s9,s2,s3");
  const end = insertScene(list, 2, sc(9));
  assert.equal(names(end.scenes), "s1,s2,s3,s9");
  assert.equal(end.index, 3);
  assert.equal(names(list), "s1,s2,s3");
  assert.throws(() => insertScene(list, 3, sc(9)), /place/);
  assert.throws(() => insertScene(list, "x", sc(9)), /place/);
  assert.throws(() => insertScene(null, 0, sc(9)), /no written scenes/);
});

test("removing: the scene goes, its neighbours stay; the last scene of a beat cannot be removed", () => {
  const list = [sc(1), sc(2), sc(3)];
  const r = removeSceneAt(list, 1);
  assert.equal(names(r.scenes), "s1,s3");
  assert.equal(r.removed.content[0].text.en, "s2");
  assert.equal(names(list), "s1,s2,s3");
  assert.throws(() => removeSceneAt(list, 3), /valid scene/);
  assert.throws(() => removeSceneAt([sc(1)], 0), /at least one scene/);
});

test("moving: up and down swap neighbours; the ends say so", () => {
  const list = [sc(1), sc(2), sc(3)];
  assert.equal(names(moveSceneBy(list, 1, "up").scenes), "s2,s1,s3");
  assert.equal(moveSceneBy(list, 1, "up").index, 0);
  assert.equal(names(moveSceneBy(list, 1, "down").scenes), "s1,s3,s2");
  assert.throws(() => moveSceneBy(list, 0, "up"), /first scene/);
  assert.throws(() => moveSceneBy(list, 2, "down"), /last scene/);
  assert.throws(() => moveSceneBy(list, 1, "sideways"), /up or down/);
  assert.equal(names(list), "s1,s2,s3");
});

test("undo of a removal puts the scene back at its place; only the newest 20 are kept; a vanished beat is skipped", () => {
  const beats = [{ scenes: [sc(1), sc(3)] }, { scenes: [sc(4)] }];
  const removed = { beatIndex: 0, sceneIndex: 1, scene: sc(2) };
  const back = restoreRemoved([removed], beats);
  assert.equal(names(back.beats[0].scenes), "s1,s2,s3");
  assert.equal(back.sceneIndex, 1);
  assert.deepEqual(back.kept, []);
  assert.equal(names(beats[0].scenes), "s1,s3"); // the input is not changed
  // the beat is now shorter than when the scene was removed: it goes as far back as it can
  assert.equal(restoreRemoved([{ beatIndex: 1, sceneIndex: 5, scene: sc(7) }], beats).sceneIndex, 1);
  // the newest first; a removal from a beat that no longer exists is skipped, the one before it is used
  const two = restoreRemoved([{ beatIndex: 0, sceneIndex: 0, scene: sc(8) }, { beatIndex: 9, sceneIndex: 0, scene: sc(9) }], beats);
  assert.equal(two.beatIndex, 0);
  assert.equal(restoreRemoved([], beats), null);
  assert.equal(restoreRemoved(undefined, beats), null);
  let list = [];
  for (let i = 0; i < 25; i++) list = keepRemoved(list, { beatIndex: 0, sceneIndex: 0, scene: sc(i) });
  assert.equal(list.length, 20);
  assert.equal(list.at(-1).scene.content[0].text.en, "s24");
});
