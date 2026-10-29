import test from "node:test";
import assert from "node:assert/strict";
import ScriptAwarePDF, { splitScriptRuns, needsSplit, fontScript } from "../mixedScriptPdf.js";

test("a line is cut by script: Odia, Hindi, and the neutral characters stay with the piece before them", () => {
  const runs = splitScriptRuns("କଳା ରୂପା / Blackened coin / काली चांदी (ପ୍ରପର୍ଟି)");
  assert.deepEqual(runs.map((r) => r.script), ["or", "hi", "or"]);
  assert.equal(runs.map((r) => r.text).join(""), "କଳା ରୂପା / Blackened coin / काली चांदी (ପ୍ରପର୍ଟି)"); // nothing lost or reordered
  assert.deepEqual(splitScriptRuns("Plain English 123").map((r) => r.script), [null]);
  assert.equal(splitScriptRuns("ଆସ। काली").length, 2); // the danda "।" never starts a new piece
});

test("only a line with a script the current font cannot draw is cut", () => {
  assert.equal(needsSplit("Plain English, ₹500 (x)", "latin"), false);
  assert.equal(needsSplit("ଓଡ଼ିଆ / English", "or"), false);
  assert.equal(needsSplit("ଓଡ଼ିଆ / English / हिन्दी", "or"), true);
  assert.equal(needsSplit("ଓଡ଼ିଆ", "hi"), true);
  assert.equal(needsSplit("ଓଡ଼ିଆ", "latin"), true);
  assert.equal(fontScript("NotoSansOriya-Bold"), "or");
  assert.equal(fontScript("NotoSansDevanagari-Regular"), "hi");
  assert.equal(fontScript("Helvetica-Bold"), "latin");
});

test("a PDF line with Odia, English and Hindi uses both Noto fonts, and plain text works as before", async () => {
  const doc = new ScriptAwarePDF({ size: "A4", margin: 50 });
  doc.registerFont("odiaBold", new URL("../fonts/NotoSansOriya-Bold.ttf", import.meta.url).pathname);
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", resolve));
  doc.font("odiaBold").fontSize(13).text("କଳା ରୂପା କଏନ୍ / Blackened silver coin / काली चांदी का सिक्का (ପ୍ରପର୍ଟି)");
  doc.font("odiaBold").text("ଓଡ଼ିଆ / हिन्दी", { align: "center" });
  doc.font("Helvetica").text("Plain English line.");
  doc.text("ଏକ / एक", 60, 300);
  doc.end();
  await done;
  const pdf = Buffer.concat(chunks).toString("latin1");
  assert.match(pdf, /NotoSansOriya/);
  assert.match(pdf, /NotoSansDevanagari/);
  assert.equal(doc._font.name, "Helvetica"); // the caller's font is put back after a mixed line
});
