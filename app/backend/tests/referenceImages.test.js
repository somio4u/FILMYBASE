// Reference images: real logos / brands / titles that go along with the pictures that mention them (referenceImages.js). The AI service is a LOCAL IMITATION (tests/mockGemini.js).
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
import { createGenerationService } from "../generations.js";
import { matchReferences, referenceSentence, parseKeywords, detectReferenceNeeds, listReferenceImages } from "../referenceImages.js";
import { assetPrompt, keyframePrompt, sheetSpec, frameSpec, assetReferences, shotReferences } from "../generations.js";
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




const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const REFS = [
  { id: 1, code: "REF01", label: "Tarang Plus logo", kind: "logo", keywords: ["Tarang Plus", "Tarang"], mediaId: 11, fileName: "REF01_Tarang-Plus-logo" },
  { id: 2, code: "REF02", label: "Odisha Today", kind: "brand", keywords: [], mediaId: 12, fileName: "REF02_Odisha-Today" },
];

test("matching: a reference is needed when the text names it (label or 'also called'), as a whole word, any case", () => {
  assert.deepEqual(matchReferences("He switches on the TV: the Tarang Plus logo glows in the corner.", REFS).map((r) => r.code), ["REF01"]);
  assert.deepEqual(matchReferences("a channel called TARANG", REFS).map((r) => r.code), ["REF01"]);
  assert.deepEqual(matchReferences("Odisha Today is on the table", REFS).map((r) => r.code), ["REF02"]);
  assert.deepEqual(matchReferences("A quiet room with a lamp.", REFS), []);
  assert.deepEqual(matchReferences("a TV", [{ ...REFS[0], label: "TV", keywords: [] }]).map((r) => r.code), ["REF01"]);
  assert.deepEqual(matchReferences("an activity near the tvset", [{ ...REFS[0], label: "TV", keywords: [] }]), [], "TV must not match inside other words");
  assert.deepEqual(matchReferences("", REFS), []);
  assert.deepEqual(matchReferences("Tarang Plus and Odisha Today and Tarang", [...REFS, { ...REFS[0], id: 3, code: "REF03", label: "Third", keywords: ["Tarang"] }]).map((r) => r.code), ["REF01", "REF02"], "never more than two on one picture");
  assert.deepEqual(matchReferences("ତରଙ୍ଗ ପ୍ଲସ ଲୋଗୋ", [{ ...REFS[0], keywords: ["ତରଙ୍ଗ ପ୍ଲସ"] }]).map((r) => r.code), ["REF01"], "other scripts match as text");
});

test("the sentence says the artwork is real and must be copied, not invented; no sentence when nothing matches", () => {
  const s = referenceSentence([REFS[0]]);
  assert.match(s, /REAL REFERENCE IMAGE —/);
  assert.match(s, /1\) Tarang Plus logo \(logo\)/);
  assert.match(s, /show it exactly as given/);
  assert.match(s, /Do not redraw it/);
  assert.match(referenceSentence(REFS), /IMAGES — attached after any model sheets, in this order: 1\) Tarang Plus logo \(logo\); 2\) Odisha Today \(brand\)/);
  assert.equal(referenceSentence([]), "");
});

test("keywords: split, trimmed, deduplicated and limited", () => {
  assert.deepEqual(parseKeywords("Tarang Plus, Tarang ;  tarang plus\n x ,TV"), ["Tarang Plus", "Tarang", "tarang plus", "TV"]);
  assert.deepEqual(parseKeywords(["A1", "A1", " "]), ["A1"]);
  assert.deepEqual(parseKeywords(""), []);
  assert.equal(parseKeywords(Array.from({ length: 30 }, (_, i) => `word${i}`)).length, 12);
});

test("commands: a shot / item that mentions a brand gets the reference sentence, the others do not; the same style packet is used everywhere", () => {
  const look = { text: "Photorealistic look", castOrigin: "indian", refs: REFS };
  const shot = { id: 1, framing: "Close", cameraAngle: "Eye level", cameraMove: "Static", description: "The Tarang Plus logo glows on the TV screen.", assets: [] };
  const plain = { ...shot, description: "A quiet empty room." };
  assert.match(keyframePrompt(shot, look, []), /REAL REFERENCE IMAGE — .*Tarang Plus logo/);
  assert.doesNotMatch(keyframePrompt(plain, look, []), /REAL REFERENCE/);
  const tv = { id: 5, kind: "prop", name: "TV", agent_details: { description: "An old TV that shows the Tarang Plus channel" }, human_edits: {} };
  assert.match(assetPrompt(tv, look), /REAL REFERENCE IMAGE/);
  assert.doesNotMatch(assetPrompt({ ...tv, agent_details: { description: "An old TV" } }, look), /REAL REFERENCE/);
  assert.doesNotMatch(assetPrompt(tv, { text: "x", castOrigin: "indian", refs: [] }), /REAL REFERENCE/);
  assert.doesNotMatch(assetPrompt(tv, "plain text style"), /REAL REFERENCE/);
  assert.equal(assetReferences(tv, REFS).length, 1);
  assert.equal(shotReferences(plain, REFS).length, 0);
});

