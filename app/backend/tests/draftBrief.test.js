import test from "node:test";
import assert from "node:assert/strict";
import { buildBrief, BRIEF_LIMIT } from "../draftAgent.js";

const unit = (section, i, text, label) => ({ key: `${section}${i}`, section, label: label ?? `${section} ${i}`, text });
function film(nScenes) {
  const units = [unit("synopsis", 0, "S".repeat(5000), "Synopsis"), unit("story", 0, "T".repeat(4000), "Story")];
  for (let i = 0; i < 12; i++) units.push(unit("characters", i, "C".repeat(900), `Character ${i}`));
  for (let i = 0; i < 20; i++) units.push(unit("beats", i, "B".repeat(900), `Beat ${i + 1}`));
  for (let i = 1; i <= nScenes; i++) units.push(unit("screenplay", i, `INT. PLACE ${i} - DAY\n${"Something happens in this scene. ".repeat(20)}END${i}`, `Scene ${i}`));
  return units;
}
const req = { instruction: "Cut the narration. ".repeat(100), constraints: {} };

test("a long film's last scenes are still in the brief", () => {
  for (const n of [40, 126, 206]) {
    const brief = buildBrief(req, film(n), null);
    assert.ok(brief.length <= BRIEF_LIMIT + 400, `${n} scenes: ${brief.length} characters`);
    assert.ok(brief.includes(`Scene ${n}:`), `${n} scenes: the last scene heading is missing`);
    for (let i = 1; i <= n; i++) assert.ok(brief.includes(`- Scene ${i}:`), `scene ${i} of ${n} is missing`);
  }
});

test("a short film keeps the full gist of each scene", () => {
  const brief = buildBrief(req, film(10), null);
  assert.ok(brief.includes("Something happens in this scene."));
  assert.ok(brief.includes("Beat 20:") && brief.includes("Character 11:"));
});
