// Pipeline step 1: analyze the screenplay.
//
// Reads the project's screenplay (the app's saved scenes, or plain screenplay
// text), stores every scene with its actions, dialogue lines and shot notes,
// gives each dialogue line a stable id (D001...), and links each scene to the
// characters, props and places in the Production Dossier. No AI is used, so it
// costs nothing and cannot hit a quota.

import crypto from "node:crypto";
import { addIssue, effectiveDetails } from "./production.js";
import { guessLanguage, parseScreenplayText, scenesFromBeats } from "./screenplayParse.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function ensureScreenplayAnalysisSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS production_scenes (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      scene_number TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_key TEXT NOT NULL,
      heading TEXT NOT NULL,
      int_ext TEXT,
      location TEXT,
      time_of_day TEXT,
      qualifier TEXT,
      beat_index INTEGER,
      estimated_minutes NUMERIC,
      order_index INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      in_latest BOOLEAN NOT NULL DEFAULT TRUE,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (project_id, source_key),
      UNIQUE (project_id, code)
    )`,
    `CREATE TABLE IF NOT EXISTS production_scene_elements (
      id SERIAL PRIMARY KEY,
      scene_id INTEGER NOT NULL REFERENCES production_scenes(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      order_index INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('action','dialogue','shot_hint','transition','note')),
      code TEXT,
      speaker TEXT,
      extension TEXT,
      parenthetical TEXT,
      label TEXT,
      text_en TEXT,
      text_hi TEXT,
      language TEXT,
      text_hash TEXT NOT NULL,
      UNIQUE (project_id, code)
    )`,
    `CREATE INDEX IF NOT EXISTS production_scene_elements_scene_idx ON production_scene_elements (scene_id, order_index)`,
    `CREATE TABLE IF NOT EXISTS production_scene_assets (
      scene_id INTEGER NOT NULL REFERENCES production_scenes(id) ON DELETE CASCADE,
      asset_id INTEGER NOT NULL REFERENCES production_assets(id) ON DELETE CASCADE,
      via JSONB NOT NULL DEFAULT '[]',
      PRIMARY KEY (scene_id, asset_id)
    )`,
  ];
  for (const sql of statements) await db.query(sql);
}

// ---------------------------------------------------------------------------
// Linking scenes to dossier assets (pure)
// ---------------------------------------------------------------------------

export function normalizeForMatch(text) {
  return String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}
const STOP = new Set(["the", "a", "an", "of", "and", "in", "on", "at", "to", "for", "with"]);
const tokens = (text) => normalizeForMatch(text).split(" ").filter((t) => t && !STOP.has(t));
export const contains = (haystack, phrase) => ` ${haystack} `.includes(` ${phrase} `);

export function phrasesOf(asset) {
  const out = new Set();
  for (const name of [asset.name, ...(asset.aliases ?? [])]) {
    const phrase = normalizeForMatch(name).replace(/^the /, "");
    if (phrase.length >= 3) out.add(phrase);
  }
  return [...out];
}

// Does an agent reference like "Scene 10" / "Beat 4" point at this scene?
function refPointsAt(ref, scene) {
  const scene_ = /^(?:scene|sc)\.?\s*([0-9][0-9.]*)/i.exec(ref);
  if (scene_) return scene_[1].replace(/\.$/, "") === String(scene.number);
  const beat = /^beat\s*(\d+)/i.exec(ref);
  return Boolean(beat) && scene.beatIndex !== undefined && scene.beatIndex !== null && Number(beat[1]) === scene.beatIndex + 1;
}

// assets: [{ id, kind, name, aliases[], sceneRefs[] }]. Returns Map(assetId -> [via...]).
// Places come from the scene heading only (a prop called "office bag" must not
// link the "Office" location); everything else from the words in the scene.
export function linkSceneToAssets(scene, assets) {
  const links = new Map();
  const add = (id, via) => links.set(id, [...new Set([...(links.get(id) ?? []), via])]);
  const textNorm = normalizeForMatch([scene.heading, ...scene.elements.map((e) => `${e.speaker ?? ""} ${e.text}`)].join(" "));
  // A character who is only TALKED ABOUT in someone's dialogue is not in the
  // scene: characters are found in the heading, the action and who speaks.
  const presenceNorm = normalizeForMatch([scene.heading, ...scene.elements.map((e) => (e.kind === "dialogue" ? e.speaker ?? "" : e.text))].join(" "));
  const speakers = [...new Set(scene.elements.filter((e) => e.kind === "dialogue" && e.speaker).map((e) => normalizeForMatch(e.speaker).replace(/^the /, "")))];
  const locNorm = normalizeForMatch([scene.location, scene.qualifier].filter(Boolean).join(" ") || scene.heading);
  const locTokens = new Set(tokens(locNorm));

  for (const asset of assets) {
    if ((asset.sceneRefs ?? []).some((ref) => refPointsAt(ref, scene))) add(asset.id, "agent_ref");
    const phrases = phrasesOf(asset);
    if (asset.kind === "location") {
      const nameTokens = tokens(asset.name);
      const common = nameTokens.filter((t) => locTokens.has(t)).length;
      const phraseHit = phrases.some((ph) => contains(locNorm, ph));
      const tokenHit = common >= 2 || (nameTokens.length > 0 && common === nameTokens.length);
      if (phraseHit || tokenHit) add(asset.id, "heading");
      continue;
    }
    if (phrases.some((ph) => contains(asset.kind === "character" ? presenceNorm : textNorm, ph))) add(asset.id, "text");
    if (asset.kind === "character" && speakers.some((sp) => phrases.some((ph) => ph === sp || contains(ph, sp)))) add(asset.id, "speaker");
  }
  return links;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

function toRows(scene) {
  return scene.elements.map((e, order) => {
    const both = e.textBoth;
    const language = both ? (both.hi && !both.en ? "hi" : "en") : guessLanguage(e.text);
    const en = both ? both.en : language === "en" ? e.text : "";
    const hi = both ? both.hi : language === "hi" ? e.text : "";
    return {
      order, kind: e.kind, speaker: e.speaker ?? null, extension: e.extension ?? null, parenthetical: e.parenthetical ?? null,
      label: e.label ?? null, text_en: en, text_hi: hi, language, text_hash: sha(`${e.kind}|${e.speaker ?? ""}|${e.text}`),
    };
  });
}

function pickSource(project) {
  const fromBeats = scenesFromBeats(project.backfill);
  if (fromBeats.length > 0) return { kind: "beats", scenes: fromBeats, warnings: [] };
  const text = (project.pasted_text ?? "").trim();
  if (text) {
    const parsed = parseScreenplayText(text);
    if (parsed.scenes.length > 0) return { kind: "text", scenes: parsed.scenes, warnings: parsed.warnings };
    return { kind: "text", scenes: [], warnings: parsed.warnings };
  }
  return { kind: null, scenes: [], warnings: [] };
}

export async function analyzeScreenplay(db, projectId, { actorUserId = null } = {}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const project = (await client.query("SELECT id, pasted_text, backfill FROM ai_movie_projects WHERE id = $1 FOR UPDATE", [projectId])).rows[0];
    if (!project) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    const source = pickSource(project);
    if (source.scenes.length === 0) {
      await client.query("ROLLBACK");
      return { outcome: "no_screenplay", warnings: source.warnings, message: source.kind ? "No scenes could be read from the screenplay text." : "This project has no screenplay yet." };
    }

    // ---- scenes ----
    const existing = (await client.query("SELECT * FROM production_scenes WHERE project_id = $1", [projectId])).rows;
    const byKey = new Map(existing.map((s) => [s.source_key, s]));
    let sceneCounter = existing.reduce((m, s) => Math.max(m, parseInt(s.code.replace(/\D/g, ""), 10) || 0), 0);
    let dialogueCounter = Number((await client.query("SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::int), 0) AS n FROM production_scene_elements WHERE project_id = $1", [projectId])).rows[0].n);
    const stats = { created: 0, updated: 0, unchanged: 0, removed: 0 };
    const seenKeys = new Set();
    const stored = []; // { row, scene }

    for (let order = 0; order < source.scenes.length; order++) {
      const scene = source.scenes[order];
      let key = source.kind === "beats" ? `b${scene.beatIndex}s${scene.sceneIndex}` : `n${scene.number}`;
      for (let dup = 2; seenKeys.has(key); dup++) key = `${source.kind === "beats" ? `b${scene.beatIndex}s${scene.sceneIndex}` : `n${scene.number}`}#${dup}`;
      seenKeys.add(key);
      const rows = toRows(scene);
      const contentHash = sha(JSON.stringify([scene.heading, rows.map((r) => r.text_hash)]));
      let sceneRow = byKey.get(key);
      if (!sceneRow) {
        sceneCounter += 1;
        sceneRow = (
          await client.query(
            `INSERT INTO production_scenes (project_id, code, scene_number, source_kind, source_key, heading, int_ext, location, time_of_day, qualifier, beat_index, estimated_minutes, order_index, content_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
            [projectId, `SC${String(sceneCounter).padStart(3, "0")}`, scene.number, source.kind, key, scene.heading, scene.intExt, scene.location, scene.time,
              scene.qualifier, scene.beatIndex ?? null, scene.estimatedMinutes ?? null, order, contentHash]
          )
        ).rows[0];
        stats.created++;
      } else if (sceneRow.content_hash !== contentHash || sceneRow.heading !== scene.heading || !sceneRow.in_latest || sceneRow.order_index !== order) {
        sceneRow = (
          await client.query(
            `UPDATE production_scenes SET scene_number=$1, heading=$2, int_ext=$3, location=$4, time_of_day=$5, qualifier=$6, beat_index=$7, estimated_minutes=$8,
               order_index=$9, content_hash=$10, in_latest=TRUE, revision = revision + CASE WHEN content_hash <> $10 THEN 1 ELSE 0 END, updated_at=now()
             WHERE id=$11 RETURNING *`,
            [scene.number, scene.heading, scene.intExt, scene.location, scene.time, scene.qualifier, scene.beatIndex ?? null, scene.estimatedMinutes ?? null, order, contentHash, sceneRow.id]
          )
        ).rows[0];
        stats.updated++;
      } else {
        stats.unchanged++;
      }

      // ---- elements: keep the ids of lines that did not change ----
      const old = (await client.query("SELECT * FROM production_scene_elements WHERE scene_id = $1 ORDER BY order_index", [sceneRow.id])).rows;
      const pool = new Map();
      for (const o of old) pool.set(o.text_hash, [...(pool.get(o.text_hash) ?? []), o]);
      const keep = new Set();
      for (const r of rows) {
        const reuse = pool.get(r.text_hash)?.shift();
        if (reuse) {
          keep.add(reuse.id);
          await client.query(
            "UPDATE production_scene_elements SET order_index=$1, extension=$2, parenthetical=$3, label=$4, text_en=$5, text_hi=$6, language=$7 WHERE id=$8",
            [r.order, r.extension, r.parenthetical, r.label, r.text_en, r.text_hi, r.language, reuse.id]
          );
        } else {
          let code = null;
          if (r.kind === "dialogue") {
            dialogueCounter += 1;
            code = `D${String(dialogueCounter).padStart(3, "0")}`;
          }
          await client.query(
            `INSERT INTO production_scene_elements (scene_id, project_id, order_index, kind, code, speaker, extension, parenthetical, label, text_en, text_hi, language, text_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [sceneRow.id, projectId, r.order, r.kind, code, r.speaker, r.extension, r.parenthetical, r.label, r.text_en, r.text_hi, r.language, r.text_hash]
          );
        }
      }
      // old lines that are no longer in the script are removed
      const gone = old.filter((o) => !keep.has(o.id)).map((o) => o.id);
      if (gone.length > 0) await client.query("DELETE FROM production_scene_elements WHERE id = ANY($1)", [gone]);
      stored.push({ row: sceneRow, scene });
    }
    // scenes no longer in the script stay (ids are referenced later) but are marked
    for (const s of existing) {
      if (!seenKeys.has(s.source_key) && s.in_latest) {
        await client.query("UPDATE production_scenes SET in_latest = FALSE WHERE id = $1", [s.id]);
        stats.removed++;
      }
    }

    // ---- link scenes to dossier assets ----
    const assets = (await client.query("SELECT * FROM production_assets WHERE project_id = $1 ORDER BY id", [projectId])).rows.map((a) => ({
      id: a.id, kind: a.kind, code: a.code, name: a.name, aliases: a.aliases ?? [], sceneRefs: effectiveDetails(a).sceneRefs ?? [],
    }));
    await client.query("DELETE FROM production_scene_assets WHERE scene_id IN (SELECT id FROM production_scenes WHERE project_id = $1)", [projectId]);
    let linkCount = 0;
    const linkedAssetIds = new Set();
    for (const { row, scene } of stored) {
      for (const [assetId, via] of linkSceneToAssets({ ...scene, number: scene.number }, assets)) {
        await client.query("INSERT INTO production_scene_assets (scene_id, asset_id, via) VALUES ($1,$2,$3)", [row.id, assetId, JSON.stringify(via)]);
        linkedAssetIds.add(assetId);
        linkCount++;
      }
    }

    // ---- things a person should look at ----
    const characters = assets.filter((a) => a.kind === "character");
    const knownSpeaker = (name) => {
      const n = normalizeForMatch(name).replace(/^the /, "");
      return characters.some((c) => phrasesOf(c).some((ph) => ph === n || contains(ph, n)));
    };
    const wanted = []; // [category, assetId|null, message]
    const unknownSpeakers = new Map();
    for (const { row, scene } of stored) {
      if (!scene.location) wanted.push(["screenplay_no_location", null, `Scene ${scene.number} (${row.code}) has no clear location in its heading: "${scene.heading}".`]);
      for (const e of scene.elements) {
        if (e.kind === "dialogue" && e.speaker && !knownSpeaker(e.speaker) && !unknownSpeakers.has(e.speaker)) unknownSpeakers.set(e.speaker, scene.number);
      }
    }
    for (const [speaker, num] of unknownSpeakers) wanted.push(["screenplay_unknown_speaker", null, `"${speaker}" speaks in scene ${num} but is not a character in the dossier.`]);
    for (const a of assets) if (!linkedAssetIds.has(a.id)) wanted.push(["not_in_any_scene", a.id, `${a.code} ${a.name} is not found in any scene of the screenplay.`]);

    const owned = ["screenplay_no_location", "screenplay_unknown_speaker", "not_in_any_scene"];
    const open = (await client.query("SELECT id, category, message, COALESCE(asset_id,0) AS aid FROM production_issues WHERE project_id = $1 AND status = 'open' AND category = ANY($2)", [projectId, owned])).rows;
    for (const issue of open) {
      if (!wanted.some(([c, , m]) => c === issue.category && m === issue.message)) {
        await client.query("UPDATE production_issues SET status = 'resolved', resolved_at = now() WHERE id = $1", [issue.id]);
      }
    }
    for (const [category, assetId, message] of wanted) {
      await addIssue(client, { projectId, assetId, category, severity: category === "not_in_any_scene" ? "info" : "warning", message });
    }

    const totals = (
      await client.query(
        `SELECT count(*) FILTER (WHERE e.kind='dialogue')::int AS dialogue, count(*) FILTER (WHERE e.kind='shot_hint')::int AS shot_hints,
                count(*) FILTER (WHERE e.kind='action')::int AS actions
         FROM production_scene_elements e JOIN production_scenes s ON s.id = e.scene_id WHERE s.project_id = $1 AND s.in_latest`,
        [projectId]
      )
    ).rows[0];
    const summary = {
      source: source.kind, scenes: stored.length, dialogueLines: totals.dialogue, shotHints: totals.shot_hints, actions: totals.actions,
      links: linkCount, unknownSpeakers: [...unknownSpeakers.keys()], warnings: source.warnings, ...stats,
    };
    await client.query(
      "INSERT INTO production_audit_events (project_id, actor_user_id, action, entity, detail) VALUES ($1,$2,'screenplay_analyzed','scenes',$3)",
      [projectId, actorUserId, JSON.stringify(summary)]
    );
    await client.query("COMMIT");
    return { outcome: "analyzed", summary };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listScenes(db, projectId) {
  const scenes = (await db.query("SELECT * FROM production_scenes WHERE project_id = $1 AND in_latest ORDER BY order_index", [projectId])).rows;
  if (scenes.length === 0) return [];
  const counts = (
    await db.query(
      `SELECT scene_id, kind, count(*)::int AS n FROM production_scene_elements WHERE scene_id = ANY($1) GROUP BY scene_id, kind`, [scenes.map((s) => s.id)]
    )
  ).rows;
  const links = (
    await db.query(
      `SELECT sa.scene_id, a.id, a.code, a.name, a.kind FROM production_scene_assets sa JOIN production_assets a ON a.id = sa.asset_id
       WHERE sa.scene_id = ANY($1) ORDER BY a.kind, a.code`, [scenes.map((s) => s.id)]
    )
  ).rows;
  return scenes.map((s) => {
    const c = Object.fromEntries(counts.filter((x) => x.scene_id === s.id).map((x) => [x.kind, x.n]));
    return {
      id: s.id, code: s.code, number: s.scene_number, heading: s.heading, intExt: s.int_ext, location: s.location, timeOfDay: s.time_of_day,
      qualifier: s.qualifier, estimatedMinutes: s.estimated_minutes === null ? null : Number(s.estimated_minutes),
      counts: { actions: c.action ?? 0, dialogue: c.dialogue ?? 0, shotHints: c.shot_hint ?? 0 },
      assets: links.filter((l) => l.scene_id === s.id).map(({ id, code, name, kind }) => ({ id, code, name, kind })),
    };
  });
}

