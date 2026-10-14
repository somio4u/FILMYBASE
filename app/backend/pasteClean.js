// Reading a pasted story BEFORE using it. Text copied out of a PDF carries things that are not the story: the same page header on every
// page (often in the middle of a sentence), page numbers, running labels like "EPISODE 03 / 08", words cut into lines, and vowel signs
// copied in "visual order" (stuck in front of the letter instead of after it). This keeps the story and removes the rest, and reports
// exactly what it did, so nothing is thrown away silently.

const HEADING_LINE = /^[ \t]*[#*_>\-\s]*(?:episode|ep\.?|sequence|part|एपिसोड|एपिसोड्|एपीसोड|भाग|ଏପିସୋଡ୍|ଏପିସୋଡ|ଭାଗ)\s*[-–—:.#]*\s*[0-9०-९୦-୯]{1,3}(?![0-9०-९୦-୯])/imu;
const clip = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// 1. invisible junk
function normalizeChars(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n\n")              // a page break
    .replace(/ /g, " ")
    .replace(/[​﻿­]/g, "") // zero-width space, byte-order mark, soft hyphen (NOT the joiners: Indic scripts need those)
    .replace(/[ \t]+\n/g, "\n");
}

// 2. Odia / Hindi vowel signs copied in visual order. A vowel sign can never start a word, so one that does belongs AFTER the letters that follow it.
const ODIA_CONS = "\\u0B15-\\u0B39\\u0B5C\\u0B5D\\u0B5F";
const ODIA_CLUSTER = `[${ODIA_CONS}](?:\\u0B4D[${ODIA_CONS}])*`;
const DEVA_CONS = "\\u0915-\\u0939\\u0958-\\u095F";
const DEVA_CLUSTER = `[${DEVA_CONS}](?:\\u094D[${DEVA_CONS}])*`;
export function repairVisualOrder(text) {
  let fixed = 0;
  let out = String(text);
  const START = "(^|[^\\u0B00-\\u0B7F\\u0900-\\u097F]|[\\u0B66-\\u0B6F])"; // start, or anything that is not an Odia/Hindi letter
  // Odia: e-sign (େ) / ai-sign (ୈ) before the letters; o-sign was copied as e + letters + aa
  out = out.replace(new RegExp(`${START}\\u0B47(${ODIA_CLUSTER})\\u0B3E`, "gu"), (_, a, c) => { fixed += 1; return `${a}${c}\u0B4B`; });
  out = out.replace(new RegExp(`${START}\\u0B47(${ODIA_CLUSTER})`, "gu"), (_, a, c) => { fixed += 1; return `${a}${c}\u0B47`; });
  out = out.replace(new RegExp(`${START}\\u0B48(${ODIA_CLUSTER})`, "gu"), (_, a, c) => { fixed += 1; return `${a}${c}\u0B48`; });
  // Hindi: short-i sign (ि) before the letters
  out = out.replace(new RegExp(`${START}\\u093F(${DEVA_CLUSTER})`, "gu"), (_, a, c) => { fixed += 1; return `${a}${c}\u093F`; });
  return { text: out, fixed };
}

// 3. things repeated all through the text that are not the story
const HEADERISH = /^[A-Z#\/\-–—&.,:()]+$/;
const hasWord = (t) => /[A-Z]{2,}/.test(t);
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toRegex = (tokens) => new RegExp(tokens.map((t) => rx(t).replace(/#/g, "\\d+")).join("\\s*"), "g");

// letter-spaced labels like "E P I S O D E 0 3 / 0 8" become one word first, so they can be recognised
function collapseLetterSpaced(text) {
  return text.replace(/(?<![A-Za-z0-9])(?:[A-Z0-9\/][ \t]){5,}[A-Z0-9\/](?![A-Za-z0-9])/g, (m) => m.replace(/[ \t]+/g, ""));
}

export function learnBoilerplate(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const norm = words.map((w) => w.replace(/\d+/g, "#"));
  const runs = [];
  for (let i = 0; i < words.length;) {
    if (!HEADERISH.test(norm[i])) { i += 1; continue; }
    let j = i;
    while (j < words.length && HEADERISH.test(norm[j])) j += 1;
    runs.push({ raw: words.slice(i, j), norm: norm.slice(i, j) });
    i = j;
  }
  // every stretch of 3+ words inside those runs, counted
  const seen = new Map();
  for (const run of runs) {
    for (let a = 0; a < run.norm.length; a += 1) {
      for (let b = a + 3; b <= run.norm.length && b - a <= 18; b += 1) {
        const key = run.norm.slice(a, b).join(" ");
        const e = seen.get(key) ?? { count: 0, raws: new Set(), tokens: run.norm.slice(a, b) };
        e.count += 1; e.raws.add(run.raw.slice(a, b).join(" "));
        seen.set(key, e);
      }
    }
  }
  const patterns = [];
  const candidates = [...seen.values()]
    .filter((e) => e.count >= 3 && /[A-Z]{2,}/.test(e.tokens[0]) && hasWord(e.tokens.join(" ")) && (e.raws.size >= 2 || e.tokens.some((t) => t.includes("#"))))
    .sort((x, y) => y.tokens.length - x.tokens.length || y.count - x.count);
  let rest = text;
  for (const c of candidates) {
    const re = toRegex(c.tokens);
    const hits = rest.match(re)?.length ?? 0;
    if (hits >= 3) { patterns.push({ regex: re, kind: "header", sample: [...c.raws][0] }); rest = rest.replace(re, " "); }
  }
  // a short running label such as "EPISODE#/#" on its own
  for (const t of new Set(norm)) {
    if (/^[A-Z]{3,}#?\/?#$/.test(t) || /^[A-Z]{3,}#\/#$/.test(t)) {
      const hits = norm.filter((n) => n === t).length;
      if (hits >= 2) patterns.push({ regex: toRegex([t]), kind: "label", sample: words[norm.indexOf(t)] });
    }
  }
  return patterns;
}

// 4. lines that are only a page number
const PAGE_NUMBER_LINE = /^\s*(?:[-–—]\s*)?(?:page\s+)?[0-9०-९୦-୯]{1,4}(?:\s*(?:\/|of)\s*[0-9०-९୦-୯]{1,4})?\s*(?:[-–—])?\s*$/iu;

// 5. a paragraph that was cut into lines by the PDF becomes one paragraph again; headings and blank lines stay
function rejoinLines(text) {
  const lines = text.split("\n");
  // a PDF cuts a paragraph into lines of about the same (long) length; a list of items has short, uneven lines and must stay a list
  const lengths = lines.map((l) => l.trim().length).filter((n) => n > 0).sort((a, b) => a - b);
  const wrapWidth = lengths.length ? lengths[Math.floor(lengths.length * 0.9)] : 0;
  const out = [];
  let joined = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t === "") { if (out.at(-1) !== "") out.push(""); continue; }
    const prev = out.at(-1);
    const prevCutMidSentence = prev !== undefined && prev !== "" && !HEADING_LINE.test(prev) && prev.length >= wrapWidth * 0.6 && wrapWidth >= 40 && !/[.!?।॥"”’:;)]\s*$/u.test(prev);
    if (HEADING_LINE.test(t) || !prevCutMidSentence) { out.push(t); continue; }
    out[out.length - 1] = `${prev} ${t}`; joined += 1;
  }
  return { text: out.join("\n").replace(/[ \t]{2,}/g, " ").trim(), joined };
}

// Cleans a pasted story. `patterns` can be passed to reuse what was learned from a bigger text (e.g. all episodes together).
export function cleanPastedStory(input, { patterns = null } = {}) {
  const original = String(input ?? "");
  let text = normalizeChars(original);
  const report = { headers: [], pageNumbers: 0, joinedLines: 0, repairedLetters: 0, removedCharacters: 0 };
  text = collapseLetterSpaced(text);
  const learned = patterns ?? learnBoilerplate(text);
  for (const p of learned) {
    p.regex.lastIndex = 0;
    const hits = text.match(p.regex)?.length ?? 0;
    if (hits > 0) { report.headers.push({ text: clip(p.sample), times: hits }); text = text.replace(p.regex, " "); }
  }
  const lines = text.split("\n");
  const kept = lines.filter((l) => { const drop = PAGE_NUMBER_LINE.test(l) && !HEADING_LINE.test(l); if (drop) report.pageNumbers += 1; return !drop; });
  text = kept.join("\n");
  const repaired = repairVisualOrder(text);
  text = repaired.text; report.repairedLetters = repaired.fixed;
  const joined = rejoinLines(text);
  text = joined.text; report.joinedLines = joined.joined;
  report.removedCharacters = Math.max(0, original.length - text.length);
  report.changed = report.headers.length > 0 || report.pageNumbers > 0 || report.repairedLetters > 0 || report.joinedLines > 0;
  report.summary = summarize(report);
  return { text, report, patterns: learned };
}

export function summarize(r) {
  const parts = [];
  const headerTimes = r.headers.reduce((a, h) => a + h.times, 0);
  if (headerTimes) parts.push(`removed ${headerTimes} repeated page header${headerTimes === 1 ? "" : "s"} (such as “${r.headers[0].text}”)`);
  if (r.pageNumbers) parts.push(`removed ${r.pageNumbers} page number${r.pageNumbers === 1 ? "" : "s"}`);
  if (r.repairedLetters) parts.push(`fixed ${r.repairedLetters} misplaced vowel sign${r.repairedLetters === 1 ? "" : "s"}`);
  if (r.joinedLines) parts.push(`joined ${r.joinedLines} broken line${r.joinedLines === 1 ? "" : "s"}`);
  return parts.length ? `Adu cleaned your paste: ${parts.join("; ")}.` : "Your paste needed no cleaning.";
}

// Does this paste look damaged by the PDF it came from? (stray signs, boxes, Latin-1 symbols among Odia/Hindi letters, many repairs)
// When it does, Adu asks the user to upload the PDF itself so he can read it from the page.
export function damageSignals(text) {
  const t = String(text ?? "");
  const odiaHindi = (t.match(/[଀-୿ऀ-ॿ]/g) ?? []).length;
  const boxes = (t.match(/[◌�]/g) ?? []).length;                       // dotted circles, replacement characters
  const strayLatin1 = odiaHindi > 50 ? (t.match(/[°-ÿ]/g) ?? []).length : 0; // ° ³ ´ ² ± among Indic letters = wrong font encoding
  const strayMarks = (t.match(/(?:^|\s)[ା-୍ा-्]/gmu) ?? []).length; // a vowel sign at the start of a word
  const score = boxes * 3 + strayLatin1 + strayMarks;
  return { boxes, strayLatin1, strayMarks, score, damaged: odiaHindi > 50 && (boxes > 3 || strayLatin1 > 10 || strayMarks > 15) };
}
