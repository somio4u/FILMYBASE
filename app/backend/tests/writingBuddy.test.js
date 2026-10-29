import test from "node:test";
import assert from "node:assert/strict";
import { BUDDY_GUIDE, BUDDY_PERSONA, buddySystemPrompt, historyToContents, rolePhrase, sceneContextText } from "../writingBuddy.js";
import { matchWriterRoute } from "../writerAccess.js";

const sceneList = {
  targetMinutes: 90,
  scenes: [
    { sceneNumber: "1", intExt: "INT", location: { en: "Kali Temple" }, timeOfDay: "DAY", oneLiner: { en: "The priest finds the idol's eyes stolen." }, estimatedMinutes: 2, purpose: "setup" },
    { sceneNumber: "2", intExt: "EXT", location: { en: "Road" }, timeOfDay: "NIGHT", oneLiner: { en: "A chase." }, estimatedMinutes: 3 },
    { sceneNumber: "3", intExt: "INT", location: { en: "Hospital" }, timeOfDay: "DAY", estimatedMinutes: 1 },
  ],
};
const elements = [
  { type: "action", text: "The priest enters. He stops." },
  { type: "dialogue", character: "PUJARI", parenthetical: "shaken", text: "Maa... the eyes are gone." },
  { type: "dialogue", character: "GOLOK", text: "What?" },
  { type: "transition", text: "Cut to...." },
];

test("the scene pack tells the model the project, the selected scene, its planned and estimated length, who speaks, and the neighbours", () => {
  const text = sceneContextText({ title: "Maha Kali", sceneList, episodeIndex: null, sceneIndex: 1, elements, dialogueLanguage: "or", estimateSeconds: () => 75 });
  assert.match(text, /Project: Maha Kali — a film; 3 scenes/);
  assert.match(text, /Target runtime: 90 minutes/);
  assert.match(text, /SELECTED SCENE: scene 2 — EXT\. Road - NIGHT/);
  assert.match(text, /PLANNED length: 3 minutes/);
  assert.match(text, /ESTIMATED length from the written lines: 1 min 15 s \(4 lines\)/);
  assert.match(text, /Speaking characters: PUJARI, GOLOK/);
  assert.match(text, /Dialogue language of this scene: Odia/);
  assert.match(text, /\[ACTION\] The priest enters/);
  assert.match(text, /PUJARI \(shaken\): Maa\.\.\. the eyes are gone\./);
  assert.match(text, /\[TRANSITION\] Cut to\.\.\.\./);
  assert.match(text, /Scene before: scene 1: INT\. Kali Temple - DAY — The priest finds/);
  assert.match(text, /Scene after: scene 3: INT\. Hospital - DAY/);
  assert.match(text, /ALL SCENES[\s\S]*1\. INT\. Kali Temple - DAY \(2 min\)[\s\S]*3\. INT\. Hospital - DAY \(1 min\)/);
});

test("a scene that is not written yet says so; a series names the episode; no scene selected is handled", () => {
  assert.match(sceneContextText({ sceneList, episodeIndex: null, sceneIndex: 2, elements: null }), /has NOT been written yet/);
  const series = { episodeScenes: [{ scenes: [sceneList.scenes[0]] }, { scenes: [sceneList.scenes[1], sceneList.scenes[2]] }] };
  const t = sceneContextText({ title: "S", sceneList: series, episodeIndex: 1, sceneIndex: 0, elements: null });
  assert.match(t, /a series of 2 episodes; 2 scenes in episode 2/);
  assert.match(t, /episode 2, scene 2 — EXT\. Road/);
  assert.match(sceneContextText({ sceneList, sceneIndex: -1 }), /No scene is selected/);
});

test("a very long scene is cut, saying how much was left out", () => {
  const long = [{ type: "action", text: "x".repeat(20000) }];
  const t = sceneContextText({ sceneList, sceneIndex: 0, elements: long, maxSceneChars: 1000 });
  assert.match(t, /\[… cut here: \d+ more characters not shown\]/);
  assert.ok(t.length < 3000);
});

test("the conversation is sent back as the model's turns, newest 30, always starting with the person", () => {
  const rows = [
    { role: "assistant", content: "orphan answer" },
    { role: "user", content: "Q1" }, { role: "assistant", content: "A1" }, { role: "user", content: "   " }, { role: "user", content: "Q2" },
  ];
  assert.deepEqual(historyToContents(rows).map((t) => [t.role, t.parts[0].text]), [["user", "Q1"], ["model", "A1"], ["user", "Q2"]]);
  const many = Array.from({ length: 80 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }));
  const kept = historyToContents(many, { max: 30 });
  assert.ok(kept.length <= 30);
  assert.equal(kept[0].role, "user");
  assert.equal(kept[kept.length - 1].parts[0].text, "m79");
});

test("the system prompt carries the persona, the honesty rules, the app guide, the person's role and the scene", () => {
  const prompt = buddySystemPrompt({ user: { name: "Chandan", role: "independent_writer" }, scenePack: "SELECTED SCENE: scene 7" });
  for (const part of ["Name: Chandan", "Independent Writer", "SELECTED SCENE: scene 7", "you can only TALK", "NEVER say or imply that you changed", "Edit this scene", "Director Screenplay"]) assert.ok(prompt.includes(part), part);
  assert.equal(rolePhrase("admin").startsWith("Admin"), true);
  assert.ok(BUDDY_PERSONA.length > 500 && BUDDY_GUIDE.length > 1500);
});

test("the chat routes are open to the writers, for their own project only (checked through the scene list)", () => {
  assert.equal(matchWriterRoute("GET", "/api/assistant/31/history")?.kind, "sceneList");
  assert.equal(matchWriterRoute("DELETE", "/api/assistant/31/history")?.kind, "sceneList");
  assert.equal(matchWriterRoute("POST", "/api/assistant/31/message")?.kind, "sceneList");
  assert.equal(matchWriterRoute("PUT", "/api/assistant/31/message"), null);
  assert.equal(matchWriterRoute("GET", "/api/assistant/abc/history"), null);
});