export async function getScene(db, projectId, sceneId) {
  const scene = (await db.query("SELECT * FROM production_scenes WHERE id = $1 AND project_id = $2", [sceneId, projectId])).rows[0];
  if (!scene) return null;
  const elements = (
    await db.query("SELECT id, order_index, kind, code, speaker, extension, parenthetical, label, text_en, text_hi, language FROM production_scene_elements WHERE scene_id = $1 ORDER BY order_index", [sceneId])
  ).rows.map((e) => ({
    id: e.id, kind: e.kind, code: e.code, speaker: e.speaker, extension: e.extension, parenthetical: e.parenthetical, label: e.label,
    text: e.text_en || e.text_hi, textEn: e.text_en, textHi: e.text_hi, language: e.language,
  }));
  const assets = (
    await db.query(
      `SELECT a.id, a.code, a.name, a.kind, sa.via FROM production_scene_assets sa JOIN production_assets a ON a.id = sa.asset_id WHERE sa.scene_id = $1 ORDER BY a.kind, a.code`, [sceneId]
    )
  ).rows;
  return {
    id: scene.id, code: scene.code, number: scene.scene_number, heading: scene.heading, intExt: scene.int_ext, location: scene.location,
    timeOfDay: scene.time_of_day, qualifier: scene.qualifier, revision: scene.revision, elements, assets,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerScreenplayRoutes(app, db, requireRole) {
  const id = (value) => (/^\d+$/.test(String(value)) && Number(value) > 0 ? Number(value) : null);

  app.post("/api/production/:projectId/analyze-screenplay", requireRole("admin"), async (req, res) => {
    const projectId = id(req.params.projectId);
    if (!projectId) return res.status(400).json({ error: "Not a valid project." });
    const result = await analyzeScreenplay(db, projectId, { actorUserId: req.user?.id });
    if (result.outcome === "not_found") return res.status(404).json({ error: "Project not found." });
    res.json(result);
  });

  app.get("/api/production/:projectId/scenes", requireRole("admin"), async (req, res) => {
    const projectId = id(req.params.projectId);
    if (!projectId) return res.status(400).json({ error: "Not a valid project." });
    res.json({ scenes: await listScenes(db, projectId) });
  });

  app.get("/api/production/:projectId/scenes/:sceneId", requireRole("admin"), async (req, res) => {
    const projectId = id(req.params.projectId);
    const sceneId = id(req.params.sceneId);
    if (!projectId || !sceneId) return res.status(400).json({ error: "Not a valid scene." });
    const scene = await getScene(db, projectId, sceneId);
    if (!scene) return res.status(404).json({ error: "Scene not found." });
    res.json(scene);
  });
}
