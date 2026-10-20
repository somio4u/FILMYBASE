// "Approval format" (admin): an episode (or all of them) written out in the narrated, Hinglish style the team uses for approval —
//   SCENE 01 — INT. NIGHT / PLACE / CHARACTERS
//   DURATION: 2 MINUTES
//   "We open the scene from …" and flowing paragraphs with the dialogue inside them (Ram says, “…”),
//   capital-letter cue lines (DRAMATIC BUILD UP, TRACK TROLLEY TREATMENT, … BGM PLAYS IN BACKGROUND),
//   CUT TO... between scenes — as a Word file. It is for approval, NOT for the shoot: the screenplay itself is never changed.
// The AI only retells each scene (translating Odia/English into Hinglish and adding the cue lines); the scene heading, duration,
// transitions and the Word layout are made here, the same every time. Each retold scene is remembered, so downloading again is
// instant and only changed scenes are sent to the AI again.
import crypto from "crypto";
import AdmZip from "adm-zip";
import { AlignmentType, Document, Footer, Packer, Paragraph, TextRun } from "docx";

const STYLE_VERSION = 1; // change it when the instructions below change: every remembered scene is then retold

export const APPROVAL_SYSTEM_PROMPT = `You retell ONE scene of a film/series screenplay in the team's "approval format": a narrated scene description written in HINGLISH — Hindi grammar and words written in ROMAN letters, with English for the camera directions and cue lines (like "Durga gusse mein says, “Main kisi aur ladki ke saath dhokha nahin hone dungi.”").

STRICT RULES
- Keep EVERY event and EVERY spoken line of the scene, in the same order. Do not invent events, characters, dialogue or twists. Do not drop anything.
- The scene may be written in Odia, Hindi or English. Turn everything into Hinglish in ROMAN letters (never Odia/Devanagari letters). Spoken lines keep their meaning and emotion, in natural spoken Hindi (Hinglish). Character names stay exactly as given (CAPITALS in the input -> normal name case: Ram, Durga ...).
- Write in the PRESENT tense, as one flowing narration, not as a CHARACTER-name-above-dialogue script.
- Begin the first paragraph with: "We open the scene from <the place, in plain words>." and then describe what we see.
- Dialogue stays INSIDE the paragraphs, introduced by the speaker and "says" (also "cries and says", "mutters", "in anger says", "softly says"), with the spoken line in curly quotes “ ”. Example: Ram ladkhadaate hue says, “Maa, meri Durga ko bacha lena.”
- Use camera/visual phrases where the scene itself shows them: "We show …", "We REVEAL …", "CAMERA HOLDS ON …", "tight close shot", "CHARGE ON …".
- A flashback in the scene is written inline: "QUICK FLASHBACK – EPISODE 02: <what we see>. Back to present."
- Add the team's CAPITAL-LETTER CUE LINES, each as its own short sentence ending with a full stop, ONLY at real dramatic turns of this scene (do not put one after every sentence): "DRAMATIC BUILD UP.", "HEAVY DRAMATIC BUILD UP.", "EMOTIONAL BUILD-UP.", "THRILLER BUILD-UP.", "DIVINE BUILD-UP.", "TRACK TROLLEY TREATMENT.", "<NAMES> ARE SHOCKED.", "HEAVY VOCAL BGM PLAYS IN BACKGROUND.", "DIVINE BGM PLAYS IN BACKGROUND.", "EMOTIONAL SILENCE.". A big turn may combine two, e.g. "DURGA IS SHOCKED. DRAMATIC BUILD UP. TRACK TROLLEY TREATMENT."
- Do NOT write the scene heading, the duration, or the CUT TO / FADE transitions between scenes: they are added separately. A transition INSIDE the scene (a short "CUT TO" between two parts of it) may be written as its own short paragraph.
- Return "paragraphs": the scene as 1 to 12 paragraphs (a short scene is one paragraph; break a long scene where the beat changes). Plain text only: no markdown, no bullet points, no asterisks.`;

