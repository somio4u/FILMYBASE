import test from "node:test";
import assert from "node:assert/strict";
import { foreignOrigin, normalizeStyle, personRule, objectRule, shotRule, INDIAN_PERSON } from "../castRule.js";
import { assetPrompt, keyframePrompt, videoPrompt, sheetSpec, frameSpec, videoSpec } from "../generations.js";

const rohan = { id: 1, kind: "character", name: "Rohan", agent_details: { description: "a lean man in a green t-shirt" }, human_edits: {} };
const shot = { id: 5, framing: "Wide", cameraAngle: "Eye level", cameraMove: "Static", description: "Rohan meets John in the market.", assets: [{ id: 1, kind: "character", name: "Rohan", code: "CHAR001" }, { id: 2, kind: "character", name: "John", code: "CHAR002", origin: "British" }], durationSec: 5 };
const style = { text: "Photorealistic live-action film look", castOrigin: "indian" };

test("a character is Indian unless its origin names another country", () => {
  assert.equal(foreignOrigin({}), null);
  assert.equal(foreignOrigin({ origin: "" }), null);
  for (const indian of ["Indian", "Odia", "from Odisha", "Bengali", "South Asian"]) assert.equal(foreignOrigin({ origin: indian }), null, indian);
  assert.equal(foreignOrigin({ origin: "British" }), "British");
  assert.equal(foreignOrigin({ nationality: "Japanese" }), "Japanese");
  assert.equal(foreignOrigin({ ethnicity: " Nigerian " }), "Nigerian");
});

test("the default is the Indian rule; older callers with a plain style text get it too", () => {
  assert.equal(normalizeStyle("plain look").castOrigin, "indian");
  assert.equal(normalizeStyle(undefined).castOrigin, "indian");
  assert.equal(normalizeStyle({ text: "x", castOrigin: "none" }).castOrigin, "none");
  assert.equal(normalizeStyle({ text: "x", castOrigin: "weird" }).castOrigin, "indian");
});

test("character sheet: Indian by default, never Hollywood; a foreign origin is honoured; the rule can be switched off", () => {
  const p = assetPrompt(rohan, style);
  assert.ok(p.includes(INDIAN_PERSON));
  assert.match(p, /Indian person/);
  assert.match(p, /must NOT look European, American, British, Hollywood/);
  const john = assetPrompt({ ...rohan, name: "John", human_edits: { origin: "British" } }, style);
  assert.doesNotMatch(john, /INDIAN CAST/);
  assert.match(john, /This character is British \(NOT Indian\)/);
  assert.doesNotMatch(assetPrompt(rohan, { ...style, castOrigin: "none" }), /INDIAN CAST/);
  assert.doesNotMatch(assetPrompt(rohan, "just text"), /Hollywood.*Hollywood/);
});

test("props (single and sheets) are Indian objects; environments are left to the story", () => {
  const prop = assetPrompt({ id: 3, kind: "prop", name: "Lamp", agent_details: {}, human_edits: {} }, style);
  assert.match(prop, /INDIAN OBJECTS/);
  const sheet = assetPrompt({ id: 4, kind: "prop", name: "Props sheet 1", agent_details: {}, human_edits: {}, group_members: [{ position: 1, name: "Mug" }, { position: 2, name: "Camera" }] }, style);
  assert.match(sheet, /INDIAN OBJECTS/);
  const place = assetPrompt({ id: 5, kind: "location", name: "Temple", agent_details: {}, human_edits: {} }, style);
  assert.doesNotMatch(place, /INDIAN CAST|INDIAN OBJECTS/);
});

test("shots: every person in the frame is Indian, extras too, except a named foreign character; videos too", () => {
  const k = keyframePrompt(shot, style, ["Rohan", "John"]);
  assert.match(k, /Every person in this frame is Indian/);
  assert.match(k, /extras and crowd included/);
  assert.match(k, /Exception: John is British, not Indian/);
  assert.match(videoPrompt(shot, style), /Every person in this frame is Indian/);
  assert.doesNotMatch(keyframePrompt(shot, { ...style, castOrigin: "none" }, []), /Every person in this frame is Indian/);
  assert.equal(shotRule(shot.assets, "none"), "");
  assert.equal(personRule({}, "none"), "");
  assert.equal(objectRule("none"), "");
});

test("changing the origin or the rule changes the fingerprints, so old commands show as out of date", () => {
  const a = sheetSpec(rohan, style).sourceHash;
  assert.notEqual(a, sheetSpec({ ...rohan, human_edits: { origin: "British" } }, style).sourceHash);
  assert.notEqual(a, sheetSpec(rohan, { ...style, castOrigin: "none" }).sourceHash);
  const f = frameSpec(shot, style).sourceHash;
  assert.notEqual(f, frameSpec({ ...shot, assets: [shot.assets[0], { ...shot.assets[1], origin: undefined }] }, style).sourceHash);
  assert.notEqual(f, frameSpec(shot, { ...style, castOrigin: "none" }).sourceHash);
  assert.notEqual(videoSpec(shot, style).sourceHash, videoSpec(shot, { ...style, castOrigin: "none" }).sourceHash);
});
