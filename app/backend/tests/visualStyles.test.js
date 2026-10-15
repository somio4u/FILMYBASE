import test from "node:test";
import assert from "node:assert/strict";
import { VISUAL_STYLES, DEFAULT_VISUAL_STYLE, resolveStyle, isVisualStyle, isPhotographic } from "../visualStyles.js";
import { assetPrompt, keyframePrompt, videoPrompt, sheetSpec, frameSpec, videoSpec } from "../generations.js";

const character = { id: 1, kind: "character", name: "Rohan", details: { description: "a lean man in a green t-shirt" } };
const shot = { id: 5, framing: "Wide", cameraAngle: "Eye level", cameraMove: "Static", description: "Rohan walks into the temple.", assets: [], durationSec: 5 };

test("the default look is realistic, never a drawing", () => {
  assert.equal(DEFAULT_VISUAL_STYLE, "realistic");
  assert.match(resolveStyle("realistic"), /Photorealistic live-action/);
  assert.match(resolveStyle("realistic"), /NOT a drawing/);
  assert.match(resolveStyle("realistic"), /NOT a cartoon/);
  assert.equal(resolveStyle(undefined), resolveStyle("realistic"));
});

test("there is a ready-made style for realistic, cartoon, anime and more, each with its own words", () => {
  const ids = VISUAL_STYLES.map((s) => s.id);
  for (const id of ["realistic", "cinematic", "cartoon", "anime", "animation3d", "comic", "painting", "indian_art", "noir"]) assert.ok(ids.includes(id), id);
  assert.equal(new Set(VISUAL_STYLES.map((s) => s.text)).size, VISUAL_STYLES.length, "every style is different");
  assert.match(resolveStyle("anime"), /anime/i);
  assert.match(resolveStyle("cartoon"), /cartoon/i);
  assert.ok(isVisualStyle("custom") && isVisualStyle("anime") && !isVisualStyle("sparkly"));
});

test("a custom look uses the director's own words", () => {
  assert.equal(resolveStyle("custom", "  warm 1970s Odia village film, grainy  "), "warm 1970s Odia village film, grainy");
});

test("the chosen style is written into the commands for characters, environments, properties, shots and videos", () => {
  for (const id of ["realistic", "cartoon", "anime"]) {
    const style = resolveStyle(id);
    assert.ok(assetPrompt(character, style).includes(style), `character sheet / ${id}`);
    assert.ok(assetPrompt({ id: 2, kind: "location", name: "Temple", details: {} }, style).includes(style), `environment sheet / ${id}`);
    assert.ok(assetPrompt({ id: 3, kind: "prop", name: "Lamp", details: {} }, style).includes(style), `property sheet / ${id}`);
    assert.ok(keyframePrompt(shot, style, []).includes(style), `shot frame / ${id}`);
    assert.ok(videoPrompt(shot, style).includes(style), `video / ${id}`);
    assert.match(assetPrompt(character, style), /follow it strictly/);
  }
});

test("a non-photographic style does not also ask for 'photographic detail'; a realistic one does", () => {
  assert.match(keyframePrompt(shot, resolveStyle("realistic"), []), /photographic detail/);
  assert.doesNotMatch(keyframePrompt(shot, resolveStyle("anime"), []), /photographic detail/);
  assert.doesNotMatch(keyframePrompt(shot, resolveStyle("cartoon"), []), /photographic detail/);
  assert.equal(isPhotographic(resolveStyle("noir")), true);
  assert.equal(isPhotographic(resolveStyle("anime")), false);
});

test("changing the style changes every planned command's fingerprint, so old commands show as out of date", () => {
  const a = resolveStyle("realistic"), b = resolveStyle("anime");
  assert.notEqual(sheetSpec(character, a).sourceHash, sheetSpec(character, b).sourceHash);
  assert.notEqual(frameSpec(shot, a).sourceHash, frameSpec(shot, b).sourceHash);
  assert.notEqual(videoSpec(shot, a).sourceHash, videoSpec(shot, b).sourceHash);
});
