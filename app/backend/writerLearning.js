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
  // a written description of a writer's style (made by reading drafts side by side); used together with the pairs
  await db.query(`CREATE TABLE IF NOT EXISTS writer_style_cards (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    card TEXT NOT NULL,
    source TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
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

// ---- STEP 2: USING what was learned ----
// The style of the person who is working is added to every screenplay / dialogue writing prompt (writingStyleGuide.js reads it from here).
// It is made of that writer's OWN corrections: "the AI wrote X, the writer made it Y". The AI is shown the most recent ones and writes the next scenes in that voice.
import { AsyncLocalStorage } from "node:async_hooks";

const styleStore = new AsyncLocalStorage();
export const currentWriterStyle = () => styleStore.getStore()?.block ?? "";
export const runWithWriterStyle = (block, fn) => styleStore.run({ block }, fn);

export const MIN_STYLE_EXAMPLES = 5;   // fewer rewrites than this and there is nothing reliable to learn yet
const MAX_DIALOGUE_EXAMPLES = 12, MAX_ACTION_EXAMPLES = 4;
const clip = (t, n) => { const s = String(t ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

export function buildStyleBlock(name, rows, card = "", { examples = MAX_DIALOGUE_EXAMPLES, header = true } = {}) {
  const dialogue = [], action = [];
  for (const r of rows) for (const p of r.pairs ?? []) {
    if (!p.after || (p.before && p.before.trim() === p.after.trim())) continue; // only rewrites (and lines the writer added) teach a style
    (p.type === "dialogue" ? dialogue : action).push(p);
  }
  const real = [...dialogue, ...action].filter((p) => p.before).length;
  // a written style card is enough on its own; without one, we wait for enough real rewrites
  if (!card && real < MIN_STYLE_EXAMPLES) return "";
  const who = name || "the writer";
  const line = (p) => (p.before
    ? `- ${p.character ? `${p.character}: ` : ""}AI wrote: "${clip(p.before, 160)}"  →  ${who} made it: "${clip(p.after, 160)}"`
    : `- ${p.character ? `${p.character}: ` : ""}${who} added: "${clip(p.after, 160)}"`);
  const rewrites = dialogue.filter((p) => p.before), added = dialogue.filter((p) => !p.before);
  return [
    header
      ? `THIS WRITER'S OWN STYLE — ${who}. Write like ${who}: the same word choice, line length, tone, humour and way of showing feeling. Study the style description and the examples ("AI wrote" → the writer's version), and apply what changed to NEW lines. Never copy these lines into the film, and never let this change the story, the characters or the events.`
      : `— THE STYLE OF ${String(who).toUpperCase()} —`,
    ...(card ? [String(card).trim()] : []),
    ...rewrites.slice(0, examples).map(line),
    ...added.slice(0, 4).map(line),
    ...action.filter((p) => p.before).slice(0, MAX_ACTION_EXAMPLES).map(line),
  ].join("\n");
}

export async function styleBlockFor(db, user) {
  try {
    if (!user?.id) return "";
    const rows = (await db.query("SELECT pairs FROM writer_edits WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 40", [user.id])).rows;
    const card = (await db.query("SELECT card FROM writer_style_cards WHERE user_id = $1", [user.id])).rows[0]?.card ?? "";
    return buildStyleBlock(user.name, rows, card);
  } catch (error) {
    console.error("Could not read a writer's style (writing goes on without it):", error.message);
    return "";
  }
}

// ---- TEAM STYLE: a project can be written with the style of ALL our writers, whoever is logged in ----
const TEAM_PER_WRITER_EXAMPLES = 6, TEAM_MAX_WRITERS = 6;

export function buildTeamStyleBlock(writers) {
  const parts = writers.map(({ name, rows, card }) => buildStyleBlock(name, rows, card, { examples: TEAM_PER_WRITER_EXAMPLES, header: false })).filter(Boolean);
  if (!parts.length) return "";
  return [
    `THE TEAM'S WRITING STYLES — this project is written with the learned style of ALL its dialogue and screenplay writers (${writers.filter((w, i) => parts[i]).map((w) => w.name).join(", ")}). Use what is strongest in each of them, and keep every CHARACTER's own voice distinct: do not make everybody speak like one writer. Never copy the example lines, and never let any of this change the story, the characters or the events.`,
    ...parts,
  ].join("\n\n");
}

export async function teamStyleBlock(db) {
  try {
    const users = (await db.query(
      `SELECT u.id, u.name FROM users u WHERE EXISTS (SELECT 1 FROM writer_style_cards c WHERE c.user_id = u.id) OR EXISTS (SELECT 1 FROM writer_edits e WHERE e.user_id = u.id)
       ORDER BY u.id LIMIT ${TEAM_MAX_WRITERS}`)).rows;
    const writers = [];
    for (const u of users) {
      const rows = (await db.query("SELECT pairs FROM writer_edits WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 40", [u.id])).rows;
      const card = (await db.query("SELECT card FROM writer_style_cards WHERE user_id = $1", [u.id])).rows[0]?.card ?? "";
      writers.push({ name: u.name, rows, card });
    }
    return buildTeamStyleBlock(writers);
  } catch (error) {
    console.error("Could not read the team's style (writing goes on without it):", error.message);
    return "";
  }
}

// the AI Movie project a request is about (path, body or query)
export const projectIdOfRequest = (req) => {
  const m = /^\/api\/ai-movie\/projects\/(\d+)(?:\/|$)/.exec(req.path ?? "");
  const id = Number(m?.[1] ?? req.body?.projectId ?? req.query?.projectId);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// Express middleware: finds the style for this request — the team's, if the AI Movie project asks for it, else that of whoever is asking — and keeps it
// for everything this request (and the background work it starts) writes.
export const writerStyleMiddleware = (db) => async (req, res, next) => {
  if (!req.user || !/^\/api\/(screenplay|ai-movie|scene-lists|assistant|pitch-deck|generate|skip|draft)/.test(req.path)) { next(); return; }
  let block = "";
  const projectId = req.path.startsWith("/api/ai-movie") ? projectIdOfRequest(req) : null;
  if (projectId) {
    const team = (await db.query("SELECT team_style FROM ai_movie_projects WHERE id = $1", [projectId]).catch(() => ({ rows: [] }))).rows[0]?.team_style === true;
    if (team) block = await teamStyleBlock(db);
  }
  if (!block) block = await styleBlockFor(db, req.user);
  if (!block) { next(); return; }
  runWithWriterStyle(block, next);
};

// Gives a writer a style that was worked out from drafts (a written card + before/after pairs). Safe to run again: it replaces the earlier import of the same writer.
export async function importWriterStyle(db, userId, { card, pairs = [], source = "import" }) {
  const user = (await db.query("SELECT id, name FROM users WHERE id = $1", [userId])).rows[0];
  if (!user) throw Object.assign(new Error("No such login."), { status: 404 });
  await db.query("DELETE FROM writer_edits WHERE user_id = $1 AND module = 'import'", [userId]);
  const clean = (pairs ?? []).filter((p) => p && typeof p.after === "string" && p.after.trim()).slice(0, 200)
    .map((p) => ({ type: p.type === "action" ? "action" : "dialogue", character: String(p.character ?? ""), before: String(p.before ?? ""), after: String(p.after) }));
  if (clean.length) await db.query("INSERT INTO writer_edits (user_id, user_name, module, language, pairs) VALUES ($1,$2,'import','or',$3)", [userId, user.name, JSON.stringify(clean)]);
  if (card) await db.query("INSERT INTO writer_style_cards (user_id, card, source) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET card = EXCLUDED.card, source = EXCLUDED.source, updated_at = now()", [userId, String(card), source]);
  return { userId, name: user.name, pairs: clean.length, card: Boolean(card) };
}

// Styles worked out from drafts that belong to ONE exact login. At every start: if that login exists and has no style card yet, it gets the ready-made one.
// (Only when there is no card, so a style the admin changes later is never overwritten by a restart.)
// "kumar" = "kumar bro" (the writer who edited Maha Kali); "script" = the new "Kumar" login the owner made for him to write on his own.
export const STYLE_SEEDS = [{ username: "kumar", seed: "kumar" }, { username: "script", seed: "kumar" }];

export async function applyStyleSeeds(db, readSeed, seeds = STYLE_SEEDS) {
  const done = [];
  for (const { username, seed } of seeds) {
    try {
      const user = (await db.query("SELECT id FROM users WHERE lower(username) = $1", [username])).rows[0];
      if (!user) continue;
      if ((await db.query("SELECT 1 FROM writer_style_cards WHERE user_id = $1", [user.id])).rows.length) continue;
      done.push(await importWriterStyle(db, user.id, await readSeed(seed)));
    } catch (error) {
      console.error(`Could not give "${username}" the ready-made style (nothing else is affected):`, error.message);
    }
  }
  return done;
}
