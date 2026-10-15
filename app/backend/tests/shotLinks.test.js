import { test } from "node:test";
import assert from "node:assert/strict";
import { assetsForShot } from "../shots.js";
import { keyframePrompt } from "../generations.js";

const asset = (id, kind, name) => ({ id, kind, code: `X${id}`, name, aliases: [] });

test("a shot also links an item the scene links missed, when its text names it", () => {
  const scene = [asset(1, "location", "Village gate")];
  const others = [asset(2, "character", "Rohan"), asset(3, "prop", "Jeep"), asset(4, "character", "Meera")];
  const ids = assetsForShot({ description: "Rohan sits in the Jeep at night.", dialogueIds: [] }, [], scene, others);
  assert.deepEqual([...ids].sort(), [1, 2, 3]);
});

test("the picture command tells the model not to invent people, vehicles or places", () => {
  const text = keyframePrompt({ description: "Rohan at the gate", assets: [] }, {}, ["Rohan", "Village gate"]);
  assert.match(text, /Do not invent other main characters, vehicles, buildings or locations/);
});

test("the frame command names the only people allowed, or forbids inventing a crowd when none is linked", () => {
  const withWho = keyframePrompt({ description: "Rohan arrives", assets: [{ kind: "character", name: "Rohan" }] }, {}, ["Rohan"]);
  assert.match(withWho, /The only named people in this frame are: Rohan/);
  const none = keyframePrompt({ description: "A jeep at a gate", assets: [] }, {}, []);
  assert.match(none, /do not invent characters and do not fill the frame with a crowd/);
});
