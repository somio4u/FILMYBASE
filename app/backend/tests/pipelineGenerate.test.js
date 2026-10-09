// Pipeline steps 4-7: AI pictures, voices and video, their review, the money
// limit and the gates between steps. The AI service is a LOCAL IMITATION
// (tests/mockGemini.js): these prove the app's own logic, not that real Google
// accepts the same requests.
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
import { createGenerationService, failStaleGenerations, speechText, describeDetails, assetPrompt } from "../generations.js";
import { saveSettings, getSettings, spendSummary, assertWithinBudget } from "../pipelineSettings.js";
import { divideScene, listShots, generateStoryboard, approveStoryboard } from "../shots.js";
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
  if (approveStoryboardToo) await approveStoryboard(db, projectId, scene.id);
  mock.state.requests.length = 0;
  return { projectId, scene };
}
const assetByName = async (pid, re) => (await db.query("SELECT * FROM production_assets WHERE project_id = $1", [pid])).rows.find((a) => re.test(a.name));
const finish = async ({ row, done }) => { await done; return (await gens.list(row.project_id, { id: row.id }))[0]; };
const ONE_PIXEL_OK = (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const mediaRow = async (id) => (await db.query("SELECT * FROM production_media_files WHERE id = $1", [id])).rows[0];

// ---------------------------------------------------------------------------
// The AI service layer
// ---------------------------------------------------------------------------

test("providers: a picture comes back as a real PNG; references are sent along; the key travels in a header", async () => {
  const img = await providers.generateImage({ prompt: "A red door", references: [{ bytes: Buffer.from("abc"), mime: "image/png" }], aspectRatio: "16:9" });
  assert.ok(ONE_PIXEL_OK(img.bytes));
  assert.equal(img.ext, ".png");
  const sent = mock.state.requests.at(-1);
  assert.equal(sent.key, "test-key");
  assert.match(sent.path, /gemini-2.5-flash-image:generateContent/);
  assert.equal(sent.body.contents[0].parts.filter((p) => p.inlineData).length, 1);
  assert.equal(sent.body.generationConfig.imageConfig.aspectRatio, "16:9");
});

test("providers: voice is a valid .wav with a real length; the chosen voice name is sent", async () => {
  const v = await providers.generateSpeech({ text: "Hello there, how are you today my friend", voice: "Puck" });
  assert.equal(v.bytes.slice(0, 4).toString(), "RIFF");
  assert.equal(v.bytes.slice(8, 12).toString(), "WAVE");
  assert.ok(v.durationMs > 400);
  assert.equal(mock.state.requests.at(-1).body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Puck");
  assert.equal(wavDurationMs(pcmToWav(Buffer.alloc(48000), 24000)), 1000);
});

test("providers: video starts a job, checks back until done, then downloads the file", async () => {
  mock.state.videoPollsBeforeDone = 2;
  const out = await providers.generateVideo({ prompt: "A door opens", image: { bytes: Buffer.from("x"), mime: "image/png" }, durationSec: 4, pollMs: 1 });
  assert.equal(out.bytes.slice(4, 8).toString(), "ftyp");
  const polls = mock.state.requests.filter((r) => r.method === "GET" && r.path.startsWith("/v1beta/operations/")).length;
  assert.ok(polls >= 3);
  const start = mock.state.requests.find((r) => r.path.endsWith(":predictLongRunning"));
  assert.equal(start.body.instances[0].image.mimeType, "image/png");
  assert.equal(start.body.parameters.durationSeconds, 4);
  mock.state.videoPollsBeforeDone = 1;
});

test("providers: every failure is turned into a plain sentence", async () => {
  const bad = createProviders({ env: { GEMINI_API_KEY: "wrong", GEMINI_API_BASE: mock.base } });
  await assert.rejects(bad.generateImage({ prompt: "x" }), /API key was refused/);
  await assert.rejects(createProviders({ env: { GEMINI_API_BASE: mock.base } }).generateImage({ prompt: "x" }), /needs the Gemini key/);
  mock.state.failNext = { status: 429 };
  await assert.rejects(providers.generateImage({ prompt: "x" }), /usage limit/);
  mock.state.failNext = { status: 404 };
  await assert.rejects(providers.generateSpeech({ text: "x" }), /does not know this model/);
  mock.state.failNext = { status: 403 };
  await assert.rejects(providers.generateImage({ prompt: "x" }), /refused this request \(403\)/);
  await assert.rejects(providers.generateImage({ prompt: "FORBIDDEN" }), /no picture \(SAFETY\)/);
  await assert.rejects(providers.generateVideo({ prompt: "FORBIDDEN", pollMs: 1 }), /no video \(blocked by policy\)/);
  const unreachable = createProviders({ env: { GEMINI_API_KEY: "k", GEMINI_API_BASE: "http://127.0.0.1:1" } });
  await assert.rejects(unreachable.generateImage({ prompt: "x" }), /could not reach Google/);
  const slow = createProviders({ env: { GEMINI_API_KEY: "test-key", GEMINI_API_BASE: mock.base }, sleep: () => new Promise((r) => setTimeout(r, 5)) });
  mock.state.videoPollsBeforeDone = 1000;
  await assert.rejects(slow.generateVideo({ prompt: "slow", pollMs: 1, maxWaitMs: 30 }), /took too long/);
  mock.state.videoPollsBeforeDone = 1;
});

// ---------------------------------------------------------------------------
// Settings and the money limit
// ---------------------------------------------------------------------------

test("settings: defaults, saving, and strict checks", async () => {
  const { projectId } = await ready();
  const s = await getSettings(db, projectId);
  assert.deepEqual([s.aspectRatio, s.stylePrompt, s.budgetLimitUsd], ["16:9", "", null]);
  assert.equal(s.effectiveBudgetUsd, 5);
  const saved = await saveSettings(db, projectId, { stylePrompt: " moody, warm light ", aspectRatio: "9:16", budgetLimitUsd: 12.5, voices: { RAHUL: "Puck" } });
  assert.deepEqual([saved.stylePrompt, saved.aspectRatio, saved.effectiveBudgetUsd, saved.voices.RAHUL], ["moody, warm light", "9:16", 12.5, "Puck"]);
  await assert.rejects(saveSettings(db, projectId, { aspectRatio: "2:1" }), /Picture shape/);
  await assert.rejects(saveSettings(db, projectId, { budgetLimitUsd: -1 }), /money limit/);
  await assert.rejects(saveSettings(db, projectId, { budgetLimitUsd: "lots" }), /money limit/);
  await assert.rejects(saveSettings(db, projectId, { voices: { A: "Nobody" } }), /not one of the available voices/);
  assert.equal((await saveSettings(db, projectId, { budgetLimitUsd: null })).effectiveBudgetUsd, 5);
  await assert.rejects(assertWithinBudget(db, projectId, 6), /Raise the money limit/);
  assert.equal((await spendSummary(db, projectId)).spentUsd, 0);
});

// ---------------------------------------------------------------------------
// Step 4: reference pictures
// ---------------------------------------------------------------------------

test("reference picture: stored in the project's character folder, costed, and shown with its prompt", async () => {
  const { projectId } = await ready();
  await saveSettings(db, projectId, { stylePrompt: "grainy 35mm, warm morning light" });
  const rahul = await assetByName(projectId, /Rahul/);
  const job = await gens.generateReference(projectId, rahul.id);
  assert.equal(job.row.status, "running");
  const g = await finish(job);
  assert.equal(g.status, "ready");
  assert.equal(g.kind, "character");
  assert.equal(g.version, 1);
  assert.match(g.prompt, /Rahul Mohapatra/);
  assert.match(g.prompt, /grainy 35mm/);
  assert.equal(g.mediaUrl, `/api/production/media/${g.mediaId}`);
  const m = await mediaRow(g.mediaId);
  assert.equal(m.role, "character");
  assert.equal(m.subfolder, `${rahul.code} ${rahul.name}`);
  assert.equal(m.status, "stored");
  assert.equal(g.costUsd, 0.04);
  const spend = await spendSummary(db, projectId);
  assert.equal(spend.spentUsd, 0.04);
  assert.equal(spend.byKind.character.count, 1);
  const sent = mock.state.requests.find((r) => r.path.endsWith(":generateContent"));
  assert.equal(sent.body.generationConfig.imageConfig.aspectRatio, "3:4");
  // a second try is version 2
  const g2 = await finish(await gens.generateReference(projectId, rahul.id, { note: "older, with a beard" }));
  assert.equal(g2.version, 2);
  assert.match(g2.prompt, /older, with a beard/);
});

test("props and places get their own kinds, shapes and folders", async () => {
  const { projectId } = await ready();
  const cup = await assetByName(projectId, /coffee cup/i);
  const office = await assetByName(projectId, /Apartment entrance/i);
  const a = await finish(await gens.generateReference(projectId, cup.id));
  const b = await finish(await gens.generateReference(projectId, office.id));
  assert.equal(a.kind, "prop");
  assert.equal(b.kind, "environment");
  assert.equal((await mediaRow(a.mediaId)).role, "prop");
  assert.equal((await mediaRow(b.mediaId)).role, "environment");
  assert.match(a.prompt, /on a plain light-grey studio background/);
  assert.match(b.prompt, /No people in the picture/);
});

test("review: only one result per item is approved; approving another switches; reject and reset work; a failed result cannot be approved", async () => {
  const { projectId } = await ready();
  const rahul = await assetByName(projectId, /Rahul/);
  const one = await finish(await gens.generateReference(projectId, rahul.id));
  const two = await finish(await gens.generateReference(projectId, rahul.id));
  assert.equal((await gens.review(projectId, one.id, { decision: "approve" })).review, "approved");
  assert.equal((await gens.review(projectId, two.id, { decision: "approve" })).review, "approved");
  const list = await gens.list(projectId, { assetId: rahul.id });
  assert.deepEqual(list.map((g) => [g.version, g.review]), [[2, "approved"], [1, "pending"]]);
  assert.equal((await gens.review(projectId, one.id, { decision: "reject", note: "wrong age" })).reviewNote, "wrong age");
  assert.equal((await gens.review(projectId, one.id, { decision: "reset" })).review, "pending");
  await assert.rejects(gens.review(projectId, one.id, { decision: "maybe" }), /approve, reject or reset/);
  await assert.rejects(gens.review(projectId, 999999, { decision: "approve" }), /not found/);
  mock.state.failNext = { status: 500 };
  const failed = await finish(await gens.generateReference(projectId, rahul.id));
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /Picture generation failed \(HTTP 500\)/);
  assert.equal(failed.mediaId, null);
  await assert.rejects(gens.review(projectId, failed.id, { decision: "approve" }), /finished result/);
  assert.equal((await spendSummary(db, projectId)).byKind.character.count, 2); // the failed one cost nothing
  // the database itself refuses two approved results for one item
  await assert.rejects(db.query("UPDATE production_generations SET review = 'approved' WHERE id = $1", [one.id]), /duplicate key/);
});

test("pressing Make twice at once does not start two", async () => {
  const { projectId } = await ready();
  const rahul = await assetByName(projectId, /Rahul/);
  const first = await gens.generateReference(projectId, rahul.id);
  await assert.rejects(gens.generateReference(projectId, rahul.id), /already being made/);
  await first.done;
  assert.equal((await gens.list(projectId, { assetId: rahul.id })).length, 1);
});

test("money limit: refuses work that would go over, counting work still running", async () => {
  const { projectId } = await ready();
  await saveSettings(db, projectId, { budgetLimitUsd: 0.1 });
  const rahul = await assetByName(projectId, /Rahul/);
  const cup = await assetByName(projectId, /coffee cup/i);
  const office = await assetByName(projectId, /Apartment entrance/i);
  const a = await gens.generateReference(projectId, rahul.id);
  const b = await gens.generateReference(projectId, cup.id);
  await assert.rejects(gens.generateReference(projectId, office.id), (e) => e.status === 402 && e.code === "over_budget" && /\$0\.1/.test(e.message));
  await Promise.all([a.done, b.done]);
  assert.equal((await spendSummary(db, projectId)).remainingUsd, 0.02);
  await assert.rejects(gens.generateReference(projectId, office.id), /over|left of the/);
  await saveSettings(db, projectId, { budgetLimitUsd: 1 });
  assert.equal((await finish(await gens.generateReference(projectId, office.id))).status, "ready");
});

// ---------------------------------------------------------------------------
// Step 5: a picture per shot
// ---------------------------------------------------------------------------

test("keyframe gates: the text storyboard must be approved, and every person/place/object in the shot needs an approved reference", async () => {
  const { projectId, scene } = await ready({ approveStoryboardToo: false });
  const shots = await listShots(db, projectId, { sceneId: scene.id });
  await assert.rejects(gens.generateKeyframe(projectId, shots[0]), /Approve the text storyboard for scene 2/);
  await approveStoryboard(db, projectId, scene.id);
  const approved = await listShots(db, projectId, { sceneId: scene.id });
  await assert.rejects(gens.generateKeyframe(projectId, approved[0]), (e) => e.status === 409 && /approved reference picture first/.test(e.message) && /Rahul Mohapatra/.test(e.message));
  const rahul = await assetByName(projectId, /Rahul/);
  const loc = await assetByName(projectId, /Apartment entrance/i);
  for (const a of [rahul, loc]) {
    const g = await finish(await gens.generateReference(projectId, a.id));
    await gens.review(projectId, g.id, { decision: "approve" });
  }
  const s21 = approved.find((s) => s.number === "2.1");
  const ready21 = await gens.checkKeyframeReady(projectId, s21);
  assert.equal(ready21.ok, ready21.missing.length === 0);
});

test("keyframe: drawn from the approved references (sent as pictures), styled, stored in 04 Shot images, and flagged outdated when a reference changes", async () => {
  const { projectId, scene } = await ready();
  await saveSettings(db, projectId, { stylePrompt: "cold blue dawn" });
  const shots = await listShots(db, projectId, { sceneId: scene.id });
  const shot = shots.find((s) => s.number === "2.1");
  const needed = shot.assets.filter((a) => ["character", "location", "prop"].includes(a.kind));
  assert.ok(needed.length >= 2);
  const refGens = {};
  for (const a of needed) {
    const g = await finish(await gens.generateReference(projectId, a.id));
    await gens.review(projectId, g.id, { decision: "approve" });
    refGens[a.id] = g;
  }
  mock.state.requests.length = 0;
  const g = await finish(await gens.generateKeyframe(projectId, shot));
  assert.equal(g.status, "ready");
  assert.equal(g.kind, "keyframe");
  assert.match(g.prompt, /cold blue dawn/);
  assert.match(g.prompt, /Over-the-shoulder/);
  assert.match(g.prompt, /reference pictures to keep the exact same look for/);
  const sent = mock.state.requests.find((r) => r.path.endsWith(":generateContent"));
  assert.equal(sent.body.contents[0].parts.filter((p) => p.inlineData).length, Math.min(4, needed.length));
  assert.equal((await mediaRow(g.mediaId)).role, "keyframe");
  assert.equal((await mediaRow(g.mediaId)).subfolder, shot.sceneCode);
  assert.equal(g.outdated, false);
  assert.equal(g.params.refs.length, needed.length);
  // replace one reference: the shot picture is now out of date
  const first = needed[0];
  const newer = await finish(await gens.generateReference(projectId, first.id));
  await gens.review(projectId, newer.id, { decision: "approve" });
  assert.equal((await gens.list(projectId, { shotId: shot.id }))[0].outdated, true);
});

test("keyframe with allowMissing skips unapproved references instead of refusing (storyboard still required)", async () => {
  const { projectId, scene } = await ready();
  const shot = (await listShots(db, projectId, { sceneId: scene.id }))[0];
  const g = await finish(await gens.generateKeyframe(projectId, shot, { allowMissing: true }));
  assert.equal(g.status, "ready");
  assert.deepEqual(g.params.refs, []);
});

// ---------------------------------------------------------------------------
// Step 6: voices
// ---------------------------------------------------------------------------

test("voices: one per dialogue line, a steady voice per speaker, settings can change it, parenthetical becomes the style", async () => {
  const { projectId } = await ready();
  const lines = (await db.query("SELECT * FROM production_scene_elements WHERE project_id = $1 AND kind = 'dialogue' ORDER BY order_index", [projectId])).rows;
  const rahulLine = lines.find((l) => /RAHUL/i.test(l.speaker) && l.parenthetical);
  assert.ok(rahulLine);
  assert.equal(speechText({ text_en: "Hi", parenthetical: "(tired)" }), "Say tired: Hi");
  const g = await finish(await gens.generateVoice(projectId, rahulLine.id));
  assert.equal(g.status, "ready");
  assert.equal(g.kind, "audio");
  assert.equal(g.prompt.startsWith("Say "), true);
  const m = await mediaRow(g.mediaId);
  assert.equal(m.role, "audio");
  assert.equal(m.mime, "audio/wav");
  assert.ok(m.duration_ms > 0);
  const voiceUsed = () => mock.state.requests.filter((r) => r.body?.generationConfig?.speechConfig).at(-1).body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
  const first = voiceUsed();
  await finish(await gens.generateVoice(projectId, rahulLine.id));
  assert.equal(voiceUsed(), first);
  await saveSettings(db, projectId, { voices: { [rahulLine.speaker]: "Fenrir" } });
  await finish(await gens.generateVoice(projectId, rahulLine.id));
  assert.equal(voiceUsed(), "Fenrir");
  await assert.rejects(gens.generateVoice(projectId, 999999), /not found/);
  assert.ok((await spendSummary(db, projectId)).byKind.audio.count >= 3);
});

// ---------------------------------------------------------------------------
// Step 7: video takes
// ---------------------------------------------------------------------------

test("video: needs an approved shot picture; takes are numbered; one take is chosen per shot", async () => {
  const { projectId, scene } = await ready();
  const shot = (await listShots(db, projectId, { sceneId: scene.id }))[0];
  await assert.rejects(gens.generateTake(projectId, shot), /needs an approved picture first/);
  const key = await finish(await gens.generateKeyframe(projectId, shot, { allowMissing: true }));
  await assert.rejects(gens.generateTake(projectId, shot), /needs an approved picture first/);
  await gens.review(projectId, key.id, { decision: "approve" });
  mock.state.requests.length = 0;
  const t1 = await finish(await gens.generateTake(projectId, shot, { durationSec: 5 }));
  assert.equal(t1.status, "ready");
  assert.equal(t1.version, 1);
  assert.equal(t1.params.seconds, 6); // 5s is rounded up to what the video maker offers
  assert.equal(t1.costUsd, 0.9);
  const m = await mediaRow(t1.mediaId);
  assert.equal(m.role, "video_take");
  assert.equal(m.mime, "video/mp4");
  const start = mock.state.requests.find((r) => r.path.endsWith(":predictLongRunning"));
  assert.ok(start.body.instances[0].image.bytesBase64Encoded.length > 50); // the approved picture is the start frame
  assert.match(start.body.instances[0].prompt, /Start exactly from the given picture/);
  const t2 = await finish(await gens.generateTake(projectId, shot));
  assert.equal(t2.version, 2);
  assert.equal(t2.params.seconds, 4);
  await gens.review(projectId, t1.id, { decision: "approve" });
  await gens.review(projectId, t2.id, { decision: "approve", note: "better pacing" });
  assert.deepEqual((await gens.list(projectId, { shotId: shot.id, kind: "video" })).map((g) => [g.version, g.review]), [[2, "approved"], [1, "pending"]]);
});

test("a video that fails or is blocked is recorded as failed with the reason, and costs nothing", async () => {
  const { projectId, scene } = await ready();
  const shot = (await listShots(db, projectId, { sceneId: scene.id }))[0];
  const key = await finish(await gens.generateKeyframe(projectId, shot, { allowMissing: true }));
  await gens.review(projectId, key.id, { decision: "approve" });
  await db.query("UPDATE production_shots SET description = 'FORBIDDEN scene', storyboard_text = 'FORBIDDEN scene' WHERE id = $1", [shot.id]);
  const forbidden = (await listShots(db, projectId, { sceneId: scene.id }))[0];
  const t = await finish(await gens.generateTake(projectId, forbidden));
  assert.equal(t.status, "failed");
  assert.match(t.error, /no video \(blocked by policy\)/);
  assert.equal((await spendSummary(db, projectId)).byKind.video, undefined);
});

// ---------------------------------------------------------------------------
// Whole-pipeline status, restarts, prompts
// ---------------------------------------------------------------------------

test("status shows how far the pipeline has got", async () => {
  const { projectId, scene } = await ready();
  let s = await gens.status(projectId);
  assert.equal(s.scenes, 12);
  assert.equal(s.shots.total, 8);
  assert.equal(s.shots.storyboardApproved, 8);
  assert.equal(s.references.characters.approved, 0);
  assert.ok(s.references.characters.total >= 8);
  const rahul = await assetByName(projectId, /Rahul/);
  await gens.review(projectId, (await finish(await gens.generateReference(projectId, rahul.id))).id, { decision: "approve" });
  s = await gens.status(projectId);
  assert.equal(s.references.characters.approved, 1);
  assert.equal(s.keyframes.of, 8);
  assert.ok(scene);
});

test("work cut off by a server restart is marked failed, not left running forever", async () => {
  const { projectId } = await ready();
  const rahul = await assetByName(projectId, /Rahul/);
  await db.query("INSERT INTO production_generations (project_id, kind, asset_id, version, prompt, status) VALUES ($1,'character',$2,9,'x','running')", [projectId, rahul.id]);
  await failStaleGenerations(db);
  const g = (await gens.list(projectId, { assetId: rahul.id }))[0];
  assert.equal(g.status, "failed");
  assert.match(g.error, /server restarted/);
});

test("prompts: item details are turned into readable text; internal fields are left out", () => {
  const text = describeDetails({ description: "Tall, thin", sceneRefs: ["Scene 1"], missing: ["age"], costumes: ["white shirt", "maroon tie"], extra: { a: "x" }, empty: "" });
  assert.equal(text, "description: Tall, thin. costumes: white shirt; maroon tie");
  const p = assetPrompt({ name: "Rahul", kind: "character", agent_details: { description: "Tall" }, human_edits: {} }, "");
  assert.match(p, /Character reference picture of "Rahul"/);
  assert.match(p, /No text, letters/);
});
