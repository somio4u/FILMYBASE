import test from "node:test";
import assert from "node:assert/strict";
import { isPhoneticKey, PHONETIC_HELP, transliterate } from "../../frontend/src/odiaPhonetic.js";
import { DEFAULT_WORDS, parseWordLines, wordLines } from "../../frontend/src/odiaWords.js";

// THE OWNER'S OWN WORDS (typed with a capital first letter, as he types them, and in small letters): the app once got every one of them wrong
const owners = [["Mun", "ମୁଁ"], ["Paye", "ପାୟେ"], ["Bhola", "ଭୋଳ"], ["Kana", "କଣ"], ["Pau", "ପାଉ"], ["Pabana", "ପବନ"]];
for (const [typed, odia] of owners) {
  test(`owner's word: ${typed} -> ${odia}`, () => { assert.equal(transliterate(typed), odia); assert.equal(transliterate(typed.toLowerCase()), odia); });
}
// ...and the ones among them that the RULES alone can get right do not depend on the word list
test("rules alone (no word list): Pau and Pabana come out right, au is the usual ାଉ", () => {
  assert.equal(transliterate("Pau", { words: {} }), "ପାଉ");
  assert.equal(transliterate("pabana"), "ପବନ");
});

const cases = [
  ["mandira", "ମନ୍ଦିର"],
  ["aama", "ଆମ"],
  ["asili", "ଅସିଲି"],
  ["guru", "ଗୁରୁ"],
  ["poojaa", "ପୂଜା"],
  ["neela", "ନୀଲ"], // a plain l is ଲ; the thick ଳ is a capital L inside the word
  ["neeLa", "ନୀଳ"],
  ["shiva", "ଶିବ"],
  ["kshama", "କ୍ଷମ"],
  ["saMsara", "ସଂସର"],
  ["mu~", "ମୁଁ"],
  ["ghare", "ଘରେ"],
  ["meitrii", "ମୈତ୍ରୀ"],
  ["mora", "ମୋର"],
  ["goura", "ଗୌର"],
  ["bhai", "ଭାଇ"],
  ["khai", "ଖାଇ"],
  ["jau", "ଜାଉ"], // j is ଜ (ya at the start is y)
  ["ankita", "ଅଙ୍କିତ"],
  ["angara", "ଅଙ୍ଗର"],
  ["sangha", "ସଙ୍ଘ"],
  ["gyana", "ଜ୍ଞନ"],
  ["raaja", "ରାଜ"],
  ["mitra", "ମିତ୍ର"],
  ["yaa", "ଯା"], // y at the start of a word is ଯ
  ["maayaa", "ମାୟା"], // y inside a word is ୟ
  ["dhanya", "ଧନ୍ୟ"],
  ["KaNa", "କଣ"], // thick sounds are capitals INSIDE a word
  ["BhoLa", "ଭୋଳ"],
  ["ttika", "ଟିକ"], // at the start of a word they are doubled small letters
  ["ddara", "ଡର"],
  ["tthaakura", "ଠାକୁର"],
  ["ddhola", "ଢୋଲ"],
  ["Tupi", "ତୁପି"], // a capital first letter alone is only a sentence capital
  ["ttupi", "ଟୁପି"],
];
for (const [roman, odia] of cases) {
  test(`${roman} -> ${odia}`, () => assert.equal(transliterate(roman), odia));
}

test("a sentence capital never turns into a special sign (the old bug: Mun came out as ଂଉନ)", () => {
  for (const w of ["Mun", "Hari", "Madhu", "Tara", "Dina", "Nana", "Sita", "Raja", "Lata", "Yaa"]) {
    assert.ok(!/[ଂଃ]/.test(transliterate(w)), `${w} -> ${transliterate(w)}`);
  }
  assert.equal(transliterate("Hari"), "ହରି");
  assert.equal(transliterate("Madhu"), "ମଧୁ");
});

test("the writer's own words win over the built-in list and over the rules; matching ignores a capital first letter but not inner capitals", () => {
  assert.equal(transliterate("kana", { words: { kana: "କନା" } }), "କନା");
  assert.equal(transliterate("Kana", { words: { kana: "କନା" } }), "କନା");
  assert.equal(transliterate("rama", { words: { rama: "ରାମ" } }), "ରାମ");
  assert.equal(transliterate("rama"), "ରମ"); // not in any list: the rules
  assert.equal(transliterate("KaNa", { words: { kana: "କନା" } }), "କଣ"); // inner capitals mean "use the rules"
  assert.ok(DEFAULT_WORDS.mun && DEFAULT_WORDS.kana);
});

test("a half-typed word always shows something sensible", () => {
  assert.deepEqual(["p", "pa", "pab", "paba", "pabana"].map((w) => transliterate(w)), ["ପ", "ପ", "ପବ", "ପବ", "ପବନ"]);
  assert.deepEqual(["m", "ma", "man", "mand", "mandi"].map((w) => transliterate(w)), ["ମ", "ମ", "ମନ", "ମନ୍ଦ", "ମନ୍ଦି"]);
});

test("digits, other symbols and an empty word are left alone; | is the Odia full stop", () => {
  assert.equal(transliterate(""), "");
  assert.equal(transliterate("12"), "12");
  assert.equal(transliterate("pa1"), "ପ1");
  assert.equal(transliterate("|"), "।");
});

test("word lines: 'mun = ମୁଁ' pairs are read, anything else is left out", () => {
  const words = parseWordLines("mun = ମୁଁ\nKana → କଣ\nbad line\nhello = world\n  tu:ତୁ \n= ଏକ\nse - ସେ");
  assert.deepEqual(words, { mun: "ମୁଁ", kana: "କଣ", tu: "ତୁ", se: "ସେ" });
  assert.deepEqual(parseWordLines(wordLines(words)), words); // what is shown can be read back
});

test("which keys belong to a word, and every example in the help table is really what the rules give", () => {
  for (const c of ["a", "Z", "|", "~"]) assert.equal(isPhoneticKey(c), true, c);
  for (const c of [" ", "1", ".", ",", "Enter"]) assert.equal(isPhoneticKey(c), false, c);
  assert.ok(PHONETIC_HELP.length >= 12);
  let checked = 0;
  for (const [, , example] of PHONETIC_HELP) {
    for (const piece of example.split(" · ")) {
      const m = /^([A-Za-z~]+) → (\S+)$/.exec(piece);
      if (m) { assert.equal(transliterate(m[1]), m[2], piece); checked += 1; }
    }
  }
  assert.ok(checked >= 18, `only ${checked} examples were checked`);
});
