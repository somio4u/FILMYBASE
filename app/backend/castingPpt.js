// "Casting PPT": a cover, then the cast in sections (Protagonist, Heroines,
// Villains, Sidekicks, Key Supporting). Each section opens with a title slide;
// each character gets one designed slide: details on top, three photo cards
// (name line only) below. English or Odia. Pure function: cast list in,
// .pptx bytes out — no database or AI here.
import PptxGenJS from "pptxgenjs";
import { GROUPS } from "./castingCast.js";

const C = { bg: "0E0B09", panel: "1A1512", card: "261F1A", accent: "E0A458", deep: "B8742A", text: "F5F1EA", muted: "A89C8C", line: "3D3128" };

// English uses Georgia/Calibri; Odia needs a font that has Odia letters
// (Nirmala UI ships with Windows/Office; other devices substitute one).
const FONTS = { en: { head: "Georgia", body: "Calibri" }, or: { head: "Nirmala UI", body: "Nirmala UI" } };

const GROUP_NAMES = {
  en: { protagonist: "THE PROTAGONIST", heroine: "THE HEROINES", villain: "THE VILLAINS", sidekick: "THE SIDEKICKS", supporting: "KEY SUPPORTING" },
  or: { protagonist: "ନାୟକ", heroine: "ନାୟିକାମାନେ", villain: "ଖଳନାୟକମାନେ", sidekick: "ସହଯୋଗୀମାନେ", supporting: "ମୁଖ୍ୟ ସହାୟକ ଚରିତ୍ର" },
};
const GROUP_TAG = {
  en: { protagonist: "PROTAGONIST", heroine: "HEROINE", villain: "VILLAIN", sidekick: "SIDEKICK", supporting: "KEY SUPPORTING" },
  or: { protagonist: "ନାୟକ", heroine: "ନାୟିକା", villain: "ଖଳନାୟକ", sidekick: "ସହଯୋଗୀ", supporting: "ସହାୟକ ଚରିତ୍ର" },
};

const LABELS = {
  en: { cast: "THE CAST", presentation: "CASTING PRESENTATION", count: (n) => `${n} characters · 3 choices each`, sectionCount: (n) => `${n} ${n === 1 ? "character" : "characters"}`, look: "LOOK", importance: "IMPORTANCE", relation: "RELATION", arc: "CHARACTER ARC", age: "AGE", rank: "RANK", screen: "SCREEN TIME", score: "STORY IMPORTANCE", choices: "CASTING CHOICES FOR", photo: "PHOTO · drop here", name: "NAME" },
  or: { cast: "କାଷ୍ଟ", presentation: "କାଷ୍ଟିଂ ପ୍ରେଜେଣ୍ଟେସନ୍", count: (n) => `${n}ଟି ଚରିତ୍ର · ପ୍ରତିଟିର ୩ଟି ବିକଳ୍ପ`, sectionCount: (n) => `${n}ଟି ଚରିତ୍ର`, look: "ଲୁକ୍", importance: "ସିରିଜ୍‌ରେ ଗୁରୁତ୍ୱ", relation: "ସମ୍ପର୍କ", arc: "ଚରିତ୍ର ଯାତ୍ରା", age: "ବୟସ", rank: "ର୍‍ୟାଙ୍କ", screen: "ସ୍କ୍ରିନ୍ ସମୟ", score: "କାହାଣୀରେ ଗୁରୁତ୍ୱ", choices: "କାଷ୍ଟିଂ ବିକଳ୍ପ —", photo: "ଫଟୋ · ଏଠି ଲଗାନ୍ତୁ", name: "ନାମ" },
};

