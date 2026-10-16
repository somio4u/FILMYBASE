// What the voice agent may do to a scene: add lines (as before), and now also CHANGE and REMOVE them.
//   insert            new lines after a line (the old behaviour)
//   replace           change the words (and/or the speaker) of one line, by its number
//   delete            remove one line, by its number
//   remove_character  take a character out of the scene (all of that character's dialogue)
//   rename_character  the same lines, a different speaker
//   rewritten         the whole scene written again (e.g. "make the scene day instead of night")
// Line numbers are the numbers the agent was shown (1 = first line); they always mean the scene as it was BEFORE this change.

const TYPES = ["action", "dialogue", "transition"];
const norm = (s) => String(s ?? "").normalize("NFC").trim().toUpperCase();

export function cleanElement(raw) {
  const text = String(raw?.text ?? "").trim();
  if (!text) return null;
  const isDialogue = raw?.type === "dialogue" && String(raw?.character ?? "").trim() !== "";
  const type = isDialogue ? "dialogue" : TYPES.includes(raw?.type) && raw.type !== "dialogue" ? raw.type : "action";
  return {
    type,
    character: isDialogue ? norm(raw.character) : "",
    characterModifier: isDialogue && raw.characterModifier && raw.characterModifier !== "none" ? String(raw.characterModifier) : "none",
    parenthetical: isDialogue ? String(raw?.parenthetical ?? "").trim() : "",
    text: type === "transition" ? text.toUpperCase() : text,
  };
}

export function cleanEdits(raw) {
  const out = [];
  for (const e of Array.isArray(raw) ? raw.slice(0, 200) : []) {
    const action = e?.action;
    const line = Number(e?.line);
    if (action === "replace" && Number.isInteger(line) && line >= 1) out.push({ action, line, text: String(e.text ?? "").trim(), character: norm(e.character) });
    else if (action === "delete" && Number.isInteger(line) && line >= 1) out.push({ action, line });
    else if (action === "remove_character" && norm(e?.character)) out.push({ action, character: norm(e.character) });
    else if (action === "rename_character" && norm(e?.character) && norm(e?.to)) out.push({ action, character: norm(e.character), to: norm(e.to) });
  }
  return out;
}

// existing: the scene's elements; insert: new elements; insertAfter: how many existing lines come before them
export function applyVoiceEdits(existing, { insert = [], insertAfter = existing.length, edits = [], rewritten = [] } = {}) {
  const counts = { added: 0, changed: 0, removed: 0, rewrote: false };
  const fresh = (insert ?? []).map(cleanElement).filter(Boolean);
  const rewrite = (rewritten ?? []).map(cleanElement).filter(Boolean);
  if (rewrite.length > 0) {
    counts.rewrote = true;
    counts.added = rewrite.length;
    const names = new Set(rewrite.filter((e) => e.type === "dialogue").map((e) => e.character));
    const gone = [...new Set(existing.filter((e) => e.type === "dialogue" && !names.has(norm(e.character))).map((e) => norm(e.character)))];
    return { elements: rewrite, counts, removedCharacters: gone };
  }
  const cleaned = cleanEdits(edits);
  const removedNames = new Set(cleaned.filter((e) => e.action === "remove_character").map((e) => e.character));
  const renames = new Map(cleaned.filter((e) => e.action === "rename_character").map((e) => [e.character, e.to]));
  const deleted = new Set(cleaned.filter((e) => e.action === "delete").map((e) => e.line));
  const replaced = new Map(cleaned.filter((e) => e.action === "replace").map((e) => [e.line, e]));
  const out = [];
  const place = Math.max(0, Math.min(existing.length, Number.isInteger(insertAfter) ? insertAfter : existing.length));
  const pushFresh = () => { out.push(...fresh); counts.added += fresh.length; };
  if (place === 0) pushFresh();
  existing.forEach((el, i) => {
    const n = i + 1;
    let keep = { ...el };
    const speaker = el.type === "dialogue" ? norm(el.character) : "";
    if (deleted.has(n) || (speaker && removedNames.has(speaker))) counts.removed++;
    else {
      const r = replaced.get(n);
      if (r) {
        if (r.text) keep.text = el.type === "transition" ? r.text.toUpperCase() : r.text;
        if (r.character && el.type === "dialogue") keep.character = r.character;
        counts.changed++;
      }
      if (speaker && renames.has(speaker)) { keep.character = renames.get(speaker); if (!r) counts.changed++; }
      out.push(keep);
    }
    if (n === place && place !== 0) pushFresh();
  });
  return { elements: out, counts, removedCharacters: [...removedNames] };
}

export const changeTotal = (c) => c.added + c.changed + c.removed;
