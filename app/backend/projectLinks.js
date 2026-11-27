// ONE project in two views. When a project is brought across (convertProject.js), the two copies are LINKED: whatever is changed in the screenplay of one —
// the words of the action and dialogue, the scene headings, scenes added, removed or moved — is made in the other too, in both directions.
// Only the screenplay travels. The Movie keeps its own scene list, schedule and the rest; the AI Movie keeps its Story Bible, cinematic details, beats' own notes.
//
// How: a small worker looks at every link every few seconds. Each side's screenplay is reduced to a plain "fingerprint" (heading + lines of every written scene).
// A fingerprint that is not the one remembered from the last sync means that side was changed: its screenplay is written into the other side, and both
// fingerprints are remembered again (so the change does not bounce back). If BOTH sides changed since the last sync, the one changed last wins.
// Scenes are matched by their position among the written scenes, so a scene moved or inserted anywhere shifts the others in the same way on both sides.
import { createHash } from "node:crypto";
import { filmEpisodeFromAiMovie, chooseLanguage } from "./convertProject.js";
import { outlineFor, sceneContent } from "./screenplayImport.js";

const sha = (x) => createHash("sha1").update(JSON.stringify(x)).digest("hex");
const both = (t) => ({ en: t, hi: t });

export async function ensureProjectLinkSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS project_links (
    id SERIAL PRIMARY KEY,
    film_concept_id INTEGER NOT NULL UNIQUE REFERENCES concepts(id) ON DELETE CASCADE,
    ai_movie_id INTEGER NOT NULL UNIQUE REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
    language TEXT NOT NULL DEFAULT 'en',
    film_hash TEXT, ai_hash TEXT, film_stamp TEXT, ai_stamp TEXT,
    last_synced_at TIMESTAMPTZ, last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

// ---- reading both sides ----------------------------------------------------------------------------------------------------------------------
const lineKey = (e) => [e.type, e.character ?? "", e.text ?? "", e.parenthetical ?? "", e.characterModifier ?? "none"];

async function readAi(db, aiId) {
  const row = (await db.query("SELECT backfill, updated_at FROM ai_movie_projects WHERE id = $1", [aiId])).rows[0];
  return row ? { backfill: row.backfill ?? {}, stamp: new Date(row.updated_at).toISOString() } : null;
}
export const aiFingerprint = (backfill, language) => sha(filmEpisodeFromAiMovie(backfill, language).scenes.map((s) => [s.heading, s.elements.map(lineKey)]));

async function readFilm(db, conceptId) {
  const list = (await db.query(
    `SELECT sl.id, sl.content FROM scene_lists sl LEFT JOIN bit_sheets bs ON bs.id = sl.bit_sheet_id LEFT JOIN three_act_structures tas ON tas.id = bs.three_act_structure_id
     LEFT JOIN pitch_decks pd ON pd.id = tas.pitch_deck_id WHERE sl.concept_id = $1 OR pd.concept_id = $1 ORDER BY sl.created_at DESC, sl.id DESC LIMIT 1`, [conceptId])).rows[0];
  if (!list || !Array.isArray(list.content?.scenes)) return null;
  const rows = (await db.query("SELECT DISTINCT ON (scene_index) scene_index, content, created_at FROM screenplay_scenes WHERE scene_list_id = $1 AND episode_index IS NULL ORDER BY scene_index, created_at DESC, id DESC", [list.id])).rows;
  const byIndex = new Map(rows.map((r) => [r.scene_index, r.content]));
  const written = rows.filter((r) => Array.isArray(r.content?.elements) && r.content.elements.length > 0).map((r) => r.scene_index).sort((a, b) => a - b);
  const stats = (await db.query("SELECT count(*)::int AS n, max(created_at) AS latest FROM screenplay_scenes WHERE scene_list_id = $1 AND episode_index IS NULL", [list.id])).rows[0];
  return { listId: list.id, listContent: list.content, outlines: list.content.scenes, byIndex, written, stamp: `${stats.n}:${stats.latest ? new Date(stats.latest).toISOString() : ""}`, latest: stats.latest ? new Date(stats.latest).getTime() : 0 };
}
const filmHeading = (o) => `${[o?.intExt, String(typeof o?.location === "string" ? o.location : o?.location?.en ?? "").trim()].filter(Boolean).join(". ")}${o?.timeOfDay ? ` - ${o.timeOfDay}` : ""}`.trim() || "INT. LOCATION - DAY";
export const filmFingerprint = (film) => sha(film.written.map((i) => [filmHeading(film.outlines[i]), (film.byIndex.get(i).elements ?? []).map((e) => lineKey({ ...e, text: e.text, parenthetical: e.parenthetical ?? "" }))]));

// ---- writing: AI Movie -> Movie ------------------------------------------------------------------------------------------------------------
async function writeFilmFromAi(db, link, ai, film) {
  const scenes = filmEpisodeFromAiMovie(ai.backfill, link.language).scenes;
  const outlines = film.outlines.map((o) => ({ ...o }));
  let next = outlines.length;
  const sameElements = (a, b) => JSON.stringify((a ?? []).map(lineKey)) === JSON.stringify((b ?? []).map(lineKey));
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (let r = 0; r < scenes.length; r += 1) {
      const scene = scenes[r];
      const index = film.written[r] ?? next++;
      const previous = film.byIndex.get(index);
      const fresh = outlineFor({ ...scene, oneLiner: scene.oneLiner }, index, undefined, 1, []);
      outlines[index] = outlines[index]
        ? { ...outlines[index], intExt: scene.intExt, location: both(scene.location), timeOfDay: scene.timeOfDay, estimatedMinutes: scene.minutes }
        : fresh;
      const elements = scene.elements.map((e) => (e.type === "dialogue" ? { type: "dialogue", character: e.character, characterModifier: e.characterModifier ?? "none", ...(e.parenthetical ? { parenthetical: e.parenthetical } : {}), text: e.text } : { type: e.type, character: "", text: e.text }));
      if (previous && sameElements(previous.elements, elements)) continue;
      const content = { ...(previous ?? {}), ...sceneContent(scene, link.language), importedFromFile: previous?.importedFromFile, editedByUser: true };
      await client.query("INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content) VALUES ($1, NULL, $2, $3)", [film.listId, index, JSON.stringify(content)]);
    }
    // scenes that no longer exist in the AI Movie: they go back to "not written yet" in the Movie (their one-line plan stays in the scene list)
    for (let r = scenes.length; r < film.written.length; r += 1) await client.query("DELETE FROM screenplay_scenes WHERE scene_list_id = $1 AND episode_index IS NULL AND scene_index = $2", [film.listId, film.written[r]]);
    await client.query("UPDATE scene_lists SET content = $2 WHERE id = $1", [film.listId, JSON.stringify({ ...film.listContent, scenes: outlines })]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
}

// ---- writing: Movie -> AI Movie ------------------------------------------------------------------------------------------------------------
const sceneKey = (scene, language) => { const x = filmEpisodeFromAiMovie({ screenplayBeats: [{ scenes: [scene] }] }, language).scenes[0]; return x ? sha([x.heading, x.elements.map(lineKey)]) : ""; };
const hasLines = (scene, language) => filmEpisodeFromAiMovie({ screenplayBeats: [{ scenes: [scene] }] }, language).scenes.length > 0;

export function mergeFilmIntoAiBeats(beats, sequence, language) {
  const queue = [...sequence];
  const merged = (beats ?? []).map((beat) => {
    const scenes = [];
    for (const old of beat?.scenes ?? []) {
      if (!hasLines(old, language)) { scenes.push(old); continue; } // an unwritten slot stays where it is
      const item = queue.shift();
      if (!item) continue; // the Movie has fewer scenes now: this one is gone
      const next = { sceneHeading: both(item.heading), content: item.content };
      // a scene whose words did not change keeps everything the AI Movie knows about it (card, tags, songs…); a changed one has its old card dropped, as for any edit
      if (sceneKey(old, language) === sceneKey(next, language)) { scenes.push(old); continue; }
      const { action: _a, dialogue: _d, card: _c, ...rest } = old;
      scenes.push({ ...rest, ...next, editedByUser: true, estimatedMinutes: rest.estimatedMinutes ?? item.estimatedMinutes });
    }
    return { ...beat, scenes };
  });
  if (queue.length) {
    const extra = queue.map((item) => ({ sceneHeading: both(item.heading), content: item.content, addedByUser: true, editedByUser: true, estimatedMinutes: item.estimatedMinutes }));
    if (merged.length === 0) merged.push({ status: "approved", feedback: null, scenes: extra });
    else merged[merged.length - 1] = { ...merged[merged.length - 1], scenes: [...merged[merged.length - 1].scenes, ...extra] };
  }
  return merged;
}

async function writeAiFromFilm(db, link, ai, film) {
  const sequence = film.written.map((i) => {
    const o = film.outlines[i];
    const content = (film.byIndex.get(i).elements ?? []).map((e) => {
      if (e.type === "dialogue") return { type: "dialogue", character: String(e.character ?? "").toUpperCase(), line: both(String(e.text ?? "")), ...(e.parenthetical ? { parenthetical: both(e.parenthetical) } : {}), ...(e.characterModifier === "V.O." || e.characterModifier === "O.S." ? { extension: e.characterModifier } : {}) };
      if (e.type === "transition") return { type: "transition", transition: String(e.text ?? "").toUpperCase() };
      return { type: "action", text: both(String(e.text ?? "")) };
    });
    return { heading: filmHeading(o), content, estimatedMinutes: Math.max(0.5, Math.min(15, Number(o?.estimatedMinutes) || 2)) };
  });
  const beats = mergeFilmIntoAiBeats(ai.backfill.screenplayBeats, sequence, link.language);
  await db.query("UPDATE ai_movie_projects SET backfill = jsonb_set(COALESCE(backfill,'{}'::jsonb), '{screenplayBeats}', $2::jsonb), updated_at = now() WHERE id = $1", [link.ai_movie_id, JSON.stringify(beats)]);
}

// ---- the link itself -----------------------------------------------------------------------------------------------------------------------
async function stateOf(db, link) {
  const ai = await readAi(db, link.ai_movie_id);
  const film = await readFilm(db, link.film_concept_id);
  if (!ai || !film) return null;
  return { ai, film, aiHash: aiFingerprint(ai.backfill, link.language), filmHash: filmFingerprint(film) };
}

export async function createProjectLink(db, { filmConceptId, aiMovieId, language = null }) {
  const ai = await readAi(db, aiMovieId);
  const lang = language ?? chooseLanguage(ai?.backfill);
  const link = { film_concept_id: filmConceptId, ai_movie_id: aiMovieId, language: lang };
  const s = await stateOf(db, link);
  if (!s) throw new Error("Cannot link: one of the two projects has no screenplay yet.");
  await db.query(
    `INSERT INTO project_links (film_concept_id, ai_movie_id, language, film_hash, ai_hash, film_stamp, ai_stamp, last_synced_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT (film_concept_id) DO UPDATE SET ai_movie_id = EXCLUDED.ai_movie_id, language = EXCLUDED.language, film_hash = EXCLUDED.film_hash, ai_hash = EXCLUDED.ai_hash, film_stamp = EXCLUDED.film_stamp, ai_stamp = EXCLUDED.ai_stamp`,
    [filmConceptId, aiMovieId, lang, s.filmHash, s.aiHash, s.film.stamp, s.ai.stamp]);
}

// One link, one look: returns "same" | "ai_to_film" | "film_to_ai" | "skipped"
export async function syncLink(db, link) {
  let s = await stateOf(db, link);
  if (!s) return "skipped";
  const filmChanged = s.filmHash !== link.film_hash, aiChanged = s.aiHash !== link.ai_hash;
  if (!filmChanged && !aiChanged) return "same";
  // both changed since the last sync: the side changed last wins
  const direction = filmChanged && aiChanged ? (s.film.latest > new Date(s.ai.stamp).getTime() ? "film_to_ai" : "ai_to_film") : aiChanged ? "ai_to_film" : "film_to_ai";
  if (direction === "ai_to_film") await writeFilmFromAi(db, link, s.ai, s.film); else await writeAiFromFilm(db, link, s.ai, s.film);
  s = await stateOf(db, link);
  await db.query("UPDATE project_links SET film_hash = $2, ai_hash = $3, film_stamp = $4, ai_stamp = $5, last_synced_at = now(), last_error = NULL WHERE id = $1", [link.id, s.filmHash, s.aiHash, s.film.stamp, s.ai.stamp]);
  return direction;
}

export async function syncAllLinks(db) {
  const links = (await db.query("SELECT * FROM project_links ORDER BY id")).rows;
  const done = [];
  for (const link of links) {
    try { done.push([link.id, await syncLink(db, link)]); }
    catch (error) { console.error(`Syncing linked projects ${link.film_concept_id} <-> ${link.ai_movie_id} failed:`, error.message); await db.query("UPDATE project_links SET last_error = $2 WHERE id = $1", [link.id, String(error.message).slice(0, 300)]).catch(() => {}); }
  }
  return done;
}

let timer = null;
export function startProjectLinkSync(db, { everyMs = 8000 } = {}) {
  if (timer) return;
  let running = false;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await syncAllLinks(db); } catch (error) { console.error("Project link sync failed:", error.message); } finally { running = false; }
  }, everyMs);
  timer.unref?.();
}
