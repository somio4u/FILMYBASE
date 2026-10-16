// The "Screenplay writer" login (role "screenplay_writer"): a person assigned to ONE project who writes its screenplay and dialogue.
// He gets the Story & Screenplay tools of that project — the story stages, writing and editing scenes, the voice assistant, change
// language, rename a character, scene list tools, exports of the script — and nothing else: no production, pictures, video, budget,
// no other project, no team management. Like the "Production only" login, every request must match the list below, and where the
// route names a project (directly or through a pitch deck, scene list …) it must be the project he is assigned to.
// The place where he stopped (stage, episode, scene) is saved on the server, so any device opens the page where he left off.

export const WRITER_ROLE = "screenplay_writer";

// [method regex, path regex, what the path/body names]
export const WRITER_ROUTES = [
  ["^(POST)$", /^\/api\/auth\/(login|logout)$/, null],
  ["^(GET)$", /^\/api\/auth\/me$/, null],
  ["^(GET)$", /^\/api\/health$/, null],
  ["^(GET)$", /^\/api\/concepts$/, null], // the route lists only his own project
  ["^(GET)$", /^\/api\/concepts\/(\d+)\/full$/, "concept"],
  ["^(POST)$", /^\/api\/concepts\/(\d+)\/title$/, "concept"],
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
  ["^(GET)$", /^\/api\/language-jobs\/[A-Za-z0-9_-]+$/, null],
  ["^(GET)$", /^\/api\/screenplay\/scenes$/, "querySceneList"],
  ["^(POST)$", /^\/api\/screenplay\/scene$/, "bodySceneList"],
  ["^(POST)$", /^\/api\/screenplay\/scene\/(undo|redo|voice)$/, "bodySceneList"],
  ["^(POST)$", /^\/api\/screenplay\/scene\/(\d+)\/(edit|request-changes)$/, "screenplayScene"],
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
    if (req.user?.role !== WRITER_ROLE || !req.path.startsWith("/api/")) { next(); return; }
    const rule = matchWriterRoute(req.method, req.path);
    if (!rule) { res.status(403).json({ error: "This login can only write the screenplay of its own project." }); return; }
    if (rule.kind) {
      const concept = await writerTargetConcept(db, rule.kind, rule.match, req, sceneListConceptId);
      if (concept == null || req.user.concept_id == null || String(concept) !== String(req.user.concept_id)) {
        res.status(403).json({ error: "You don't have access to this project." });
        return;
      }
    }
    req.writerAllowed = true;
    next();
  };
}

export async function ensureWriterSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS writer_progress (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    concept_id INTEGER,
    state JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
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

export function registerWriterRoutes(app, db) {
  app.get("/api/writer/progress", async (req, res) => {
    if (!req.user) { res.status(401).json({ error: "Please log in." }); return; }
    const row = (await db.query("SELECT concept_id, state, updated_at FROM writer_progress WHERE user_id = $1", [req.user.id])).rows[0];
    res.json(row ? { conceptId: row.concept_id, state: row.state, updatedAt: row.updated_at } : null);
  });
  app.put("/api/writer/progress", async (req, res) => {
    if (!req.user) { res.status(401).json({ error: "Please log in." }); return; }
    if (req.user.role !== WRITER_ROLE) { res.json({ saved: false }); return; } // only a writer's place is remembered
    const state = cleanProgress(req.body);
    await db.query(
      `INSERT INTO writer_progress (user_id, concept_id, state, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET concept_id = EXCLUDED.concept_id, state = EXCLUDED.state, updated_at = now()`,
      [req.user.id, req.user.concept_id, JSON.stringify(state)]
    );
    res.json({ saved: true, state });
  });
}
