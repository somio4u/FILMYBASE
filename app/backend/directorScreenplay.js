// "Director Screenplay": the screenplay laid out like the director's own scene sheets —
//   SCENE - 01 (centred), then Location / Time / Character, a double rule, and below it the scene:
//   the LEFT HALF OF THE PAGE IS EMPTY (the director writes his notes there), action in ( brackets ), dialogue as  NAME : words,
//   transitions on the right, and "Pg- N" at the foot of every page. Every scene starts on a new page.
// The screenplay's own lines are NEVER changed: each action, dialogue, acting note and transition is printed exactly as saved.
// Only the scene heading is split into the Location / Time / Character lines (from the same data as the heading).

import { AlignmentType, BorderStyle, Document, Footer, PageNumber, Paragraph, Table, TableCell, TableRow, TextRun, VerticalAlign, WidthType } from "docx";

const pad2 = (n) => String(n).padStart(2, "0");

// ---- the scenes, in order, ready to print --------------------------------------------------------------------------------------------
// -> [{ episodeIndex, episodeTitle, firstInEpisode, number, intExt, location, time, characters, elements }]
export function directorScenes(deck, sceneList, scenesByEpisode, { onlyEpisode = null } = {}) {
  const isSeries = Array.isArray(sceneList.episodeScenes);
  const out = [];
  const add = (scene, sceneIndex, row, episodeIndex) => {
    if (!row) return; // a scene not written yet has nothing to print
    out.push({
      episodeIndex,
      episodeTitle: episodeIndex === null ? "" : (deck?.episodes?.[episodeIndex]?.title?.en ?? ""),
      firstInEpisode: false,
      number: sceneIndex + 1,
      intExt: scene.intExt ?? "",
      location: scene.location?.en ?? "",
      time: scene.timeOfDay ?? "",
      characters: row.content?.charactersPresent ?? [],
      elements: row.content?.elements ?? [],
    });
  };
  if (isSeries) {
    sceneList.episodeScenes.forEach((episode, episodeIndex) => {
      if (onlyEpisode !== null && episodeIndex !== onlyEpisode) return;
      const rows = scenesByEpisode.get(episodeIndex) ?? [];
      const before = out.length;
      (episode.scenes ?? []).forEach((scene, sceneIndex) => add(scene, sceneIndex, rows.find((r) => r.scene_index === sceneIndex), episodeIndex));
      if (out.length > before) out[before].firstInEpisode = true;
    });
  } else {
    const rows = scenesByEpisode.get(null) ?? [];
    sceneList.scenes.forEach((scene, sceneIndex) => add(scene, sceneIndex, rows.find((r) => r.scene_index === sceneIndex), null));
  }
  return out;
}

// "Location : Sagar's Bed room / Int"
const locationLine = (s) => {
  const place = String(s.location ?? "").trim();
  const side = { INT: "Int", EXT: "Ext", "INT/EXT": "Int/Ext" }[String(s.intExt ?? "").toUpperCase()] ?? String(s.intExt ?? "").trim();
  return [place, side].filter(Boolean).join(" / ");
};
const speaker = (e) => {
  const modifier = e.characterModifier && e.characterModifier !== "none" ? ` (${e.characterModifier})` : "";
  return `${e.character ?? ""}${modifier}`;
};
// the words of a dialogue: the acting note (if any) in front, as a bracket, like the director's sheets
const dialogueWords = (e) => `${e.parenthetical ? `(${e.parenthetical}) ` : ""}${e.text ?? ""}`;
const actionWords = (e) => (e.type === "flashback" ? `(FLASH - ${e.character ?? ""}'S POV: ${e.text ?? ""})` : `(${e.text ?? ""})`);

// ---- PDF -----------------------------------------------------------------------------------------------------------------------------
export const DIRECTOR_LAYOUT = {
  page: "A4",
  margin: 50,
  nameX: 215, // everything left of this is left empty for the director's notes
  nameWidth: 76,
  colonX: 293,
  textX: 303,
};

