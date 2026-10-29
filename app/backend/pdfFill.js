// "Re-read a PDF into THIS project": the project already has its scene list (and maybe some written scenes). The PDF's written scenes are matched to
// the project's scenes and only the written text is filled in — the scene list itself is never changed. Pure functions, no database, easy to test.
//
// A PDF scene is put into a project scene only when we are SURE they are the same scene:
//   - same place (heading) — "INT. TEMPLE OFFICE - NIGHT" ≈ the project's INT + location + time, or
//   - the same position in a list that has the same number of scenes in the same episode, and the scene numbers agree.
// Everything else is listed as "not sure" and left alone. A project scene that is already written is skipped unless the writer asks to replace it.
import { headingParts, toAsciiDigits } from "./screenplayImport.js";
import { sceneState } from "./importAnalysis.js";

const pickText = (value) => (value && typeof value === "object" ? [value.en, value.or, value.hi].filter(Boolean) : [String(value ?? "")]);
const normPlace = (text) => String(text ?? "").toUpperCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const tokens = (text) => new Set(normPlace(text).split(" ").filter((t) => t.length > 1));

// is the PDF's place the same as one of the project's spellings of it?
export function samePlace(pdfLocation, projectLocation) {
  const a = normPlace(pdfLocation);
  if (!a) return false;
  for (const candidate of pickText(projectLocation)) {
    const b = normPlace(candidate);
    if (!b) continue;
    if (a === b || a.includes(b) || b.includes(a)) return true;
    const ta = tokens(a);
    const tb = tokens(b);
    const shared = [...ta].filter((t) => tb.has(t)).length;
    if (shared > 0 && shared / Math.max(ta.size, tb.size) >= 0.6) return true;
  }
  return false;
}

// "E2S5" / "12" / "5A" -> the scene's own number part ("5", "12", "5A")
export function numberKey(label) {
  const t = toAsciiDigits(String(label ?? "")).toUpperCase().trim();
  const m = /(\d+[A-Z]?)$/.exec(t);
  return m ? m[1] : "";
}

// projectEpisodes: [{ episodeIndex (null for a film), scenes: [outline] }]   (outline = a scene-list entry)
// pdfEpisodes:     parseEpisodesFromText(...).episodes
// writtenKeys:     Set of "episodeIndex:sceneIndex" strings of project scenes that already have written lines ("null:3" for a film)
export function planFill({ projectEpisodes, pdfEpisodes, writtenKeys = new Set(), replaceWritten = false }) {
  const warnings = [];
  const isFilm = projectEpisodes.length === 1 && projectEpisodes[0].episodeIndex === null;
  // which PDF scenes belong to which project episode
  const sources = new Map(); // episodeIndex|null -> pdf scenes[]
  if (isFilm) {
    sources.set(null, pdfEpisodes.flatMap((e) => e.scenes.map((s) => ({ ...s, pdfEpisode: e.number }))));
    if (pdfEpisodes.length > 1) warnings.push(`The PDF has ${pdfEpisodes.length} episodes but this project is a film: all its scenes are read as one list.`);
  } else {
    for (const e of pdfEpisodes) sources.set(e.number - 1, e.scenes.map((s) => ({ ...s, pdfEpisode: e.number })));
    const unknown = pdfEpisodes.filter((e) => !projectEpisodes.some((p) => p.episodeIndex === e.number - 1));
    if (unknown.length) warnings.push(`The PDF has episode${unknown.length > 1 ? "s" : ""} ${unknown.map((e) => e.number).join(", ")} that this project does not have; ${unknown.length > 1 ? "they were" : "it was"} not placed.`);
  }

  const items = []; // one per PDF scene
  for (const proj of projectEpisodes) {
    const pdfScenes = sources.get(proj.episodeIndex) ?? [];
    const sameCount = pdfScenes.length === proj.scenes.length;
    const taken = new Set();
    pdfScenes.forEach((pdf, pi) => {
      const state = sceneState(pdf).state;
      const base = { episodeIndex: proj.episodeIndex, pdfEpisode: pdf.pdfEpisode, pdfNumber: pdf.number, pdfHeading: pdf.heading, pdf, pdfState: state };
      if (state !== "written") { items.push({ ...base, action: "pdf_one_liner", why: "Only a one-line summary in the PDF — nothing to fill in." }); return; }
      // 1) a scene with the same number AND the same place; 2) the same place anywhere unused in this episode (only if it is unique); 3) same position + same count + same number
      const parts = headingParts(pdf.heading ?? "");
      const byNumber = proj.scenes.findIndex((o, i) => !taken.has(i) && numberKey(o.sceneNumber ?? i + 1) === numberKey(pdf.number) && samePlace(parts.location, o.location));
      let target = byNumber;
      let how = "same number and same place";
      if (target < 0) {
        const candidates = proj.scenes.map((o, i) => i).filter((i) => !taken.has(i) && samePlace(parts.location, proj.scenes[i].location) && proj.scenes[i].intExt === parts.intExt);
        const unusedPdfWithSamePlace = pdfScenes.filter((s, j) => j >= pi && samePlace(headingParts(s.heading ?? "").location, parts.location)).length;
        if (candidates.length === 1 && unusedPdfWithSamePlace === 1) { target = candidates[0]; how = "same place (only one such scene)"; }
      }
      if (target < 0 && sameCount && pi < proj.scenes.length && numberKey(proj.scenes[pi].sceneNumber ?? pi + 1) === numberKey(pdf.number) && !taken.has(pi)) {
        target = pi;
        how = "same position and number (the scene counts agree)";
      }
      if (target < 0) { items.push({ ...base, action: "not_sure", why: "I could not tell which scene of the project this is (no scene with the same number and place)." }); return; }
      taken.add(target);
      const written = writtenKeys.has(`${proj.episodeIndex}:${target}`);
      const outline = proj.scenes[target];
      const common = { ...base, sceneIndex: target, projectHeading: `${outline.intExt}. ${pickText(outline.location)[0]} - ${outline.timeOfDay}`, how };
      if (written && !replaceWritten) items.push({ ...common, action: "skip_written", why: "This scene is already written in the project — left as it is." });
      else items.push({ ...common, action: "fill", replaces: written, why: written ? "Will replace the written scene (the old version stays: ↶ Undo)." : "Will be filled in." });
    });
  }
  const count = (a) => items.filter((i) => i.action === a).length;
  return {
    items, warnings,
    counts: { fill: count("fill"), replace: items.filter((i) => i.action === "fill" && i.replaces).length, skipWritten: count("skip_written"), notSure: count("not_sure"), pdfOneLiner: count("pdf_one_liner"), pdfScenes: items.length },
  };
}