test("adding or removing a reference changes the fingerprint ONLY of the pictures it concerns", () => {
  const shot = { id: 1, framing: "Close", cameraAngle: "Eye level", cameraMove: "Static", description: "The Tarang Plus logo glows.", assets: [] };
  const other = { ...shot, id: 2, description: "A quiet room." };
  const look = (refs) => ({ text: "Photorealistic look", castOrigin: "indian", refs });
  assert.notEqual(frameSpec(shot, look(REFS)).sourceHash, frameSpec(shot, look([])).sourceHash);
  assert.equal(frameSpec(other, look(REFS)).sourceHash, frameSpec(other, look([])).sourceHash, "an unrelated shot is left alone");
  assert.notEqual(frameSpec(shot, look([REFS[0]])).sourceHash, frameSpec(shot, look([{ ...REFS[0], mediaId: 99 }])).sourceHash, "a replaced picture makes it out of date");
});

test("detect: Adu's suggestions are cleaned (kind, keywords, duplicates, those already added)", async () => {
  let asked = "";
  const textJson = async (prompt) => { asked = prompt; return { items: [
    { name: "Tarang Plus", kind: "logo", keywords: ["Tarang"], where: "TV in scene 2" },
    { name: "tarang plus", kind: "logo" },
    { name: "Odisha Today", kind: "weird", keywords: "a, b" },
    { name: "Already Added", kind: "brand" },
    { name: "", kind: "logo" },
  ] }; };
  const items = await detectReferenceNeeds({ textJson, screenplay: "The Tarang Plus channel plays on the TV.", have: ["Already Added"] });
  assert.deepEqual(items.map((i) => i.name), ["Tarang Plus", "Odisha Today"]);
  assert.equal(items[1].kind, "brand");
  assert.deepEqual(items[1].keywords, []);
  assert.match(asked, /The Tarang Plus channel plays on the TV/);
  assert.match(asked, /Already added \(do not list again\): Already Added/);
  assert.deepEqual(await detectReferenceNeeds({ textJson: async () => ({}), screenplay: "x" }), []);
});

test("generation: the matching reference image really travels with the request, after the model sheets, and is recorded", async () => {
  const { projectId } = await ready();
  const rahul = await assetByName(projectId, /Rahul/);
  // a reference image stored like a real upload
  const file = path.join(tmp, "logo.png"); fs.writeFileSync(file, PNG);
  const media = await store.putMedia({ projectId, role: "reference", filePath: file, originalName: "REF01_Logo.png", label: "REF01 Rahul Channel", subfolder: "Reference images", dimensions: {} });
  await db.query("INSERT INTO production_reference_images (project_id, code, label, kind, keywords, media_id) VALUES ($1,'REF01','Rahul Channel','logo','[]',$2)", [projectId, media.id]);
  assert.equal((await listReferenceImages(db, projectId)).length, 1);
  await db.query("UPDATE production_assets SET human_edits = human_edits || $1 WHERE id = $2", [JSON.stringify({ description: "He always wears a cap with the Rahul Channel logo" }), rahul.id]);
  mock.state.requests.length = 0;
  const job = await (async () => { const g = await gens.generateReference(projectId, rahul.id); await g.done; return g.row; })();
  const sent = mock.state.requests.at(-1).body.contents[0].parts;
  assert.equal(sent.filter((p) => p.inlineData).length, 1, "the logo is attached");
  assert.match(sent.find((p) => p.text).text, /REAL REFERENCE IMAGE — .*Rahul Channel/);
  assert.deepEqual((await db.query("SELECT params FROM production_generations WHERE id = $1", [job.id])).rows[0].params.brandRefs, ["REF01"]);

  // an item that does not mention it gets nothing attached
  const other = (await db.query("SELECT * FROM production_assets WHERE project_id = $1 AND id <> $2 AND kind = 'prop' LIMIT 1", [projectId, rahul.id])).rows[0];
  mock.state.requests.length = 0;
  const g2 = await gens.generateReference(projectId, other.id); await g2.done;
  assert.equal(mock.state.requests.at(-1).body.contents[0].parts.filter((p) => p.inlineData).length, 0);
});

import { describeDetails } from "../generations.js";
test("a description saved in two languages ({ en, hi }) is part of the command — it used to be left out of every character and prop command", () => {
  const text = describeDetails({ description: { en: "a lean man of 24 in a green t-shirt", hi: "हिन्दी" }, costumes: [{ name: "Casual", description: "cargo pants" }], aliases: ["R"] });
  assert.match(text, /description: a lean man of 24 in a green t-shirt/);
  assert.match(text, /costumes: Casual - cargo pants/);
  assert.doesNotMatch(text, /\[object Object\]/);
  assert.equal(describeDetails({ description: { hi: "केवल हिन्दी" } }), "description: केवल हिन्दी");
  assert.equal(describeDetails({ description: { en: "" , hi: "" } }), "");
  assert.equal(describeDetails({ build: "plain text" }), "build: plain text");
});