// `doc` is a ScriptAwarePDF made with bufferPages: true; the caller pipes it and calls doc.end() afterwards.
export function writeDirectorPdf(doc, scenes, { fonts }) {
  const L = DIRECTOR_LAYOUT;
  doc.registerFont("dsOdia", fonts.odiaRegular);
  doc.registerFont("dsHindi", fonts.hindiRegular);
  const right = doc.page.width - L.margin;
  const textWidth = right - L.textX;
  const bodyFont = (text) => (/[଀-୿]/.test(text) ? "dsOdia" : /[ऀ-ॿ]/.test(text) ? "dsHindi" : "Times-Roman");
  const bottom = () => doc.page.height - L.margin - 14; // room for "Pg- N"
  const space = (lines) => doc.y + lines * 16 > bottom();

  if (scenes.length === 0) {
    doc.font("Helvetica").fontSize(12).text("No scene of this screenplay has been written yet.", L.margin, 80);
    return;
  }

  scenes.forEach((scene, index) => {
    if (index > 0) doc.addPage();
    doc.y = L.margin + 8;
    if (scene.firstInEpisode) {
      doc.font("Helvetica-Bold").fontSize(11).text(`EPISODE ${scene.episodeIndex + 1}${scene.episodeTitle ? ` — ${scene.episodeTitle}` : ""}`, L.margin, doc.y, { width: right - L.margin, align: "center" });
      doc.moveDown(0.6);
    }
    doc.font("Helvetica-Bold").fontSize(17).text(`SCENE - ${pad2(scene.number)}`, L.margin, doc.y, { width: right - L.margin, align: "center" });
    doc.moveDown(0.9);

    const row = (label, value) => {
      const y = doc.y;
      doc.font("Helvetica").fontSize(13).text(label, L.margin + 6, y, { width: 70, lineBreak: false });
      doc.font("Helvetica").fontSize(13).text(":", L.margin + 76, y, { width: 8, lineBreak: false });
      doc.font(bodyFont(value)).fontSize(13).text(value, L.margin + 88, y, { width: right - L.margin - 88 });
      doc.moveDown(0.55);
    };
    row("Location", locationLine(scene));
    row("Time", scene.time);
    row("Character", scene.characters.join(", "));
    const ruleY = doc.y + 2;
    doc.lineWidth(1.4).moveTo(L.margin, ruleY).lineTo(right, ruleY).stroke();
    doc.lineWidth(0.6).moveTo(L.margin, ruleY + 3.5).lineTo(right, ruleY + 3.5).stroke();
    doc.y = ruleY + 18;

    for (const element of scene.elements) {
      if (element.type === "dialogue") {
        const name = speaker(element);
        const words = dialogueWords(element);
        doc.font(bodyFont(words)).fontSize(12);
        const need = Math.min(doc.heightOfString(words, { width: textWidth, lineGap: 5 }), 3 * 18);
        if (doc.y + need > bottom()) doc.addPage(), (doc.y = L.margin + 8);
        const y = doc.y;
        // the name and the colon are set in the same font as the words, so all three sit on one baseline
        const lineFont = bodyFont(words + name);
        doc.font(lineFont).fontSize(12).text(name, L.nameX, y, { width: L.nameWidth, lineGap: 5 });
        const afterName = doc.y;
        const pageNow = doc.bufferedPageRange().count;
        doc.font(lineFont).fontSize(12).text(":", L.colonX, y, { width: 8, lineBreak: false });
        doc.font(lineFont).fontSize(12).text(words, L.textX, y, { width: textWidth, lineGap: 5 });
        doc.y = doc.bufferedPageRange().count === pageNow ? Math.max(doc.y, afterName) : doc.y;
        doc.moveDown(0.8);
      } else if (element.type === "transition") {
        const words = element.text ?? "";
        doc.font(bodyFont(words)).fontSize(12);
        if (space(2)) doc.addPage(), (doc.y = L.margin + 8);
        doc.text(words, L.textX, doc.y, { width: textWidth, align: "right", lineGap: 5 });
        doc.moveDown(0.8);
      } else {
        const words = actionWords(element);
        doc.font(bodyFont(words)).fontSize(12);
        const need = Math.min(doc.heightOfString(words, { width: textWidth, lineGap: 5 }), 3 * 18);
        if (doc.y + need > bottom()) doc.addPage(), (doc.y = L.margin + 8);
        doc.text(words, L.textX, doc.y, { width: textWidth, lineGap: 5 });
        doc.moveDown(0.8);
      }
    }
  });

  // "Pg- N" on every page, centred at the foot
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.font("Helvetica-Bold").fontSize(11).text(`Pg- ${i - range.start + 1}`, 0, doc.page.height - 44, { width: doc.page.width, align: "center", lineBreak: false });
  }
}

