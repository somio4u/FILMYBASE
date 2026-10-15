import test from "node:test";
import assert from "node:assert/strict";
import { lengthRule } from "../aiMovieLength.js";
import { filmFormat } from "../aiMovieStory.js";
import { formatUnits } from "../storyBrain.js";

test("a 1-minute short film gets ONE sequence, not four, and its rule says one or two scenes", () => {
  const u = formatUnits(filmFormat({ kind: "short_film", runtimeMinutes: 1 }));
  assert.equal(u.count, 1);
  assert.match(u.label, /SHORT film of exactly 1 minute/);
  const rule = lengthRule("short_film", 1);
  assert.match(rule, /EXACTLY 1 MINUTE IN TOTAL/);
  assert.match(rule, /at most 2 beats/);
  assert.match(rule, /at most 2 scenes/);
});

test("short films scale gently: 5 minutes -> 3 sequences, 10 minutes -> 5 (never the 4+ of a feature for 1 minute)", () => {
  assert.equal(formatUnits(filmFormat({ kind: "short_film", runtimeMinutes: 5 })).count, 3);
  assert.equal(formatUnits(filmFormat({ kind: "short_film", runtimeMinutes: 10 })).count, 5);
  assert.match(lengthRule("short_film", 10), /at most 6 beats/);
  assert.match(lengthRule("short_film", 10), /at most 15 scenes/);
});

test("a short film can never be longer than 10 minutes, and a film is at least 11", () => {
  assert.equal(filmFormat({ kind: "short_film", runtimeMinutes: 45 }).runtimeMinutes, 10);
  assert.equal(filmFormat({ kind: "short_film", runtimeMinutes: 0.2 }).runtimeMinutes, 1);
  assert.equal(filmFormat({ kind: "short_film" }).runtimeMinutes, 5);
  assert.equal(filmFormat({ kind: "film", runtimeMinutes: 3 }).runtimeMinutes, 11);
  assert.equal(filmFormat({ kind: "film", runtimeMinutes: 150 }).runtimeMinutes, 150);
  assert.equal(filmFormat({}).runtimeMinutes, 120);
  assert.equal(filmFormat({ kind: "film", runtimeMinutes: 150 }).short, false);
});

test("a feature film is sized exactly as before", () => {
  const u = formatUnits(filmFormat({ kind: "film", runtimeMinutes: 120 }));
  assert.equal(u.count, 8);
  assert.match(u.label, /feature film of 120 minutes/);
  assert.match(lengthRule("film", 120), /120 minutes long in total/);
});

test("no length set (older projects) adds no rule at all", () => {
  assert.equal(lengthRule(null, null), "");
  assert.equal(lengthRule("film", 0), "");
});
