// Which Odia word did the writer MEAN? English letters cannot tell ନ from ଣ, ଲ from ଳ, ସ from ଶ ଷ, ଜ from ଯ, a long vowel from a short one, a thin ତ ଦ from a
// thick ଟ ଡ, or when an "aa" sign is there — but the real Odia words can: only one spelling of "kana" is a word people write. So the words the writer's own
// scripts already contain (counted: odiaCorpus.js on the server) are the dictionary. Both the typed word and every dictionary word are boiled down to a
// "skeleton" in which those look-alike letters are one letter; the dictionary word with the same skeleton (the most used one first) is the answer.
// The rules (odiaPhonetic.js) are the fallback for a word nobody wrote yet, and a few look-alike spellings of it are offered as choices.
import { DEFAULT_WORDS } from "./odiaWords.js";
import { transliterate } from "./odiaPhonetic.js";

// look-alike letters -> the one letter they stand for in the skeleton
const FOLD = {
  "ଣ": "ନ", "ଙ": "ନ", "ଞ": "ନ", "ଁ": "ନ", "ଂ": "ନ", // all the n sounds (and the nasal marks: mun ମୁଁ ~ mun ମୁନ)
  "ଳ": "ଲ", "ଶ": "ସ", "ଷ": "ସ", "ଯ": "ଜ",          // l, s, j (ଯ is read like ଜ)
  "ଟ": "ତ", "ଠ": "ଥ", "ଡ": "ଦ", "ଢ": "ଧ", "ଡ଼": "ଦ", "ଢ଼": "ଧ", // thick and thin (T / t)
  "ଆ": "ଅ", "ଈ": "ଇ", "ଊ": "ଉ", "ଐ": "ଏ", "ଔ": "ଓ", // long vowels
  "ୀ": "ି", "ୂ": "ୁ", "ୈ": "େ", "ୌ": "ୋ",
};
// dropped completely: the aa sign (a short "a" is typed for it as often as not), the nukta dot, zero-width joiners
const DROP = new Set(["ା", "଼", "‌", "‍"]);

export function skeleton(word) {
  let out = "";
  for (const ch of String(word ?? "")) {
    if (DROP.has(ch)) continue;
    out += FOLD[ch] ?? ch;
  }
  return out;
}

// entries: [[word, count], …] (any order) -> Map(skeleton -> [{ word, count }] the most used first)
export function buildIndex(entries) {
  const index = new Map();
  for (const [word, count] of entries) {
    const key = skeleton(word);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ word, count: Number(count) || 1 });
  }
  for (const list of index.values()) list.sort((a, b) => b.count - a.count || a.word.length - b.word.length);
  return index;
}

// a few look-alike spellings of a word that is in no list, most likely first (shown as choices; the writer picks, and the app remembers the pick)
const SWAPS = [["ନ", "ଣ"], ["ଲ", "ଳ"], ["ସ", "ଶ"], ["ସ", "ଷ"], ["ଜ", "ଯ"], ["ତ", "ଟ"], ["ଦ", "ଡ"], ["ି", "ୀ"], ["ୁ", "ୂ"]];
export function lookAlikes(odia) {
  const out = [];
  const chars = [...String(odia)];
  for (const [from, to] of SWAPS) {
    chars.forEach((ch, i) => { if (ch === from) out.push([...chars.slice(0, i), to, ...chars.slice(i + 1)].join("")); });
  }
  if (chars.at(-1) === "ନ" && chars.length > 1) out.push([...chars.slice(0, -1), "ଁ"].join("")); // mun ମୁନ -> ମୁଁ
  return out;
}

// The choices for a typed word, best first: the writer's own words, the built-in list, the words of his scripts with the same skeleton (most used first),
// then what the rules give, then a few look-alikes. `index` from buildIndex; `words` the writer's own spellings.
export function candidatesFor(roman, { words = {}, index = new Map(), limit = 5 } = {}) {
  const typed = String(roman ?? "");
  const plain = typed === typed.toLowerCase() || /^[A-Z][a-z]+$/.test(typed) ? typed.toLowerCase() : null;
  const list = [];
  const add = (w) => { if (w && !list.includes(w)) list.push(w); };
  if (plain !== null) { add(words[plain]); add(DEFAULT_WORDS[plain]); }
  const byRules = transliterate(typed, { rulesOnly: true });
  for (const hit of index.get(skeleton(byRules)) ?? []) add(hit.word);
  add(byRules);
  for (const w of lookAlikes(byRules)) add(w);
  return list.slice(0, limit);
}
