// THE SCRIPT PACKET FOR AN ARTIST. What an actor playing one character is sent:
//   1. who the character is (details), how the character changes over the story (the arc) and how the feeling rises and falls (the emotional graph)
//   2. EVERY scene the character is in, in full — the heading, the action lines, every character's dialogue — exactly as written, not only the artist's own lines,
//      so the artist understands what is going on in the scene itself.
//
// The scenes are cut out of the script by plain code (nothing is reworded, nothing is invented). Only the arc, the emotions and the objective of each scene
// come from the AI — one call per character — and if that call fails the packet is still sent, with the scenes in full and a note instead of the arc.
import { Type } from "@google/genai";
import { parseEpisodesFromText } from "./screenplayImport.js";
import { numberedHeadingsToPlain } from "./importAnalysis.js";

// ---- who is who -------------------------------------------------------------------------------------------------------------------------
// "BISWA BABU (V.O.)" / "Biswa babu" -> ["biswa", "babu"]
const nameTokens = (value) =>
  String(value ?? "")
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9ऀ-ॿ଀-୿]+/)
    .filter(Boolean);

// The cue of a speech and the name the artist's packet is for are the same person when the words match, or when one name is a part of the other
// ("BISWA" speaking for "Biswa Babu"). A name of fewer than 3 letters is never matched loosely, and different names never match (Anita ≠ Ankita).
export function sameCharacter(cue, label) {
  const a = nameTokens(cue);
  const b = nameTokens(label);
  if (a.length === 0 || b.length === 0) return false;
  if (a.join(" ") === b.join(" ")) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.join("").length >= 3 && short.every((token) => long.includes(token));
}

const wordIn = (text, label) => {
  const tokens = nameTokens(label).filter((t) => t.length >= 3);
  if (tokens.length === 0) return false;
  const words = nameTokens(text);
  return tokens.every((token) => words.includes(token)) || (tokens.length > 1 && words.includes(tokens[0]) && tokens[0].length >= 4);
};

// "speaks" | "present" (named in the action lines, silent) | null
export function presenceIn(scene, label) {
  if (scene.elements.some((e) => e.type === "dialogue" && sameCharacter(e.character, label))) return "speaks";
  if (scene.elements.some((e) => e.type !== "dialogue" && wordIn(e.text, label))) return "present";
  if (scene.characters?.some((name) => sameCharacter(name, label))) return "present";
  return null;
}

// ---- the scenes of the script, whole -----------------------------------------------------------------------------------------------------
const elementOf = (e) => ({ type: e.type === "dialogue" || e.type === "transition" || e.type === "flashback" ? e.type : "action", character: e.character ?? "", parenthetical: e.parenthetical ?? "", text: String(e.text ?? "") });

// the text of an imported screenplay -> scenes (null when no scene could be found: the caller then uses the older AI way)
export function scenesFromSourceText(sourceText) {
  const parsed = parseEpisodesFromText(numberedHeadingsToPlain(String(sourceText ?? "")));
  const episodes = parsed.episodes.filter((e) => e.scenes.length > 0);
  if (episodes.length === 0) return null;
  const isSeries = episodes.length > 1;
  return episodes.flatMap((episode) =>
    episode.scenes.map((scene) => ({
      episodeLabel: isSeries ? `Episode ${episode.number}` : null,
      sceneLabel: `Scene ${scene.number}`,
      heading: scene.heading ?? "",
      characters: scene.characters ?? [],
      elements: scene.elements.map(elementOf),
    }))
  );
}

const en = (value) => (value && typeof value === "object" ? value.en ?? "" : String(value ?? ""));

// the scenes written inside the app: the scene list says where and when, the written scene says what happens
export async function scenesFromWrittenScreenplay(db, sceneListId, sceneListContent) {
  const rows = (await db.query(
    `SELECT DISTINCT ON (episode_index, scene_index) episode_index, scene_index, content
     FROM screenplay_scenes WHERE scene_list_id = $1 ORDER BY episode_index, scene_index, created_at DESC`,
    [sceneListId]
  )).rows;
  if (rows.length === 0) return null;
  const isSeries = Boolean(sceneListContent?.episodeScenes);
  const outlineOf = (row) => (isSeries ? sceneListContent.episodeScenes?.[row.episode_index]?.scenes?.[row.scene_index] : sceneListContent?.scenes?.[row.scene_index]) ?? {};
  return rows.map((row) => {
    const outline = outlineOf(row);
    const heading = outline.intExt ? `${outline.intExt}. ${en(outline.location)} - ${outline.timeOfDay ?? ""}`.trim().replace(/\s*-\s*$/, "") : "";
    return {
      episodeLabel: isSeries ? `Episode ${row.episode_index + 1}` : null,
      sceneLabel: `Scene ${outline.sceneNumber ?? row.scene_index + 1}`,
      heading,
      characters: row.content?.charactersPresent ?? [],
      elements: (row.content?.elements ?? []).map(elementOf),
    };
  });
}

