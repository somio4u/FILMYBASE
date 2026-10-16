// Language Checker & Converter for AI Movie (Odia / Hindi / English screenplay), plus the microphone-to-screenplay
// route (Voice Writer). The translator itself is the Film module's (translateScreenplaySceneElements, passed in) — this
// file adds the AI Movie wiring, the validation, the spoken-language check and the storage:
//   * AI Movie scenes already carry English + Hindi side by side; Odia is added here as a stored conversion per scene,
//     tied to the exact English text it was made from (so an edited scene marks its conversion out of date).
//   * Every conversion is validated (same blocks, same speakers, really in the target script) and, if a piece fails,
//     that piece is retried once; whatever still fails is reported, never hidden.
//   * Odia and Hindi get a second "spoken language" pass (everyday spoken words, not bookish ones).
//   * Money: every call is checked against the project's limit first and written to the spend ledger.

import { applyVoiceEdits, changeTotal } from "./voiceEdits.js";
import crypto from "node:crypto";
import { assertWithinBudget, recordSpend } from "./pipelineSettings.js";
import { estimateCost } from "./modelRouting.js";

export const LANGUAGES = { en: "English", hi: "Hindi (Devanagari)", or: "Odia (Odia script)" };
const SCRIPT = { or: /[଀-୿]/g, hi: /[ऀ-ॿ]/g };
const httpError = (message, status = 400, code = null) => Object.assign(new Error(message), { status, code });
const sha = (text) => crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 32);

export async function ensureAiMovieLanguageSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_movie_screenplay_translations (
    project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
    scene_key TEXT NOT NULL,
    language TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    content JSONB NOT NULL,
    issues JSONB NOT NULL DEFAULT '[]',
    spoken_checked BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, scene_key, language)
  )`);
}

const letters = (text) => (String(text).match(/\p{L}/gu) ?? []).length;
const inScript = (text, language) => (String(text).match(SCRIPT[language] ?? /$^/g) ?? []).length;

// The words that must stay as they are: CAPITAL Latin names/cues (a speaker's name, "V.O.").
const isName = (text) => /^[A-Z0-9 .'()-]+$/.test(String(text).trim());

// Pure check of a conversion against its source. Returns a list of { index, problem }.
export function validateConversion(source, converted, language) {
  const issues = [];
  if (!Array.isArray(converted) || converted.length !== source.length) {
    return [{ index: -1, problem: `Expected ${source.length} blocks but got ${Array.isArray(converted) ? converted.length : 0}.` }];
  }
  source.forEach((s, i) => {
    const c = converted[i];
    if (!c || c.type !== s.type) { issues.push({ index: i, problem: "The block type changed." }); return; }
    if (s.type === "transition") return;
    if (s.type === "dialogue" && String(c.character ?? "").trim().toUpperCase() !== String(s.character ?? "").trim().toUpperCase()) issues.push({ index: i, problem: `The speaker name changed from ${s.character} to ${c.character}.` });
    const text = String(c.text ?? "");
    if (String(s.text ?? "").trim() && !text.trim()) { issues.push({ index: i, problem: "This line came back empty." }); return; }
    if (language === "en") {
      if (/[ऀ-୿]/.test(text)) issues.push({ index: i, problem: "English text still contains Hindi/Odia letters." });
    } else if (SCRIPT[language] && !isName(s.text)) {
      const total = letters(text);
      if (total > 0 && inScript(text, language) / total < 0.3) issues.push({ index: i, problem: `This line does not look like ${LANGUAGES[language]} — it is mostly English letters.` });
    }
  });
  return issues;
}

const SPOKEN_SYSTEM = (language) => `You are a native ${LANGUAGES[language]} script supervisor. You make dialogue and action lines sound like real everyday spoken language — never bookish, never Sanskritized, never a word-for-word translation. You change as little as possible: only words or phrasing that a person would not really say.`;

export function registerAiMovieLanguageRoutes(app, db, requireRole, deps) {
  // deps: translateElements(elements, "en", target) -> elements (Film's translator; elements are {type, character, parenthetical, text}),
  //       getSceneBlocks(projectId) -> [{ key, beatIndex, sceneIndex, heading, blocks, hash }],
  //       ask(projectId, agentId, params) -> { data } (routed + budgeted), spokenRule (text),
  //       voiceToElements({ audioBase64, mimeType, liveText, sceneOutline, existingElements, dialogueLanguage, defaultInsertAfter }) -> { transcript, elements, insertAfter, note }
  const admin = requireRole("admin");
  const id = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error("AI Movie language route failed:", error);
      res.status(status).json({ error: status >= 500 && !error.status ? "Something went wrong on the server." : error.message, code: error.code ?? null });
    }
  };
  const projectOf = async (req) => {
    const projectId = id(req.params.id);
    if (!projectId) throw httpError("Not a valid project.", 400);
    if ((await db.query("SELECT 1 FROM ai_movie_projects WHERE id = $1", [projectId])).rowCount === 0) throw httpError("Project not found.", 404);
    return projectId;
  };
  const textOf = (blocks) => blocks.map((b) => `${b.character ?? ""} ${b.text ?? ""}`).join("\n");

  async function convertOne(projectId, scene, language) {
    const source = scene.blocks;
    const pieces = source.filter((b) => b.type !== "transition").length;
    await assertWithinBudget(db, projectId, estimateCost("flashLite", 2) + (language === "en" ? 0 : estimateCost("flash", 1)));
    let converted = await deps.translateElements(source, "en", language);
    let issues = validateConversion(source, converted, language);
    let spent = estimateCost("flashLite", 1);
    if (issues.length > 0 && issues[0].index !== -1) {
      // Retry only the pieces that failed, once.
      const again = await deps.translateElements(source, "en", language);
      spent += estimateCost("flashLite", 1);
      const merged = converted.map((c, i) => (issues.some((x) => x.index === i) && again[i] ? again[i] : c));
      const secondIssues = validateConversion(source, merged, language);
      if (secondIssues.length <= issues.length) { converted = merged; issues = secondIssues; }
    }
    let spokenChecked = false;
    if (issues.length === 0 && language !== "en") {
      try {
        const lines = converted.map((b, i) => ({ i, type: b.type, text: b.text })).filter((b) => b.type !== "transition");
        const { data } = await deps.ask(projectId, "language-checker", {
          systemInstruction: SPOKEN_SYSTEM(language),
          contents: `${deps.spokenRule ?? ""}\n\nHere are the lines of one scene in ${LANGUAGES[language]}. Return each line again, same order, same count, corrected ONLY where it sounds bookish, stiff or unnatural for everyday speech. Keep names, meaning and the script (${LANGUAGES[language]}). If a line is already natural, return it unchanged.\n\n${JSON.stringify(lines.map((l) => l.text))}`,
          responseSchema: { type: "OBJECT", properties: { lines: { type: "ARRAY", items: { type: "STRING" } } }, required: ["lines"] },
          maxOutputTokens: 8192,
        });
        if (Array.isArray(data.lines) && data.lines.length === lines.length && data.lines.every((t) => String(t).trim())) {
          const next = converted.map((b) => ({ ...b }));
          lines.forEach((l, k) => { next[l.i].text = String(data.lines[k]).trim(); });
          if (validateConversion(source, next, language).length === 0) { converted = next; spokenChecked = true; }
        }
      } catch (error) {
        if (error.status === 402) throw error;
        console.error("Spoken-language check skipped:", error.message);
      }
    }
    await recordSpend(db, projectId, { kind: "text", provider: "Gemini 2.5 Flash-Lite (language)", units: 1, costUsd: spent, ref: `language:${language}:${scene.key}` });
    await db.query(
      `INSERT INTO ai_movie_screenplay_translations (project_id, scene_key, language, source_hash, content, issues, spoken_checked) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (project_id, scene_key, language) DO UPDATE SET source_hash = EXCLUDED.source_hash, content = EXCLUDED.content, issues = EXCLUDED.issues, spoken_checked = EXCLUDED.spoken_checked, updated_at = now()`,
      [projectId, scene.key, language, sha(textOf(source)), JSON.stringify({ heading: scene.heading, blocks: converted }), JSON.stringify(issues), spokenChecked]
    );
    return { key: scene.key, issues, spokenChecked };
  }

  app.get("/api/ai-movie/projects/:id/language", admin, wrap(async (req, res) => {
    const projectId = await projectOf(req);
    const scenes = await deps.getSceneBlocks(projectId);
    const current = new Map(scenes.map((s) => [s.key, sha(textOf(s.blocks))]));
    const rows = (await db.query("SELECT scene_key, language, source_hash, issues, spoken_checked, updated_at FROM ai_movie_screenplay_translations WHERE project_id = $1", [projectId])).rows;
    res.json({
      languages: Object.entries(LANGUAGES).map(([key, label]) => ({ key, label })),
      sceneCount: scenes.length,
      conversions: rows.map((r) => ({ sceneKey: r.scene_key, language: r.language, outOfDate: current.get(r.scene_key) !== r.source_hash, issues: r.issues, spokenChecked: r.spoken_checked, updatedAt: r.updated_at })),
    });
  }));

  // scope: "scene" (beatIndex + sceneIndex), "beat" (beatIndex) or "all". Hindi and English already exist inside every AI Movie scene;
  // converting to them just reports that. Odia is made here.
  app.post("/api/ai-movie/projects/:id/language/convert", admin, wrap(async (req, res) => {
    const projectId = await projectOf(req);
    const language = String(req.body?.language ?? "");
    if (!LANGUAGES[language]) throw httpError(`Language must be one of ${Object.keys(LANGUAGES).join(", ")}.`, 400);
    const scope = req.body?.scope ?? "all";
    let scenes = await deps.getSceneBlocks(projectId);
    if (scope === "scene") scenes = scenes.filter((s) => s.beatIndex === Number(req.body.beatIndex) && s.sceneIndex === Number(req.body.sceneIndex));
    else if (scope === "beat") scenes = scenes.filter((s) => s.beatIndex === Number(req.body.beatIndex));
    else if (scope !== "all") throw httpError('Scope must be "scene", "beat" or "all".', 400);
    if (scenes.length === 0) throw httpError("There are no written scenes to convert.", 400);
    if (language === "hi" || language === "en") {
      res.json({ language, converted: 0, alreadyInside: true, note: `Every AI Movie scene already carries a ${language === "hi" ? "Hindi" : "English"} version next to the other — switch the screenplay language at the top of the screen. No AI call was made.` });
      return;
    }
    const done = [];
    for (const scene of scenes) {
      try {
        done.push(await convertOne(projectId, scene, language));
      } catch (error) {
        if (error.status === 402) { done.push({ key: scene.key, stopped: "money_limit", error: error.message }); break; }
        done.push({ key: scene.key, error: error.message });
      }
    }
    res.json({
      language, converted: done.filter((d) => !d.error).length, withIssues: done.filter((d) => d.issues?.length).length,
      stoppedByMoneyLimit: done.some((d) => d.stopped === "money_limit"), results: done,
    });
  }));

  // The converted screenplay as plain text (or JSON). Scenes whose English changed after the conversion are marked out of date.
  app.get("/api/ai-movie/projects/:id/language/export", admin, wrap(async (req, res) => {
    const projectId = await projectOf(req);
    const language = String(req.query.language ?? "or");
    if (!LANGUAGES[language]) throw httpError("Unknown language.", 400);
    const scenes = await deps.getSceneBlocks(projectId);
    const rows = new Map((await db.query("SELECT scene_key, source_hash, content FROM ai_movie_screenplay_translations WHERE project_id = $1 AND language = $2", [projectId, language])).rows.map((r) => [r.scene_key, r]));
    const out = [];
    for (const s of scenes) {
      const row = rows.get(s.key);
      const stale = Boolean(row) && row.source_hash !== sha(textOf(s.blocks));
      if (language === "en") out.push({ key: s.key, heading: s.heading, blocks: s.blocks, outOfDate: false });
      else if (row) out.push({ key: s.key, heading: row.content.heading, blocks: row.content.blocks, outOfDate: stale });
      else out.push({ key: s.key, heading: s.heading, blocks: null, outOfDate: false, missing: true });
    }
    if (req.query.format === "json") { res.json({ language, scenes: out }); return; }
    const text = out.map((s) => `${s.heading}${s.outOfDate ? "   [OUT OF DATE — the English scene changed; convert it again]" : ""}\n\n${s.blocks ? s.blocks.map((b) => (b.type === "dialogue" ? `        ${b.character}${b.parenthetical ? ` (${b.parenthetical})` : ""}\n    ${b.text}` : b.type === "transition" ? `                                ${b.text ?? ""}` : b.text)).join("\n\n") : "[not converted yet]"}`).join("\n\n\n");
    res.type("text/plain; charset=utf-8").send(text);
  }));

  // Speak Here / Voice Writer: a voice note becomes screenplay lines for the scene editor's DRAFT (nothing is saved until the writer submits).
  app.post("/api/ai-movie/projects/:id/scene/voice", admin, wrap(async (req, res) => {
    const projectId = await projectOf(req);
    const mimeType = String(req.body?.mimeType ?? "").split(";")[0].trim().toLowerCase();
    const audioBase64 = String(req.body?.audio ?? "");
    const instructionText = String(req.body?.instruction ?? "").trim().slice(0, 4000);
    if (!instructionText && (!["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/aac", "audio/m4a"].includes(mimeType) || audioBase64.length < 200)) throw httpError("No recording came through — try speaking again.", 400);
    const scenes = await deps.getSceneBlocks(projectId);
    const scene = scenes.find((s) => s.beatIndex === Number(req.body?.beatIndex) && s.sceneIndex === Number(req.body?.sceneIndex));
    if (!scene) throw httpError("That scene doesn't exist.", 400);
    await assertWithinBudget(db, projectId, estimateCost("flash", 1));
    const existing = Array.isArray(req.body?.draftBlocks)
      ? req.body.draftBlocks.slice(0, 500).map((b) => ({ type: String(b?.type ?? "action"), character: String(b?.character ?? ""), parenthetical: String(b?.parenthetical ?? ""), text: String(b?.text ?? "") }))
      : scene.blocks;
    const voice = await deps.voiceToElements({
      audioBase64, mimeType, instructionText: instructionText || null, liveText: String(req.body?.liveText ?? "").slice(0, 2000), sceneOutline: scene.heading, existingElements: existing,
      dialogueLanguage: ["en", "hi", "or"].includes(req.body?.language) ? req.body.language : "en",
      defaultInsertAfter: Number.isInteger(req.body?.cursorAfter) ? req.body.cursorAfter : undefined,
      allowSceneActions: false, // an AI Movie screenplay has no "add / delete a scene" of its own (scenes come with their beat)
    });
    await recordSpend(db, projectId, { kind: "text", provider: "Gemini 2.5 Flash (voice writer)", units: 1, costUsd: estimateCost("flash", 1), ref: "voice-writer" });
    // the agent may add lines, change or remove existing ones, take a character out, or write the whole scene again
    const applied = applyVoiceEdits(existing, { insert: voice.elements, insertAfter: voice.insertAfter, edits: voice.edits ?? [], rewritten: voice.rewritten ?? [] });
    const changes = { ...applied.counts, total: applied.counts.added + applied.counts.changed + applied.counts.removed };
    if (changes.total === 0 && !changes.rewrote) { res.status(422).json({ error: voice.note || "I couldn't make out anything to change or add — try again, a little closer to the mic.", transcript: voice.transcript }); return; }
    res.json({ draft: true, fullElements: applied.elements, elements: voice.elements, transcript: voice.transcript, note: voice.note, added: applied.counts.added, changes, insertAfter: voice.insertAfter });
  }));
}
