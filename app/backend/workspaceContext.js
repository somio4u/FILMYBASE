// Workspace Reader — lets the Auto Screenplay agent LOOK THROUGH the rest of the app (read-only).
//
// It can see every Film project (idea, pitch / synopsis, characters, three-act structure, bit sheet, scene list, screenplay)
// and every AI Movie project (idea, story, synopsis, plot, character arc, screenplay beats, assets, reference files).
// It never writes anything. The agent either gets sources the person picked, or finds related ones itself by matching the
// words of the new idea against what already exists; whatever it used is saved on the run so it can be shown afterwards.
//
// Material from other projects is given to the writer as INSPIRATION AND CONTINUITY ONLY: the new idea stays in charge.

const PART_LIMIT = 3500; // characters per part
const TOTAL_LIMIT = 14000; // characters for the whole block handed to the writer

const SKIP_KEYS = /^(id|ids|url|urls|created_?at|updated_?at|status|feedback|usage|tokens?|hash|version|order_?index)$/i;

// Turns any stored JSON (bilingual {en,hi} objects, arrays, nested sections) into readable plain text.
export function flatten(value, depth = 0) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => flatten(v, depth + 1)).filter(Boolean).join(depth > 1 ? "; " : "\n");
  if (typeof value === "object") {
    if (typeof value.en === "string" && value.en.trim()) return value.en.trim();
    if (typeof value.hi === "string" && value.hi.trim() && Object.keys(value).length <= 3) return value.hi.trim();
    const lines = [];
    for (const [k, v] of Object.entries(value)) {
      if (SKIP_KEYS.test(k)) continue;
      const text = flatten(v, depth + 1);
      if (!text) continue;
      lines.push(`${k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")}: ${text}`);
    }
    return lines.join("\n");
  }
  return "";
}

const clip = (text, max = PART_LIMIT) => (text.length > max ? `${text.slice(0, max).trimEnd()}… [cut for length]` : text);
const STOP = new Set("the and for with that this from into over under about have has had was were are his her their them they you your our out not but all any can will would could should one two its who what when where why how a an of to in on at by it is as be or if so we".split(" "));
const words = (text) => new Set(String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));

export const PART_LABELS = {
  idea: "The idea", story: "Story", synopsis: "Synopsis / pitch", characters: "Characters", structure: "Three-act structure", beats: "Beat sheet / plot",
  sceneList: "Scene list", screenplay: "Screenplay", assets: "Assets (people, places, things)", reference: "Reference files",
};

// ---------------------------------------------------------------------------
// Film projects (concepts → pitch deck → character sheet → three act → bit sheet → scene list → screenplay scenes)
// ---------------------------------------------------------------------------
async function filmParts(db, id) {
  const concept = (await db.query("SELECT id, title, concept_text, storylines, project_type, created_at FROM concepts WHERE id = $1", [id])).rows[0];
  if (!concept) return null;
  const latest = async (sql, params) => (await db.query(sql, params)).rows[0]?.content ?? null;
  const deck = (await db.query("SELECT id, content FROM pitch_decks WHERE concept_id = $1 ORDER BY id DESC LIMIT 1", [id])).rows[0];
  const sheet = deck ? await latest("SELECT content FROM character_sheets WHERE pitch_deck_id = $1 ORDER BY id DESC LIMIT 1", [deck.id]) : null;
  const act = deck ? (await db.query("SELECT id, content FROM three_act_structures WHERE pitch_deck_id = $1 ORDER BY id DESC LIMIT 1", [deck.id])).rows[0] : null;
  const bits = act ? (await db.query("SELECT id, content FROM bit_sheets WHERE three_act_structure_id = $1 ORDER BY id DESC LIMIT 1", [act.id])).rows[0] : null;
  const list = bits
    ? (await db.query("SELECT id, content FROM scene_lists WHERE bit_sheet_id = $1 ORDER BY id DESC LIMIT 1", [bits.id])).rows[0]
    : (await db.query("SELECT id, content FROM scene_lists WHERE concept_id = $1 ORDER BY id DESC LIMIT 1", [id])).rows[0];
  let screenplay = "";
  if (list) {
    const scenes = (await db.query(
      `SELECT DISTINCT ON (episode_index, scene_index) episode_index, scene_index, content FROM screenplay_scenes WHERE scene_list_id = $1 ORDER BY episode_index, scene_index, id DESC`, [list.id]
    )).rows;
    screenplay = scenes.map((s) => flatten(s.content)).join("\n\n");
  }
  return {
    kind: "film", id, title: concept.title || concept.concept_text.slice(0, 60), type: concept.project_type, createdAt: concept.created_at,
    parts: {
      idea: [concept.concept_text, flatten(concept.storylines)].filter(Boolean).join("\n"),
      synopsis: flatten(deck?.content), characters: flatten(sheet), structure: flatten(act?.content), beats: flatten(bits?.content), sceneList: flatten(list?.content), screenplay,
    },
  };
}

