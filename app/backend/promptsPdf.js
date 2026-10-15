// A PDF of every IMAGE command (prompt) of the film, ready to copy into any image generator:
//   Characters, Environments, Properties (one model-sheet prompt each) and Shots (one first-frame prompt each,
//   grouped by scene). Pure function: lists in, PDF bytes out — no database here.
import PDFDocument from "pdfkit";

const SECTIONS = [
  { key: "character", title: "Characters", note: "One reference sheet per character. Generate these first, then reuse them so the face and costume stay the same in every shot." },
  { key: "location", title: "Environments", note: "One reference picture per place. Reuse it for every shot that happens there." },
  { key: "prop", title: "Properties", note: "One reference picture per important object." },
];

export function groupAssets(assets) {
  const known = new Set(SECTIONS.map((s) => s.key));
  return [
    ...SECTIONS.map((s) => ({ ...s, items: assets.filter((a) => a.kind === s.key) })),
    { key: "other", title: "Other", note: "", items: assets.filter((a) => !known.has(a.kind)) },
  ].filter((s) => s.items.length > 0);
}

// assets: [{ kind, name, code, prompt }]   shots: [{ sceneCode, sceneHeading, shotCode, description, prompt }]
export function buildPromptsPdf({ title, assets, shots }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `${title} — image commands` } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const width = doc.page.width - 96;
    const ensure = (needed) => { if (doc.y + needed > doc.page.height - 56) doc.addPage(); };
    const heading = (text, size = 20) => { ensure(60); doc.moveDown(0.6).font("Helvetica-Bold").fontSize(size).fillColor("#111").text(text, { width }); };
    const note = (text) => { if (text) doc.font("Helvetica-Oblique").fontSize(10).fillColor("#555").text(text, { width }).moveDown(0.4); };
    const entry = (label, sub, prompt) => {
      const body = String(prompt ?? "").trim() || "(no command planned yet)";
      ensure(40 + Math.min(180, doc.heightOfString(body, { width: width - 14 })));
      doc.moveDown(0.5).font("Helvetica-Bold").fontSize(12).fillColor("#111").text(label, { width });
      if (sub) doc.font("Helvetica").fontSize(9.5).fillColor("#555").text(sub, { width });
      doc.moveDown(0.15).font("Courier").fontSize(9.5).fillColor("#000").text(body, { width: width - 14, indent: 14, lineGap: 1.5 });
    };

    doc.font("Helvetica-Bold").fontSize(30).fillColor("#111").text(title, { width });
    doc.font("Helvetica").fontSize(14).fillColor("#555").text("Image commands: characters, environments, properties and shots", { width });
    doc.moveDown(0.8);
    const counts = [...groupAssets(assets).map((s) => `${s.items.length} ${s.title.toLowerCase()}`), `${shots.length} shots`].join(" · ");
    doc.fontSize(11).fillColor("#333").text(counts, { width });
    doc.fontSize(10).fillColor("#555").text("Copy each command into your image generator. Characters, environments and properties come first; the shot commands refer to them.", { width });

    for (const section of groupAssets(assets)) {
      doc.addPage();
      heading(section.title, 24);
      note(section.note);
      for (const a of section.items) entry(a.name || a.code, a.code, a.prompt);
    }

    if (shots.length > 0) {
      doc.addPage();
      heading("Shots", 24);
      note("One first-frame picture per shot — the starting image of that shot.");
      let scene = null;
      for (const s of shots) {
        if (s.sceneCode !== scene) {
          scene = s.sceneCode;
          heading(`Scene ${s.sceneCode}${s.sceneHeading ? ` — ${s.sceneHeading}` : ""}`, 14);
        }
        entry(`${s.sceneCode}_${s.shotCode}`, String(s.description ?? "").slice(0, 160), s.prompt);
      }
    }
    doc.end();
  });
}
