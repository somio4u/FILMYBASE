// A script doctor's report -> the plan of changes made scene by scene (scriptDoctorApply.js). Pure functions; no database and no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { sceneKeysInOrder, planApply, itemProgress } from "../scriptDoctorApply.js";

const units = [
  { section: "idea", key: "idea", label: "The idea" },
  { section: "screenplay", key: "b0s0", label: "Beat 1, scene 1: INT. HUT - DAY" },
  { section: "screenplay", key: "b0s1", label: "Beat 1, scene 2" },
  { section: "beats", key: "beat1", label: "Beat 2" },
  { section: "screenplay", key: "b1s0", label: "Beat 2, scene 1" },
  { section: "screenplay", key: "b1s1", label: "Beat 2, scene 2" },
];
const items = [
  { id: 1, kind: "structure", title: "Plant Kalapahada early", action: "Show his silhouette in act one.", scenes: [], pages: [5], severity: "critical" },
  { id: 2, kind: "scene", title: "Rewrite the last line", action: "Callback line.", scenes: [4], pages: [], severity: "minor" },
  { id: 3, kind: "scene", title: "Silence the deathbed", action: "Cut the medical lines.", scenes: [2, 3, 99], pages: [], severity: "major" },
  { id: 4, kind: "global", title: "Cut the narration", action: "Cut about 70% of the narrator's cues.", scenes: [], pages: [], severity: "major" },
  { id: 5, kind: "risk", title: "Soften the extraction", action: "Show light, never the idol.", scenes: [3], pages: [], severity: "critical" },
  { id: 6, kind: "keep", title: "Keep payment", action: "Samir: “payment?” (p16)", scenes: [], pages: [], severity: "note" },
  { id: 7, kind: "risk", title: "Check with a temple scholar", action: "Consult before shooting.", scenes: [], pages: [], severity: "major" },
];

test("scene numbers follow the screenplay across beats, like the numbers on screen", () => {
  assert.deepEqual(sceneKeysInOrder(units).map((s) => [s.number, s.key]), [[1, "b0s0"], [2, "b0s1"], [3, "b1s0"], [4, "b1s1"]]);
});

test("the plan: scene fixes go to the scenes they name, a whole-script change to every scene, a story change with no scene numbers needs a person", () => {
  const plan = planApply(items, units);
  assert.deepEqual(plan.tasks.map((t) => [t.sceneNumber, t.key, t.itemIds]), [[1, "b0s0", [4]], [2, "b0s1", [3, 4]], [3, "b1s0", [3, 4, 5]], [4, "b1s1", [2, 4]]]);
  assert.deepEqual(plan.manual.map((m) => m.id), [1, 7]); // the story change and the "consult a scholar" note: a person decides
  assert.match(plan.manual[0].why, /needs your decision/);
  assert.deepEqual(plan.perItem, { 2: 1, 3: 2, 4: 4, 5: 1 }); // the scene number 99 is not in this draft: it is counted for nobody
  assert.deepEqual(plan.mustKeep, ["Samir: “payment?” (p16)"]); // the protected line is never a change; it travels with every rewrite
  const t = plan.tasks[2].instruction;
  assert.match(t, /1\. Silence the deathbed: Cut the medical lines\./);
  assert.match(t, /3\. Soften the extraction: Show light, never the idol\./);
  assert.match(t, /Rewrite this ONE scene/);
});

test("only the ticked changes are planned (none ticked = all); a change that names scenes none of which exist needs a person", () => {
  const some = planApply(items, units, [2, 6]); // 6 is a protected line: ticking it makes no change
  assert.deepEqual(some.tasks.map((t) => [t.sceneNumber, t.itemIds]), [[4, [2]]]);
  assert.deepEqual(some.manual, []);
  const lost = planApply([{ id: 9, kind: "scene", title: "x", action: "y", scenes: [150], pages: [], severity: "minor" }], units);
  assert.equal(lost.tasks.length, 0);
  assert.match(lost.manual[0].why, /not in this draft/);
  assert.equal(planApply([], units).tasks.length, 0);
  assert.equal(planApply(items, []).tasks.length, 0); // an empty draft: nothing to do
});

test("where each change stands: waiting, working (some scenes done), done, or needing a person", () => {
  const plan = planApply(items, units);
  const progress = (results) => Object.fromEntries(itemProgress(items, plan, results).map((p) => [p.id, [p.state, p.done, p.total]]));
  assert.deepEqual(progress({}), { 2: ["waiting", 0, 1], 3: ["waiting", 0, 2], 4: ["waiting", 0, 4], 5: ["waiting", 0, 1], 1: ["manual", 0, 0], 7: ["manual", 0, 0] });
  const half = progress({ b0s0: { status: "changed" }, b0s1: { status: "unchanged" } });
  assert.deepEqual(half[4], ["working", 2, 4]); // an "unchanged" scene was looked at: it counts as done
  assert.deepEqual(half[3], ["working", 1, 2]);
  const all = progress({ b0s0: { status: "changed" }, b0s1: { status: "changed" }, b1s0: { status: "changed" }, b1s1: { status: "changed" } });
  assert.deepEqual([all[2][0], all[3][0], all[4][0], all[5][0]], ["done", "done", "done", "done"]);
});
