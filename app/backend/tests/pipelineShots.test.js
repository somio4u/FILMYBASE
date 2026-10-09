// Pipeline steps 2-3: shot division and the text storyboard, on the real
// "Idea of an Idea" screenplay and a local Postgres. The AI is a stub that
// returns what a model might (including bad answers).
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { seedTestProject } from "../production.js";
import { analyzeScreenplay, listScenes } from "../screenplayAnalysis.js";
import { ensureAllProductionSchemas } from "../productionSchema.js";
import { readShotNote, divideScene, listShots, updateShot, addShot, deleteShot, splitShot, mergeShotWithNext, generateStoryboard, approveStoryboard, approveShots, validateAiShots, shotsFromScriptNotes } from "../shots.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  assert.deepEqual(await ensureAllProductionSchemas(db), []);
  assert.deepEqual(await ensureAllProductionSchemas(db), []); // idempotent
});
test.after(() => db.end());

async function project() {
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'");
  const { projectId } = await seedTestProject(db);
  await analyzeScreenplay(db, projectId);
  return projectId;
}
const sceneId = async (pid, n) => (await listScenes(db, pid)).find((s) => s.number === String(n)).id;

test("shot notes are read into framing and camera moves", () => {
  assert.deepEqual(readShotNote("Close-up: Rahul's hands buttoning the last shirt button."), { framing: "Close-up", cameraMove: null, cameraAngle: null });
  assert.equal(readShotNote("Over-the-shoulder shot: Rahul's hand turning the key").framing, "Over-the-shoulder");
  assert.equal(readShotNote("Slow push-in shot on Rahul's face").cameraMove, "Push-in");
  assert.equal(readShotNote("POV shot (Rahul's eyes): the black figure").framing, "POV");
  assert.equal(readShotNote("Wide establishing shot: the car at a red light").framing, "Wide");
  assert.equal(readShotNote("Rack focus shot: focus shifts").cameraMove, "Rack focus");
  assert.equal(readShotNote("Low-angle shot of a door").cameraAngle, "Low angle");
  assert.deepEqual(readShotNote(""), { framing: null, cameraMove: null, cameraAngle: null });
});

