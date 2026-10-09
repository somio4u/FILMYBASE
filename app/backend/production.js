// Production workflow — the "agent data -> Production Dossier" side.
//
// The silent asset-extraction agent (generateAiMovieAssetExtraction in
// server.js) saves its list to ai_movie_projects.assets. That agent is NOT
// changed by anything in this file. This file only READS what it saved,
// copies it into proper production records (one row per character / prop /
// location / other asset), and keeps an untouched snapshot of every distinct
// output it has seen.
//
// Rules this follows (from the Production Workflow brief):
//  - same output twice -> nothing new is created (hash check)
//  - a changed output never overwrites human edits (kept in human_edits)
//  - missing information is recorded as an issue, never invented
//  - the agent has no ids, so we match by name + aliases and keep our own ids

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Schema (idempotent; run on every server start, like ensureAiMovieSchema)
// ---------------------------------------------------------------------------

export async function ensureProductionSchema(db) {
  const statements = [
    // One row per distinct output of the silent agent we have received.
    // payload is the exact snapshot; never edited after insert.
    `CREATE TABLE IF NOT EXISTS production_agent_imports (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      payload_hash TEXT NOT NULL,
      payload JSONB,
      source_kind TEXT NOT NULL DEFAULT 'existing_agent',
      completion_state TEXT NOT NULL DEFAULT 'partial',
      source_state JSONB,
      status TEXT NOT NULL DEFAULT 'received',
      summary JSONB,
      error TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (project_id, payload_hash)
    )`,
    // The dossier: one row per asset. agent_details = what the agent last
    // said; human_edits = what a person changed (wins over the agent).
    `CREATE TABLE IF NOT EXISTS production_assets (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('character','prop','location','other')),
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      aliases JSONB NOT NULL DEFAULT '[]',
      agent_details JSONB NOT NULL DEFAULT '{}',
      human_edits JSONB NOT NULL DEFAULT '{}',
      imported_revision INTEGER NOT NULL DEFAULT 1,
      in_latest_import BOOLEAN NOT NULL DEFAULT TRUE,
      review_status TEXT NOT NULL DEFAULT 'needs_review',
      first_import_id INTEGER REFERENCES production_agent_imports(id) ON DELETE SET NULL,
      last_import_id INTEGER REFERENCES production_agent_imports(id) ON DELETE SET NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (project_id, kind, name_key),
      UNIQUE (project_id, code)
    )`,
    // Review inbox: missing information, ambiguities, quarantined entries,
    // updates that touch human-edited assets.
    `CREATE TABLE IF NOT EXISTS production_issues (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      asset_id INTEGER REFERENCES production_assets(id) ON DELETE CASCADE,
      import_id INTEGER REFERENCES production_agent_imports(id) ON DELETE SET NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `ALTER TABLE production_issues ADD COLUMN IF NOT EXISTS resolution_note TEXT`,
    `CREATE INDEX IF NOT EXISTS production_issues_project_idx ON production_issues (project_id, status)`,
    `CREATE TABLE IF NOT EXISTS production_audit_events (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      actor_user_id INTEGER,
      action TEXT NOT NULL,
      entity TEXT,
      entity_id INTEGER,
      detail JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  ];
  for (const sql of statements) await db.query(sql);
}

// ---------------------------------------------------------------------------
// Normalising the agent's output (pure functions — easy to test)
// ---------------------------------------------------------------------------

// Key used to decide "same asset": lower-case, accents/punctuation stripped,
// spaces collapsed. Unicode letters (Hindi/Odia) are kept.
export function nameKey(name) {
  return String(name ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// JSON with sorted keys, so the same content always hashes the same.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function payloadHash(payload) {
  return crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

const LISTS = [
  { field: "characters", kind: "character", prefix: "CHAR" },
  { field: "properties", kind: "prop", prefix: "PROP" },
  { field: "environments", kind: "location", prefix: "LOC" },
  { field: "otherAssets", kind: "other", prefix: "OTH" },
];

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanStringList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const text = cleanString(item);
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

// Turns the stored `assets` blob into entries + quarantined (malformed) ones.
// Never throws; never invents ids or evidence.
export function normalizeAgentAssets(assets) {
  const entries = [];
  const quarantined = [];

  if (!assets || typeof assets !== "object" || Array.isArray(assets)) {
    return { entries, quarantined, fatal: "The silent agent has not saved any output for this project yet." };
  }
  if (!LISTS.some(({ field }) => Array.isArray(assets[field]))) {
    return { entries, quarantined, fatal: "The saved output has none of the expected lists (characters, properties, environments)." };
  }

  for (const { field, kind } of LISTS) {
    const list = assets[field];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      quarantined.push({ list: field, index: null, reason: `"${field}" is not a list.` });
      continue;
    }
    list.forEach((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        quarantined.push({ list: field, index, reason: "Entry is not an object." });
        return;
      }
      const name = cleanString(raw.name);
      if (!name || name.length > 200) {
        quarantined.push({ list: field, index, reason: "Entry has no usable name." });
        return;
      }
      const vd = raw.visualDescription && typeof raw.visualDescription === "object" ? raw.visualDescription : {};
      const entry = {
        kind,
        name,
        nameKey: nameKey(name),
        aliases: cleanStringList(raw.aliases),
        description: { en: cleanString(vd.en), hi: cleanString(vd.hi) },
        states: cleanStringList(raw.states),
        sceneRefs: cleanStringList(raw.sceneRefs),
        agentMissing: cleanStringList(raw.missing),
        costumes: [],
        otherKind: kind === "other" ? cleanString(raw.kind) : "",
      };
      if (!entry.nameKey) {
        quarantined.push({ list: field, index, reason: "Name has no letters or numbers." });
        return;
      }
      if (kind === "character" && Array.isArray(raw.costumes)) {
        entry.costumes = raw.costumes
          .filter((c) => c && typeof c === "object" && cleanString(c.name))
          .map((c) => ({ name: cleanString(c.name), description: cleanString(c.description) }));
      }
      entries.push(entry);
    });
  }
  return { entries, quarantined, fatal: null };
}

// What the designer will still need. Agent-supplied "missing" items plus a
// few we can tell from the record itself. ("Not designed yet" is a status
// shown on the asset, not a missing-information issue.)
export function computeMissing(entry) {
  const missing = [...entry.agentMissing];
  if (!entry.description.en && !entry.description.hi) missing.push("visual description");
  if (entry.kind === "character" && entry.costumes.length === 0) missing.push("costume details");
  if (entry.sceneRefs.length === 0) missing.push("which scenes it appears in");
  return [...new Set(missing)];
}

// The part of an entry that is "details" (stored as agent_details).
function detailsOf(entry) {
  return {
    description: entry.description,
    states: entry.states,
    sceneRefs: entry.sceneRefs,
    costumes: entry.costumes,
    otherKind: entry.otherKind,
    agentMissing: entry.agentMissing,
  };
}

// Human edits win over what the agent said.
export function effectiveDetails(asset) {
  return { ...asset.agent_details, ...asset.human_edits };
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export async function addIssue(client, { projectId, assetId = null, importId = null, category, severity = "info", message }) {
  const existing = await client.query(
    `SELECT 1 FROM production_issues
     WHERE project_id = $1 AND COALESCE(asset_id, 0) = $2 AND category = $3 AND message = $4 AND status IN ('open','dismissed')`,
    [projectId, assetId ?? 0, category, message]
  );
  if (existing.rowCount > 0) return false;
  await client.query(
    "INSERT INTO production_issues (project_id, asset_id, import_id, category, severity, message) VALUES ($1,$2,$3,$4,$5,$6)",
    [projectId, assetId, importId, category, severity, message]
  );
  return true;
}

async function audit(client, projectId, actorUserId, action, entity, entityId, detail) {
  await client.query(
    "INSERT INTO production_audit_events (project_id, actor_user_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6)",
    [projectId, actorUserId ?? null, action, entity ?? null, entityId ?? null, detail ? JSON.stringify(detail) : null]
  );
}

// Reads the silent agent's saved output for a project and turns it into
// production records. Safe to call as often as you like.
//   returns { outcome: 'imported' | 'duplicate' | 'failed' | 'not_found', ... }
export async function ingestAgentOutput(db, projectId, { actorUserId = null } = {}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Serialises concurrent imports for the same project (also guards the
    // code counters below).
    const projectResult = await client.query(
      "SELECT id, assets, stage_status, updated_at FROM ai_movie_projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    const project = projectResult.rows[0];
    if (!project) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }

    const hash = payloadHash(project.assets ?? null);
    const already = await client.query(
      "SELECT id, status, summary FROM production_agent_imports WHERE project_id = $1 AND payload_hash = $2",
      [projectId, hash]
    );
    if (already.rowCount > 0) {
      await client.query("COMMIT");
      return { outcome: "duplicate", importId: already.rows[0].id, status: already.rows[0].status, summary: already.rows[0].summary };
    }

    const sourceState = {
      projectUpdatedAt: project.updated_at,
      approvedStages: Object.entries(project.stage_status ?? {})
        .filter(([, v]) => v?.status === "approved")
        .map(([k]) => k),
    };
    const completion = sourceState.approvedStages.includes("screenplay") ? "complete" : "partial";

    const { entries, quarantined, fatal } = normalizeAgentAssets(project.assets);
    const importInsert = await client.query(
      `INSERT INTO production_agent_imports (project_id, payload_hash, payload, completion_state, source_state, status)
       VALUES ($1,$2,$3,$4,$5,'mapping') RETURNING id`,
      [projectId, hash, project.assets == null ? null : JSON.stringify(project.assets), completion, JSON.stringify(sourceState)]
    );
    const importId = importInsert.rows[0].id;

    if (fatal) {
      await client.query("UPDATE production_agent_imports SET status = 'failed', error = $1 WHERE id = $2", [fatal, importId]);
      await audit(client, projectId, actorUserId, "import_failed", "import", importId, { error: fatal });
      await client.query("COMMIT");
      return { outcome: "failed", importId, error: fatal };
    }

    // Load what we already have, to match instead of duplicating.
    const existingRows = (await client.query("SELECT * FROM production_assets WHERE project_id = $1", [projectId])).rows;
    const byKey = new Map(); // `${kind}|${name_key}` -> asset
    for (const a of existingRows) byKey.set(`${a.kind}|${a.name_key}`, a);
    const counters = { character: 0, prop: 0, location: 0, other: 0 };
    for (const a of existingRows) {
      const n = parseInt(a.code.replace(/\D/g, ""), 10) || 0;
      counters[a.kind] = Math.max(counters[a.kind], n);
    }
    const prefixOf = Object.fromEntries(LISTS.map((l) => [l.kind, l.prefix]));

    const stats = { created: 0, updated: 0, unchanged: 0, needsReview: 0, quarantined: quarantined.length };
    const touchedIds = new Set();

    for (const q of quarantined) {
      await addIssue(client, {
        projectId, importId, category: "quarantined", severity: "warning",
        message: `Skipped an entry in "${q.list}"${q.index === null ? "" : ` (#${q.index + 1})`}: ${q.reason}`,
      });
    }

    for (const entry of entries) {
      // 1. find a match: same name, or this entry's alias is an existing name,
      //    or an existing asset lists this entry's name as an alias.
      const candidates = new Map();
      const direct = byKey.get(`${entry.kind}|${entry.nameKey}`);
      if (direct) candidates.set(direct.id, direct);
      for (const alias of entry.aliases) {
        const hit = byKey.get(`${entry.kind}|${nameKey(alias)}`);
        if (hit) candidates.set(hit.id, hit);
      }
      for (const a of byKeyValues(byKey)) {
        if (a.kind === entry.kind && (a.aliases ?? []).some((x) => nameKey(x) === entry.nameKey)) candidates.set(a.id, a);
      }

      if (candidates.size > 1) {
        await addIssue(client, {
          projectId, importId, category: "ambiguous_match", severity: "warning",
          message: `"${entry.name}" could be any of: ${[...candidates.values()].map((c) => `${c.code} ${c.name}`).join(", ")}. Not merged — please decide.`,
        });
        stats.needsReview++;
        continue;
      }

      const details = detailsOf(entry);
      const missing = computeMissing(entry);
      let asset = candidates.size === 1 ? [...candidates.values()][0] : null;

      if (asset && touchedIds.has(asset.id)) {
        await addIssue(client, {
          projectId, assetId: asset.id, importId, category: "duplicate_in_output", severity: "info",
          message: `The agent listed "${entry.name}" more than once; only the first entry was used.`,
        });
        continue;
      }

      if (!asset) {
        counters[entry.kind] += 1;
        const code = `${prefixOf[entry.kind]}${String(counters[entry.kind]).padStart(3, "0")}`;
        const inserted = await client.query(
          `INSERT INTO production_assets (project_id, kind, code, name, name_key, aliases, agent_details, first_import_id, last_import_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
          [projectId, entry.kind, code, entry.name, entry.nameKey, JSON.stringify(entry.aliases), JSON.stringify(details), importId]
        );
        asset = inserted.rows[0];
        byKey.set(`${asset.kind}|${asset.name_key}`, asset);
        stats.created++;
        await audit(client, projectId, actorUserId, "asset_created", "asset", asset.id, { code, name: entry.name, importId });
      } else {
        const changed = canonicalJson(asset.agent_details) !== canonicalJson(details);
        const mergedAliases = [...new Set([...(asset.aliases ?? []), ...entry.aliases])];
        const aliasesChanged = mergedAliases.length !== (asset.aliases ?? []).length;
        if (changed || aliasesChanged) {
          await client.query(
            `UPDATE production_assets SET agent_details = $1, aliases = $2, imported_revision = imported_revision + $3,
               last_import_id = $4, in_latest_import = TRUE, updated_at = now() WHERE id = $5`,
            [JSON.stringify(details), JSON.stringify(mergedAliases), changed ? 1 : 0, importId, asset.id]
          );
          stats.updated++;
          const hasHumanWork = Object.keys(asset.human_edits ?? {}).length > 0 || asset.review_status === "approved";
          if (changed && hasHumanWork) {
            await addIssue(client, {
              projectId, assetId: asset.id, importId, category: "agent_update", severity: "warning",
              message: `The agent's description of "${asset.name}" changed after a person edited or approved it. Your edits were kept; review the new agent details.`,
            });
            stats.needsReview++;
          }
        } else {
          await client.query("UPDATE production_assets SET last_import_id = $1, in_latest_import = TRUE WHERE id = $2", [importId, asset.id]);
          stats.unchanged++;
        }
      }
      touchedIds.add(asset.id);

      stats.needsReview += await syncMissingIssues(client, { projectId, assetId: asset.id, importId, entry: { ...entry, ...effectiveEntryOverrides(asset) } });
    }

    // Assets we already had that this output no longer lists: keep them (the
    // agent can drop things between runs), but say so.
    for (const a of existingRows) {
      if (!touchedIds.has(a.id)) {
        await client.query("UPDATE production_assets SET in_latest_import = FALSE WHERE id = $1", [a.id]);
      }
    }

    const totals = (
      await client.query(
        `SELECT
           (count(*) FILTER (WHERE kind = 'character'))::int AS characters,
           (count(*) FILTER (WHERE kind = 'prop'))::int AS properties,
           (count(*) FILTER (WHERE kind = 'location'))::int AS locations,
           (count(*) FILTER (WHERE kind = 'other'))::int AS other
         FROM production_assets WHERE project_id = $1`,
        [projectId]
      )
    ).rows[0];
    const openIssues = Number((await client.query("SELECT count(*) FROM production_issues WHERE project_id = $1 AND status = 'open'", [projectId])).rows[0].count);
    const status = stats.quarantined > 0 || stats.needsReview > 0 ? "partially_ready" : "ready";
    const summary = { ...stats, totals, openIssues };
    await client.query("UPDATE production_agent_imports SET status = $1, summary = $2 WHERE id = $3", [status, JSON.stringify(summary), importId]);
    await audit(client, projectId, actorUserId, "import_completed", "import", importId, summary);
    await client.query("COMMIT");
    return { outcome: "imported", importId, status, summary };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Missing-information issues: add the ones that apply, close the ones that no
// longer do. Returns how many new ones were added.
async function syncMissingIssues(client, { projectId, assetId, importId = null, entry }) {
  const stillMissing = computeMissing(entry);
  const open = (
    await client.query("SELECT id, message FROM production_issues WHERE asset_id = $1 AND category = 'missing_info' AND status = 'open'", [assetId])
  ).rows;
  for (const issue of open) {
    if (!stillMissing.includes(issue.message)) {
      await client.query("UPDATE production_issues SET status = 'resolved', resolved_at = now() WHERE id = $1", [issue.id]);
    }
  }
  let added = 0;
  for (const message of stillMissing) {
    if (await addIssue(client, { projectId, assetId, importId, category: "missing_info", message })) added++;
  }
  return added;
}

function byKeyValues(map) {
  return map.values();
}

// Overrides from human edits that matter for "what is still missing".
function effectiveEntryOverrides(asset) {
  const edits = asset.human_edits ?? {};
  const out = {};
  if (edits.description) out.description = edits.description;
  if (edits.sceneRefs) out.sceneRefs = edits.sceneRefs;
  if (edits.costumes) out.costumes = edits.costumes;
  if (edits.agentMissing) out.agentMissing = edits.agentMissing;
  return out;
}

// ---------------------------------------------------------------------------
// Read side — every number comes from saved rows
// ---------------------------------------------------------------------------

export async function getProductionOverview(db, projectId) {
  const lastImport = (
    await db.query(
      "SELECT id, status, completion_state, summary, error, received_at FROM production_agent_imports WHERE project_id = $1 ORDER BY id DESC LIMIT 1",
      [projectId]
    )
  ).rows[0] ?? null;
  const counts = (
    await db.query("SELECT kind, count(*)::int AS n FROM production_assets WHERE project_id = $1 GROUP BY kind", [projectId])
  ).rows;
  const issues = (
    await db.query(
      "SELECT category, count(*)::int AS n FROM production_issues WHERE project_id = $1 AND status = 'open' GROUP BY category",
      [projectId]
    )
  ).rows;
  const importsReceived = Number((await db.query("SELECT count(*) FROM production_agent_imports WHERE project_id = $1", [projectId])).rows[0].count);
  return {
    lastImport,
    importsReceived,
    assetsByKind: Object.fromEntries(counts.map((c) => [c.kind, c.n])),
    openIssuesByCategory: Object.fromEntries(issues.map((i) => [i.category, i.n])),
  };
}

export async function listProductionAssets(db, projectId, kind = null) {
  const params = [projectId];
  let where = "project_id = $1";
  if (kind) {
    params.push(kind);
    where += " AND kind = $2";
  }
  const rows = (await db.query(`SELECT * FROM production_assets WHERE ${where} ORDER BY kind, code`, params)).rows;
  const issueRows = (
    await db.query(
      "SELECT asset_id, category, message FROM production_issues WHERE project_id = $1 AND status = 'open' AND asset_id IS NOT NULL",
      [projectId]
    )
  ).rows;
  return rows.map((a) => ({
    id: a.id,
    code: a.code,
    kind: a.kind,
    name: a.name,
    aliases: a.aliases,
    details: effectiveDetails(a),
    importedOriginal: a.agent_details,
    hasHumanEdits: Object.keys(a.human_edits ?? {}).length > 0,
    importedRevision: a.imported_revision,
    inLatestImport: a.in_latest_import,
    reviewStatus: a.review_status,
    revision: a.revision,
    openIssues: issueRows.filter((i) => i.asset_id === a.id).map(({ category, message }) => ({ category, message })),
  }));
}

export async function listProductionIssues(db, projectId, status = "open") {
  return (
    await db.query(
      `SELECT i.id, i.asset_id, a.code AS asset_code, a.name AS asset_name, i.category, i.severity, i.message, i.status, i.created_at
       FROM production_issues i LEFT JOIN production_assets a ON a.id = i.asset_id
       WHERE i.project_id = $1 AND i.status = $2 ORDER BY i.id`,
      [projectId, status]
    )
  ).rows;
}

// ---------------------------------------------------------------------------
// Routes (admin only for now; roles for designers come with the designer step)
// ---------------------------------------------------------------------------

export function registerProductionRoutes(app, db, requireRole) {
  const parseProjectId = (req, res) => {
    const id = Number(req.params.projectId);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Not a valid project." });
      return null;
    }
    return id;
  };

  // Reads the silent agent's saved output and updates the dossier. Never
  // calls the AI, never costs anything.
  app.post("/api/production/:projectId/import", requireRole("admin"), async (req, res) => {
    const projectId = parseProjectId(req, res);
    if (!projectId) return;
    const result = await ingestAgentOutput(db, projectId, { actorUserId: req.user?.id });
    if (result.outcome === "not_found") {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.json(result);
  });

  // Edit an asset. Human edits are kept on top of the agent's version; send
  // null for a field to go back to the agent's version. 409 = changed meanwhile.
  app.patch("/api/production/:projectId/assets/:assetId", requireRole("admin"), async (req, res) => {
    const projectId = parseProjectId(req, res);
    if (!projectId) return;
    const assetId = Number(req.params.assetId);
    if (!Number.isInteger(assetId) || assetId <= 0) {
      res.status(400).json({ error: "Not a valid asset." });
      return;
    }
    try {
      const result = await updateProductionAsset(db, projectId, assetId, {
        expectedRevision: req.body?.expectedRevision, edits: req.body?.edits, actorUserId: req.user?.id,
      });
      if (result.outcome === "not_found") return res.status(404).json({ error: "Asset not found." });
      if (result.outcome === "conflict") {
        return res.status(409).json({ error: "This asset was changed by someone else (or a new import). Reload and try again.", currentRevision: result.currentRevision });
      }
      res.json(result);
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ error: error.message });
      throw error;
    }
  });

  app.post("/api/production/:projectId/issues/:issueId/dismiss", requireRole("admin"), async (req, res) => {
    const projectId = parseProjectId(req, res);
    if (!projectId) return;
    const issueId = Number(req.params.issueId);
    if (!Number.isInteger(issueId) || issueId <= 0) return res.status(400).json({ error: "Not a valid issue." });
    const result = await dismissProductionIssue(db, projectId, issueId, { note: req.body?.note ?? "", actorUserId: req.user?.id });
    if (result.outcome === "not_found") return res.status(404).json({ error: "Issue not found or already closed." });
    res.json(result);
  });

  // Creates (once) the "[TEST] Idea of an Idea" project and loads the dossier
  // from a hand-written stand-in for the silent agent's output.
  app.post("/api/production/dev/seed-test-project", requireRole("admin"), async (req, res) => {
    res.json(await seedTestProject(db, { actorUserId: req.user?.id }));
  });

  app.get("/api/production/:projectId/overview", requireRole("admin"), async (req, res) => {
    const projectId = parseProjectId(req, res);
    if (!projectId) return;
    res.json(await getProductionOverview(db, projectId));
  });

  app.get("/api/production/:projectId/assets", requireRole("admin"), async (req, res) => {
    const projectId = parseProjectId(req, res);
    if (!projectId) return;
    const kind = ["character", "prop", "location", "other"].includes(req.query.kind) ? req.query.kind : null;
    res.json({ assets: await listProductionAssets(db, projectId, kind) });
  });

  app.get("/api/production/:projectId/issues", requireRole("admin"), async (req, res) => {
    const projectId = parseProjectId(req, res);
    if (!projectId) return;
    res.json({ issues: await listProductionIssues(db, projectId, req.query.status === "resolved" ? "resolved" : "open") });
  });
}

