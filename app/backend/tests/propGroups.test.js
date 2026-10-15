// Small props that share ONE picture (propGroups.js). The AI service is a LOCAL IMITATION (tests/mockGemini.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { seedTestProject } from "../production.js";
import { analyzeScreenplay, listScenes } from "../screenplayAnalysis.js";
import { ensureAllProductionSchemas } from "../productionSchema.js";
import { createMediaStore, createLocalBackend } from "../mediaStore.js";
import { createProviders, pcmToWav, wavDurationMs } from "../providers.js";
import { createGenerationService, plannedRefNames, assetPrompt } from "../generations.js";
import { combineProps, splitProps, previewPropGroups, planPropGroups, memberLabel, repairPropGroupDescriptions, plainText } from "../propGroups.js";
import { computeSpecs } from "../planning.js";
import { saveSettings, getSettings, spendSummary, assertWithinBudget } from "../pipelineSettings.js";
import { divideScene, listShots, generateStoryboard, approveStoryboard, approveShots } from "../shots.js";
import { startMockGemini } from "./mockGemini.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gen-test-"));
let mock, providers, store, gens;

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  assert.deepEqual(await ensureAllProductionSchemas(db), []);
  mock = await startMockGemini();
  providers = createProviders({ env: { GEMINI_API_KEY: "test-key", GEMINI_API_BASE: mock.base }, sleep: async () => {} });
  store = createMediaStore({ db, backend: createLocalBackend({ root: path.join(tmp, "media") }), spoolDir: path.join(tmp, "spool") });
  gens = createGenerationService({ db, store, providers, env: {}, videoPollMs: 1 });
});
test.after(async () => {
  await mock.close();
  await db.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// a fresh project with scene 2 cut into shots and its text storyboard approved
async function ready({ approveStoryboardToo = true } = {}) {
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[TEST] Idea of an Idea%'");
  const { projectId } = await seedTestProject(db);
  await analyzeScreenplay(db, projectId);
  const scene = (await listScenes(db, projectId)).find((s) => s.number === "2");
  await divideScene(db, projectId, scene.id, { mode: "script" });
  await generateStoryboard(db, projectId, scene.id, {});
  if (approveStoryboardToo) await approveShots(db, projectId, scene.id);
  mock.state.requests.length = 0;
  return { projectId, scene };
}
const assetByName = async (pid, re) => (await db.query("SELECT * FROM production_assets WHERE project_id = $1", [pid])).rows.find((a) => re.test(a.name));
const finish = async ({ row, done }) => { await done; return (await gens.list(row.project_id, { id: row.id }))[0]; };
const ONE_PIXEL_OK = (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const mediaRow = async (id) => (await db.query("SELECT * FROM production_media_files WHERE id = $1", [id])).rows[0];


const propsOf = async (pid) => (await db.query("SELECT * FROM production_assets WHERE project_id = $1 AND kind = 'prop' AND group_members IS NULL ORDER BY code", [pid])).rows;

test("planPropGroups: balanced groups of at most N; a lone prop is never 'grouped'", () => {
  const props = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `P${i + 1}` }));
  assert.deepEqual(planPropGroups(props(12), 6).map((g) => g.length), [6, 6]);
  assert.deepEqual(planPropGroups(props(7), 6).map((g) => g.length), [4, 3]);
  assert.deepEqual(planPropGroups(props(4), 6).map((g) => g.length), [4]);
  assert.deepEqual(planPropGroups(props(1), 6), []);
  assert.deepEqual(planPropGroups(props(0), 6), []);
  assert.deepEqual(planPropGroups(props(20), 99).map((g) => g.length), [7, 7, 6], "never more than 9 per picture");
});

