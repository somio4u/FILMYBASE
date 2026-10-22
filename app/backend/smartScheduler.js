// The Smart Scheduler — a SEPARATE agent (like Adu): it only READS a project's approved screenplay, and keeps its own briefs and runs in
// its own tables. It never touches the Production Management shoot schedule.
//   1. read the screenplay: per scene the place, day/night, minutes, and who is in it
//   2. the AI (the best model) reads it too: merges names that are the same place / person, finds scenes that must stay together or
//      in order, and notes what looks risky
//   3. scheduleSolver.js (plain arithmetic) makes the day plan within the days the owner asks for, using the owner's categories
//      (artists costly / normal / cheap, locations free / paid)
import crypto from "crypto";
import { solveSchedule } from "./scheduleSolver.js";

export const ANALYSIS_SYSTEM_PROMPT = `You are the scheduling analyst of a film/series production. You get every scene of a screenplay in short form (id, heading, minutes, who is in it, one line of what happens). Do NOT make a schedule — a program does that. Tell the program what it cannot see:
- locationAliases: places written differently but physically the SAME set (e.g. "TEMPLE", "KALI TEMPLE GROUNDS", "TEMPLE COURTYARD"). Give one canonical name (one of the written names) and the aliases. Only merge when they are really one place.
- characterAliases: names that are the SAME person (e.g. "DOCTOR" and "SOUMYA" ONLY if the script makes it certain; "BALARAM'S MAN" is not Balaram). Be careful: never merge two different people.
- voiceOnly: names that only speak as a voice (narrator, V.O., an echo) and need no one on set.
- artistKinds: for each person: lead, supporting, extra (crowd, villagers, workers, police constables) or child (a minor).
- sameDay: groups of scene ids that must be shot on the same day (a continuous action split over two scenes, one costume/make-up state, a one-time effect like rain or a fire).
- order: pairs [before, after] of scene ids where the first must be shot no later than the second (an injury or change that carries on, a prop that gets destroyed).
- notes: up to 8 short, plain remarks on what makes this screenplay hard to schedule (many night scenes, a child in many scenes, one place used in many episodes, a heavy crowd scene …).
Use ONLY the ids and names you were given, spelled exactly. If nothing applies, return empty lists. Do not invent.`;

const textOf = (v) => (v && typeof v === "object" ? v.en || v.or || v.hi || "" : String(v ?? ""));
const NIGHT = /NIGHT|EVENING|DUSK|MIDNIGHT/;
const upper = (v) => String(v ?? "").trim().toUpperCase();

// every scene of the screenplay as the scheduler needs it. written = Map("e-s" -> the latest screenplay content of that scene)
export function sceneRowsFromList(sceneList, written) {
  const groups = Array.isArray(sceneList.episodeScenes)
    ? sceneList.episodeScenes.map((e, i) => ({ episodeIndex: i, scenes: e.scenes ?? [] }))
    : [{ episodeIndex: null, scenes: sceneList.scenes ?? [] }];
  const rows = [];
  for (const g of groups) {
    g.scenes.forEach((scene, si) => {
      const key = `${g.episodeIndex ?? "film"}-${si}`;
      const content = written?.get?.(key);
      const names = new Set();
      for (const n of content?.charactersPresent ?? []) if (upper(n)) names.add(upper(n));
      for (const e of content?.elements ?? []) {
        if (e.type === "dialogue" && e.character && e.characterModifier !== "V.O.") names.add(upper(e.character));
      }
      const timeOfDay = upper(scene.timeOfDay) || "DAY";
      rows.push({
        id: key,
        label: scene.sceneNumber ? String(scene.sceneNumber) : g.episodeIndex === null ? `S${si + 1}` : `E${g.episodeIndex + 1}S${si + 1}`,
        episode: g.episodeIndex,
        minutes: Math.max(0.5, Number(scene.estimatedMinutes) || 2),
        location: upper(textOf(scene.location)) || "UNKNOWN LOCATION",
        intExt: scene.intExt === "EXT" ? "EXT" : String(scene.intExt || "INT"),
        timeOfDay,
        night: NIGHT.test(timeOfDay),
        artists: [...names].sort(),
        written: Boolean(content?.elements?.length),
        gist: String(textOf(scene.oneLiner)).slice(0, 140),
      });
    });
  }
  return rows;
}

