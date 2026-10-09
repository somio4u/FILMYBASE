// Tests for designTasks.js on a real local Postgres, using the labelled
// "Idea of an Idea" fixture (hand-written stand-in for the silent agent).
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { ensureProductionSchema, seedTestProject, ingestAgentOutput, listProductionAssets, updateProductionAsset } from "../production.js";
import {
  ensureDesignTaskSchema, buildBrief, createDesignerTasks, listDesignerTasks, getDesignerTask,
  updateDesignerTask, cancelDesignerTask, refreshDesignerBrief, addTaskComment,
} from "../designTasks.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });

async function freshSeededProject() {
  // a brand-new copy of the test project each time, so tests don't interfere
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'");
  return (await seedTestProject(db)).projectId;
}
async function assetNamed(projectId, name) {
  return (await listProductionAssets(db, projectId)).find((a) => a.name === name);
}
async function assetRow(id) {
  return (await db.query("SELECT * FROM production_assets WHERE id = $1", [id])).rows[0];
}
async function issuesOf(id) {
  return (await db.query("SELECT id, category, message FROM production_issues WHERE asset_id = $1 AND status = 'open'", [id])).rows;
}

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await ensureProductionSchema(db);
  await ensureDesignTaskSchema(db);
  await ensureDesignTaskSchema(db); // idempotent
});
test.after(() => db.end());

test("brief: MUST KEEP / DESIGNER MAY EXPLORE / NEEDS DECISION are separate and correct", async () => {
  const pid = await freshSeededProject();
  const figure = await assetNamed(pid, "The Black Figure");
  const brief = buildBrief(await assetRow(figure.id), await issuesOf(figure.id));
  assert.ok(brief.mustKeep.some((m) => m.label === "Description (English)" && /matte pitch-black/.test(m.text)));
  assert.ok(brief.mustKeep.some((m) => m.label === "Costume: Matte black full-body suit"));
  assert.ok(brief.mustKeep.every((m) => m.source));
  const decisionTexts = brief.needsDecision.map((n) => n.text);
  assert.ok(decisionTexts.some((t) => /^DECISION: the silhouette is based on Spider-Man/.test(t)));
  assert.ok(decisionTexts.some((t) => /^CONFLICT: the character sheet says the mask is matte/.test(t)));
  assert.ok(brief.mayExplore.some((m) => m.text === "seated pose reference"));
  assert.ok(!brief.mayExplore.some((m) => /^(DECISION|CONFLICT)/.test(m.text)), "decisions never sit under 'may explore'");
  assert.deepEqual(brief.sceneUsage, ["Scene 2", "Scene 3", "Scene 4", "Scene 5", "Scene 9", "Scene 10"]);
});

test("brief: deliverables follow the asset type (character costumes, prop states, location variants, exact-text graphics)", async () => {
  const pid = await freshSeededProject();
  const get = async (name) => {
    const a = await assetNamed(pid, name);
    return buildBrief(await assetRow(a.id), await issuesOf(a.id));
  };
  const rahul = await get("Rahul Mohapatra");
  assert.ok(rahul.deliverables.includes("Costume view: King's royal costume (dream)"));
  assert.ok(rahul.deliverables.includes("Neutral front portrait"));
  assert.ok(rahul.deliverables.some((d) => /contact sheet.*separate/i.test(d)));
  const plant = await get("Wilting potted plant");
  assert.ok(plant.deliverables.includes("State: Wilting / dry") && plant.deliverables.includes("State: Replanted with fresh soil and watered"));
  assert.match(plant.format.background, /transparent/i);
  const bedroom = await get("Rahul's bedroom");
  assert.ok(bedroom.deliverables.includes("Establishing view") && bedroom.deliverables.some((d) => /Sunrise/.test(d)));
  const sign = await get("Odia-script shop signage");
  assert.ok(sign.deliverables.some((d) => /exact approved wording/.test(d)));
});

test("creating for all assets makes one task each; running it again creates nothing", async () => {
  const pid = await freshSeededProject();
  const first = await createDesignerTasks(db, pid, {});
  assert.equal(first.outcome, "ok");
  assert.equal(first.created.length, 40);
  assert.deepEqual(first.created.slice(0, 2).map((c) => c.code), ["TASK001", "TASK002"]);
  const again = await createDesignerTasks(db, pid, {});
  assert.equal(again.created.length, 0);
  assert.equal(again.skipped.length, 40);
  assert.ok(again.skipped.every((s) => s.reason === "already_has_task"));
  assert.equal((await listDesignerTasks(db, pid)).length, 40);
});

