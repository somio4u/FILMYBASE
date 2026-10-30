// Odia typing with English letters ("phonetic"): write pabana and get ପବନ. Pure functions, no screen — so the rules can be tested and, when a word comes out
// wrong, fixed here in one place (the tables below) without touching anything else.
//
// The rules (ITRANS-like, the way Odia is usually typed in Roman letters):
//   a after a consonant = the consonant alone (the "a" is built in):  pa ba na -> ପବନ
//   aa ା   i ି   ee / ii ୀ   u ୁ   oo / uu ୂ   e େ   ai ୈ   o ୋ   au ୌ         (at the start of a word they are the full vowels ଅ ଆ ଇ ଈ ଉ ଊ ଏ ଐ ଓ ଔ)
//   two consonants in a row are joined with a halant:  mandira -> ମନ୍ଦିର
//   thick sounds are CAPITALS:  T ଟ  Th ଠ  D ଡ  Dh ଢ  N ଣ  L ଳ  R ଡ଼  Rh ଢ଼   sh ଶ  Sh ଷ  s ସ   M ଂ  H ଃ  ~ ଁ
//   ksh -> କ୍ଷ   gy / jn -> ଜ୍ଞ   ng -> ଙ୍ଗ   nk -> ଙ୍କ   (ankita -> ଅଙ୍କିତ)

const HALANT = "୍";

// consonant letters, longest spelling first is handled by sorting below
const CONSONANTS = {
  kh: "ଖ", k: "କ", gh: "ଘ", g: "ଗ",
  chh: "ଛ", ch: "ଚ", c: "ଚ", jh: "ଝ", j: "ଜ",
  Th: "ଠ", T: "ଟ", Dh: "ଢ", D: "ଡ", N: "ଣ",
  th: "ଥ", t: "ତ", dh: "ଧ", d: "ଦ", n: "ନ",
  ph: "ଫ", p: "ପ", bh: "ଭ", b: "ବ", m: "ମ",
  y: "ଯ", Y: "ୟ", r: "ର", l: "ଲ", L: "ଳ", v: "ବ", w: "ୱ",
  shh: "ଷ", Sh: "ଷ", S: "ଷ", sh: "ଶ", s: "ସ", h: "ହ",
  Rh: "ଢ଼", R: "ଡ଼",
  f: "ଫ", z: "ଜ", q: "କ", x: "କ୍ଷ",
};
// whole clusters that are one written letter
const CLUSTERS = { ksh: "କ୍ଷ", kSh: "କ୍ଷ", gy: "ଜ୍ଞ", jn: "ଜ୍ଞ", ngh: "ଙ୍ଘ", ng: "ଙ୍ଗ", nkh: "ଙ୍ଖ", nk: "ଙ୍କ" };

// vowels: [independent letter, sign after a consonant ("" = built in)]
const VOWELS = {
  aa: ["ଆ", "ା"], ai: ["ଐ", "ୈ"], au: ["ଔ", "ୌ"], ee: ["ଈ", "ୀ"], ii: ["ଈ", "ୀ"], oo: ["ଊ", "ୂ"], uu: ["ଊ", "ୂ"],
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

// one word (letters typed since the last space) -> Odia
export function transliterate(roman) {
  const text = normalise(roman);
  let out = "";
  let afterConsonant = false; // the last thing written is a consonant that has no vowel sign yet
  let i = 0;
  while (i < text.length) {
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
  ["i  ee", "ି  ୀ", "mitra → ମିତ୍ର · neeLa → ନୀଳ"],
  ["u  oo", "ୁ  ୂ", "guru → ଗୁରୁ · poojaa → ପୂଜା"],
  ["e  ai", "େ  ୈ", "ghare → ଘରେ · maitrii → ମୈତ୍ରୀ"],
  ["o  au", "ୋ  ୌ", "mora → ମୋର · gaura → ଗୌର"],
  ["T Th D Dh N L", "ଟ ଠ ଡ ଢ ଣ ଳ", "Tupi → ଟୁପି · kaaLa → କାଳ"],
  ["sh  Sh  s", "ଶ  ଷ  ସ", "shiva → ଶିବ"],
  ["ksh  gy", "କ୍ଷ  ଜ୍ଞ", "kshama → କ୍ଷମ"],
  ["M  H  ~", "ଂ  ଃ  ଁ", "saMsara → ସଂସର · mu~ → ମୁଁ"],
  ["nd  mb …", "halant is added", "mandira → ମନ୍ଦିର"],
];
