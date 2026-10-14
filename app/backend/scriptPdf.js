// Writing text into a PDF in the RIGHT FONT for its script. The built-in PDF fonts (Times, Helvetica) have no Odia or Hindi letters,
// so Odia text written with them comes out as random symbols. Here every run of text gets a font that has its letters:
// Odia -> Noto Sans Oriya, Devanagari (Hindi) -> Noto Sans Devanagari, everything else -> Times.

export function scriptOf(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x0b00 && c <= 0x0b7f) return "odia";
  if (c >= 0x0900 && c <= 0x097f) return "hindi";
  return "latin";
}

// Splits text into runs of one script. Spaces, digits and punctuation stay with the run before them (so words are not chopped up).
export function segmentByScript(text) {
  const runs = [];
  for (const ch of String(text ?? "")) {
    const neutral = /[\s\d.,;:!?'"“”‘’()\[\]{}\-–—/\\|%&*+=<>@#_~`^·•…॥।]/u.test(ch);
    const script = neutral ? (runs.at(-1)?.script ?? "latin") : scriptOf(ch);
    if (runs.length && runs.at(-1).script === script) runs.at(-1).text += ch;
    else runs.push({ script, text: ch });
  }
  return runs;
}

export function registerScriptFonts(doc, FONTS) {
  doc.registerFont("odiaRegular", FONTS.odiaRegular);
  doc.registerFont("odiaBold", FONTS.odiaBold);
  doc.registerFont("hindiRegular", FONTS.hindiRegular);
  doc.registerFont("hindiBold", FONTS.hindiBold);
}

const FONT = {
  latin: { regular: "Times-Roman", bold: "Times-Bold", italic: "Times-Italic" },
  odia: { regular: "odiaRegular", bold: "odiaBold", italic: "odiaRegular" },
  hindi: { regular: "hindiRegular", bold: "hindiBold", italic: "hindiRegular" },
};
// how tall a line is, per script (Indic letters carry marks above and below, so they need more room)
const LINE_HEIGHT = { latin: 1.3, odia: 1.75, hindi: 1.7 };

// content: a string, or a list of pieces [{ text, weight?, color? }] that flow on the same line (e.g. a bold label then plain text).
// Words are laid out one by one, each in the font of its script, so Odia, Hindi and English can share a line without overlapping.
export function writeScripted(doc, content, { size = 11.5, weight = "regular", color = "#000", align = "left" } = {}) {
  const pieces = (Array.isArray(content) ? content : [{ text: content }]).map((p) => ({ weight, color, ...p, text: String(p.text ?? "") }));
  const left = doc.page.margins.left;
  const maxWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;

  // 1. cut into words, each word into runs of one script
  const words = []; // [{ runs: [{ text, font, script, color, width }], space }]
  const lines = [[]];
  const widthOf = (text, font) => doc.font(font).fontSize(size).widthOfString(text);
  for (const piece of pieces) {
    for (const [pi, paragraph] of piece.text.split("\n").entries()) {
      if (pi > 0) lines.push([]);
      for (const token of paragraph.split(/(\s+)/u).filter((t) => t !== "")) {
        const isSpace = /^\s+$/u.test(token);
        const runs = (isSpace ? [{ script: "latin", text: " " }] : segmentByScript(token)).map((r) => {
          const font = FONT[r.script][piece.weight] ?? FONT[r.script].regular;
          return { text: r.text, font, script: r.script, color: piece.color, width: widthOf(r.text, font) };
        });
        words.push({ runs, isSpace, width: runs.reduce((a, r) => a + r.width, 0), line: lines.length - 1 });
      }
    }
  }
  // 2. break into lines that fit the page width
  const out = [];
  let current = { items: [], width: 0 };
  let paragraphIndex = 0;
  const flush = () => { out.push(current); current = { items: [], width: 0 }; };
  for (const w of words) {
    if (w.line !== paragraphIndex) { for (let k = paragraphIndex; k < w.line; k += 1) flush(); paragraphIndex = w.line; }
    if (w.isSpace && current.items.length === 0) continue;
    if (!w.isSpace && current.width + w.width > maxWidth && current.items.length > 0) {
      while (current.items.length && current.items.at(-1).isSpace) { current.width -= current.items.pop().width; }
      flush();
    }
    current.items.push(w); current.width += w.width;
  }
  flush();
  // 3. draw
  let y = doc.y;
  for (const line of out) {
    while (line.items.length && line.items.at(-1).isSpace) { line.width -= line.items.pop().width; }
    const height = Math.max(size * LINE_HEIGHT.latin, ...line.items.flatMap((w) => w.runs.map((r) => size * LINE_HEIGHT[r.script])));
    if (y + height > bottom) { doc.addPage(); y = doc.page.margins.top; }
    let x = align === "center" ? left + (maxWidth - line.width) / 2 : left;
    for (const w of line.items) {
      for (const r of w.runs) {
        doc.font(r.font).fontSize(size).fillColor(r.color).text(r.text, x, y, { lineBreak: false });
        x += r.width;
      }
    }
    y += height;
  }
  doc.x = left; doc.y = y;
  doc.fillColor("#000");
  return doc;
}