export const scenesWithCharacter = (scenes, label) =>
  scenes.map((scene) => ({ ...scene, presence: presenceIn(scene, label) })).filter((scene) => scene.presence);

export const sceneKey = (scene, index) => `${index + 1}`;

// ---- the AI part: details, arc, emotion per scene ----------------------------------------------------------------------------------------
const INSIGHT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    profile: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING }, age: { type: Type.STRING }, look: { type: Type.STRING }, relationships: { type: Type.STRING },
        want: { type: Type.STRING }, need: { type: Type.STRING }, flaw: { type: Type.STRING }, voice: { type: Type.STRING },
      },
      required: ["summary", "age", "look", "relationships", "want", "need", "flaw", "voice"],
    },
    arc: {
      type: Type.OBJECT,
      properties: { start: { type: Type.STRING }, turningPoints: { type: Type.ARRAY, items: { type: Type.STRING } }, end: { type: Type.STRING } },
      required: ["start", "turningPoints", "end"],
    },
    scenes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { key: { type: Type.STRING }, emotion: { type: Type.STRING }, intensity: { type: Type.INTEGER }, objective: { type: Type.STRING }, note: { type: Type.STRING } },
        required: ["key", "emotion", "intensity", "objective", "note"],
      },
    },
  },
  required: ["profile", "arc", "scenes"],
};

const LANGUAGE_NAME = { en: "English", or: "Odia (ଓଡ଼ିଆ)", hi: "Hindi (हिन्दी)" };
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1).trim()}…` : text);

// what the AI is shown of a scene: where, what happens (shortened) and what this character says
export function sceneDigest(scene, label, key) {
  const body = scene.elements.map((e) => (e.type === "dialogue" ? `${e.character}: ${e.text}` : e.text)).join(" / ");
  const own = scene.elements.filter((e) => e.type === "dialogue" && sameCharacter(e.character, label)).slice(0, 3).map((e) => e.text).join(" | ");
  return `[${key}] ${scene.episodeLabel ? `${scene.episodeLabel}, ` : ""}${scene.sceneLabel} — ${scene.heading || "(no heading)"}\n${clip(body, 700)}${own ? `\n${label} says: ${clip(own, 220)}` : "\n(silent in this scene)"}`;
}

// the character sheet entry for this name (story projects have one), as plain facts for the AI
export function sheetFacts(sheetContent, label) {
  const hit = (sheetContent?.characters ?? []).find((c) => sameCharacter(c.name, label));
  if (!hit) return "";
  const facts = [];
  for (const [field, name] of [["age", "age"], ["look", "look"], ["relationToHero", "relation to the hero"], ["archetype", "archetype"], ["role", "role"], ["want", "wants"], ["need", "needs"], ["flaw", "flaw"], ["innerConflict", "inner conflict"], ["outerConflict", "outer conflict"], ["arc", "arc"]]) {
    const value = en(hit[field]);
    if (value) facts.push(`${name}: ${value}`);
  }
  return facts.join("\n");
}

export function insightPrompt({ label, scenes, facts, lang }) {
  const digests = scenes.map((scene, i) => sceneDigest(scene, label, sceneKey(scene, i))).join("\n\n");
  return `You are preparing a briefing for the ACTOR who plays "${label}". Below are all the scenes this character is in, in story order, each with a key in [brackets].${facts ? `\n\nKnown facts about the character (from the writers' character sheet — use them, never contradict them):\n${facts}` : ""}

${digests}