// ---------------------------------------------------------------------------
// Editing the dossier (human edits sit on top of what the agent said)
// ---------------------------------------------------------------------------

const EDITABLE_FIELDS = ["description", "states", "sceneRefs", "costumes", "notes"];

// Checks one edit payload and returns clean values. Throws a 400-style error.
export function validateAssetEdits(edits) {
  const bad = (message) => Object.assign(new Error(message), { status: 400 });
  if (!edits || typeof edits !== "object" || Array.isArray(edits)) throw bad("Nothing to change.");
  const clean = {};
  for (const [key, value] of Object.entries(edits)) {
    if (!EDITABLE_FIELDS.includes(key)) throw bad(`"${key}" cannot be edited.`);
    if (value === null) { clean[key] = null; continue; } // null = go back to the agent's version
    if (key === "description") {
      if (typeof value !== "object" || Array.isArray(value)) throw bad("Description must have en and hi text.");
      const en = typeof value.en === "string" ? value.en.trim() : "";
      const hi = typeof value.hi === "string" ? value.hi.trim() : "";
      if (en.length > 4000 || hi.length > 4000) throw bad("Description is too long.");
      clean.description = { en, hi };
    } else if (key === "notes") {
      if (typeof value !== "string" || value.length > 4000) throw bad("Notes must be text under 4000 characters.");
      clean.notes = value.trim();
    } else if (key === "costumes") {
      if (!Array.isArray(value) || value.length > 50) throw bad("Costumes must be a list.");
      clean.costumes = value.map((c) => {
        if (!c || typeof c.name !== "string" || !c.name.trim() || c.name.length > 200) throw bad("Each costume needs a name.");
        return { name: c.name.trim(), description: typeof c.description === "string" ? c.description.trim().slice(0, 2000) : "" };
      });
    } else {
      if (!Array.isArray(value) || value.length > 100 || value.some((v) => typeof v !== "string" || v.length > 300)) throw bad(`${key} must be a list of short texts.`);
      clean[key] = [...new Set(value.map((v) => v.trim()).filter(Boolean))];
    }
  }
  return clean;
}

