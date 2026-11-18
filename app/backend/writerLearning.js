// STEP 1 of "the agent that learns each writer's style": it only WATCHES and REMEMBERS.
// Every time a writer (Chandan, or anyone the admin assigns later) changes a line of the screenplay by hand, we keep the pair:
// what was there before (usually the AI's line) and what the writer made of it. Nothing is learned or changed here yet — the pairs are the
// training material for the next steps (a style page per writer, then writer agents that write in that style).
// Saving a pair NEVER blocks or fails the writer's save: any problem in here is swallowed and logged.

export async function ensureWriterLearningSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS writer_edits (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_name TEXT,
    module TEXT NOT NULL,               -- 'screenplay' (Story & Screenplay) | 'ai_movie'
    project_ref INTEGER,                -- scene list id (screenplay) or AI Movie project id
    scene_ref TEXT,                     -- which scene (id or beat/scene position)
    language TEXT,
    pairs JSONB NOT NULL,               -- [{ type, character, before, after }]
    before_lines JSONB,                 -- the scene as it was when this editing session began
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query("ALTER TABLE writer_edits ADD COLUMN IF NOT EXISTS before_lines JSONB");
  await db.query("ALTER TABLE writer_edits ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()");
  await db.query("CREATE INDEX IF NOT EXISTS writer_edits_user_idx ON writer_edits (user_id, created_at DESC)");
}

// one line of text, whatever shape the screen keeps it in (plain text, or { en, hi, or })
const plain = (v, language) => {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") return String(v[language] ?? v.en ?? v.hi ?? v.or ?? Object.values(v).find((x) => typeof x === "string") ?? "").trim();
  return "";
};

// a scene's lines as a flat list: { type: 'dialogue' | 'action', character, text }
export function flattenLines(items, language) {
  return (Array.isArray(items) ? items : []).map((b) => {
    if (b?.type === "dialogue") return { type: "dialogue", character: plain(b.character).toUpperCase(), text: plain(b.line ?? b.text, language) };
    if (b?.type === "action" || b?.type === "flashback") return { type: "action", character: "", text: plain(b.text, language) };
    return null;
  }).filter((l) => l && l.text);
}

// What the writer changed: lines that were reworded (matched by position among lines of the same kind and speaker) and lines they added or removed.
export function diffWriterLines(beforeLines, afterLines) {
  const pairs = [];
  const used = new Set();
  const key = (l) => `${l.type}|${l.character}`;
  const pools = new Map();
  beforeLines.forEach((l, i) => { if (!pools.has(key(l))) pools.set(key(l), []); pools.get(key(l)).push(i); });
  afterLines.forEach((a, i) => {
    const pool = pools.get(key(a)) ?? [];
    // an unchanged line uses up its original; otherwise the nearest unused original of the same speaker is the one that was reworded
    const same = pool.find((j) => !used.has(j) && beforeLines[j].text === a.text);
    if (same !== undefined) { used.add(same); return; }
    const near = pool.filter((j) => !used.has(j)).sort((x, y) => Math.abs(x - i) - Math.abs(y - i))[0];
    if (near !== undefined) { used.add(near); pairs.push({ type: a.type, character: a.character, before: beforeLines[near].text, after: a.text }); }
    else pairs.push({ type: a.type, character: a.character, before: "", after: a.text }); // a line the writer added
  });
  beforeLines.forEach((b, j) => { if (!used.has(j)) pairs.push({ type: b.type, character: b.character, before: b.text, after: "" }); }); // a line the writer cut
  return pairs.slice(0, 200);
}

export async function recordWriterEdit(db, { user, module, projectRef, sceneRef, language = "en", before, after }) {
  try {
    if (!user?.id) return null;
    const after_ = flattenLines(after, language);
    // Autosave sends the scene again and again while the writer types: one editing session of one scene (30 minutes) stays ONE record,
    // always compared with the scene as it was when the session began — not a row per keystroke.
    const ref = sceneRef == null ? null : String(sceneRef);
    const open = (await db.query(
      "SELECT id, before_lines FROM writer_edits WHERE user_id = $1 AND module = $2 AND project_ref IS NOT DISTINCT FROM $3 AND scene_ref IS NOT DISTINCT FROM $4 AND updated_at > now() - interval '30 minutes' ORDER BY id DESC LIMIT 1",
      [user.id, module, projectRef ?? null, ref]
    )).rows[0];
    const beforeLines = open?.before_lines ?? flattenLines(before, language);
    const pairs = diffWriterLines(beforeLines, after_);
    if (open) {
      await db.query("UPDATE writer_edits SET pairs = $2, updated_at = now() WHERE id = $1", [open.id, JSON.stringify(pairs)]);
      return open.id;
    }
    if (pairs.length === 0) return null;
    const row = (await db.query(
      "INSERT INTO writer_edits (user_id, user_name, module, project_ref, scene_ref, language, pairs, before_lines) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [user.id, user.name ?? null, module, projectRef ?? null, ref, language, JSON.stringify(pairs), JSON.stringify(beforeLines)]
    )).rows[0];
    return row.id;
  } catch (error) {
    console.error("Could not remember a writer's edit (the save itself was fine):", error.message);
    return null;
  }
}
