// Money Meter: remembers what every AI call costs, for which project and which user.
// - Every text call made through the Gemini library is measured by its real token counts (price table below).
// - Pictures, voices and video, and the Gemini 3.1 Pro "Story Brain" calls, are copied in from the existing project money log
//   (production_spend) at the moment they are written, so nothing is counted twice.
// - Prices are list prices turned into dollars: an estimate, not your Google invoice. Change them with env vars if Google changes them.
import { AsyncLocalStorage } from "node:async_hooks";
import { matchWriterRoute, writerTargetConcept } from "./writerAccess.js";

const als = new AsyncLocalStorage();

// dollars per million tokens: [input, output (thinking tokens count as output)]
export function tokenPrices(env = process.env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== "" ? Number(v) : d);
  return {
    "flash-lite": [n(env.PRICE_FLASH_LITE_IN, 0.1), n(env.PRICE_FLASH_LITE_OUT, 0.4)],
    flash: [n(env.PRICE_FLASH_IN, 0.3), n(env.PRICE_FLASH_OUT, 2.5)],
    pro: [n(env.PRICE_PRO_IN, 2), n(env.PRICE_PRO_OUT, 12)],
  };
}

const n2 = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== "" ? Number(v) : d);
export function priceFor(model, env = process.env) {
  const p = tokenPrices(env);
  const m = String(model ?? "").toLowerCase();
  if (m.includes("lite")) return { tier: "flash-lite", price: p["flash-lite"], known: true };
  if (m.includes("2.5-pro")) return { tier: "pro-2.5", price: [n2(env.PRICE_PRO25_IN, 1.25), n2(env.PRICE_PRO25_OUT, 10)], known: true };
  if (m.includes("pro")) return { tier: "pro", price: p.pro, known: true };
  if (m.includes("flash")) return { tier: "flash", price: p.flash, known: true };
  return { tier: "flash", price: p.flash, known: false }; // unknown model: priced like Flash
}

export function tokenCostUsd(model, promptTokens, outputTokens, env = process.env) {
  const { price } = priceFor(model, env);
  return ((promptTokens ?? 0) * price[0] + (outputTokens ?? 0) * price[1]) / 1e6;
}

