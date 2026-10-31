// An Excel file (.xlsx) as plain text, so it can go through the same "what stage is this draft at?" analysis as a PDF or Word file.
//
// A scene table (the usual way people plan scenes in Excel) has a header row with columns like  SL NO | INT/EXT | DAY/NIGHT | LOCATION | DESCRIPTION.
// Each row below it becomes one scene in the shape the screenplay reader understands:
//     SCENE 7
//     INT. BISWAS HOUSE - DAY
//     the description of the scene
// Any other sheet is written as one line per row, cells joined with " | ", so nothing is lost.
import ExcelJS from "exceljs";

// one cell -> plain text (formulas give their result, rich text its words, links their label)
export function cellText(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text ?? "").join("").trim();
    if ("result" in v) return String(v.result ?? "").trim();
    if ("text" in v) return String(typeof v.text === "object" ? (v.text?.richText ?? []).map((r) => r.text ?? "").join("") : v.text ?? "").trim();
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return "";
  }
  return String(v).trim();
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");
const COLUMN_KINDS = [
  ["number", (n) => /^(slno|sno|sl|no|number|scene|sceneno|scenenumber|serial|serialno)$/.test(n)],
  ["intExt", (n) => /^(intext|extint|ie|interiorexterior|intorext)$/.test(n)],
  ["time", (n) => /^(daynight|daynite|time|timeofday|dayornight|dn)$/.test(n)],
  ["place", (n) => /^(location|place|setting|locale|spot)$/.test(n)],
  ["description", (n) => /^(description|desc|summary|action|oneliner|details|scenedescription|story)$/.test(n)],
];

// the header row of a scene table: needs a place or a description column plus at least one more of the kinds
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const columns = {};
    rows[r].forEach((text, c) => {
      const n = norm(text);
      if (!n) return;
      for (const [kind, test] of COLUMN_KINDS) if (!(kind in columns) && test(n)) { columns[kind] = c; break; }
    });
    if (("description" in columns || "place" in columns) && Object.keys(columns).length >= 3) return { row: r, columns };
  }
  return null;
}

const tag = (text) => (/^ext/i.test(String(text).trim()) ? "EXT" : "INT");
const timeWord = (text) => {
  const m = /(MORNING|AFTERNOON|EVENING|NIGHT|DAY|DAWN|DUSK|MIDNIGHT|NOON|SUNSET|SUNRISE)/i.exec(String(text ?? ""));
  return m ? m[1].toUpperCase() : "DAY";
};

function sheetToText(rows, nextNumber) {
  const header = findHeader(rows);
  if (!header) return { text: rows.filter((cells) => cells.some(Boolean)).map((cells) => cells.filter(Boolean).join(" | ")).join("\n"), scenes: 0 };
  const { columns } = header;
  const at = (cells, kind) => (kind in columns ? cells[columns[kind]] ?? "" : "");
  const out = [];
  let scenes = 0;
  for (const cells of rows.slice(header.row + 1)) {
    const place = at(cells, "place");
    const description = at(cells, "description");
    if (!place && !description) continue; // an empty row or a stray note
    const given = Number(String(at(cells, "number")).replace(/[^0-9]/g, ""));
    const number = given > 0 ? given : nextNumber + scenes;
    out.push(`SCENE ${number}`, `${tag(at(cells, "intExt"))}. ${(place || "UNKNOWN").replace(/\s+/g, " ").toUpperCase()} - ${timeWord(at(cells, "time"))}`);
    if (description) out.push(description.replace(/\s*\n\s*/g, " "));
    scenes += 1;
  }
  return { text: out.join("\n"), scenes };
}

export async function extractTextFromSpreadsheet(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new Error("I could not open this Excel file. Save it again as .xlsx (Excel Workbook), or as a PDF, and upload that.");
  }
  const parts = [];
  let numbered = 1;
  workbook.eachSheet((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, c) => { cells[c - 1] = cellText(cell); });
      rows.push(Array.from(cells, (t) => t ?? ""));
    });
    const { text, scenes } = sheetToText(rows, numbered);
    numbered += scenes;
    if (text.trim()) parts.push(text);
  });
  return parts.join("\n");
}