// ---------------------------------------------------------------------------
// AI Movie projects (pasted idea + backfill layers + assets + reference files)
// ---------------------------------------------------------------------------
async function aiMovieParts(db, id) {
  const p = (await db.query("SELECT id, title, pasted_text, backfill, assets, created_at FROM ai_movie_projects WHERE id = $1", [id])).rows[0];
  if (!p) return null;
  const b = p.backfill ?? {};
  const refs = (await db.query("SELECT category, label, content FROM ai_movie_reference_files WHERE project_id = $1 ORDER BY id", [id]).catch(() => ({ rows: [] }))).rows;
  let dossier = "";
  try {
    dossier = (await db.query("SELECT kind, name, agent_details, human_edits FROM production_assets WHERE project_id = $1 AND in_latest_import ORDER BY kind, code LIMIT 80", [id])).rows
      .map((a) => `${a.kind}: ${a.name}${flatten(a.human_edits ?? a.agent_details) ? ` — ${flatten(a.human_edits ?? a.agent_details).replace(/\n/g, "; ")}` : ""}`).join("\n");
  } catch { /* the production tables may not exist yet */ }
  return {
    kind: "ai_movie", id, title: p.title || p.pasted_text.slice(0, 60), type: "ai_movie", createdAt: p.created_at,
    parts: {
      idea: p.pasted_text, story: flatten(b.story), synopsis: flatten(b.synopsis), characters: flatten(b.characterArc), structure: flatten(b.threeAct), beats: flatten(b.plot),
      screenplay: flatten(b.screenplayBeats), assets: [flatten(p.assets), dossier].filter(Boolean).join("\n"), reference: refs.map((r) => `[${r.category}${r.label ? ` — ${r.label}` : ""}] ${r.content}`).join("\n\n"),
    },
  };
}

export async function readSource(db, kind, id, { parts = null } = {}) {
  const found = kind === "film" ? await filmParts(db, id) : kind === "ai_movie" ? await aiMovieParts(db, id) : null;
  if (!found) return null;
  const wanted = Array.isArray(parts) && parts.length ? parts : Object.keys(PART_LABELS);
  const out = {};
  for (const key of wanted) if (found.parts[key]) out[key] = clip(found.parts[key]);
  return { kind: found.kind, id: found.id, title: found.title, type: found.type, parts: out, available: Object.keys(found.parts).filter((k) => found.parts[k]).map((k) => ({ key: k, label: PART_LABELS[k], chars: found.parts[k].length })) };
}

// ---------------------------------------------------------------------------
// The catalogue: every project in the app, optionally ranked by how related it is to some text
// ---------------------------------------------------------------------------
export async function listSources(db, { query = "", exclude = [], limit = 60 } = {}) {
  const rows = [];
  // drafts of a project are shown inside that project (Draft Dashboard), not as projects of their own
  const film = (await db.query(`SELECT id, title, concept_text, project_type, created_at FROM concepts WHERE NOT EXISTS (SELECT 1 FROM project_drafts d JOIN project_drafts p ON p.id = d.parent_draft_id WHERE d.module = 'film' AND d.project_ref = concepts.id AND EXISTS (SELECT 1 FROM concepts pc WHERE pc.id = p.project_ref)) ORDER BY created_at DESC LIMIT 200`).catch(() => ({ rows: [] }))).rows;
  for (const c of film) rows.push({ kind: "film", id: c.id, title: c.title || c.concept_text.slice(0, 60), type: c.project_type === "production" ? "film (production only)" : "film / series", text: c.concept_text, createdAt: c.created_at });
  const ai = (await db.query(`SELECT id, title, pasted_text, backfill, created_at FROM ai_movie_projects WHERE NOT EXISTS (SELECT 1 FROM project_drafts d JOIN project_drafts p ON p.id = d.parent_draft_id WHERE d.module = 'ai_movie' AND d.project_ref = ai_movie_projects.id AND EXISTS (SELECT 1 FROM ai_movie_projects pc WHERE pc.id = p.project_ref)) ORDER BY created_at DESC LIMIT 200`).catch(() => ({ rows: [] }))).rows;
  for (const a of ai) rows.push({ kind: "ai_movie", id: a.id, title: a.title || a.pasted_text.slice(0, 60), type: "AI Movie", text: `${a.pasted_text} ${flatten(a.backfill?.synopsis)}`, createdAt: a.created_at });
  const q = words(query);
  const skip = new Set(exclude.map((e) => `${e.kind}:${e.id}`));
  const scored = rows.filter((r) => !skip.has(`${r.kind}:${r.id}`)).map((r) => {
    const w = words(`${r.title} ${r.text}`);
    let hit = 0;
    for (const x of q) if (w.has(x)) hit++;
    return { ...r, score: q.size ? hit / Math.sqrt(q.size * Math.max(1, w.size)) : 0, matched: hit };
  });
  scored.sort((a, b) => (q.size ? b.score - a.score : 0) || new Date(b.createdAt) - new Date(a.createdAt));
  return scored.slice(0, limit).map(({ text, ...r }) => ({ ...r, snippet: text.replace(/\s+/g, " ").slice(0, 160) }));
}

