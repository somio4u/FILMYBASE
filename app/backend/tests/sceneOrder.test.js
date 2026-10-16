import test from "node:test";
import assert from "node:assert/strict";
import { moveIndex, moveInArray, moveCaseSql, validMove } from "../sceneOrder.js";

test("scene 2 dragged after scene 5: the scenes in between close the gap, the others stay", () => {
  // positions are 0-based: scene 2 is index 1, "after scene 5" is index 4
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((i) => moveIndex(i, 1, 4)), [0, 4, 1, 2, 3, 5, 6]);
  assert.deepEqual(moveInArray(["s1", "s2", "s3", "s4", "s5", "s6"], 1, 4), ["s1", "s3", "s4", "s5", "s2", "s6"]);
});

test("dragging a scene up moves the ones above it down by one", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => moveIndex(i, 4, 1)), [0, 2, 3, 4, 1, 5]);
  assert.deepEqual(moveInArray(["a", "b", "c", "d", "e"], 4, 1), ["a", "e", "b", "c", "d"]);
});

test("the SQL renumbering rule agrees with the array rule and only touches the range between", () => {
  const { lo, hi, sql } = moveCaseSql(1, 4);
  assert.equal(lo, 1); assert.equal(hi, 4);
  assert.match(sql, /scene_index = 1 THEN 4 ELSE scene_index \+ \(-1\)/);
  assert.match(moveCaseSql(4, 1).sql, /scene_index = 4 THEN 1 ELSE scene_index \+ \(1\)/);
});

test("a move must be inside the list and go somewhere", () => {
  assert.equal(validMove(5, 1, 4), true);
  assert.equal(validMove(5, 2, 2), false);
  assert.equal(validMove(5, 0, 5), false);
  assert.equal(validMove(5, -1, 2), false);
  assert.equal(validMove(5, 1.5, 2), false);
});
