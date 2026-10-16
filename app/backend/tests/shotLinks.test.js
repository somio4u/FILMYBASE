import { test } from "node:test";
import assert from "node:assert/strict";
import { assetsForShot } from "../shots.js";
import { keyframePrompt, plannedRefNames, wordsOnlyNames } from "../generations.js";
import { frameDescriptionPrompt } from "../frameDescriptions.js";

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

test("six items in a frame: five pictures are attached, the sixth is named in words, and the command and the pictures agree", () => {
  const assets = [
    ...["Rohan", "Mitra", "Sagar", "Dev"].map((name, i) => ({ id: i + 1, kind: "character", name })),
    { id: 5, kind: "location", name: "Palace road" }, { id: 6, kind: "prop", name: "Jeep" },
  ];
  const shot = { description: "Four friends in a jeep", framePeople: 4, assets };
  const names = plannedRefNames(shot);
  assert.equal(names.length, 5);
  assert.deepEqual(wordsOnlyNames(shot), ["Jeep"]);
  const text = keyframePrompt(shot, {}, names);
  assert.match(text, /no attached picture \(draw them from the description\): Jeep/);
  assert.match(text, /ALL 4 are clearly visible/);
  assert.match(text, /exactly 4 people/);
});

test("the description writer is told the story, the neighbouring shots, to keep the group's count and to place each person", () => {
  const prompt = frameDescriptionPrompt({
    heading: "EXT. ROAD - NIGHT", elements: [{ kind: "action", text: "A jeep rolls on." }],
    shots: [{ code: "SH001", description: "Headlights on the arch", durationSec: 7 }],
    allShots: [{ code: "SH001", description: "Headlights on the arch" }, { code: "SH002", description: "ROHAN jumps out of the jeep" }],
    story: "Four friends set out for the old palace.", assets: [{ id: 1, kind: "character", name: "Rohan" }], present: [1],
  });
  assert.match(prompt, /Four friends set out/);
  assert.match(prompt, /SH002: ROHAN jumps out/);
  assert.match(prompt, /never reduce a group to one person/);
  assert.match(prompt, /Describe EACH person separately/);
  assert.match(prompt, /countKnown/);
  assert.match(prompt, /Rohan \[in this scene\]/);
});