export async function ensureUsageSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS ai_usage_ledger (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      user_id INTEGER,
      user_name TEXT,
      project_type TEXT,
      project_id INTEGER,
      kind TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      units NUMERIC,
      prompt_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd NUMERIC NOT NULL DEFAULT 0,
      via TEXT NOT NULL,
      ref TEXT,
      route TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS ai_usage_ledger_project_idx ON ai_usage_ledger (project_type, project_id)`,
    `CREATE INDEX IF NOT EXISTS ai_usage_ledger_user_idx ON ai_usage_ledger (user_id)`,
    `CREATE TABLE IF NOT EXISTS ai_usage_meta (key TEXT PRIMARY KEY, value TIMESTAMPTZ NOT NULL)`,
    `INSERT INTO ai_usage_meta (key, value) VALUES ('tracking_started_at', now()) ON CONFLICT (key) DO NOTHING`,
  ];
  for (const sql of statements) await db.query(sql);
}

// Remembers who is asking (and which request) for everything that happens while the request is being served.
export const usageContext = (req, res, next) => als.run({ user: req.user ?? null, req }, next);
export const withUsageContext = (ctx, fn) => als.run(ctx, fn);

const num = (v) => (/^\d+$/.test(String(v ?? "")) ? Number(v) : null);

// Which project this request is about: an AI Movie project, or a Movie (story) project.
export async function projectOfRequest(db, req, sceneListConceptId) {
  if (!req) return null;
  const path = String(req.originalUrl ?? req.url ?? "").split("?")[0];
  let m = path.match(/^\/api\/ai-movie\/projects\/(\d+)/);
  if (m) return { type: "ai_movie", id: Number(m[1]) };
  m = path.match(/^\/api\/concepts\/(\d+)/) ?? path.match(/^\/api\/concept\/(\d+)/);
  if (m) return { type: "story", id: Number(m[1]) };
  // the Smart Scheduler names the project's scene list in its path (the AI cost is the project's)
  m = path.match(/^\/api\/smart-scheduler\/(\d+)\//);
  if (m && sceneListConceptId) { const concept = await sceneListConceptId(m[1]).catch(() => null); if (concept) return { type: "story", id: concept }; }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const direct = num(body.conceptId ?? body.concept_id ?? req.query?.conceptId);
  if (direct) return { type: "story", id: direct };
  const aiProject = num(body.projectId ?? body.aiMovieProjectId ?? req.query?.projectId);
  if (aiProject && path.startsWith("/api/ai-movie")) return { type: "ai_movie", id: aiProject };
  try {
    const hit = matchWriterRoute(req.method, path);
    if (hit) {
      const concept = await writerTargetConcept(db, hit.kind, hit.match, req, sceneListConceptId);
      if (concept) return { type: "story", id: concept };
    }
  } catch { /* an unknown project is fine */ }
  return null;
}

let sceneListResolver = null;
export const setSceneListResolver = (fn) => { sceneListResolver = fn; };

export async function recordUsage(db, entry) {
  try {
    const store = als.getStore();
    const user = entry.user ?? store?.user ?? null;
    const project = entry.project !== undefined ? entry.project : await projectOfRequest(db, store?.req, sceneListResolver);
    await db.query(
      `INSERT INTO ai_usage_ledger (user_id, user_name, project_type, project_id, kind, provider, model, units, prompt_tokens, output_tokens, cost_usd, via, ref, route)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [user?.id ?? null, user?.name ?? user?.username ?? null, project?.type ?? null, project?.id ?? null, entry.kind, entry.provider ?? null, entry.model ?? null,
        entry.units ?? null, entry.promptTokens ?? null, entry.outputTokens ?? null, Math.round((entry.costUsd ?? 0) * 1e6) / 1e6, entry.via, entry.ref ?? null,
        store?.req ? `${store.req.method} ${String(store.req.originalUrl ?? "").split("?")[0]}`.slice(0, 200) : null]
    );
  } catch (error) {
    console.error("Money Meter could not write a usage row (the AI call itself was not affected):", error.message);
  }
}

// Measures every text call made through the Gemini library.
let meterDb = null;
export function installGeminiMetering(ai, db) {
  meterDb = db;
  const original = ai.models.generateContent.bind(ai.models);
  ai.models.generateContent = async (params) => {
    const response = await original(params);
    try {
      const u = response?.usageMetadata ?? {};
      const promptTokens = u.promptTokenCount ?? 0;
      const outputTokens = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
      const model = params?.model ?? "unknown";
      const { known } = priceFor(model);
      await recordUsage(db, { kind: "text", provider: `Gemini (${model})`, model, units: 1, promptTokens, outputTokens, costUsd: tokenCostUsd(model, promptTokens, outputTokens), via: known ? "metered" : "metered-unknown-model" });
    } catch { /* never break the AI call */ }
    return response;
  };
}

// Called by recordSpend: copies the pieces the token meter does not see (pictures, voices, video).
// Text of every kind (Flash, Flash-Lite and the Pro "Story Brain") is measured by its token counts instead.
export async function mirrorSpend(db, projectId, { kind, provider = null, units = null, costUsd, ref = null }) {
  if (kind === "text") return;
  await recordUsage(db, { kind, provider, units, costUsd, via: "spend-log", ref, project: { type: "ai_movie", id: projectId } });
}

// The Pro "Story Brain" model is called over REST (not the Gemini library), so storyBrain.js reports each answer here.
export async function recordBrainCall({ model, usage, label }) {
  if (!meterDb) return;
  const promptTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
  await recordUsage(meterDb, { kind: "text", provider: `${label ?? "Story Brain"} (${model})`, model, units: 1, promptTokens, outputTokens, costUsd: tokenCostUsd(model, promptTokens, outputTokens), via: "metered" });
}

