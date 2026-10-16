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

// ---- scene-level actions: add a scene before/after this one, or delete this one ----
const INT_EXT = ["INT", "EXT", "INT/EXT"];

export function cleanSceneActions(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, 6) : [];
  const adds = [];
  let remove = false;
  for (const a of list) {
    if (a?.action === "delete_scene") remove = true;
    else if (a?.action === "add_scene") {
      const location = String(a.location ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      const oneLiner = String(a.oneLiner ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
      if (!location || !oneLiner) continue;
      const minutes = Number(a.minutes);
      adds.push({
        action: "add_scene",
        where: a.where === "before" ? "before" : "after",
        intExt: INT_EXT.includes(String(a.intExt).toUpperCase()) ? String(a.intExt).toUpperCase() : "INT",
        location,
        timeOfDay: String(a.timeOfDay ?? "DAY").trim().toUpperCase().slice(0, 30) || "DAY",
        oneLiner,
        minutes: Number.isFinite(minutes) && minutes >= 0.5 && minutes <= 30 ? minutes : 2,
        write: a.write !== false,
      });
    }
  }
  // deleting the scene and changing it in the same breath makes no sense: a deletion stands alone (the writer confirms it)
  return remove ? [{ action: "delete_scene" }] : adds.slice(0, 3);
}

// ---- the screenplay's language rules, checked in code (a Hindi-speaking writer must still get an Odia scene) ----
// headings, transitions and CHARACTER names: English capitals. action lines: the action language. dialogue and parentheticals: the
// dialogue language. Whatever language the writer SPEAKS in never changes this.
const INDIC = {
  // every Indic block that is NOT the scene's own script
  or: /[ऀ-૿஀-෿]/,
  hi: /[ঀ-෿]/,
  en: /[ऀ-෿]/,
};
const forbiddenFor = (language) => INDIC[language] ?? INDIC.en;

export const SCRIPT_NAMES = { or: "Odia (ଓଡ଼ିଆ script — never Devanagari / Hindi script)", hi: "Hindi (Devanagari script — never Odia script)", en: "English (Latin letters)" };

// every element the agent produced (new lines, replacements, whole-scene rewrites) must be in the right script
export function wrongScriptLines({ elements = [], rewritten = [], edits = [] }, dialogueLanguage = "or", actionLanguage = dialogueLanguage) {
  const bad = [];
  const check = (what, text, language) => { if (text && forbiddenFor(language).test(String(text))) bad.push({ what, text: String(text).slice(0, 80), language }); };
  const checkElement = (e, label) => {
    if (e?.type === "dialogue") { check(`${label} speaker`, e.character, "en"); check(`${label} dialogue`, e.text, dialogueLanguage); check(`${label} acting note`, e.parenthetical, dialogueLanguage); }
    else if (e?.type === "transition") check(`${label} transition`, e.text, "en");
    else check(`${label} action`, e?.text, actionLanguage);
  };
  elements.forEach((e) => checkElement(e, "new line"));
  rewritten.forEach((e) => checkElement(e, "rewritten line"));
  for (const e of edits) {
    check("changed line", e?.text, dialogueLanguage === actionLanguage ? dialogueLanguage : dialogueLanguage);
    check("speaker", e?.character, "en");
    check("new speaker name", e?.to, "en");
  }
  return bad;
}
