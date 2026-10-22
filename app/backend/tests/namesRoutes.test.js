// Names & places routes against the real dev database (skipped when it is not reachable): a temporary scene list, a bare express app, a fake admin.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { ensureSmartSchedulerSchema, registerSmartSchedulerRoutes } from "../smartScheduler.js";
import { ensureLocationRenameSchema, registerLocationRenameRoutes } from "../locationRename.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
let up = true;
try { await db.query("SELECT 1"); } catch { up = false; }

test("merge places and characters, plan uses one name, rename in the screenplay and undo", { skip: !up }, async () => {
  await db.query("CREATE TABLE IF NOT EXISTS auto_pipeline_runs (id SERIAL PRIMARY KEY, scene_list_id INTEGER, status TEXT)").catch(() => {});
  await db.query("ALTER TABLE auto_pipeline_runs ADD COLUMN IF NOT EXISTS scene_list_id INTEGER");
  await ensureSmartSchedulerSchema(db);
  await ensureLocationRenameSchema(db);
  const content = { scenes: [
    { sceneNumber: "1", intExt: "INT", location: { en: "Temple Sanctum" }, timeOfDay: "DAY", estimatedMinutes: 2, oneLiner: { en: "a" } },
    { sceneNumber: "2", intExt: "EXT", location: { en: "Temple Exterior" }, timeOfDay: "DAY", estimatedMinutes: 2, oneLiner: { en: "b" } },
    { sceneNumber: "3", intExt: "INT", location: { en: "Temple" }, timeOfDay: "NIGHT", estimatedMinutes: 2, oneLiner: { en: "c" } },
    { sceneNumber: "4", intExt: "INT", location: { en: "Clinic" }, timeOfDay: "DAY", estimatedMinutes: 2, oneLiner: { en: "d" } },
  ] };
  const id = (await db.query("INSERT INTO scene_lists (content, status) VALUES ($1, 'approved') RETURNING id", [JSON.stringify(content)])).rows[0].id;
  const write = (i, names) => db.query("INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content, status) VALUES ($1, NULL, $2, $3, 'approved')", [id, i, JSON.stringify({ elements: [{ type: "dialogue", character: names[0], text: "hi" }], charactersPresent: names })]);
  await write(0, ["SOUMYA"]); await write(1, ["SAUMIA"]); await write(2, ["SOUMYA", "SAUMIA"]); await write(3, ["RAVI"]);

  const app = express();
  app.use(express.json());
  const requireRole = () => (req, res, next) => { req.user = { id: 1 }; next(); };
  registerSmartSchedulerRoutes(app, db, { requireRole, askModel: async () => ({}) });
  registerLocationRenameRoutes(app, db, { requireRole });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    let n = (await call("GET", `/api/smart-scheduler/${id}/names`)).body;
    assert.deepEqual(n.locations.map((l) => l.name).sort(), ["CLINIC", "TEMPLE", "TEMPLE SANCTUM"]); // Sanctum stays its own name until merged; Exterior folds into TEMPLE (in/out words are not part of a place)
    assert.ok(n.suggestions.artist.some((g) => g.includes("SAUMIA") && g.includes("SOUMYA")));
    assert.ok(n.suggestions.location.some((g) => g.includes("TEMPLE") && g.includes("TEMPLE SANCTUM")));

    // a saved category on a member moves to the final name
    await call("PUT", `/api/smart-scheduler/${id}/brief`, { days: 3, artists: { SAUMIA: "costly" }, locations: {} });
    assert.equal((await call("POST", `/api/smart-scheduler/${id}/names/merge`, { kind: "artist", names: ["SAUMIA", "SOUMYA"], canonical: "SOUMYA" })).status, 200);
    const b = (await call("GET", `/api/smart-scheduler/${id}/brief`)).body;
    assert.deepEqual(b.artists.map((a) => [a.name, a.category]).sort(), [["RAVI", "normal"], ["SOUMYA", "costly"]]);
    assert.equal(b.artists.find((a) => a.name === "SOUMYA").scenes, 3);
    n = (await call("GET", `/api/smart-scheduler/${id}/names`)).body;
    assert.equal(n.suggestions.artist.length, 0); // already merged: no more suggestion
    assert.equal(n.artists.find((a) => a.name === "SAUMIA").mergedInto, "SOUMYA");

    assert.equal((await call("POST", `/api/smart-scheduler/${id}/names/merge`, { kind: "location", names: ["TEMPLE SANCTUM"], canonical: "TEMPLE" })).status, 200);
    assert.equal((await call("POST", `/api/smart-scheduler/${id}/names/merge`, { kind: "artist", names: ["SOUMYA"], canonical: "SOUMYA" })).status, 400);

    // split brings the name back
    await call("POST", `/api/smart-scheduler/${id}/names/split`, { kind: "artist", name: "SAUMIA" });
    assert.equal((await call("GET", `/api/smart-scheduler/${id}/brief`)).body.artists.length, 3);
    await call("POST", `/api/smart-scheduler/${id}/names/dismiss`, { kind: "artist", names: ["SAUMIA", "SOUMYA"] });
    assert.equal((await call("GET", `/api/smart-scheduler/${id}/names`)).body.suggestions.artist.length, 0);

    // screenplay: preview counts, apply changes, undo restores
    const body = { names: ["TEMPLE SANCTUM", "TEMPLE"], to: "TEMPLE" };
    const pv = (await call("POST", `/api/scene-lists/${id}/rename-location`, { ...body, preview: true })).body;
    assert.equal(pv.scenes, 3);
    assert.equal((await db.query("SELECT content FROM scene_lists WHERE id = $1", [id])).rows[0].content.scenes[0].location.en, "Temple Sanctum");
    const ap = (await call("POST", `/api/scene-lists/${id}/rename-location`, body)).body;
    assert.deepEqual(ap.sceneList.scenes.map((s) => s.location.en), ["TEMPLE", "TEMPLE", "TEMPLE", "Clinic"]);
    assert.deepEqual(ap.sceneList.scenes.map((s) => s.intExt), ["INT", "EXT", "INT", "INT"]);
    const latest = (await call("GET", `/api/scene-lists/${id}/rename-location/latest`)).body.latest;
    assert.equal(latest.scenes, 3);
    const un = (await call("POST", `/api/scene-lists/${id}/rename-location/${latest.id}/undo`)).body;
    assert.equal(un.restored, 3);
    assert.equal(un.sceneList.scenes[1].location.en, "Temple Exterior");
    assert.equal((await call("POST", `/api/scene-lists/${id}/rename-location/${latest.id}/undo`)).status, 404);
  } finally {
    server.close();
    await db.query("DELETE FROM screenplay_scenes WHERE scene_list_id = $1", [id]);
    for (const t of ["scheduler_briefs", "scheduler_name_map", "scheduler_name_dismissed", "location_rename_backups"]) await db.query(`DELETE FROM ${t} WHERE scene_list_id = $1`, [id]);
    await db.query("DELETE FROM scene_lists WHERE id = $1", [id]);
    await db.end();
  }
});