// what changed in the screenplay since a run: a fingerprint per scene (place, time, minutes, who is in it)
export function sceneFingerprints(rows) {
  return Object.fromEntries(rows.map((r) => [r.id, crypto.createHash("sha1").update(`${r.location}|${r.timeOfDay}|${r.minutes}|${r.artists.join(",")}|${r.written}`).digest("hex").slice(0, 12)]));
}
export function changedSince(oldPrints, rows) {
  const now = sceneFingerprints(rows);
  const ids = new Set([...Object.keys(oldPrints ?? {}), ...Object.keys(now)]);
  return [...ids].filter((id) => oldPrints?.[id] !== now[id]);
}

// artists and locations to show the owner (counts), with the categories he already gave
export function briefLists(rows, brief) {
  const artists = new Map();
  const locations = new Map();
  for (const r of rows) {
    for (const a of r.artists) { const x = artists.get(a) ?? { name: a, scenes: 0, minutes: 0 }; x.scenes++; x.minutes += r.minutes; artists.set(a, x); }
    const l = locations.get(r.location) ?? { name: r.location, scenes: 0, minutes: 0 }; l.scenes++; l.minutes += r.minutes; locations.set(r.location, l);
  }
  const round = (n) => Math.round(n * 10) / 10;
  return {
    artists: [...artists.values()].sort((a, b) => b.minutes - a.minutes).map((a) => ({ ...a, minutes: round(a.minutes), category: ["costly", "normal", "cheap"].includes(brief?.artists?.[a.name]) ? brief.artists[a.name] : "normal" })),
    locations: [...locations.values()].sort((a, b) => b.minutes - a.minutes).map((l) => ({ ...l, minutes: round(l.minutes), category: ["free", "paid"].includes(brief?.locations?.[l.name]) ? brief.locations[l.name] : "free" })),
  };
}

// what the AI is shown
export function analysisInput(rows) {
  return rows.map((r) => `${r.id} | ${r.label} | ${r.intExt}. ${r.location} - ${r.timeOfDay} | ${r.minutes} min | ${r.artists.join(", ") || "(not written yet)"} | ${r.gist}`).join("\n");
}

// the AI's answer, cleaned: only real ids and names, aliases that are really present
export function cleanAnalysis(raw, rows) {
  const ids = new Set(rows.map((r) => r.id));
  const locationNames = new Set(rows.map((r) => r.location));
  const artistNames = new Set(rows.flatMap((r) => r.artists));
  const aliasMap = (list, present) => {
    const map = new Map();
    for (const g of Array.isArray(list) ? list : []) {
      const canonical = upper(g?.canonical);
      if (!present.has(canonical)) continue;
      for (const a of Array.isArray(g.aliases) ? g.aliases : []) {
        const alias = upper(a);
        if (alias && alias !== canonical && present.has(alias) && !map.has(alias)) map.set(alias, canonical);
      }
    }
    // an alias of an alias ends at the final canonical name
    for (const [alias, canonical] of map) { let c = canonical; let guard = 0; while (map.has(c) && guard++ < 5) c = map.get(c); map.set(alias, c); }
    return Object.fromEntries(map);
  };
  const kinds = {};
  for (const k of Array.isArray(raw?.artistKinds) ? raw.artistKinds : []) {
    const name = upper(k?.name);
    if (artistNames.has(name) && ["lead", "supporting", "extra", "child"].includes(k.kind)) kinds[name] = k.kind;
  }
  return {
    locationAliases: aliasMap(raw?.locationAliases, locationNames),
    characterAliases: aliasMap(raw?.characterAliases, artistNames),
    voiceOnly: [...new Set((Array.isArray(raw?.voiceOnly) ? raw.voiceOnly : []).map(upper).filter((n) => artistNames.has(n)))],
    artistKinds: kinds,
    sameDay: (Array.isArray(raw?.sameDay) ? raw.sameDay : []).map((g) => [...new Set((g?.sceneIds ?? []).filter((id) => ids.has(id)))]).filter((g) => g.length > 1),
    order: (Array.isArray(raw?.order) ? raw.order : []).map((o) => [o?.before, o?.after]).filter(([a, b]) => ids.has(a) && ids.has(b) && a !== b),
    notes: (Array.isArray(raw?.notes) ? raw.notes : []).filter((n) => typeof n === "string" && n.trim()).slice(0, 8).map((n) => n.trim()),
  };
}

