import test from "node:test";
import assert from "node:assert/strict";
import { readStoryFromPdf } from "../pdfReader.js";

const PDF = Buffer.from("%PDF-1.4\n" + "x".repeat(300));

// A scripted model: no real AI. It answers the "look" call and each page-batch call.
function scripted({ pageCount = 20, batches }) {
  const calls = [];
  const ask = async (label, contents, schema) => {
    calls.push({ label, contents });
    assert.ok(Array.isArray(contents), "contents must be parts");
    assert.equal(contents[0].inlineData.mimeType, "application/pdf");
    if (/^Looking/.test(label)) return { title: "Mahakali", pageCount, language: "Odia", episodes: [{ label: "Episode 1", page: 1 }, { label: "Episode 2", page: 9 }], notStory: ["page numbers", "running title MAHAKALI SCRIPT"] };
    return { text: batches.shift(), unreadable: [] };
  };
  return { ask, calls };
}

test("reads a PDF in page batches, leaves out the not-story things and stitches the text", async () => {
  const { ask, calls } = scripted({ pageCount: 20, batches: [
    "Episode 1\nSoumya enters the temple at dawn and sees the old priest waiting for him with a lamp.",
    "Episode 2\nBalaram plans to take the temple land before the festival begins and tells nobody.",
    "Episode 3\nMalati finds the letter hidden under the goddess's feet and understands everything now.",
  ] });
  const progress = [];
  const out = await readStoryFromPdf(PDF, { ask, onProgress: (p) => progress.push(p) });
  assert.equal(calls.length, 4); // 1 look + 3 batches of 8,8,4 pages
  assert.match(calls[1].label, /1-8 of 20/);
  assert.match(calls[3].label, /17-20 of 20/);
  assert.match(calls[1].contents[1].text, /page numbers; running title MAHAKALI SCRIPT/);
  assert.equal(out.title, "Mahakali");
  assert.deepEqual(out.episodes, ["Episode 1", "Episode 2"]);
  assert.match(out.text, /Soumya enters[\s\S]*Balaram plans[\s\S]*Malati finds/);
  assert.match(out.summary, /Read 20 pages \(Odia\)/);
  assert.ok(progress.some((p) => /Reading pages 9–16 of 20/.test(p)));
});

test("refuses a non-PDF, an empty file and a too-big file with plain messages", async () => {
  const ask = async () => { throw new Error("must not call the model"); };
  await assert.rejects(readStoryFromPdf(Buffer.from("hello world"), { ask }), /does not look like a PDF/);
  await assert.rejects(readStoryFromPdf(Buffer.alloc(0), { ask }), /empty/);
  await assert.rejects(readStoryFromPdf(Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(19 * 1024 * 1024)]), { ask }), /too big/);
});

test("says so when nothing readable comes back", async () => {
  const { ask } = scripted({ pageCount: 3, batches: [""] });
  await assert.rejects(readStoryFromPdf(PDF, { ask }), /could not read any story text/);
});

test("a repeated running header the model let through is removed by the paste cleaner", async () => {
  const header = "MAHAKALI SCRIPT PAGE";
  const body = (n) => `${header} ${n}\nSoumya walks into the temple courtyard number ${n} and looks around slowly.`;
  const { ask } = scripted({ pageCount: 24, batches: [body(1) + "\n" + body(2), body(3) + "\n" + body(4), body(5) + "\n" + body(6)] });
  const out = await readStoryFromPdf(PDF, { ask });
  assert.doesNotMatch(out.text, /MAHAKALI SCRIPT PAGE/);
  assert.match(out.text, /courtyard number 6/);
});

test("screenplay kind: asks for the screenplay layout and keeps repeated character names, scene headings and short lines as they are", async () => {
  const script = [
    "1. INT. TEMPLE - NIGHT", "Soumya lights the lamp.", "SOUMYA", "Where is the idol?", "BALARAM", "Gone.",
    "2. INT. TEMPLE - DAY", "Soumya runs in.", "SOUMYA", "Stop him!", "BALARAM", "Too late.",
    "3. EXT. VILLAGE - DAY", "SOUMYA", "Help!", "BALARAM", "No.",
  ].join("\n");
  const { ask, calls } = scripted({ pageCount: 8, batches: [script] });
  const out = await readStoryFromPdf(PDF, { ask, kind: "screenplay" });
  assert.match(calls[1].contents[1].text, /This is a SCREENPLAY/);
  assert.equal(out.text, script); // nothing removed or re-flowed
});

// a scene TABLE (the "Two Sisters" plan): copied in bites of 4 pages, every row, none skipped, and the reader says when scenes are missing
const rows = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `SCENE ${from + i}\nINT. BISWAS HOUSE - DAY\nBiswa babu is in the house and something happens in scene ${from + i}.`).join("\n");

test("a scene table: pages are read 4 at a time, with the table rule; an empty answer is asked again once", async () => {
  const calls = [];
  const answers = ["", rows(1, 30), rows(31, 67)]; // the first bite comes back empty
  const ask = async (label, contents) => {
    calls.push({ label, text: contents[1].text });
    if (/^Looking/.test(label)) return { title: "TWO SISTERS", pageCount: 13, language: "English", sceneCount: 67, episodes: [], notStory: ["column titles"] };
    return { text: answers.shift(), unreadable: [] };
  };
  // pages 1-4 (empty, retried -> scenes 1-30), 5-8 (31-67)... the script above gives the retry the 30 scenes
  answers.splice(0, answers.length, "", rows(1, 30), rows(31, 49), rows(50, 62), rows(63, 67));
  const out = await readStoryFromPdf(PDF, { ask, kind: "screenplay" });
  assert.match(calls[1].label, /1-4 of 13/);
  assert.match(calls[1].text, /TABLE of scenes[^]*SCENE <the SL NO>/);
  assert.match(calls[2].label, /1-4 of 13/); // the empty answer was asked again
  assert.match(calls[2].text, /too short/);
  assert.equal(out.scenesFound, 67);
  assert.equal(out.warnings.length, 0);
});

test("when far fewer scenes were read than the PDF has, a plain warning says so", async () => {
  const ask = async (label) => (/^Looking/.test(label) ? { title: "T", pageCount: 4, language: "English", sceneCount: 67, episodes: [], notStory: [] } : { text: rows(50, 67), unreadable: [] });
  const out = await readStoryFromPdf(PDF, { ask, kind: "screenplay" });
  assert.match(out.warnings.join(" "), /about 67 scenes, but only 18 were read/);
});
