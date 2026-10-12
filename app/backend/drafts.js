// Draft Management for Film and AI Movie projects.
//
// A PROJECT is a group of DRAFTS. Every draft is a full, independent project row (a Film `concepts` chain, or an `ai_movie_projects`
// row), so everything that already hangs off a project row — stages, approvals, the Production Dossier, shots, generated media,
// timeline — belongs to exactly one draft and can never be touched by another draft. Making Draft 2 COPIES Draft 1's content into a
// new row (copy-on-write); Draft 1 is never modified. All existing screens and routes keep working on whichever draft is open.
//
//   project_draft_groups   one per project: which draft was used last
//   project_drafts         one per draft: number, lineage (parent), status, saved stage, resume context, label
//   draft_revision_requests / draft_change_sets  the agent's work (see draftAgent.js)
//
// Film and AI Movie are kept apart (module column): a Film draft only ever points at a Film concept, an AI Movie draft at an AI Movie project.

import { createHash } from "node:crypto";
import { flatten } from "./workspaceContext.js";
import { publish } from "./events.js";

export const httpError = (message, status = 400, code = "bad_request") => Object.assign(new Error(message), { status, code });
export const MODULES = ["film", "ai_movie"];
export const STATUSES = ["working", "pending_approval", "approved", "locked", "archived"];
const EDITABLE = new Set(["working", "pending_approval", "approved"]); // locked and archived drafts refuse edits (approved needs a confirmation)