// ---- Word ----------------------------------------------------------------------------------------------------------------------------
// The scene body is a table of three columns — [empty, for the director's notes | name | words] — without borders, so the notes can be
// typed straight into the empty column next to the line they belong to.
const NONE = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE };
const FONT = "Times New Roman";
const COLS = [4000, 1500, 4966]; // twips: notes | name | words (A4 with 0.5 inch margins)

export function buildDirectorDocx(scenes) {
  const run = (text, extra = {}) => new TextRun({ text, font: { ascii: FONT, hAnsi: FONT, cs: "Nirmala UI" }, size: 24, ...extra });
  const cell = (children, width, extra = {}) => new TableCell({ children, width: { size: width, type: WidthType.DXA }, borders: NO_BORDERS, verticalAlign: VerticalAlign.TOP, ...extra });
  const para = (text, opts = {}) => new Paragraph({ children: [run(text)], spacing: { after: 160 }, ...opts });
  const empty = () => new Paragraph({ children: [] });
  const body = [];

  if (scenes.length === 0) body.push(para("No scene of this screenplay has been written yet."));
  scenes.forEach((scene, index) => {
    if (scene.firstInEpisode) {
      body.push(new Paragraph({ children: [run(`EPISODE ${scene.episodeIndex + 1}${scene.episodeTitle ? ` — ${scene.episodeTitle}` : ""}`, { bold: true, size: 22 })], alignment: AlignmentType.CENTER, pageBreakBefore: index > 0, spacing: { after: 120 } }));
    }
    body.push(new Paragraph({ children: [run(`SCENE - ${pad2(scene.number)}`, { bold: true, size: 34 })], alignment: AlignmentType.CENTER, pageBreakBefore: index > 0 && !scene.firstInEpisode, spacing: { after: 260 } }));
    [["Location", locationLine(scene)], ["Time", scene.time], ["Character", scene.characters.join(", ")]].forEach(([label, value], i, all) => {
      body.push(new Paragraph({
        children: [run(`${label}\t: ${value}`, { size: 26 })],
        tabStops: [{ type: "left", position: 1500 }],
        indent: { left: 1500, hanging: 1500 },
        spacing: { after: 140 },
        border: i === all.length - 1 ? { bottom: { style: BorderStyle.DOUBLE, size: 6, space: 6, color: "000000" } } : undefined,
      }));
    });
    const rows = scene.elements.map((element) => {
      if (element.type === "dialogue") {
        return new TableRow({ cantSplit: false, children: [cell([empty()], COLS[0]), cell([para(speaker(element))], COLS[1]), cell([para(`: ${dialogueWords(element)}`)], COLS[2])] });
      }
      if (element.type === "transition") {
        return new TableRow({ children: [cell([empty()], COLS[0]), cell([empty()], COLS[1]), cell([para(element.text ?? "", { alignment: AlignmentType.RIGHT })], COLS[2])] });
      }
      return new TableRow({ children: [cell([empty()], COLS[0]), cell([empty()], COLS[1]), cell([para(actionWords(element))], COLS[2])] });
    });
    if (rows.length) {
      body.push(new Table({ rows, width: { size: COLS.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: COLS, borders: { ...NO_BORDERS, insideHorizontal: NONE, insideVertical: NONE } }));
    }
  });

  return new Document({
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 900, bottom: 900, left: 720, right: 720 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ["Pg- ", PageNumber.CURRENT], bold: true, font: "Arial", size: 22 })] })] }) },
      children: body,
    }],
  });
}