Write, in ${LANGUAGE_NAME[lang] ?? "English"}:
- profile: who "${label}" is — a short summary, age (a number or range; "Unspecified" only if truly not inferable), look, relationships with the other characters, what the character WANTS (outer goal), NEEDS (inner truth), the FLAW, and how the character speaks (voice). Use only what the scenes and facts support; never invent backstory the material does not imply.
- arc: how the character CHANGES across the story — the starting point, 2 to 5 turning points (each one sentence, name the scene it happens in), and the end point.
- scenes: for EVERY key above exactly once — the emotion the character carries in that scene (one or two words), its intensity from 1 (calm) to 10 (the peak of the story), the character's objective in the scene (one sentence: what they are trying to get or do), and a one-sentence acting note on how it should feel.
Match each scene's emotion to what actually happens in it. The intensity must rise and fall with the story, not stay flat.`;
}

// the AI's answer, made safe: numbers inside 1–10, one entry per key
export function cleanInsights(raw, scenes) {
  const text = (v) => String(v ?? "").trim();
  const profile = {};
  for (const field of ["summary", "age", "look", "relationships", "want", "need", "flaw", "voice"]) profile[field] = text(raw?.profile?.[field]);
  const arc = { start: text(raw?.arc?.start), turningPoints: (raw?.arc?.turningPoints ?? []).map(text).filter(Boolean).slice(0, 6), end: text(raw?.arc?.end) };
  const byKey = new Map((raw?.scenes ?? []).map((s) => [text(s.key), s]));
  const perScene = scenes.map((scene, i) => {
    const hit = byKey.get(sceneKey(scene, i));
    const n = Math.round(Number(hit?.intensity));
    return { emotion: text(hit?.emotion), intensity: Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : null, objective: text(hit?.objective), note: text(hit?.note) };
  });
  return { profile, arc, perScene };
}

const cache = new Map(); // short-lived: the same packet opened again (a WhatsApp link opened twice) does not ask the AI again
const CACHE_MINUTES = 30;

// the whole packet. `askModel(contents, schema)` returns the AI's JSON; `sheetContent` is the project's character sheet (or null)
export async function buildCharacterPacket({ scenes, label, lang = "en", sheetContent = null, askModel, now = Date.now() }) {
  const mine = scenesWithCharacter(scenes, label);
  const packet = { character: label, lang, scenes: mine, insights: null, note: "" };
  if (mine.length === 0) return packet;
  const facts = sheetFacts(sheetContent, label);
  const cacheKey = JSON.stringify([label, lang, facts, mine.map((s, i) => sceneDigest(s, label, sceneKey(s, i)))]);
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < CACHE_MINUTES * 60 * 1000) return { ...packet, insights: hit.insights };
  try {
    const raw = await askModel(insightPrompt({ label, scenes: mine, facts, lang }), INSIGHT_SCHEMA);
    packet.insights = cleanInsights(raw, mine);
    cache.set(cacheKey, { at: now, insights: packet.insights });
  } catch (error) {
    console.error("Character packet: the AI part (details, arc, emotions) failed:", error.message);
    packet.note = "The character details, arc and emotional graph could not be prepared this time. The scenes below are complete.";
  }
  return packet;
}

