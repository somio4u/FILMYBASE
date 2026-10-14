// "Casting PPT": a cover slide, then one designed slide per major character
// (description + key facts on the left, three photo cards on the right so
// the director can drop in actor choices). Always English. Pure function:
// character sheet in, .pptx bytes out — no database or AI involved.
import PptxGenJS from "pptxgenjs";

const C = { bg: "0E0B09", panel: "1A1512", card: "261F1A", accent: "E0A458", deep: "B8742A", text: "F5F1EA", muted: "A89C8C", line: "3D3128" };

// English uses Georgia/Calibri; Odia needs a font that has Odia letters
// (Nirmala UI ships with Windows/Office; other devices substitute one).
const FONTS = { en: { head: "Georgia", body: "Calibri" }, or: { head: "Nirmala UI", body: "Nirmala UI" } };

const LABELS = {
  en: { cast: "THE CAST", presentation: "CASTING PRESENTATION", count: (n) => `${n} characters · 3 choices each`, look: "LOOK", wants: "WANTS", needs: "NEEDS", flaw: "FLAW", inner: "INNER CONFLICT", arc: "ARC", virtues: "VIRTUES", age: "AGE", choices: "CASTING CHOICES FOR", choicesPlain: "CASTING CHOICES", photo: "PHOTO · drop here", name: "NAME" },
  or: { cast: "କାଷ୍ଟ", presentation: "କାଷ୍ଟିଂ ପ୍ରେଜେଣ୍ଟେସନ୍", count: (n) => `${n}ଟି ଚରିତ୍ର · ପ୍ରତିଟିର ୩ଟି ବିକଳ୍ପ`, look: "ଲୁକ୍", wants: "ଚାହିଦା", needs: "ଆବଶ୍ୟକତା", flaw: "ତ୍ରୁଟି", inner: "ଭିତରର ଦ୍ୱନ୍ଦ୍ୱ", arc: "ଚରିତ୍ର ଯାତ୍ରା", virtues: "ଗୁଣ", age: "ବୟସ", choices: "କାଷ୍ଟିଂ ବିକଳ୍ପ —", choicesPlain: "କାଷ୍ଟିଂ ବିକଳ୍ପ", photo: "ଫଟୋ · ଏଠି ଲଗାନ୍ତୁ", name: "ନାମ" },
};

const ARCHETYPE_EN = {
  hero: "THE HERO", mentor: "THE MENTOR", threshold_guardian: "THE GUARDIAN", herald: "THE HERALD",
  shapeshifter: "THE SHAPESHIFTER", shadow: "THE VILLAIN", ally: "ALLY · SIDEKICK", trickster: "THE TRICKSTER",
};

const ARCHETYPE_OR = {
  hero: "ନାୟକ", mentor: "ଗୁରୁ", threshold_guardian: "ପ୍ରହରୀ", herald: "ଦୂତ",
  shapeshifter: "ରୂପ ପରିବର୍ତ୍ତନକାରୀ", shadow: "ଖଳନାୟକ", ally: "ସହଯୋଗୀ", trickster: "ଚତୁର",
};