export async function ensureDraftSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS project_draft_groups (
      id SERIAL PRIMARY KEY,
      module TEXT NOT NULL CHECK (module IN ('film','ai_movie')),
      active_draft_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS project_drafts (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES project_draft_groups(id) ON DELETE CASCADE,
      module TEXT NOT NULL CHECK (module IN ('film','ai_movie')),
      project_ref INTEGER NOT NULL,
      draft_number INTEGER,
      kind TEXT NOT NULL DEFAULT 'numbered' CHECK (kind IN ('numbered','alternative')),
      label TEXT,
      parent_draft_id INTEGER REFERENCES project_drafts(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'working' CHECK (status IN ('working','pending_approval','approved','locked','archived')),
      current_stage TEXT,
      resume_context JSONB NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      source_screenplay_version INTEGER,
      approval JSONB,
      note TEXT,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_opened_at TIMESTAMPTZ,
      UNIQUE (module, project_ref)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS project_drafts_number ON project_drafts (group_id, draft_number) WHERE draft_number IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS draft_revision_requests (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES project_draft_groups(id) ON DELETE CASCADE,
      module TEXT NOT NULL,
      parent_draft_id INTEGER REFERENCES project_drafts(id) ON DELETE SET NULL,
      draft_id INTEGER REFERENCES project_drafts(id) ON DELETE SET NULL,
      intent TEXT NOT NULL,
      instruction TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'text',
      constraints JSONB NOT NULL DEFAULT '{}',
      context JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'proposed',
      impact_map JSONB,
      proposal JSONB,
      decisions JSONB NOT NULL DEFAULT '[]',
      error TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS draft_change_sets (
      id SERIAL PRIMARY KEY,
      draft_id INTEGER NOT NULL REFERENCES project_drafts(id) ON DELETE CASCADE,
      request_id INTEGER REFERENCES draft_revision_requests(id) ON DELETE SET NULL,
      intent TEXT NOT NULL,
      instruction TEXT NOT NULL,
      scope JSONB NOT NULL DEFAULT '{}',
      edits JSONB NOT NULL,
      base_fingerprint TEXT,
      status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','applied','undone','rejected','stale')),
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS draft_change_sets_draft ON draft_change_sets (draft_id, id DESC)`,
  ];
  for (const sql of statements) await db.query(sql);
}

const rowView = (r) => ({
  id: r.id, groupId: r.group_id, module: r.module, projectRef: r.project_ref, draftNumber: r.draft_number, kind: r.kind, label: r.label,
  title: r.label ?? (r.draft_number ? `Draft ${r.draft_number}` : "Alternative"), parentDraftId: r.parent_draft_id, status: r.status, currentStage: r.current_stage,
  resumeContext: r.resume_context ?? {}, revision: r.revision, sourceScreenplayVersion: r.source_screenplay_version, approval: r.approval, note: r.note,
  createdAt: r.created_at, updatedAt: r.updated_at, lastOpenedAt: r.last_opened_at,
});

// ---------------------------------------------------------------------------
// Project rows (the only place that knows how each module stores a project)
// ---------------------------------------------------------------------------
async function projectExists(db, module, ref) {
  const table = module === "film" ? "concepts" : "ai_movie_projects";
  return (await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [ref])).rowCount > 0;
}
async function projectTitle(db, module, ref) {
  if (module === "film") { const r = (await db.query("SELECT title, concept_text FROM concepts WHERE id = $1", [ref])).rows[0]; return r ? (r.title || r.concept_text.slice(0, 60)) : null; }
  const r = (await db.query("SELECT title, pasted_text FROM ai_movie_projects WHERE id = $1", [ref])).rows[0];
  return r ? (r.title || r.pasted_text.slice(0, 60)) : null;
}

// Where a project really is, worked out from what exists (the same rule the screens use).
export async function detectStage(db, module, ref) {
  if (module === "ai_movie") {
    const p = (await db.query("SELECT stage_status, backfill FROM ai_movie_projects WHERE id = $1", [ref])).rows[0];
    if (!p) return { stage: null, approved: false };
    const order = ["story", "synopsis", "characterArc", "threeAct", "plot", "screenplay"];
    const st = p.stage_status ?? {};
    const current = order.find((k) => !st[k] || st[k].status !== "approved") ?? "screenplay";
    return { stage: current, approved: st.screenplay?.status === "approved" };
  }
  const deck = (await db.query("SELECT id, status FROM pitch_decks WHERE concept_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [ref])).rows[0];
  if (!deck) return { stage: "idea", approved: false };
  if (deck.status !== "approved") return { stage: "synopsis", approved: false };
  const sheet = (await db.query("SELECT status FROM character_sheets WHERE pitch_deck_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [deck.id])).rows[0];
  if (sheet?.status !== "approved") return { stage: "characters", approved: false };
  const act = (await db.query("SELECT id FROM three_act_structures WHERE pitch_deck_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [deck.id])).rows[0];
  const bits = act ? (await db.query("SELECT status FROM bit_sheets WHERE three_act_structure_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [act.id])).rows[0] : null;
  if (bits?.status !== "approved") return { stage: "bitsheet", approved: false };
  const list = (await db.query("SELECT status FROM scene_lists WHERE bit_sheet_id IN (SELECT id FROM bit_sheets WHERE three_act_structure_id = $1) ORDER BY created_at DESC, id DESC LIMIT 1", [act.id])).rows[0];
  return { stage: "screenplay", approved: list?.status === "approved" };
}

// ---------------------------------------------------------------------------
// Groups and drafts
// ---------------------------------------------------------------------------
// Every existing project is Draft 1 of its own project, automatically, with no data change. Safe to call any time.
export async function ensureDraftFor(db, module, ref, { actorUserId = null } = {}) {
  if (!MODULES.includes(module)) throw httpError("Unknown module.", 400);
  const found = (await db.query("SELECT * FROM project_drafts WHERE module = $1 AND project_ref = $2", [module, ref])).rows[0];
  if (found) return found;
  if (!(await projectExists(db, module, ref))) throw httpError("Project not found.", 404, "not_found");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [900000 + ref + (module === "film" ? 0 : 500000)]);
    const again = (await client.query("SELECT * FROM project_drafts WHERE module = $1 AND project_ref = $2", [module, ref])).rows[0];
    if (again) { await client.query("COMMIT"); return again; }
    const group = (await client.query("INSERT INTO project_draft_groups (module) VALUES ($1) RETURNING id", [module])).rows[0];
    const where = await detectStage(client, module, ref);
    const row = (await client.query(
      `INSERT INTO project_drafts (group_id, module, project_ref, draft_number, kind, status, current_stage, created_by) VALUES ($1,$2,$3,1,'numbered',$4,$5,$6) RETURNING *`,
      [group.id, module, ref, where.approved ? "approved" : "working", where.stage, actorUserId]
    )).rows[0];
    await client.query("UPDATE project_draft_groups SET active_draft_id = $2 WHERE id = $1", [group.id, row.id]);
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Gives every project that has no draft record its Draft 1. Run at startup; harmless to repeat.
export async function backfillDrafts(db) {
  let made = 0;
  for (const [module, table] of [["film", "concepts"], ["ai_movie", "ai_movie_projects"]]) {
    const exists = (await db.query("SELECT to_regclass($1) AS t", [table])).rows[0].t;
    if (!exists) continue;
    const missing = (await db.query(`SELECT t.id FROM ${table} t WHERE NOT EXISTS (SELECT 1 FROM project_drafts d WHERE d.module = $1 AND d.project_ref = t.id)`, [module])).rows;
    for (const m of missing) { await ensureDraftFor(db, module, m.id); made++; }
  }
  return made;
}

async function groupDrafts(db, groupId) {
  const rows = (await db.query("SELECT * FROM project_drafts WHERE group_id = $1 ORDER BY COALESCE(draft_number, 1000000 + id), id", [groupId])).rows;
  const alive = [];
  for (const r of rows) if (await projectExists(db, r.module, r.project_ref)) alive.push(r);
  return alive;
}

// The Draft Dashboard for a project: every draft (and alternative) with lineage, status and where it stopped.
export async function getDashboard(db, module, projectRef, { actorUserId = null } = {}) {
  const me = await ensureDraftFor(db, module, projectRef, { actorUserId });
  const group = (await db.query("SELECT * FROM project_draft_groups WHERE id = $1", [me.group_id])).rows[0];
  const rows = await groupDrafts(db, me.group_id);
  const drafts = [];
  for (const r of rows) {
    const live = await detectStage(db, r.module, r.project_ref);
    const pending = (await db.query("SELECT id, intent, status FROM draft_revision_requests WHERE draft_id = $1 AND status NOT IN ('completed','cancelled','failed') ORDER BY id DESC LIMIT 1", [r.id])).rows[0] ?? null;
    drafts.push({
      ...rowView(r), title: rowView(r).title, workStage: live.stage, screenplayApproved: live.approved, projectTitle: await projectTitle(db, r.module, r.project_ref),
      openRequest: pending ? { id: pending.id, intent: pending.intent, status: pending.status } : null,
      childCount: rows.filter((x) => x.parent_draft_id === r.id).length,
    });
  }
  return { groupId: group.id, module, activeDraftId: group.active_draft_id, drafts, requestedProjectRef: projectRef };
}

export async function getDraft(db, draftId) {
  const row = (await db.query("SELECT * FROM project_drafts WHERE id = $1", [draftId])).rows[0];
  if (!row) throw httpError("Draft not found.", 404, "not_found");
  return row;
}

// ---------------------------------------------------------------------------
// Branching: copy a draft into a NEW project row. The parent is only read.
// ---------------------------------------------------------------------------
async function commonColumns(client, table, skip) {
  return (await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = current_schema() ORDER BY ordinal_position", [table])).rows
    .map((r) => r.column_name).filter((c) => !skip.includes(c));
}
async function copyRow(client, table, id, overrides, skip = ["id"]) {
  const cols = await commonColumns(client, table, skip);
  const names = cols.filter((c) => !(c in overrides));
  const extra = Object.keys(overrides).filter((c) => cols.includes(c));
  const all = [...names, ...extra];
  const sel = [...names, ...extra.map((c, i) => `$${i + 2}`)];
  const r = await client.query(`INSERT INTO ${table} (${all.join(", ")}) SELECT ${sel.join(", ")} FROM ${table} WHERE id = $1 RETURNING id`, [id, ...extra.map((c) => overrides[c])]);
  return r.rows[0]?.id ?? null;
}

async function copyAiMovie(client, parentRef, { title, actorUserId }) {
  const p = (await client.query("SELECT id, backfill FROM ai_movie_projects WHERE id = $1 FOR SHARE", [parentRef])).rows[0];
  if (!p) throw httpError("The draft's project no longer exists.", 404, "not_found");
  const backfill = p.backfill ? JSON.parse(JSON.stringify(p.backfill)) : p.backfill;
  if (backfill) {
    delete backfill.scriptCheck; // a running check belongs to the parent only
    for (const b of backfill.screenplayBeats ?? []) if (b && b.status === "generating") { b.status = b.scenes?.length ? "pending" : "not_started"; delete b.generatingSince; }
  }
  const newId = await copyRow(client, "ai_movie_projects", parentRef, { title, backfill: JSON.stringify(backfill), created_by: actorUserId, story_bible_job: null, cinematic_job: null, created_at: new Date(), updated_at: new Date() });
  for (const table of ["ai_movie_reference_files", "ai_movie_screenplay_translations"]) {
    const exists = (await client.query("SELECT to_regclass($1) AS t", [table])).rows[0].t;
    if (!exists) continue;
    // child tables are copied wholesale (some have no id column): same columns, project_id swapped for the new project
    const cols = await commonColumns(client, table, ["id"]);
    const list = cols.join(", ");
    const sel = cols.map((c) => (c === "project_id" ? "$2" : c)).join(", ");
    await client.query(`INSERT INTO ${table} (${list}) SELECT ${sel} FROM ${table} WHERE project_id = $1`, [parentRef, newId]);
  }
  return newId;
}

async function copyFilm(client, parentRef, { title, actorUserId }) {
  const c = (await client.query("SELECT id FROM concepts WHERE id = $1 FOR SHARE", [parentRef])).rows[0];
  if (!c) throw httpError("The draft's project no longer exists.", 404, "not_found");
  const latest = async (sql, params) => (await client.query(sql, params)).rows[0]?.id ?? null;
  const newConcept = await copyRow(client, "concepts", parentRef, { title, pinned: false, clapboard_banner_path: null, created_at: new Date() });
  const deck = await latest("SELECT id FROM pitch_decks WHERE concept_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [parentRef]);
  if (!deck) return newConcept;
  const newDeck = await copyRow(client, "pitch_decks", deck, { concept_id: newConcept });
  const sheet = await latest("SELECT id FROM character_sheets WHERE pitch_deck_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [deck]);
  if (sheet) await copyRow(client, "character_sheets", sheet, { pitch_deck_id: newDeck });
  const act = await latest("SELECT id FROM three_act_structures WHERE pitch_deck_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [deck]);
  if (!act) return newConcept;
  const newAct = await copyRow(client, "three_act_structures", act, { pitch_deck_id: newDeck });
  const bits = await latest("SELECT id FROM bit_sheets WHERE three_act_structure_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [act]);
  if (!bits) return newConcept;
  const newBits = await copyRow(client, "bit_sheets", bits, { three_act_structure_id: newAct });
  const list = await latest("SELECT id FROM scene_lists WHERE bit_sheet_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [bits]);
  if (!list) return newConcept;
  const newList = await copyRow(client, "scene_lists", list, { bit_sheet_id: newBits, concept_id: null });
  const scenes = (await client.query("SELECT DISTINCT ON (episode_index, scene_index) id FROM screenplay_scenes WHERE scene_list_id = $1 ORDER BY episode_index, scene_index, id DESC", [list])).rows;
  for (const s of scenes) await copyRow(client, "screenplay_scenes", s.id, { scene_list_id: newList });
  return newConcept; // script breakdown / shoot schedule belong to the parent draft's production planning and are NOT copied
}

// kind 'numbered' takes the next draft number; 'alternative' takes none until promoted.
export async function branchDraft(db, parentDraftId, { label = null, kind = "numbered", actorUserId = null, note = null } = {}) {
  if (!["numbered", "alternative"].includes(kind)) throw httpError("kind must be numbered or alternative.", 400);
  const parent = await getDraft(db, parentDraftId);
  if (parent.status === "archived") throw httpError("An archived draft cannot be branched. Unarchive it first.", 409, "archived");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [800000 + parent.group_id]);
    const title0 = (await projectTitle(client, parent.module, parent.project_ref)) ?? "Untitled";
    const baseTitle = title0.replace(/\s+[—-]\s+(Draft \d+|Alternative.*)$/, "");
    const number = kind === "numbered" ? Number((await client.query("SELECT COALESCE(MAX(draft_number),0)+1 AS n FROM project_drafts WHERE group_id = $1", [parent.group_id])).rows[0].n) : null;
    const alts = kind === "alternative" ? Number((await client.query("SELECT count(*)::int + 1 AS n FROM project_drafts WHERE group_id = $1 AND kind = 'alternative'", [parent.group_id])).rows[0].n) : 0;
    const name = kind === "numbered" ? `${baseTitle} — Draft ${number}` : `${baseTitle} — Alternative ${alts}`;
    const ref = parent.module === "film" ? await copyFilm(client, parent.project_ref, { title: name, actorUserId }) : await copyAiMovie(client, parent.project_ref, { title: name, actorUserId });
    const where = await detectStage(client, parent.module, ref);
    const row = (await client.query(
      `INSERT INTO project_drafts (group_id, module, project_ref, draft_number, kind, label, parent_draft_id, status, current_stage, resume_context, source_screenplay_version, created_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'working',$8,$9,$10,$11,$12) RETURNING *`,
      [parent.group_id, parent.module, ref, number, kind, label, parent.id, where.stage, JSON.stringify(parent.resume_context ?? {}), parent.source_screenplay_version, actorUserId, note]
    )).rows[0];
    await client.query("COMMIT");
    publish(0, { type: "draft_created", draftId: row.id, groupId: row.group_id });
    return row;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function promoteAlternative(db, draftId, { label = null } = {}) {
  const d = await getDraft(db, draftId);
  if (d.kind !== "alternative") throw httpError("Only an alternative can be promoted to a numbered draft.", 409, "not_alternative");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [800000 + d.group_id]);
    const n = Number((await client.query("SELECT COALESCE(MAX(draft_number),0)+1 AS n FROM project_drafts WHERE group_id = $1", [d.group_id])).rows[0].n);
    const row = (await client.query("UPDATE project_drafts SET kind = 'numbered', draft_number = $2, label = COALESCE($3, label), revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *", [draftId, n, label])).rows[0];
    const base = (await projectTitle(client, d.module, d.project_ref)) ?? "Untitled";
    const table = d.module === "film" ? "concepts" : "ai_movie_projects";
    await client.query(`UPDATE ${table} SET title = $2 WHERE id = $1`, [d.project_ref, base.replace(/\s+[—-]\s+Alternative.*$/, "") + ` — Draft ${n}`]);
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Status, labels, saved stage — all with optimistic concurrency
// ---------------------------------------------------------------------------
export async function updateDraft(db, draftId, { label, status, note, expectedRevision = null, confirm = false } = {}) {
  const d = await getDraft(db, draftId);
  if (expectedRevision !== null && Number(expectedRevision) !== d.revision) throw httpError("This draft changed since you loaded it. Reload and try again.", 409, "stale_revision");
  const sets = [];
  const params = [draftId];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (label !== undefined) add("label", label === null ? null : String(label).slice(0, 120));
  if (note !== undefined) add("note", note === null ? null : String(note).slice(0, 1000));
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw httpError(`status must be one of ${STATUSES.join(", ")}.`, 400);
    if (status === "archived" && !confirm) throw httpError("Archiving hides this draft from the dashboard. Confirm to continue.", 409, "confirm_required");
    if (status === "archived" && d.draft_number === 1 && (await db.query("SELECT count(*)::int AS n FROM project_drafts WHERE group_id = $1 AND status <> 'archived'", [d.group_id])).rows[0].n <= 1) throw httpError("The last remaining draft cannot be archived.", 409, "last_draft");
    add("status", status);
    if (["approved", "locked"].includes(status)) add("approval", JSON.stringify({ status, at: new Date().toISOString() }));
  }
  if (sets.length === 0) return d;
  const row = (await db.query(`UPDATE project_drafts SET ${sets.join(", ")}, revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *`, params)).rows[0];
  return row;
}

// Saved stage + context so a draft reopens exactly where it was left. Not a concurrency conflict: last writer wins for position only.
export async function saveResume(db, draftId, { stage = null, context = null } = {}) {
  const sets = ["last_opened_at = now()"];
  const params = [draftId];
  if (stage) { params.push(String(stage).slice(0, 60)); sets.push(`current_stage = $${params.length}`); }
  if (context && typeof context === "object") { params.push(JSON.stringify(context)); sets.push(`resume_context = $${params.length}`); }
  const row = (await db.query(`UPDATE project_drafts SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params)).rows[0];
  if (!row) throw httpError("Draft not found.", 404, "not_found");
  await db.query("UPDATE project_draft_groups SET active_draft_id = $2 WHERE id = $1", [row.group_id, row.id]);
  return row;
}

// ---------------------------------------------------------------------------
// Units: a draft's content as comparable pieces (used for comparison, impact maps and change detection)
// ---------------------------------------------------------------------------
const hash = (s) => createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 12);

function sceneText(scene) {
  if (!scene) return "";
  const blocks = Array.isArray(scene.content) ? scene.content : Array.isArray(scene.elements) ? scene.elements : null;
  const heading = flatten(scene.sceneHeading ?? scene.heading ?? "");
  const body = blocks ? blocks.map((b) => `${b.character ? `${flatten(b.character)}: ` : ""}${flatten(b.text ?? b.content ?? b.line ?? b)}`).join("\n") : flatten(scene.action ?? scene);
  return `${heading}\n${body}`.trim();
}

export async function draftUnits(db, module, projectRef) {
  const units = [];
  const add = (section, key, label, text) => { if (text && text.trim()) units.push({ section, key, label, text: text.trim(), hash: hash(text) }); };
  if (module === "ai_movie") {
    const p = (await db.query("SELECT pasted_text, backfill FROM ai_movie_projects WHERE id = $1", [projectRef])).rows[0];
    if (!p) throw httpError("Project not found.", 404, "not_found");
    const b = p.backfill ?? {};
    add("idea", "idea", "The idea", p.pasted_text);
    add("story", "story", "Story", flatten(b.story));
    add("synopsis", "synopsis", "Synopsis", flatten(b.synopsis));
    (Array.isArray(b.characterArc) ? b.characterArc : []).forEach((c, i) => add("characters", `char${i}`, flatten(c.name) || `Character ${i + 1}`, flatten(c)));
    (Array.isArray(b.threeAct) ? b.threeAct : []).forEach((a, i) => add("structure", `act${i}`, flatten(a.actName) || `Act ${i + 1}`, flatten(a)));
    (Array.isArray(b.plot) ? b.plot : []).forEach((x, i) => add("beats", `beat${i}`, `Beat ${i + 1}: ${flatten(x.title)}`, flatten(x)));
    (Array.isArray(b.screenplayBeats) ? b.screenplayBeats : []).forEach((beat, bi) => (beat?.scenes ?? []).forEach((s, si) => add("screenplay", `b${bi}s${si}`, `Beat ${bi + 1}, scene ${si + 1}: ${flatten(s.sceneHeading).slice(0, 60)}`, sceneText(s))));
    return units;
  }
  const c = (await db.query("SELECT concept_text FROM concepts WHERE id = $1", [projectRef])).rows[0];
  if (!c) throw httpError("Project not found.", 404, "not_found");
  add("idea", "idea", "The idea", c.concept_text);
  const deck = (await db.query("SELECT id, content FROM pitch_decks WHERE concept_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [projectRef])).rows[0];
  if (!deck) return units;
  add("synopsis", "synopsis", "Synopsis / pitch", flatten(deck.content));
  const sheet = (await db.query("SELECT content FROM character_sheets WHERE pitch_deck_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [deck.id])).rows[0];
  const chars = Array.isArray(sheet?.content) ? sheet.content : Array.isArray(sheet?.content?.characters) ? sheet.content.characters : null;
  if (chars) chars.forEach((x, i) => add("characters", `char${i}`, flatten(x.name) || `Character ${i + 1}`, flatten(x)));
  else add("characters", "characters", "Characters", flatten(sheet?.content));
  const act = (await db.query("SELECT id, content FROM three_act_structures WHERE pitch_deck_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [deck.id])).rows[0];
  add("structure", "structure", "Three-act structure", flatten(act?.content));
  const bits = act ? (await db.query("SELECT id, content FROM bit_sheets WHERE three_act_structure_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [act.id])).rows[0] : null;
  add("beats", "beats", "Beat sheet", flatten(bits?.content));
  const list = bits ? (await db.query("SELECT id, content FROM scene_lists WHERE bit_sheet_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [bits.id])).rows[0] : null;
  if (list) {
    add("sceneList", "sceneList", "Scene list", flatten(list.content));
    const scenes = (await db.query("SELECT DISTINCT ON (episode_index, scene_index) episode_index, scene_index, content FROM screenplay_scenes WHERE scene_list_id = $1 ORDER BY episode_index, scene_index, id DESC", [list.id])).rows;
    for (const s of scenes) add("screenplay", `e${s.episode_index ?? 0}s${s.scene_index}`, `${s.episode_index != null ? `Episode ${Number(s.episode_index) + 1}, ` : ""}scene ${s.scene_index + 1}: ${flatten(s.content?.heading ?? s.content?.sceneHeading ?? "").slice(0, 60)}`, sceneText(s.content));
  }
  return units;
}

export const fingerprintOf = (units, keys = null) => hash(units.filter((u) => !keys || keys.includes(u.key)).map((u) => `${u.key}:${u.hash}`).join("|"));

// Compares two lists of units by key and content: preserved, modified, added, removed.
export function diffUnits(aUnits, bUnits) {
  const a = new Map(aUnits.map((u) => [u.key, u]));
  const b = new Map(bUnits.map((u) => [u.key, u]));
  const rows = [];
  for (const [key, u] of a) {
    const v = b.get(key);
    rows.push(!v ? { status: "removed", section: u.section, key, label: u.label, before: u.text, after: null } : v.hash === u.hash ? { status: "preserved", section: u.section, key, label: u.label } : { status: "modified", section: u.section, key, label: v.label, before: u.text, after: v.text });
  }
  for (const [key, v] of b) if (!a.has(key)) rows.push({ status: "added", section: v.section, key, label: v.label, before: null, after: v.text });
  const counts = { preserved: 0, modified: 0, added: 0, removed: 0 };
  for (const r of rows) counts[r.status]++;
  return { counts, rows };
}

export async function compareDrafts(db, aDraftId, bDraftId) {
  const a = await getDraft(db, aDraftId), b = await getDraft(db, bDraftId);
  if (a.module !== b.module) throw httpError("Drafts of different modules cannot be compared.", 400, "module_mismatch");
  const [ua, ub] = [await draftUnits(db, a.module, a.project_ref), await draftUnits(db, b.module, b.project_ref)];
  const diff = diffUnits(ua, ub);
  return { a: rowView(a), b: rowView(b), ...diff, rows: diff.rows.filter((r) => r.status !== "preserved").concat(diff.rows.filter((r) => r.status === "preserved").map(({ before, after, ...r }) => r)) };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function registerDraftRoutes(app, db, requireRole) {
  const admin = requireRole("admin");
  const id = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error("Draft route failed:", error);
      res.status(status).json({ error: status >= 500 && !error.status ? "Something went wrong on the server." : error.message, code: error.code ?? null });
    }
  };
  const draftId = (req) => id(req.params.draftId) ?? 0;
  app.get("/api/drafts", admin, wrap(async (req, res) => {
    const module = String(req.query.module ?? ""), ref = id(req.query.projectRef);
    if (!MODULES.includes(module) || !ref) throw httpError("module (film | ai_movie) and projectRef are required.", 400);
    res.json(await getDashboard(db, module, ref, { actorUserId: req.user?.id }));
  }));
  app.get("/api/drafts/compare", admin, wrap(async (req, res) => {
    const a = id(req.query.a), b = id(req.query.b);
    if (!a || !b) throw httpError("a and b (draft ids) are required.", 400);
    res.json(await compareDrafts(db, a, b));
  }));
  app.post("/api/drafts/:draftId/branch", admin, wrap(async (req, res) => {
    const row = await branchDraft(db, draftId(req), { label: req.body?.label ?? null, kind: req.body?.kind ?? "numbered", actorUserId: req.user?.id, note: req.body?.note ?? null });
    res.status(201).json({ draft: rowView(row) });
  }));
  app.post("/api/drafts/:draftId/promote", admin, wrap(async (req, res) => res.json({ draft: rowView(await promoteAlternative(db, draftId(req), { label: req.body?.label ?? null })) })));
  app.patch("/api/drafts/:draftId", admin, wrap(async (req, res) => res.json({ draft: rowView(await updateDraft(db, draftId(req), { label: req.body?.label, status: req.body?.status, note: req.body?.note, expectedRevision: req.body?.expectedRevision ?? null, confirm: req.body?.confirm === true })) })));
  app.put("/api/drafts/:draftId/resume", admin, wrap(async (req, res) => res.json({ draft: rowView(await saveResume(db, draftId(req), { stage: req.body?.stage ?? null, context: req.body?.context ?? null })) })));
}
