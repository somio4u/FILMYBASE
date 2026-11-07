// A SCRIPT DOCTOR'S REPORT (a PDF / Word file written by someone else, or by another tool) → a checklist of the changes it asks for.
//
// Reading is the only thing done here: the report is cut into parts, the AI lists the changes in each part, and the lists are joined. NOTHING in the screenplay is
// changed by reading it. The person ticks what they want; each ticked change is then given to Adu (which shows before / after and only changes the screenplay when
// the person presses Apply, with Undo).
//
// Every change carries: a kind, a short title, what to do (written so Adu can act on it alone), which scene numbers / pages the report names, and how serious the
// report says it is. Lines the report says to PROTECT are kept as "keep" items: they are handed to Adu as "must keep" so a rewrite does not lose them.
import { S, LIST, OBJ } from "./storyBrain.js";

export const KINDS = ["structure", "scene", "global", "risk", "keep"];
export const KIND_ORDER = ["structure", "scene", "global", "risk", "keep"];

const clean = (v, max) => String(v ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim().slice(0, max);

// the report's text cut into parts of about `maxChars`, at paragraph borders (a part never ends in the middle of a table row if it can be helped)
export function chunkReportText(text, maxChars = 9000) {
  // a PDF can carry hidden control characters (a NUL breaks the database): they are dropped, tabs and line breaks stay
  const paragraphs = String(text ?? "").replace(/\r/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g, "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const pieces = paragraph.length > maxChars ? paragraph.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, "g")) : [paragraph]; // one huge block is cut anywhere
    for (const piece of pieces) {
      if (current && current.length + piece.length + 2 > maxChars) { chunks.push(current); current = ""; }
      current += (current ? "\n\n" : "") + piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

const ITEM_SCHEMA = OBJ({
  kind: { type: "STRING", enum: KINDS, description: "structure = a story / plot / character / ending change that touches several scenes or adds or removes scenes; scene = a fix for named scenes (cut, trim, add a line, silence, rewrite a line); global = a pass over the whole script (strip camera directions, cut narration, one language register, remove duplicates, one voice per character); risk = a sensitivity / certification / legal note with a fix; keep = a line, scene or element the report says to PROTECT." },
  title: S("Five to ten words naming the change."),
  action: S("What to do, written as an instruction another writer can follow without reading the report: concrete, with the names, the scene numbers and the sample line or idea the report gives. For 'keep' items: the exact line or element to protect."),
  scenes: LIST({ type: "INTEGER" }, "The scene NUMBERS the report names for this change (not page numbers). Empty when it names none."),
  pages: LIST({ type: "INTEGER" }, "The page numbers the report names for this change. Empty when it names none."),
  severity: { type: "STRING", enum: ["critical", "major", "minor", "note"], description: "How serious the report says it is. 'note' when it gives none." },
});
export const REPORT_SCHEMA = OBJ({ items: LIST(ITEM_SCHEMA, "Every change asked for in this part of the report, in order.") });

export const REPORT_SYSTEM = `You read a script doctor's report about a screenplay and turn it into a checklist of the CHANGES it asks for. You change nothing yourself.
Rules:
- One item per change. Do not merge unrelated changes; do not split one change into pieces.
- Praise and scores are NOT changes. A "merits" list is not a change, EXCEPT lines or scenes the report says to keep/protect: list those as kind "keep".
- Write "action" so that someone who has not read the report can do it: say WHAT to change and HOW, use the character and place names, and copy the report's own sample line or fix when it gives one.
- Keep the report's own language and spelling for names and quoted lines (Hindi, Hinglish, Odia or English). Write the title and the action in English, but quote lines exactly as written.
- "scenes" are scene NUMBERS only when the report says "scene 63" or lists a scene number in a table; page numbers go in "pages".
- Do not invent changes the report does not ask for. A part with no changes gives an empty list.`;

export function reportPrompt(partText, partNo, parts) {
  return `This is part ${partNo} of ${parts} of the report. List every change it asks for.\n\n--- REPORT PART ${partNo} ---\n${partText}`;
}

const ints = (list) => [...new Set((Array.isArray(list) ? list : []).map((n) => Math.round(Number(n))).filter((n) => Number.isFinite(n) && n > 0 && n < 2000))].slice(0, 40);

// the AI's list -> clean items (bad kinds / empty actions dropped, lengths limited)
export function normalizeItems(raw) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const kind = KINDS.includes(r?.kind) ? r.kind : null;
    const action = clean(r?.action, 900);
    const title = clean(r?.title, 120);
    if (!kind || !action || !title) continue;
    out.push({ kind, title, action, scenes: ints(r.scenes), pages: ints(r.pages), severity: ["critical", "major", "minor", "note"].includes(r.severity) ? r.severity : "note" });
  }
  return out;
}

// joins the parts' items: the same change named twice (same kind and nearly the same title) is kept once; every item gets a number
export function joinItems(partLists) {
  const seen = new Set();
  const items = [];
  for (const list of partLists) {
    for (const item of list ?? []) {
      const key = `${item.kind}|${item.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return items.map((item, i) => ({ id: i + 1, ...item }));
}

export function groupByKind(items) {
  return KIND_ORDER.map((kind) => ({ kind, items: items.filter((i) => i.kind === kind) })).filter((g) => g.items.length > 0);
}

// the message that gives one change to Adu: what to do, which scenes, and the lines that must survive
export function instructionFor(item, keepItems = []) {
  const where = item.scenes?.length ? ` (scene${item.scenes.length === 1 ? "" : "s"} ${item.scenes.join(", ")})` : "";
  const keeps = keepItems.filter((k) => k.id !== item.id).slice(0, 8).map((k) => `“${k.action.slice(0, 120)}”`);
  return `${item.action}${where}${keeps.length ? ` — but keep these untouched: ${keeps.join("; ")}` : ""}`.slice(0, 1800);
}

// ALL the ticked changes as ONE revision request (for "a new draft from this report"): the most serious first, the structure before the scene fixes; the lines to protect
// become "must keep". Nothing is invented: every sentence is the report's own change text. Limited in size, because the whole request is read by the writers.
const SEVERITY_RANK = { critical: 0, major: 1, minor: 2, note: 3 };
export function revisionFromReport(items, selectedIds = [], { maxChars = 9000 } = {}) {
  const chosen = new Set((selectedIds ?? []).map(Number));
  const doable = (items ?? []).filter((i) => i.kind !== "keep" && (chosen.size === 0 || chosen.has(i.id)));
  const keeps = (items ?? []).filter((i) => i.kind === "keep");
  const ordered = [...doable].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.id - b.id);
  const lines = [];
  let size = 0;
  let included = 0;
  for (const item of ordered) {
    const where = item.scenes?.length ? ` [scene${item.scenes.length === 1 ? "" : "s"} ${item.scenes.join(", ")}]` : "";
    const line = `${included + 1}. (${item.severity === "note" ? item.kind : `${item.severity}, ${item.kind}`}) ${item.title}${where}: ${item.action}`;
    if (size + line.length + 1 > maxChars) break;
    lines.push(line); size += line.length + 1; included += 1;
  }
  const instruction = `Make ALL of these changes from a script doctor's report, in order of importance. Do not skip any; where two conflict, the earlier one wins.\n${lines.join("\n")}`;
  return { instruction, included, left: ordered.length - included, constraints: { mustKeep: keeps.map((k) => k.action.slice(0, 200)).slice(0, 30), mustChange: [] } };
}

// ---- storage: one row per uploaded report ---------------------------------------------------------------------------
export async function ensureReportSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS adu_report_reads (
    id SERIAL PRIMARY KEY, module TEXT NOT NULL DEFAULT 'ai_movie', project_ref INTEGER NOT NULL, user_id INTEGER, filename TEXT NOT NULL,
    chunks JSONB NOT NULL, done_chunks JSONB NOT NULL DEFAULT '[]', part_items JSONB NOT NULL DEFAULT '{}', items JSONB NOT NULL DEFAULT '[]',
    selected JSONB NOT NULL DEFAULT '[]', sent JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  // making the changes: the plan (a task per scene), the draft they are made in, and what happened to each scene
  await db.query("ALTER TABLE adu_report_reads ADD COLUMN IF NOT EXISTS apply_plan JSONB");
  await db.query("ALTER TABLE adu_report_reads ADD COLUMN IF NOT EXISTS apply_draft_id INTEGER");
  await db.query("ALTER TABLE adu_report_reads ADD COLUMN IF NOT EXISTS results JSONB NOT NULL DEFAULT '{}'");
  // a read made by the two doctors (not uploaded): their verdicts, scores and top fixes, shown at the top of Script Doctor
  await db.query("ALTER TABLE adu_report_reads ADD COLUMN IF NOT EXISTS analysis JSONB");
}

export async function savePlan(db, readId, plan, draftId) {
  await db.query("UPDATE adu_report_reads SET apply_plan = $2, apply_draft_id = $3, results = '{}' WHERE id = $1", [readId, JSON.stringify(plan), draftId]);
}
// one scene's outcome: { status: 'changed' | 'unchanged', changeSetId? }; written under a lock so two finishing at once cannot lose each other
export async function saveResult(db, readId, key, result) {
  await db.query("UPDATE adu_report_reads SET results = results || $2::jsonb WHERE id = $1", [readId, JSON.stringify({ [key]: { ...result, at: Date.now() } })]);
}
export async function markUndone(db, readId, keys) {
  const row = (await db.query("SELECT results FROM adu_report_reads WHERE id = $1 FOR UPDATE", [readId])).rows[0];
  if (!row) return;
  const next = { ...row.results };
  for (const k of keys) if (next[k]) next[k] = { ...next[k], status: "undone" };
  await db.query("UPDATE adu_report_reads SET results = $2 WHERE id = $1", [readId, JSON.stringify(next)]);
}

export async function latestReadId(db, projectRef) {
  return (await db.query("SELECT id FROM adu_report_reads WHERE project_ref = $1 ORDER BY id DESC LIMIT 1", [projectRef])).rows[0]?.id ?? null;
}

export async function createRead(db, { module = "ai_movie", projectRef, userId = null, filename, text, analysis = null }) {
  const chunks = chunkReportText(text);
  if (chunks.length === 0) throw Object.assign(new Error("I could not read any text from that file."), { status: 422 });
  const r = await db.query("INSERT INTO adu_report_reads (module, project_ref, user_id, filename, chunks, analysis) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [module, projectRef, userId, clean(filename, 200), JSON.stringify(chunks), analysis ? JSON.stringify(analysis) : null]);
  return { id: r.rows[0].id, parts: chunks.length };
}

// the job reads one part: saves that part's items, and re-joins the whole list
export async function saveParts(db, readId, partNo, items) {
  const row = (await db.query("SELECT part_items, done_chunks, chunks FROM adu_report_reads WHERE id = $1 FOR UPDATE", [readId])).rows[0];
  if (!row) return;
  const partItems = { ...row.part_items, [partNo]: items };
  const done = [...new Set([...(row.done_chunks ?? []), partNo])].sort((a, b) => a - b);
  const joined = joinItems(Array.from({ length: row.chunks.length }, (_, i) => partItems[i + 1]));
  await db.query("UPDATE adu_report_reads SET part_items = $2, done_chunks = $3, items = $4 WHERE id = $1", [readId, JSON.stringify(partItems), JSON.stringify(done), JSON.stringify(joined)]);
}

export async function getRead(db, readId, { projectRef = null } = {}) {
  const row = (await db.query("SELECT id, module, project_ref, filename, chunks, done_chunks, items, selected, sent, created_at, apply_plan, apply_draft_id, results, analysis FROM adu_report_reads WHERE id = $1", [readId])).rows[0];
  if (!row || (projectRef !== null && row.project_ref !== Number(projectRef))) return null;
  return {
    id: row.id, filename: row.filename, parts: row.chunks.length, partsDone: row.done_chunks.length, items: row.items, selected: row.selected, sent: row.sent, createdAt: row.created_at,
    groups: groupByKind(row.items), plan: row.apply_plan, applyDraftId: row.apply_draft_id, results: row.results ?? {}, analysis: row.analysis ?? null,
  };
}

export async function saveSelection(db, readId, ids, { sent = null } = {}) {
  const row = (await db.query("SELECT items FROM adu_report_reads WHERE id = $1", [readId])).rows[0];
  if (!row) return null;
  const valid = new Set(row.items.map((i) => i.id));
  const selected = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((id) => valid.has(id)))];
  if (sent) {
    const marked = (await db.query("SELECT sent FROM adu_report_reads WHERE id = $1", [readId])).rows[0].sent;
    const now = [...new Set([...(marked ?? []), ...sent.map(Number).filter((id) => valid.has(id))])];
    await db.query("UPDATE adu_report_reads SET selected = $2, sent = $3 WHERE id = $1", [readId, JSON.stringify(selected), JSON.stringify(now)]);
  } else await db.query("UPDATE adu_report_reads SET selected = $2 WHERE id = $1", [readId, JSON.stringify(selected)]);
  return selected;
}
