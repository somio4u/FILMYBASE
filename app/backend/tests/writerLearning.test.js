import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { ensureWriterLearningSchema, recordWriterEdit, diffWriterLines, flattenLines } from "../writerLearning.js";

test("the diff finds reworded, added and cut lines, and ignores unchanged ones", () => {
  const before = flattenLines([
    { type: "action", text: "Raju enters." },
    { type: "dialogue", character: "RAJU", text: "I shall not tolerate this." },
    { type: "dialogue", character: "MEERA", text: "Please calm down." },
  ], "en");
  const after = flattenLines([
    { type: "action", text: "Raju enters." },
    { type: "dialogue", character: "RAJU", text: "Bas. Aur nahi." },
    { type: "dialogue", character: "MEERA", text: "Please calm down." },
    { type: "dialogue", character: "MEERA", text: "Raju?" },
  ], "en");
  assert.deepEqual(diffWriterLines(before, after), [
    { type: "dialogue", character: "RAJU", before: "I shall not tolerate this.", after: "Bas. Aur nahi." },
    { type: "dialogue", character: "MEERA", before: "", after: "Raju?" },
  ]);
  assert.deepEqual(diffWriterLines(before, before), []);
  assert.deepEqual(diffWriterLines(before, before.slice(0, 2)), [{ type: "dialogue", character: "MEERA", before: "Please calm down.", after: "" }]);
});

test("lines kept as { en, hi } are read in the scene's language", () => {
  assert.deepEqual(flattenLines([{ type: "dialogue", character: "raju", line: { en: "Go.", hi: "जा।" } }], "hi"), [{ type: "dialogue", character: "RAJU", text: "जा।" }]);
});

test("edits are remembered per writer; autosave of one scene stays ONE record; a failure never throws", async () => {
  const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
  try {
    await ensureWriterLearningSchema(db);
    const uid = (await db.query("INSERT INTO users (name, username, password_hash, password_salt, role) VALUES ('Chandan T','chandan_t_wl','x','x','independent_writer') RETURNING id")).rows[0].id;
    const user = { id: uid, name: "Chandan T" };
    const before = [{ type: "dialogue", character: "RAJU", text: "I shall not tolerate this." }];
    const id1 = await recordWriterEdit(db, { user, module: "screenplay", projectRef: 1, sceneRef: 5, before, after: [{ type: "dialogue", character: "RAJU", text: "Bas." }] });
    const id2 = await recordWriterEdit(db, { user, module: "screenplay", projectRef: 1, sceneRef: 5, before: [{ type: "dialogue", character: "RAJU", text: "Bas." }], after: [{ type: "dialogue", character: "RAJU", text: "Bas. Aur nahi." }] });
    assert.equal(id1, id2, "same scene, same session: one record");
    const rows = (await db.query("SELECT pairs FROM writer_edits WHERE user_id = $1", [uid])).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].pairs, [{ type: "dialogue", character: "RAJU", before: "I shall not tolerate this.", after: "Bas. Aur nahi." }], "compared with the scene as the session began");
    assert.equal(await recordWriterEdit(db, { user, module: "screenplay", projectRef: 1, sceneRef: 6, before, after: before }), null, "no change, nothing saved");
    assert.equal(await recordWriterEdit({ query: async () => { throw new Error("db down"); } }, { user, module: "screenplay", before, after: [] }), null);
    await db.query("DELETE FROM writer_edits WHERE user_id = $1", [uid]); await db.query("DELETE FROM users WHERE id = $1", [uid]);
  } finally { await db.end(); }
});
