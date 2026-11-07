// Dialogue Doctor — the run: stored in the database, done in the background one group of scenes at a time (so the screen can show what it is doing right
// now, and it carries on after a reload or a server restart), then the whole-film overview. The AI is passed in, so tests use a fake one.
import { createWriteScenesJobs, publicView } from "./writeScenesJobs.js";
import { createRead, saveParts } from "./scriptDoctorReport.js";
import { GENRES, DEFAULT_GENRE, DOCTOR_SYSTEM, CHUNK_SCHEMA, OVERVIEW_SCHEMA, blocksOf, filmStats, sceneStats, chunkPrompt, overviewPrompt, normalizeNotes, normalizeOverview, chunksOf, toReportItems } from "./dialogueDoctor.js";

export const DOCTOR_KIND = "dialogue-doctor";
const err = (message, status = 400) => Object.assign(new Error(message), { status });

export async function ensureDialogueDoctorSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS dialogue_doctor_runs (
    id SERIAL PRIMARY KEY, project_ref INTEGER NOT NULL, user_id INTEGER, genre TEXT NOT NULL, scene_count INTEGER NOT NULL,
    film JSONB NOT NULL DEFAULT '{}', notes JSONB NOT NULL DEFAULT '[]', overview JSONB, sent_read_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ)`);
}

// every scene of the film in order (the Nth scene across all the beats = scene number N)
export async function loadScenes(db, projectId) {
  const row = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0];
  if (!row) throw err("Project not found.", 404);
  return (Array.isArray(row.backfill?.screenplayBeats) ? row.backfill.screenplayBeats : []).flatMap((b) => (Array.isArray(b?.scenes) ? b.scenes : []));
}

const rowView = (r) => (r ? { id: r.id, genre: r.genre, sceneCount: r.scene_count, film: r.film, notes: r.notes, overview: r.overview, sentReadId: r.sent_read_id, createdAt: r.created_at, finishedAt: r.finished_at } : null);

export function createDialogueDoctor({ db, jobStore, makeAsk }) {
  const jobs = createWriteScenesJobs({
    jobStore,
    kind: DOCTOR_KIND,
    isWritten: async (item) => {
      const row = (await db.query("SELECT notes, overview FROM dialogue_doctor_runs WHERE id = $1", [item.runId])).rows[0];
      if (!row) return true; // the run is gone
      return item.overview ? Boolean(row.overview) : (row.notes ?? []).some((n) => n.number >= item.from && n.number <= item.to);
    },
    describe: (item, n, total) => (item.overview ? `Looking at the whole film (${n} of ${total})` : `Scenes ${item.from}–${item.to} (${n} of ${total})`),
    writeOne: async (item, tools) => {
      const scenes = await loadScenes(db, item.projectId);
      const ask = makeAsk();
      if (item.overview) {
        await tools.say("The AI is judging the whole film: the must-have beats, the voices, the scores");
        const run = (await db.query("SELECT genre, notes FROM dialogue_doctor_runs WHERE id = $1", [item.runId])).rows[0];
        const film = filmStats(scenes);
        const gist = scenes.map((s, i) => { const first = blocksOf(s).find((b) => b.type === "dialogue"); return `${i + 1} — ${String(s?.sceneHeading?.en ?? "").slice(0, 60)} — ${first ? `${first.character}: ${first.text.slice(0, 50)}` : "(no dialogue)"}`; }).join("\n").slice(0, 14000);
        const data = await ask("Dialogue Doctor: the whole film", overviewPrompt(film, run.notes, run.genre, gist), OVERVIEW_SCHEMA, DOCTOR_SYSTEM);
        const overview = normalizeOverview(data);
        if (!overview.verdict) throw new Error("The AI did not give a verdict for the whole film.");
        await db.query("UPDATE dialogue_doctor_runs SET overview = $2, film = $3, finished_at = now() WHERE id = $1", [item.runId, JSON.stringify(overview), JSON.stringify(film)]);
        return;
      }
      const numbers = Array.from({ length: item.to - item.from + 1 }, (_, i) => item.from + i);
      const group = numbers.map((n) => scenes[n - 1]).filter(Boolean);
      await tools.say(`The AI is reading scenes ${item.from}–${item.to} (${group.reduce((n, s) => n + sceneStats(s, 0).dialogueLines, 0)} dialogue lines)`);
      const run = (await db.query("SELECT genre FROM dialogue_doctor_runs WHERE id = $1", [item.runId])).rows[0];
      const stats = group.map((s, i) => sceneStats(s, numbers[i]));
      const data = await ask(`Dialogue Doctor: scenes ${item.from}–${item.to}`, chunkPrompt(group, stats, run.genre, numbers), CHUNK_SCHEMA, DOCTOR_SYSTEM);
      const notes = normalizeNotes(data, numbers);
      if (notes.length === 0) throw new Error("The AI gave no usable notes for these scenes.");
      await db.query("UPDATE dialogue_doctor_runs SET notes = (SELECT COALESCE(jsonb_agg(n ORDER BY (n->>'number')::int), '[]'::jsonb) FROM jsonb_array_elements(notes || $2::jsonb) n) WHERE id = $1", [item.runId, JSON.stringify(notes)]);
    },
  });

  const latestRun = async (projectId) => rowView((await db.query("SELECT * FROM dialogue_doctor_runs WHERE project_ref = $1 ORDER BY id DESC LIMIT 1", [projectId])).rows[0]);

  async function start(projectId, { userId, genre }) {
    const g = GENRES[genre] ? genre : DEFAULT_GENRE;
    const scenes = await loadScenes(db, projectId);
    if (scenes.length === 0) throw err("There is no written screenplay in this project yet.", 409);
    if (!scenes.some((s) => blocksOf(s).some((b) => b.type === "dialogue"))) throw err("None of the scenes has dialogue yet. Write the dialogue first.", 409);
    const running = await jobs.currentFor(projectId).catch(() => null);
    if (running?.status === "running") return { job: running, alreadyRunning: true, run: await latestRun(projectId) };
    const film = filmStats(scenes);
    const run = (await db.query("INSERT INTO dialogue_doctor_runs (project_ref, user_id, genre, scene_count, film) VALUES ($1,$2,$3,$4,$5) RETURNING id", [projectId, userId, g, scenes.length, JSON.stringify(film)])).rows[0];
    const items = [...chunksOf(scenes.length).map((c) => ({ episodeIndex: null, sceneIndex: c.chunk, label: `Scenes ${c.from}–${c.to}`, runId: run.id, projectId, from: c.from, to: c.to })),
      { episodeIndex: null, sceneIndex: 9999, label: "Whole film", runId: run.id, projectId, overview: true }];
    const out = await jobs.start({ sceneListId: projectId, userId, items, language: "en" });
    return { ...out, run: await latestRun(projectId) };
  }

  // the findings -> a "read" in Script Doctor (so its ▶ / ⚡ buttons work on them)
  async function sendToScriptDoctor(projectId, runId, userId) {
    const row = (await db.query("SELECT * FROM dialogue_doctor_runs WHERE id = $1 AND project_ref = $2", [runId, projectId])).rows[0];
    if (!row) throw err("That Dialogue Doctor run was not found.", 404);
    if (!row.overview) throw err("The Dialogue Doctor has not finished yet.", 409);
    const items = toReportItems(row.notes, row.overview, row.film);
    if (items.length === 0) throw err("The Dialogue Doctor found nothing to change.", 409);
    const text = `Dialogue Doctor — ${row.overview.verdict}. ${row.overview.verdictReason}\n\n${items.map((i) => `${i.title}\n${i.action}`).join("\n\n")}`;
    const read = await createRead(db, { projectRef: projectId, userId, filename: `Dialogue Doctor (${new Date(row.created_at).toISOString().slice(0, 10)})`, text });
    // Script Doctor counts the parts of a report it has "read": every part is marked read, all the changes sit in the first
    for (let part = 1; part <= read.parts; part++) await saveParts(db, read.id, part, part === 1 ? items : []);
    await db.query("UPDATE dialogue_doctor_runs SET sent_read_id = $2 WHERE id = $1", [runId, read.id]);
    return { readId: read.id, items: items.length };
  }

  // the findings as a list of changes, without making a read (the combined analysis puts both doctors' lists into ONE read)
  async function itemsFor(projectId, runId) {
    const row = (await db.query("SELECT * FROM dialogue_doctor_runs WHERE id = $1 AND project_ref = $2", [runId, projectId])).rows[0];
    if (!row?.overview) return { items: [], overview: null };
    return { items: toReportItems(row.notes, row.overview, row.film), overview: row.overview };
  }

  return { jobs, latestRun, start, sendToScriptDoctor, itemsFor, publicView };
}