// ---- the words on the page --------------------------------------------------------------------------------------------------------------
export const PACKET_LABELS = {
  en: { title: "CHARACTER SCRIPT", details: "Character details", arc: "Character arc", graph: "Emotional graph", scenes: "The scenes", summary: "Who", age: "Age", look: "Look", relationships: "Relationships", want: "Wants", need: "Needs", flaw: "Flaw", voice: "Voice", start: "Starts as", turning: "Turning points", end: "Ends as", emotion: "Emotion", intensity: "Intensity", objective: "Objective", note: "Acting note", scene: "Scene", noScenes: "No scenes were found for this character.", silent: "(in the scene, no lines)", yourLines: "your lines in bold", intensityAxis: "Scenes in story order — higher means a stronger feeling (1–10)" },
  or: { title: "CHARACTER SCRIPT", details: "ଚରିତ୍ର ବିବରଣୀ", arc: "ଚରିତ୍ରର ଆର୍କ", graph: "ଭାବନାର ଗ୍ରାଫ୍", scenes: "ଦୃଶ୍ୟଗୁଡ଼ିକ", summary: "କିଏ", age: "ବୟସ", look: "ରୂପ", relationships: "ସମ୍ପର୍କ", want: "ଚାହେଁ", need: "ଆବଶ୍ୟକ", flaw: "ଦୁର୍ବଳତା", voice: "କଥାବାର୍ତ୍ତା", start: "ଆରମ୍ଭରେ", turning: "ମୋଡ଼", end: "ଶେଷରେ", emotion: "ଭାବନା", intensity: "ତୀବ୍ରତା", objective: "ଲକ୍ଷ୍ୟ", note: "ଅଭିନୟ ଟିପ୍ପଣୀ", scene: "ଦୃଶ୍ୟ", noScenes: "ଏହି ଚରିତ୍ର ପାଇଁ କୌଣସି ଦୃଶ୍ୟ ମିଳିଲା ନାହିଁ।", silent: "(ଦୃଶ୍ୟରେ ଅଛି, ସଂଳାପ ନାହିଁ)", yourLines: "ତୁମ ସଂଳାପ ମୋଟା ଅକ୍ଷରରେ", intensityAxis: "ଦୃଶ୍ୟ କାହାଣୀ କ୍ରମରେ — ଉପରକୁ ମାନେ ଅଧିକ ତୀବ୍ର ଭାବନା (୧–୧୦)" },
  hi: { title: "CHARACTER SCRIPT", details: "किरदार का विवरण", arc: "किरदार का आर्क", graph: "भावनाओं का ग्राफ़", scenes: "दृश्य", summary: "कौन", age: "उम्र", look: "रूप-रंग", relationships: "रिश्ते", want: "चाहता है", need: "ज़रूरत", flaw: "कमज़ोरी", voice: "बोलने का ढंग", start: "शुरुआत में", turning: "मोड़", end: "अंत में", emotion: "भावना", intensity: "तीव्रता", objective: "लक्ष्य", note: "अभिनय टिप्पणी", scene: "दृश्य", noScenes: "इस किरदार के लिए कोई दृश्य नहीं मिला।", silent: "(दृश्य में है, संवाद नहीं)", yourLines: "आपके संवाद मोटे अक्षरों में", intensityAxis: "दृश्य कहानी के क्रम में — ऊपर यानी ज़्यादा तीव्र भावना (1–10)" },
};

const sceneTitle = (scene) => `${scene.episodeLabel ? `${scene.episodeLabel}, ` : ""}${scene.sceneLabel}`;

// ---- the PDF ------------------------------------------------------------------------------------------------------------------------------
// the line chart of the emotional graph: one point per scene (those with a number), 1–10 up the side, the scene numbers along the bottom
export function drawEmotionChart(doc, points, { x, y, width, height, label }) {
  const left = x + 26;
  const top = y + 4;
  const chartW = width - 34;
  const chartH = height - 28;
  doc.save();
  doc.lineWidth(0.5).strokeColor("#bbbbbb");
  for (const level of [1, 5, 10]) {
    const gy = top + chartH - ((level - 1) / 9) * chartH;
    doc.moveTo(left, gy).lineTo(left + chartW, gy).stroke();
    doc.font("Helvetica").fontSize(8).fillColor("#666666").text(String(level), x, gy - 4, { width: 20, align: "right", lineBreak: false });
  }
  const step = points.length > 1 ? chartW / (points.length - 1) : 0;
  const at = (i) => ({ px: points.length > 1 ? left + i * step : left + chartW / 2, py: top + chartH - (((points[i].intensity ?? 1) - 1) / 9) * chartH });
  doc.lineWidth(1.6).strokeColor("#b23a48");
  let started = false;
  points.forEach((p, i) => {
    if (p.intensity == null) return;
    const { px, py } = at(i);
    if (!started) { doc.moveTo(px, py); started = true; } else doc.lineTo(px, py);
  });
  if (started) doc.stroke();
  const every = Math.max(1, Math.ceil(points.length / 14));
  points.forEach((p, i) => {
    if (p.intensity != null) { const { px, py } = at(i); doc.circle(px, py, 2.6).fillColor("#b23a48").fill(); }
    if (i % every === 0) doc.font("Helvetica").fontSize(7.5).fillColor("#444444").text(p.label, at(i).px - 14, top + chartH + 5, { width: 28, align: "center", lineBreak: false });
  });
  doc.font("Helvetica").fontSize(8).fillColor("#666666").text(label, left, top + chartH + 16, { width: chartW, align: "center", lineBreak: false });
  doc.restore();
  doc.fillColor("#000000");
}

