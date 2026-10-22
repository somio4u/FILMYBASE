// Lines like "FADE OUT.", "CUT TO:", "FREEZE.", "FREEZE. BREAK-", "THE END" are TRANSITIONS (what the picture does between scenes), never people.
// One place that knows them: the Word import uses it so they are never read as a speaker, the Smart Scheduler / breakdown / AD papers use it so a
// stored mistake never turns into an "artist", and the repair below fixes screenplays that were imported before this existed.

// whole line only: a transition word, then nothing but punctuation / dashes / digits (never other letters, so "FREEZE" inside a name does not match)
export const TRANSITION_LINE = /^(?:FADE (?:IN|OUT)|CUT TO(?: BLACK)?|SMASH CUT TO|DISSOLVE TO|MATCH CUT TO|FREEZE(?:[\s.,:\-–—]+(?:FRAME|BREAK))*|(?:COMMERCIAL |AD |ACT |EPISODE )?BREAK|INTERVAL|THE END|END OF EPISODE)\b[^a-z଀-୿]*$/i;

export const isTransitionName = (name) => TRANSITION_LINE.test(String(name ?? "").replace(/\*+/g, "").trim());

const tidy = (s) => String(s).replace(/\*+/g, "").replace(/\s+/g, " ").trim().toUpperCase();

// one scene's screenplay content -> { content, changed }: a "speaker" that is really a transition becomes a transition line
// (any words that were attached to it stay, as an action line right after), and it leaves the scene's character list
export function repairTransitionElements(content) {
  if (!content || !Array.isArray(content.elements)) return { content, changed: false };
  let changed = false;
  const elements = [];
  for (const e of content.elements) {
    if (e?.type === "dialogue" && isTransitionName(e.character)) {
      changed = true;
      elements.push({ type: "transition", character: "", text: tidy(e.character) });
      const body = typeof e.text === "string" ? e.text.trim() : "";
      if (body) elements.push({ type: "action", character: "", text: body });
    } else {
      elements.push(e);
    }
  }
  let present = content.charactersPresent;
  if (Array.isArray(present) && present.some((n) => isTransitionName(n))) { present = present.filter((n) => !isTransitionName(n)); changed = true; }
  return changed ? { content: { ...content, elements, ...(Array.isArray(present) ? { charactersPresent: present } : {}), editedByUser: true }, changed } : { content, changed };
}

// every scene's NEWEST written version that has such a mistake gets a corrected NEW version (the old stays in history, so Undo works).
// Safe to run again and again: once corrected, nothing matches.
export async function repairStoredTransitions(db) {
  const rows = (await db.query(
    `SELECT scene_list_id, episode_index, scene_index, content, status FROM (
       SELECT DISTINCT ON (scene_list_id, episode_index, scene_index) scene_list_id, episode_index, scene_index, content, status
       FROM screenplay_scenes ORDER BY scene_list_id, episode_index, scene_index, created_at DESC, id DESC) newest
     WHERE content::text ~* '(freeze|break|fade|cut to|the end|interval)'`)).rows;
  let fixed = 0;
  for (const r of rows) {
    const out = repairTransitionElements(r.content);
    if (!out.changed) continue;
    await db.query("INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content, status) VALUES ($1, $2, $3, $4, $5)",
      [r.scene_list_id, r.episode_index, r.scene_index, JSON.stringify(out.content), r.status]);
    fixed++;
  }
  return fixed;
}

// a breakdown (or any list of names) without the transitions the AI may have listed as people
export const withoutTransitions = (names) => (Array.isArray(names) ? names.filter((n) => !isTransitionName(typeof n === "string" ? n : n?.label ?? n?.name)) : names);
