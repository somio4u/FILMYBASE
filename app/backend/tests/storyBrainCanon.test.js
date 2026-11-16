// An uploaded synopsis is CANON: the Story Brain keeps its characters, events and ending, and only builds around it. A one-line idea is still a seed (three pitches).
import test from "node:test";
import assert from "node:assert/strict";
import { designStoryBible, isCanonSynopsis, CANON_RULES, CANON_MIN_WORDS } from "../storyBrain.js";

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const STOP = new Error("stop here");
const direction = { title: "T", logline: "L", centralQuestion: "Q", genrePromise: "G", coldOpen: "C", openingEnding: "O", climaxTwist: "X", whyWow: "W" };
const FORMAT = { type: "film", runtimeMinutes: 120 };

// a scripted "ask": records every call, answers the first step, stops at the second
function scripted() {
  const calls = [];
  const ask = async (label, contents) => {
    calls.push({ label, contents });
    if (calls.length === 1) return { directions: [direction, direction, direction] };
    throw STOP;
  };
  return { calls, ask };
}

test("what counts as a synopsis: a long text is canon, a one-line idea is a seed", () => {
  assert.equal(isCanonSynopsis("A girl returns to her village."), false);
  assert.equal(isCanonSynopsis(words(CANON_MIN_WORDS - 1)), false);
  assert.equal(isCanonSynopsis(words(CANON_MIN_WORDS)), true);
  assert.equal(isCanonSynopsis(""), false);
});

test("an uploaded synopsis: ONE direction, read out of the text — no three pitches, no audience critic — and the canon rules travel with every step", async () => {
  const { calls, ask } = scripted();
  await assert.rejects(() => designStoryBible(words(200), FORMAT, { ask }), STOP);
  assert.equal(calls[0].label, "Direction taken from the synopsis");
  assert.ok(calls[0].contents.includes("CANON") && calls[0].contents.includes(CANON_RULES));
  assert.ok(!/THREE genuinely different/.test(calls[0].contents), "no alternatives are pitched");
  assert.equal(calls[1].label, "Hidden truth, characters and facts", "straight to the foundation: no audience critic step in between");
  assert.ok(calls[1].contents.includes(CANON_RULES), "the next step carries the canon rules too");
  assert.ok(calls[1].contents.includes("THE OWNER'S SYNOPSIS"));
});

test("a one-line idea is still a seed: three different directions are pitched and a critic picks", async () => {
  const { calls, ask } = scripted();
  await assert.rejects(() => designStoryBible("A girl returns to her village.", FORMAT, { ask }), STOP);
  assert.equal(calls[0].label, "Pitch room");
  assert.ok(/THREE genuinely different/.test(calls[0].contents));
  assert.ok(!calls[0].contents.includes(CANON_RULES));
  assert.equal(calls[1].label, "Audience critic picks a direction");
});

test("canon can be forced either way by the caller", async () => {
  const forcedOn = scripted();
  await assert.rejects(() => designStoryBible("A short idea.", FORMAT, { ask: forcedOn.ask, canon: true }), STOP);
  assert.equal(forcedOn.calls[0].label, "Direction taken from the synopsis");
  const forcedOff = scripted();
  await assert.rejects(() => designStoryBible(words(300), FORMAT, { ask: forcedOff.ask, canon: false }), STOP);
  assert.equal(forcedOff.calls[0].label, "Pitch room");
});

test("the review and revision prompts of EVERY idea say the story, theme and style are locked and a lower score is fine", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../storyBrain.js", import.meta.url), "utf8");
  assert.match(src, /THE STORY IS LOCKED/);
  assert.match(src, /A lower score is acceptable; changing the story is not/);
  // the note is added for every bible, canon or not
  assert.match(src, /bible\?\.canon \? `[^`]*\$\{locked\}` : locked/);
});