// a short sample of the style, taken from the team's own approved episode, shown to the AI with every scene
export const APPROVAL_STYLE_SAMPLE = `SAMPLE OF THE STYLE (different story — copy the style, not the content):
We open the scene from Gopal house hall. Gopal aur Meera America se aane wali Diya ka intezaar kar rahe hain. Doorbell rings. Meera darwaza kholti hai. We REVEAL DIYA – elegant saree, pearl jewellery aur graceful personality. Gopal says, “Welcome Diya ji! Aapka safar kaisa raha?” Diya muskurakar says, “Jahan pahunchna zaroori ho, wahan pahunchne ka raasta mil hi jaata hai.” Durga ki aankhon mein aansu aa jaate hain. Durga says, “Maa, mere Bhaiya ka phone nahin lag raha. Woh kahan hain?” DURGA IS SHOCKED. DRAMATIC BUILD UP. TRACK TROLLEY TREATMENT.`;

const pad2 = (n) => String(n).padStart(2, "0");

// the scene as the AI reads it (its own words and lines, in order)
export function sceneToPlainInput({ heading, location, characters, elements }) {
  const lines = (elements ?? []).map((e) => {
    if (e.type === "dialogue") return `${e.character}${e.characterModifier && e.characterModifier !== "none" ? ` (${e.characterModifier})` : ""}${e.parenthetical ? ` (${e.parenthetical})` : ""}: ${e.text}`;
    if (e.type === "transition") return `[TRANSITION] ${e.text}`;
    if (e.type === "flashback") return `[FLASHBACK] ${e.text}`;
    return `[ACTION] ${e.text}`;
  });
  return `SCENE HEADING: ${heading}\nPLACE: ${location}\nCHARACTERS: ${(characters ?? []).join(", ") || "(see the lines)"}\n\n${lines.join("\n")}`;
}

export function sceneHash(input) {
  return crypto.createHash("sha1").update(`${STYLE_VERSION}\n${input}`).digest("hex");
}

// keeps only usable paragraphs, plain text
export function cleanParagraphs(result) {
  const list = Array.isArray(result?.paragraphs) ? result.paragraphs : [];
  return list
    .filter((p) => typeof p === "string")
    .map((p) => p.replace(/\*\*?/g, "").replace(/\s+\n/g, "\n").trim())
    .filter(Boolean)
    .slice(0, 14);
}

// CUT TO... between two scenes, plus a TRANSITION line when the time of day changes
export function transitionLines(current, next, lastElementTransition) {
  if (!next) return [String(lastElementTransition ?? "").trim().toUpperCase() || "FREEZE."];
  const lines = ["CUT TO..."];
  const a = String(current.timeOfDay ?? "").toUpperCase();
  const b = String(next.timeOfDay ?? "").toUpperCase();
  if (b && a !== b) lines.push(`TRANSITION TO ${b}`);
  return lines;
}

export function sceneHeaderLine(index, scene) {
  const inOut = String(scene.intExt ?? "").replace(/\.+$/, "");
  const places = [`${inOut}. ${String(scene.timeOfDay ?? "").toUpperCase()}`, String(scene.location ?? "").toUpperCase()];
  const who = (scene.characters ?? []).map((c) => String(c).toUpperCase()).join(", ");
  return `SCENE ${pad2(index + 1)} — ${places.join(" / ")}${who ? ` / ${who}` : ""}`;
}

const FONT = "Times New Roman";
const run = (text, extra = {}) => new TextRun({ text, font: FONT, size: 28, ...extra });
const para = (children, extra = {}) => new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 160 }, children: Array.isArray(children) ? children : [children], ...extra });

// the Word file of one episode: [{ intExt, timeOfDay, location, characters, minutes, paragraphs, after: [lines] }]
export async function buildApprovalDoc({ title, episodeNumber, scenes }) {
  const body = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: `${title} EP- ${episodeNumber}`, font: FONT, size: 34, bold: true, color: "FF0000" })] }),
  ];
  scenes.forEach((scene, index) => {
    body.push(para(run(sceneHeaderLine(index, scene), { bold: true, color: "000000" })));
    const minutes = Math.max(1, Math.round(Number(scene.minutes) || 1));
    body.push(para(run(`DURATION: ${minutes} ${minutes === 1 ? "MINUTE" : "MINUTES"}`, { bold: true, color: "000000" })));
    for (const text of scene.paragraphs) body.push(para(run(text)));
    for (const line of scene.after ?? []) body.push(para(run(line)));
  });
  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 28 } } } },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1037, bottom: 1008, left: 1181, right: 1181, header: 720, footer: 720 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${title} | EPISODE ${pad2(episodeNumber)}`, font: FONT, size: 20 })] })] }) },
      children: body,
    }],
  });
  return Packer.toBuffer(doc);
}

export function zipOf(files) {
  const zip = new AdmZip();
  for (const f of files) zip.addFile(f.name, f.buffer);
  return zip.toBuffer();
}

// ---- the routes ------------------------------------------------------------------------------------------------------------------

export async function ensureApprovalFormatSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS approval_format_cache (
    scene_list_id INTEGER NOT NULL,
    episode_index INTEGER NOT NULL,
    scene_index INTEGER NOT NULL,
    hash TEXT NOT NULL,
    paragraphs JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scene_list_id, episode_index, scene_index)
  )`);
}

