// Odia typing with English letters ("phonetic"): write pabana, press Space and get ପବନ. Pure functions, no screen — so the rules can be tested and, when a word comes out
// wrong, fixed here in one place (the tables below) without touching anything else.
//
// The rules (the way Odia is usually typed in Roman letters):
//   a after a consonant = the consonant alone (the "a" is built in):  pa ba na -> ପବନ
//   aa ା   i ି   ee / ii ୀ   u ୁ   oo / uu ୂ   e େ   o ୋ        (at the start of a word they are the full vowels ଅ ଆ ଇ ଈ ଉ ଊ ଏ ଓ)
//   au ାଉ   ai ାଇ   (the usual Odia spelling: pau ପାଉ, bhai ଭାଇ)    ou ୌ   ei ୈ   (the rare ones)
//   two consonants in a row are joined with a halant:  mandira -> ମନ୍ଦିର
//   y is ଯ at the start of a word and ୟ inside it:  yaa ଯା, maayaa ମାୟା
//   thick sounds are CAPITALS INSIDE a word:  T ଟ  Th ଠ  D ଡ  Dh ଢ  N ଣ  L ଳ  R ଡ଼  Rh ଢ଼   sh ଶ  Sh ଷ  s ସ   M ଂ  H ଃ  ~ ଁ   (KaNa କଣ, BhoLa ଭୋଳ)
//   a word whose ONLY capital is its first letter is just a sentence capital: Mun = mun, Paye = paye
//   at the START of a word the thick sounds are doubled small letters:  tt ଟ  tth ଠ  dd ଡ  ddh ଢ   (ttika ଟିକ, ddara ଡର)
//   ksh -> କ୍ଷ   gy / jn -> ଜ୍ଞ   ng -> ଙ୍ଗ   nk -> ଙ୍କ   (ankita -> ଅଙ୍କିତ)
//   words in the word list (odiaWords.js, and the writer's own) are used exactly as listed, before any rule: mun ମୁଁ, kana କଣ, bhola ଭୋଳ

import { DEFAULT_WORDS } from "./odiaWords.js";

const HALANT = "୍";

// consonant letters, longest spelling first is handled by sorting below
const CONSONANTS = {
  kh: "ଖ", k: "କ", gh: "ଘ", g: "ଗ",
  chh: "ଛ", ch: "ଚ", c: "ଚ", jh: "ଝ", j: "ଜ",
  Th: "ଠ", T: "ଟ", Dh: "ଢ", D: "ଡ", N: "ଣ",
  th: "ଥ", t: "ତ", dh: "ଧ", d: "ଦ", n: "ନ",
  ph: "ଫ", p: "ପ", bh: "ଭ", b: "ବ", m: "ମ",
  Y: "ୟ", r: "ର", l: "ଲ", L: "ଳ", v: "ବ", w: "ୱ",
  shh: "ଷ", Sh: "ଷ", S: "ଷ", sh: "ଶ", s: "ସ", h: "ହ",
  Rh: "ଢ଼", R: "ଡ଼",
  f: "ଫ", z: "ଜ", q: "କ", x: "କ୍ଷ",
};
// whole clusters that are one written letter
const CLUSTERS = { ksh: "କ୍ଷ", kSh: "କ୍ଷ", gy: "ଜ୍ଞ", jn: "ଜ୍ଞ", ngh: "ଙ୍ଘ", ng: "ଙ୍ଗ", nkh: "ଙ୍ଖ", nk: "ଙ୍କ" };

// vowels: [independent letter, sign after a consonant ("" = built in)]
const VOWELS = {
  aa: ["ଆ", "ା"], ai: ["ଆଇ", "ାଇ"], au: ["ଆଉ", "ାଉ"], ei: ["ଐ", "ୈ"], ou: ["ଔ", "ୌ"], ee: ["ଈ", "ୀ"], ii: ["ଈ", "ୀ"], oo: ["ଊ", "ୂ"], uu: ["ଊ", "ୂ"],
  a: ["ଅ", ""], i: ["ଇ", "ି"], u: ["ଉ", "ୁ"], e: ["ଏ", "େ"], o: ["ଓ", "ୋ"],
  A: ["ଆ", "ା"], I: ["ଈ", "ୀ"], U: ["ଊ", "ୂ"],
};
// signs and marks
const MARKS = { M: "ଂ", H: "ଃ", "~": "ଁ", "|": "।" };

const bySize = (table) => Object.keys(table).sort((a, b) => b.length - a.length);
const CLUSTER_KEYS = bySize(CLUSTERS);
const CONSONANT_KEYS = bySize(CONSONANTS);
const VOWEL_KEYS = bySize(VOWELS);

// Capitals that mean nothing special are read as their small letter (Pabana = pabana). The ones in the tables above keep their meaning.
const SPECIAL_CAPITALS = new Set(["T", "D", "N", "L", "R", "S", "M", "H", "Y", "A", "I", "U"]);
function normalise(text) {
  return String(text ?? "").replace(/[A-Z]/g, (c) => (SPECIAL_CAPITALS.has(c) ? c : c.toLowerCase()));
}

