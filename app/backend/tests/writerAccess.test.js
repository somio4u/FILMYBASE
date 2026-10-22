import test from "node:test";
import assert from "node:assert/strict";
import { matchWriterRoute, cleanProgress, workOf, WRITER_ROLE } from "../writerAccess.js";

const ok = (method, path) => Boolean(matchWriterRoute(method, path));

test("a screenplay writer may use the story and screenplay tools", () => {
  for (const [m, p] of [
    ["GET", "/api/concepts/12/full"], ["POST", "/api/concepts/12/title"],
    ["POST", "/api/screenplay/scene"], ["POST", "/api/screenplay/scene/voice"], ["POST", "/api/screenplay/scene/undo"], ["POST", "/api/screenplay/scene/55/edit"], ["POST", "/api/screenplay/scene/55/draft"], ["GET", "/api/scene-lists/7/sync"], ["PUT", "/api/scene-lists/7/scene-tag"],
    ["GET", "/api/screenplay/scenes"], ["POST", "/api/voice/understand"], ["POST", "/api/transcribe"],
    ["POST", "/api/scene-lists/7/scenes"], ["DELETE", "/api/scene-lists/7/scenes"], ["POST", "/api/scene-lists/7/scenes/move"], ["PATCH", "/api/scene-lists/7/scenes/heading"],
    ["POST", "/api/scene-lists/7/rename-character"], ["POST", "/api/scene-lists/7/convert-language"], ["GET", "/api/scene-lists/7/screenplay-pdf"],
    ["POST", "/api/pitch-deck/3/approve"], ["POST", "/api/pitch-deck/3/episode-title"], ["POST", "/api/bit-sheet/4/request-changes"], ["POST", "/api/character-sheet/5/find-characters"],
    ["GET", "/api/writer/progress"], ["PUT", "/api/writer/progress"], ["POST", "/api/auth/logout"],
  ]) assert.ok(ok(m, p), `${m} ${p} should be allowed`);
});

test("everything else is refused: production, pictures, video, budget, team, other modules, importing and deleting projects", () => {
  for (const [m, p] of [
    ["POST", "/api/auth/users"], ["GET", "/api/auth/users"], ["DELETE", "/api/auth/users/3"],
    ["DELETE", "/api/concepts/12"], ["POST", "/api/concepts/import"], ["GET", "/api/projects/master-list"],
    ["POST", "/api/script-breakdown"], ["POST", "/api/shoot-schedule"], ["GET", "/api/crew"], ["POST", "/api/crew"],
    ["POST", "/api/scene-lists/7/send-to-ai-production"], ["POST", "/api/scene-lists/7/reimport-screenplay"],
    ["POST", "/api/production/4/generate"], ["GET", "/api/production/4/settings"], ["POST", "/api/ai-movie/projects/4/auto-production"],
    ["POST", "/api/generate-storylines"], ["POST", "/api/auto-pipeline/start"], ["GET", "/api/drafts"], ["GET", "/api/adu/current"],
    ["GET", "/api/concepts/latest"], ["GET", "/api/pitch-deck/latest"], ["GET", "/api/scene-list/latest"],
    ["DELETE", "/api/screenplay/scene"], ["GET", "/api/screenplay/scene/voice"],
  ]) assert.ok(!ok(m, p), `${m} ${p} must be refused`);
});

test("the place where he stopped is saved clean: known stage, whole numbers only", () => {
  assert.equal(WRITER_ROLE, "screenplay_writer");
  assert.deepEqual(cleanProgress({ stage: "screenplay", groupIndex: 1, sceneIndex: 7, editMode: true, scrollTop: 1200.4, evil: "x" }), { stage: "screenplay", groupIndex: 1, sceneIndex: 7, editMode: true, scrollTop: 1200 });
  assert.deepEqual(cleanProgress({ stage: "production", groupIndex: -3, sceneIndex: "9", editMode: "yes" }), { stage: "screenplay", groupIndex: 0, sceneIndex: 0, editMode: false, scrollTop: 0 });
  assert.deepEqual(cleanProgress(null), { stage: "screenplay", groupIndex: 0, sceneIndex: 0, editMode: false, scrollTop: 0 });
});

test("what a writer did is named in plain terms, with the episode", () => {
  assert.deepEqual(workOf("POST", "/api/screenplay/scene/undo", { episodeIndex: 3, sceneIndex: 2 }), { action: "undo", episodeIndex: 3, sceneIndex: 2 });
  assert.deepEqual(workOf("DELETE", "/api/scene-lists/7/scenes", { episodeIndex: 1, sceneIndex: 0 }), { action: "delete", episodeIndex: 1, sceneIndex: 0 });
  assert.equal(workOf("POST", "/api/scene-lists/7/scenes/move", { episodeIndex: 1 }).action, "move");
  assert.equal(workOf("POST", "/api/screenplay/scene/55/edit", {}).sceneRowId, 55);
  assert.equal(workOf("POST", "/api/screenplay/scene/55/draft", {}).action, "edit");
  assert.deepEqual(workOf("POST", "/api/scene-lists/7/rename-character", {}), { action: "rename", episodeIndex: null, sceneIndex: null });
  assert.equal(workOf("PUT", "/api/scene-lists/7/scene-tag", { episodeIndex: 1, sceneIndex: 2, tag: "done" }).action, "tagdone");
  assert.equal(workOf("PUT", "/api/scene-lists/7/scene-tag", { tag: "change" }).action, "tag");
  assert.equal(workOf("POST", "/api/scene-lists/7/scenes/plan", {}), null);
  assert.equal(workOf("POST", "/api/pitch-deck", {}), null);
  assert.equal(workOf("POST", "/api/scene-lists/7/rename-character", { preview: true }), null);
});
