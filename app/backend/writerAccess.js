// Two writer logins share everything below:
//  • "Story & Screenplay Writer" (role "screenplay_writer"): a person the admin ASSIGNS to ONE project (users.concept_id), which he writes.
//  • "Independent Writer" (role "independent_writer"): nobody assigns him a project — he starts his OWN projects (concepts.owner_user_id) and writes
//    them, as many as he likes. He never sees anybody else's project.
// Each gets the Story & Screenplay tools of his project(s) — the story stages, writing and editing scenes, the voice assistant, change
// language, rename a character, scene list tools, exports of the script — and nothing else: no production, pictures, video, budget,
// no other project, no team management. Like the "Production only" login, every request must match the list below, and where the
// route names a project (directly or through a pitch deck, scene list …) it must be the project he is assigned to.
// The place where he stopped (stage, episode, scene) is saved on the server, so any device opens the page where he left off.

export const WRITER_ROLE = "screenplay_writer";
export const INDEPENDENT_WRITER_ROLE = "independent_writer";
export const isWriterRole = (role) => role === WRITER_ROLE || role === INDEPENDENT_WRITER_ROLE;

// May this user work on this project? The admin: any. Anyone else: the project assigned to him, or (an independent writer) a project he created.
// `user.ownedConceptIds` is filled in with every request of a writer (getCurrentUser in server.js).
export function userHasConcept(user, conceptId) {
  if (!user || conceptId == null) return false;
  if (user.role === "admin") return true;
  if (user.concept_id != null && String(user.concept_id) === String(conceptId)) return true;
  return Array.isArray(user.ownedConceptIds) && user.ownedConceptIds.includes(String(conceptId));
}

