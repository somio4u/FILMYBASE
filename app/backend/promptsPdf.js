// A PDF of every IMAGE command (prompt) of the film, ready to copy into any image generator:
//   Characters, Environments, Properties (one model-sheet prompt each) and Shots (one first-frame prompt each,
//   grouped by scene). Pure function: lists in, PDF bytes out — no database here.
import ScriptAwarePDF from "./mixedScriptPdf.js";

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

// assets: [{ kind, name, code, prompt, fileName, members? }]   shots: [{ sceneCode, sceneHeading, shotCode, description, prompt, fileName }]
// fileName is what the picture must be SAVED AS (no extension); it is what lets the app connect the picture when it is uploaded back.
export function buildPromptsPdf({ title, assets, shots, waitingShots = 0, aspectRatio = "16:9", style = "", references = [] }) {
  return new Promise((resolve, reject) => {
    const doc = new ScriptAwarePDF({ size: "A4", margin: 48, info: { Title: `${title} — image commands` } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const width = doc.page.width - 96;
    const ensure = (needed) => { if (doc.y + needed > doc.page.height - 56) doc.addPage(); };
    const heading = (text, size = 20) => { ensure(60); doc.moveDown(0.6).font("Helvetica-Bold").fontSize(size).fillColor("#111").text(text, { width }); };
    const note = (text) => { if (text) doc.font("Helvetica-Oblique").fontSize(10).fillColor("#555").text(text, { width }).moveDown(0.4); };
    const entry = (label, sub, prompt, { fileName = null, shape = null, members = null, attach = [] } = {}) => {
      const body = String(prompt ?? "").trim() || "(no command planned yet)";
      ensure(70 + Math.min(180, doc.heightOfString(body, { width: width - 14 })));
      doc.moveDown(0.5).font("Helvetica-Bold").fontSize(12).fillColor("#111").text(label, { width });
      if (sub) doc.font("Helvetica").fontSize(9.5).fillColor("#555").text(sub, { width });
      if (fileName) {
        doc.moveDown(0.1).font("Helvetica-Bold").fontSize(10).fillColor("#0b5").text(`SAVE THE PICTURE AS:  ${fileName}.png`, { width });
        if (shape) doc.font("Helvetica").fontSize(9).fillColor("#555").text(`Picture shape: ${shape}`, { width });
      }
      if (attach?.length) doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#a40").text(`ATTACH THESE REFERENCE IMAGES (real artwork, shown exactly as given): ${attach.join("; ")}`, { width });
      if (members?.length) doc.font("Helvetica").fontSize(9.5).fillColor("#333").text(`One picture, ${members.length} props in a grid (position 1 = top-left, left to right, top to bottom): ${members.map((m) => `${m.position} ${m.name}`).join(" · ")}`, { width });
      doc.moveDown(0.15).font("Courier").fontSize(9.5).fillColor("#000").text(body, { width: width - 14, indent: 14, lineGap: 1.5 });
    };

    doc.font("Helvetica-Bold").fontSize(30).fillColor("#111").text(title, { width });
    doc.font("Helvetica").fontSize(14).fillColor("#555").text("Image commands: characters, environments, properties and shots", { width });
    doc.moveDown(0.8);
    const counts = [...groupAssets(assets).map((s) => `${s.items.length} ${s.title.toLowerCase()}`), `${shots.length} shots`].join(" · ");
    doc.fontSize(11).fillColor("#333").text(counts, { width });
    if (waitingShots > 0) doc.moveDown(0.4).fontSize(10).fillColor("#a40").text(`${waitingShots} shot${waitingShots === 1 ? " is" : "s are"} not in this PDF yet: their shot division is not approved in the Storyboard Designer. Approve it, then download this PDF again.`, { width });
    if (style) doc.moveDown(0.4).fontSize(10).fillColor("#333").text(`Visual style of the film (already inside every command): ${style.slice(0, 160)}${style.length > 160 ? "…" : ""}`, { width });

    doc.moveDown(0.8).font("Helvetica-Bold").fontSize(13).fillColor("#111").text("How to use this PDF", { width });
    doc.font("Helvetica").fontSize(10.5).fillColor("#222").text([
      "1.  Copy a command into the image tool you like, and make the picture.",
      "2.  Save the picture EXACTLY under the name written under \"SAVE THE PICTURE AS\" (any format: PNG, JPG or WebP). Only the code at the start matters (CHAR001, LOC002, PGRP01, SC001_SH003), so a tool that adds \" (1)\" or its own ending is fine.",
      "3.  Make the characters, environments, properties and props sheets FIRST: the shot commands refer to them. When you make a shot, attach the sheets it names (for a props sheet the command says which POSITION on the sheet is meant) so faces, places and objects look the same in every shot.",
      "4.  In the app, open the Image Studio and press \"Import pictures I made elsewhere\". Choose all the pictures at once (or one .zip of them). Each picture is connected by its name to the right character, place, props sheet or shot, and waits for your review.",
    ].join("\n"), { width, lineGap: 3 });

    if (references.length > 0) {
      doc.moveDown(0.8).font("Helvetica-Bold").fontSize(13).fillColor("#111").text("Reference images to attach (real logos, brands, titles)", { width });
      doc.font("Helvetica").fontSize(10).fillColor("#222").text(references.map((r) => `${r.fileName}   —   ${r.label} (${r.kind})${r.keywords?.length ? `, also written as: ${r.keywords.join(", ")}` : ""}`).join("\n"), { width, lineGap: 2 });
      doc.fontSize(9.5).fillColor("#555").text("A command that needs one says “ATTACH THESE REFERENCE IMAGES”. Attach the picture to your image tool together with the command, so the real artwork is used instead of an invented one.", { width });
    }

    // the checklist: every file name on one page
    doc.addPage();
    heading("Checklist of file names", 20);
    note("Tick them off as you save each picture.");
    doc.font("Courier").fontSize(9.5).fillColor("#000");
    for (const section of groupAssets(assets)) {
      ensure(30);
      doc.moveDown(0.4).font("Helvetica-Bold").fontSize(11).fillColor("#111").text(section.title, { width });
      for (const a of section.items) { ensure(16); doc.font("Courier").fontSize(9.5).fillColor("#000").text(`[ ]  ${a.fileName ?? a.code}.png   —  ${a.name}`, { width }); }
    }
    if (shots.length > 0) {
      ensure(30);
      doc.moveDown(0.4).font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Shots", { width });
      for (const s of shots) { ensure(16); doc.font("Courier").fontSize(9.5).fillColor("#000").text(`[ ]  ${s.fileName ?? `${s.sceneCode}_${s.shotCode}`}.png`, { width }); }
    }

    for (const section of groupAssets(assets)) {
      doc.addPage();
      heading(section.title, 24);
      note(section.note);
      for (const a of section.items) entry(a.name || a.code, a.code, a.prompt, { fileName: a.fileName ?? a.code, shape: "16:9 (wide, so every view fits)", members: a.members, attach: a.attach });
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
        entry(`${s.sceneCode}_${s.shotCode}`, String(s.description ?? "").slice(0, 160), s.prompt, { fileName: s.fileName ?? `${s.sceneCode}_${s.shotCode}`, shape: aspectRatio, attach: s.attach });
      }
    }
    doc.end();
  });
}