// Cut long AI text at a word boundary so it can never overflow its block.
function clip(text, max) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6))}…`;
}

export async function buildCastingPpt({ title, characters, lang = "en" }) {
  const isOdia = lang === "or";
  const L = LABELS[isOdia ? "or" : "en"];
  const HEAD = FONTS[isOdia ? "or" : "en"].head;
  const BODY = FONTS[isOdia ? "or" : "en"].body;
  // Capitals and letter-spacing are English-only: they break Odia letter joins.
  const up = (text) => (isOdia ? String(text) : String(text).toUpperCase());
  const sp = (n) => (isOdia ? 0 : n);
  const tr = (value) => (value && typeof value === "object" ? value[isOdia ? "or" : "en"] || value.en || "" : value || "");
  const archetypes = isOdia ? ARCHETYPE_OR : ARCHETYPE_EN;

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 10, height: 5.63 });
  pptx.layout = "WIDE";

  // ---- Cover
  const cover = pptx.addSlide();
  cover.background = { color: C.bg };
  cover.addShape("rect", { x: 0, y: 0, w: 0.35, h: 5.63, fill: { color: C.accent } });
  cover.addShape("rect", { x: 0.35, y: 0, w: 0.08, h: 5.63, fill: { color: C.deep } });
  cover.addText(L.cast, { x: 1.0, y: 1.2, w: 8, h: 0.5, fontSize: 16, bold: true, color: C.accent, fontFace: BODY, charSpacing: sp(12) });
  cover.addText(title, { x: 1.0, y: 1.7, w: 8.4, h: 1.6, fontSize: 60, bold: true, color: C.text, fontFace: HEAD, valign: "middle", fit: "shrink" });
  cover.addShape("line", { x: 1.0, y: 3.5, w: 2.2, h: 0, line: { color: C.accent, width: 3 } });
  cover.addText(L.presentation, { x: 1.0, y: 3.7, w: 8, h: 0.5, fontSize: 22, color: C.text, fontFace: BODY, charSpacing: sp(8) });
  cover.addText(L.count(characters.length), { x: 1.0, y: 4.25, w: 8, h: 0.4, fontSize: 13, italic: true, color: C.muted, fontFace: HEAD });

  // ---- One slide per character: top ~45% = who the character is,
  // bottom ~55% = three big photo cards (name line only).
  characters.forEach((character) => {
    const slide = pptx.addSlide();
    slide.background = { color: C.bg };

    // Top band: character details
    slide.addShape("rect", { x: 0, y: 0, w: 10, h: 2.6, fill: { color: C.panel } });
    slide.addShape("rect", { x: 0, y: 0, w: 0.14, h: 2.6, fill: { color: C.accent } });

    const tag = archetypes[character.archetype] ?? up(character.archetype ?? "");
    slide.addShape("roundRect", { x: 0.45, y: 0.18, w: 1.9, h: 0.28, fill: { color: C.accent }, rectRadius: 0.05 });
    slide.addText(tag, { x: 0.45, y: 0.18, w: 1.9, h: 0.28, align: "center", fontSize: 9.5, bold: true, color: C.bg, fontFace: BODY, charSpacing: sp(3) });

    slide.addText(up(character.name), { x: 0.45, y: 0.5, w: 4.2, h: 0.7, fontSize: 34, bold: true, color: C.text, fontFace: HEAD, valign: "middle", fit: "shrink" });
    const meta = [character.age ? `${L.age} ${character.age}` : "", up(clip(character.relationToHero, 40))].filter(Boolean).join("  ·  ");
    slide.addText(meta, { x: 0.45, y: 1.2, w: 4.2, h: 0.28, fontSize: 10.5, bold: true, color: C.accent, fontFace: BODY, charSpacing: sp(2) });

    const about = [tr(character.heroLogline), tr(character.archetypeNote), tr(character.role)].find(Boolean) ?? "";
    slide.addText(clip(about, 230), { x: 0.45, y: 1.5, w: 4.2, h: 0.75, fontSize: 11, italic: !isOdia, color: C.text, fontFace: HEAD, valign: "top" });

    // 3 x 2 grid of facts, right of the name
    const cells = [
      [L.look, clip(character.look, 95)],
      [L.wants, clip(tr(character.want), 90)],
      [L.needs, clip(tr(character.need), 90)],
      [L.flaw, clip(tr(character.flaw), 90)],
      [L.inner, clip(tr(character.innerConflict), 90)],
      [L.arc, clip(tr(character.arc), 90)],
    ];
    cells.forEach(([label, value], i) => {
      const x = 4.9 + (i % 3) * 1.68;
      const y = 0.2 + Math.floor(i / 3) * 1.1;
      slide.addText(label, { x, y, w: 1.6, h: 0.2, fontSize: 8, bold: true, color: C.accent, fontFace: BODY, charSpacing: sp(3) });
      slide.addText(value, { x, y: y + 0.2, w: 1.6, h: 0.82, fontSize: 9, color: C.text, fontFace: BODY, valign: "top" });
    });

    // Virtues strip closes the top band
    const virtues = (character.virtues ?? []).map(tr).filter(Boolean).slice(0, 4).map((v) => clip(v, 24)).join("   ◆   ");
    slide.addShape("rect", { x: 0, y: 2.3, w: 10, h: 0.3, fill: { color: C.deep } });
    slide.addText(virtues ? `${L.virtues}   ${up(virtues)}` : L.choicesPlain, { x: 0.45, y: 2.3, w: 9.1, h: 0.3, fontSize: 9, bold: true, color: C.bg, fontFace: BODY, charSpacing: sp(3), fit: "shrink" });

    // Bottom: three casting choices, name only
    slide.addText(`${L.choices} ${up(character.name)}`, { x: 0.45, y: 2.68, w: 9.1, h: 0.28, fontSize: 11, bold: true, color: C.accent, fontFace: BODY, charSpacing: sp(4), fit: "shrink" });
    for (let i = 0; i < 3; i += 1) {
      const x = 0.45 + i * 3.1;
      slide.addShape("rect", { x, y: 3.0, w: 2.9, h: 2.45, fill: { color: C.card }, line: { color: C.line, width: 1 } });
      slide.addShape("rect", { x: x + 0.08, y: 3.08, w: 2.74, h: 1.85, fill: { color: C.bg }, line: { color: C.accent, dashType: "dash", width: 1 } });
      slide.addText(String(i + 1), { x, y: 3.25, w: 2.9, h: 1.0, align: "center", fontSize: 56, bold: true, color: C.line, fontFace: "Georgia" });
      slide.addText(L.photo, { x, y: 4.3, w: 2.9, h: 0.3, align: "center", fontSize: 10, italic: !isOdia, color: C.muted, fontFace: HEAD });
      slide.addText(L.name, { x: x + 0.12, y: 5.0, w: 0.75, h: 0.35, fontSize: 9, bold: true, color: C.accent, fontFace: BODY, charSpacing: sp(1), valign: "middle", wrap: false });
      slide.addShape("line", { x: x + 0.9, y: 5.3, w: 1.85, h: 0, line: { color: C.muted, width: 1 } });
    }
  });

  return pptx.write({ outputType: "nodebuffer" });
}
