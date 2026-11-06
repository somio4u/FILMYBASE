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

test("the story shortcut: the AI's merged directions are cleaned, nothing a direction forgot is lost, and without the AI the most serious fit first with the rest counted", async () => {
  const { normalizeDirections, fallbackDirections, directionsInstruction, uncovered, condensePrompt, MAX_DIRECTIONS } = await import("../scriptDoctorApply.js");
  const manual = [
    { id: 1, kind: "structure", title: "Plant Kalapahada early", action: "Show his silhouette in act one.", severity: "critical" },
    { id: 2, kind: "structure", title: "Move his reveal before the interval", action: "Helmet off before the INTERVAL card.", severity: "critical" },
    { id: 3, kind: "structure", title: "Add a real ending", action: "A 2-3 page resolution.", severity: "major" },
    { id: 4, kind: "structure", title: "Shreya pays off", action: "Find Shreya among the turned pilgrims.", severity: "minor" },
  ];
  const directions = normalizeDirections([
    { title: "Bring Kalapahada into the first half", action: "Silhouette in act one; helmet off before the INTERVAL card.", fromIds: [1, 2, 99] },
    { title: "", action: "no title" },
    { title: "Write the real ending", action: "A short resolution.", fromIds: [3] },
    null,
  ], manual);
  assert.equal(directions.length, 2);
  assert.deepEqual(directions[0].fromIds, [1, 2]); // an id that is not a real request is dropped
  assert.deepEqual(uncovered(directions, manual).map((i) => i.id), [4]); // change 4 was forgotten by the merge: it is found, so it can be added
  assert.match(directionsInstruction(directions), /1\. Bring Kalapahada into the first half: Silhouette in act one/);
  assert.match(directionsInstruction(directions), /2\. Write the real ending/);
  assert.equal(normalizeDirections(Array.from({ length: 60 }, (_, i) => ({ title: `t${i}`, action: "a", fromIds: [] })), manual).length, MAX_DIRECTIONS);
  assert.match(condensePrompt(manual), /#1 \(critical, structure\) Plant Kalapahada early/);
  // no AI: the most serious first, as many as fit, the rest counted
  const many = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, kind: "structure", title: `Change ${i}`, action: "x".repeat(300), severity: i === 99 ? "critical" : "minor" }));
  const fb = fallbackDirections(many, 3000);
  assert.equal(fb.directions[0].title, "Change 99"); // the critical one comes first although it was last
  assert.ok(fb.directions.length < 100 && fb.left === 100 - fb.directions.length);
  assert.deepEqual(fallbackDirections([], 100), { directions: [], left: 0 });
});

// the report's own scene table (page(s) -> scene(s)), as the AI lists it: the pairs the page map is built from
const TABLE = [[[2, 7], [1, 14]], [[7, 9], [15, 17]], [[13, 15], [22, 24]], [[26, 30], [37, 44]], [[33, 39], [48, 55]], [[41, 43], [57, 60]], [[54, 56], [71, 72]], [[64, 65], [81, 82]], [[79, 83], [97, 101]], [[89, 92], [109, 114]], [[121, 125], [154, 158]], [[138, 144], [170, 181]], [[146, 153], [184, 193]], [[154, 154], [194, 194]], [[159, 159], [203, 203]]]
  .map(([p, s], i) => ({ id: 100 + i, kind: "scene", title: `row ${i}`, action: "x", pages: p[0] === p[1] ? [p[0]] : [p[0], p[1]], scenes: s[0] === s[1] ? [s[0]] : Array.from({ length: s[1] - s[0] + 1 }, (_, n) => s[0] + n), severity: "minor" }));

test("what each change needs: a fix inside scenes is in place, a line or a sensitive moment is careful, new scenes / a new ending / moving or cutting scenes need a new draft", async () => {
  const { impactOf } = await import("../scriptDoctorApply.js");
  const it = (kind, title, action, scenes = []) => ({ kind, title, action, scenes, pages: [], severity: "major" });
  assert.equal(impactOf(it("global", "Cut the narration", "Cut about 70% of the narrator's cues.")), "in_place");
  assert.equal(impactOf(it("scene", "Silence the deathbed", "Cut the medical lines.", [97])), "in_place");
  assert.equal(impactOf(it("scene", "Rewrite the last line", "Callback line.", [203])), "in_place");
  assert.equal(impactOf(it("risk", "Soften the Brahma extraction", "Show light through the cloth, never the opened idol.", [170])), "careful");
  assert.equal(impactOf(it("structure", "Give Kalapahada a voice early", "Add one line spoken by Kalapahada in the prologue: his philosophy.")), "careful");
  assert.equal(impactOf(it("structure", "Introduce Kalapahada in Act One", "Show his silhouette, armor or voice in the first act.")), "new_draft");
  assert.equal(impactOf(it("structure", "Write the real ending", "Add a 2-3 page resolution: the pilgrims are restored.")), "new_draft");
  assert.equal(impactOf(it("structure", "Cut repeated training beats", "Cut the training between pages 33 and 61.")), "new_draft");
  assert.equal(impactOf(it("structure", "Swap the order", "Move the Maha Guru's demonstration before the flagship raid.")), "new_draft");
  assert.equal(impactOf(it("structure", "Add a Bahuda song", "Add a celebration song at the end.")), "new_draft");
  assert.equal(impactOf(it("risk", "Consult a scholar", "Add three new scenes about the ritual.")), "new_draft");
});

