// The words the writer's own scripts already contain, counted — the dictionary behind the phonetic Odia typing (frontend/src/odiaFuzzy.js decides which of them a
// typed word means). Pure functions: texts in, [[word, count], …] out; the route that reads the scripts from the database is in server.js.

// an Odia word = letters, signs and joiners of the Odia block (U+0B01–0B77) plus zero-width joiners inside a word
const WORD = /[ଁ-୷‌‍]+/gu;
const MIN_LETTERS = 2;

export function odiaWordsIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(WORD)) {
    const word = m[0].replace(/^[\u200C\u200D]+|[\u200C\u200D]+$/g, "");
    // a word has at least one real letter; a single character only counts when it is a whole vowel letter (ଏ ଓ ଅ …)
    const hasLetter = /[\u0B05-\u0B39\u0B5C-\u0B61\u0B71]/.test(word);
    if (hasLetter && (word.length >= MIN_LETTERS || /[\u0B05-\u0B14]/.test(word))) out.push(word);
  }
  return out;
}

// texts: any iterable of strings -> the `limit` most used words, [[word, count], …], most used first
export function countOdiaWords(texts, { limit = 20000 } = {}) {
  const counts = new Map();
  for (const text of texts) for (const word of odiaWordsIn(text)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, limit);
}

// every piece of Odia text a scene's saved content holds: its lines (action and dialogue) and the acting notes
export function textsOfScene(content) {
  const out = [];
  for (const e of Array.isArray(content?.elements) ? content.elements : []) {
    if (e?.text) out.push(String(e.text));
    if (e?.parenthetical) out.push(String(e.parenthetical));
  }
  return out;
}

// the texts of a scene list's planned scenes (one-liners and places, in whichever language is Odia)
export function textsOfSceneList(content) {
  const out = [];
  const take = (v) => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") for (const t of Object.values(v)) if (typeof t === "string") out.push(t);
  };
  const scenes = Array.isArray(content?.scenes) ? content.scenes : (content?.episodeScenes ?? []).flatMap((e) => e?.scenes ?? []);
  for (const s of scenes) { take(s.oneLiner); take(s.location); take(s.turn); }
  return out;
}
