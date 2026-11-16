import test from "node:test";
import assert from "node:assert/strict";
import { projectProgress } from "../projectProgress.js";

test("a project's stage is the furthest step that exists, with whether it is approved", () => {
  assert.deepEqual(projectProgress({}), { stageKey: "story", stageApproved: false });
  assert.deepEqual(projectProgress({ n_deck: 1, ok_deck: true }), { stageKey: "synopsis", stageApproved: true });
  assert.deepEqual(projectProgress({ n_deck: 1, n_chars: 1, ok_chars: false }), { stageKey: "characters", stageApproved: false });
  assert.deepEqual(projectProgress({ n_deck: 1, n_chars: 1, n_act: 1, ok_act: true }), { stageKey: "structure", stageApproved: true });
  assert.deepEqual(projectProgress({ n_deck: 1, n_act: 1, n_beats: 1 }), { stageKey: "beats", stageApproved: false });
  assert.deepEqual(projectProgress({ n_beats: 1, n_list: 1 }), { stageKey: "screenplay", stageApproved: false });
  assert.deepEqual(projectProgress({ n_list: 1, screenplay_ready: true }), { stageKey: "done", stageApproved: true });
});
test("an imported screenplay (production project) is 'screenplay' or 'done'", () => {
  assert.equal(projectProgress({ project_type: "production", n_list: 1 }).stageKey, "screenplay");
  assert.equal(projectProgress({ project_type: "production", n_list: 1, screenplay_ready: true }).stageKey, "done");
});

import { projectFormat } from "../projectProgress.js";
test("format: film, short film (40 min or less), web series, vertical drama", () => {
  assert.deepEqual(projectFormat({ type: "film", runtimeMinutes: 120 }), { formatKind: "film", formatDetail: "120 min" });
  assert.deepEqual(projectFormat({ type: "film", runtimeMinutes: 20 }), { formatKind: "short", formatDetail: "20 min" });
  assert.deepEqual(projectFormat({ type: "series", episodeCount: 8, episodeMinutes: 30 }), { formatKind: "series", formatDetail: "8 episodes × 30 min each" });
  assert.deepEqual(projectFormat({ type: "vertical", episodeCount: 60, episodeMinutes: 1.5 }), { formatKind: "vertical", formatDetail: "60 episodes × 1.5 min each" });
  assert.deepEqual(projectFormat(null), { formatKind: "film", formatDetail: "" });
});