test("pages become scenes through the report's own scene table: p5–6 lands in the prologue, p79–83 in the deathbed scenes, p159 is the last scene; too few pairs give no map", async () => {
  const { buildPageMap, annotateItems } = await import("../scriptDoctorApply.js");
  const map = buildPageMap(TABLE);
  assert.ok(Math.floor(map(5)) >= 6 && Math.floor(map(5)) <= 12); // inside scenes 1-14 (p2-7)
  assert.equal(Math.floor(map(79)), 97);
  assert.equal(Math.floor(map(159)), 203);
  assert.ok(map(100) > map(99) && map(60) > map(50)); // it only goes forward
  assert.equal(buildPageMap([]), null);
  assert.equal(buildPageMap([TABLE[0]]), null); // one pair is not enough
  const [narration, training, villain] = annotateItems([
    ...TABLE,
    { id: 1, kind: "structure", title: "Trim narration before the hook", action: "Cut or trim the narration that precedes the hook.", scenes: [], pages: [5, 6], severity: "major" },
    { id: 2, kind: "structure", title: "Cut repeated training beats", action: "Cut the repeated training beats between pages 33 and 61.", scenes: [], pages: [33, 61], severity: "major" },
    { id: 3, kind: "structure", title: "Introduce Kalapahada in Act One", action: "Show his silhouette in the first act.", scenes: [], pages: [5], severity: "critical" },
  ]).slice(-3);
  assert.equal(narration.impact, "in_place"); // "trim the narration" is a fix inside scenes, although the AI called it a story change: it is placed
  assert.equal(narration.estimated, true);
  assert.ok(narration.scenesUsed.length >= 2 && narration.scenesUsed[0] >= 1 && narration.scenesUsed.at(-1) <= 14);
  assert.equal(training.impact, "new_draft"); // cutting scenes needs a new draft: it is not placed
  assert.deepEqual(training.scenesUsed, []);
  assert.equal(villain.impact, "new_draft");
  assert.deepEqual(villain.scenesUsed, []);
});

test("the plan now uses the pages: a change with only page numbers is made in the scenes those pages reach; the story changes stay with the person; the summary counts them", async () => {
  const { impactSummary, annotateItems } = await import("../scriptDoctorApply.js");
  const many = Array.from({ length: 210 }, (_, i) => ({ section: "screenplay", key: `b${Math.floor(i / 10)}s${i % 10}`, label: `Scene ${i + 1}` }));
  const extra = [
    { id: 1, kind: "scene", title: "Trim narration before the hook", action: "Cut the narration before the hook.", scenes: [], pages: [5, 6], severity: "major" },
    { id: 2, kind: "structure", title: "Introduce Kalapahada in Act One", action: "Show his silhouette in the first act.", scenes: [], pages: [5], severity: "critical" },
    { id: 3, kind: "global", title: "Cut the narration", action: "Cut 70%.", scenes: [], pages: [], severity: "major" },
  ];
  const all = [...TABLE, ...extra];
  const plan = planApply(all, many, [1, 2, 3]);
  const sceneNumbers = plan.tasks.filter((t) => t.itemIds.includes(1)).map((t) => t.sceneNumber);
  assert.ok(sceneNumbers.length >= 2 && sceneNumbers.length <= 14);
  assert.deepEqual(plan.manual.map((m) => m.id), [2]); // the story change is not made by itself
  assert.match(plan.manual[0].why, /new draft/);
  assert.equal(plan.perItem[1], sceneNumbers.length);
  assert.equal(plan.tasks.length, 210); // the whole-script change reaches every scene
  const summary = impactSummary(annotateItems(all));
  assert.equal(summary.newDraft, 1);
  assert.equal(summary.everyScene, true);
  assert.ok(summary.inPlace >= 16 && summary.namedScenes >= 80);
});

test("the new-story way is given everything not tied to old scenes (story changes, whole-script rules, changes with no place); scene-tied changes and protected lines are left out", async () => {
  const { itemsForNewStory, annotateItems, impactSummary } = await import("../scriptDoctorApply.js");
  const items = annotateItems([
    { id: 1, kind: "structure", title: "Introduce Kalapahada in Act One", action: "Show his silhouette in the first act.", scenes: [], pages: [5], severity: "critical" },
    { id: 2, kind: "global", title: "Cut the narration", action: "Cut about 70% of the cues.", scenes: [], pages: [], severity: "major" },
    { id: 3, kind: "scene", title: "Silence the deathbed", action: "Cut the medical lines.", scenes: [97, 98], pages: [79], severity: "major" },
    { id: 4, kind: "structure", title: "A voice for Rudra", action: "Give Rudra a soldier's clipped voice everywhere.", scenes: [], pages: [], severity: "minor" },
    { id: 5, kind: "keep", title: "Keep payment", action: "Samir: payment?", scenes: [], pages: [], severity: "note" },
  ]);
  assert.deepEqual(itemsForNewStory(items).map((i) => i.id), [1, 2, 4]); // the whole-script rule and the unplaced change come along; the scene-tied one and the protected line do not
  assert.equal(impactSummary(items).forNewStory, 3);
});