// Cut long AI text at a word boundary so it can never overflow its block.
function clip(text, max) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6))}…`;
}

export async function buildCastingPpt({ title, cast, lang = "en" }) {
  const isOdia = lang === "or";
  const key = isOdia ? "or" : "en";
  const L = LABELS[key];
  const HEAD = FONTS[key].head;
  const BODY = FONTS[key].body;
  // Capitals and letter-spacing are English-only: they break Odia letter joins.
  const up = (text) => (isOdia ? String(text) : String(text).toUpperCase());
  const sp = (n) => (isOdia ? 0 : n);
  const tr = (value) => (value && typeof value === "object" ? value[key] || value.en || "" : value || "");

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
  cover.addText(L.count(cast.length), { x: 1.0, y: 4.25, w: 8, h: 0.4, fontSize: 13, italic: !isOdia, color: C.muted, fontFace: HEAD });

  for (const group of GROUPS) {
    const members = cast.filter((c) => (GROUPS.includes(c.group) ? c.group : "supporting") === group);
    if (members.length === 0) continue;

    // ---- Section slide
    const section = pptx.addSlide();
    section.background = { color: C.bg };
    section.addShape("rect", { x: 0, y: 0, w: 10, h: 0.18, fill: { color: C.accent } });
    section.addText(GROUP_NAMES[key][group], { x: 0.8, y: 1.3, w: 8.4, h: 1.2, fontSize: 46, bold: true, color: C.text, fontFace: HEAD, valign: "middle", fit: "shrink" });
    section.addShape("line", { x: 0.85, y: 2.65, w: 2.0, h: 0, line: { color: C.accent, width: 3 } });
    section.addText(L.sectionCount(members.length), { x: 0.8, y: 2.8, w: 8.4, h: 0.4, fontSize: 14, color: C.accent, fontFace: BODY, charSpacing: sp(4) });
    section.addText(members.map((m) => (isOdia && m.odiaName ? m.odiaName : m.name)).join("   ·   "), { x: 0.8, y: 3.3, w: 8.4, h: 1.2, fontSize: 16, color: C.muted, fontFace: HEAD, valign: "top", fit: "shrink" });

    // ---- One slide per character: top ~45% = who they are, bottom ~55% = three photo cards
    for (const character of members) {
      const displayName = isOdia && character.odiaName ? character.odiaName : character.name;
      const slide = pptx.addSlide();
      slide.background = { color: C.bg };

      slide.addShape("rect", { x: 0, y: 0, w: 10, h: 2.6, fill: { color: C.panel } });
      slide.addShape("rect", { x: 0, y: 0, w: 0.14, h: 2.6, fill: { color: C.accent } });

      slide.addShape("roundRect", { x: 0.45, y: 0.18, w: 1.9, h: 0.28, fill: { color: C.accent }, rectRadius: 0.05 });
      slide.addText(GROUP_TAG[key][group], { x: 0.45, y: 0.18, w: 1.9, h: 0.28, align: "center", fontSize: 9.5, bold: true, color: C.bg, fontFace: BODY, charSpacing: sp(3) });

      slide.addText(up(displayName), { x: 0.45, y: 0.5, w: 4.2, h: 0.7, fontSize: 34, bold: true, color: C.text, fontFace: HEAD, valign: "middle", fit: "shrink" });
      slide.addText(character.age ? `${L.age} ${character.age}` : "", { x: 0.45, y: 1.2, w: 4.2, h: 0.28, fontSize: 10.5, bold: true, color: C.accent, fontFace: BODY, charSpacing: sp(2) });
      slide.addText(clip(tr(character.about), 230), { x: 0.45, y: 1.5, w: 4.2, h: 0.75, fontSize: 11, italic: !isOdia, color: C.text, fontFace: HEAD, valign: "top" });

      // 2 x 2 facts: look, importance, relation, arc
      const cells = [
        [L.look, clip(tr(character.look), 110)],
        [L.importance, clip(tr(character.importance), 120)],
        [L.relation, clip(tr(character.relation), 120)],
        [L.arc, clip(tr(character.arc), 120)],
      ];
      cells.forEach(([label, value], i) => {
        const x = 4.95 + (i % 2) * 2.55;
        const y = 0.2 + Math.floor(i / 2) * 1.1;
        slide.addText(label, { x, y, w: 2.4, h: 0.2, fontSize: 8, bold: true, color: C.accent, fontFace: BODY, charSpacing: sp(3) });
        slide.addText(value, { x, y: y + 0.22, w: 2.4, h: 0.82, fontSize: 9.5, color: C.text, fontFace: BODY, valign: "top" });
      });

      // Strip closing the top band: rank, screen time, importance score (from the director's list)
      const bits = [
        character.rank ? `${L.rank} ${character.rank}` : "",
        character.screenTime ? `${L.screen}: ${character.screenTime}` : "",
        character.score ? `${L.score}: ${character.score}` : "",
      ].filter(Boolean);
      slide.addShape("rect", { x: 0, y: 2.3, w: 10, h: 0.3, fill: { color: C.deep } });
      slide.addText(up(bits.join("   ◆   ")), { x: 0.45, y: 2.3, w: 9.1, h: 0.3, fontSize: 9, bold: true, color: C.bg, fontFace: BODY, charSpacing: sp(3), fit: "shrink" });

      // Bottom: three casting choices, name only
      slide.addText(`${L.choices} ${up(displayName)}`, { x: 0.45, y: 2.68, w: 9.1, h: 0.28, fontSize: 11, bold: true, color: C.accent, fontFace: BODY, charSpacing: sp(4), fit: "shrink" });
      for (let i = 0; i < 3; i += 1) {
        const x = 0.45 + i * 3.1;
        slide.addShape("rect", { x, y: 3.0, w: 2.9, h: 2.45, fill: { color: C.card }, line: { color: C.line, width: 1 } });
        slide.addShape("rect", { x: x + 0.08, y: 3.08, w: 2.74, h: 1.85, fill: { color: C.bg }, line: { color: C.accent, dashType: "dash", width: 1 } });
        slide.addText(String(i + 1), { x, y: 3.25, w: 2.9, h: 1.0, align: "center", fontSize: 56, bold: true, color: C.line, fontFace: "Georgia" });
        slide.addText(L.photo, { x, y: 4.3, w: 2.9, h: 0.3, align: "center", fontSize: 10, italic: !isOdia, color: C.muted, fontFace: HEAD });
        slide.addText(L.name, { x: x + 0.12, y: 5.0, w: 0.75, h: 0.35, fontSize: 9, bold: true, color: C.accent, fontFace: BODY, charSpacing: sp(1), valign: "middle", wrap: false });
        slide.addShape("line", { x: x + 0.9, y: 5.3, w: 1.85, h: 0, line: { color: C.muted, width: 1 } });
      }
    }
  }

  return pptx.write({ outputType: "nodebuffer" });
}
