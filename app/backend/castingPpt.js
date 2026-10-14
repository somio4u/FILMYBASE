// "Casting PPT": a cover slide, then one designed slide per major character
// (description + key facts on the left, three photo cards on the right so
// the director can drop in actor choices). Always English. Pure function:
// character sheet in, .pptx bytes out — no database or AI involved.
import PptxGenJS from "pptxgenjs";

const C = { bg: "0E0B09", panel: "1A1512", card: "261F1A", accent: "E0A458", deep: "B8742A", text: "F5F1EA", muted: "A89C8C", line: "3D3128" };
const HEAD = "Georgia";
const BODY = "Calibri";

const ARCHETYPE = {
  hero: "THE HERO", mentor: "THE MENTOR", threshold_guardian: "THE GUARDIAN", herald: "THE HERALD",
  shapeshifter: "THE SHAPESHIFTER", shadow: "THE VILLAIN", ally: "ALLY · SIDEKICK", trickster: "THE TRICKSTER",
};

const en = (value) => (value && typeof value === "object" ? value.en || "" : value || "");

// Cut long AI text at a word boundary so it can never overflow its block.
function clip(text, max) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6))}…`;
}

export async function buildCastingPpt({ title, characters }) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 10, height: 5.63 });
  pptx.layout = "WIDE";

  // ---- Cover
  const cover = pptx.addSlide();
  cover.background = { color: C.bg };
  cover.addShape("rect", { x: 0, y: 0, w: 0.35, h: 5.63, fill: { color: C.accent } });
  cover.addShape("rect", { x: 0.35, y: 0, w: 0.08, h: 5.63, fill: { color: C.deep } });
  cover.addText("THE CAST", { x: 1.0, y: 1.2, w: 8, h: 0.5, fontSize: 16, bold: true, color: C.accent, fontFace: BODY, charSpacing: 12 });
  cover.addText(title, { x: 1.0, y: 1.7, w: 8.4, h: 1.6, fontSize: 60, bold: true, color: C.text, fontFace: HEAD, valign: "middle", fit: "shrink" });
  cover.addShape("line", { x: 1.0, y: 3.5, w: 2.2, h: 0, line: { color: C.accent, width: 3 } });
  cover.addText("CASTING PRESENTATION", { x: 1.0, y: 3.7, w: 8, h: 0.5, fontSize: 22, color: C.text, fontFace: BODY, charSpacing: 8 });
  cover.addText(`${characters.length} characters · 3 choices each`, { x: 1.0, y: 4.25, w: 8, h: 0.4, fontSize: 13, italic: true, color: C.muted, fontFace: HEAD });

  // ---- One slide per character
  characters.forEach((character, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: C.bg };

    // Left panel
    slide.addShape("rect", { x: 0, y: 0, w: 5.45, h: 5.63, fill: { color: C.panel } });
    slide.addShape("rect", { x: 0, y: 0, w: 0.14, h: 5.63, fill: { color: C.accent } });

    const tag = ARCHETYPE[character.archetype] ?? String(character.archetype ?? "").toUpperCase();
    slide.addShape("roundRect", { x: 0.45, y: 0.32, w: 2.0, h: 0.3, fill: { color: C.accent }, rectRadius: 0.05 });
    slide.addText(tag, { x: 0.45, y: 0.32, w: 2.0, h: 0.3, align: "center", fontSize: 10, bold: true, color: C.bg, fontFace: BODY, charSpacing: 3 });
    slide.addText(String(index + 1).padStart(2, "0"), { x: 4.2, y: 0.2, w: 1.0, h: 0.55, align: "right", fontSize: 30, bold: true, color: C.line, fontFace: HEAD });

    slide.addText(String(character.name).toUpperCase(), { x: 0.45, y: 0.7, w: 4.8, h: 0.75, fontSize: 36, bold: true, color: C.text, fontFace: HEAD, valign: "middle", fit: "shrink" });
    const meta = [character.age ? `AGE ${character.age}` : "", clip(character.relationToHero, 40).toUpperCase()].filter(Boolean).join("  ·  ");
    slide.addText(meta, { x: 0.45, y: 1.43, w: 4.8, h: 0.3, fontSize: 11, bold: true, color: C.accent, fontFace: BODY, charSpacing: 2 });

    // Character description (who they are, in a few lines)
    const about = [en(character.heroLogline), en(character.archetypeNote), en(character.role)].find(Boolean) ?? "";
    slide.addText(clip(about, 230), { x: 0.45, y: 1.78, w: 4.8, h: 0.95, fontSize: 12.5, italic: true, color: C.text, fontFace: HEAD, valign: "top" });
    slide.addShape("line", { x: 0.45, y: 2.8, w: 4.8, h: 0, line: { color: C.line, width: 1 } });

    // 2 x 3 grid of facts
    const cells = [
      ["LOOK", clip(character.look, 120)],
      ["FLAW", clip(en(character.flaw), 110)],
      ["WANTS", clip(en(character.want), 110)],
      ["INNER CONFLICT", clip(en(character.innerConflict), 110)],
      ["NEEDS", clip(en(character.need), 110)],
      ["ARC", clip(en(character.arc), 110)],
    ];
    cells.forEach(([label, value], i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = 0.45 + col * 2.45;
      const y = 2.92 + row * 0.8;
      slide.addText(label, { x, y, w: 2.3, h: 0.22, fontSize: 8.5, bold: true, color: C.accent, fontFace: BODY, charSpacing: 3 });
      slide.addText(value, { x, y: y + 0.22, w: 2.3, h: 0.55, fontSize: 9.5, color: C.text, fontFace: BODY, valign: "top" });
    });

    // Virtues strip along the bottom of the panel
    const virtues = (character.virtues ?? []).map(en).filter(Boolean).slice(0, 4).map((v) => clip(v, 24)).join("   ◆   ");
    slide.addShape("rect", { x: 0.14, y: 5.33, w: 5.31, h: 0.3, fill: { color: C.deep } });
    slide.addText(virtues ? `VIRTUES   ${virtues.toUpperCase()}` : "CASTING CHOICES →", { x: 0.45, y: 5.33, w: 4.9, h: 0.3, fontSize: 8.5, bold: true, color: C.bg, fontFace: BODY, charSpacing: 2, fit: "shrink" });

    // Right side: three photo cards
    slide.addText(`CASTING CHOICES FOR ${String(character.name).toUpperCase()}`, { x: 5.7, y: 0.12, w: 4.1, h: 0.3, fontSize: 9.5, bold: true, color: C.accent, fontFace: BODY, charSpacing: 3, fit: "shrink" });
    for (let i = 0; i < 3; i += 1) {
      const x = 5.7 + i * 1.4;
      slide.addShape("rect", { x, y: 0.5, w: 1.3, h: 4.95, fill: { color: C.card }, line: { color: C.line, width: 1 } });
      slide.addShape("rect", { x: x + 0.07, y: 0.57, w: 1.16, h: 2.9, fill: { color: C.bg }, line: { color: C.accent, dashType: "dash", width: 1 } });
      slide.addText(String(i + 1), { x, y: 1.1, w: 1.3, h: 1.0, align: "center", fontSize: 54, bold: true, color: C.line, fontFace: HEAD });
      slide.addText("PHOTO", { x, y: 2.5, w: 1.3, h: 0.3, align: "center", fontSize: 10, bold: true, color: C.muted, fontFace: BODY, charSpacing: 6 });
      slide.addText("drop here", { x, y: 2.75, w: 1.3, h: 0.3, align: "center", fontSize: 9, italic: true, color: C.muted, fontFace: HEAD });
      const lines = [["NAME", 3.6], ["AGE", 4.15], ["NOTES", 4.7]];
      lines.forEach(([label, y]) => {
        slide.addText(label, { x: x + 0.1, y, w: 1.1, h: 0.2, fontSize: 7.5, bold: true, color: C.accent, fontFace: BODY, charSpacing: 3 });
        slide.addShape("line", { x: x + 0.1, y: y + 0.45, w: 1.1, h: 0, line: { color: C.line, width: 1 } });
      });
    }
  });

  return pptx.write({ outputType: "nodebuffer" });
}