// [method regex, path regex, what the path/body names]
export const WRITER_ROUTES = [
  ["^(POST)$", /^\/api\/auth\/(login|logout)$/, null],
  ["^(GET)$", /^\/api\/auth\/me$/, null],
  ["^(GET)$", /^\/api\/health$/, null],
  ["^(GET)$", /^\/api\/concepts$/, null], // the route lists only his own project
  ["^(GET)$", /^\/api\/concepts\/(\d+)\/full$/, "concept"],
  ["^(POST)$", /^\/api\/concepts\/(\d+)\/title$/, "concept"],
  // starting a NEW project of his own (only the Independent Writer; the Idea stage, or "start from" a synopsis / bit sheet / scene one-liners): it becomes his (owner_user_id)
  ["^(POST)$", /^\/api\/(generate-storylines|skip-to-synopsis|skip-to-bitsheet|skip-to-scenelist|import-pdf-screenplay)$/, "newProject"],
  // the Buddy chat in the screenplay screen (the project is checked through its scene list)
  ["^(GET|DELETE)$", /^\/api\/assistant\/(\d+)\/history$/, "sceneList"],
  ["^(POST)$", /^\/api\/scene-lists\/(\d+)\/pdf-fill$/, "sceneList"],
  ["^(GET)$", /^\/api\/scene-lists\/(\d+)\/write-jobs\/current$/, "sceneList"],
  ["^(POST)$", /^\/api\/scene-lists\/(\d+)\/write-jobs$/, "sceneList"],
  ["^(POST)$", /^\/api\/scene-lists\/(\d+)\/write-jobs\/[A-Za-z0-9-]+\/stop$/, "sceneList"],
  ["^(POST)$", /^\/api\/assistant\/(\d+)\/(message|resolve)$/, "sceneList"],
  // following the "Let's go" job (its own jobs only — the route checks whose it is)
  ["^(GET)$", /^\/api\/skip-jobs\/(current|[A-Za-z0-9-]+)$/, null],
  // "Upload PDF instead" in the Idea / Synopsis / Bit Sheet / Scene one-liners boxes: Adu reads the pages of a PDF (a background job, polled)
  ["^(POST)$", /^\/api\/story-from-pdf$/, null],
  ["^(POST)$", /^\/api\/draft\/(analyze|read-file)$/, null],
  ["^(GET)$", /^\/api\/story-from-pdf\/[A-Za-z0-9-]+$/, null],
  // the story stages
  ["^(POST)$", /^\/api\/pitch-deck$/, "bodyConcept"],
  ["^(POST)$", /^\/api\/pitch-deck\/(\d+)\/(approve|request-changes|format|episode-title)$/, "pitchDeck"],
  ["^(GET)$", /^\/api\/pitch-deck\/(\d+)\/(export|export-ppt)$/, "pitchDeck"],
  ["^(POST)$", /^\/api\/three-act-structure$/, "bodyPitchDeck"],
  ["^(GET)$", /^\/api\/three-act-structure\/history$/, "queryPitchDeck"],
  ["^(GET)$", /^\/api\/three-act-structure\/(\d+)$/, "threeAct"],
  ["^(POST)$", /^\/api\/three-act-structure\/(\d+)\/(lock|request-changes)$/, "threeAct"],
  ["^(POST)$", /^\/api\/bit-sheet$/, "bodyThreeAct"],
  ["^(POST)$", /^\/api\/bit-sheet\/(\d+)\/(approve|request-changes)$/, "bitSheet"],
  ["^(POST)$", /^\/api\/character-sheet$/, "bodyPitchDeck"],
  ["^(POST)$", /^\/api\/character-sheet\/(\d+)\/(approve|request-changes|find-characters)$/, "characterSheet"],
  ["^(POST)$", /^\/api\/scene-list$/, "bodyBitSheet"],
  ["^(POST)$", /^\/api\/scene-list\/(\d+)\/(approve|request-changes)$/, "sceneList"],
  // the scene list and the written screenplay
  ["^(GET)$", /^\/api\/scene-lists\/(\d+)\/(breakdown-freshness|script-check|screenplay-pdf)$/, "sceneList"],
  ["^(POST)$", /^\/api\/scene-lists\/(\d+)\/(convert-language|rename-character|script-check)$/, "sceneList"],
  ["^(POST|DELETE|PATCH)$", /^\/api\/scene-lists\/(\d+)\/scenes(\/(move|duplicate|heading|plan))?$/, "sceneList"],
  ["^(PUT)$", /^\/api\/scene-lists\/(\d+)\/scene-tag$/, "sceneList"], // the writer may only mark a tagged scene "done" (sceneTags.js decides)
  ["^(GET)$", /^\/api\/scene-lists\/(\d+)\/sync$/, "sceneList"], // the 20-second "did anything change?" of the open screenplay
  ["^(GET)$", /^\/api\/language-jobs\/[A-Za-z0-9_-]+$/, null],
  ["^(GET)$", /^\/api\/screenplay\/scenes$/, "querySceneList"],
  ["^(POST)$", /^\/api\/screenplay\/scene$/, "bodySceneList"],
  ["^(POST)$", /^\/api\/screenplay\/scene\/(undo|redo|voice)$/, "bodySceneList"],
  ["^(POST)$", /^\/api\/screenplay\/scene\/(\d+)\/(edit|draft|request-changes)$/, "screenplayScene"],
  // the voice assistant and the 🎤 buttons
  ["^(POST)$", /^\/api\/voice\/understand$/, null],
  ["^(POST)$", /^\/api\/transcribe$/, null],
  // where he stopped
  ["^(GET|PUT)$", /^\/api\/writer\/progress$/, null],
];

export function matchWriterRoute(method, path) {
  for (const [methods, pattern, kind] of WRITER_ROUTES) {
    if (!new RegExp(methods).test(method)) continue;
    const match = path.match(pattern);
    if (match) return { pattern, kind, match };
  }
  return null;
}

const isId = (v) => /^\d+$/.test(String(v ?? ""));

// the project (concept) a matched request is about; null = it names none we can tie to a project
export async function writerTargetConcept(db, kind, match, req, sceneListConceptId) {
  const one = async (sql, id) => (isId(id) ? (await db.query(sql, [id])).rows[0]?.concept_id ?? null : null);
  const PITCH = "SELECT concept_id FROM pitch_decks WHERE id = $1";
  const THREE = "SELECT pd.concept_id FROM three_act_structures t JOIN pitch_decks pd ON pd.id = t.pitch_deck_id WHERE t.id = $1";
  const BIT = "SELECT pd.concept_id FROM bit_sheets b JOIN three_act_structures t ON t.id = b.three_act_structure_id JOIN pitch_decks pd ON pd.id = t.pitch_deck_id WHERE b.id = $1";
  const CHAR = "SELECT pd.concept_id FROM character_sheets c JOIN pitch_decks pd ON pd.id = c.pitch_deck_id WHERE c.id = $1";
  switch (kind) {
    case "newProject": return null; // names no project yet — the gatekeeper lets it through, the route makes the new project his
    case "concept": return match[1];
    case "bodyConcept": return isId(req.body?.conceptId) ? Number(req.body.conceptId) : null;
    case "pitchDeck": return one(PITCH, match[1]);
    case "bodyPitchDeck": return one(PITCH, req.body?.pitchDeckId);
    case "queryPitchDeck": return one(PITCH, req.query?.pitchDeckId);
    case "threeAct": return one(THREE, match[1]);
    case "bodyThreeAct": return one(THREE, req.body?.threeActStructureId);
    case "bitSheet": return one(BIT, match[1]);
    case "bodyBitSheet": return one(BIT, req.body?.bitSheetId);
    case "characterSheet": return one(CHAR, match[1]);
    case "sceneList": return sceneListConceptId(match[1]);
    case "querySceneList": return sceneListConceptId(req.query?.sceneListId);
    case "bodySceneList": return sceneListConceptId(req.body?.sceneListId);
    case "screenplayScene": {
      if (!isId(match[1])) return null;
      const row = (await db.query("SELECT scene_list_id FROM screenplay_scenes WHERE id = $1", [match[1]])).rows[0];
      return row ? sceneListConceptId(row.scene_list_id) : null;
    }
    default: return null;
  }
}

