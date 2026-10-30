import test from "node:test";
import assert from "node:assert/strict";
import { isPhoneticKey, PHONETIC_HELP, transliterate } from "../../frontend/src/odiaPhonetic.js";

const cases = [
  ["pabana", "ପବନ"], // the owner's own example
  ["mandira", "ମନ୍ଦିର"],
  ["aama", "ଆମ"],
  ["asili", "ଅସିଲି"],
  ["guru", "ଗୁରୁ"],
  ["poojaa", "ପୂଜା"],
  ["neela", "ନୀଲ"], // plain l is ଲ; the thick ଳ is a capital L
  ["neeLa", "ନୀଳ"],
  ["shiva", "ଶିବ"],
  ["Tupi", "ଟୁପି"],
  ["kshama", "କ୍ଷମ"],
  ["saMsara", "ସଂସର"],
  ["mu~", "ମୁଁ"],
  ["ghare", "ଘରେ"],
  ["maitrii", "ମୈତ୍ରୀ"],
  ["mora", "ମୋର"],
  ["gaura", "ଗୌର"],
  ["ankita", "ଅଙ୍କିତ"],
  ["angara", "ଅଙ୍ଗର"],
  ["sangha", "ସଙ୍ଘ"],
  ["Pabana", "ପବନ"], // a capital that means nothing special is read as small
  ["gyana", "ଜ୍ଞନ"],
  ["Dhola", "ଢୋଲ"],
  ["raaja", "ରାଜ"],
  ["mitra", "ମିତ୍ର"],
];
for (const [roman, odia] of cases) {
  test(`${roman} -> ${odia}`, () => assert.equal(transliterate(roman), odia));
}

test("a half-typed word always shows something sensible (the screen redraws the word after every key)", () => {
  assert.deepEqual(["p", "pa", "pab", "paba", "pabana"].map(transliterate), ["ପ", "ପ", "ପବ", "ପବ", "ପବନ"]);
  assert.deepEqual(["m", "ma", "man", "mand", "mandi"].map(transliterate), ["ମ", "ମ", "ମନ", "ମନ୍ଦ", "ମନ୍ଦି"]);
});

test("digits, other symbols and an empty word are left alone; | is the Odia full stop", () => {
  assert.equal(transliterate(""), "");
  assert.equal(transliterate("12"), "12");
  assert.equal(transliterate("pa1"), "ପ1");
  assert.equal(transliterate("|"), "।");
});

test("which keys belong to a word, and the help table is complete", () => {
  for (const c of ["a", "Z", "|", "~"]) assert.equal(isPhoneticKey(c), true, c);
  for (const c of [" ", "1", ".", ",", "Enter"]) assert.equal(isPhoneticKey(c), false, c);
  assert.ok(PHONETIC_HELP.length >= 10);
  for (const [, , example] of PHONETIC_HELP) {
    const m = /^(?:.*· )?([A-Za-z~]+) → (\S+)$/.exec(example.split(" · ").at(-1));
    if (m) assert.equal(transliterate(m[1]), m[2], example); // every example in the help panel is really what the rules give
  }
});
