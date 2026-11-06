import test from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { screenplayDocxBuffer } from "../aiMovieDocx.js";

test("the Word file holds the title, every scene heading, the action in English and the dialogue in the chosen language", async () => {
  const scenes = [
    { sceneHeading: { en: "INT. TEMPLE - DAY", hi: "" }, content: [{ type: "action", text: { en: "Mira ties her anklets.", hi: "x" } }, { type: "dialogue", character: "Mira", line: { en: "Step back!", hi: "पीछे हटो!" }, parenthetical: { en: "firm", hi: "दृढ़" } }, { type: "transition", transition: "CUT TO" }] },
    { sceneHeading: { en: "EXT. BRIDGE - NIGHT" }, action: { en: "Swords clash." }, dialogue: [{ character: "Kaal", line: { en: "Come.", hi: "आओ" } }] },
  ];
  for (const [lang, line, other] of [["hi", "पीछे हटो!", "Step back!"], ["en", "Step back!", "पीछे हटो!"]]) {
    const buffer = await screenplayDocxBuffer(scenes, { title: "Tandava Storm", lang });
    assert.ok(buffer.length > 1000);
    const xml = new AdmZip(buffer).readAsText("word/document.xml");
    for (const text of ["TANDAVA STORM", "1. INT. TEMPLE - DAY", "2. EXT. BRIDGE - NIGHT", "Mira ties her anklets.", "Swords clash.", "MIRA", "KAAL", "CUT TO:", line]) assert.ok(xml.includes(text), `${lang}: missing ${text}`);
    assert.ok(!xml.includes(other), `${lang}: the other language leaked in`);
  }
});