// Express middleware: lets a writer's request through (req.writerAllowed) only if it is on the list and about his own project.
export function writerGatekeeper(db, sceneListConceptId) {
  return async (req, res, next) => {
    if (!isWriterRole(req.user?.role) || !req.path.startsWith("/api/")) { next(); return; }
    const rule = matchWriterRoute(req.method, req.path);
    if (!rule) { res.status(403).json({ error: "This login can only write the screenplay of its own project." }); return; }
    if (rule.kind === "newProject" && req.user.role !== INDEPENDENT_WRITER_ROLE) {
      res.status(403).json({ error: "This login works on the project it was given — it cannot start new projects." });
      return;
    }
    if (rule.kind && rule.kind !== "newProject") {
      const concept = await writerTargetConcept(db, rule.kind, rule.match, req, sceneListConceptId);
      if (!userHasConcept(req.user, concept)) {
        res.status(403).json({ error: "You don't have access to this project." });
        return;
      }
      req.writerConceptId = concept;
    }
    req.writerAllowed = true;
    // note what he changed (which episode) once the request has succeeded — shown to the admin as "Work details"
    if (req.method !== "GET") {
      res.on("finish", () => {
        if (res.statusCode < 400) recordWriterWork(db, req).catch((error) => console.error("Writer activity not saved:", error.message));
      });
    }
    next();
  };
}

// What a successful writer request did, in plain terms: { action, episodeIndex, sceneIndex } — null if it is not screenplay work.
export function workOf(method, path, body) {
  const b = body && typeof body === "object" ? body : {};
  const place = (action) => ({
    action,
    episodeIndex: Number.isInteger(b.episodeIndex) ? b.episodeIndex : null,
    sceneIndex: Number.isInteger(b.sceneIndex) ? b.sceneIndex : null,
  });
  let m;
  if (method === "POST" && path === "/api/screenplay/scene") return place("write");
  if (method === "POST" && (m = path.match(/^\/api\/screenplay\/scene\/(undo|redo|voice)$/))) return place(m[1]);
  if (method === "POST" && (m = path.match(/^\/api\/screenplay\/scene\/(\d+)\/(edit|draft|request-changes)$/))) return { ...place(m[2] === "request-changes" ? "changes" : "edit"), sceneRowId: Number(m[1]) };
  if ((m = path.match(/^\/api\/scene-lists\/\d+\/scenes(?:\/(move|duplicate|heading))?$/))) {
    const action = m[1] ?? (method === "DELETE" ? "delete" : method === "POST" ? "add" : null);
    return action ? place(action) : null;
  }
  if (method === "PUT" && /^\/api\/scene-lists\/\d+\/scene-tag$/.test(path)) return place(b.tag === "done" ? "tagdone" : "tag");
  if (method === "POST" && /^\/api\/scene-lists\/\d+\/rename-character$/.test(path)) return b.preview === true ? null : { action: "rename", episodeIndex: null, sceneIndex: null };
  if (method === "POST" && /^\/api\/scene-lists\/\d+\/convert-language$/.test(path)) return { action: "convert", episodeIndex: null, sceneIndex: null };
  return null;
}

async function logWork(db, user, entry) {
  await db.query(
    "INSERT INTO writer_activity (user_id, concept_id, episode_index, scene_index, action) VALUES ($1, $2, $3, $4, $5)",
    [user.id, entry.conceptId ?? user.concept_id ?? null, entry.episodeIndex, entry.sceneIndex, entry.action]
  );
}