// rows with the merged names; voice-only names no longer need a call
export function applyAnalysis(rows, analysis) {
  if (!analysis) return rows;
  const voice = new Set(analysis.voiceOnly ?? []);
  return rows.map((r) => ({
    ...r,
    location: analysis.locationAliases?.[r.location] ?? r.location,
    artists: [...new Set(r.artists.filter((a) => !voice.has(a)).map((a) => analysis.characterAliases?.[a] ?? a))].sort(),
  }));
}

// the category of a merged name is that of its most expensive member
const RANK = { costly: 3, normal: 2, cheap: 1, paid: 2, free: 1 };
export function categoriesFor(brief, analysis) {
  const out = { artist: {}, location: {} };
  const take = (target, raw, canonicalOf, fallback) => {
    for (const [name, cat] of Object.entries(raw ?? {})) {
      const key = canonicalOf?.[name] ?? name;
      if (!target[key] || RANK[cat] > RANK[target[key]]) target[key] = cat;
    }
    return fallback;
  };
  take(out.artist, brief?.artists, analysis?.characterAliases);
  take(out.location, brief?.locations, analysis?.locationAliases);
  return { artistCategory: out.artist, locationCategory: out.location };
}

// rows + brief (+ the AI analysis) -> the finished plan
export function buildPlan(rows, brief, analysis) {
  const merged = applyAnalysis(rows, analysis);
  const { artistCategory, locationCategory } = categoriesFor(brief, analysis);
  const plan = solveSchedule({
    scenes: merged.map((r) => ({ id: r.id, label: r.label, minutes: r.minutes, location: r.location, night: r.night, artists: r.artists })),
    days: brief.days,
    artistCategory, locationCategory,
    maxMinutesPerDay: brief.maxMinutesPerDay ?? null,
    sameDay: analysis?.sameDay ?? [], order: analysis?.order ?? [],
  });
  const unwritten = rows.filter((r) => !r.written).length;
  if (unwritten > 0) plan.warnings.push(`${unwritten} scene${unwritten === 1 ? " is" : "s are"} not written yet, so who is in ${unwritten === 1 ? "it" : "them"} is unknown — the artists' days are only as complete as the screenplay.`);
  return {
    ...plan,
    scenes: Object.fromEntries(merged.map((r) => [r.id, { label: r.label, episode: r.episode, location: r.location, intExt: r.intExt, timeOfDay: r.timeOfDay, minutes: r.minutes, artists: r.artists, gist: r.gist, written: r.written }])),
    notes: analysis?.notes ?? [],
    voiceOnly: analysis?.voiceOnly ?? [],
    artistKinds: analysis?.artistKinds ?? {},
    merged: { locations: analysis?.locationAliases ?? {}, artists: analysis?.characterAliases ?? {} },
    aiUsed: Boolean(analysis),
    input: { days: brief.days, maxMinutesPerDay: brief.maxMinutesPerDay ?? null },
  };
}

// ---- the database + routes ------------------------------------------------------------------------------------------------------------

