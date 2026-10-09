// Tests for production.js against a real local Postgres.
// FIXTURE DATA ONLY — the "agent output" below is made up to exercise the
// adapter; it is not output from the real silent agent.
//
//   createdb filmmaking_app_test && node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { ensureProductionSchema, ingestAgentOutput, listProductionAssets, listProductionIssues, getProductionOverview, nameKey } from "../production.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });

const FIXTURE = {
  characters: [
    { name: "Rudra", visualDescription: { en: "Tall, scarred monk", hi: "लंबा साधु" }, aliases: ["The Monk"], sceneRefs: ["Beat 1"], states: ["wounded"], missing: ["age"], costumes: [{ name: "Saffron robe", description: "faded" }] },
    { name: "Samir", visualDescription: { en: "Young engineer", hi: "" } },
  ],
  properties: [{ name: "Envelope", visualDescription: { en: "Cream envelope", hi: "" }, states: ["sealed", "opened"] }],
  environments: [{ name: "Prayer Room", visualDescription: { en: "Dim hall", hi: "" }, sceneRefs: ["Beat 2"] }],
  otherAssets: [{ name: "Warning sign", kind: "sign", visualDescription: { en: 'Sign reading "NO ENTRY"', hi: "" } }],
};

async function freshProject(assets) {
  const r = await db.query("INSERT INTO ai_movie_projects (pasted_text, assets) VALUES ('fixture', $1) RETURNING id", [assets == null ? null : JSON.stringify(assets)]);
  return r.rows[0].id;
}

test.before(async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_projects (
    id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await ensureProductionSchema(db);
  await ensureProductionSchema(db); // idempotent
});
test.after(() => db.end());

test("first import creates one record per asset with codes, issues, and counts from saved rows", async () => {
  const pid = await freshProject(FIXTURE);
  const r = await ingestAgentOutput(db, pid);
  assert.equal(r.outcome, "imported");
  const assets = await listProductionAssets(db, pid);
  assert.equal(assets.length, 5);
  assert.deepEqual(assets.map((a) => a.code).sort(), ["CHAR001", "CHAR002", "LOC001", "OTH001", "PROP001"]);
  const overview = await getProductionOverview(db, pid);
  assert.equal(overview.assetsByKind.character, 2);
  assert.ok(overview.openIssuesByCategory.missing_info > 0);
  assert.equal(r.summary.created, 5);
});

test("importing the same output twice creates nothing new", async () => {
  const pid = await freshProject(FIXTURE);
  await ingestAgentOutput(db, pid);
  const before = (await db.query("SELECT count(*)::int n FROM production_assets WHERE project_id=$1", [pid])).rows[0].n;
  const issuesBefore = (await listProductionIssues(db, pid)).length;
  const again = await ingestAgentOutput(db, pid);
  assert.equal(again.outcome, "duplicate");
  assert.equal((await db.query("SELECT count(*)::int n FROM production_assets WHERE project_id=$1", [pid])).rows[0].n, before);
  assert.equal((await db.query("SELECT count(*)::int n FROM production_agent_imports WHERE project_id=$1", [pid])).rows[0].n, 1);
  assert.equal((await listProductionIssues(db, pid)).length, issuesBefore);
});

test("concurrent identical imports still make one import and no duplicates", async () => {
  const pid = await freshProject(FIXTURE);
  await Promise.all([ingestAgentOutput(db, pid), ingestAgentOutput(db, pid), ingestAgentOutput(db, pid)]);
  assert.equal((await db.query("SELECT count(*)::int n FROM production_assets WHERE project_id=$1", [pid])).rows[0].n, 5);
  assert.equal((await db.query("SELECT count(*)::int n FROM production_agent_imports WHERE project_id=$1", [pid])).rows[0].n, 1);
});

