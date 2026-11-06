// AI Movie → the screenplay as a Word file (.docx): title, then every scene — heading, action in English, dialogue in the chosen language (Hindi by default
// for a Hindi film, as in the PDF). Plain screenplay layout: speaker name centred in capitals, the line under it, transitions on the right.
import { Document, Packer, Paragraph, TextRun, AlignmentType, PageBreak } from "docx";

const FONT = "Courier New";
const pick = (v, lang) => (typeof v === "string" ? v : String(v?.[lang] || v?.en || v?.hi || ""));

const para = (text, options = {}) => new Paragraph({ spacing: { after: 160 }, ...options.paragraph, children: [new TextRun({ text, font: FONT, size: 24, ...options.run })] });

// scenes: [{ sceneHeading, content:[{type, character, line, text, parenthetical, transition}] }] (older scenes: { action, dialogue:[] }); lang: "en" | "hi" (the language of the DIALOGUE)
export function screenplayDocxChildren(scenes, { title = "Screenplay", lang = "en" } = {}) {
  const out = [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 2400, after: 400 }, children: [new TextRun({ text: String(title).toUpperCase(), font: FONT, size: 36, bold: true })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "A Screenplay", font: FONT, size: 24 })] }), new Paragraph({ children: [new PageBreak()] })];
  scenes.forEach((scene, i) => {
    const heading = pick(scene?.sceneHeading, "en");
    out.push(para(`${i + 1}. ${heading}`.toUpperCase(), { run: { bold: true }, paragraph: { spacing: { before: 360, after: 200 } } }));
    const blocks = Array.isArray(scene?.content) ? scene.content
      : [...(pick(scene?.action, "en").trim() ? [{ type: "action", text: scene.action }] : []), ...(Array.isArray(scene?.dialogue) ? scene.dialogue.map((d) => ({ type: "dialogue", ...d })) : [])];
    for (const b of blocks) {
      if (b?.type === "dialogue") {
        const line = pick(b.line ?? b.text, lang);
        if (!line.trim()) continue;
        const name = `${String(b.character ?? "").toUpperCase()}${b.extension ? ` (${b.extension})` : ""}`;
        out.push(para(name, { paragraph: { alignment: AlignmentType.LEFT, indent: { left: 3000 }, spacing: { after: 0 } } }));
        const note = pick(b.parenthetical, lang);
        if (note.trim()) out.push(para(`(${note})`, { paragraph: { indent: { left: 2400 }, spacing: { after: 0 } } }));
        out.push(para(line, { paragraph: { indent: { left: 1500, right: 1500 } } }));
      } else if (b?.type === "transition") {
        const text = String(b.transition ?? b.text ?? "").trim();
        if (text) out.push(para(`${text.toUpperCase()}${/:$/.test(text) ? "" : ":"}`, { paragraph: { alignment: AlignmentType.RIGHT } }));
      } else {
        const text = pick(b?.text, "en");
        if (text.trim()) out.push(para(text));
      }
    }
  });
  return out;
}

export async function screenplayDocxBuffer(scenes, options) {
  return Packer.toBuffer(new Document({ sections: [{ children: screenplayDocxChildren(scenes, options) }] }));
}