// `doc` is a ScriptAwarePDF; the caller pipes it and calls doc.end() afterwards.
export function writeCharacterPacketPdf(doc, packet) {
  const L = PACKET_LABELS[packet.lang] ?? PACKET_LABELS.en;
  const margin = doc.page.margins.left;
  const width = doc.page.width - margin * 2;
  const heading = (text) => { doc.moveDown(0.8); doc.font("Helvetica-Bold").fontSize(14).fillColor("#000").text(text, margin, doc.y, { width }); doc.moveDown(0.3); };
  const room = (needed) => { if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage(); };
  const field = (name, value) => {
    if (!value) return;
    room(30);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#000").text(`${name}: `, margin, doc.y, { width, continued: true });
    doc.font("Helvetica").fontSize(11).text(value);
    doc.moveDown(0.25);
  };

  doc.font("Helvetica-Bold").fontSize(20).fillColor("#000").text(`${L.title} — ${packet.character}`, margin, doc.y, { width });

  if (packet.scenes.length === 0) {
    doc.moveDown(1);
    doc.font("Helvetica").fontSize(12).text(L.noScenes, margin, doc.y, { width });
    return;
  }
  if (packet.note) { doc.moveDown(0.6); doc.font("Helvetica-Oblique").fontSize(10).fillColor("#8a5a00").text(packet.note, margin, doc.y, { width }); doc.fillColor("#000"); }

  const insights = packet.insights;
  if (insights) {
    const p = insights.profile;
    heading(L.details);
    field(L.summary, p.summary); field(L.age, p.age); field(L.look, p.look); field(L.relationships, p.relationships);
    field(L.want, p.want); field(L.need, p.need); field(L.flaw, p.flaw); field(L.voice, p.voice);

    heading(L.arc);
    field(L.start, insights.arc.start);
    if (insights.arc.turningPoints.length) {
      room(20);
      doc.font("Helvetica-Bold").fontSize(11).text(`${L.turning}:`, margin, doc.y, { width });
      insights.arc.turningPoints.forEach((point, i) => { room(20); doc.font("Helvetica").fontSize(11).text(`${i + 1}. ${point}`, margin + 12, doc.y, { width: width - 12 }); });
      doc.moveDown(0.25);
    }
    field(L.end, insights.arc.end);

    heading(L.graph);
    const points = packet.scenes.map((scene, i) => ({ label: String(scene.sceneLabel).replace(/^\D*/, "") || String(i + 1), intensity: insights.perScene[i].intensity }));
    if (points.some((pt) => pt.intensity != null)) {
      room(170);
      drawEmotionChart(doc, points, { x: margin, y: doc.y, width, height: 150, label: L.intensityAxis });
      doc.y += 156;
    }
    packet.scenes.forEach((scene, i) => {
      const s = insights.perScene[i];
      if (!s.emotion && s.intensity == null) return;
      room(18);
      doc.font("Helvetica").fontSize(10).fillColor("#333").text(`${sceneTitle(scene)}: ${s.emotion || "—"}${s.intensity != null ? `  (${s.intensity}/10)` : ""}`, margin, doc.y, { width });
    });
    doc.fillColor("#000");
  }

  doc.addPage();
  doc.font("Helvetica-Bold").fontSize(14).text(L.scenes, margin, doc.y, { width });
  doc.font("Helvetica-Oblique").fontSize(9).fillColor("#666").text(L.yourLines, margin, doc.y, { width });
  doc.fillColor("#000");

  packet.scenes.forEach((scene, i) => {
    const s = insights?.perScene[i];
    room(90);
    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#000").text(`${sceneTitle(scene)}${scene.heading ? ` — ${scene.heading}` : ""}`, margin, doc.y, { width });
    if (s && (s.emotion || s.objective)) {
      doc.font("Helvetica-Oblique").fontSize(10).fillColor("#b23a48").text(
        [s.emotion ? `${L.emotion}: ${s.emotion}${s.intensity != null ? ` (${s.intensity}/10)` : ""}` : "", s.objective ? `${L.objective}: ${s.objective}` : "", s.note ? `${L.note}: ${s.note}` : ""].filter(Boolean).join("   ·   "),
        margin, doc.y, { width }
      );
      doc.fillColor("#000");
    }
    doc.moveDown(0.4);
    if (scene.presence === "present" && !scene.elements.some((e) => e.type === "dialogue" && sameCharacter(e.character, packet.character))) {
      doc.font("Helvetica-Oblique").fontSize(10).fillColor("#666").text(L.silent, margin, doc.y, { width });
      doc.fillColor("#000");
      doc.moveDown(0.3);
    }
    for (const e of scene.elements) {
      room(30);
      if (e.type === "dialogue") {
        const mine = sameCharacter(e.character, packet.character);
        doc.font(mine ? "Helvetica-Bold" : "Helvetica").fontSize(11).fillColor("#000").text(String(e.character).toUpperCase(), margin + 70, doc.y, { width: width - 70 });
        doc.font(mine ? "Helvetica-Bold" : "Helvetica").fontSize(11).text(`${e.parenthetical ? `(${e.parenthetical}) ` : ""}${e.text}`, margin + 40, doc.y, { width: width - 40 });
        doc.moveDown(0.5);
      } else if (e.type === "transition") {
        doc.font("Helvetica").fontSize(10).fillColor("#555").text(e.text, margin, doc.y, { width, align: "right" });
        doc.fillColor("#000");
        doc.moveDown(0.4);
      } else {
        doc.font("Helvetica").fontSize(11).fillColor("#222").text(e.type === "flashback" ? `FLASH - ${e.character}'S POV: ${e.text}` : e.text, margin, doc.y, { width });
        doc.fillColor("#000");
        doc.moveDown(0.5);
      }
    }
  });
}

