// The REAL startup sequence (productionSchema.js) on a completely blank
// database. Unit tests build their tables by hand in a lucky order; this one
// proves the order the server actually uses works from nothing, twice.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { ensureAllProductionSchemas } from "../productionSchema.js";

const conn = { user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" };
const NAME = "schema_order_scratch";
let admin, scratch;

test.before(async () => {
  admin = new pg.Pool({ ...conn, database: "postgres" });
  await admin.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin.query(`CREATE DATABASE ${NAME}`);
  scratch = new pg.Pool({ ...conn, database: NAME });
  // the only table the production tables expect to already exist
  await scratch.query("CREATE TABLE ai_movie_projects (id SERIAL PRIMARY KEY, title TEXT, assets JSONB, stage_status JSONB DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT now())");
});
test.after(async () => {
  await scratch.end();
  await admin.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin.end();
});

test("from a blank database every production table is created with no failures, and re-running is harmless", async () => {
  const logged = [];
  const failures = await ensureAllProductionSchemas(scratch, (...a) => logged.push(a.join(" ")));
  assert.deepEqual(failures, [], logged.join("\n"));
  const again = await ensureAllProductionSchemas(scratch, () => {});
  assert.deepEqual(again, []);
  const tables = (await scratch.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.table_name);
  for (const t of [
    "production_agent_imports", "production_assets", "production_issues", "production_audit_events",
    "production_media_files", "production_drive_folders", "production_drive_tokens",
    "production_design_tasks", "production_task_comments",
    "production_design_submissions", "production_submission_files",
  ]) assert.ok(tables.includes(t), `missing table ${t}`);
});

test("deleting a project removes its production records (no foreign key blocks the existing delete-project button)", async () => {
  const pid = (await scratch.query("INSERT INTO ai_movie_projects (title) VALUES ('x') RETURNING id")).rows[0].id;
  const media = (await scratch.query(
    "INSERT INTO production_media_files (project_id, role, backend, stored_name, mime, bytes, sha256) VALUES ($1,'design','local','a.png','image/png',10,'abc') RETURNING id", [pid])).rows[0].id;
  const asset = (await scratch.query(
    "INSERT INTO production_assets (project_id, kind, code, name, name_key) VALUES ($1,'prop','PROP001','Pot','pot') RETURNING id", [pid])).rows[0].id;
  const task = (await scratch.query(
    "INSERT INTO production_design_tasks (project_id, asset_id, code, brief, brief_asset_revision, brief_imported_revision) VALUES ($1,$2,'TASK001','{}',1,1) RETURNING id", [pid, asset])).rows[0].id;
  const sub = (await scratch.query("INSERT INTO production_design_submissions (project_id, task_id, version_no) VALUES ($1,$2,1) RETURNING id", [pid, task])).rows[0].id;
  await scratch.query("INSERT INTO production_submission_files (submission_id, media_id) VALUES ($1,$2)", [sub, media]);
  await scratch.query("DELETE FROM ai_movie_projects WHERE id = $1", [pid]);
  for (const t of ["production_media_files", "production_assets", "production_design_tasks", "production_design_submissions", "production_submission_files"]) {
    assert.equal(Number((await scratch.query(`SELECT count(*) FROM ${t}`)).rows[0].count), 0, t);
  }
});