// Finds projects related to a new idea by shared meaningful words (cheap, no model call). Needs real overlap, never "closest of nothing".
export async function findRelated(db, idea, { exclude = [], max = 3 } = {}) {
  const ranked = await listSources(db, { query: idea, exclude });
  return ranked.filter((r) => r.matched >= 3 && r.score >= 0.08).slice(0, max);
}

// ---------------------------------------------------------------------------
// The block handed to the writer
// ---------------------------------------------------------------------------
export async function buildReferenceBlock(db, sources) {
  const used = [];
  const sections = [];
  let total = 0;
  for (const s of sources.slice(0, 6)) {
    const read = await readSource(db, s.kind, Number(s.id), { parts: s.parts ?? null });
    if (!read || Object.keys(read.parts).length === 0) continue;
    const body = Object.entries(read.parts).map(([k, text]) => `-- ${PART_LABELS[k] ?? k} --\n${text}`).join("\n\n");
    const section = `### From "${read.title}" (${read.kind === "film" ? "Film project" : "AI Movie project"} #${read.id})\n${body}`;
    if (total + section.length > TOTAL_LIMIT && sections.length > 0) continue;
    sections.push(clip(section, TOTAL_LIMIT - total));
    total += section.length;
    used.push({ kind: read.kind, id: read.id, title: read.title, parts: Object.keys(read.parts), how: s.how ?? "chosen" });
  }
  const text = sections.length
    ? `REFERENCE MATERIAL FROM OTHER PARTS OF THE APP (read-only). Use it for continuity, tone, characters, world and ideas the writer asked to build on. The NEW IDEA above is in charge: do not copy scenes or lines, do not let this material override it.\n\n${sections.join("\n\n")}`
    : "";
  return { text, used };
}

// A new idea plus the reference block, as one text for the writer (the person's own idea text is stored unchanged on the run).
export const ideaWithReferences = (idea, referenceContext) => (referenceContext ? `${idea}\n\n${referenceContext}` : idea);

export function registerWorkspaceRoutes(app, db, requireRole) {
  const admin = requireRole("admin");
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (error) {
      console.error("Workspace reader failed:", error.message);
      res.status(error.status ?? 500).json({ error: error.status ? error.message : "Something went wrong on the server." });
    }
  };
  app.get("/api/workspace/sources", admin, wrap(async (req, res) => {
    res.json({ sources: await listSources(db, { query: String(req.query.q ?? "") }), parts: PART_LABELS });
  }));
  app.get("/api/workspace/sources/:kind/:id", admin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!["film", "ai_movie"].includes(req.params.kind) || !Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Not a valid project." });
    const parts = typeof req.query.parts === "string" && req.query.parts ? req.query.parts.split(",") : null;
    const read = await readSource(db, req.params.kind, id, { parts });
    if (!read) return res.status(404).json({ error: "Project not found." });
    res.json(read);
  }));
  app.post("/api/workspace/related", admin, wrap(async (req, res) => {
    res.json({ related: await findRelated(db, String(req.body?.idea ?? ""), { exclude: Array.isArray(req.body?.exclude) ? req.body.exclude : [] }) });
  }));
}
