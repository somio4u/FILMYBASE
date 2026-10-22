// Turns an AD document spec (see adSheets.js) into an Excel file or a PDF. Both show exactly the same rows.
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "fonts");
const HINDI = /[ऀ-ॿ]/;
const ODIA = /[଀-୿]/;
const fontFor = (text, bold) => (ODIA.test(text) ? (bold ? "odiaBold" : "odiaRegular") : HINDI.test(text) ? (bold ? "hindiBold" : "hindiRegular") : bold ? "Helvetica-Bold" : "Helvetica");
const cellText = (v) => (v === null || v === undefined ? "" : String(v));

export const fileBase = (title, doc) => `${String(title || "project").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "project"}-${doc.title.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "")}`;

export async function renderXlsx(spec) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Filmybase";
  const ws = wb.addWorksheet(spec.title.slice(0, 31), { pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const cols = Math.max(...spec.sections.map((s) => s.columns.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(8, ...spec.sections.map((s) => s.columns[i]?.w ?? 0)));
  ws.columns = widths.map((w) => ({ width: Math.min(60, w + 2) }));
  const title = ws.addRow([spec.title]); title.font = { bold: true, size: 16 };
  const subtitle = ws.addRow([spec.subtitle]); subtitle.font = { italic: true, color: { argb: "FF555555" } };
  ws.addRow([]);
  for (const s of spec.sections) {
    const h = ws.addRow([s.heading]); h.font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
    for (let c = 1; c <= s.columns.length; c++) h.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F4B8A" } };
    ws.mergeCells(h.number, 1, h.number, s.columns.length);
    if (s.note) { const n = ws.addRow([s.note]); n.font = { italic: true, color: { argb: "FF7A5200" } }; ws.mergeCells(n.number, 1, n.number, s.columns.length); n.alignment = { wrapText: true, vertical: "top" }; n.height = Math.max(15, Math.ceil(s.note.length / 110) * 15); }
    const head = ws.addRow(s.columns.map((c) => c.h)); head.font = { bold: true };
    head.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE3E9F7" } }; cell.border = { bottom: { style: "thin" } }; });
    for (const r of s.rows) {
      const row = ws.addRow(s.columns.map((_, i) => (typeof r[i] === "number" ? r[i] : cellText(r[i]))));
      row.alignment = { wrapText: true, vertical: "top" };
      row.eachCell({ includeEmpty: true }, (cell, i) => { if (i <= s.columns.length) cell.border = { bottom: { style: "hair", color: { argb: "FFBBBBBB" } } }; });
    }
    ws.addRow([]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function renderPdf(spec) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 28, bufferPages: true, info: { Title: spec.title } });
    doc.registerFont("odiaRegular", path.join(FONTS, "NotoSansOriya.ttf"));
    doc.registerFont("odiaBold", path.join(FONTS, "NotoSansOriya-Bold.ttf"));
    doc.registerFont("hindiRegular", path.join(FONTS, "NotoSansDevanagari-Regular.ttf"));
    doc.registerFont("hindiBold", path.join(FONTS, "NotoSansDevanagari-Bold.ttf"));
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 14;
    const SIZE = 8;
    const PAD = 3;
    const write = (text, x, y, w, bold, color = "#111") => doc.font(fontFor(text, bold)).fontSize(SIZE).fillColor(color).text(text, x, y, { width: w, lineGap: 1 });
    const heightOf = (text, w, bold) => doc.font(fontFor(text, bold)).fontSize(SIZE).heightOfString(text || " ", { width: w, lineGap: 1 });

    doc.font("Helvetica-Bold").fontSize(18).fillColor("#111").text(spec.title, left, doc.y, { width });
    doc.font(fontFor(spec.subtitle, false)).fontSize(9).fillColor("#555").text(spec.subtitle, { width });
    doc.moveDown(0.6);

    const drawHeader = (columns, xs, ws) => {
      const y = doc.y;
      const h = Math.max(...columns.map((c, i) => heightOf(c.h, ws[i] - PAD * 2, true))) + PAD * 2;
      doc.rect(left, y, width, h).fill("#E3E9F7");
      columns.forEach((c, i) => write(c.h, xs[i] + PAD, y + PAD, ws[i] - PAD * 2, true));
      doc.y = y + h;
    };

    for (const s of spec.sections) {
      const total = s.columns.reduce((n, c) => n + c.w, 0);
      const ws = s.columns.map((c) => (c.w / total) * width);
      const xs = ws.map((_, i) => left + ws.slice(0, i).reduce((n, w) => n + w, 0));
      if (doc.y > bottom() - 70) doc.addPage();
      doc.moveDown(0.3);
      const hy = doc.y;
      const hh = heightOf(s.heading, width - 12, true) + 8;
      doc.rect(left, hy, width, hh).fill("#2F4B8A");
      write(s.heading, left + 6, hy + 4, width - 12, true, "#fff");
      doc.y = hy + hh + 2;
      if (s.note) { write(s.note, left, doc.y, width, false, "#7A5200"); doc.moveDown(0.2); }
      drawHeader(s.columns, xs, ws);
      for (const r of s.rows) {
        const cells = s.columns.map((_, i) => cellText(r[i]));
        const h = Math.max(...cells.map((t, i) => heightOf(t, ws[i] - PAD * 2, false))) + PAD * 2;
        if (doc.y + h > bottom()) { doc.addPage(); drawHeader(s.columns, xs, ws); }
        const y = doc.y;
        cells.forEach((t, i) => write(t, xs[i] + PAD, y + PAD, ws[i] - PAD * 2, false));
        doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.3).strokeColor("#bbb").stroke();
        doc.y = y + h;
      }
      doc.moveDown(0.5);
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font("Helvetica").fontSize(7.5).fillColor("#777").text(`${spec.title}  ·  page ${i + 1} of ${range.count}`, left, doc.page.height - doc.page.margins.bottom + 2, { width, align: "right", lineBreak: false });
    }
    doc.end();
  });
}
