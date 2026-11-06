import test from "node:test";
import assert from "node:assert/strict";
import { withWritingStyle, dialogueStyleText, actionStyleText, DIALOGUE_STYLE_GUIDE } from "../writingStyleGuide.js";

test("the style guide is added to a prompt, after the prompt's own text", () => {
  delete process.env.WRITING_STYLE_GUIDE;
  const out = withWritingStyle("BASE PROMPT");
  assert.ok(out.startsWith("BASE PROMPT"));
  assert.ok(out.includes("EASY-TO-UNDERSTAND DIALOGUE") && out.includes("EASY-TO-READ ACTION"));
  assert.equal(dialogueStyleText(), DIALOGUE_STYLE_GUIDE);
  assert.ok(actionStyleText().includes("Avengers"));
});

test("WRITING_STYLE_GUIDE=off removes it everywhere", () => {
  process.env.WRITING_STYLE_GUIDE = "off";
  try {
    assert.equal(withWritingStyle("BASE PROMPT"), "BASE PROMPT");
    assert.equal(dialogueStyleText(), "");
    assert.equal(actionStyleText(), "");
  } finally { delete process.env.WRITING_STYLE_GUIDE; }
});

test("the guide teaches the style and quotes nothing from the sample scripts", () => {
  const text = DIALOGUE_STYLE_GUIDE + actionStyleText();
  for (const line of ["Mast hain tumhara dadu", "Sunday done", "Right back at you", "Come back to reality", "Pleased to meet you"]) assert.ok(!text.includes(line), line);
});
