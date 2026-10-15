// "Write full description from screenplay": for the shots of a scene the AI re-reads the screenplay and writes, per shot, the COMPLETE
// frame — who is in it (how many, which characters), what each one is doing, where, the place, the objects, the camera. The names it
// reports are matched to the project's made characters / environments / props and those are linked to the shot, so the picture is
// built from the pictures that already exist. The original shot text is never touched (the shot division approval stays); the full
// description is saved beside it and is what the picture command uses.
import { phrasesOf, contains, normalizeForMatch } from "./screenplayAnalysis.js";
import { plainText } from "./propGroups.js";

const httpError = (message, status = 400, code = "bad_request") => Object.assign(new Error(message), { status, code });
const clean = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

export async function ensureFrameDescriptionSchema(db) {
  await db.query("ALTER TABLE production_shots ADD COLUMN IF NOT EXISTS frame_description TEXT NOT NULL DEFAULT ''");
  await db.query("ALTER TABLE production_shots ADD COLUMN IF NOT EXISTS frame_people INTEGER");
}

export function frameDescriptionPrompt({ heading, elements, shots, assets }) {
  const script = elements.map((e) => (e.kind === "dialogue" ? `${e.speaker}${e.parenthetical ? ` ${e.parenthetical}` : ""}: ${e.text}` : `[${e.kind}] ${e.text}`)).join("\n");
  const list = (kind) => assets.filter((a) => a.kind === kind).map((a) => `- ${a.name}${a.about ? ` (${a.about})` : ""}`).join("\n") || "(none)";
  const shotLines = shots.map((s) => `${s.code} | ${[s.framing, s.cameraAngle, s.cameraMove].filter(Boolean).join(", ") || "framing not set"} | ${Number(s.durationSec) || 4}s | ${s.description}`).join("\n");
  return `You are a film director's assistant. Below is ONE scene of a screenplay, the shots it was cut into, and the made characters, places and objects of the film. For EACH shot write the complete picture of its first frame, so that an image can be made from your words alone.

SCENE: ${heading}
SCREENPLAY OF THE SCENE:
${script || "(no lines)"}

SHOTS (code | framing, angle, move | length | what the cutter wrote):
${shotLines}

MADE CHARACTERS:
${list("character")}
MADE ENVIRONMENTS:
${list("location")}
MADE PROPS:
${list("prop")}

For every shot give:
- description: ONE complete paragraph (2-4 sentences) that says WHERE the camera is and what it sees; HOW MANY people are in the frame, who each one is (use the made character names exactly) and exactly what each one is doing and where (e.g. seated in the front, at the wheel, looking out); the place and what part of it is visible; the important objects and where they are; the movement or action at this moment (e.g. a jeep travelling along the middle of a lonely road towards the palace); light and time of day. Use ONLY what the screenplay and the shot say or clearly imply — do not invent events, new named characters or new places. If the shot or the scene implies people (a jeep arriving carries its passengers), put the scene's characters in it and say how many.
- characters: the made character names who are in this frame (exact spelling from the list; [] if nobody).
- environment: the made environment's name (exact), or "".
- props: the made prop names visible in this frame (exact spelling).
- people: the number of people in the frame, a whole number (0 if none).
Return JSON: {"shots":[{"code":"SH001","description":"…","characters":["…"],"environment":"…","props":["…"],"people":4}]} with one entry for every shot code above.`;
}

// the project's item whose name or alias a reported name points at
function matchItem(name, items) {
  const n = normalizeForMatch(name);
  if (!n) return null;
  return items.find((a) => phrasesOf(a).some((ph) => ph === n)) ?? items.find((a) => phrasesOf(a).some((ph) => contains(n, ph) || contains(ph, n))) ?? null;
}

