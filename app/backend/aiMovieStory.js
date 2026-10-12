// The Auto Storyteller inside AI Movie.
//
// This file does NOT contain a second story engine. The writers' room itself
// (storyBrain.js: head writer + three critics) and the stage writers in
// server.js are the same ones the Film module uses; this file is the AI Movie
// side of the wiring:
//   * the Story Bible stage (design / your note / approve) saved on the AI Movie project,
//   * the Story / Audience / Cinematic judges and the Script Editor that consolidates them,
//   * the stage-by-stage judge -> revise loop for Synopsis, Characters, Three-Act and Beat Sheet,
//   * quality mode + creative mode settings,
//   * the money guard: every paid model call is checked against the project's money limit first
//     (pipelineSettings.js assertWithinBudget) and written to the same spend ledger after.
// Film projects never touch any of it (separate tables / columns, separate routes).

import crypto from "node:crypto";
import { marked } from "marked";
import { assertWithinBudget, recordSpend, spendSummary } from "./pipelineSettings.js";
import { DEFAULT_QUALITY_MODE, estimateCost, modelFor, normalizeQualityMode, QUALITY_MODES, QUALITY_MODE_INFO, routingTable, textPrices } from "./modelRouting.js";

export const CREATIVE_MODES = ["balanced", "mass"];
export const DEFAULT_CREATIVE_MODE = "mass";
export const CREATIVE_MODE_INFO = {
  balanced: { label: "Balanced Cinematic", blurb: "Story-oriented filmmaking with selective spectacle." },
  mass: { label: "Mass Spectacle", blurb: "High-impact hero moments, visually ambitious action, grand staging and powerful cinematic payoffs." },
};

export async function ensureAiMovieStorySchema(db) {
  const statements = [
    `ALTER TABLE ai_movie_projects ADD COLUMN IF NOT EXISTS story_bible JSONB`,
    `ALTER TABLE ai_movie_projects ADD COLUMN IF NOT EXISTS story_bible_usage JSONB`,
    `ALTER TABLE ai_movie_projects ADD COLUMN IF NOT EXISTS story_bible_job JSONB`,
    `ALTER TABLE ai_movie_projects ADD COLUMN IF NOT EXISTS quality_mode TEXT NOT NULL DEFAULT 'professional'`,
    `ALTER TABLE ai_movie_projects ADD COLUMN IF NOT EXISTS cinematic_mode TEXT NOT NULL DEFAULT 'mass'`,
    `CREATE TABLE IF NOT EXISTS ai_movie_review_cache (
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      cache_key TEXT NOT NULL,
      result JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, cache_key)
    )`,
  ];
  for (const sql of statements) await db.query(sql);
}

const httpError = (message, status = 400, code = null) => Object.assign(new Error(message), { status, code });
const sha = (text) => crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 32);

// ---------------------------------------------------------------------------
// The one door for paid text calls: pick the model for this agent + the project's
// quality mode, check the money limit, call, write the spend.
// callTier(tier, { systemInstruction, contents, responseSchema, maxOutputTokens }) -> parsed JSON
// is supplied by the server (Pro -> the Story Brain's Gemini 3.1 Pro chain, flash/flashLite -> Gemini).
// ---------------------------------------------------------------------------

