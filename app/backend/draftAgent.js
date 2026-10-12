// The Universal Auto Screenplay Agent: ONE entry point that works from any stage of any draft.
//
// It is not a new writer. It decides WHAT kind of job a spoken/typed instruction is, shows what it would touch, and only then uses the
// existing models (routed by the project's quality mode, behind the existing money guard) to do it:
//
//   LOCAL_EDIT / SCOPED_REWRITE   a preview (diff) of changes to the selected piece(s) -> Apply (undoable)
//   ALTERNATIVE                   a copy of the draft ("alternative", no draft number) where the idea is tried; promote later
//   NEW_DRAFT                     a copy of the draft + impact map + revised synopsis -> STOP for approval -> selective rewrite -> final approval
//   NEW_STORY                     asks whether to start it in this project or as a new project
//   CONTINUE                      reopens the draft at its saved stage
//   UNCLEAR                       asks which of the four it should be
//
// A classifier's answer is only a recommendation. Nothing is changed, copied or paid for until the person confirms a specific action.

import { branchDraft, createBlank, draftUnits, diffUnits, fingerprintOf, getDraft, httpError, saveResume, sceneText, updateDraft } from "./drafts.js";
import { flatten } from "./workspaceContext.js";
import { analyzeScreenplay } from "./screenplayAnalysis.js";
import { publish } from "./events.js";

export const INTENTS = ["LOCAL_EDIT", "SCOPED_REWRITE", "NEW_DRAFT", "ALTERNATIVE", "NEW_STORY", "CONTINUE", "UNCLEAR"];
const CHOICES = [
  { action: "edit_current", label: "Edit current draft", intent: "SCOPED_REWRITE" },
  { action: "new_draft", label: "Create new draft", intent: "NEW_DRAFT" },
  { action: "alternative", label: "Explore alternative", intent: "ALTERNATIVE" },
  { action: "new_story", label: "Start new story", intent: "NEW_STORY" },
];
const MAX_UNITS_PER_PROPOSAL = 12;
const PRO_CALL_USD = 0.12;

const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// ---------------------------------------------------------------------------
// Reading and writing ONE unit of a draft (the unit keys come from drafts.js draftUnits)
// ---------------------------------------------------------------------------
const AI_PATHS = [
  [/^b(\d+)s(\d+)$/, (m) => ({ kind: "scene", beat: +m[1], scene: +m[2] })],
  [/^char(\d+)$/, (m) => ({ kind: "array", field: "characterArc", i: +m[1], stage: "characterArc" })],
  [/^act(\d+)$/, (m) => ({ kind: "array", field: "threeAct", i: +m[1], stage: "threeAct" })],
  [/^beat(\d+)$/, (m) => ({ kind: "array", field: "plot", i: +m[1], stage: "plot" })],
  [/^(story)$/, () => ({ kind: "field", field: "story", stage: "story" })],
  [/^(synopsis)$/, () => ({ kind: "field", field: "synopsis", stage: "synopsis" })],
];
const aiPath = (key) => { for (const [re, f] of AI_PATHS) { const m = re.exec(key); if (m) return f(m); } return key === "idea" ? { kind: "idea" } : null; };

async function aiTx(db, ref, fn) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query("SELECT id, pasted_text, backfill, stage_status FROM ai_movie_projects WHERE id = $1 FOR UPDATE", [ref])).rows[0];
    if (!row) throw httpError("The draft's project no longer exists.", 404, "not_found");
    const state = { pasted: row.pasted_text, b: row.backfill ?? {}, st: row.stage_status ?? {} };
    const out = await fn(state);
    await client.query("UPDATE ai_movie_projects SET pasted_text = $2, backfill = $3, stage_status = $4, updated_at = now() WHERE id = $1", [ref, state.pasted, JSON.stringify(state.b), JSON.stringify(state.st)]);
    await client.query("COMMIT");
    return out;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// -> { text: bool, value } the raw stored value for this unit
