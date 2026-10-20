import test from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { buildApprovalDoc, cleanParagraphs, sceneHash, sceneHeaderLine, sceneToPlainInput, transitionLines, zipOf, APPROVAL_SYSTEM_PROMPT } from "../approvalFormat.js";

test("the scene heading line carries number, in/out, time, place and the characters", () => {
  assert.equal(
    sceneHeaderLine(2, { intExt: "INT", timeOfDay: "night", location: "Devi Maa temple", characters: ["Ram", "Devi Maa"] }),
    "SCENE 03 — INT. NIGHT / DEVI MAA TEMPLE / RAM, DEVI MAA"
  );
});

test("a combined EXT./INT. heading does not get a double full stop", () => {
  assert.equal(sceneHeaderLine(0, { intExt: "EXT./INT.", timeOfDay: "NIGHT", location: "Site", characters: [] }), "SCENE 01 — EXT./INT. NIGHT / SITE");
});

test("transitions: CUT TO between scenes, a TRANSITION line when the time changes, the episode's own ending at the last scene", () => {
  assert.deepEqual(transitionLines({ timeOfDay: "NIGHT" }, { timeOfDay: "NIGHT" }), ["CUT TO..."]);
  assert.deepEqual(transitionLines({ timeOfDay: "NIGHT" }, { timeOfDay: "DAY" }), ["CUT TO...", "TRANSITION TO DAY"]);
  assert.deepEqual(transitionLines({}, null, "fade out"), ["FADE OUT"]);
  assert.deepEqual(transitionLines({}, null, undefined), ["FREEZE."]);
});

test("the AI's answer is cleaned to plain paragraphs", () => {
  assert.deepEqual(cleanParagraphs({ paragraphs: ["  **We open** the scene.  ", "", 5, "Ram says, “Hello.”"] }), ["We open the scene.", "Ram says, “Hello.”"]);
  assert.deepEqual(cleanParagraphs(null), []);
});

test("a scene is remembered by its words: changing a line changes the key", () => {
  const a = sceneToPlainInput({ heading: "INT. HALL - DAY", location: "HALL", characters: ["RAM"], elements: [{ type: "dialogue", character: "RAM", text: "Hello" }] });
  const b = sceneToPlainInput({ heading: "INT. HALL - DAY", location: "HALL", characters: ["RAM"], elements: [{ type: "dialogue", character: "RAM", text: "Hello!" }] });
  assert.equal(sceneHash(a), sceneHash(a));
  assert.notEqual(sceneHash(a), sceneHash(b));
});

test("the instructions ask for Hinglish in roman letters, all events kept, nothing invented", () => {
  assert.match(APPROVAL_SYSTEM_PROMPT, /HINGLISH/);
  assert.match(APPROVAL_SYSTEM_PROMPT, /ROMAN letters/);
  assert.match(APPROVAL_SYSTEM_PROMPT, /Do not invent/);
});

test("the Word file has the title, scene lines, durations, paragraphs and the footer in the team's layout", async () => {
  const buffer = await buildApprovalDoc({
    title: "MAHA KALI", episodeNumber: 4,
    scenes: [
      { intExt: "EXT", timeOfDay: "NIGHT", location: "Kali temple grounds", characters: ["Soumya"], minutes: 1.5, paragraphs: ["We open the scene from Kali temple grounds."], after: ["CUT TO..."] },
      { intExt: "INT", timeOfDay: "DAY", location: "House", characters: [], minutes: 3, paragraphs: ["Ram says, “Hello.”"], after: ["FREEZE."] },
    ],
  });
  const zip = new AdmZip(buffer);
  const xml = zip.readAsText("word/document.xml");
  assert.match(xml, /MAHA KALI EP- 4/);
  assert.match(xml, /SCENE 01 — EXT\. NIGHT \/ KALI TEMPLE GROUNDS \/ SOUMYA/);
  assert.match(xml, /DURATION: 2 MINUTES/);
  assert.match(xml, /DURATION: 3 MINUTES/);
  assert.match(xml, /We open the scene from Kali temple grounds\./);
  assert.match(xml, /Times New Roman/);
  assert.match(xml, /FF0000/);
  assert.match(zip.getEntries().map((e) => zip.readAsText(e)).join(" "), /MAHA KALI \| EPISODE 04/);
});

test("all episodes go in one zip", () => {
  const zip = new AdmZip(zipOf([{ name: "a.docx", buffer: Buffer.from("x") }, { name: "b.docx", buffer: Buffer.from("y") }]));
  assert.deepEqual(zip.getEntries().map((e) => e.entryName).sort(), ["a.docx", "b.docx"]);
});