// expectedRevision must match what the person was looking at, otherwise
// someone (or a new import) changed it first and they must look again.
export async function updateProductionAsset(db, projectId, assetId, { expectedRevision, edits, actorUserId = null }) {
  const clean = validateAssetEdits(edits);
  if (!Number.isInteger(expectedRevision)) throw Object.assign(new Error("expectedRevision is required."), { status: 400 });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query("SELECT * FROM production_assets WHERE id = $1 AND project_id = $2 FOR UPDATE", [assetId, projectId])).rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (row.revision !== expectedRevision) {
      await client.query("ROLLBACK");
      return { outcome: "conflict", currentRevision: row.revision };
    }
    const humanEdits = { ...(row.human_edits ?? {}) };
    for (const [key, value] of Object.entries(clean)) {
      if (value === null) delete humanEdits[key];
      else humanEdits[key] = value;
    }
    const updated = (
      await client.query(
        "UPDATE production_assets SET human_edits = $1, revision = revision + 1, updated_at = now() WHERE id = $2 RETURNING *",
        [JSON.stringify(humanEdits), assetId]
      )
    ).rows[0];
    const entry = {
      kind: updated.kind,
      ...effectiveDetails(updated),
      description: effectiveDetails(updated).description ?? { en: "", hi: "" },
      costumes: effectiveDetails(updated).costumes ?? [],
      sceneRefs: effectiveDetails(updated).sceneRefs ?? [],
      agentMissing: updated.agent_details?.agentMissing ?? [],
    };
    await syncMissingIssues(client, { projectId, assetId, entry });
    await audit(client, projectId, actorUserId, "asset_edited", "asset", assetId, {
      fields: Object.keys(clean),
      before: Object.fromEntries(Object.keys(clean).map((k) => [k, row.human_edits?.[k] ?? row.agent_details?.[k] ?? null])),
    });
    await client.query("COMMIT");
    return { outcome: "updated", revision: updated.revision };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// "I have dealt with this / it does not matter": stays closed even when a