export async function getProjectModes(db, projectId) {
  const row = (await db.query("SELECT quality_mode, cinematic_mode FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0];
  if (!row) throw httpError("Project not found.", 404);
  return {
    qualityMode: normalizeQualityMode(row.quality_mode),
    cinematicMode: CREATIVE_MODES.includes(row.cinematic_mode) ? row.cinematic_mode : DEFAULT_CREATIVE_MODE,
  };
}

export function createAiMovieAsker({ db, callTier }) {
  async function ask(projectId, agentId, params, { skipBudget = false, forcePro = false, calls = 1 } = {}) {
    const { qualityMode } = await getProjectModes(db, projectId);
    const route = modelFor(agentId, qualityMode, { forcePro });
    const estimate = estimateCost(route.tier, calls);
    if (!skipBudget) await assertWithinBudget(db, projectId, estimate);
    const data = await callTier(route.tier, params);
    await recordSpend(db, projectId, { kind: "text", provider: route.label, units: calls, costUsd: estimate, ref: agentId });
    return { data, route, qualityMode };
  }
  return { ask, getModes: (projectId) => getProjectModes(db, projectId) };
}

// Pro-model token prices (US dollars per million tokens), estimates for the money guard.
function tokenCostUsd(usage, env = process.env) {
  const inputPerM = Number(env.COST_PRO_INPUT_PER_M ?? 2);
  const outputPerM = Number(env.COST_PRO_OUTPUT_PER_M ?? 12);
  return Math.round(((usage.promptTokens ?? 0) * inputPerM + ((usage.outputTokens ?? 0) + (usage.thinkingTokens ?? 0)) * outputPerM) / 1e6 * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Judge text for AI Movie's own story layers (bilingual objects; judges read English)
// ---------------------------------------------------------------------------

const en = (v) => (v && typeof v === "object" ? v.en ?? "" : v ?? "");

export function stageJudgeText(stageKey, content) {
  if (stageKey === "synopsis") {
    return `LOGLINE: ${en(content.logline)}\nPREMISE: ${en(content.premise)}\nTONE/GENRE: ${en(content.toneGenre)}\nTARGET AUDIENCE: ${en(content.targetAudience)}`;
  }
  if (stageKey === "characterArc") {
    return (content ?? []).map((c) => `- ${c.name}: wants ${en(c.want)} / needs ${en(c.need)} / arc: ${en(c.arc)}`).join("\n");
  }
  if (stageKey === "threeAct") {
    return (content ?? []).map((a) => `${en(a.actName)}: ${en(a.description)} (turning point: ${en(a.turningPoint)})`).join("\n\n");
  }
  if (stageKey === "plot") {
    return (content ?? []).map((b, i) => `Beat ${i + 1} — ${en(b.title)} (${b.runtimeMinutes ?? "?"} min): ${en(b.description)}`).join("\n");
  }
  return JSON.stringify(content);
}

export const AI_MOVIE_STAGE_CHECKLIST_KEY = { synopsis: "pitchDeck", characterArc: "pitchDeck", threeAct: "threeAct", plot: "bitSheet" };

const JUDGE_SCHEMA = {
  type: "OBJECT",
  properties: {
    score: { type: "INTEGER", description: "1-10, strict. 7 = usable (the pass mark), 8 = strong, 10 = excellent." },
    verdict: { type: "STRING", description: "Two or three sentences: the honest overall verdict." },
    strengths: { type: "ARRAY", items: { type: "STRING" } },
    problems: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          where: { type: "STRING", description: "Exactly where (the beat, act, character or scene)." },
          severity: { type: "STRING", enum: ["blocker", "major", "minor"] },
          issue: { type: "STRING", description: "What is wrong, concretely." },
          fix: { type: "STRING", description: "A concrete change that would fix it." },
        },
        required: ["where", "severity", "issue", "fix"],
      },
    },
    criticalProblem: { type: "STRING", description: "A must-fix problem from the MUST-FIX list and where, or an empty string." },
  },
  required: ["score", "verdict", "strengths", "problems", "criticalProblem"],
};

const JUDGE_SYSTEM = "You are a blunt, specific, experienced judge in a film-development team. Never inflate scores. Every problem you raise names where it is and gives a concrete fix — no generic remarks. You judge only what is in front of you and give your own independent opinion.";

export const JUDGE_ROLES = {
  "story-judge": {
    label: "Story Judge",
    rubric: `- Narrative structure: does it build, turn and land?\n- Plot logic and continuity: cause and effect, who knows what and when, no contradictions.\n- Character development: wants, needs, choices and real change.\n- Conflict and resolution: strong opposition, rising stakes, a climax won by the hero's own choice.\n- Originality: what is fresh here and what is stock.`,
  },
  "audience-judge": {
    label: "Audience Judge",
    rubric: `- Engagement: would a mass audience keep watching, scene after scene?\n- Pacing: where does it sag, rush or repeat?\n- Emotional impact: where will people laugh, cry or cheer, and where is it flat?\n- Mass audience appeal: clear hero, clear wants, easy to follow and talk about.\n- Entertainment value: set pieces, twists, memorable moments.`,
  },
  "cinematic-judge": {
    label: "Cinematic Judge",
    rubric: `- Visual storytelling: is the story told in images and action, or in talk?\n- Action potential: fights, chases, set pieces that grow out of the story.\n- Hero and villain elevation: grand introductions and memorable presence.\n- Cinematic spectacle: places, scale, reveals, signature moments an audience remembers.\n- AI filmmaking feasibility: can each big idea be made with AI pictures and video, shot by shot, with consistent characters, costumes and places?`,
  },
};

function judgePrompt(role, targetLabel, text, { idea, checklist, criticalChecks } = {}) {
  const must = criticalChecks?.length ? `\n\nMUST-FIX LIST (put the first that applies in "criticalProblem", with where; otherwise leave it empty):\n${criticalChecks.map((c) => `- ${c}`).join("\n")}` : "";
  const list = checklist ? `\n\nAlso check it against this checklist:\n${checklist}` : "";
  return `${idea ? `THE USER'S ORIGINAL IDEA (the story must stay true to it):\n${idea}\n\n` : ""}You are the ${JUDGE_ROLES[role].label}. Judge this ${targetLabel}:\n\n${text}\n\nYOUR RUBRIC:\n${JUDGE_ROLES[role].rubric}${list}${must}\n\nScore from 1 to 10 (7 = usable, the pass mark; be strict). List every real problem with where it is, how serious it is, and a concrete fix (at most 10, most serious first). A blocker means it breaks the story's premise, logic or climax.`;
}

// ---------------------------------------------------------------------------
// Stage-by-stage judging: writer -> Story Judge (Pro) -> revise, until it passes
// or the revision cap for the quality mode is reached. Keeps the BEST version.
// ---------------------------------------------------------------------------

export const MAX_REVISIONS = { economy: 1, professional: 2, maximum: 3 };
export const PASS_SCORE = 7;

function feedbackFrom(judged) {
  const lines = (judged.problems ?? []).filter((p) => p.severity !== "minor").map((p) => `[${p.severity.toUpperCase()}] ${p.where}: ${p.issue} → ${p.fix}`);
  const minors = (judged.problems ?? []).filter((p) => p.severity === "minor").map((p) => `[minor] ${p.where}: ${p.issue} → ${p.fix}`);
  return [judged.criticalProblem ? `MUST FIX: ${judged.criticalProblem}` : null, ...lines, ...minors, judged.verdict].filter(Boolean).join("\n");
}

export async function judgedStage({ ask, projectId, stageKey, idea, firstDraft, revise, checklists = {}, criticalChecks = [], maxRevisions = null }) {
  const { qualityMode } = await ask.getModes(projectId);
  const cap = maxRevisions ?? MAX_REVISIONS[qualityMode];
  const checklist = checklists[AI_MOVIE_STAGE_CHECKLIST_KEY[stageKey]] ?? null;
  const versions = [];
  let draft = firstDraft;
  let best = null;
  let route = null;

  for (let version = 1; ; version++) {
    const text = stageJudgeText(stageKey, draft);
    const result = await ask.ask(projectId, "story-judge", {
      systemInstruction: JUDGE_SYSTEM,
      contents: judgePrompt("story-judge", `"${stageKey}" stage of the screenplay in development`, text, { idea, checklist, criticalChecks }),
      responseSchema: JUDGE_SCHEMA,
      maxOutputTokens: 8192,
    });
    route = result.route;
    const judged = result.data;
    const blocking = Boolean((judged.criticalProblem ?? "").trim()) || (judged.problems ?? []).some((p) => p.severity === "blocker");
    const score = Number(judged.score) || 0;
    versions.push({ version, score, verdict: judged.verdict, blocking, problems: judged.problems ?? [], criticalProblem: judged.criticalProblem || null });
    const beats = !best || (best.blocking && !blocking) || (best.blocking === blocking && score >= best.score);
    if (beats) best = { draft, score, blocking, version };
    if ((score >= PASS_SCORE && !blocking) || version > cap) break;
    draft = await revise(draft, feedbackFrom(judged));
  }
  return { content: best.draft, judge: { versions, kept: best.version, keptScore: best.score, passScore: PASS_SCORE, passed: best.score >= PASS_SCORE && !best.blocking, qualityMode, model: route?.label ?? null, maxRevisions: cap } };
}

// ---------------------------------------------------------------------------
// The three independent judges + the Pro Script Editor that consolidates them
// ---------------------------------------------------------------------------

const EDITOR_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    recommendation: { type: "STRING", enum: ["approve", "revise"] },
    contradictions: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { between: { type: "STRING" }, issue: { type: "STRING" }, resolution: { type: "STRING" } }, required: ["between", "issue", "resolution"] },
    },
    consolidatedFixes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          target: { type: "STRING", description: "Exactly which scene, beat, act or character to change." },
          fix: { type: "STRING" },
          priority: { type: "STRING", enum: ["high", "medium", "low"] },
          fromJudges: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["target", "fix", "priority", "fromJudges"],
      },
    },
  },
  required: ["summary", "recommendation", "contradictions", "consolidatedFixes"],
};

const EDITOR_SYSTEM = "You are the Script Editor: the person who reads three independent judges' reports on the same material, finds where they contradict each other or the material, and decides a short list of targeted corrections. You never rewrite the material yourself — you say exactly what to change and where. The human makes the final decision.";

async function cached(db, projectId, key, produce) {
  const hit = (await db.query("SELECT result FROM ai_movie_review_cache WHERE project_id = $1 AND cache_key = $2", [projectId, key])).rows[0];
  if (hit) return { ...hit.result, cached: true };
  const fresh = await produce();
  await db.query("INSERT INTO ai_movie_review_cache (project_id, cache_key, result) VALUES ($1,$2,$3) ON CONFLICT (project_id, cache_key) DO UPDATE SET result = EXCLUDED.result, created_at = now()", [projectId, key, JSON.stringify(fresh)]);
  return { ...fresh, cached: false };
}

// targetKey names what is judged ("bible", "stage:synopsis", "beat:4", "screenplay") so an unchanged
// target is answered from the cache, and only changed beats are paid for again.
export async function runJudgePanel({ db, ask, projectId, targetKey, targetLabel, text, idea, checklist = null, criticalChecks = [], force = false }) {
  const { qualityMode } = await ask.getModes(projectId);
  const roles = Object.keys(JUDGE_ROLES);
  const keyOf = (agent) => `${agent}|${modelFor(agent, qualityMode).label}|${targetKey}|${sha(text)}`;
  const panelKey = `panel|${qualityMode}|${targetKey}|${sha(text)}`;
  if (!force) {
    const hit = (await db.query("SELECT result FROM ai_movie_review_cache WHERE project_id = $1 AND cache_key = $2", [projectId, panelKey])).rows[0];
    if (hit) return { ...hit.result, cached: true };
  }
  // One money check for the whole panel (3 judges + the editor) before anything is paid for.
  const total = roles.reduce((sum, r) => sum + estimateCost(modelFor(r, qualityMode).tier), 0) + estimateCost(modelFor("script-editor", qualityMode).tier);
  await assertWithinBudget(db, projectId, total);

  // Independent: each judge gets only the material and its own rubric, in parallel, never another judge's answer.
  const reports = await Promise.all(
    roles.map(async (role) => {
      const run = async () => (await ask.ask(projectId, role, { systemInstruction: JUDGE_SYSTEM, contents: judgePrompt(role, targetLabel, text, { idea, checklist, criticalChecks }), responseSchema: JUDGE_SCHEMA, maxOutputTokens: 8192 }, { skipBudget: true })).data;
      const data = force ? await run() : (await cached(db, projectId, keyOf(role), run));
      return { role, label: JUDGE_ROLES[role].label, ...data };
    })
  );
  const editorText = reports.map((r) => `${r.label.toUpperCase()} — score ${r.score}/10. ${r.verdict}\nPROBLEMS:\n${(r.problems ?? []).map((p) => `- [${p.severity}] ${p.where}: ${p.issue} → ${p.fix}`).join("\n") || "(none)"}`).join("\n\n");
  const editor = (await ask.ask(projectId, "script-editor", {
    systemInstruction: EDITOR_SYSTEM,
    contents: `THE MATERIAL (${targetLabel}):\n${text}\n\nTHE THREE INDEPENDENT JUDGES' REPORTS:\n${editorText}\n\nConsolidate: (1) list every place where the judges contradict each other or the material, with how to resolve it; (2) give a short, prioritised list of targeted corrections, each saying exactly which scene/beat/act/character to change and how, and which judges raised it; (3) recommend "approve" only if no blocker or high-priority fix remains.`,
    responseSchema: EDITOR_SCHEMA,
    maxOutputTokens: 8192,
  }, { skipBudget: true })).data;

  const result = {
    targetKey, targetLabel, qualityMode,
    judges: reports.map(({ role, label, score, verdict, strengths, problems, criticalProblem, cached: c }) => ({ role, label, score, verdict, strengths, problems, criticalProblem, cached: Boolean(c) })),
    editor,
    models: { judges: modelFor("story-judge", qualityMode).label, editor: modelFor("script-editor", qualityMode).label },
  };
  await db.query("INSERT INTO ai_movie_review_cache (project_id, cache_key, result) VALUES ($1,$2,$3) ON CONFLICT (project_id, cache_key) DO UPDATE SET result = EXCLUDED.result, created_at = now()", [projectId, panelKey, JSON.stringify(result)]);
  return { ...result, cached: false };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function renderBibleHtml(markdownText, title) {
  const safe = String(title ?? "Story Bible").replace(/[<>&"]/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${safe} — Story Bible</title><style>
body{font-family:Georgia,'Times New Roman',serif;max-width:860px;margin:0 auto;padding:24px 16px;line-height:1.55;color:#1a1a1a;background:#fff}
h1{color:#5a0d0d;border-bottom:3px solid #8b1a1a;padding-bottom:6px}h2{color:#8b1a1a;border-bottom:1px solid #ddd;padding-bottom:3px;margin-top:28px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid #ccc;padding:6px;vertical-align:top;text-align:left}th{background:#f3e9e9}
em{color:#555}@media print{body{padding:0}}
</style></head><body>${marked.parse(markdownText)}</body></html>`;
}

const JOB_STALE_MS = 20 * 60 * 1000;

export function registerAiMovieStoryRoutes(app, db, requireRole, deps) {
  const { storyBrain, callTier, onBibleApproved = async () => {} } = deps;
  const admin = requireRole("admin");
  const ask = createAiMovieAsker({ db, callTier });
  const id = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error("AI Movie story route failed:", error);
      res.status(status).json({ error: status >= 500 && !error.status ? "Something went wrong on the server." : error.message, code: error.code ?? null });
    }
  };
  const loadProject = async (req) => {
    const projectId = id(req.params.id);
    if (!projectId) throw httpError("Not a valid project.", 400);
    const row = (await db.query("SELECT * FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0];
    if (!row) throw httpError("Project not found.", 404);
    return { projectId, row };
  };
  const bibleView = (row) => ({
    bible: row.story_bible ?? null,
    markdown: row.story_bible ? storyBrain.storyBibleToMarkdown(row.story_bible, row.story_bible_usage) : null,
    status: row.story_bible ? row.stage_status?.storyBible?.status ?? "pending" : "none",
    job: row.story_bible_job ?? null,
    passScore: storyBrain.BIBLE_PASS_SCORE,
  });

  async function setJob(projectId, patch) {
    await db.query("UPDATE ai_movie_projects SET story_bible_job = COALESCE(story_bible_job, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1", [projectId, JSON.stringify(patch)]);
  }
  async function note(projectId, text) {
    await db.query(
      `UPDATE ai_movie_projects SET story_bible_job = jsonb_set(COALESCE(story_bible_job, '{}'::jsonb), '{notes}', COALESCE(story_bible_job->'notes', '[]'::jsonb) || to_jsonb($2::text)), updated_at = now() WHERE id = $1`,
      [projectId, text]
    );
  }

  // Runs one Story Brain job (design or revise) in the background; the screen polls the project.
  function startJob(projectId, label, work) {
    (async () => {
      try {
        const { bible, usage } = await work((step) => note(projectId, `Story Brain: ${step}…`).catch(() => {}));
        const prior = (await db.query("SELECT story_bible_usage FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0]?.story_bible_usage;
        const total = prior ? { calls: prior.calls + usage.calls, promptTokens: prior.promptTokens + usage.promptTokens, outputTokens: prior.outputTokens + usage.outputTokens, thinkingTokens: prior.thinkingTokens + usage.thinkingTokens, models: [...new Set([...(prior.models ?? []), ...usage.models])] } : usage;
        await db.query(
          "UPDATE ai_movie_projects SET story_bible = $2, story_bible_usage = $3, stage_status = COALESCE(stage_status,'{}'::jsonb) || $4::jsonb, updated_at = now() WHERE id = $1",
          [projectId, JSON.stringify(bible), JSON.stringify(total), JSON.stringify({ storyBible: { status: "pending", feedback: null } })]
        );
        await recordSpend(db, projectId, { kind: "text", provider: "Gemini 3.1 Pro (Story Brain)", units: usage.calls, costUsd: tokenCostUsd(usage), ref: `story-brain:${label}` });
        const scores = Object.values(bible.review?.scores ?? {}).join(" / ");
        await note(projectId, bible.review?.passed ? `Story Bible ready — the critics passed it (${scores}). Waiting for your approval.` : `Story Bible ready, but the critics didn't all reach ${storyBrain.BIBLE_PASS_SCORE} (${scores}) — read the open problems and give a note, or approve it as it is.`);
        await setJob(projectId, { status: "idle", error: null });
      } catch (error) {
        console.error(`Story Brain failed for AI Movie project ${projectId}:`, error.message);
        await setJob(projectId, { status: "failed", error: `The Story Brain stopped: ${error.message}` }).catch(() => {});
      }
    })();
  }
  const assertNoJobRunning = (row) => {
    const job = row.story_bible_job;
    if (job?.status === "running" && Date.now() - new Date(job.startedAt ?? 0).getTime() < JOB_STALE_MS) throw httpError("The Story Brain is already working on this project — wait for it to finish.", 409, "busy");
  };
  const beginJob = (projectId, title) => setJob(projectId, { status: "running", title, startedAt: new Date().toISOString(), error: null });

  app.get("/api/ai-movie/projects/:id/story-bible", admin, wrap(async (req, res) => {
    const { row } = await loadProject(req);
    res.json(bibleView(row));
  }));

  app.get("/api/ai-movie/projects/:id/story-bible.html", admin, wrap(async (req, res) => {
    const { row } = await loadProject(req);
    if (!row.story_bible) throw httpError("No Story Bible for this project yet.", 404);
    res.type("html").send(renderBibleHtml(storyBrain.storyBibleToMarkdown(row.story_bible, row.story_bible_usage), row.story_bible.promise?.title));
  }));

  // Step "Auto Storyteller": the Story Brain designs the Bible from the idea. Costly (Pro), so it asks the money guard first.
  app.post("/api/ai-movie/projects/:id/story-bible/design", admin, wrap(async (req, res) => {
    const { projectId, row } = await loadProject(req);
    assertNoJobRunning(row);
    const idea = String(req.body?.idea ?? row.pasted_text ?? "").trim();
    if (!idea) throw httpError("Write the story idea first.", 400);
    const format = req.body?.format?.type === "series"
      ? { type: "series", episodeCount: Number(req.body.format.episodeCount) || 8, episodeMinutes: Number(req.body.format.episodeMinutes) || 20 }
      : { type: "film", runtimeMinutes: Number(req.body?.format?.runtimeMinutes) || 120 };
    await assertWithinBudget(db, projectId, Number(process.env.COST_STORY_BIBLE_RUN ?? 1.5));
    await beginJob(projectId, "Designing the Story Bible");
    await db.query("UPDATE ai_movie_projects SET story_bible_job = story_bible_job - 'notes' WHERE id = $1", [projectId]);
    startJob(projectId, "design", (onProgress) => storyBrain.designStoryBible(idea, format, { onProgress }));
    res.json({ started: true });
  }));

  // Revising with a note: the user's own note, or the Cinematic Director's approved recommendations.
  // Either way it is the same Story Brain path (head writer revises, critics re-score) and the Bible goes back to waiting for approval.
  async function requestRevision(projectId, text) {
    const row = (await db.query("SELECT story_bible, story_bible_job FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0];
    if (!row?.story_bible) throw httpError("There is no Story Bible to revise yet.", 400);
    assertNoJobRunning(row);
    await assertWithinBudget(db, projectId, Number(process.env.COST_STORY_BIBLE_REVISION ?? 0.8));
    await beginJob(projectId, "Revising the Story Bible");
    await note(projectId, `Your note: ${text}`);
    startJob(projectId, "note", (onProgress) => storyBrain.reviseBibleWithNote(row.story_bible, text, { onProgress }));
  }

  app.post("/api/ai-movie/projects/:id/story-bible/note", admin, wrap(async (req, res) => {
    const { projectId } = await loadProject(req);
    const text = String(req.body?.note ?? "").trim();
    if (!text) throw httpError("Write a note first.", 400);
    await requestRevision(projectId, text);
    res.json({ started: true });
  }));

  app.post("/api/ai-movie/projects/:id/story-bible/approve", admin, wrap(async (req, res) => {
    const { projectId, row } = await loadProject(req);
    if (!row.story_bible) throw httpError("There is no Story Bible to approve yet.", 400);
    assertNoJobRunning(row);
    await db.query("UPDATE ai_movie_projects SET stage_status = COALESCE(stage_status,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1", [projectId, JSON.stringify({ storyBible: { status: "approved", feedback: null } })]);
    const markdown = storyBrain.storyBibleToMarkdown({ ...row.story_bible, pitchRoom: null, review: null });
    await onBibleApproved(projectId, row.story_bible, markdown);
    res.json({ ok: true });
  }));

  // ---- settings: quality mode, creative mode, routing table, spend ----
  app.get("/api/ai-movie/projects/:id/ai-settings", admin, wrap(async (req, res) => {
    const { projectId } = await loadProject(req);
    res.json({ ...(await getProjectModes(db, projectId)), qualityModes: QUALITY_MODES.map((key) => ({ key, ...QUALITY_MODE_INFO[key] })), creativeModes: CREATIVE_MODES.map((key) => ({ key, ...CREATIVE_MODE_INFO[key] })), routing: routingTable(), prices: textPrices(), spend: await spendSummary(db, projectId) });
  }));

  app.patch("/api/ai-movie/projects/:id/ai-settings", admin, wrap(async (req, res) => {
    const { projectId } = await loadProject(req);
    const { qualityMode, cinematicMode } = req.body ?? {};
    if (qualityMode !== undefined) {
      if (!QUALITY_MODES.includes(qualityMode)) throw httpError(`Quality mode must be one of ${QUALITY_MODES.join(", ")}.`, 400);
      await db.query("UPDATE ai_movie_projects SET quality_mode = $2 WHERE id = $1", [projectId, qualityMode]);
    }
    if (cinematicMode !== undefined) {
      if (!CREATIVE_MODES.includes(cinematicMode)) throw httpError(`Cinematic mode must be one of ${CREATIVE_MODES.join(", ")}.`, 400);
      await db.query("UPDATE ai_movie_projects SET cinematic_mode = $2 WHERE id = $1", [projectId, cinematicMode]);
    }
    res.json(await getProjectModes(db, projectId));
  }));

  // ---- the three judges + Script Editor, on demand (never automatically while typing) ----
  app.post("/api/ai-movie/projects/:id/judge-panel", admin, wrap(async (req, res) => {
    const { projectId, row } = await loadProject(req);
    const target = String(req.body?.target ?? "");
    const idea = row.pasted_text;
    let text, label, targetKey;
    if (target === "bible") {
      if (!row.story_bible) throw httpError("There is no Story Bible to judge yet.", 400);
      text = storyBrain.storyBibleToMarkdown({ ...row.story_bible, pitchRoom: null, review: null });
      label = "Story Bible"; targetKey = "bible";
    } else if (target.startsWith("stage:")) {
      const stageKey = target.slice(6);
      if (!(stageKey in AI_MOVIE_STAGE_CHECKLIST_KEY)) throw httpError("Not a story stage that can be judged.", 400);
      if (!row.backfill?.[stageKey]) throw httpError("That stage has not been written yet.", 400);
      text = stageJudgeText(stageKey, row.backfill[stageKey]);
      label = `"${stageKey}" story stage`; targetKey = target;
    } else if (target === "screenplay" || /^beat:\d+$/.test(target)) {
      const beats = row.backfill?.screenplayBeats ?? [];
      const which = target === "screenplay" ? beats.map((b, i) => [b, i]) : [[beats[Number(target.slice(5))], Number(target.slice(5))]];
      const parts = which.filter(([b]) => Array.isArray(b?.scenes) && b.scenes.length).map(([b, i]) => `=== BEAT ${i + 1} ===\n${b.scenes.map((s) => deps.sceneText(s)).join("\n\n")}`);
      if (!parts.length) throw httpError("There is no written screenplay to judge yet.", 400);
      text = parts.join("\n\n").slice(0, 60000);
      label = target === "screenplay" ? "screenplay" : `screenplay beat ${Number(target.slice(5)) + 1}`; targetKey = target;
    } else {
      throw httpError('Target must be "bible", "stage:<stage>", "beat:<n>" or "screenplay".', 400);
    }
    res.json(await runJudgePanel({ db, ask, projectId, targetKey, targetLabel: label, text, idea, force: req.body?.force === true, checklist: deps.checklists?.pitchDeck && target.startsWith("stage:") ? deps.checklists[AI_MOVIE_STAGE_CHECKLIST_KEY[target.slice(6)]] : null }));
  }));

  return { ask, requestRevision };
}