test("two simultaneous 'create all' requests still produce exactly one task per asset", async () => {
  const pid = await freshSeededProject();
  await Promise.all([createDesignerTasks(db, pid, {}), createDesignerTasks(db, pid, {}), createDesignerTasks(db, pid, {})]);
  const tasks = await listDesignerTasks(db, pid);
  assert.equal(tasks.length, 40);
  assert.equal(new Set(tasks.map((t) => t.code)).size, 40);
});

test("creating for chosen assets: assignee makes it claimed; foreign or invalid ids are refused", async () => {
  const pid = await freshSeededProject();
  const other = await freshSeededProject2();
  const rahul = await assetNamed(pid, "Rahul Mohapatra");
  const foreign = (await listProductionAssets(db, other))[0];
  const r = await createDesignerTasks(db, pid, { assetIds: [rahul.id, foreign.id], assignee: " Asha ", priority: "high", dueDate: "2026-12-31" });
  assert.equal(r.created.length, 1);
  assert.deepEqual(r.skipped, [{ assetId: foreign.id, reason: "not_in_project" }]);
  const task = await getDesignerTask(db, pid, r.created[0].taskId);
  assert.equal(task.state, "claimed");
  assert.equal(task.assignee, "Asha");
  assert.equal(task.priority, "high");
  assert.equal(task.dueDate, "2026-12-31");
  await assert.rejects(createDesignerTasks(db, pid, { assetIds: [] }), /assetIds/);
  await assert.rejects(createDesignerTasks(db, pid, { assetIds: ["x"] }), /assetIds/);
  await assert.rejects(createDesignerTasks(db, pid, { priority: "urgent" }), /Priority/);
  await assert.rejects(createDesignerTasks(db, pid, { dueDate: "31/12/2026" }), /Due date/);
  assert.equal((await createDesignerTasks(db, 99999999, {})).outcome, "not_found");
});
// A second, separate project (the helper above deletes the first one's title,
// so give the other one its own title).
async function freshSeededProject2() {
  const { IDEA_OF_AN_IDEA_ASSETS } = await import("../fixtures/idea-of-an-idea.assets.js");
  const id = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, assets) VALUES ('[TEST-OTHER] project','x',$1) RETURNING id", [JSON.stringify(IDEA_OF_AN_IDEA_ASSETS)])).rows[0].id;
  await ingestAgentOutput(db, id);
  return id;
}

test("editing a task: revision checks, claimed/open follows the assignee, bad input refused, cancelled is final", async () => {
  const pid = await freshSeededProject();
  const rahul = await assetNamed(pid, "Rahul Mohapatra");
  const { created } = await createDesignerTasks(db, pid, { assetIds: [rahul.id] });
  const id = created[0].taskId;
  let task = await getDesignerTask(db, pid, id);
  assert.equal(task.state, "open");

  const r1 = await updateDesignerTask(db, pid, id, { expectedRevision: task.revision, assignee: "Asha", priority: "high" });
  assert.equal(r1.outcome, "ok");
  assert.equal(r1.state, "claimed");
  const stale = await updateDesignerTask(db, pid, id, { expectedRevision: task.revision, priority: "low" });
  assert.equal(stale.outcome, "conflict");
  assert.equal(stale.currentRevision, r1.revision);

  const results = await Promise.all([
    updateDesignerTask(db, pid, id, { expectedRevision: r1.revision, priority: "low" }),
    updateDesignerTask(db, pid, id, { expectedRevision: r1.revision, priority: "normal" }),
  ]);
  assert.deepEqual(results.map((x) => x.outcome).sort(), ["conflict", "ok"]);

  task = await getDesignerTask(db, pid, id);
  const r2 = await updateDesignerTask(db, pid, id, { expectedRevision: task.revision, assignee: null });
  assert.equal(r2.state, "open");
  await assert.rejects(updateDesignerTask(db, pid, id, { expectedRevision: r2.revision, dueDate: "nope" }), /Due date/);
  await assert.rejects(updateDesignerTask(db, pid, id, { expectedRevision: r2.revision }), /Nothing to change/);
  await assert.rejects(updateDesignerTask(db, pid, id, { priority: "low" }), /expectedRevision/);

  const cancelled = await cancelDesignerTask(db, pid, id, { expectedRevision: r2.revision });
  assert.equal(cancelled.state, "cancelled");
  const after = await updateDesignerTask(db, pid, id, { expectedRevision: cancelled.revision, priority: "low" });
  assert.equal(after.outcome, "wrong_state");

  // a cancelled task does not block a fresh one for the same asset
  const again = await createDesignerTasks(db, pid, { assetIds: [rahul.id] });
  assert.equal(again.created.length, 1);
  assert.notEqual(again.created[0].taskId, id);
});

