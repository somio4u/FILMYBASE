import test from "node:test";
import assert from "node:assert/strict";
import { joinActs, stripActLabel } from "../../frontend/src/joinActs.js";
import { parseScreenplayText } from "../screenplayTextParser.js";

const act = (n, label) => `${label ? `${label}\n` : ""}INT. ROOM ${n} - DAY\n\nRAJU\nHello ${n}.\n\nMEERA\nBye ${n}.\n\nEXT. ROAD ${n} - NIGHT\n\nRaju walks.\n`;

test("three acts join in order into ONE screenplay: scenes run on across the acts, nothing is split into stories", () => {
  const text = joinActs([act(1, "ACT ONE"), act(2, "ACT TWO"), act(3, "ACT 3")]);
  assert.doesNotMatch(text, /ACT (ONE|TWO|3)/);
  const scenes = parseScreenplayText(text);
  assert.equal(scenes.length, 6);
  assert.deepEqual(scenes.map((s) => s.heading.split(" - ")[0]), ["INT. ROOM 1", "EXT. ROAD 1", "INT. ROOM 2", "EXT. ROAD 2", "INT. ROOM 3", "EXT. ROAD 3"]);
});

test("only a lone act label at the very top of a part is dropped; the same words inside the film are kept", () => {
  assert.equal(stripActLabel("ACT TWO\nINT. A - DAY"), "INT. A - DAY");
  assert.equal(stripActLabel("INT. A - DAY\nRAJU\nACT TWO is over.\n"), "INT. A - DAY\nRAJU\nACT TWO is over.\n");
  assert.equal(joinActs(["a", "b", "c"]), "a\n\nb\n\nc");
});
