// Reading a pasted story before using it: the story is kept, what came from the PDF (headers, page numbers, broken lines) is removed.
import test from "node:test";
import assert from "node:assert/strict";
import { cleanPastedStory, learnBoilerplate, repairVisualOrder, damageSignals, summarize } from "../pasteClean.js";

const HEADER = (n) => `DETAILED EPISODE SYNOPSIS / 1999-2026 ${n} MAHA KALI / SEASON 01`;
const P = (n) => `Soumya walks to the temple on day ${n} and meets the old priest who warns him about the red door`;

// a PDF copy: the same header lands in the MIDDLE of sentences, page numbers sit on their own lines, a running label repeats, lines are cut
const NOISY = [
  "Episode 1: Agni Danda",
  `${P(1)}, but he does not listen ${HEADER(4)} and goes inside.`,
  "4",
  `The priest follows ${HEADER(5)} him slowly down the long dark corridor of the temple and the door`,
  "closes behind them.",
  "E P I S O D E 0 1 / 0 8",
  "5",
  "",
  "Episode 2: Dhuli Danda",
  `${P(2)} ${HEADER(6)} again.`,
  "6",
  `E P I S O D E 0 2 / 0 8 ${P(3)} ${HEADER(7)} and waits.`,
  "7",
].join("\n");

test("repeated page headers (even in the middle of a sentence), page numbers and running labels are removed; the story stays", () => {
  const { text, report } = cleanPastedStory(NOISY);
  assert.ok(!/DETAILED EPISODE SYNOPSIS|MAHA KALI|SEASON 01/.test(text), "the page header is gone everywhere");
  assert.ok(!/E P I S O D E|EPISODE0|EPISODE 0/.test(text.replace(/Episode \d: /g, "")), "the running 'EPISODE 01 / 08' label is gone");
  assert.ok(!/^\d+$/m.test(text), "no line is only a page number");
  assert.match(text, /^Episode 1: Agni Danda\n/); assert.match(text, /\nEpisode 2: Dhuli Danda\n/, "the real episode headings stay");
  assert.match(text, /but he does not listen and goes inside\./, "the sentence is whole again");
  assert.match(text, /The priest follows him slowly down the long dark corridor of the temple and the door closes behind them\./, "a line cut in two by the PDF is joined");
  assert.ok(report.headers.length >= 1 && report.pageNumbers >= 3 && report.joinedLines >= 1);
  assert.match(report.summary, /^Adu cleaned your paste: removed \d+ repeated page header/);
});

test("a text that is already clean is left alone, and a repeated phrase of the story itself is NOT removed", () => {
  const clean = "Episode 1: A\nThe hero opens the door. The hero opens the door. The hero opens the door.\n\nEpisode 2: B\nINT. TEMPLE - DAY\nINT. TEMPLE - DAY\nINT. TEMPLE - DAY";
  const out = cleanPastedStory(clean);
  assert.equal(out.report.changed, false); assert.equal(out.report.summary, "Your paste needed no cleaning.");
  assert.match(out.text, /INT\. TEMPLE - DAY\nINT\. TEMPLE - DAY\nINT\. TEMPLE - DAY/, "short separate lines (a list of scenes) stay separate");
});

test("vowel signs copied in visual order are put back after their letters (Odia and Hindi); correct text is untouched", () => {
  const r1 = repairVisualOrder("େସୗମ୍ୟ ଏକ େଦବୀ ଅଟେ");   // e-sign in front of the letters
  assert.equal(r1.text.includes("ସେ"), true); assert.ok(r1.fixed >= 2);
  assert.ok(!/(^|\s)େ/u.test(r1.text), "no word starts with a vowel sign any more");
  const fine = "ସୌମ୍ୟ ଏକ ଦେବୀ ଅଟେ";
  assert.equal(repairVisualOrder(fine).fixed, 0); assert.equal(repairVisualOrder(fine).text, fine);
  assert.equal(repairVisualOrder("िहंदी की किताब").text.startsWith("हिं"), true, "Hindi short-i sign moved behind its letter");
  assert.equal(repairVisualOrder("किताब").fixed, 0);
});

test("a damaged paste is recognised so Adu can ask for the PDF; a good one is not flagged", () => {
  const odia = "ସୌମ୍ୟ ଏକ ଯୁବ ଡାକ୍ତର ଯିଏ ଗାଁକୁ ଫେରେ ".repeat(8);
  assert.equal(damageSignals(odia).damaged, false);
  const bad = odia + " °û*³ò 8³ë!´Ò ±«H ²KM³ ".repeat(6) + "◌◌◌◌";
  assert.equal(damageSignals(bad).damaged, true);
  assert.equal(damageSignals("plain English text with no Indic letters at all °°°").damaged, false);
});

test("learnBoilerplate needs a repeat: one stray all-caps phrase is kept", () => {
  assert.deepEqual(learnBoilerplate("The hero meets DETAILED EPISODE SYNOPSIS 1 once."), []);
  assert.equal(summarize({ headers: [], pageNumbers: 0, joinedLines: 0, repairedLetters: 0 }), "Your paste needed no cleaning.");
});

test("rejoin:false and boilerplate:false leave a screenplay's lines alone", () => {
  const script = ["EPISODE 1/3", "SOUMYA", "Where is the idol that was here this morning", "BALARAM", "Gone", "EPISODE 2/3", "SOUMYA", "Stop him", "EPISODE 3/3", "SOUMYA", "Help"].join("\n");
  const kept = cleanPastedStory(script, { rejoin: false, boilerplate: false }).text;
  assert.equal(kept.split("\n").length, 11);
});