test("brief is a snapshot: edits make it stale, nothing shifts until Refresh, then it matches the asset", async () => {
  const pid = await freshSeededProject();
  const plant = await assetNamed(pid, "Wilting potted plant");
  const { created } = await createDesignerTasks(db, pid, { assetIds: [plant.id] });
  const id = created[0].taskId;
  let task = await getDesignerTask(db, pid, id);
  assert.equal(task.briefStale, false);
  const before = JSON.stringify(task.brief);

  await updateProductionAsset(db, pid, plant.id, { expectedRevision: plant.revision, edits: { sceneRefs: ["Scene 2", "Scene 12", "Scene 13"], notes: "Use the same pot as the boot scene" } });
  task = await getDesignerTask(db, pid, id);
  assert.equal(task.briefStale, true);
  assert.equal(JSON.stringify(task.brief), before, "designer's brief did not change by itself");
  assert.equal((await listDesignerTasks(db, pid))[0].briefStale, true);

  const refreshed = await refreshDesignerBrief(db, pid, id, { expectedRevision: task.revision });
  assert.equal(refreshed.outcome, "ok");
  task = await getDesignerTask(db, pid, id);
  assert.equal(task.briefStale, false);
  assert.ok(task.brief.mustKeep.some((m) => m.text === "Use the same pot as the boot scene"));
  assert.deepEqual(task.brief.sceneUsage, ["Scene 2", "Scene 12", "Scene 13"]);
});

test("a new agent import with different details also marks the brief out of date", async () => {
  const pid = await freshSeededProject();
  const boot = await assetNamed(pid, "High-ankle boot");
  await createDesignerTasks(db, pid, { assetIds: [boot.id] });
  const project = (await db.query("SELECT assets FROM ai_movie_projects WHERE id = $1", [pid])).rows[0];
  const changed = structuredClone(project.assets);
  changed.properties.find((p) => p.name === "High-ankle boot").visualDescription.en = "A different description from a later agent run";
  await db.query("UPDATE ai_movie_projects SET assets = $1 WHERE id = $2", [JSON.stringify(changed), pid]);
  await ingestAgentOutput(db, pid);
  assert.equal((await listDesignerTasks(db, pid))[0].briefStale, true);
});

test("comments and clarification requests are saved in order; empty/oversized/other-project refused", async () => {
  const pid = await freshSeededProject();
  const rahul = await assetNamed(pid, "Rahul Mohapatra");
  const { created } = await createDesignerTasks(db, pid, { assetIds: [rahul.id] });
  const id = created[0].taskId;
  assert.equal((await addTaskComment(db, pid, id, { body: "  Which hairstyle in Scene 11?  ", kind: "clarification", authorName: "Asha" })).outcome, "ok");
  await addTaskComment(db, pid, id, { body: "Use the Scene 1 look.", authorName: "Director" });
  const task = await getDesignerTask(db, pid, id);
  assert.deepEqual(task.comments.map((c) => [c.kind, c.body, c.author_name]), [
    ["clarification", "Which hairstyle in Scene 11?", "Asha"],
    ["comment", "Use the Scene 1 look.", "Director"],
  ]);
  assert.equal(task.commentCount, 2);
  await assert.rejects(addTaskComment(db, pid, id, { body: "   " }), /1 to 4000/);
  await assert.rejects(addTaskComment(db, pid, id, { body: "x".repeat(4001) }), /1 to 4000/);
  await assert.rejects(addTaskComment(db, pid, id, { body: "hi", kind: "shout" }), /Not a valid/);
  const other = await freshSeededProject2();
  assert.equal((await addTaskComment(db, other, id, { body: "hi" })).outcome, "not_found");
  assert.equal(await getDesignerTask(db, other, id), null);
});
