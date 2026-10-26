// The AI spelling/grammar check is shown every line as "[S1.3] ACTION: <text>". The newer Gemini models sometimes write that label back
// INSIDE the corrected text, so a scene ended up with every action line starting "ACTION: ...". These helpers take such a label off —
// from the AI's answer, from text on its way to being saved, and from scenes that were already saved with it.
// Only the exact labels the app itself writes are removed (upper-case ACTION:, DIALOGUE line of NAME:, ACTING NOTE of NAME:, [S1.3], [action]).

const LABEL = /^\s*(?:\[S\d+\.\d+\]\s*)?(?:\[(?:ACTION|action|dialogue|DIALOGUE|transition|TRANSITION)\]\s*|ACTION\s*:\s*|DIALOGUE line of [^:\n]{1,60}:\s*|ACTING NOTE of [^:\n]{1,60}:\s*)/;

export function stripEchoedLabel(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (let i = 0; i < 3 && LABEL.test(out); i++) out = out.replace(LABEL, ""); // "[S1.3] ACTION: ACTION: x" too
  return out === text ? text : out.trimStart();
}

// scene content -> { content, changed } with the labels taken off every text / acting note
export function repairLabelElements(content) {
  let changed = false;
  const elements = (content?.elements ?? []).map((element) => {
    const text = stripEchoedLabel(element?.text);
    const parenthetical = stripEchoedLabel(element?.parenthetical);
    if (text === element?.text && parenthetical === element?.parenthetical) return element;
    changed = true;
    return { ...element, text, ...(element?.parenthetical !== undefined ? { parenthetical } : {}) };
  });
  return { content: changed ? { ...content, elements } : content, changed };
}

// startup: the newest version of every scene that still carries a label gets a corrected new version (the old one stays for ↶ Undo)
export async function repairStoredLabels(db) {
  const rows = (await db.query(
    `SELECT scene_list_id, episode_index, scene_index, content, status FROM (
       SELECT DISTINCT ON (scene_list_id, episode_index, scene_index) scene_list_id, episode_index, scene_index, content, status
       FROM screenplay_scenes ORDER BY scene_list_id, episode_index, scene_index, created_at DESC, id DESC) newest
     WHERE content::text ~ '(ACTION|DIALOGUE line of|ACTING NOTE of|\\[S[0-9]+\\.[0-9]+\\]|\\[(action|dialogue|transition)\\])'`)).rows;
  let fixed = 0;
  for (const r of rows) {
    const out = repairLabelElements(r.content);
    if (!out.changed) continue;
    await db.query("INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content, status) VALUES ($1, $2, $3, $4, $5)",
      [r.scene_list_id, r.episode_index, r.scene_index, JSON.stringify(out.content), r.status]);
    fixed++;
  }
  return fixed;
}