const r4 = (v) => Math.round(Number(v ?? 0) * 10000) / 10000;


// ---------------------------------------------------------------------------
// Work done BEFORE the meter existed: estimated from what is saved.
// Every saved version of a pitch deck, character sheet, three-act structure, bit sheet, scene list, screenplay scene,
// breakdown, schedule and every assistant chat reply was one AI answer. Its size tells us the answer's tokens; the
// prompt size, the model's "thinking" and the Pro judge pass are assumptions, listed here so the screen can show them.
// Versions that were overwritten or deleted, and failed or retried calls, left nothing behind — so this is a LOW estimate.
// ---------------------------------------------------------------------------
const FLASH = "gemini-2.5-flash";
const LITE = "gemini-2.5-flash-lite";
const PRO = "gemini-3.1-pro-preview";
// inBase: fixed prompt tokens (rules, examples). inMult: prompt tokens per answer token (earlier stages sent as context).
// think: the model's hidden thinking tokens per answer token. judge: a Pro judge read it (tokens in = answer + 2500, out 1200 + 2500 thinking).
export const ESTIMATE_RULES = {
  storylines: { label: "Storylines", model: LITE, inBase: 1500, inMult: 1, think: 0.2 },
  pitch: { label: "Pitch deck", model: FLASH, inBase: 2000, inMult: 2, think: 1, judge: true },
  characters: { label: "Character sheet", model: FLASH, inBase: 3000, inMult: 3, think: 1, judge: true },
  threeAct: { label: "Three-act structure", model: FLASH, inBase: 3500, inMult: 3, think: 1, judge: true },
  bitSheet: { label: "Bit sheet", model: FLASH, inBase: 4000, inMult: 4, think: 1, judge: true },
  sceneList: { label: "Scene list (Pro model)", model: PRO, inBase: 8000, inMult: 6, think: 2, judge: true },
  screenplay: { label: "Screenplay scenes", model: FLASH, inBase: 4000, inMult: 6, think: 1 },
  breakdown: { label: "Script breakdown", model: LITE, inBase: 3000, inMult: 5, think: 0.2 },
  schedule: { label: "Shoot schedule", model: LITE, inBase: 3000, inMult: 4, think: 0.2 },
  chat: { label: "Agent chat replies", model: LITE, inBase: 3000, inMult: 8, think: 0.2 },
};
const JUDGE = { inBase: 2500, out: 1200, think: 2500 };
const CHARS_PER_TOKEN = { latin: 4, other: 1.5 }; // English text vs Odia/Hindi text

const ROWS_SQL = (cols) => `
  SELECT concept_id, stage, count(*)::float AS n, sum(len)::float AS len, sum(asc_len)::float AS asc_len FROM (
    SELECT c.id AS concept_id, 'storylines' AS stage, length(c.storylines::text) AS len, length(regexp_replace(c.storylines::text, '[^ -~]', '', 'g')) AS asc_len, c.created_at FROM concepts c
    UNION ALL SELECT x.concept_id, 'pitch', ${cols("x.content")}, x.created_at FROM pitch_decks x
    UNION ALL SELECT pd.concept_id, 'characters', ${cols("x.content")}, x.created_at FROM character_sheets x JOIN pitch_decks pd ON pd.id = x.pitch_deck_id
    UNION ALL SELECT pd.concept_id, 'threeAct', ${cols("x.content")}, x.created_at FROM three_act_structures x JOIN pitch_decks pd ON pd.id = x.pitch_deck_id
    UNION ALL SELECT pd.concept_id, 'bitSheet', ${cols("x.content")}, x.created_at FROM bit_sheets x JOIN three_act_structures t ON t.id = x.three_act_structure_id JOIN pitch_decks pd ON pd.id = t.pitch_deck_id
    UNION ALL SELECT COALESCE(x.concept_id, pd.concept_id), 'sceneList', ${cols("x.content")}, x.created_at FROM scene_lists x
      LEFT JOIN bit_sheets b ON b.id = x.bit_sheet_id LEFT JOIN three_act_structures t ON t.id = b.three_act_structure_id LEFT JOIN pitch_decks pd ON pd.id = t.pitch_deck_id
    UNION ALL SELECT s.concept_id, 'screenplay', ${cols("x.content")}, x.created_at FROM screenplay_scenes x JOIN ${SL_CONCEPT} s ON s.id = x.scene_list_id
    UNION ALL SELECT s.concept_id, 'breakdown', ${cols("x.content")}, x.created_at FROM script_breakdowns x JOIN ${SL_CONCEPT} s ON s.id = x.scene_list_id
    UNION ALL SELECT s.concept_id, 'schedule', ${cols("x.content")}, x.created_at FROM shoot_schedules x JOIN ${SL_CONCEPT} s ON s.id = x.scene_list_id
    UNION ALL SELECT x.concept_id, 'chat', length(x.content), length(regexp_replace(x.content, '[^ -~]', '', 'g')), x.created_at FROM agent_chat_messages x WHERE x.role = 'assistant'
  ) r WHERE created_at < $1 AND concept_id IS NOT NULL GROUP BY concept_id, stage`;