const jobs = new Map(); // jobId -> { sceneListId, status, done, total, error, filename, buffer, type, startedAt }
const JOB_KEEP_MS = 60 * 60 * 1000;

// tools: { requireRole, askModel(systemInstruction, contents) -> { paragraphs }, sceneListConceptId }
export function registerApprovalFormatRoutes(app, db, tools) {
  const { requireRole, askModel, sceneListConceptId } = tools;

  async function loadEpisodes(sceneListId) {
    const list = (await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId])).rows[0];
    if (!list) return null;
    const content = list.content;
    const groups = Array.isArray(content.episodeScenes)
      ? content.episodeScenes.map((e, i) => ({ episodeIndex: i, scenes: e.scenes ?? [] }))
      : [{ episodeIndex: null, scenes: content.scenes ?? [] }];
    const rows = (await db.query(
      `SELECT DISTINCT ON (episode_index, scene_index) episode_index, scene_index, content
       FROM screenplay_scenes WHERE scene_list_id = $1 ORDER BY episode_index, scene_index, created_at DESC, id DESC`, [sceneListId])).rows;
    const written = new Map(rows.map((r) => [`${r.episode_index ?? "film"}-${r.scene_index}`, r.content]));
    const conceptId = await sceneListConceptId(sceneListId);
    const title = conceptId ? (await db.query("SELECT title FROM concepts WHERE id = $1", [conceptId])).rows[0]?.title : null;
    return { groups, written, title: String(title || "SCREENPLAY").toUpperCase() };
  }

  const textOf = (v) => (v && typeof v === "object" ? v.en || v.or || v.hi || "" : String(v ?? ""));

  async function retoldScene(sceneListId, episodeIndex, sceneIndex, scene, screenplay) {
    const characters = screenplay.charactersPresent?.length ? screenplay.charactersPresent : [...new Set(screenplay.elements.filter((e) => e.type === "dialogue").map((e) => e.character))];
    const input = sceneToPlainInput({ heading: `${scene.intExt}. ${textOf(scene.location)} - ${scene.timeOfDay}`, location: textOf(scene.location), characters, elements: screenplay.elements });
    const hash = sceneHash(input);
    const key = [sceneListId, episodeIndex ?? -1, sceneIndex];
    const cached = (await db.query("SELECT hash, paragraphs FROM approval_format_cache WHERE scene_list_id = $1 AND episode_index = $2 AND scene_index = $3", key)).rows[0];
    if (cached?.hash === hash && Array.isArray(cached.paragraphs) && cached.paragraphs.length) return { paragraphs: cached.paragraphs, characters };
    let paragraphs = [];
    for (let attempt = 0; attempt < 2 && paragraphs.length === 0; attempt++) {
      paragraphs = cleanParagraphs(await askModel(APPROVAL_SYSTEM_PROMPT, `${APPROVAL_STYLE_SAMPLE}\n\n--- THE SCENE TO RETELL ---\n${input}\n\nReturn "paragraphs".`));
    }
    if (paragraphs.length === 0) throw new Error("the AI returned nothing for this scene");
    await db.query(
      `INSERT INTO approval_format_cache (scene_list_id, episode_index, scene_index, hash, paragraphs) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (scene_list_id, episode_index, scene_index) DO UPDATE SET hash = EXCLUDED.hash, paragraphs = EXCLUDED.paragraphs, created_at = now()`,
      [...key, hash, JSON.stringify(paragraphs)]);
    return { paragraphs, characters };
  }

  async function runJob(job, data, episodeIndexes) {
    try {
      const work = [];
      for (const ei of episodeIndexes) {
        const group = data.groups.find((g) => g.episodeIndex === ei);
        group.scenes.forEach((scene, si) => work.push({ group, scene, si }));
      }
      job.total = work.length;
      const results = new Map();
      let next = 0;
      const worker = async () => {
        while (next < work.length) {
          const item = work[next++];
          const written = data.written.get(`${item.group.episodeIndex ?? "film"}-${item.si}`);
          if (Array.isArray(written?.elements) && written.elements.length) {
            try {
              results.set(item, await retoldScene(job.sceneListId, item.group.episodeIndex, item.si, item.scene, written));
            } catch (error) {
              throw new Error(`${item.group.episodeIndex === null ? "Scene" : `Episode ${item.group.episodeIndex + 1}, scene`} ${item.si + 1}: ${error.message}`);
            }
          } else {
            results.set(item, { paragraphs: [`[This scene is not written yet] ${textOf(item.scene.oneLiner)}`], characters: [] });
          }
          job.done++;
        }
      };
      await Promise.all([worker(), worker(), worker()]);

      const files = [];
      for (const ei of episodeIndexes) {
        const group = data.groups.find((g) => g.episodeIndex === ei);
        const scenes = group.scenes.map((scene, si) => {
          const r = results.get(work.find((w) => w.group === group && w.si === si));
          const written = data.written.get(`${ei ?? "film"}-${si}`);
          const last = [...(written?.elements ?? [])].reverse().find((e) => e.type === "transition");
          const nextScene = group.scenes[si + 1];
          return {
            intExt: scene.intExt, timeOfDay: scene.timeOfDay, location: textOf(scene.location), characters: r.characters,
            minutes: scene.estimatedMinutes, paragraphs: r.paragraphs,
            after: transitionLines(scene, nextScene, last?.text),
          };
        });
        const episodeNumber = ei === null ? 1 : ei + 1;
        files.push({ name: `${data.title.replace(/[^A-Za-z0-9]+/g, "-")}-EP-${pad2(episodeNumber)}-approval.docx`, buffer: await buildApprovalDoc({ title: data.title, episodeNumber, scenes }) });
      }
      if (files.length === 1) { job.buffer = files[0].buffer; job.filename = files[0].name; job.type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; }
      else { job.buffer = zipOf(files); job.filename = `${data.title.replace(/[^A-Za-z0-9]+/g, "-")}-all-episodes-approval.zip`; job.type = "application/zip"; }
      job.status = "done";
    } catch (error) {
      console.error("Approval format failed:", error.message);
      job.status = "error";
      job.error = error.message;
    }
  }

  app.post("/api/scene-lists/:id/approval-format", requireRole("admin"), async (req, res) => {
    const sceneListId = Number(req.params.id);
    const data = await loadEpisodes(sceneListId);
    if (!data) { res.status(404).json({ error: "Scene list not found" }); return; }
    const wanted = req.body?.episodeIndex;
    const indexes = req.body?.all === true || !Number.isInteger(wanted) ? data.groups.map((g) => g.episodeIndex) : [wanted];
    if (indexes.some((i) => !data.groups.some((g) => g.episodeIndex === i))) { res.status(400).json({ error: "That episode does not exist." }); return; }
    for (const [id, j] of jobs) if (Date.now() - j.startedAt > JOB_KEEP_MS) jobs.delete(id);
    const jobId = crypto.randomUUID();
    const job = { sceneListId, status: "running", done: 0, total: 0, startedAt: Date.now() };
    jobs.set(jobId, job);
    runJob(job, data, indexes);
    res.json({ jobId });
  });

  app.get("/api/scene-lists/:id/approval-format/:jobId", requireRole("admin"), (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.sceneListId !== Number(req.params.id)) { res.status(404).json({ error: "That download is no longer available. Please start it again." }); return; }
    res.json({ status: job.status, done: job.done, total: job.total, error: job.error ?? null });
  });

  app.get("/api/scene-lists/:id/approval-format/:jobId/file", requireRole("admin"), (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.sceneListId !== Number(req.params.id) || job.status !== "done") { res.status(404).json({ error: "That file is not ready." }); return; }
    res.setHeader("Content-Type", job.type);
    res.setHeader("Content-Disposition", `attachment; filename="${job.filename}"`);
    res.send(job.buffer);
  });
}