// later import mentions the same thing again.
export async function dismissProductionIssue(db, projectId, issueId, { note = "", actorUserId = null } = {}) {
  const result = await db.query(
    `UPDATE production_issues SET status = 'dismissed', resolved_at = now(), resolution_note = $1
     WHERE id = $2 AND project_id = $3 AND status = 'open' RETURNING id, asset_id`,
    [String(note).slice(0, 1000), issueId, projectId]
  );
  if (result.rowCount === 0) return { outcome: "not_found" };
  await db.query(
    "INSERT INTO production_audit_events (project_id, actor_user_id, action, entity, entity_id, detail) VALUES ($1,$2,'issue_dismissed','issue',$3,$4)",
    [projectId, actorUserId, issueId, JSON.stringify({ note: String(note).slice(0, 1000) })]
  );
  return { outcome: "dismissed" };
}

// ---------------------------------------------------------------------------
// Test project: the "Idea of an Idea" screenplay + a HAND-WRITTEN stand-in for
// the silent agent's output (see fixtures/idea-of-an-idea.assets.js).
// ---------------------------------------------------------------------------

export async function seedTestProject(db, { actorUserId = null, fixturesDir = path.join(import.meta.dirname, "fixtures") } = {}) {
  const { IDEA_OF_AN_IDEA_TITLE, IDEA_OF_AN_IDEA_ASSETS } = await import(path.join(fixturesDir, "idea-of-an-idea.assets.js"));
  const screenplay = fs.readFileSync(path.join(fixturesDir, "idea-of-an-idea.md"), "utf8");
  const existing = await db.query("SELECT id FROM ai_movie_projects WHERE title = $1 ORDER BY id LIMIT 1", [IDEA_OF_AN_IDEA_TITLE]);
  let projectId = existing.rows[0]?.id;
  let created = false;
  if (!projectId) {
    const inserted = await db.query(
      "INSERT INTO ai_movie_projects (title, pasted_text, detected_stage, assets, created_by) VALUES ($1,$2,'screenplay',$3,$4) RETURNING id",
      [IDEA_OF_AN_IDEA_TITLE, screenplay, JSON.stringify(IDEA_OF_AN_IDEA_ASSETS), actorUserId]
    );
    projectId = inserted.rows[0].id;
    created = true;
  }
  const result = await ingestAgentOutput(db, projectId, { actorUserId });
  return { projectId, created, import: result };
}

// Called after the silent agent saves new output. Never throws: the agent's
// own work must not fail because of the production side.
export async function syncProductionQuietly(db, projectId) {
  try {
    await ingestAgentOutput(db, projectId);
  } catch (error) {
    console.error("Production dossier sync failed (agent output itself is saved):", error.message);
  }
}