export async function writeFrameDescriptions(db, projectId, { sceneId = null, shotId = null, overwrite = true, textJson, listShots }) {
  if (!textJson) throw httpError("The text AI is not available right now.", 503, "no_text_ai");
  let scene = sceneId;
  if (!scene && shotId) scene = (await db.query("SELECT scene_id FROM production_shots WHERE id = $1 AND project_id = $2", [shotId, projectId])).rows[0]?.scene_id;
  if (!scene) throw httpError("Choose a scene or a shot.", 400, "no_target");
  const sceneRow = (await db.query("SELECT id, heading FROM production_scenes WHERE id = $1 AND project_id = $2", [scene, projectId])).rows[0];
  if (!sceneRow) throw httpError("Scene not found.", 404, "not_found");
  const allShots = await listShots(db, projectId, { sceneId: scene });
  if (allShots.length === 0) throw httpError("This scene has no shots yet.", 400, "no_shots");
  const targets = allShots.filter((s) => (shotId ? s.id === shotId : overwrite || !s.frameDescription));
  if (targets.length === 0) return { written: 0, linked: 0, unknown: [], skipped: allShots.length };
  const elements = (await db.query("SELECT kind, speaker, parenthetical, text_en, text_hi FROM production_scene_elements WHERE scene_id = $1 ORDER BY order_index", [scene])).rows
    .map((e) => ({ kind: e.kind, speaker: e.speaker, parenthetical: e.parenthetical, text: e.text_en || e.text_hi || "" })).filter((e) => e.text);
  const rows = (await db.query("SELECT id, kind, code, name, aliases, agent_details, human_edits, grouped_into FROM production_assets WHERE project_id = $1 AND kind IN ('character','location','prop')", [projectId])).rows;
  const assets = rows.map((a) => {
    const d = { ...(a.agent_details ?? {}), ...(a.human_edits ?? {}) };
    return { id: a.id, kind: a.kind, code: a.code, name: a.name, aliases: a.aliases ?? [], grouped: a.grouped_into, about: plainText(d.description ?? d.notes ?? "").slice(0, 160) };
  });
  const raw = await textJson(frameDescriptionPrompt({ heading: sceneRow.heading, elements, shots: targets, assets: assets.filter((a) => !a.grouped) }));
  const byCode = new Map((Array.isArray(raw?.shots) ? raw.shots : []).filter((s) => typeof s?.code === "string").map((s) => [s.code.toUpperCase(), s]));
  let written = 0, linked = 0;
  const unknown = [];
  for (const shot of targets) {
    const got = byCode.get(shot.code.toUpperCase());
    const description = clean(got?.description, 2000);
    if (!description) continue;
    const ids = new Set();
    const note = (names, kind) => {
      for (const name of Array.isArray(names) ? names : names ? [names] : []) {
        const hit = matchItem(String(name), assets.filter((a) => a.kind === kind));
        if (hit) ids.add(hit.id); else if (String(name).trim()) unknown.push(`${shot.code}: ${name}`);
      }
    };
    note(got.characters, "character"); note(got.environment, "location"); note(got.props, "prop");
    const people = Number.isInteger(got.people) && got.people >= 0 && got.people < 100 ? got.people : null;
    await db.query("UPDATE production_shots SET frame_description = $1, frame_people = $2, updated_at = now() WHERE id = $3", [description, people, shot.id]);
    if (ids.size > 0) {
      // the AI read the whole scene: its list replaces what the guesses had linked
      await db.query("DELETE FROM production_shot_assets WHERE shot_id = $1", [shot.id]);
      for (const id of ids) await db.query("INSERT INTO production_shot_assets (shot_id, asset_id) VALUES ($1,$2)", [shot.id, id]);
      linked++;
    }
    written++;
  }
  return { written, linked, unknown, skipped: targets.length - written };
}

export async function setFrameDescription(db, projectId, shotId, text) {
  const value = clean(text, 2000);
  const done = await db.query("UPDATE production_shots SET frame_description = $1, updated_at = now() WHERE id = $2 AND project_id = $3", [value, shotId, projectId]);
  if (done.rowCount === 0) throw httpError("Shot not found.", 404, "not_found");
  return { saved: true, text: value };
}
