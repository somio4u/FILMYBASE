// Screenplay Doctor — the run: stored in the database, done in the background one group of scenes at a time (the scene map, plants, payoffs, rules), then once for
// the whole film (the fourteen lenses). Same machinery as Dialogue Doctor; the AI is passed in, so tests use a fake one.
import { createWriteScenesJobs, publicView } from "./writeScenesJobs.js";
import { createRead, saveParts } from "./scriptDoctorReport.js";
import { loadScenes } from "./dialogueDoctorRun.js";
import { MARKETS, DEFAULT_MARKET, DOCTOR_SYSTEM, CHUNK_SCHEMA, OVERVIEW_SCHEMA, timeline, characterLedger, beatPositions, lateEntrances, chunkPrompt, overviewPrompt, normalizeRows, normalizeOverview, chunksOf, toReportItems, overallScore } from "./screenplayDoctor.js";

export const SCREENPLAY_DOCTOR_KIND = "screenplay-doctor";
const err = (message, status = 400) => Object.assign(new Error(message), { status });

export async function ensureScreenplayDoctorSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS screenplay_doctor_runs (
    id SERIAL PRIMARY KEY, project_ref INTEGER NOT NULL, user_id INTEGER, market TEXT NOT NULL, scene_count INTEGER NOT NULL,
    film JSONB NOT NULL DEFAULT '{}', rows JSONB NOT NULL DEFAULT '[]', overview JSONB, sent_read_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ)`);
}

const rowView = (r) => (r ? { id: r.id, market: r.market, sceneCount: r.scene_count, film: r.film, rows: r.rows, overview: r.overview, sentReadId: r.sent_read_id, createdAt: r.created_at, finishedAt: r.finished_at } : null);

export function createScreenplayDoctor({ db, jobStore, makeAsk }) {
  const jobs = createWriteScenesJobs({
    jobStore,
    kind: SCREENPLAY_DOCTOR_KIND,
    isWritten: async (item) => {
      const row = (await db.query("SELECT rows, overview FROM screenplay_doctor_runs WHERE id = $1", [item.runId])).rows[0];
      if (!row) return true;
      return item.overview ? Boolean(row.overview) : (row.rows ?? []).some((n) => n.number >= item.from && n.number <= item.to);
    },
    describe: (item, n, total) => (item.overview ? `Looking at the whole film (${n} of ${total})` : `Scenes ${item.from}–${item.to} (${n} of ${total})`),
    writeOne: async (item, tools) => {
      const scenes = await loadScenes(db, item.projectId);
      const ask = makeAsk();
      const run = (await db.query("SELECT market, rows FROM screenplay_doctor_runs WHERE id = $1", [item.runId])).rows[0];
      if (item.overview) {
        await tools.say("The AI is judging the whole film through the fourteen lenses");
        const tl = timeline(scenes), ledger = characterLedger(scenes), late = lateEntrances(ledger, tl);
        const pbk = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [item.projectId])).rows[0]?.backfill ?? {};
        const film = { scenes: scenes.length, minutes: Math.round(tl.reduce((n, s) => n + s.minutes, 0)), characters: ledger, late };
        const synopsis = typeof pbk.synopsis === "string" ? pbk.synopsis : JSON.stringify(pbk.synopsis ?? pbk.plot ?? "").slice(0, 3000);
        const characters = JSON.stringify(pbk.characterArc ?? "").slice(0, 3000);
        const data = await ask("Screenplay Doctor: the whole film", overviewPrompt({ market: run.market, synopsis, characters, tl, rows: run.rows, ledger, late, film }), OVERVIEW_SCHEMA, DOCTOR_SYSTEM);
        const overview = normalizeOverview(data, scenes.length);
        if (!overview.verdict) throw new Error("The AI did not give a verdict for the whole film.");
        overview.positions = beatPositions(overview.beats, tl, run.market);
        overview.overall = overallScore(overview.scores);
        await db.query("UPDATE screenplay_doctor_runs SET overview = $2, film = $3, finished_at = now() WHERE id = $1", [item.runId, JSON.stringify(overview), JSON.stringify(film)]);
        return;
      }
      const numbers = Array.from({ length: item.to - item.from + 1 }, (_, i) => item.from + i);
      await tools.say(`The AI is reading scenes ${item.from}–${item.to}: the purpose of each, what changes, what is planted and paid off`);
      const data = await ask(`Screenplay Doctor: scenes ${item.from}–${item.to}`, chunkPrompt(numbers.map((n) => scenes[n - 1]).filter(Boolean), numbers, run.market), CHUNK_SCHEMA, DOCTOR_SYSTEM);
      const rows = normalizeRows(data, numbers);
      if (rows.length === 0) throw new Error("The AI gave no usable notes for these scenes.");
      await db.query("UPDATE screenplay_doctor_runs SET rows = (SELECT COALESCE(jsonb_agg(n ORDER BY (n->>'number')::int), '[]'::jsonb) FROM jsonb_array_elements(rows || $2::jsonb) n) WHERE id = $1", [item.runId, JSON.stringify(rows)]);
    },
  });

  const latestRun = async (projectId) => rowView((await db.query("SELECT * FROM screenplay_doctor_runs WHERE project_ref = $1 ORDER BY id DESC LIMIT 1", [projectId])).rows[0]);

  async function start(projectId, { userId, market }) {
    const mk = MARKETS[market] ? market : DEFAULT_MARKET;
    const scenes = await loadScenes(db, projectId);
    if (scenes.length < 3) throw err("The screenplay needs at least 3 written scenes to be reviewed.", 409);
    const running = await jobs.currentFor(projectId).catch(() => null);
    if (running?.status === "running") return { job: running, alreadyRunning: true };
    const run = (await db.query("INSERT INTO screenplay_doctor_runs (project_ref, user_id, market, scene_count) VALUES ($1,$2,$3,$4) RETURNING id", [projectId, userId, mk, scenes.length])).rows[0];
    const items = [...chunksOf(scenes.length).map((c) => ({ episodeIndex: null, sceneIndex: c.chunk, label: `Scenes ${c.from}–${c.to}`, runId: run.id, projectId, from: c.from, to: c.to })),
      { episodeIndex: null, sceneIndex: 9999, label: "Whole film", runId: run.id, projectId, overview: true }];
    return jobs.start({ sceneListId: projectId, userId, items, language: "en" });
  }

  async function sendToScriptDoctor(projectId, runId, userId) {
    const row = (await db.query("SELECT * FROM screenplay_doctor_runs WHERE id = $1 AND project_ref = $2", [runId, projectId])).rows[0];
    if (!row) throw err("That Screenplay Doctor run was not found.", 404);
    if (!row.overview) throw err("The Screenplay Doctor has not finished yet.", 409);
    const items = toReportItems(row.overview, row.overview.positions ?? [], row.film?.late ?? []);
    if (items.length === 0) throw err("The Screenplay Doctor found nothing to change.", 409);
    const text = `Screenplay Doctor — ${row.overview.verdict}. ${row.overview.verdictReason}\n\n${items.map((i) => `${i.title}\n${i.action}`).join("\n\n")}`;
    const read = await createRead(db, { projectRef: projectId, userId, filename: `Screenplay Doctor (${new Date(row.created_at).toISOString().slice(0, 10)})`, text });
    for (let part = 1; part <= read.parts; part++) await saveParts(db, read.id, part, part === 1 ? items : []);
    await db.query("UPDATE screenplay_doctor_runs SET sent_read_id = $2 WHERE id = $1", [runId, read.id]);
    return { readId: read.id, items: items.length };
  }

  // the findings as a list of changes, without making a read (the combined analysis puts both doctors' lists into ONE read)
  async function itemsFor(projectId, runId) {
    const row = (await db.query("SELECT * FROM screenplay_doctor_runs WHERE id = $1 AND project_ref = $2", [runId, projectId])).rows[0];
    if (!row?.overview) return { items: [], overview: null };
    return { items: toReportItems(row.overview, row.overview.positions ?? [], row.film?.late ?? []), overview: row.overview };
  }

  return { jobs, latestRun, start, sendToScriptDoctor, itemsFor, publicView };
}
