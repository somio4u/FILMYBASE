// AI MOVIE → adding, removing and moving the scenes of one beat by hand (the Movie screenplay has these tools; AI Movie did not).
// Pure functions on a beat's `scenes` list, so they are tested without a database or the AI; the routes in server.js only load, call and save.
//   - a NEW scene starts blank (a heading and, if the person wrote what happens, that as its first line) — writing it is a separate step ("Rewrite" / "Write dialogue"),
//     so adding a scene costs no AI money and cannot fail because of the AI
//   - a removed scene is kept (last 20) so "Undo" can put it back exactly where it was

const INT_EXT = ["INT", "EXT", "INT/EXT"];
const MAX_REMOVED_KEPT = 20;
const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function sceneHeadingText({ intExt, location, timeOfDay }) {
  const place = clean(location, 80).toUpperCase();
  if (!place) return "";
  const ie = INT_EXT.includes(String(intExt ?? "").toUpperCase()) ? String(intExt).toUpperCase() : "INT";
  const time = clean(timeOfDay, 20).toUpperCase() || "DAY";
  return `${ie}. ${place} - ${time}`;
}

// { heading?, intExt, location, timeOfDay, what, minutes } -> a scene in the shape the screenplay reader understands
export function newBlankScene(input = {}) {
  const heading = clean(input.heading, 160) || sceneHeadingText(input);
  if (!heading) throw Object.assign(new Error("Give the new scene a place (for example “TEMPLE”) or a full heading."), { status: 400 });
  const what = clean(input.what, 400);
  const minutes = Number(input.minutes);
  return {
    sceneHeading: { en: heading, hi: heading },
    content: [{ type: "action", text: { en: what, hi: what } }],
    estimatedMinutes: Number.isFinite(minutes) && minutes > 0 && minutes <= 30 ? Math.round(minutes * 10) / 10 : 1,
    addedByUser: true,
  };
}

const failWith = (status, message) => Object.assign(new Error(message), { status });
const checkScenes = (scenes) => { if (!Array.isArray(scenes)) throw failWith(400, "This beat has no written scenes yet."); };

// afterIndex: -1 = at the start of the beat, otherwise after that scene
export function insertScene(scenes, afterIndex, scene) {
  checkScenes(scenes);
  const at = Number(afterIndex);
  if (!Number.isInteger(at) || at < -1 || at >= scenes.length) throw failWith(400, "Not a valid place for the new scene.");
  const next = scenes.slice();
  next.splice(at + 1, 0, scene);
  return { scenes: next, index: at + 1 };
}

export function removeSceneAt(scenes, sceneIndex) {
  checkScenes(scenes);
  const at = Number(sceneIndex);
  if (!Number.isInteger(at) || at < 0 || at >= scenes.length) throw failWith(400, "Not a valid scene.");
  if (scenes.length === 1) throw failWith(400, "A beat needs at least one scene. Add another scene first, or write this one again instead.");
  const next = scenes.slice();
  const [removed] = next.splice(at, 1);
  return { scenes: next, removed, index: at };
}

export function moveSceneBy(scenes, sceneIndex, direction) {
  checkScenes(scenes);
  const at = Number(sceneIndex);
  if (!Number.isInteger(at) || at < 0 || at >= scenes.length) throw failWith(400, "Not a valid scene.");
  const to = direction === "up" ? at - 1 : direction === "down" ? at + 1 : NaN;
  if (!Number.isInteger(to)) throw failWith(400, "Move the scene up or down.");
  if (to < 0 || to >= scenes.length) throw failWith(400, direction === "up" ? "This is already the first scene of the beat." : "This is already the last scene of the beat.");
  const next = scenes.slice();
  [next[at], next[to]] = [next[to], next[at]];
  return { scenes: next, index: to };
}

// the list of removed scenes (newest last) kept for Undo
export const keepRemoved = (list, entry) => [...(Array.isArray(list) ? list : []), entry].slice(-MAX_REMOVED_KEPT);

// Undo: put the newest removed scene back where it was (as near as the beat allows). Returns null when there is nothing to put back.
export function restoreRemoved(list, screenplayBeats) {
  const kept = Array.isArray(list) ? list.slice() : [];
  while (kept.length > 0) {
    const entry = kept.pop();
    const beat = screenplayBeats?.[entry.beatIndex];
    if (!beat || !Array.isArray(beat.scenes)) continue; // its beat is gone: try the one before
    const at = Math.max(0, Math.min(entry.sceneIndex, beat.scenes.length));
    const scenes = beat.scenes.slice();
    scenes.splice(at, 0, entry.scene);
    const beats = screenplayBeats.slice();
    beats[entry.beatIndex] = { ...beat, scenes };
    return { beats, kept, beatIndex: entry.beatIndex, sceneIndex: at };
  }
  return null;
}
