// A PDF line is written in ONE font, but the AI often puts several languages in one line ("କଳା ରୂପା କଏନ୍ / Blackened silver coin / चांदी का सिक्का").
// The Odia font has no Hindi letters and the Hindi font has no Odia letters, so the missing ones came out as empty boxes (□□□).
// ScriptAwarePDF is a normal PDFKit document whose text() looks at every line first: when it holds a script the current font cannot draw,
// the line is cut into pieces (Odia / Hindi / the rest) and each piece is written with the right font, one after the other on the same line.
// Everything else (fonts, sizes, alignment, links, "continued") is left exactly as the caller set it.

import PDFDocument from "pdfkit";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fonts");
const FONT_FILES = {
  mixOdiaR: "NotoSansOriya.ttf",
  mixOdiaB: "NotoSansOriya-Bold.ttf",
  mixHindiR: "NotoSansDevanagari-Regular.ttf",
  mixHindiB: "NotoSansDevanagari-Bold.ttf",
};

// the danda "।" (U+0964/5) is written in both languages and exists in both fonts, so it never starts a new piece
const scriptOf = (char) => {
  const cp = char.codePointAt(0);
  if (cp === 0x0964 || cp === 0x0965) return null;
  if (cp >= 0x0b00 && cp <= 0x0b7f) return "or";
  if (cp >= 0x0900 && cp <= 0x097f) return "hi";
  return null; // Latin letters, digits, spaces, punctuation: both Noto fonts draw them
};

// "or" | "hi" | "latin" — which script the CURRENT font is made for (from its name)
export const fontScript = (fontName) => (/oriya|odia/i.test(fontName ?? "") ? "or" : /devanagari|hindi/i.test(fontName ?? "") ? "hi" : "latin");

// text -> [{ script: "or" | "hi" | null, text }] — neutral characters stay with the piece before them (the first ones join the piece after)
export function splitScriptRuns(text) {
  const runs = [];
  for (const char of String(text)) {
    const script = scriptOf(char);
    const last = runs[runs.length - 1];
    if (!last || (script !== null && last.script !== null && last.script !== script)) runs.push({ script, text: char });
    else {
      if (last.script === null && script !== null) last.script = script;
      last.text += char;
    }
  }
  return runs;
}

// does this line hold a script that the font in use cannot draw?
export function needsSplit(text, currentScript) {
  for (const char of String(text)) {
    const script = scriptOf(char);
    if (script !== null && script !== currentScript) return true;
  }
  return false;
}

export default class ScriptAwarePDF extends PDFDocument {
  constructor(options) {
    super(options);
    for (const [name, file] of Object.entries(FONT_FILES)) this.registerFont(name, path.join(FONTS_DIR, file));
  }

  // The Hindi and Odia fonts have a slightly different "ascender"; PDFKit puts every piece of a line at its own ascender, so a Hindi piece would
  // sit a little higher than the Odia piece next to it. Giving the pieces the same ascender puts them on one baseline. (Done at the first
  // mixed line only, so a PDF without mixed lines does not carry the extra fonts.)
  _levelBaselines() {
    if (this._baselinesLevelled) return;
    this._baselinesLevelled = true;
    const keep = this._font;
    this.font("mixOdiaR");
    const ascender = this._font.ascender;
    for (const name of ["mixOdiaB", "mixHindiR", "mixHindiB"]) { this.font(name); this._font.ascender = ascender; }
    this._font = keep;
  }

  _writeRuns(runs, bold, original, positioned, args, options) {
    runs.forEach((run, i) => {
      const last = i === runs.length - 1;
      if (run.script === "or") this.font(bold ? "mixOdiaB" : "mixOdiaR");
      else if (run.script === "hi") this.font(bold ? "mixHindiB" : "mixHindiR");
      else this._font = original;
      const piece = { ...options, continued: last ? options.continued : true };
      if (i === 0 && positioned) super.text(run.text, args[0], args[1], piece);
      else super.text(run.text, piece);
    });
    this._font = original;
  }

  text(text, ...args) {
    if (typeof text !== "string" || !text) return super.text(text, ...args);
    const bold = /bold/i.test(this._font?.name ?? "");
    const current = fontScript(this._font?.name);
    if (!needsSplit(text, current)) return super.text(text, ...args);
    this._levelBaselines();

    // text(text, x, y, options) or text(text, options)
    const positioned = typeof args[0] === "number";
    const options = (positioned ? args[2] : args[0]) ?? {};
    const original = this._font;
    const runs = splitScriptRuns(text);

    // centred / right-aligned: PDFKit cannot align a line made of pieces, so the line is measured and started at the right place
    // (a line too long for one row is simply written from the left and wraps)
    if (options.align === "center" || options.align === "right") {
      const x = positioned ? args[0] : this.x;
      const y = positioned ? args[1] : this.y;
      const room = options.width ?? this.page.width - this.page.margins.right - x;
      const total = this.widthOfString(text, options);
      if (total < room) {
        const offset = options.align === "center" ? (room - total) / 2 : room - total;
        const homeX = this.x;
        this._writeRuns(runs, bold, original, true, [x + offset, y], { ...options, align: "left", width: room - offset });
        this.x = positioned ? args[0] : homeX;
        return this;
      }
    }
    this._writeRuns(runs, bold, original, positioned, args, options);
    return this;
  }

  // measuring a mixed line must use the same fonts the line will be written with
  widthOfString(text, options) {
    if (typeof text !== "string" || !needsSplit(text, fontScript(this._font?.name))) return super.widthOfString(text, options);
    const bold = /bold/i.test(this._font?.name ?? "");
    const original = this._font;
    let total = 0;
    for (const run of splitScriptRuns(text)) {
      if (run.script === "or") this.font(bold ? "mixOdiaB" : "mixOdiaR");
      else if (run.script === "hi") this.font(bold ? "mixHindiB" : "mixHindiR");
      else this._font = original;
      total += super.widthOfString(run.text, options);
    }
    this._font = original;
    return total;
  }
}