async function recordWriterWork(db, req) {
  const work = workOf(req.method, req.path, req.body);
  if (!work) return;
  if (work.sceneRowId) {
    const row = (await db.query("SELECT episode_index, scene_index FROM screenplay_scenes WHERE id = $1", [work.sceneRowId])).rows[0];
    if (row) { work.episodeIndex = row.episode_index; work.sceneIndex = row.scene_index; }
  }
  await logWork(db, req.user, { ...work, conceptId: req.writerConceptId ?? null });
}

export async function ensureWriterSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS writer_progress (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    concept_id INTEGER,
    state JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // one line per thing a writer did (or episode he opened): the admin's "Work details"
  await db.query(`CREATE TABLE IF NOT EXISTS writer_activity (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    concept_id INTEGER,
    episode_index INTEGER,
    scene_index INTEGER,
    action TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query("CREATE INDEX IF NOT EXISTS writer_activity_user_at ON writer_activity (user_id, at DESC)");
}

const STAGES = ["idea", "synopsis", "characters", "bitsheet", "screenplay"];
const int = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);

// only what is needed to reopen the page where it was left
export function cleanProgress(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    stage: STAGES.includes(s.stage) ? s.stage : "screenplay",
    groupIndex: int(s.groupIndex, 500) ?? 0, // the episode (0 for a film)
    sceneIndex: int(s.sceneIndex, 5000) ?? 0,
    editMode: s.editMode === true,
    scrollTop: int(Math.round(Number(s.scrollTop)), 5_000_000) ?? 0,
  };
}

export function registerWriterRoutes(app, db, requireRole) {
  // Admin: for each screenplay writer, the episodes he worked on (edits, scenes touched, first/last time) and his latest actions.
  app.get("/api/admin/writer-activity", requireRole("admin"), async (req, res) => {
    const userId = Number(req.query.userId);
    const where = Number.isInteger(userId) ? "AND a.user_id = $1" : "";
    const args = Number.isInteger(userId) ? [userId] : [];
    const episodes = (await db.query(
      `SELECT a.user_id, a.episode_index,
              count(*) FILTER (WHERE a.action <> 'open')::int AS changes,
              count(*) FILTER (WHERE a.action = 'open')::int AS opens,
              count(DISTINCT a.scene_index) FILTER (WHERE a.action <> 'open' AND a.scene_index IS NOT NULL)::int AS scenes,
              min(a.at) AS first_at, max(a.at) AS last_at
       FROM writer_activity a WHERE true ${where}
       GROUP BY a.user_id, a.episode_index ORDER BY a.user_id, max(a.at) DESC`, args)).rows;
    const recent = (await db.query(
      `SELECT a.user_id, a.episode_index, a.scene_index, a.action, a.at
       FROM writer_activity a WHERE true ${where} ORDER BY a.at DESC, a.id DESC LIMIT 40`, args)).rows;
    res.json({ episodes, recent });
  });

  app.get("/api/writer/progress", async (req, res) => {
    if (!req.user) { res.status(401).json({ error: "Please log in." }); return; }
    const row = (await db.query("SELECT concept_id, state, updated_at FROM writer_progress WHERE user_id = $1", [req.user.id])).rows[0];
    res.json(row ? { conceptId: row.concept_id, state: row.state, updatedAt: row.updated_at } : null);
  });
  app.put("/api/writer/progress", async (req, res) => {
    if (!req.user) { res.status(401).json({ error: "Please log in." }); return; }
    if (!isWriterRole(req.user.role)) { res.json({ saved: false }); return; } // only a writer's place is remembered
    const state = cleanProgress(req.body);
    const before = (await db.query("SELECT state FROM writer_progress WHERE user_id = $1", [req.user.id])).rows[0]?.state;
    if (state.stage === "screenplay" && (before?.stage !== "screenplay" || before?.groupIndex !== state.groupIndex)) {
      await logWork(db, req.user, { action: "open", episodeIndex: state.groupIndex, sceneIndex: state.sceneIndex });
    }
    await db.query(
      `INSERT INTO writer_progress (user_id, concept_id, state, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET concept_id = EXCLUDED.concept_id, state = EXCLUDED.state, updated_at = now()`,
      [req.user.id, req.user.concept_id, JSON.stringify(state)]
    );
    res.json({ saved: true, state });
  });
}