export async function readUnit(db, module, ref, key) {
  if (module === "ai_movie") {
    const p = (await db.query("SELECT pasted_text, backfill FROM ai_movie_projects WHERE id = $1", [ref])).rows[0];
    const f = aiPath(key);
    if (!p || !f) return null;
    const b = p.backfill ?? {};
    if (f.kind === "idea") return { text: true, value: p.pasted_text };
    if (f.kind === "field") return b[f.field] === undefined ? null : { text: false, value: b[f.field] };
    if (f.kind === "array") return b[f.field]?.[f.i] === undefined ? null : { text: false, value: b[f.field][f.i] };
    const scene = b.screenplayBeats?.[f.beat]?.scenes?.[f.scene];
    return scene ? { text: false, value: scene } : null;
  }
  if (key === "idea") return { text: true, value: (await db.query("SELECT concept_text FROM concepts WHERE id = $1", [ref])).rows[0]?.concept_text ?? "" };
  const deck = (await db.query("SELECT id, content FROM pitch_decks WHERE concept_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [ref])).rows[0];
  if (key === "synopsis") return deck ? { text: false, value: deck.content } : null;
  const chain = await filmChain(db, ref);
  if (/^char(\d+)$/.test(key)) { const i = +key.slice(4); const arr = Array.isArray(chain.sheet?.content) ? chain.sheet.content : chain.sheet?.content?.characters; return arr?.[i] === undefined ? null : { text: false, value: arr[i] }; }
  if (key === "characters") return chain.sheet ? { text: false, value: chain.sheet.content } : null;
  if (key === "structure") return chain.act ? { text: false, value: chain.act.content } : null;
  if (key === "beats") return chain.bits ? { text: false, value: chain.bits.content } : null;
  if (key === "sceneList") return chain.list ? { text: false, value: chain.list.content } : null;
  const m = /^e(\d+)s(\d+)$/.exec(key);
  if (m && chain.list) {
    const row = await filmScene(db, chain.list.id, +m[1], +m[2]);
    return row ? { text: false, value: row.content } : null;
  }
  return null;
}

async function filmChain(db, ref) {
  const q = async (sql, p) => (await db.query(sql, p)).rows[0] ?? null;
  const deck = await q("SELECT id, content FROM pitch_decks WHERE concept_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [ref]);
  const sheet = deck ? await q("SELECT id, content FROM character_sheets WHERE pitch_deck_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [deck.id]) : null;
  const act = deck ? await q("SELECT id, content FROM three_act_structures WHERE pitch_deck_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [deck.id]) : null;
  const bits = act ? await q("SELECT id, content FROM bit_sheets WHERE three_act_structure_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [act.id]) : null;
  const list = bits ? await q("SELECT id, content FROM scene_lists WHERE bit_sheet_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [bits.id]) : null;
  return { deck, sheet, act, bits, list };
}
async function filmScene(db, listId, ep, idx) {
  return (await db.query("SELECT id, episode_index, scene_index, content FROM screenplay_scenes WHERE scene_list_id = $1 AND COALESCE(episode_index, 0) = $2 AND scene_index = $3 ORDER BY id DESC LIMIT 1", [listId, ep, idx])).rows[0] ?? null;
}

// Writes the new value. In AI Movie the stage is marked for review when `needsReview`; in Film, scenes get a NEW version row (the app's own undoable history).
export async function writeUnit(db, module, ref, key, value, { needsReview = false } = {}) {
  if (module === "ai_movie") {
    const f = aiPath(key);
    if (!f) throw httpError(`Unknown part "${key}".`, 400);
    return aiTx(db, ref, (s) => {
      if (f.kind === "idea") s.pasted = String(value);
      else if (f.kind === "field") { s.b[f.field] = value; if (needsReview) s.st[f.stage] = { ...(s.st[f.stage] ?? {}), status: "pending", feedback: s.st[f.stage]?.feedback ?? null }; }
      else if (f.kind === "array") { s.b[f.field] = s.b[f.field] ?? []; s.b[f.field][f.i] = value; if (needsReview) s.st[f.stage] = { ...(s.st[f.stage] ?? {}), status: "pending", feedback: s.st[f.stage]?.feedback ?? null }; }
      else {
        const beat = s.b.screenplayBeats?.[f.beat];
        if (!beat?.scenes?.[f.scene]) throw httpError("That scene no longer exists.", 409, "gone");
        beat.scenes[f.scene] = value;
        if (needsReview) { beat.status = "pending"; if (s.st.screenplay) delete s.st.screenplay; }
      }
    });
  }
  const chain = await filmChain(db, ref);
  const setContent = async (table, id, content) => db.query(`UPDATE ${table} SET content = $2${needsReview ? ", status = 'pending'" : ""} WHERE id = $1`, [id, JSON.stringify(content)]);
  if (key === "idea") return db.query("UPDATE concepts SET concept_text = $2 WHERE id = $1", [ref, String(value)]);
  if (key === "synopsis" && chain.deck) return setContent("pitch_decks", chain.deck.id, value);
  if (key === "characters" && chain.sheet) return setContent("character_sheets", chain.sheet.id, value);
  const ch = /^char(\d+)$/.exec(key);
  if (ch && chain.sheet) {
    const c = chain.sheet.content;
    if (Array.isArray(c)) { c[+ch[1]] = value; return setContent("character_sheets", chain.sheet.id, c); }
    if (Array.isArray(c?.characters)) { c.characters[+ch[1]] = value; return setContent("character_sheets", chain.sheet.id, c); }
  }
  if (key === "structure" && chain.act) return setContent("three_act_structures", chain.act.id, value);
  if (key === "beats" && chain.bits) return setContent("bit_sheets", chain.bits.id, value);
  if (key === "sceneList" && chain.list) return setContent("scene_lists", chain.list.id, value);
  const m = /^e(\d+)s(\d+)$/.exec(key);
  if (m && chain.list) {
    const cur = await filmScene(db, chain.list.id, +m[1], +m[2]);
    if (!cur) throw httpError("That scene no longer exists.", 409, "gone");
    // a NEW version row, exactly like the app's own scene edits (so the existing Undo still works on it)
    await db.query("INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content, status) VALUES ($1,$2,$3,$4,$5)", [chain.list.id, cur.episode_index, cur.scene_index, JSON.stringify(value), needsReview ? "pending" : "pending"]);
    return null;
  }
  throw httpError(`Cannot write "${key}" in this draft.`, 400);
}

// If production work already exists for an AI Movie draft, let it notice the change the way it always does (flags stale, deletes nothing).
async function refreshProduction(db, module, ref) {
  if (module !== "ai_movie") return;
  try {
    if ((await db.query("SELECT 1 FROM production_scenes WHERE project_id = $1 LIMIT 1", [ref])).rowCount > 0) await analyzeScreenplay(db, ref);
  } catch { /* production follows on its next sync */ }
}

// ---------------------------------------------------------------------------
// Intent routing
// ---------------------------------------------------------------------------
// Words only: used when the model is unavailable, and as a safety net that can only make things MORE careful.
export function heuristicIntent(instruction, context = {}) {
  const t = String(instruction ?? "").toLowerCase();
  if (!t.trim()) return "UNCLEAR";
  if (/\b(continue|resume|carry on|pick up)\b.*\b(screenplay|script|draft|writing|story)\b|^continue\b/.test(t)) return "CONTINUE";
  if (/\b(entirely|completely|totally)\s+different\s+story\b|\b(new|another|different)\s+story\b|\bstart over\b/.test(t)) return "NEW_STORY";
  if (/\b(try|explore|what if|alternative|alternate|experiment)\b/.test(t) && !/\bdraft\b/.test(t)) return "ALTERNATIVE";
  if (/\b(second|third|next|new)\s+draft\b|\bcreate\s+(a\s+)?(draft|branch)\b|\bdraft\s*\d\b|\bkeep\b.*\bchange\b/.test(t)) return "NEW_DRAFT";
  if (/\bscenes?\s*\d+\s*(-|–|to|through)\s*\d+\b|\b(and|also)\b.*\b(fix|update|adjust)\b.*\b(affected|else|rest)\b|\bwhole (act|film|screenplay|script)\b/.test(t)) return "SCOPED_REWRITE";
  if (context.selectedText || /\b(this|that)\s+(line|dialogue|scene|speech|action)\b|\bdialogue\b|\bline\b/.test(t)) return "LOCAL_EDIT";
  return "UNCLEAR";
}

const CLASSIFY_SCHEMA = {
  type: "OBJECT",
  properties: {
    intent: { type: "STRING", enum: INTENTS },
    confidence: { type: "NUMBER" },
    summary: { type: "STRING", description: "One plain sentence: what the person wants done." },
    targets: { type: "ARRAY", items: { type: "OBJECT", properties: { type: { type: "STRING", enum: ["selection", "scene", "scenes", "beat", "episode", "character", "opening", "ending", "climax", "whole"] }, from: { type: "INTEGER" }, to: { type: "INTEGER" }, name: { type: "STRING" } }, required: ["type"] } },
    mustKeep: { type: "ARRAY", items: { type: "STRING" } },
    mustChange: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["intent", "summary"],
};

export function classifyPrompt(instruction, context, draft, units) {
  return `You are the routing step of a screenplay-writing assistant. Decide what KIND of job the instruction below is. You do not do the job.

Kinds:
- LOCAL_EDIT: change selected text, one line of dialogue or one scene.
- SCOPED_REWRITE: change several related scenes/episodes (and what depends on them) inside the current draft.
- NEW_DRAFT: a significant story or structural revision that should be a NEW draft (for example "keep the opening and the hero, change the villain and the central conflict", "create a second draft", "here is my complete screenplay, revise it").
- ALTERNATIVE: try a scene, ending, climax or direction without changing the current draft ("try an ending where...", "what if...").
- NEW_STORY: a completely different story.
- CONTINUE: resume unfinished work.
- UNCLEAR: you cannot tell. Prefer UNCLEAR over guessing when a destructive or expensive choice depends on it.

Current stage: ${context.stage ?? "unknown"}. Draft: ${draft.label ?? `Draft ${draft.draft_number ?? ""}`} (${draft.status}). The project has ${units.filter((u) => u.section === "screenplay").length} screenplay scenes.
${context.selectedText ? `The person has selected this text: "${clip(context.selectedText, 400)}"\n` : ""}${context.sceneLabel ? `The scene currently open: ${context.sceneLabel}\n` : ""}
targets: list what the instruction refers to (a selection, scene numbers, a beat, an episode, a character name, the opening, the ending, the climax, or the whole film). Do not invent numbers that are not in the instruction. mustKeep / mustChange: things the person said to keep or change.

INSTRUCTION (verbatim): """${instruction}"""`;
}

const num = (x) => (Number.isInteger(x) && x > 0 ? x : null);

// Turns the classifier's (or the words') targets into real unit keys. Anything it cannot place is returned as `unresolved` with candidates to pick from.
export function resolveTargets(units, targets, instruction, context = {}) {
  const scenes = units.filter((u) => u.section === "screenplay");
  const keys = new Set();
  const unresolved = [];
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const text = String(instruction ?? "");
  const list = [...(targets ?? [])];
  // numbers written in the instruction work even if the model missed them
  const range = /\bscenes?\s*(\d+)\s*(?:-|–|to|through)\s*(\d+)\b/i.exec(text);
  if (range && !list.some((t) => t.type === "scenes")) list.push({ type: "scenes", from: +range[1], to: +range[2] });
  const one = /\bscene\s*(\d+)\b/i.exec(text);
  if (one && !range && !list.some((t) => t.type === "scene")) list.push({ type: "scene", from: +one[1] });
  if (context.selectedText && !list.some((t) => t.type === "selection")) list.push({ type: "selection" });
  for (const t of list) {
    if (t.type === "selection") {
      if (!norm(context.selectedText)) continue; // the model assumed a selection that does not exist: nothing to place
      const sel = norm(context.selectedText);
      const hit = sel ? units.find((u) => norm(u.text).includes(sel)) : null;
      if (hit) keys.add(hit.key); else unresolved.push({ type: "selection", why: "The selected text was not found in this draft (it may have changed). Select it again." });
    } else if (t.type === "scene") {
      const n = num(t.from), u = n ? scenes[n - 1] : null;
      if (u) keys.add(u.key); else unresolved.push({ type: "scene", why: `There is no scene ${t.from ?? "number"}.` });
    } else if (t.type === "scenes") {
      const a = num(t.from), b = num(t.to);
      if (a && b && a <= b && b <= scenes.length) for (let i = a; i <= b; i++) keys.add(scenes[i - 1].key);
      else unresolved.push({ type: "scenes", why: `Scenes ${t.from}–${t.to} are not all in this draft (it has ${scenes.length}).` });
    } else if (t.type === "beat") {
      const n = num(t.from);
      const hit = n ? scenes.filter((u) => u.key.startsWith(`b${n - 1}s`)) : [];
      if (hit.length) hit.forEach((u) => keys.add(u.key)); else unresolved.push({ type: "beat", why: `Beat ${t.from ?? ""} has no scenes in this draft.` });
    } else if (t.type === "episode") {
      const n = num(t.from);
      const hit = n ? scenes.filter((u) => u.key.startsWith(`e${n - 1}s`)) : [];
      if (hit.length) hit.forEach((u) => keys.add(u.key)); else unresolved.push({ type: "episode", why: "This draft has no such episode (episodes exist only in series)." });
    } else if (t.type === "character") {
      const name = norm(t.name);
      const hit = name ? units.filter((u) => u.section === "characters" && norm(u.label + u.text).includes(name)) : [];
      if (hit.length) hit.forEach((u) => keys.add(u.key)); else unresolved.push({ type: "character", why: `No character called "${t.name ?? ""}" in this draft.` });
    } else if (t.type === "opening") scenes.slice(0, 2).forEach((u) => keys.add(u.key));
    else if (t.type === "ending") scenes.slice(-2).forEach((u) => keys.add(u.key));
    else if (t.type === "climax") unresolved.push({ type: "climax", why: "Which scenes are the climax? Pick them below instead of letting me guess." });
    else if (t.type === "whole") scenes.forEach((u) => keys.add(u.key));
  }
  return {
    keys: [...keys],
    unresolved,
    candidates: unresolved.length ? scenes.map((u, i) => ({ key: u.key, number: i + 1, label: u.label })) : [],
  };
}

// model: { json(draft, agentId, prompt, opts) } supplied by the server (routing + money guard live there).
export async function interpret(db, models, draftId, { instruction, source = "text", context = {} }) {
  const draft = await getDraft(db, draftId);
  const text = String(instruction ?? "").trim();
  if (!text) throw httpError("Say or type what you want the Auto Screenplay Agent to do.", 400, "empty");
  const units = await draftUnits(db, draft.module, draft.project_ref);
  let model = null, usedModel = false, modelError = null;
  if (models) {
    try { model = await models.json(draft, "writing-assistant", classifyPrompt(text, context, draft, units), { maxOutputTokens: 2048, responseSchema: CLASSIFY_SCHEMA }); usedModel = true; }
    catch (error) { if (error.status === 402) throw error; modelError = error.message; }
  }
  const words = heuristicIntent(text, context);
  let intent = INTENTS.includes(model?.intent) ? model.intent : words;
  // safety net: a model that says "just edit" for something the words clearly mark as bigger is overruled toward the more careful option
  const bigger = { LOCAL_EDIT: 0, SCOPED_REWRITE: 1, ALTERNATIVE: 2, NEW_DRAFT: 3, NEW_STORY: 4 };
  if (["NEW_DRAFT", "NEW_STORY", "ALTERNATIVE"].includes(words) && (bigger[intent] ?? 0) < bigger[words] && intent !== "UNCLEAR" && intent !== "CONTINUE") intent = words;
  if (intent === "LOCAL_EDIT" && !context.selectedText && !/scene|line|dialogue/i.test(text) && !(model?.targets ?? []).length) intent = "UNCLEAR";
  const resolved = resolveTargets(units, model?.targets ?? [], text, context);
  const scenesTouched = resolved.keys.length;
  const proCalls = ["LOCAL_EDIT", "SCOPED_REWRITE", "ALTERNATIVE"].includes(intent) ? Math.min(scenesTouched || 1, MAX_UNITS_PER_PROPOSAL) + (intent === "SCOPED_REWRITE" ? 1 : 0) : intent === "NEW_DRAFT" ? 4 : 0;
  const needsClarification = intent === "UNCLEAR" || (["LOCAL_EDIT", "SCOPED_REWRITE", "ALTERNATIVE"].includes(intent) && (resolved.unresolved.length > 0 || resolved.keys.length === 0));
  const editable = !["locked", "archived"].includes(draft.status);
  return {
    draftId, intent, confidence: Number.isFinite(model?.confidence) ? Math.max(0, Math.min(1, model.confidence)) : usedModel ? 0.6 : 0.4,
    summary: clip(model?.summary ?? `Interpreted as ${intent.replace(/_/g, " ").toLowerCase()}.`, 300), instruction: text, source,
    targets: resolved.keys.map((k) => { const u = units.find((x) => x.key === k); return { key: k, label: u?.label, section: u?.section }; }),
    unresolved: resolved.unresolved, candidates: resolved.candidates,
    constraints: { mustKeep: (model?.mustKeep ?? []).map((s) => clip(s, 200)), mustChange: (model?.mustChange ?? []).map((s) => clip(s, 200)) },
    needsClarification, options: needsClarification ? CHOICES : CHOICES.filter((c) => c.intent === intent || (intent === "LOCAL_EDIT" && c.action === "edit_current")),
    allChoices: CHOICES,
    scope: { units: scenesTouched, ofScenes: units.filter((u) => u.section === "screenplay").length, cappedAt: MAX_UNITS_PER_PROPOSAL },
    estimate: { modelCalls: proCalls, usd: Math.round(proCalls * PRO_CALL_USD * 100) / 100, note: draft.module === "ai_movie" ? "Estimate at the Pro-model price; checked against the project's money limit before each call." : "Film projects have no money limit; the same models are used." },
    draft: { status: draft.status, editable, needsConfirmToEdit: draft.status === "approved", message: !editable ? `This draft is ${draft.status}. Unlock it, or create a new draft or alternative instead.` : null },
    usedModel, modelError, executesNothing: true,
  };
}

// ---------------------------------------------------------------------------
// Scoped edits: propose (preview) -> apply -> undo
// ---------------------------------------------------------------------------
function rewritePrompt({ instruction, unit, current, context, constraints }) {
  const asText = typeof current === "string";
  return `You are the Auto Screenplay Agent revising ONE piece of a screenplay project. Make only the changes the instruction needs and keep everything else exactly as written: names, story facts, formatting, the language of each field.

INSTRUCTION (verbatim): """${instruction}"""
${constraints?.mustKeep?.length ? `MUST KEEP: ${constraints.mustKeep.join("; ")}\n` : ""}${constraints?.mustChange?.length ? `MUST CHANGE: ${constraints.mustChange.join("; ")}\n` : ""}${context.synopsis ? `APPROVED SYNOPSIS OF THE REVISION (follow it): ${clip(context.synopsis, 2500)}\n` : ""}${context.before ? `THE PREVIOUS PIECE (continuity): ${clip(context.before, 700)}\n` : ""}${context.after ? `THE NEXT PIECE (continuity): ${clip(context.after, 700)}\n` : ""}
THIS PIECE: ${unit.label}
${asText ? `CURRENT TEXT:\n${current}\n\nReturn JSON only: {"text":"the revised text"}` : `CURRENT (JSON):\n${JSON.stringify(current)}\n\nReturn JSON only: the SAME structure with the SAME keys and the same kinds of values. Where a field has both English ("en") and Hindi ("hi") text, revise both so they say the same thing. Do not add keys.`}`;
}

// Keeps the shape of the original: unknown keys dropped, missing keys kept, wrong type rejected.
export function conform(original, revised) {
  if (typeof original === "string") return typeof revised?.text === "string" && revised.text.trim() ? revised.text : null;
  if (Array.isArray(original)) return Array.isArray(revised) ? revised : null;
  if (original && typeof original === "object") {
    if (!revised || typeof revised !== "object" || Array.isArray(revised)) return null;
    const out = { ...original };
    if (!Object.keys(original).some((k) => k in revised)) return null; // an answer with none of the expected fields is not a revision of this piece
    for (const k of Object.keys(original)) if (k in revised && typeof revised[k] === typeof original[k] && Array.isArray(revised[k]) === Array.isArray(original[k])) out[k] = revised[k];
    return out;
  }
  return null;
}

export async function rewriteUnit(db, models, draft, key, { instruction, constraints, context = {}, units }) {
  const unit = units.find((u) => u.key === key);
  const raw = await readUnit(db, draft.module, draft.project_ref, key);
  if (!unit || !raw) throw httpError(`"${key}" is not part of this draft.`, 404, "not_found");
  const idx = units.findIndex((u) => u.key === key);
  const nb = (i) => (units[i] && units[i].section === unit.section ? clip(units[i].text, 700) : null);
  const answer = await models.json(draft, unit.section === "screenplay" ? "scene-writer-key" : "story-writer", rewritePrompt({ instruction, unit, current: raw.value, constraints, context: { ...context, before: nb(idx - 1), after: nb(idx + 1) } }), { maxOutputTokens: 8192 });
  const value = conform(raw.value, answer);
  if (value === null) throw httpError(`The AI's answer for "${unit.label}" did not keep the required structure, so nothing was changed there.`, 502, "bad_shape");
  return { key, label: unit.label, section: unit.section, before: raw.value, after: value, changed: JSON.stringify(value) !== JSON.stringify(raw.value) };
}

// readable text for the preview: scenes as script lines, everything else as plain text
const textOf = (v) => (typeof v === "string" ? v : v && (v.elements || v.content || v.sceneHeading || v.heading) ? sceneText(v) : flatten(v));

export async function propose(db, models, draftId, { instruction, intent = "SCOPED_REWRITE", targetKeys = [], context = {}, constraints = {}, confirmed = false, actorUserId = null, requestId = null }) {
  if (confirmed !== true) throw httpError("Confirm the action first: this uses the AI (and money) to prepare the changes.", 409, "confirm_required");
  if (!["LOCAL_EDIT", "SCOPED_REWRITE", "ALTERNATIVE"].includes(intent)) throw httpError("Only LOCAL_EDIT, SCOPED_REWRITE and ALTERNATIVE produce a change preview.", 400, "bad_intent");
  if (!models) throw httpError("The AI is not available on this server right now.", 503, "not_configured");
  const draft = await getDraft(db, draftId);
  if (["locked", "archived"].includes(draft.status)) throw httpError(`This draft is ${draft.status}. Unlock it, or create a new draft or alternative.`, 409, "locked");
  const units = await draftUnits(db, draft.module, draft.project_ref);
  const keys = [...new Set(targetKeys)].filter((k) => units.some((u) => u.key === k));
  if (keys.length === 0) throw httpError("Choose what to change first.", 400, "no_targets");
  if (keys.length > MAX_UNITS_PER_PROPOSAL) throw httpError(`That is ${keys.length} pieces at once. Do ${MAX_UNITS_PER_PROPOSAL} or fewer at a time (or create a new draft for a big revision).`, 400, "too_many");
  const edits = [];
  const failures = [];
  for (const key of keys) {
    try {
      const e = await rewriteUnit(db, models, draft, key, { instruction, constraints, context, units });
      if (e.changed) edits.push({ key: e.key, label: e.label, section: e.section, before: e.before, after: e.after, beforeText: textOf(e.before), afterText: textOf(e.after) });
    } catch (error) {
      if (error.status === 402) throw error;
      failures.push({ key, message: error.message });
    }
  }
  const row = (await db.query(
    "INSERT INTO draft_change_sets (draft_id, request_id, intent, instruction, scope, edits, base_fingerprint, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
    [draftId, requestId, intent, instruction, JSON.stringify({ keys, failures }), JSON.stringify(edits), fingerprintOf(units, keys), actorUserId]
  )).rows[0];
  return changeSetView(row);
}

const changeSetView = (r) => ({ id: r.id, draftId: r.draft_id, requestId: r.request_id, intent: r.intent, instruction: r.instruction, status: r.status, scope: r.scope, createdAt: r.created_at, appliedAt: r.applied_at, edits: r.edits.map((e) => ({ key: e.key, label: e.label, section: e.section, beforeText: e.beforeText, afterText: e.afterText })), changes: r.edits.length, failures: r.scope?.failures ?? [] });

export async function getChangeSet(db, id) {
  const r = (await db.query("SELECT * FROM draft_change_sets WHERE id = $1", [id])).rows[0];
  if (!r) throw httpError("Change set not found.", 404, "not_found");
  return r;
}

export async function applyChangeSet(db, changeSetId, { confirmEditApproved = false, needsReview = false } = {}) {
  const cs = await getChangeSet(db, changeSetId);
  if (cs.status === "applied") return changeSetView(cs); // idempotent: pressing Apply twice changes nothing more
  if (cs.status !== "proposed") throw httpError(`This change set is ${cs.status}.`, 409, "not_proposed");
  const draft = await getDraft(db, cs.draft_id);
  if (["locked", "archived"].includes(draft.status)) throw httpError(`This draft is ${draft.status}. Unlock it first.`, 409, "locked");
  if (draft.status === "approved" && !confirmEditApproved) throw httpError("This draft is approved. Confirm that you want to edit an approved draft (or create a new draft instead).", 409, "confirm_required");
  const units = await draftUnits(db, draft.module, draft.project_ref);
  const keys = cs.edits.map((e) => e.key);
  // refuse if anything the preview was based on changed since (another edit, autosave, or another agent run)
  const stale = fingerprintOf(units, cs.scope.keys ?? keys) !== cs.base_fingerprint;
  if (stale) {
    await db.query("UPDATE draft_change_sets SET status = 'stale' WHERE id = $1", [cs.id]);
    throw httpError("The draft changed after this preview was made, so nothing was applied. Preview the change again.", 409, "stale");
  }
  for (const e of cs.edits) await writeUnit(db, draft.module, draft.project_ref, e.key, e.after, { needsReview });
  const row = (await db.query("UPDATE draft_change_sets SET status = 'applied', applied_at = now() WHERE id = $1 RETURNING *", [cs.id])).rows[0];
  await db.query("UPDATE project_drafts SET revision = revision + 1, updated_at = now() WHERE id = $1", [draft.id]);
  await refreshProduction(db, draft.module, draft.project_ref);
  publish(0, { type: "draft_changed", draftId: draft.id });
  return changeSetView(row);
}

export async function rejectChangeSet(db, id) {
  const cs = await getChangeSet(db, id);
  if (cs.status !== "proposed") throw httpError(`This change set is ${cs.status}.`, 409, "not_proposed");
  return changeSetView((await db.query("UPDATE draft_change_sets SET status = 'rejected' WHERE id = $1 RETURNING *", [id])).rows[0]);
}

export async function undoChangeSet(db, id) {
  const cs = await getChangeSet(db, id);
  if (cs.status !== "applied") throw httpError("Only an applied change can be undone.", 409, "not_applied");
  const draft = await getDraft(db, cs.draft_id);
  for (const e of cs.edits) {
    const now = await readUnit(db, draft.module, draft.project_ref, e.key);
    if (!now || JSON.stringify(now.value) !== JSON.stringify(e.after)) throw httpError(`"${e.label}" was edited again after this change, so it cannot be undone safely.`, 409, "changed_since");
  }
  for (const e of cs.edits) await writeUnit(db, draft.module, draft.project_ref, e.key, e.before);
  const row = (await db.query("UPDATE draft_change_sets SET status = 'undone' WHERE id = $1 RETURNING *", [id])).rows[0];
  await refreshProduction(db, draft.module, draft.project_ref);
  return changeSetView(row);
}

export async function listChangeSets(db, draftId) {
  return (await db.query("SELECT * FROM draft_change_sets WHERE draft_id = $1 ORDER BY id DESC LIMIT 30", [draftId])).rows.map(changeSetView);
}

// ---------------------------------------------------------------------------
// Alternatives: a trial copy, the preview is made INSIDE the copy
// ---------------------------------------------------------------------------
export async function startAlternative(db, models, draftId, { instruction, targetKeys = [], context = {}, constraints = {}, confirmed = false, actorUserId = null }) {
  if (confirmed !== true) throw httpError("Confirm first: this makes a copy of the draft to try the idea in.", 409, "confirm_required");
  const parent = await getDraft(db, draftId);
  const alt = await branchDraft(db, draftId, { kind: "alternative", actorUserId, note: clip(instruction, 300) });
  let changeSet = null, error = null;
  if (targetKeys.length) {
    try { changeSet = await propose(db, models, alt.id, { instruction, intent: "ALTERNATIVE", targetKeys, context, constraints, confirmed: true, actorUserId }); }
    catch (e) { if (e.status === 402) error = e.message; else error = e.message; }
  }
  return { parentId: parent.id, alternative: alt, changeSet, error };
}

// ---------------------------------------------------------------------------
// Revision requests: NEW_DRAFT with the hard synopsis checkpoint
// ---------------------------------------------------------------------------
const REQUEST_STATUSES = ["analyzing", "awaiting_synopsis_approval", "synopsis_approved", "rewriting", "awaiting_final_approval", "completed", "cancelled", "failed"];

async function setRequest(db, id, fields) {
  const sets = ["updated_at = now()", "revision = revision + 1"];
  const params = [id];
  for (const [k, v] of Object.entries(fields)) { params.push(v !== null && typeof v === "object" ? JSON.stringify(v) : v); sets.push(`${k} = $${params.length}`); }
  return (await db.query(`UPDATE draft_revision_requests SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params)).rows[0];
}
const requestView = (r) => r && ({
  id: r.id, groupId: r.group_id, module: r.module, parentDraftId: r.parent_draft_id, draftId: r.draft_id, intent: r.intent, instruction: r.instruction, source: r.source,
  constraints: r.constraints, context: r.context, status: r.status, impactMap: r.impact_map, proposal: r.proposal, progress: r.decisions, error: r.error, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at,
});
export async function getRequest(db, id) {
  const r = (await db.query("SELECT * FROM draft_revision_requests WHERE id = $1", [id])).rows[0];
  if (!r) throw httpError("Revision request not found.", 404, "not_found");
  return r;
}
export async function listRequests(db, draftId) {
  return (await db.query("SELECT * FROM draft_revision_requests WHERE draft_id = $1 OR parent_draft_id = $1 ORDER BY id DESC LIMIT 20", [draftId])).rows.map(requestView);
}

// Requests left "analyzing" or "rewriting" by a restart are marked failed (so they can be retried), never left spinning.
export async function failInterruptedRequests(db) {
  const r = await db.query("UPDATE draft_revision_requests SET status = 'failed', error = 'Interrupted by a server restart. Press Retry to continue.', updated_at = now() WHERE status IN ('analyzing','rewriting') RETURNING id");
  return r.rowCount;
}

const IMPACT_SCHEMA = {
  type: "OBJECT",
  properties: {
    modified: { type: "ARRAY", items: { type: "OBJECT", properties: { key: { type: "STRING" }, why: { type: "STRING" } }, required: ["key"] } },
    removed: { type: "ARRAY", items: { type: "OBJECT", properties: { key: { type: "STRING" }, why: { type: "STRING" } }, required: ["key"] } },
    indirect: { type: "ARRAY", items: { type: "OBJECT", properties: { key: { type: "STRING" }, why: { type: "STRING" } }, required: ["key"] } },
    added: { type: "ARRAY", items: { type: "OBJECT", properties: { label: { type: "STRING" }, why: { type: "STRING" } }, required: ["label"] } },
  },
};
const OUTLINE_BATCH_CHARS = 36000;

function impactPrompt(instruction, constraints, batch, framing) {
  const lines = batch.map((u) => `[${u.key}] ${u.label} — ${clip(u.text, 260)}`).join("\n");
  return `You are analysing how a requested revision ripples through a screenplay project. Below is ${framing} of the CURRENT draft: one line per piece, each starting with its key in brackets.

REVISION REQUEST (verbatim): """${instruction}"""
${constraints?.mustKeep?.length ? `MUST KEEP (leave these unchanged): ${constraints.mustKeep.join("; ")}\n` : ""}${constraints?.mustChange?.length ? `MUST CHANGE: ${constraints.mustChange.join("; ")}\n` : ""}
Sort EVERY piece it lists that is affected:
- modified: must be rewritten because of the request
- removed: no longer belongs
- indirect: not asked about, but its foreshadowing, motivation, chronology, dialogue reference or continuity depends on what changes
- added: new scenes or beats the revision needs (give a short label)
Leave unaffected pieces out. Use ONLY keys that appear below. Be conservative: preserve as much of the draft as the request allows.

Return JSON only: {"modified":[{"key":"","why":""}],"removed":[],"indirect":[],"added":[{"label":"","why":""}]}

${lines}`;
}

function proposalPrompt(request, parentUnits, impact, feedback, series) {
  const get = (k) => parentUnits.find((u) => u.key === k);
  const list = (arr) => arr.map((x) => `- [${x.key}] ${get(x.key)?.label ?? x.key}: ${x.why ?? ""}`).join("\n") || "(none)";
  const synopsis = parentUnits.filter((u) => ["idea", "story", "synopsis"].includes(u.section)).map((u) => `${u.label}: ${clip(u.text, 1800)}`).join("\n\n");
  const episodes = series ? [...new Set([...impact.modified, ...impact.removed, ...impact.indirect].map((x) => /^e(\d+)s/.exec(x.key)?.[1]).filter((n) => n !== undefined))].map(Number).sort((a, b) => a - b) : [];
  return `You are the story editor planning a REVISED DRAFT of a screenplay. The writer will review your plan before any scene is rewritten.

REVISION REQUEST (verbatim): """${request.instruction}"""
${request.constraints?.mustKeep?.length ? `MUST KEEP: ${request.constraints.mustKeep.join("; ")}\n` : ""}${request.constraints?.mustChange?.length ? `MUST CHANGE: ${request.constraints.mustChange.join("; ")}\n` : ""}${feedback ? `THE WRITER ASKED FOR THESE CHANGES TO YOUR PREVIOUS PLAN: """${feedback}"""\n` : ""}
CURRENT STORY:
${synopsis}

PIECES TO MODIFY:\n${list(impact.modified)}
PIECES TO REMOVE:\n${list(impact.removed)}
INDIRECTLY AFFECTED:\n${list(impact.indirect)}
NEW PIECES NEEDED: ${impact.added.map((a) => a.label).join("; ") || "(none)"}

Write:
- summary: two or three sentences on what the revision changes and what it keeps.
- revisedSynopsis: the new synopsis (logline and premise) of the revised draft, in English, and the same in Hindi (revisedSynopsisHi).
${series ? `- seasonArc: a short overview of the revised season arc.\n- episodes: for EACH affected episode number (${episodes.map((n) => n + 1).join(", ") || "none"}) a concise revised synopsis. Use "index" = the episode number starting at 1.` : "- sequenceOutline: the revised sequence-by-sequence outline (a short line per sequence or scene that changes)."}

Return JSON only: {"summary":"","revisedSynopsis":"","revisedSynopsisHi":"",${series ? '"seasonArc":"","episodes":[{"index":1,"title":"","synopsis":""}]' : '"sequenceOutline":[{"label":"","change":""}]'}}`;
}

// Is this a series? (Film modules store episodes; AI Movie films do not.)
const isSeries = (units) => units.some((u) => /^e[1-9]\d*s\d+$/.test(u.key)) || units.filter((u) => /^e0s\d+$/.test(u.key)).length > 0 && units.some((u) => /^Episode \d/.test(u.label));

async function analyze(db, models, requestId, { feedback = null } = {}) {
  const request = await getRequest(db, requestId);
  const parent = await getDraft(db, request.parent_draft_id);
  const parentUnits = await draftUnits(db, parent.module, parent.project_ref);
  const valid = new Set(parentUnits.map((u) => u.key));
  let impact = feedback ? request.impact_map : null;
  if (!impact) {
    impact = { modified: [], removed: [], indirect: [], added: [] };
    // the whole parent draft is read, in batches that fit one model call
    const batches = [];
    let cur = [], size = 0;
    for (const u of parentUnits) {
      const len = Math.min(u.text.length, 260) + u.label.length + 20;
      if (size + len > OUTLINE_BATCH_CHARS && cur.length) { batches.push(cur); cur = []; size = 0; }
      cur.push(u); size += len;
    }
    if (cur.length) batches.push(cur);
    const protectedKeys = new Set();
    for (const [i, batch] of batches.entries()) {
      const a = await models.json(parent, "story-writer", impactPrompt(request.instruction, request.constraints, batch, batches.length > 1 ? `part ${i + 1} of ${batches.length}` : "the whole outline"), { maxOutputTokens: 8192, responseSchema: IMPACT_SCHEMA });
      for (const bucket of ["modified", "removed", "indirect"]) for (const x of Array.isArray(a?.[bucket]) ? a[bucket] : []) if (valid.has(x.key) && !protectedKeys.has(x.key)) { impact[bucket].push({ key: x.key, why: clip(x.why, 240) }); protectedKeys.add(x.key); }
      for (const x of Array.isArray(a?.added) ? a.added : []) if (x?.label) impact.added.push({ label: clip(x.label, 120), why: clip(x.why, 240) });
    }
    const touched = new Set([...impact.modified, ...impact.removed, ...impact.indirect].map((x) => x.key));
    impact.unchanged = parentUnits.filter((u) => !touched.has(u.key)).map((u) => u.key);
    impact.counts = { unchanged: impact.unchanged.length, modified: impact.modified.length, removed: impact.removed.length, indirect: impact.indirect.length, added: impact.added.length };
    await setRequest(db, requestId, { impact_map: impact });
  }
  const series = isSeries(parentUnits);
  const p = await models.json(parent, "story-writer", proposalPrompt(request, parentUnits, impact, feedback, series), { maxOutputTokens: 8192 });
  const proposal = {
    series, summary: clip(p?.summary, 1200), revisedSynopsis: clip(p?.revisedSynopsis, 3000), revisedSynopsisHi: clip(p?.revisedSynopsisHi, 3000),
    seasonArc: series ? clip(p?.seasonArc, 2000) : undefined,
    episodes: series ? (Array.isArray(p?.episodes) ? p.episodes.filter((e) => Number.isInteger(e?.index) && e.index > 0).map((e) => ({ index: e.index, title: clip(e.title, 120), synopsis: clip(e.synopsis, 1500) })) : []) : undefined,
    sequenceOutline: series ? undefined : (Array.isArray(p?.sequenceOutline) ? p.sequenceOutline.map((s) => ({ label: clip(s.label, 120), change: clip(s.change, 400) })) : []),
    feedbackHistory: [...(request.proposal?.feedbackHistory ?? []), ...(feedback ? [feedback] : [])],
  };
  if (!proposal.revisedSynopsis) throw httpError("The AI did not return a usable revised synopsis. Press Retry.", 502, "bad_proposal");
  await setRequest(db, requestId, { status: "awaiting_synopsis_approval", proposal, error: null });
  await db.query("UPDATE project_drafts SET status = 'pending_approval', current_stage = 'synopsis_review', updated_at = now() WHERE id = $1", [request.draft_id]);
  publish(0, { type: "revision_ready", requestId });
}

const running = new Map(); // request id -> promise (one job per request)
function launch(db, requestId, job) {
  if (running.has(requestId)) return running.get(requestId);
  const p = (async () => {
    try { await job(); }
    catch (error) {
      await setRequest(db, requestId, { status: "failed", error: clip(error.message, 600) }).catch(() => {});
    } finally { running.delete(requestId); }
  })();
  running.set(requestId, p);
  return p;
}
export const whenIdle = (requestId) => running.get(requestId) ?? Promise.resolve();

// Creates Draft N as a copy of the chosen draft and starts the analysis. Nothing is rewritten until the synopsis is approved.
export async function startRevision(db, models, draftId, { instruction, constraints = {}, source = "text", context = {}, label = null, confirmed = false, actorUserId = null }) {
  if (confirmed !== true) throw httpError("Confirm first: this creates a new draft and uses the AI to analyse the whole screenplay.", 409, "confirm_required");
  if (!models) throw httpError("The AI is not available on this server right now.", 503, "not_configured");
  const text = String(instruction ?? "").trim();
  if (!text) throw httpError("Say what the new draft should change.", 400, "empty");
  const parent = await getDraft(db, draftId);
  const units = await draftUnits(db, parent.module, parent.project_ref);
  if (units.filter((u) => u.section === "screenplay").length === 0 && units.length < 2) throw httpError("There is nothing in this draft to revise yet.", 409, "empty_draft");
  const draft = await branchDraft(db, draftId, { label, actorUserId, note: `Revision of ${parent.label ?? `Draft ${parent.draft_number}`}: ${clip(text, 200)}` });
  const row = (await db.query(
    `INSERT INTO draft_revision_requests (group_id, module, parent_draft_id, draft_id, intent, instruction, source, constraints, context, status, created_by) VALUES ($1,$2,$3,$4,'NEW_DRAFT',$5,$6,$7,$8,'analyzing',$9) RETURNING *`,
    [parent.group_id, parent.module, parent.id, draft.id, text, source, JSON.stringify({ mustKeep: constraints.mustKeep ?? [], mustChange: constraints.mustChange ?? [] }), JSON.stringify(context ?? {}), actorUserId]
  )).rows[0];
  await db.query("UPDATE project_drafts SET status = 'pending_approval', current_stage = 'analyzing' WHERE id = $1", [draft.id]);
  launch(db, row.id, () => analyze(db, models, row.id));
  return { request: requestView(row), draft };
}

export async function retryRequest(db, models, requestId) {
  const r = await getRequest(db, requestId);
  if (r.status !== "failed") throw httpError("Only a failed request can be retried.", 409, "not_failed");
  const wasRewriting = (r.decisions ?? []).length > 0 || r.proposal?.approved;
  await setRequest(db, requestId, { status: wasRewriting ? "rewriting" : "analyzing", error: null });
  launch(db, requestId, () => (wasRewriting ? rewriteAll(db, models, requestId) : analyze(db, models, requestId)));
  return requestView(await getRequest(db, requestId));
}

export async function requestSynopsisChanges(db, models, requestId, { feedback, expectedRevision = null }) {
  const r = await getRequest(db, requestId);
  if (r.status !== "awaiting_synopsis_approval") throw httpError("The synopsis is not waiting for review.", 409, "wrong_state");
  if (expectedRevision !== null && Number(expectedRevision) !== r.revision) throw httpError("This proposal changed since you loaded it. Reload it first.", 409, "stale_revision");
  const text = String(feedback ?? "").trim();
  if (!text) throw httpError("Say what should change in the synopsis.", 400, "empty");
  await setRequest(db, requestId, { status: "analyzing" });
  launch(db, requestId, () => analyze(db, models, requestId, { feedback: text }));
  return requestView(await getRequest(db, requestId));
}

export async function cancelRequest(db, requestId) {
  const r = await getRequest(db, requestId);
  if (["completed", "cancelled"].includes(r.status)) throw httpError(`This request is already ${r.status}.`, 409, "wrong_state");
  await setRequest(db, requestId, { status: "cancelled" });
  // the copy is archived, never deleted: the audit trail stays, and the parent was never touched
  if (r.draft_id) await db.query("UPDATE project_drafts SET status = 'archived', updated_at = now() WHERE id = $1", [r.draft_id]);
  return requestView(await getRequest(db, requestId));
}

// THE GATE: only here does the rewrite begin.
export async function approveSynopsis(db, models, requestId, { expectedRevision = null, actorUserId = null } = {}) {
  const r = await getRequest(db, requestId);
  if (r.status !== "awaiting_synopsis_approval") throw httpError("The synopsis is not waiting for approval.", 409, "wrong_state");
  if (expectedRevision !== null && Number(expectedRevision) !== r.revision) throw httpError("This proposal changed since you loaded it. Reload it first.", 409, "stale_revision");
  const proposal = { ...r.proposal, approved: true, approvedAt: new Date().toISOString(), approvedBy: actorUserId };
  await setRequest(db, requestId, { status: "rewriting", proposal, decisions: [] });
  await db.query("UPDATE project_drafts SET current_stage = 'rewriting', approval = $2 WHERE id = $1", [r.draft_id, JSON.stringify({ gate: "revised_synopsis", status: "approved", at: new Date().toISOString(), by: actorUserId })]);
  launch(db, requestId, () => rewriteAll(db, models, requestId));
  return requestView(await getRequest(db, requestId));
}

const ORDER = { idea: 0, story: 1, synopsis: 2, characters: 3, structure: 4, beats: 5, sceneList: 6, screenplay: 7 };

async function rewriteAll(db, models, requestId) {
  let r = await getRequest(db, requestId);
  const draft = await getDraft(db, r.draft_id);
  const units = await draftUnits(db, draft.module, draft.project_ref);
  const approvedSynopsis = `${r.proposal.revisedSynopsis}${r.proposal.seasonArc ? `\nSeason arc: ${r.proposal.seasonArc}` : ""}`;
  const done = new Map((r.decisions ?? []).map((d) => [d.key, d]));
  const log = [...(r.decisions ?? [])];
  const save = async () => { await setRequest(db, requestId, { decisions: log }); };
  // 1. the synopsis itself becomes the approved one
  if (!done.has("synopsis") && units.some((u) => u.key === "synopsis")) {
    const raw = await readUnit(db, draft.module, draft.project_ref, "synopsis");
    const a = await models.json(draft, "story-writer", `Rewrite this synopsis so it matches the approved revised synopsis. Keep the same JSON structure and keys; revise English and Hindi fields to say the same thing.\n\nAPPROVED REVISED SYNOPSIS: ${r.proposal.revisedSynopsis}\n${r.proposal.revisedSynopsisHi ? `(Hindi) ${r.proposal.revisedSynopsisHi}\n` : ""}\nCURRENT (JSON):\n${JSON.stringify(raw.value)}\n\nReturn JSON only, same structure.`, { maxOutputTokens: 4096 });
    const value = conform(raw.value, a);
    if (value) { await writeUnit(db, draft.module, draft.project_ref, "synopsis", value, { needsReview: true }); log.push({ key: "synopsis", status: "done" }); }
    else log.push({ key: "synopsis", status: "skipped", why: "The AI's answer did not keep the structure." });
    await save();
  }
  // 2. everything the impact map marked, story-level first, then scenes in order
  const impact = r.impact_map;
  const todo = [...impact.modified, ...impact.indirect].map((x) => ({ key: x.key, why: x.why })).filter((x) => x.key !== "synopsis")
    .sort((a, b) => (ORDER[units.find((u) => u.key === a.key)?.section] ?? 9) - (ORDER[units.find((u) => u.key === b.key)?.section] ?? 9) || units.findIndex((u) => u.key === a.key) - units.findIndex((u) => u.key === b.key));
  for (const item of todo) {
    r = await getRequest(db, requestId);
    if (r.status === "cancelled") return; // cancelled while running: stop between pieces
    if (done.has(item.key)) continue;
    const currentUnits = await draftUnits(db, draft.module, draft.project_ref);
    const e = await rewriteUnit(db, models, draft, item.key, { instruction: `${r.instruction}\n\nWhy this piece changes: ${item.why || "it depends on the revision"}`, constraints: r.constraints, context: { synopsis: approvedSynopsis }, units: currentUnits }).catch((error) => { if (error.status === 402) throw error; return { error }; });
    if (e.error) { log.push({ key: item.key, status: "failed", why: clip(e.error.message, 200) }); await save(); continue; }
    if (!e.changed) { log.push({ key: item.key, status: "unchanged" }); await save(); continue; }
    await writeUnit(db, draft.module, draft.project_ref, item.key, e.after, { needsReview: true });
    const cs = (await db.query("INSERT INTO draft_change_sets (draft_id, request_id, intent, instruction, scope, edits, base_fingerprint, status, applied_at) VALUES ($1,$2,'NEW_DRAFT',$3,$4,$5,'', 'applied', now()) RETURNING id", [draft.id, requestId, r.instruction, JSON.stringify({ keys: [item.key] }), JSON.stringify([{ key: item.key, label: e.label, section: e.section, before: e.before, after: e.after, beforeText: textOf(e.before), afterText: textOf(e.after) }])])).rows[0];
    log.push({ key: item.key, status: "done", changeSetId: cs.id });
    await save();
  }
  await refreshProduction(db, draft.module, draft.project_ref);
  const manual = [...impact.removed.map((x) => `Removed: ${units.find((u) => u.key === x.key)?.label ?? x.key}`), ...impact.added.map((x) => `New: ${x.label}`)];
  await setRequest(db, requestId, { status: "awaiting_final_approval", decisions: log, impact_map: { ...impact, manual } });
  await db.query("UPDATE project_drafts SET current_stage = 'revision_review', status = 'pending_approval', updated_at = now() WHERE id = $1", [draft.id]);
  publish(0, { type: "revision_ready", requestId });
}

export async function approveFinal(db, requestId, { expectedRevision = null, actorUserId = null } = {}) {
  const r = await getRequest(db, requestId);
  if (r.status !== "awaiting_final_approval") throw httpError("This revision is not waiting for final approval.", 409, "wrong_state");
  if (expectedRevision !== null && Number(expectedRevision) !== r.revision) throw httpError("This revision changed since you loaded it. Reload it first.", 409, "stale_revision");
  await setRequest(db, requestId, { status: "completed" });
  const draft = await getDraft(db, r.draft_id);
  // the draft's own stages still need their normal approvals where parts were rewritten: it is "approved" only when none are pending
  const pendingParts = (r.decisions ?? []).filter((d) => d.status === "done").length;
  await updateDraft(db, draft.id, { status: pendingParts ? "working" : "approved" });
  await db.query("UPDATE project_drafts SET approval = $2, current_stage = $3 WHERE id = $1", [draft.id, JSON.stringify({ gate: "final", status: "accepted", requestId, at: new Date().toISOString(), by: actorUserId }), "screenplay"]);
  return { request: requestView(await getRequest(db, requestId)), pendingParts };
}

// the full picture for the review screens
export async function revisionDetail(db, requestId) {
  const r = await getRequest(db, requestId);
  const out = { request: requestView(r) };
  if (r.draft_id && r.parent_draft_id) {
    const [d, p] = [await getDraft(db, r.draft_id), await getDraft(db, r.parent_draft_id)];
    const diff = diffUnits(await draftUnits(db, p.module, p.project_ref), await draftUnits(db, d.module, d.project_ref));
    out.comparison = { counts: diff.counts, rows: diff.rows.filter((x) => x.status !== "preserved") };
    out.parentDraft = { id: p.id, title: p.label ?? `Draft ${p.draft_number}` };
    out.draft = { id: d.id, title: d.label ?? `Draft ${d.draft_number}`, status: d.status };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Downstream production safety (AI Movie)
// ---------------------------------------------------------------------------
// Compares a draft with its parent and classifies what the PARENT's production work means for the new draft. Nothing is reused automatically.
export async function productionImpact(db, draftId) {
  const draft = await getDraft(db, draftId);
  if (draft.module !== "ai_movie") return { applicable: false, reason: "Production work exists only for AI Movie drafts." };
  if (!draft.parent_draft_id) return { applicable: false, reason: "This is the original draft: its production work belongs to it alone." };
  const parent = await getDraft(db, draft.parent_draft_id);
  const diff = diffUnits(await draftUnits(db, parent.module, parent.project_ref), await draftUnits(db, draft.module, draft.project_ref));
  const status = new Map(diff.rows.map((r) => [r.key, r.status]));
  const scenes = (await db.query("SELECT id, code, source_key, heading FROM production_scenes WHERE project_id = $1 AND in_latest ORDER BY order_index", [parent.project_ref])).rows;
  const media = new Map((await db.query(
    `SELECT s.id AS scene_id, count(DISTINCT sh.id)::int AS shots, count(g.id) FILTER (WHERE g.review = 'approved' AND g.status = 'ready')::int AS approved_media
     FROM production_scenes s LEFT JOIN production_shots sh ON sh.scene_id = s.id LEFT JOIN production_generations g ON g.shot_id = sh.id WHERE s.project_id = $1 GROUP BY s.id`, [parent.project_ref])).rows.map((r) => [r.scene_id, r]));
  const classes = { reusable: [], needs_review: [], stale: [] };
  for (const s of scenes) {
    const m = media.get(s.id) ?? { shots: 0, approved_media: 0 };
    const st = status.get(s.source_key);
    const item = { code: s.code, heading: s.heading, sourceKey: s.source_key, shots: m.shots, approvedMedia: m.approved_media, change: st ?? "removed" };
    if (st === "preserved") classes.reusable.push(item); else if (st === "modified") classes.needs_review.push(item); else classes.stale.push(item);
  }
  const overall = classes.stale.length === 0 && classes.needs_review.length === 0 ? "compatible" : classes.stale.length ? "stale" : "needs_review";
  return {
    applicable: true, parentDraftId: parent.id, overall, counts: { reusable: classes.reusable.length, needs_review: classes.needs_review.length, stale: classes.stale.length }, classes,
    guarantees: ["The parent draft's shots, pictures, voices, video and timeline are stored under its own project and are not touched by this draft.", "Nothing from the parent is reused here automatically. Reusing media needs an explicit, approved step."],
    unrelatedParentScenes: scenes.length === 0 ? "The parent has no production work yet." : null,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function registerDraftAgentRoutes(app, db, requireRole, { models = null } = {}) {
  const admin = requireRole("admin");
  const id = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500 && !error.status) console.error("Draft agent route failed:", error);
      res.status(status).json({ error: status >= 500 && !error.status ? "Something went wrong on the server." : error.message, code: error.code ?? null });
    }
  };
  const did = (req) => id(req.params.draftId) ?? 0;
  const ctx = (req) => (req.body?.context && typeof req.body.context === "object" ? req.body.context : {});
  const base = "/api/drafts/:draftId/agent";
  app.post(`${base}/interpret`, admin, wrap(async (req, res) => res.json(await interpret(db, models, did(req), { instruction: req.body?.instruction, source: req.body?.source ?? "text", context: ctx(req) }))));
  app.post(`${base}/propose`, admin, wrap(async (req, res) => res.status(201).json({ changeSet: await propose(db, models, did(req), { instruction: req.body?.instruction, intent: req.body?.intent ?? "SCOPED_REWRITE", targetKeys: Array.isArray(req.body?.targetKeys) ? req.body.targetKeys : [], context: ctx(req), constraints: req.body?.constraints ?? {}, confirmed: req.body?.confirmed === true, actorUserId: req.user?.id }) })));
  app.get(`${base}/change-sets`, admin, wrap(async (req, res) => res.json({ changeSets: await listChangeSets(db, did(req)) })));
  app.post("/api/drafts/change-sets/:id/apply", admin, wrap(async (req, res) => res.json({ changeSet: await applyChangeSet(db, id(req.params.id) ?? 0, { confirmEditApproved: req.body?.confirmEditApproved === true }) })));
  app.post("/api/drafts/change-sets/:id/reject", admin, wrap(async (req, res) => res.json({ changeSet: await rejectChangeSet(db, id(req.params.id) ?? 0) })));
  app.post("/api/drafts/change-sets/:id/undo", admin, wrap(async (req, res) => res.json({ changeSet: await undoChangeSet(db, id(req.params.id) ?? 0) })));
  app.post(`${base}/alternative`, admin, wrap(async (req, res) => res.status(201).json(await startAlternative(db, models, did(req), { instruction: req.body?.instruction, targetKeys: Array.isArray(req.body?.targetKeys) ? req.body.targetKeys : [], context: ctx(req), constraints: req.body?.constraints ?? {}, confirmed: req.body?.confirmed === true, actorUserId: req.user?.id }))));
  app.post(`${base}/revision`, admin, wrap(async (req, res) => res.status(202).json(await startRevision(db, models, did(req), { instruction: req.body?.instruction, constraints: req.body?.constraints ?? {}, source: req.body?.source ?? "text", context: ctx(req), label: req.body?.label ?? null, confirmed: req.body?.confirmed === true, actorUserId: req.user?.id }))));
  app.post(`${base}/new-story`, admin, wrap(async (req, res) => {
    const draft = await getDraft(db, did(req));
    const dest = req.body?.destination;
    if (!["same_project", "new_project"].includes(dest)) throw httpError('Choose where the new story goes: "same_project" or "new_project".', 400, "destination_required");
    res.status(201).json(await createBlank(db, draft, { destination: dest, idea: req.body?.idea, actorUserId: req.user?.id }));
  }));
  app.post(`${base}/continue`, admin, wrap(async (req, res) => { const d = await saveResume(db, did(req), {}); res.json({ draftId: d.id, projectRef: d.project_ref, module: d.module, stage: d.current_stage, context: d.resume_context }); }));
  app.get("/api/drafts/:draftId/requests", admin, wrap(async (req, res) => res.json({ requests: await listRequests(db, did(req)) })));
  app.get("/api/drafts/requests/:id", admin, wrap(async (req, res) => res.json(await revisionDetail(db, id(req.params.id) ?? 0))));
  app.post("/api/drafts/requests/:id/synopsis/approve", admin, wrap(async (req, res) => res.json({ request: await approveSynopsis(db, models, id(req.params.id) ?? 0, { expectedRevision: req.body?.expectedRevision ?? null, actorUserId: req.user?.id }) })));
  app.post("/api/drafts/requests/:id/synopsis/changes", admin, wrap(async (req, res) => res.json({ request: await requestSynopsisChanges(db, models, id(req.params.id) ?? 0, { feedback: req.body?.feedback, expectedRevision: req.body?.expectedRevision ?? null }) })));
  app.post("/api/drafts/requests/:id/retry", admin, wrap(async (req, res) => res.json({ request: await retryRequest(db, models, id(req.params.id) ?? 0) })));
  app.post("/api/drafts/requests/:id/cancel", admin, wrap(async (req, res) => res.json({ request: await cancelRequest(db, id(req.params.id) ?? 0) })));
  app.post("/api/drafts/requests/:id/approve", admin, wrap(async (req, res) => res.json(await approveFinal(db, id(req.params.id) ?? 0, { expectedRevision: req.body?.expectedRevision ?? null, actorUserId: req.user?.id }))));
  app.get("/api/drafts/:draftId/production-impact", admin, wrap(async (req, res) => res.json(await productionImpact(db, did(req)))));
}
