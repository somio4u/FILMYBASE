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

export function priceFor(model, env = process.env) {
  const p = tokenPrices(env);
  const m = String(model ?? "").toLowerCase();
  if (m.includes("lite")) return { tier: "flash-lite", price: p["flash-lite"], known: true };
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
export function installGeminiMetering(ai, db) {
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

// Called by recordSpend: copies the pieces the token meter does not see.
export async function mirrorSpend(db, projectId, { kind, provider = null, units = null, costUsd, ref = null }) {
  if (kind === "text" && !/pro|story brain/i.test(String(provider ?? ""))) return; // other text calls are measured by token counts
  await recordUsage(db, { kind, provider, units, costUsd, via: "spend-log", ref, project: { type: "ai_movie", id: projectId } });
}

const r4 = (v) => Math.round(Number(v ?? 0) * 10000) / 10000;

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

  const projects = new Map();
  const project = (type, id) => {
    const key = type && id ? `${type}:${id}` : "none";
    if (!projects.has(key)) {
      const meta = names.get(key);
      projects.set(key, { key, type: meta?.type ?? (key === "none" ? "none" : type), id: id ?? null, name: meta?.name ?? (key === "none" ? "Not tied to one project" : `${type} #${id} (deleted)`), owner: meta?.owner ?? null, createdAt: meta?.createdAt ?? null, trackedUsd: 0, earlierUsd: 0, calls: 0, lastAt: null, byKind: {}, byUser: {} });
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
    p.earlierUsd += row.usd; p.calls += row.calls;
    if (!p.lastAt || row.last_at > p.lastAt) p.lastAt = row.last_at;
    bump(p.byKind, row.kind, row.usd);
  }

  const total = (list, f) => r4(list.reduce((s, x) => s + f(x), 0));
  const projectList = [...projects.values()].map((p) => ({ ...p, trackedUsd: r4(p.trackedUsd), earlierUsd: r4(p.earlierUsd), totalUsd: r4(p.trackedUsd + p.earlierUsd) }))
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
    totals: { trackedUsd, earlierUsd, grandUsd: r4(trackedUsd + earlierUsd), projects: projectList.filter((p) => p.type !== "none").length, usersWithSpend: userList.length },
    projects: projectList,
    users: userList,
    allUsers,
    daily: daily.map((d) => ({ ...d, usd: r4(d.usd) })),
    prices: tokenPrices(env),
  };
}

export function registerUsageRoutes(app, db, requireRole) {
  app.get("/api/admin/usage", requireRole("admin"), async (req, res) => {
    try { res.json(await usageReport(db)); }
    catch (error) { console.error("Money Meter report failed:", error); res.status(500).json({ error: "Could not build the spend report." }); }
  });
}