// ---- the Excel file ------------------------------------------------------------------------------------------------------------------------
// three sheets: the character (details + arc), the emotional graph as a table, and the scenes in full (one scene per row)
export function writeCharacterPacketExcel(workbook, packet) {
  const L = PACKET_LABELS[packet.lang] ?? PACKET_LABELS.en;
  const insights = packet.insights;
  const wrap = (row, ...keys) => keys.forEach((k) => { row.getCell(k).alignment = { wrapText: true, vertical: "top" }; });

  const details = workbook.addWorksheet(L.details.slice(0, 31));
  details.columns = [{ header: "", key: "name", width: 20 }, { header: packet.character, key: "value", width: 90 }];
  details.getRow(1).font = { bold: true };
  if (insights) {
    const p = insights.profile;
    const rows = [[L.summary, p.summary], [L.age, p.age], [L.look, p.look], [L.relationships, p.relationships], [L.want, p.want], [L.need, p.need], [L.flaw, p.flaw], [L.voice, p.voice],
      [L.start, insights.arc.start], ...insights.arc.turningPoints.map((t, i) => [i === 0 ? L.turning : "", `${i + 1}. ${t}`]), [L.end, insights.arc.end]];
    rows.filter(([, v]) => v).forEach(([name, value]) => { const row = details.addRow({ name, value }); row.getCell("name").font = { bold: true }; wrap(row, "value"); });
  } else if (packet.note) details.addRow({ name: "", value: packet.note });

  const graph = workbook.addWorksheet(L.graph.slice(0, 31));
  graph.columns = [{ header: L.scene, key: "scene", width: 18 }, { header: L.emotion, key: "emotion", width: 22 }, { header: L.intensity, key: "intensity", width: 12 }, { header: L.objective, key: "objective", width: 50 }, { header: L.note, key: "note", width: 50 }];
  graph.getRow(1).font = { bold: true };
  packet.scenes.forEach((scene, i) => {
    const s = insights?.perScene[i];
    wrap(graph.addRow({ scene: sceneTitle(scene), emotion: s?.emotion ?? "", intensity: s?.intensity ?? "", objective: s?.objective ?? "", note: s?.note ?? "" }), "objective", "note");
  });

  const sheet = workbook.addWorksheet(L.scenes.slice(0, 31));
  sheet.columns = [{ header: L.scene, key: "scene", width: 18 }, { header: "", key: "heading", width: 34 }, { header: "", key: "content", width: 100 }];
  sheet.getRow(1).font = { bold: true };
  packet.scenes.forEach((scene) => {
    const content = scene.elements.map((e) => (e.type === "dialogue" ? `${String(e.character).toUpperCase()}: ${e.parenthetical ? `(${e.parenthetical}) ` : ""}${e.text}` : e.text)).join("\n");
    wrap(sheet.addRow({ scene: sceneTitle(scene), heading: scene.heading, content }), "content", "heading");
  });
}