const SL_CONCEPT = `(SELECT sl.id, COALESCE(sl.concept_id, pd.concept_id) AS concept_id FROM scene_lists sl
    LEFT JOIN bit_sheets b ON b.id = sl.bit_sheet_id LEFT JOIN three_act_structures t ON t.id = b.three_act_structure_id LEFT JOIN pitch_decks pd ON pd.id = t.pitch_deck_id)`;
const jsonCols = (col) => `length(${col}::text), length(regexp_replace(${col}::text, '[^ -~]', '', 'g'))`;

// returns Map(conceptId -> { usd, stages: [{ stage, label, model, rows, usd }], proUsd })
export async function estimateEarlierStoryWork(db, startedAt, env = process.env) {
  const scale = Number(env.ESTIMATE_SCALE ?? 1);
  const out = new Map();
  const add = (conceptId, entry) => {
    if (!out.has(conceptId)) out.set(conceptId, { usd: 0, proUsd: 0, stages: [] });
    const c = out.get(conceptId);
    c.usd += entry.usd; if (/pro/.test(entry.model)) c.proUsd += entry.usd;
    c.stages.push(entry);
  };
  if (!startedAt) return out;
  const rows = (await db.query(ROWS_SQL(jsonCols), [startedAt])).rows;
  for (const r of rows) {
    const rule = ESTIMATE_RULES[r.stage];
    if (!rule) continue;
    const answerTokens = r.asc_len / CHARS_PER_TOKEN.latin + (r.len - r.asc_len) / CHARS_PER_TOKEN.other;
    const inTokens = r.n * rule.inBase + rule.inMult * answerTokens;
    const outTokens = answerTokens + rule.think * answerTokens;
    let usd = tokenCostUsd(rule.model, inTokens, outTokens, env);
    add(r.concept_id, { stage: r.stage, label: rule.label, model: rule.model, rows: r.n, usd: usd * scale });
    if (rule.judge) {
      const judgeUsd = tokenCostUsd(PRO, r.n * JUDGE.inBase + answerTokens, r.n * (JUDGE.out + JUDGE.think), env);
      add(r.concept_id, { stage: `${r.stage}-judge`, label: `${rule.label}: Pro judge reads`, model: PRO, rows: r.n, usd: judgeUsd * scale });
    }
  }
  // Story Brain runs of the automatic pipeline saved their real Pro token counts.
  const runs = (await db.query("SELECT concept_id, story_bible_usage AS u FROM auto_pipeline_runs WHERE story_bible_usage IS NOT NULL AND concept_id IS NOT NULL AND created_at < $1", [startedAt])).rows;
  for (const run of runs) {
    const u = run.u ?? {};
    const usd = tokenCostUsd(PRO, u.promptTokens ?? 0, (u.outputTokens ?? 0) + (u.thinkingTokens ?? 0), env);
    if (usd > 0) add(run.concept_id, { stage: "storyBrain", label: "Story Brain (real saved token counts)", model: PRO, rows: u.calls ?? 1, usd });
  }
  for (const c of out.values()) {
    const merged = new Map();
    for (const st of c.stages) { const m = merged.get(st.stage) ?? { ...st, usd: 0, rows: 0 }; m.usd += st.usd; m.rows += st.rows; merged.set(st.stage, m); }
    c.stages = [...merged.values()].map((st) => ({ ...st, usd: r4(st.usd) })).sort((a, b) => b.usd - a.usd);
    c.usd = r4(c.usd); c.proUsd = r4(c.proUsd);
  }
  return out;
}

