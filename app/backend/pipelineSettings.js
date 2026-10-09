// Per-project settings for the AI production pipeline: the look of the film
// (style text), picture shape, voices, and the MONEY limit. Every paid AI call
// is checked against the limit first and written to a spend ledger after.

export const DEFAULT_BUDGET_USD = Number(process.env.PRODUCTION_DEFAULT_BUDGET_USD || 5);

// Rough prices in US dollars, used only to stop runaway spending. They are
// estimates, not bills. Change them with environment settings if Google's
// prices change.
export function priceTable(env = process.env) {
  return {
    image: Number(env.COST_IMAGE_EACH ?? 0.04),
    audioPerThousandChars: Number(env.COST_AUDIO_PER_1000_CHARS ?? 0.02),
    videoPerSecond: Number(env.COST_VIDEO_PER_SECOND ?? 0.15),
  };
}

export const VOICES = ["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr", "Callirrhoe", "Algenib"];

export async function ensurePipelineSettingsSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS production_settings (
      project_id INTEGER PRIMARY KEY REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      style_prompt TEXT NOT NULL DEFAULT '',
      aspect_ratio TEXT NOT NULL DEFAULT '16:9',
      budget_limit_usd NUMERIC,
      voices JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS production_spend (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      provider TEXT,
      units NUMERIC,
      cost_usd NUMERIC NOT NULL,
      ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS production_spend_project_idx ON production_spend (project_id)`,
  ];
  for (const sql of statements) await db.query(sql);
}

const ASPECTS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);

export async function getSettings(db, projectId) {
  const row = (await db.query("SELECT * FROM production_settings WHERE project_id = $1", [projectId])).rows[0];
  return {
    stylePrompt: row?.style_prompt ?? "",
    aspectRatio: row?.aspect_ratio ?? "16:9",
    budgetLimitUsd: row?.budget_limit_usd === null || row?.budget_limit_usd === undefined ? null : Number(row.budget_limit_usd),
    effectiveBudgetUsd: row?.budget_limit_usd === null || row?.budget_limit_usd === undefined ? DEFAULT_BUDGET_USD : Number(row.budget_limit_usd),
    voices: row?.voices ?? {},
  };
}

export async function saveSettings(db, projectId, patch) {
  const current = await getSettings(db, projectId);
  const next = { ...current };
  if (patch.stylePrompt !== undefined) {
    if (typeof patch.stylePrompt !== "string" || patch.stylePrompt.length > 2000) throw Object.assign(new Error("The look description must be text under 2000 characters."), { status: 400 });
    next.stylePrompt = patch.stylePrompt.trim();
  }
  if (patch.aspectRatio !== undefined) {
    if (!ASPECTS.has(patch.aspectRatio)) throw Object.assign(new Error("Picture shape must be one of 16:9, 9:16, 1:1, 4:3, 3:4."), { status: 400 });
    next.aspectRatio = patch.aspectRatio;
  }
  if (patch.budgetLimitUsd !== undefined) {
    if (patch.budgetLimitUsd === null) next.budgetLimitUsd = null;
    else {
      const n = Number(patch.budgetLimitUsd);
      if (!Number.isFinite(n) || n < 0 || n > 10000) throw Object.assign(new Error("The money limit must be a number from 0 to 10000 (US dollars)."), { status: 400 });
      next.budgetLimitUsd = n;
    }
  }
  if (patch.voices !== undefined) {
    if (!patch.voices || typeof patch.voices !== "object" || Array.isArray(patch.voices)) throw Object.assign(new Error("Voices must be a list of speaker -> voice."), { status: 400 });
    const voices = {};
    for (const [speaker, voice] of Object.entries(patch.voices)) {
      if (!VOICES.includes(voice)) throw Object.assign(new Error(`"${voice}" is not one of the available voices (${VOICES.join(", ")}).`), { status: 400 });
      voices[String(speaker).slice(0, 80)] = voice;
    }
    next.voices = voices;
  }
  await db.query(
    `INSERT INTO production_settings (project_id, style_prompt, aspect_ratio, budget_limit_usd, voices, updated_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (project_id) DO UPDATE SET style_prompt = EXCLUDED.style_prompt, aspect_ratio = EXCLUDED.aspect_ratio,
       budget_limit_usd = EXCLUDED.budget_limit_usd, voices = EXCLUDED.voices, updated_at = now()`,
    [projectId, next.stylePrompt, next.aspectRatio, next.budgetLimitUsd, JSON.stringify(next.voices)]
  );
  return getSettings(db, projectId);
}

export async function spendSummary(db, projectId) {
  const settings = await getSettings(db, projectId);
  const rows = (await db.query("SELECT kind, COALESCE(sum(cost_usd),0)::float AS usd, count(*)::int AS n FROM production_spend WHERE project_id = $1 GROUP BY kind", [projectId])).rows;
  const spent = rows.reduce((sum, r) => sum + r.usd, 0);
  return {
    spentUsd: Math.round(spent * 10000) / 10000,
    limitUsd: settings.effectiveBudgetUsd,
    remainingUsd: Math.max(0, Math.round((settings.effectiveBudgetUsd - spent) * 10000) / 10000),
    byKind: Object.fromEntries(rows.map((r) => [r.kind, { usd: Math.round(r.usd * 10000) / 10000, count: r.n }])),
    prices: priceTable(),
  };
}

// Refuses (HTTP 402) when this work would take the project over its limit.
export async function assertWithinBudget(db, projectId, estimateUsd) {
  const summary = await spendSummary(db, projectId);
  if (summary.spentUsd + estimateUsd > summary.limitUsd + 1e-9) {
    throw Object.assign(
      new Error(
        `This would cost about $${estimateUsd.toFixed(2)}, but only $${summary.remainingUsd.toFixed(2)} is left of the $${summary.limitUsd.toFixed(2)} limit for this project. Raise the money limit in Settings if you want to continue.`
      ),
      { status: 402, code: "over_budget" }
    );
  }
  return summary;
}

export async function recordSpend(db, projectId, { kind, provider = null, units = null, costUsd, ref = null }) {
  await db.query("INSERT INTO production_spend (project_id, kind, provider, units, cost_usd, ref) VALUES ($1,$2,$3,$4,$5,$6)", [projectId, kind, provider, units, costUsd, ref]);
}
