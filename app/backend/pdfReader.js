// READING A STORY FROM A PDF. Copy-pasting from a PDF often garbles Odia/Hindi
// (broken vowel signs, boxes), so instead the PDF itself is shown to the AI,
// which reads the PAGES like a person would. Two steps:
//   1. a look at the whole PDF: title, page count, episode headings, what is NOT story,
//   2. the story text is copied page-batch by page-batch, skipping page numbers,
//      running headers/footers, watermarks and the like.
// The batches are then stitched and passed through the same paste cleaner.
// Every function takes the model as `ask` so it can be tested with a scripted model.
import { OBJ, LIST, S } from "./storyBrain.js";
import { cleanPastedStory, damageSignals } from "./pasteClean.js";

export const PAGES_PER_BATCH = 8;
export const SCREENPLAY_PAGES_PER_BATCH = 4; // a screenplay or scene table is copied in smaller bites, so nothing is skipped
export const MAX_PDF_BYTES = 18 * 1024 * 1024; // Gemini accepts about 20 MB per request, base64 included

const READER_SYSTEM = `You are a careful script reader. You are shown a PDF of someone's own story, synopsis or screenplay. You READ THE PAGES (what is printed), never guess from a text layer. The language may be Odia, Hindi, English or a mix; write every word in the same script it is printed in. Never translate, summarise, correct or improve the story. Never invent anything.`;

const LOOK_SCHEMA = OBJ({
  title: S("The story's title as printed, or an empty string if none."),
  pageCount: { type: "INTEGER", description: "Total number of pages in the PDF." },
  language: S("Main language of the story: Odia, Hindi, English or Mixed."),
  sceneCount: { type: "INTEGER", description: "If the PDF is a screenplay or a TABLE / LIST of scenes: the total number of scenes (the highest scene or serial number printed). 0 if it is not made of scenes." },
  episodes: LIST(OBJ({ label: S("Heading as printed, e.g. 'Episode 3'"), page: { type: "INTEGER", description: "Page it starts on." } }), "Every episode/part heading in order. Empty list if the story is not split into episodes."),
  notStory: LIST(S("One kind of thing in the PDF that is NOT part of the story, e.g. 'page numbers', 'running title at the top of every page', 'watermark', 'cover page', 'table of contents'."), "What will be left out."),
});

const PAGES_SCHEMA = OBJ({
  text: S("The story text of these pages exactly as printed, paragraph breaks kept. Episode headings kept on their own line."),
  unreadable: LIST(S("Page number plus what could not be read."), "Anything on these pages too blurred or damaged to read. Empty if all fine."),
});

// A scene plan is often a TABLE (SL NO | INT/EXT | DAY/NIGHT | LOCATION | DESCRIPTION). Each row is copied as one scene in the layout the app reads.
const TABLE_RULE = ` If the pages are a TABLE of scenes (columns like SL NO, INT/EXT, DAY/NIGHT, LOCATION, DESCRIPTION), copy EVERY row, none skipped, each as three lines: "SCENE <the SL NO>", then "INT. <LOCATION> - <DAY/NIGHT>" (EXT. for Ext), then the DESCRIPTION word for word. Ignore the column titles and any title row at the top of the table.`;

// how many scenes the text has: "SCENE n" lines, or else scene headings (INT./EXT.)
export function countScenes(text) {
  const marked = (String(text).match(/^\s*SCENE\s+\d+/gim) || []).length;
  return marked || (String(text).match(/^\s*(?:INT|EXT)\b/gim) || []).length;
}