const startsWithAt = (text, i, keys) => keys.find((k) => text.startsWith(k, i));

// A word typed with only its first letter capital ("Mun") is an ordinary word with a sentence capital: read it as small letters. Inner capitals keep their meaning.
const isSentenceCapital = (word) => /^[A-Z][a-z]+$/.test(word);

// one word (letters typed since the last space) -> Odia. `words`: the writer's own spellings, which win over the built-in list
export function transliterate(roman, { words = {} } = {}) {
  const typed = String(roman ?? "");
  const plain = typed === typed.toLowerCase() || isSentenceCapital(typed) ? typed.toLowerCase() : null;
  if (plain !== null) {
    const known = words[plain] ?? DEFAULT_WORDS[plain];
    if (known) return known;
  }
  const text = normalise(plain ?? typed);
  let out = "";
  let afterConsonant = false; // the last thing written is a consonant that has no vowel sign yet
  let i = 0;
  while (i < text.length) {
    // the thick ଟ ଠ ଡ ଢ at the START of a word are doubled letters (a word never starts with a double consonant): ttika ଟିକ, ddara ଡର, tthakura ଠାକୁର
    if (i === 0) {
      const thick = ["tth", "ddh", "tt", "dd"].find((k) => text.startsWith(k));
      if (thick) { out += { tth: "ଠ", ddh: "ଢ", tt: "ଟ", dd: "ଡ" }[thick]; afterConsonant = true; i += thick.length; continue; }
    }
    const cluster = startsWithAt(text, i, CLUSTER_KEYS);
    if (cluster) {
      if (afterConsonant) out += HALANT;
      out += CLUSTERS[cluster];
      afterConsonant = true;
      i += cluster.length;
      continue;
    }
    const vowel = startsWithAt(text, i, VOWEL_KEYS);
    if (vowel) {
      const [letter, sign] = VOWELS[vowel];
      out += afterConsonant ? sign : letter;
      afterConsonant = false;
      i += vowel.length;
      continue;
    }
    if (text[i] === "y") {
      // ଯ at the start of a word (yaa ଯା), ୟ inside it (maayaa ମାୟା, paye ପାୟେ)
      if (afterConsonant) out += HALANT;
      out += i === 0 ? "ଯ" : "ୟ";
      afterConsonant = true;
      i += 1;
      continue;
    }
    const consonant = startsWithAt(text, i, CONSONANT_KEYS);
    if (consonant) {
      if (afterConsonant) out += HALANT;
      out += CONSONANTS[consonant];
      afterConsonant = true;
      i += consonant.length;
      continue;
    }
    const ch = text[i];
    if (MARKS[ch]) { out += MARKS[ch]; afterConsonant = false; i += 1; continue; }
    out += ch; // anything else (digits, other symbols) stays as typed
    afterConsonant = false;
    i += 1;
  }
  return out;
}

// letters that start or continue a word in this typing
export const isPhoneticKey = (ch) => /^[A-Za-z|~]$/.test(ch);

// the rules as a table for the help panel on screen: [what you type, what you get, example]
export const PHONETIC_HELP = [
  ["a", "built in", "pa ba na → ପବନ"],
  ["aa", "ା  (ଆ at the start)", "aama → ଆମ"],
  ["au  ai", "ାଉ  ାଇ", "pau → ପାଉ · bhai → ଭାଇ"],
  ["i  ee", "ି  ୀ", "mitra → ମିତ୍ର · neeLa → ନୀଳ"],
  ["u  oo", "ୁ  ୂ", "guru → ଗୁରୁ · poojaa → ପୂଜା"],
  ["e  o", "େ  ୋ", "ghare → ଘରେ · mora → ମୋର"],
  ["ou  ei", "ୌ  ୈ", "goura → ଗୌର · meitrii → ମୈତ୍ରୀ"],
  ["y", "ଯ at the start, ୟ inside", "yaa → ଯା · maayaa → ମାୟା"],
  ["T Th D Dh N L inside a word", "ଟ ଠ ଡ ଢ ଣ ଳ", "kaNa → କଣ · bhoLa → ଭୋଳ"],
  ["tt tth dd ddh at the start", "ଟ ଠ ଡ ଢ", "ttika → ଟିକ · ddara → ଡର"],
  ["sh  Sh  s", "ଶ  ଷ  ସ", "shiva → ଶିବ"],
  ["ksh  gy", "କ୍ଷ  ଜ୍ଞ", "kshama → କ୍ଷମ"],
  ["M  H  ~ inside a word", "ଂ  ଃ  ~ → ଁ", "saMsara → ସଂସର · mu~ → ମୁଁ"],
  ["nd  mb …", "halant is added", "mandira → ମନ୍ଦିର"],
  ["Mun  Paye", "a capital first letter is just a capital", "Mun → ମୁଁ · Paye → ପାୟେ"],
];