test("a changed output updates the asset, keeps human edits and approval, and flags it", async () => {
  const pid = await freshProject(FIXTURE);
  await ingestAgentOutput(db, pid);
  const rudra = (await listProductionAssets(db, pid, "character")).find((a) => a.name === "Rudra");
  await db.query("UPDATE production_assets SET human_edits = $1 WHERE id = $2", [JSON.stringify({ description: { en: "HUMAN TEXT", hi: "" } }), rudra.id]);

  const changed = structuredClone(FIXTURE);
  changed.characters[0].visualDescription.en = "Agent's new wording";
  changed.characters.push({ name: "New Girl", visualDescription: { en: "x", hi: "" } });
  await db.query("UPDATE ai_movie_projects SET assets = $1 WHERE id = $2", [JSON.stringify(changed), pid]);
  const r = await ingestAgentOutput(db, pid);
  assert.equal(r.outcome, "imported");

  const after = await listProductionAssets(db, pid, "character");
  const rudra2 = after.find((a) => a.name === "Rudra");
  assert.equal(rudra2.details.description.en, "HUMAN TEXT"); // human wins
  assert.equal(rudra2.importedOriginal.description.en, "Agent's new wording"); // agent's proposal kept
  assert.equal(rudra2.importedRevision, 2);
  assert.equal(after.length, 3); // no duplicate Rudra, one new
  assert.ok((await listProductionIssues(db, pid)).some((i) => i.category === "agent_update" && i.asset_name === "Rudra"));
  assert.equal((await db.query("SELECT count(*)::int n FROM production_agent_imports WHERE project_id=$1", [pid])).rows[0].n, 2);
});

test("an alias matches the existing asset instead of creating a duplicate", async () => {
  const pid = await freshProject(FIXTURE);
  await ingestAgentOutput(db, pid);
  const next = structuredClone(FIXTURE);
  next.characters.push({ name: "the monk", visualDescription: { en: "same person", hi: "" } });
  await db.query("UPDATE ai_movie_projects SET assets = $1 WHERE id = $2", [JSON.stringify(next), pid]);
  await ingestAgentOutput(db, pid);
  assert.equal((await listProductionAssets(db, pid, "character")).length, 2);
});

test("same name in different kinds stays separate", async () => {
  const pid = await freshProject({
    characters: [{ name: "Ring", visualDescription: { en: "a girl", hi: "" } }],
    properties: [{ name: "Ring", visualDescription: { en: "a ring", hi: "" } }],
    environments: [],
  });
  await ingestAgentOutput(db, pid);
  assert.equal((await listProductionAssets(db, pid)).length, 2);
});

test("partial output imports; malformed entries are quarantined, not fatal", async () => {
  const pid = await freshProject({
    characters: [{ name: "Good", visualDescription: { en: "ok", hi: "" } }, { visualDescription: {} }, "junk", { name: "   " }],
    properties: "not a list",
  });
  const r = await ingestAgentOutput(db, pid);
  assert.equal(r.outcome, "imported");
  assert.equal(r.status, "partially_ready");
  assert.equal(r.summary.quarantined, 4);
  assert.equal((await listProductionAssets(db, pid)).length, 1);
  assert.ok((await listProductionIssues(db, pid)).some((i) => i.category === "quarantined"));
});

test("no output / unrecognisable output fails cleanly and creates no assets", async () => {
  for (const bad of [null, [], { foo: 1 }]) {
    const pid = await freshProject(bad);
    const r = await ingestAgentOutput(db, pid);
    assert.equal(r.outcome, "failed", JSON.stringify(bad));
    assert.equal((await listProductionAssets(db, pid)).length, 0);
  }
});

test("unknown project is not_found and one project never sees another's assets", async () => {
  assert.equal((await ingestAgentOutput(db, 99999999)).outcome, "not_found");
  const a = await freshProject(FIXTURE);
  const b = await freshProject({ characters: [{ name: "Only B", visualDescription: { en: "x", hi: "" } }], properties: [], environments: [] });
  await ingestAgentOutput(db, a);
  await ingestAgentOutput(db, b);
  assert.deepEqual((await listProductionAssets(db, b)).map((x) => x.name), ["Only B"]);
});

test("Hindi names are matched as themselves; nameKey keeps Unicode letters", () => {
  assert.equal(nameKey("  रुद्र! "), "रुद्र");
  assert.equal(nameKey("The  Monk."), "the monk");
});