test("combining: the props share ONE sheet; the single props are hidden; the sheet is an ordinary item with a numbered-grid command", async () => {
  const { projectId } = await ready();
  const props = await propsOf(projectId);
  assert.ok(props.length >= 2, "the sample film has at least two props");
  const expected = planPropGroups(props, 6);
  const preview = await previewPropGroups(db, projectId, 6);
  assert.equal(preview.groups, expected.length);
  assert.equal(preview.picturesSaved, props.length - expected.length);
  const done = await combineProps(db, projectId, { perImage: 6 });
  assert.deepEqual(done.groups.map((g) => g.members.length), expected.map((g) => g.length));
  assert.equal(done.groups[0].code, "PGRP01");
  assert.deepEqual(done.groups[0].members.map((m) => m.position), done.groups[0].members.map((_, i) => i + 1));
  assert.equal(done.picturesSaved, props.length - expected.length);

  const { assets } = await computeSpecs(db, projectId);
  const visibleProps = assets.filter((a) => a.kind === "prop");
  assert.deepEqual(visibleProps.map((a) => a.code), done.groups.map((g) => g.code), "only the sheets are listed; the single props are hidden");

  const sheet = visibleProps[0];
  const prompt = assetPrompt(sheet, "Photorealistic test look");
  assert.match(prompt, /Props sheet for a film/);
  assert.match(prompt, /ONE image/);
  for (const m of done.groups[0].members) assert.ok(prompt.includes(`position ${m.position}: ${m.name}`), `position ${m.position} is ${m.name}`);
  assert.match(prompt, /position 1 is the top-left/);
  assert.match(prompt, /VISUAL STYLE/);
});