export async function ensureSmartSchedulerSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS scheduler_briefs (
    scene_list_id INTEGER PRIMARY KEY,
    days INTEGER NOT NULL DEFAULT 10,
    max_minutes_per_day NUMERIC,
    artists JSONB NOT NULL DEFAULT '{}',
    locations JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS scheduler_runs (
    id SERIAL PRIMARY KEY,
    scene_list_id INTEGER NOT NULL,
    brief JSONB NOT NULL,
    result JSONB NOT NULL,
    fingerprints JSONB NOT NULL,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query("CREATE INDEX IF NOT EXISTS scheduler_runs_list ON scheduler_runs (scene_list_id, created_at DESC)");
}

const jobs = new Map();

// tools: { requireRole, askModel(systemInstruction, contents) -> the AI's JSON }
export function registerSmartSchedulerRoutes(app, db, tools) {
  const { requireRole, askModel } = tools;
  const admin = requireRole("admin");

  async function loadRows(sceneListId) {
    const list = (await db.query("SELECT content, status FROM scene_lists WHERE id = $1", [sceneListId])).rows[0];
    if (!list) return null;
    const writtenRows = (await db.query(
      `SELECT DISTINCT ON (episode_index, scene_index) episode_index, scene_index, content
       FROM screenplay_scenes WHERE scene_list_id = $1 ORDER BY episode_index, scene_index, created_at DESC, id DESC`, [sceneListId])).rows;
    const written = new Map(writtenRows.map((r) => [`${r.episode_index ?? "film"}-${r.scene_index}`, r.content]));
    return { rows: sceneRowsFromList(list.content, written), content: list.content };
  }
  async function loadBrief(sceneListId) {
    const b = (await db.query("SELECT days, max_minutes_per_day, artists, locations FROM scheduler_briefs WHERE scene_list_id = $1", [sceneListId])).rows[0];
    return b ? { days: b.days, maxMinutesPerDay: b.max_minutes_per_day === null ? null : Number(b.max_minutes_per_day), artists: b.artists, locations: b.locations } : { days: 10, maxMinutesPerDay: null, artists: {}, locations: {} };
  }

  app.get("/api/smart-scheduler/projects", admin, async (req, res) => {
    const lists = (await db.query(
      `SELECT DISTINCT ON (c.id) c.id AS concept_id, c.title, sl.id AS scene_list_id, sl.content
       FROM scene_lists sl
       LEFT JOIN bit_sheets bs ON bs.id = sl.bit_sheet_id
       LEFT JOIN three_act_structures tas ON tas.id = bs.three_act_structure_id
       LEFT JOIN pitch_decks pd ON pd.id = tas.pitch_deck_id
       JOIN concepts c ON c.id = COALESCE(sl.concept_id, pd.concept_id)
       WHERE sl.status = 'approved'
       ORDER BY c.id, sl.created_at DESC`)).rows;
    const out = [];
    for (const l of lists) {
      const groups = Array.isArray(l.content.episodeScenes) ? l.content.episodeScenes.map((e) => e.scenes ?? []) : [l.content.scenes ?? []];
      const all = groups.flat();
      const written = Number((await db.query("SELECT count(DISTINCT (episode_index, scene_index)) AS n FROM screenplay_scenes WHERE scene_list_id = $1", [l.scene_list_id])).rows[0].n);
      const last = (await db.query("SELECT created_at FROM scheduler_runs WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1", [l.scene_list_id])).rows[0];
      out.push({ conceptId: l.concept_id, title: l.title || `#${l.concept_id}`, sceneListId: l.scene_list_id, isSeries: Array.isArray(l.content.episodeScenes), episodes: groups.length, scenes: all.length, written, minutes: Math.round(all.reduce((n, s) => n + (Number(s.estimatedMinutes) || 0), 0)), lastRunAt: last?.created_at ?? null });
    }
    res.json(out.sort((a, b) => a.title.localeCompare(b.title)));
  });

  app.get("/api/smart-scheduler/:id/brief", admin, async (req, res) => {
    const id = Number(req.params.id);
    const data = await loadRows(id);
    if (!data) { res.status(404).json({ error: "Project not found" }); return; }
    const brief = await loadBrief(id);
    res.json({ brief: { days: brief.days, maxMinutesPerDay: brief.maxMinutesPerDay }, ...briefLists(data.rows, brief), scenes: data.rows.length, minutes: Math.round(data.rows.reduce((n, r) => n + r.minutes, 0) * 10) / 10 });
  });

  app.put("/api/smart-scheduler/:id/brief", admin, async (req, res) => {
    const id = Number(req.params.id);
    const days = Math.floor(Number(req.body.days));
    if (!(days >= 1 && days <= 60)) { res.status(400).json({ error: "Give the number of days (1 to 60)." }); return; }
    const max = req.body.maxMinutesPerDay === null || req.body.maxMinutesPerDay === "" || req.body.maxMinutesPerDay === undefined ? null : Number(req.body.maxMinutesPerDay);
    if (max !== null && !(max > 0 && max <= 120)) { res.status(400).json({ error: "Minutes per day must be between 1 and 120." }); return; }
    const clean = (obj, allowed) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k, v]) => k && allowed.includes(v)).map(([k, v]) => [upper(k), v]));
    await db.query(
      `INSERT INTO scheduler_briefs (scene_list_id, days, max_minutes_per_day, artists, locations, updated_at) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (scene_list_id) DO UPDATE SET days = EXCLUDED.days, max_minutes_per_day = EXCLUDED.max_minutes_per_day, artists = EXCLUDED.artists, locations = EXCLUDED.locations, updated_at = now()`,
      [id, days, max, JSON.stringify(clean(req.body.artists, ["costly", "normal", "cheap"])), JSON.stringify(clean(req.body.locations, ["free", "paid"]))]);
    res.json({ saved: true });
  });

  async function runJob(job, sceneListId, userId) {
    try {
      job.stage = "reading";
      const data = await loadRows(sceneListId);
      const brief = await loadBrief(sceneListId);
      if (data.rows.length === 0) throw new Error("This project has no scenes.");
      job.stage = "analysing";
      let analysis = null;
      try {
        analysis = cleanAnalysis(await askModel(ANALYSIS_SYSTEM_PROMPT, `SCENES (id | label | heading | minutes | who is in it | what happens):\n${analysisInput(data.rows)}\n\nReturn the analysis.`), data.rows);
      } catch (error) {
        console.error("Smart Scheduler: the AI analysis failed, planning from the screenplay data only:", error.message);
      }
      job.stage = "scheduling";
      const result = buildPlan(data.rows, brief, analysis);
      if (!analysis) result.warnings.unshift("The AI analysis was not available this time, so same-place names and 'keep together' rules were not applied. The plan uses the screenplay data only — run it again to include the analysis.");
      const inserted = await db.query(
        "INSERT INTO scheduler_runs (scene_list_id, brief, result, fingerprints, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at",
        [sceneListId, JSON.stringify(brief), JSON.stringify(result), JSON.stringify(sceneFingerprints(data.rows)), userId]);
      job.runId = inserted.rows[0].id;
      job.status = "done";
    } catch (error) {
      console.error("Smart Scheduler failed:", error.message);
      job.status = "error";
      job.error = error.message;
    }
  }

  app.post("/api/smart-scheduler/:id/run", admin, async (req, res) => {
    const id = Number(req.params.id);
    if (!(await loadRows(id))) { res.status(404).json({ error: "Project not found" }); return; }
    for (const [k, j] of jobs) if (Date.now() - j.startedAt > 60 * 60 * 1000) jobs.delete(k);
    const jobId = crypto.randomUUID();
    const job = { sceneListId: id, status: "running", stage: "reading", startedAt: Date.now() };
    jobs.set(jobId, job);
    runJob(job, id, req.user.id);
    res.json({ jobId });
  });

  app.get("/api/smart-scheduler/:id/run/:jobId", admin, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.sceneListId !== Number(req.params.id)) { res.status(404).json({ error: "That run is no longer available." }); return; }
    res.json({ status: job.status, stage: job.stage, error: job.error ?? null, runId: job.runId ?? null });
  });

  // the newest run, and whether the screenplay has changed since (which scenes)
  app.get("/api/smart-scheduler/:id/latest", admin, async (req, res) => {
    const id = Number(req.params.id);
    const run = (await db.query("SELECT id, brief, result, fingerprints, created_at FROM scheduler_runs WHERE scene_list_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [id])).rows[0];
    if (!run) { res.json({ run: null }); return; }
    const data = await loadRows(id);
    const changed = data ? changedSince(run.fingerprints, data.rows) : [];
    res.json({ run: { id: run.id, createdAt: run.created_at, brief: run.brief, ...run.result }, changedScenes: changed.length, stale: changed.length > 0 });
  });
}
