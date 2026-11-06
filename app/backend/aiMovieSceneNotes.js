// AI Movie → colour tags and a short note on a scene, for the director's own use: red "change", yellow "check", blue "new", green "done".
// The tag is stored INSIDE the scene (scene.tag), so it moves with the scene when scenes are added, removed or moved, and it is carried by every
// save that keeps the scene's other fields. Setting or clearing a tag is a mark only — it never changes the written scene, so it is not part of Undo/Redo.

export const SCENE_TAGS = ["change", "check", "new", "done"];

export function tagOfScene(scene) {
  const t = scene?.tag;
  return t && SCENE_TAGS.includes(t.tag) ? { tag: t.tag, note: String(t.note ?? ""), by: t.by ?? null, at: t.at ?? null } : null;
}

// wanted: null clears; otherwise { tag, note }. Returns a NEW scene object.
export function withSceneTag(scene, wanted, { by = null, now = new Date() } = {}) {
  const next = { ...scene };
  if (wanted === null || wanted === undefined || wanted.tag === null) { delete next.tag; return next; }
  if (!SCENE_TAGS.includes(wanted.tag)) throw Object.assign(new Error("The tag must be change, check, new or done."), { status: 400 });
  const note = String(wanted.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  next.tag = { tag: wanted.tag, note, by, at: now.toISOString() };
  return next;
}