test("shots that used a single prop now use its sheet, once, and their command names the position of the prop", async () => {
  const { projectId } = await ready();
  const before = await listShots(db, projectId);
  const usingProp = before.find((s) => s.assets.some((a) => a.kind === "prop"));
  assert.ok(usingProp, "a shot uses a prop");
  const propName = usingProp.assets.find((a) => a.kind === "prop").name;
  await combineProps(db, projectId, { perImage: 6 });
  const after = (await listShots(db, projectId)).find((s) => s.id === usingProp.id);
  const propEntries = after.assets.filter((a) => a.kind === "prop");
  assert.ok(propEntries.length >= 1 && propEntries.every((a) => /^PGRP\d+$/.test(a.code) && a.members.length >= 2), "a shot's props are now sheets");
  assert.equal(new Set(propEntries.map((a) => a.id)).size, propEntries.length, "each sheet appears once per shot");
  const names = plannedRefNames(after);
  assert.ok(names.some((n) => /^Props sheet \d+ \(position \d+: /.test(n)), "the command refers to the sheet by position");
});

test("memberLabel names only the props a shot talks about (all of them when it names none)", () => {
  const group = { name: "Props sheet 1", members: [{ position: 1, name: "Bamboo" }, { position: 2, name: "Mug" }, { position: 3, name: "Camera" }, { position: 4, name: "TV" }] };
  assert.equal(memberLabel(group, "She lifts the mug and the camera."), "Props sheet 1 (position 2: Mug, position 3: Camera)");
  assert.equal(memberLabel(group, "A quiet room."), "Props sheet 1 (position 1: Bamboo, position 2: Mug, position 3: Camera, position 4: TV)");
});

test("the sheet is made ONCE: one picture, one cost, and approving it covers every prop on it", async () => {
  const { projectId } = await ready();
  const props = await propsOf(projectId);
  await combineProps(db, projectId, { perImage: 6 });
  const sheet = (await db.query("SELECT * FROM production_assets WHERE project_id = $1 AND code = 'PGRP01'", [projectId])).rows[0];
  mock.state.requests.length = 0;
  const job = await finish(await gens.generateReference(projectId, sheet.id));
  assert.equal(job.status, "ready");
  assert.equal(mock.state.requests.length, 1, `one picture request for ${sheet.group_members.length} props`);
  const sent = mock.state.requests.at(-1).body.contents[0].parts.find((p) => p.text).text;
  const members = sheet.group_members;
  for (const m of members) assert.ok(sent.includes(`position ${m.position}: ${m.name}`), `${m.name} is in the one request`);
  assert.equal(members.length > 1, true);
  await gens.review(projectId, job.id, { decision: "approve" });
  const manifestSheet = (await db.query("SELECT 1 FROM production_generations WHERE asset_id = $1 AND review = 'approved'", [sheet.id])).rowCount;
  assert.equal(manifestSheet, 1);
});

test("splitting goes back to one picture per prop, but only for a sheet nothing was made for", async () => {
  const { projectId } = await ready();
  await combineProps(db, projectId, { perImage: 6 });
  const back = await splitProps(db, projectId);
  assert.ok(back.split >= 1);
  assert.equal((await propsOf(projectId)).filter((p) => p.grouped_into === null).length, (await propsOf(projectId)).length);
  assert.equal((await db.query("SELECT 1 FROM production_assets WHERE project_id = $1 AND group_members IS NOT NULL", [projectId])).rowCount, 0);

  await combineProps(db, projectId, { perImage: 6 });
  const sheet = (await db.query("SELECT * FROM production_assets WHERE project_id = $1 AND code = 'PGRP01'", [projectId])).rows[0];
  await finish(await gens.generateReference(projectId, sheet.id));
  const kept = await splitProps(db, projectId);
  assert.deepEqual(kept.keptBecauseMade, ["PGRP01"]);
  assert.equal((await db.query("SELECT 1 FROM production_assets WHERE project_id = $1 AND code = 'PGRP01'", [projectId])).rowCount, 1, "the made sheet is kept");
});

test("a prop that already has a picture is never swallowed into a sheet", async () => {
  const { projectId } = await ready();
  const props = await propsOf(projectId);
  await finish(await gens.generateReference(projectId, props[0].id));
  const done = await combineProps(db, projectId, { perImage: 6 });
  const members = done.groups.flatMap((g) => g.members.map((m) => m.assetId));
  assert.ok(!members.includes(props[0].id), "the already-made prop stays on its own");
});

test("a prop's description on the sheet command is real text (never '[object Object]'), whichever way it is stored", async () => {
  const { projectId } = await ready();
  // descriptions saved as { en, hi } objects, the way the AI Movie asset list stores them
  for (const p of await propsOf(projectId)) {
    await db.query("UPDATE production_assets SET agent_details = $1 WHERE id = $2", [JSON.stringify({ description: { en: `A real ${p.name} in daily use`, hi: "हिन्दी" } }), p.id]);
  }
  const { groups } = await combineProps(db, projectId, { perImage: 6 });
  assert.ok(groups[0].members.every((m) => typeof m.description === "string" && m.description.startsWith("A real ")), "stored as plain text");
  const sheet = (await db.query("SELECT * FROM production_assets WHERE project_id = $1 AND code = 'PGRP01'", [projectId])).rows[0];
  const prompt = assetPrompt(sheet, "Photorealistic test look");
  assert.doesNotMatch(prompt, /\[object Object\]/);
  assert.match(prompt, /position 1: .+ — A real /);
  assert.doesNotMatch(prompt, /INDIAN/, "objects are not made 'Indian'");
});

test("a sheet saved by the earlier version with '[object Object]' is repaired from the props themselves", async () => {
  const { projectId } = await ready();
  for (const p of await propsOf(projectId)) await db.query("UPDATE production_assets SET agent_details = $1 WHERE id = $2", [JSON.stringify({ description: { en: `Genuine ${p.name}`, hi: "x" } }), p.id]);
  const { groups } = await combineProps(db, projectId, { perImage: 6 });
  const broken = groups[0].members.map((m) => ({ ...m, description: "[object Object]" }));
  await db.query("UPDATE production_assets SET group_members = $1 WHERE id = $2", [JSON.stringify(broken), groups[0].id]);
  assert.equal(await repairPropGroupDescriptions(db), 1);
  const fixed = (await db.query("SELECT group_members FROM production_assets WHERE id = $1", [groups[0].id])).rows[0].group_members;
  assert.ok(fixed.every((m) => m.description.startsWith("Genuine ")), JSON.stringify(fixed));
  assert.equal(await repairPropGroupDescriptions(db), 0, "nothing left to repair");
});

test("plainText turns every stored shape into one line of text", () => {
  assert.equal(plainText("hello"), "hello");
  assert.equal(plainText({ en: "English", hi: "हिन्दी" }), "English");
  assert.equal(plainText({ hi: "only hindi" }), "only hindi");
  assert.equal(plainText(null), "");
  assert.equal(plainText(undefined), "");
  assert.equal(plainText(42), "");
});