// Everything the Money Meter screen shows.
export async function usageReport(db, env = process.env) {
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const startedAt = (await q("SELECT value FROM ai_usage_meta WHERE key = 'tracking_started_at'"))[0]?.value ?? null;

  const names = new Map();
  for (const c of await q("SELECT id, COALESCE(NULLIF(title,''), left(concept_text, 60)) AS name, project_type, created_at FROM concepts")) names.set(`story:${c.id}`, { type: c.project_type === "production" ? "production" : "story", name: c.name, createdAt: c.created_at });
  const aiRows = await q("SELECT p.id, COALESCE(NULLIF(p.title,''), 'AI Movie #' || p.id) AS name, p.created_at, u.name AS owner FROM ai_movie_projects p LEFT JOIN users u ON u.id = p.created_by");
  for (const p of aiRows) names.set(`ai_movie:${p.id}`, { type: "ai_movie", name: p.name, createdAt: p.created_at, owner: p.owner });

  const tracked = await q(`SELECT project_type, project_id, user_id, user_name, kind, via, count(*)::int AS calls, sum(cost_usd)::float AS usd, max(created_at) AS last_at
    FROM ai_usage_ledger GROUP BY project_type, project_id, user_id, user_name, kind, via`);
  const earlier = startedAt
    ? await q(`SELECT s.project_id, s.kind, count(*)::int AS calls, sum(s.cost_usd)::float AS usd, max(s.created_at) AS last_at
        FROM production_spend s WHERE s.created_at < $1 GROUP BY s.project_id, s.kind`, [startedAt])
    : [];

  const estimates = await estimateEarlierStoryWork(db, startedAt, env);
  const projects = new Map();
  const project = (type, id) => {
    const key = type && id ? `${type}:${id}` : "none";
    if (!projects.has(key)) {
      const meta = names.get(key);
      projects.set(key, { key, type: meta?.type ?? (key === "none" ? "none" : type), id: id ?? null, name: meta?.name ?? (key === "none" ? "Not tied to one project" : `${type} #${id} (deleted)`), owner: meta?.owner ?? null, createdAt: meta?.createdAt ?? null, trackedUsd: 0, earlierUsd: 0, earlierLoggedUsd: 0, earlierEstimatedUsd: 0, estimateStages: [], calls: 0, lastAt: null, byKind: {}, byUser: {} });
    }
    return projects.get(key);
  };
  for (const [key, meta] of names) { const [t, id] = key.split(":"); project(t, Number(id)); }

  const users = new Map();
  const bump = (obj, k, usd) => { obj[k] = r4((obj[k] ?? 0) + usd); };
  for (const row of tracked) {
    const p = project(row.project_type, row.project_id);
    p.trackedUsd += row.usd; p.calls += row.calls;
    if (!p.lastAt || row.last_at > p.lastAt) p.lastAt = row.last_at;
    bump(p.byKind, row.kind, row.usd);
    const who = row.user_name ?? "Not tied to a user (background or system work)";
    bump(p.byUser, who, row.usd);
    const uk = String(row.user_id ?? "none");
    if (!users.has(uk)) users.set(uk, { id: row.user_id, name: who, trackedUsd: 0, calls: 0, byKind: {}, byProject: {}, lastAt: null });
    const u = users.get(uk);
    u.trackedUsd += row.usd; u.calls += row.calls;
    if (!u.lastAt || row.last_at > u.lastAt) u.lastAt = row.last_at;
    bump(u.byKind, row.kind, row.usd);
    bump(u.byProject, p.name, row.usd);
  }
  for (const row of earlier) {
    const p = project("ai_movie", row.project_id);
    p.earlierUsd += row.usd; p.earlierLoggedUsd += row.usd; p.calls += row.calls;
    if (!p.lastAt || row.last_at > p.lastAt) p.lastAt = row.last_at;
    bump(p.byKind, row.kind, row.usd);
  }

  for (const [conceptId, est] of estimates) {
    const p = project("story", conceptId);
    p.earlierUsd += est.usd; p.earlierEstimatedUsd += est.usd; p.estimateStages = est.stages;
    bump(p.byKind, "text (estimated)", est.usd);
  }
  const proEstimatedUsd = r4([...estimates.values()].reduce((s, e) => s + e.proUsd, 0));
  const proMeasuredUsd = r4((await q("SELECT COALESCE(sum(cost_usd) FILTER (WHERE model ILIKE '%pro%'), 0)::float AS usd FROM ai_usage_ledger"))[0]?.usd);

  const total = (list, f) => r4(list.reduce((s, x) => s + f(x), 0));
  const projectList = [...projects.values()].map((p) => ({ ...p, trackedUsd: r4(p.trackedUsd), earlierUsd: r4(p.earlierUsd), earlierLoggedUsd: r4(p.earlierLoggedUsd), earlierEstimatedUsd: r4(p.earlierEstimatedUsd), totalUsd: r4(p.trackedUsd + p.earlierUsd) }))
    .sort((a, b) => b.totalUsd - a.totalUsd || String(b.createdAt).localeCompare(String(a.createdAt)));
  const userList = [...users.values()].map((u) => ({ ...u, trackedUsd: r4(u.trackedUsd) })).sort((a, b) => b.trackedUsd - a.trackedUsd);

  const daily = await q(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, sum(cost_usd)::float AS usd, count(*)::int AS calls
    FROM ai_usage_ledger WHERE created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`);
  const allUsers = (await q("SELECT id, name, username, role, concept_id FROM users ORDER BY name")).map((u) => ({ id: u.id, name: u.name, username: u.username, role: u.role }));

  const trackedUsd = total(projectList, (p) => p.trackedUsd);
  const earlierUsd = total(projectList, (p) => p.earlierUsd);
  return {
    currency: "USD",
    inrPerUsd: Number(env.USD_INR_RATE ?? 88),
    trackingStartedAt: startedAt,
    totals: { trackedUsd, earlierUsd, earlierLoggedUsd: total(projectList, (p) => p.earlierLoggedUsd), earlierEstimatedUsd: total(projectList, (p) => p.earlierEstimatedUsd), proMeasuredUsd, proEstimatedUsd, grandUsd: r4(trackedUsd + earlierUsd), projects: projectList.filter((p) => p.type !== "none").length, usersWithSpend: userList.length },
    projects: projectList,
    users: userList,
    allUsers,
    daily: daily.map((d) => ({ ...d, usd: r4(d.usd) })),
    prices: tokenPrices(env),
    estimateRules: Object.entries(ESTIMATE_RULES).map(([stage, r]) => ({ stage, ...r })),
    estimateJudge: JUDGE,
  };
}

// What is running right now, and the latest calls — the live record.
export async function liveActivity(db) {
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const safe = async (sql) => { try { return await q(sql); } catch { return []; } };
  const running = [];
  for (const r of await safe(`SELECT r.id, r.progress_stage, r.created_at, r.updated_at, COALESCE(NULLIF(c.title,''), left(r.concept_text, 50)) AS name, r.concept_id, u.name AS who
      FROM auto_pipeline_runs r LEFT JOIN concepts c ON c.id = r.concept_id LEFT JOIN users u ON u.id = r.created_by
      WHERE r.status = 'running' AND r.updated_at > now() - interval '6 hours' ORDER BY r.updated_at DESC`))
    running.push({ what: "Automatic pipeline (writing a whole project)", name: r.name, step: r.progress_stage, since: r.created_at, lastSeen: r.updated_at, who: r.who, projectKey: r.concept_id ? `story:${r.concept_id}` : null });
  for (const r of await safe(`SELECT p.id, COALESCE(NULLIF(p.title,''), 'AI Movie #' || p.id) AS name, p.auto_production_job AS job, p.updated_at, u.name AS who
      FROM ai_movie_projects p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.auto_production_job->>'status' = 'running' AND p.updated_at > now() - interval '6 hours' ORDER BY p.updated_at DESC`))
    running.push({ what: "AI Movie auto production", name: r.name, step: r.job?.label ? `${r.job.label} (${r.job.step}/${r.job.steps})` : null, since: null, lastSeen: r.updated_at, who: r.who, projectKey: `ai_movie:${r.id}` });
  for (const r of await safe(`SELECT q.id, q.module, q.created_at, q.updated_at, q.instruction, u.name AS who
      FROM draft_revision_requests q LEFT JOIN users u ON u.id = q.created_by
      WHERE q.status = 'working' AND q.updated_at > now() - interval '6 hours' ORDER BY q.updated_at DESC`))
    running.push({ what: `Draft agent (${r.module})`, name: String(r.instruction ?? "").slice(0, 60), step: null, since: r.created_at, lastSeen: r.updated_at, who: r.who, projectKey: null });

  const names = new Map();
  for (const c of await safe("SELECT id, COALESCE(NULLIF(title,''), left(concept_text, 50)) AS name FROM concepts")) names.set(`story:${c.id}`, c.name);
  for (const p of await safe("SELECT id, COALESCE(NULLIF(title,''), 'AI Movie #' || id) AS name FROM ai_movie_projects")) names.set(`ai_movie:${p.id}`, p.name);

  const recentRows = await safe(`SELECT created_at, user_name, project_type, project_id, kind, model, provider, prompt_tokens, output_tokens, cost_usd::float AS usd, route
    FROM ai_usage_ledger ORDER BY id DESC LIMIT 60`);
  const lastHour = await safe(`SELECT project_type, project_id, user_name, count(*)::int AS calls, sum(cost_usd)::float AS usd
    FROM ai_usage_ledger WHERE created_at > now() - interval '1 hour' GROUP BY project_type, project_id, user_name ORDER BY sum(cost_usd) DESC`);
  const projectName = (t, id) => (t && id ? names.get(`${t}:${id}`) ?? `${t} #${id}` : "Not tied to one project");
  return {
    running: running.map((r) => ({ ...r, projectName: r.projectKey ? names.get(r.projectKey) ?? r.name : r.name })),
    recent: recentRows.map((r) => ({ at: r.created_at, user: r.user_name ?? "background / system", project: projectName(r.project_type, r.project_id), kind: r.kind, model: r.model ?? r.provider, promptTokens: r.prompt_tokens, outputTokens: r.output_tokens, usd: r4(r.usd), route: r.route })),
    lastHour: lastHour.map((r) => ({ project: projectName(r.project_type, r.project_id), user: r.user_name ?? "background / system", calls: r.calls, usd: r4(r.usd) })),
  };
}

export function registerUsageRoutes(app, db, requireRole) {
  app.get("/api/admin/usage", requireRole("admin"), async (req, res) => {
    try { res.json(await usageReport(db)); }
    catch (error) { console.error("Money Meter report failed:", error); res.status(500).json({ error: "Could not build the spend report." }); }
  });
  app.get("/api/admin/usage/live", requireRole("admin"), async (req, res) => {
    try { res.json(await liveActivity(db)); }
    catch (error) { console.error("Money Meter live view failed:", error); res.status(500).json({ error: "Could not build the live view." }); }
  });
}
