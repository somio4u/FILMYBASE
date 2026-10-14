// The PDF fonts: Odia and Hindi text must be drawn with fonts that have their letters (not random symbols).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import PDFDocument from "pdfkit";
import { PDFParse } from "pdf-parse";
import { segmentByScript, scriptOf, registerScriptFonts, writeScripted } from "../scriptPdf.js";

const DIR = path.join(import.meta.dirname, "..", "fonts");
const FONTS = { odiaRegular: path.join(DIR, "NotoSansOriya.ttf"), odiaBold: path.join(DIR, "NotoSansOriya-Bold.ttf"), hindiRegular: path.join(DIR, "NotoSansDevanagari-Regular.ttf"), hindiBold: path.join(DIR, "NotoSansDevanagari-Bold.ttf") };

function render(draw) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A4", margin: 56, bufferPages: true });
    registerScriptFonts(doc, FONTS);
    const chunks = [];
    doc.on("data", (c) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks)));
    draw(doc); doc.end();
  });
}

test("scripts are told apart, and punctuation and spaces stay with the words around them", () => {
  assert.equal(scriptOf("ସ"), "odia"); assert.equal(scriptOf("स"), "hindi"); assert.equal(scriptOf("a"), "latin");
  assert.deepEqual(segmentByScript("Soumya meets ଗାଁ ମୁଖିଆ today.").map((r) => r.script), ["latin", "odia", "latin"]);
  assert.deepEqual(segmentByScript("hello, world").map((r) => r.script), ["latin"]);
  assert.equal(segmentByScript("").length, 0);
});

test("Odia, Hindi and English text in one PDF: the right fonts are embedded and the letters come back out as written", async () => {
  const OD = "ସୌମ୍ୟ ଏକ ଯୁବ ଡାକ୍ତର, ଯିଏ ଗାଁକୁ ଫେରେ।";
  const HI = "सौम्या को एक पुराना कैसेट मिलता है।";
  const pdf = await render((doc) => {
    writeScripted(doc, "Title — ମହାକାଳୀ", { size: 20, weight: "bold", align: "center" });
    writeScripted(doc, [{ text: "Cliffhanger: ", weight: "bold" }, { text: OD, weight: "italic" }], { size: 11 });
    writeScripted(doc, HI, { size: 11 });
    writeScripted(doc, "line one\nline two", { size: 11 });
  });
  const raw = pdf.toString("latin1");
  assert.match(raw, /NotoSansOriya/); assert.match(raw, /NotoSansDevanagari/), assert.match(raw, /Times/);
  const text = (await new PDFParse({ data: pdf }).getText()).text;
  assert.ok(text.includes("Hindi") || text.includes(HI.slice(0, 6)) || /सौम्या/.test(text), "the Hindi letters are in the text layer");
  assert.match(text, /line one/); assert.match(text, /line two/);
  assert.ok(!/[°³´²±]/.test(text.replace(/\s/g, "")), "no random Latin-1 symbols (the old failure)");
});

test("long text breaks into lines and pages without losing words", async () => {
  const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  const pdf = await render((doc) => writeScripted(doc, long, { size: 11 }));
  const text = (await new PDFParse({ data: pdf }).getText()).text;
  for (const w of ["word0", "word199", "word399"]) assert.ok(text.includes(w), w);
});