// kind "screenplay": the pages are a screenplay, so scene headings, character names, dialogue and
// action lines are copied exactly as laid out, one per line, and the text is not re-flowed.
export async function readStoryFromPdf(pdfBuffer, { ask, onProgress = () => {}, perBatch, kind = "story" } = {}) {
  const isScreenplay = kind === "screenplay";
  perBatch ??= isScreenplay ? SCREENPLAY_PAGES_PER_BATCH : PAGES_PER_BATCH;
  if (!pdfBuffer?.length) throw Object.assign(new Error("The PDF is empty."), { status: 400 });
  if (pdfBuffer.length > MAX_PDF_BYTES) throw Object.assign(new Error("This PDF is too big to read in one go (limit about 18 MB). Split it into two PDFs, or save it at a smaller size, and upload again."), { status: 400 });
  if (pdfBuffer.subarray(0, 5).toString("latin1") !== "%PDF-") throw Object.assign(new Error("This does not look like a PDF file."), { status: 400 });

  const pdfPart = { inlineData: { mimeType: "application/pdf", data: pdfBuffer.toString("base64") } };

  onProgress("Looking through the PDF");
  const look = await ask(
    "Looking through the PDF",
    [pdfPart, { text: "Look through the WHOLE PDF. Report its title, page count, language, every episode/part heading with the page it starts on, and the kinds of things printed in it that are NOT story (page numbers, running titles, watermarks, cover, contents page). Do not copy the story yet." }],
    LOOK_SCHEMA,
    READER_SYSTEM,
  );
  const pages = Math.max(1, Number(look.pageCount) || 1);
  const batches = [];
  for (let from = 1; from <= pages; from += perBatch) batches.push([from, Math.min(pages, from + perBatch - 1)]);

  const skip = (look.notStory ?? []).join("; ") || "page numbers, running headers and footers, watermarks";
  const chunks = [];
  const unreadable = [];
  for (let i = 0; i < batches.length; i++) {
    const [from, to] = batches[i];
    onProgress(`Reading pages ${from}–${to} of ${pages}`);
    const readBatch = (extra = "") => ask(
      `Reading pages ${from}-${to} of ${pages}`,
      [pdfPart, { text: `Copy out the STORY TEXT printed on pages ${from} to ${to} of this PDF, in reading order, word for word, in the script it is printed in. Keep paragraph breaks. Keep each episode heading ("Episode 3" etc.) on its own line. LEAVE OUT everything that is not story: ${skip}. A sentence that continues onto the next page is copied as one sentence. Do not copy anything from pages outside ${from}-${to}. Do not summarise, translate or fix the writing.${isScreenplay ? " This is a SCREENPLAY: keep every scene heading (INT./EXT. …), every action line, every character name and every line of dialogue and parenthetical on its own line exactly as laid out, and keep scene numbers." + TABLE_RULE : ""}${i > 0 ? " If page " + from + " begins in the middle of a sentence from the previous page, still copy it from its first printed word." : ""}${extra}` }],
      PAGES_SCHEMA,
      READER_SYSTEM,
    );
    let result = await readBatch();
    // a screenplay page holds at least a few lines: an almost empty answer means the model skipped the pages, so ask once more
    const thin = (r) => isScreenplay && String(r.text ?? "").trim().length < 150 * (to - from + 1);
    if (thin(result)) {
      onProgress(`Reading pages ${from}–${to} of ${pages} again`);
      const second = await readBatch(` Your last answer was too short: pages ${from} to ${to} are full of scenes. Copy ALL of them, from the first row on page ${from} to the last row on page ${to}.`);
      if (String(second.text ?? "").length > String(result.text ?? "").length) result = second;
    }
    chunks.push(String(result.text ?? "").trim());
    for (const note of result.unreadable ?? []) unreadable.push(note);
  }

  // headers/footers the model let through are caught by the usual paste cleaner
  const cleaned = cleanPastedStory(chunks.filter(Boolean).join(isScreenplay ? "\n" : "\n\n"), isScreenplay ? { rejoin: false, boilerplate: false } : {});
  const text = cleaned.text.trim();
  if (text.length < 50) throw Object.assign(new Error("I could not read any story text from this PDF. If it is a photo or scan, try a clearer copy."), { status: 422 });

  const episodes = (look.episodes ?? []).map((e) => e.label).filter(Boolean);
  const warnings = [...unreadable];
  const expected = Number(look.sceneCount) || 0;
  const found = countScenes(text);
  if (isScreenplay && expected >= 5 && found < expected * 0.9) warnings.push(`The PDF seems to have about ${expected} scenes, but only ${found} were read. Some pages may have been skipped — check the list, or upload the PDF again.`);
  if (damageSignals(text).damaged) warnings.push("Some letters in the result still look broken. Please read it once before using it.");
  const summary = `Read ${pages} page${pages === 1 ? "" : "s"}${look.language ? ` (${look.language})` : ""}${episodes.length ? `, found ${episodes.length} episode heading${episodes.length === 1 ? "" : "s"}` : ""}. Left out: ${skip}.`;
  return { text, title: look.title || "", language: look.language || "", pages, scenesFound: found, scenesExpected: expected, episodes, summary, warnings, cleanup: cleaned.report };
}
