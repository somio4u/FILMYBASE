// Exact spellings of common Odia words, typed the way they sound: the word typed in English letters (small letters; a capital first letter is ignored)
// -> the Odia word. English letters cannot tell ନ from ଣ, ଲ from ଳ or ଅ from ଆ, so these words are looked up FIRST and the rules in odiaPhonetic.js are
// used for every other word. The writer can add his own words (the ⌨ panel, "My words"); his words win over this list.
// To fix or add a word for everybody, change this table — nothing else.
export const DEFAULT_WORDS = {
  // the owner's own examples
  mun: "ମୁଁ", paye: "ପାୟେ", bhola: "ଭୋଳ", kana: "କଣ", pau: "ପାଉ", pabana: "ପବନ",
  // people and pronouns
  tu: "ତୁ", tume: "ତୁମେ", se: "ସେ", ame: "ଆମେ", apana: "ଆପଣ", kie: "କିଏ", maa: "ମା", bapa: "ବାପା", bhai: "ଭାଇ",
  // small everyday words
  nahin: "ନାହିଁ", han: "ହଁ", ebe: "ଏବେ", aji: "ଆଜି", kali: "କାଲି", bhala: "ଭଲ", ghara: "ଘର", mandira: "ମନ୍ଦିର", paani: "ପାଣି",
  // common verbs (the plain form)
  jaa: "ଯା", asa: "ଆସ", dekha: "ଦେଖ", kaha: "କହ",
};

// "mun = ମୁଁ" lines (one word per line; =, → or : between) -> { mun: "ମୁଁ" }; lines that are not a word and its Odia spelling are left out
export function parseWordLines(text) {
  const words = {};
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*([A-Za-z]+)\s*(?:=|→|:|->|-)\s*(\S+)\s*$/.exec(line);
    if (m && /[଀-୿]/.test(m[2])) words[m[1].toLowerCase()] = m[2];
  }
  return words;
}

export const wordLines = (words) => Object.entries(words).map(([roman, odia]) => `${roman} = ${odia}`).join("\n");