test("script shot notes become the shots: all 65, every dialogue line in exactly one shot, linked to the dossier", async () => {
  const pid = await project();
  for (const s of await listScenes(db, pid)) {
    const r = await divideScene(db, pid, s.id, { mode: "auto" });
    assert.equal(r.outcome, "divided");
    assert.equal(r.mode, "script");
  }
  const shots = await listShots(db, pid);
  assert.equal(shots.length, 65);
  assert.equal(shots[0].code, "SH001");
  assert.equal(shots[64].code, "SH065");
  assert.equal(shots[0].number, "1.1");
  assert.equal(shots[0].framing, "Close-up");
  assert.deepEqual(shots.filter((s) => s.sceneNumber === "2").map((s) => s.number), ["2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "2.8"]);
  // all 17 dialogue lines covered once
  const links = (await db.query("SELECT element_id, count(*)::int n FROM production_shot_dialogue sd JOIN production_shots s ON s.id = sd.shot_id WHERE s.project_id = $1 GROUP BY element_id", [pid])).rows;
  assert.equal(links.length, 17);
  assert.ok(links.every((l) => l.n === 1));
  // shot 2.1 is in the apartment entrance and shows Rahul; shot 2.4 (the dry plant) shows no character
  const s21 = shots.find((s) => s.number === "2.1");
  assert.ok(s21.assets.some((a) => a.kind === "character" && /Rahul/.test(a.name)), JSON.stringify(s21.assets));
  assert.ok(s21.assets.some((a) => a.kind === "location"));
  const s24 = shots.find((s) => s.number === "2.4");
  assert.ok(!s24.assets.some((a) => a.kind === "character"), JSON.stringify(s24.assets));
  assert.ok(s24.assets.some((a) => /plant/i.test(a.name)), JSON.stringify(s24.assets));
  // dialogue speakers drive who is in the shot
  const doctor = shots.filter((s) => s.sceneNumber === "7" && s.dialogue.length > 0);
  assert.ok(doctor.length > 0);
  assert.ok(doctor.every((s) => s.assets.some((a) => a.kind === "character")));
  // asking again does not duplicate
  const again = await divideScene(db, pid, await sceneId(pid, 2), { mode: "auto" });
  assert.equal(again.outcome, "exists");
  assert.equal((await listShots(db, pid)).length, 65);
});

test("dialogue before the first shot note joins the first shot; dialogue after the last stays in the last", () => {
  const els = [
    { id: 1, kind: "dialogue", speaker: "A", text: "hi" },
    { id: 2, kind: "shot_hint", text: "Wide: a room", label: "1.1" },
    { id: 3, kind: "dialogue", speaker: "B", text: "yo" },
    { id: 4, kind: "shot_hint", text: "Close-up: B", label: "1.2" },
    { id: 5, kind: "dialogue", speaker: "A", text: "bye" },
  ];
  const shots = shotsFromScriptNotes(els);
  assert.deepEqual(shots.map((s) => s.dialogueIds), [[1, 3], [5]]);
});

test("rules mode (no AI, no notes) still cuts a scene: an establishing shot, then action and spoken lines", async () => {
  const pid = await project();
  const sid = await sceneId(pid, 5); // scene 5 has dialogue
  const r = await divideScene(db, pid, sid, { mode: "rules" });
  assert.equal(r.mode, "rules");
  const shots = await listShots(db, pid, { sceneId: sid });
  assert.equal(shots[0].framing, "Wide");
  assert.equal(shots.reduce((n, s) => n + s.dialogue.length, 0), 4);
  // auto with no AI and no notes falls back to rules; auto with notes uses them
  await db.query("DELETE FROM production_scene_elements WHERE scene_id = $1 AND kind = 'shot_hint'", [sid]);
  await divideScene(db, pid, sid, { mode: "auto", replace: true });
  assert.equal((await listShots(db, pid, { sceneId: sid }))[0].source, "rules");
});

test("AI cut: valid shots are kept, junk is dropped, stray dialogue lines are attached, a failing AI falls back or reports", async () => {
  const pid = await project();
  const sid = await sceneId(pid, 5);
  await db.query("DELETE FROM production_scene_elements WHERE scene_id = $1 AND kind = 'shot_hint'", [sid]);
  const scene = (await listScenes(db, pid)).find((s) => s.id === sid);
  const codes = (await db.query("SELECT code FROM production_scene_elements WHERE scene_id = $1 AND kind = 'dialogue' ORDER BY order_index", [sid])).rows.map((r) => r.code);
  let prompt = "";
  const ai = async (p) => {
    prompt = p;
    return { shots: [
      { framing: "Wide", description: "Rahul runs into the pantry, out of breath.", durationSec: 5, characters: ["Rahul"], dialogueCodes: [codes[0], "D999"] },
      { description: "", framing: "Close-up" }, // dropped: no description
      "garbage",
      { framing: "Close-up", cameraMove: "Static", description: "Debashish laughs, holding a paper coffee cup.", durationSec: 400, characters: ["Debashish"], props: ["Paper coffee cup"], dialogueCodes: [codes[1], codes[1]] },
    ] };
  };
  const r = await divideScene(db, pid, sid, { mode: "ai", textJson: ai });
  assert.equal(r.mode, "ai");
  assert.match(prompt, new RegExp(`\\[${codes[0]}\\]`));
  assert.match(prompt, /Return JSON only/);
  const shots = await listShots(db, pid, { sceneId: sid });
  assert.equal(shots.length, 2);
  // lines 3 and 4 were never placed by the AI: they join the nearest earlier shot, none lost
  assert.equal(shots.reduce((n, s) => n + s.dialogue.length, 0), codes.length);
  assert.equal(shots[1].durationSec, 4); // 400 is not a sensible length -> default
  assert.ok(shots[1].assets.some((a) => a.name === "Paper coffee cup"));
  assert.ok(shots[1].assets.some((a) => a.name === "Debashish"));
  assert.equal(shots[0].source, "ai");

  // AI throws: mode "ai" reports plainly, mode "auto" falls back to the simple cut
  await assert.rejects(divideScene(db, pid, sid, { mode: "ai", replace: true, textJson: async () => { throw new Error("quota"); } }), /could not cut this scene/);
  const fb = await divideScene(db, pid, sid, { mode: "auto", replace: true, textJson: async () => ({ shots: [] }) });
  assert.equal(fb.mode, "rules");
  await assert.rejects(divideScene(db, pid, sid, { mode: "ai", replace: true, textJson: null }), /not available/);
  assert.deepEqual(validateAiShots(null, []), []);
});

test("editing shots: change fields, stale edits refused, add / split / merge / delete keep the order and dialogue", async () => {
  const pid = await project();
  const sid = await sceneId(pid, 5);
  await divideScene(db, pid, sid, { mode: "script" });
  let shots = await listShots(db, pid, { sceneId: sid });
  const first = shots[0];
  const edited = await updateShot(db, pid, first.id, { expectedRevision: first.revision, edits: { framing: "Wide", description: "A new description", durationSec: 6, cameraMove: "Pan" } });
  assert.equal(edited.description, "A new description");
  assert.equal(edited.durationSec, 6);
  assert.equal(edited.edited, true);
  await assert.rejects(updateShot(db, pid, first.id, { expectedRevision: first.revision, edits: { framing: "Close-up" } }), /changed this shot/);
  await assert.rejects(updateShot(db, pid, first.id, { edits: { durationSec: 99 } }), /between 1 and 30/);
  await assert.rejects(updateShot(db, pid, first.id, { edits: { description: "  " } }), /needs a description/);
  await assert.rejects(updateShot(db, pid, 999999, { edits: {} }), /not found/);

  const added = await addShot(db, pid, sid, { afterShotId: first.id, description: "Insert of the wall clock", framing: "Insert" });
  shots = await listShots(db, pid, { sceneId: sid });
  assert.equal(shots[1].id, added.id);
  assert.deepEqual(shots.map((s) => s.number), ["5.1", "5.2", "5.3", "5.4"]);

  const dialogueBefore = shots.reduce((n, s) => n + s.dialogue.length, 0);
  const withLines = shots.find((s) => s.dialogue.length >= 2) ?? shots.find((s) => s.dialogue.length >= 1);
  const parts = await splitShot(db, pid, withLines.id);
  assert.equal(parts.length, 2);
  shots = await listShots(db, pid, { sceneId: sid });
  assert.equal(shots.length, 5);
  assert.equal(shots.reduce((n, s) => n + s.dialogue.length, 0), dialogueBefore);
  const merged = await mergeShotWithNext(db, pid, withLines.id);
  assert.match(merged.description, /\(continued\)/);
  shots = await listShots(db, pid, { sceneId: sid });
  assert.equal(shots.length, 4);
  assert.equal(shots.reduce((n, s) => n + s.dialogue.length, 0), dialogueBefore);
  await assert.rejects(mergeShotWithNext(db, pid, shots[shots.length - 1].id), /no shot after/);

  await deleteShot(db, pid, added.id);
  shots = await listShots(db, pid, { sceneId: sid });
  assert.deepEqual(shots.map((s) => s.number), ["5.1", "5.2", "5.3"]);
  // changing who is in a shot and which lines it covers
  const asset = shots[0].assets[0];
  const reassigned = await updateShot(db, pid, shots[0].id, { edits: { assetIds: [], dialogueIds: [] } });
  assert.equal(reassigned.assets.length, 0);
  assert.equal(reassigned.dialogue.length, 0);
  assert.ok(asset);
});

test("a shot that already has generated material cannot be deleted, split, merged or re-cut", async () => {
  const pid = await project();
  const sid = await sceneId(pid, 5);
  await divideScene(db, pid, sid, { mode: "script" });
  const [a, b] = await listShots(db, pid, { sceneId: sid });
  await db.query("INSERT INTO production_generations (project_id, kind, shot_id, version, prompt, status) VALUES ($1,'keyframe',$2,1,'x','ready')", [pid, a.id]);
  await assert.rejects(deleteShot(db, pid, a.id), /already made/);
  await assert.rejects(splitShot(db, pid, a.id), /already made/);
  await assert.rejects(mergeShotWithNext(db, pid, a.id), /already made/);
  await assert.rejects(divideScene(db, pid, sid, { mode: "script", replace: true }), /already made/);
  assert.equal((await listShots(db, pid, { sceneId: sid })).length >= 2, true);
  assert.ok(b);
});

test("text storyboard: written for every shot (template when no AI), AI text used when valid, editing resets approval, approval needs text", async () => {
  const pid = await project();
  const sid = await sceneId(pid, 2);
  await assert.rejects(generateStoryboard(db, pid, sid, {}), /Cut this scene into shots first/);
  await divideScene(db, pid, sid, { mode: "script" });
  await assert.rejects(approveStoryboard(db, pid, sid), /needs its storyboard text/);
  const r = await generateStoryboard(db, pid, sid, {});
  assert.deepEqual([r.outcome, r.written, r.mode], ["written", 8, "template"]);
  let shots = await listShots(db, pid, { sceneId: sid });
  assert.ok(shots.every((s) => s.storyboardText.length > 20));
  assert.match(shots[0].storyboardText, /Over-the-shoulder/);
  assert.match(shots[0].storyboardText, /Rahul/);
  assert.equal((await generateStoryboard(db, pid, sid, {})).outcome, "nothing_to_do");

  // AI text replaces on overwrite; a shot the AI skipped keeps a template text
  const ai = async () => ({ frames: [{ code: shots[0].code, text: "A tight over-the-shoulder view of a key turning in a worn lock." }, { code: "SH999", text: "ignored" }] });
  const r2 = await generateStoryboard(db, pid, sid, { textJson: ai, overwrite: true });
  assert.equal(r2.mode, "ai");
  shots = await listShots(db, pid, { sceneId: sid });
  assert.match(shots[0].storyboardText, /worn lock/);
  assert.ok(shots[1].storyboardText.length > 20);

  const ok = await approveStoryboard(db, pid, sid);
  assert.equal(ok.approved, true);
  assert.ok((await listShots(db, pid, { sceneId: sid })).every((s) => s.storyboardStatus === "approved"));
  await updateShot(db, pid, shots[3].id, { edits: { storyboardText: "Changed by hand." } });
  const after = await listShots(db, pid, { sceneId: sid });
  assert.equal(after[3].storyboardStatus, "draft");
  assert.equal(after[0].storyboardStatus, "approved");
  await approveStoryboard(db, pid, sid, { approved: false });
  assert.ok((await listShots(db, pid, { sceneId: sid })).every((s) => s.storyboardStatus === "draft"));
});

test("shot approval: needs shots; any change to the cut re-opens it; storyboard text edits do not", async () => {
  const pid = await project();
  const sid = await sceneId(pid, 5);
  await assert.rejects(approveShots(db, pid, sid), /no shots to approve/);
  await assert.rejects(approveShots(db, pid, 999999), /not found/);
  await divideScene(db, pid, sid, { mode: "script" });
  assert.ok((await listShots(db, pid, { sceneId: sid })).every((s) => s.shotStatus === "draft"));
  assert.equal((await approveShots(db, pid, sid)).approved, true);
  const approved = () => listShots(db, pid, { sceneId: sid });
  assert.ok((await approved()).every((s) => s.shotStatus === "approved"));
  let shots = await approved();
  await updateShot(db, pid, shots[0].id, { edits: { storyboardText: "Just words." } });
  assert.ok((await approved()).every((s) => s.shotStatus === "approved"));
  await updateShot(db, pid, shots[0].id, { edits: { framing: "Wide" } });
  assert.ok((await approved()).every((s) => s.shotStatus === "draft"));
  for (const change of [
    () => addShot(db, pid, sid, { description: "x" }),
    async () => splitShot(db, pid, (await approved())[0].id),
    async () => mergeShotWithNext(db, pid, (await approved())[0].id),
    async () => deleteShot(db, pid, (await approved())[0].id),
  ]) {
    await approveShots(db, pid, sid);
    assert.ok((await approved()).every((s) => s.shotStatus === "approved"));
    await change();
    assert.ok((await approved()).every((s) => s.shotStatus === "draft"));
  }
  shots = await approved();
  assert.ok(shots.length > 0);
});
