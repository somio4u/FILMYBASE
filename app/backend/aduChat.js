// ADU — THE FRIENDLY FRONT DOOR for AI Movie (step H1 of the "Buddy + Draft Agent" hybrid: one friend, one conversation, the Agent as its hands).
//
// A person writes (or speaks) to Adu in plain words. Adu first SORTS what was said:
//   a question or a chat            -> answered in words (the story, the scene on screen, how to do something in the app); nothing changes
//   a small edit, a rewrite of several scenes, an alternative, a new draft, a new story, "carry on"
//                                   -> the Draft Agent's own classifier (draftAgent.js interpret) says what it understood and what it would touch
//   "write the whole screenplay" / "write what is left"   -> a proposal for the "Write the whole screenplay" job
//   "make beat 3 longer, 8 minutes" -> a proposal to extend that beat
// Nothing here changes the screenplay, copies a draft or spends money on its own: every reply that is not plain talk carries an `action` (what Adu
// proposes) for a card the person presses (the cards come in step H3). The conversation is remembered per person and per draft — every draft of AI
// Movie is its own project row, so "per project row" is "per draft".
import { ensureDraftFor, httpError } from "./drafts.js";
import { interpret } from "./draftAgent.js";
import { flatten } from "./workspaceContext.js";

export async function ensureAduChatSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS adu_chat_messages (
    id SERIAL PRIMARY KEY,
    module TEXT NOT NULL,
    project_ref INTEGER NOT NULL,
    user_id INTEGER,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    action JSONB,
    resolved BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query("CREATE INDEX IF NOT EXISTS adu_chat_messages_lookup ON adu_chat_messages (module, project_ref, user_id, id)");
}

const MAX_TEXT = 4000;
const MEMORY = 20; // messages sent back to the model with each new one
const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const LANGUAGES = ["en", "hi", "or"];
const LANGUAGE_NAME = { en: "English", hi: "Hindi (Devanagari script)", or: "Odia (Odia script)" };

// ---- sorting, without AI first -----------------------------------------------------------------------------------------------------------
// Things people say that are clear enough not to need the AI to be sorted. Anything else goes to the Draft Agent's classifier.
// Odia and Hindi letters are not "word" letters for \b, so those question words are matched with a look-ahead instead
const QUESTION_START = /^\s*(?:(?:how|what|why|when|where|which|who|whom|whose|is|are|was|were|do|does|did|should|shall|kya|kaise|kyun|kyu|kitna|kitne|kaun|kab|kahan)\b|(?:କଣ|କେମିତି|କିଏ|କେତେ|କାହିଁକି|କେବେ|କେଉଁ|କୁଆଡ଼େ|क्या|कैसे|क्यों|कितना|कितने|कौन|कब|कहाँ)(?=[\s?？,.!]|$))/i;
// a question word anywhere in a Hindi / Odia / Hinglish sentence ("यह scene कितना लंबा है") also makes it a question; being taken for talk is harmless (it only answers)
const QUESTION_WORD_ANYWHERE = /(?:^|\s)(?:क्या|कैसे|क्यों|कितना|कितने|कौन|कब|कहाँ|କଣ|କେମିତି|କିଏ|କେତେ|କାହିଁକି|କେବେ|କେଉଁ|kya|kaise|kyun|kyu|kitna|kitne|kaun|kab|kahan)(?=[\s?？,.!]|$)/i;
const POLITE_COMMAND = /^\s*(can|could|would|will)\s+you\b|\bplease\b|\bkripya\b|\bkar\s*do\b|\bkardo\b/i;
const GREETING = /^\s*(hi|hello|hey|namaste|namaskar|thanks|thank you|thankyou|ok|okay|nice|good|great|wow|ଧନ୍ୟବାଦ|ନମସ୍କାର)\b[\s!.,]*$/i;

export function looksLikeQuestion(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (GREETING.test(t)) return true;
  if (POLITE_COMMAND.test(t)) return false; // "please make the villain colder", "can you make the villain colder?": commands, not questions
  return /[?？]\s*$/.test(t) || QUESTION_START.test(t) || QUESTION_WORD_ANYWHERE.test(t);
}

// (Hindi and Odia letters are not "word" letters for \b, so those words are matched without it)
const WRITE_VERB = /\b(write|likho|likh\s*do|likhdo|generate|create|banao|bana\s*do)\b|ଲେଖ|लिख|बनाओ/i;
const WHOLE = /\b(whole|full|entire|complete|all|rest|remaining|left|baaki|baki|pura|poora|sab|sabhi)\b|ସବୁ|ପୂରା|ପୁରା|ବାକି|पूरी|पूरा|सारी|सारा|बाकी|बचे|बचा/i;
const SCREENPLAY_WORD = /\b(screenplay|script|scenes?|beats?|dialogues?|film|movie)\b|ସ୍କ୍ରିନପ୍ଲେ|ସିନ୍|ବିଟ୍|ସଂଳାପ|स्क्रीनप्ले|पटकथा|सीन|बीट|संवाद|फ़िल्म|फिल्म/i;

export function sortWithoutAi(text, context = {}) {
  const t = String(text ?? "").trim();
  if (!t) return { kind: "empty" };
  // "make beat 3 longer — 8 minutes": extend one beat to a time
  const minutes = /(\d+(?:\.\d+)?)\s*(?:min|mins|minute|minutes|मिनट|ମିନିଟ୍?)/i.exec(t);
  if (/\b(extend|longer|lengthen|increase|stretch|badha|badhao|lamba|lamb)\b|ବଢ଼ା|ଲମ୍ବା|बढ़ा|लंबा|लम्बा/i.test(t) && (/\b(beat|scene)\b/i.test(t) || Number.isInteger(context.beatIndex)) && minutes && !looksLikeQuestion(t)) {
    const beat = /\bbeat\s*(\d+)\b/i.exec(t);
    const beatIndex = beat ? Number(beat[1]) - 1 : Number.isInteger(context.beatIndex) ? context.beatIndex : null;
    return { kind: "extend", beatIndex, minutes: Number(minutes[1]) };
  }
  // "write the whole screenplay" / "write what is left" / "write all the dialogue"
  if (!looksLikeQuestion(t) && WRITE_VERB.test(t) && WHOLE.test(t) && SCREENPLAY_WORD.test(t) && !/\b(this|that)\s+(scene|line|dialogue)\b/i.test(t)) {
    return { kind: "write", dialogue: !/\b(without|no|bina)\s+dialogues?\b/i.test(t) };
  }
  if (looksLikeQuestion(t)) return { kind: "chat" };
  return { kind: "agent" };
}

// ---- what Adu tells the person about what it understood ----------------------------------------------------------------------------------------
const SAYS = {
  en: {
    agent: (a) => `I understood: ${a.summary}${a.targets.length ? ` It would touch ${a.targets.length} piece${a.targets.length === 1 ? "" : "s"}: ${a.targets.slice(0, 6).map((t) => t.label).join("; ")}${a.targets.length > 6 ? "…" : ""}.` : ""} Nothing changes until you press a button.`,
    clarify: (a) => `I am not sure what you want me to do with this. ${a.summary || ""} Tell me a little more, or choose: edit the current draft, create a new draft, explore an alternative, or start a new story.`,
    big: (a) => `${a.summary} This is a bigger change, so I will only start it after you confirm it.`,
    write: (dialogue) => `I can write every beat that is not finished yet${dialogue ? ", with the dialogue of every scene" : " (scenes only, no dialogue)"} — one beat after the other, in the background. Beats already approved with their dialogue stay as they are. Press the button to start.`,
    extend: (a) => (a.beatIndex === null ? `Which beat should I make longer? Tell me its number, for example “beat 3, ${a.minutes} minutes”.` : `I can extend beat ${a.beatIndex + 1} to about ${a.minutes} minutes by adding scenes that fit the story. Press the button to do it.`),
  },
  hi: {
    agent: (a) => `मैंने यह समझा: ${a.summary}${a.targets.length ? ` इसमें ${a.targets.length} हिस्से छुए जाएँगे: ${a.targets.slice(0, 6).map((t) => t.label).join("; ")}${a.targets.length > 6 ? "…" : ""}।` : ""} जब तक आप बटन नहीं दबाते, कुछ नहीं बदलेगा।`,
    clarify: (a) => `मुझे पक्का नहीं पता कि आप इससे क्या कराना चाहते हो। ${a.summary || ""} थोड़ा और बताओ, या चुनो: मौजूदा draft बदलना, नया draft बनाना, कोई दूसरा रास्ता आज़माना, या नई कहानी शुरू करना।`,
    big: (a) => `${a.summary} यह बड़ा बदलाव है, इसलिए मैं इसे आपके पक्का करने के बाद ही शुरू करूँगा।`,
    write: (dialogue) => `मैं हर अधूरा beat लिख सकता हूँ${dialogue ? ", हर scene के dialogue के साथ" : " (सिर्फ़ scenes, dialogue नहीं)"} — एक के बाद एक, पीछे चलते हुए। जो beats पहले से approve हैं और जिनका dialogue हो चुका है, वे जैसे हैं वैसे रहेंगे। शुरू करने के लिए बटन दबाओ।`,
    extend: (a) => (a.beatIndex === null ? `किस beat को लंबा करूँ? उसका नंबर बताओ, जैसे “beat 3, ${a.minutes} मिनट”।` : `मैं beat ${a.beatIndex + 1} को करीब ${a.minutes} मिनट तक बढ़ा सकता हूँ, कहानी में फिट होने वाले scenes जोड़कर। करने के लिए बटन दबाओ।`),
  },
  or: {
    agent: (a) => `ମୁଁ ଏହା ବୁଝିଲି: ${a.summary}${a.targets.length ? ` ଏଥିରେ ${a.targets.length} ଟି ଅଂଶ ଛୁଇଁବ: ${a.targets.slice(0, 6).map((t) => t.label).join("; ")}${a.targets.length > 6 ? "…" : ""}।` : ""} ତୁମେ ବଟନ୍ ନ ଦବାଇଲେ କିଛି ବଦଳିବ ନାହିଁ।`,
    clarify: (a) => `ତୁମେ ମୋଠାରୁ କଣ ଚାହୁଁଛ ମୁଁ ଠିକ୍ ବୁଝିପାରିଲି ନାହିଁ। ${a.summary || ""} ଟିକେ ଆଉ କୁହ, କିମ୍ବା ବାଛ: ଏବେକାର ଡ୍ରାଫ୍ଟ ବଦଳାଇବା, ନୂଆ ଡ୍ରାଫ୍ଟ ବନାଇବା, ଅନ୍ୟ ଗୋଟେ ବାଟ ଚେଷ୍ଟା କରିବା, କିମ୍ବା ନୂଆ ଗପ ଆରମ୍ଭ କରିବା।`,
    big: (a) => `${a.summary} ଏହା ଏକ ବଡ଼ ବଦଳ, ତେଣୁ ତୁମେ ପକ୍କା କଲା ପରେ ହିଁ ମୁଁ ଏହାକୁ ଆରମ୍ଭ କରିବି।`,
    write: (dialogue) => `ମୁଁ ପ୍ରତ୍ୟେକ ଅଧୁରା ବିଟ୍ ଲେଖିପାରିବି${dialogue ? ", ପ୍ରତ୍ୟେକ ଦୃଶ୍ୟର ସଂଳାପ ସହିତ" : " (କେବଳ ଦୃଶ୍ୟ, ସଂଳାପ ନୁହେଁ)"} — ଗୋଟିଏ ପରେ ଗୋଟିଏ, ପଛରେ ଚାଲି। ଯେଉଁ ବିଟ୍ ଆଗରୁ ଅନୁମୋଦିତ ଓ ସଂଳାପ ସହିତ ଅଛି, ସେଗୁଡ଼ିକ ଯେମିତି ଅଛି ସେମିତି ରହିବ। ଆରମ୍ଭ କରିବାକୁ ବଟନ୍ ଦବାଅ।`,
    extend: (a) => (a.beatIndex === null ? `କେଉଁ ବିଟ୍‌କୁ ଲମ୍ବା କରିବି? ତାର ନମ୍ବର କୁହ, ଯେମିତି “beat 3, ${a.minutes} ମିନିଟ୍”।` : `ମୁଁ beat ${a.beatIndex + 1} କୁ ପ୍ରାୟ ${a.minutes} ମିନିଟ୍ ପର୍ଯ୍ୟନ୍ତ ବଢ଼ାଇପାରିବି, ଗପ ସହ ମେଳ ଖାଉଥିବା ଦୃଶ୍ୟ ଯୋଡ଼ି। କରିବାକୁ ବଟନ୍ ଦବାଅ।`),
  },
};

const BIG = new Set(["NEW_DRAFT", "NEW_STORY", "ALTERNATIVE"]);

// ---- answering in words ------------------------------------------------------------------------------------------------------------------
const GUIDE = `WHAT THE AI MOVIE SCREEN CAN DO (explain it when asked, plainly, never invent a button that is not listed):
- Stages in order: Story, Synopsis, Characters, Three-Act Structure, Beat Sheet, Screenplay. Each is approved before the next opens.
- Screenplay: the card "Write the whole screenplay" writes every unfinished beat (its scenes, an automatic approval, and the dialogue of every scene), one beat after the other, in the background, with a progress bar and a Stop button. Beats written that way say "approved automatically — not read by you yet"; the button "Approve the whole screenplay" is the person's own sign-off once they have read it.
- The older way: write beat by beat, read each beat with the arrows, approve it, ask for dialogue scene by scene.
- A beat can be made longer (Extend), a beat can be sent back with notes (Request changes), a scene can be revised or edited, and a song beat has a song sheet.
- English / Hindi / Odia: the language switch changes the language the screenplay is read in.
- Drafts: a new draft or an alternative is a copy; the first draft is never changed.
- Everything proposed is shown first; nothing changes until the person presses a button.`;

function beatLines(backfill) {
  const plot = Array.isArray(backfill?.plot) ? backfill.plot : [];
  const beats = Array.isArray(backfill?.screenplayBeats) ? backfill.screenplayBeats : [];
  return plot.slice(0, 40).map((b, i) => {
    const sp = beats[i];
    const scenes = Array.isArray(sp?.scenes) ? sp.scenes : [];
    const state = !sp || sp.status === "not_started" ? "not written" : `${sp.status}${sp.autoApproved ? " (automatically)" : ""}, ${scenes.length} scene${scenes.length === 1 ? "" : "s"}${scenes.length && scenes.every((s) => Array.isArray(s.content) && s.content.length) ? ", with dialogue" : ""}`;
    return `Beat ${i + 1}: ${clip(flatten(b?.title), 80)} — ${state}`;
  }).join("\n");
}

function sceneInView(backfill, context) {
  const { beatIndex, sceneIndex } = context ?? {};
  if (!Number.isInteger(beatIndex)) return "";
  const beat = backfill?.screenplayBeats?.[beatIndex];
  const scene = Number.isInteger(sceneIndex) ? beat?.scenes?.[sceneIndex] : null;
  if (scene) return `The person is looking at beat ${beatIndex + 1}, scene ${sceneIndex + 1}:\n${clip(flatten(scene), 1200)}`;
  if (beat?.scenes?.length) return `The person is looking at beat ${beatIndex + 1}, which has ${beat.scenes.length} scenes:\n${clip(flatten(beat.scenes), 1200)}`;
  return `The person is looking at beat ${beatIndex + 1}.`;
}

export function answerPrompt({ project, history, text, language, context }) {
  const b = project.backfill ?? {};
  const talk = history.slice(-MEMORY).map((m) => `${m.role === "user" ? "PERSON" : "ADU"}: ${clip(m.content, 600)}`).join("\n");
  return `You are Adu, a warm, practical writing friend for a filmmaker working on an AI Movie (a film made entirely with AI). Talk like a friend in the editing room: short, clear, kind. The person is not a programmer.

RULES
- Reply in ${LANGUAGE_NAME[language] ?? LANGUAGE_NAME.en}. Keep character and place names as they are written in the story.
- You are only TALKING now: you have changed nothing and you never say you did. If the person wants a change, tell them in a sentence what you would do and that you will show it first.
- Use only the story material below. Never invent story facts, scenes or characters that are not in it. If you do not know, say so.
- Answer the question asked, in a few sentences; no long lists unless asked.

${GUIDE}

THE PROJECT
Title: ${clip(project.title, 120) || "(untitled)"}
Idea: ${clip(project.pasted_text, 600)}
Story: ${clip(flatten(b.story), 700)}
Synopsis: ${clip(flatten(b.synopsis), 700)}
Beats:
${beatLines(b) || "(the Beat Sheet is not made yet)"}
${sceneInView(b, context)}
${context?.selectedText ? `The person has selected this text: "${clip(context.selectedText, 400)}"` : ""}

THE CONVERSATION SO FAR
${talk || "(this is the start)"}

THE PERSON NOW SAYS: """${text}"""`;
}

const REPLY_SCHEMA = { type: "OBJECT", properties: { reply: { type: "STRING" } }, required: ["reply"] };

async function answerInWords({ db, models, draft, project, history, text, language, context }) {
  let out;
  try {
    out = await models.json(draft, "writing-assistant", answerPrompt({ project, history, text, language, context }), { maxOutputTokens: 2048, responseSchema: REPLY_SCHEMA });
  } catch (error) {
    if (error.status === 402) throw error; // the money limit: said plainly by the caller
    throw httpError("Adu could not answer just now. Please try again.", 502, "model_failed");
  }
  const reply = clip(out?.reply, 3000);
  if (!reply) throw httpError("Adu could not answer just now. Please try again.", 502, "empty_reply");
  return reply;
}

// ---- one message, start to finish ---------------------------------------------------------------------------------------------------------------
const row = (r) => ({ id: r.id, role: r.role, content: r.content, action: r.action ?? null, resolved: r.resolved, createdAt: r.created_at });

export async function loadHistory(db, projectId, userId, limit = 100) {
  const rows = (await db.query(
    `SELECT * FROM (SELECT * FROM adu_chat_messages WHERE module = 'ai_movie' AND project_ref = $1 AND user_id IS NOT DISTINCT FROM $2 ORDER BY id DESC LIMIT $3) latest ORDER BY id ASC`,
    [projectId, userId ?? null, limit]
  )).rows;
  return rows.map(row);
}

export async function handleAduMessage(db, models, { projectId, userId = null, text, language = "en", context = {} }) {
  const said = String(text ?? "").trim();
  if (!said) throw httpError("Write or say something to Adu first.", 400, "empty");
  if (said.length > MAX_TEXT) throw httpError(`That message is too long (most ${MAX_TEXT} characters).`, 400, "too_long");
  const lang = LANGUAGES.includes(language) ? language : "en";
  const project = (await db.query("SELECT id, title, pasted_text, backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0];
  if (!project) throw httpError("Project not found.", 404, "not_found");
  const draft = await ensureDraftFor(db, "ai_movie", projectId, { actorUserId: userId });
  const history = await loadHistory(db, projectId, userId, MEMORY);
  const sorted = sortWithoutAi(said, context);

  let reply;
  let action = null;
  let kind = sorted.kind;
  if (kind === "agent") {
    // the Draft Agent's own classifier: what kind of job is this, what would it touch?
    const read = await interpret(db, models, draft.id, { instruction: said, source: "chat", context: { ...context, stage: context.stage ?? "screenplay" } });
    if (read.intent === "UNCLEAR" && !read.needsClarification) kind = "chat";
    else if (read.intent === "UNCLEAR") {
      // it could not tell: ask, with the choices — unless it is only talk, which is then answered
      kind = "unclear";
      action = { type: "agent", intent: read.intent, instruction: said, summary: read.summary, targets: [], unresolved: read.unresolved ?? [], options: read.allChoices ?? read.options ?? [], needsClarification: true, big: false };
      reply = SAYS[lang].clarify({ summary: read.summary && !/^Interpreted as/i.test(read.summary) ? read.summary : "" });
    } else {
      // when the classifier's model could not be asked, the Agent falls back to the words alone and its summary is only "Interpreted as …": say the person's own words instead
      const summary = /^Interpreted as/i.test(read.summary ?? "") ? `“${clip(said, 140)}”` : read.summary;
      action = {
        type: "agent", intent: read.intent, instruction: said, summary, targets: read.targets ?? [], unresolved: read.unresolved ?? [], candidates: read.candidates ?? [],
        options: read.options ?? [], needsClarification: Boolean(read.needsClarification), constraints: read.constraints ?? {}, big: BIG.has(read.intent), confidence: read.confidence,
      };
      reply = action.needsClarification ? SAYS[lang].clarify(action) : action.big ? SAYS[lang].big(action) : SAYS[lang].agent(action);
    }
  } else if (kind === "write") {
    action = { type: "write_all", dialogue: sorted.dialogue };
    reply = SAYS[lang].write(sorted.dialogue);
  } else if (kind === "extend") {
    action = { type: "extend_beat", beatIndex: sorted.beatIndex, minutes: sorted.minutes, needsClarification: sorted.beatIndex === null };
    reply = SAYS[lang].extend(sorted);
  }
  if (kind === "chat") {
    reply = await answerInWords({ db, models, draft, project, history, text: said, language: lang, context });
  }

  // both messages are saved only now: a failed answer leaves nothing half-said, and the person's words stay in the box
  const userRow = (await db.query("INSERT INTO adu_chat_messages (module, project_ref, user_id, role, content) VALUES ('ai_movie', $1, $2, 'user', $3) RETURNING *", [projectId, userId, said])).rows[0];
  const aduRow = (await db.query("INSERT INTO adu_chat_messages (module, project_ref, user_id, role, content, action) VALUES ('ai_movie', $1, $2, 'assistant', $3, $4) RETURNING *", [projectId, userId, reply, action ? JSON.stringify(action) : null])).rows[0];
  return { user: row(userRow), assistant: row(aduRow), sortedAs: kind, draftId: draft.id };
}

export async function clearHistory(db, projectId, userId) {
  await db.query("DELETE FROM adu_chat_messages WHERE module = 'ai_movie' AND project_ref = $1 AND user_id IS NOT DISTINCT FROM $2", [projectId, userId ?? null]);
}

export function registerAduChatRoutes(app, db, requireRole, { models }) {
  const admin = requireRole("admin");
  const id = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500 && !error.status) console.error("Adu chat route failed:", error);
      res.status(status).json({ error: status >= 500 && !error.status ? "Something went wrong on the server." : error.message, code: error.code ?? null });
    }
  };
  const project = (req) => { const p = id(req.params.projectId); if (!p) throw httpError("Not a valid project.", 400, "bad_project"); return p; };
  const base = "/api/ai-movie/assistant/:projectId";
  app.get(`${base}/history`, admin, wrap(async (req, res) => res.json({ messages: await loadHistory(db, project(req), req.user?.id ?? null) })));
  app.delete(`${base}/history`, admin, wrap(async (req, res) => { await clearHistory(db, project(req), req.user?.id ?? null); res.json({ ok: true }); }));
  app.post(`${base}/message`, admin, wrap(async (req, res) => res.json(await handleAduMessage(db, models, {
    projectId: project(req), userId: req.user?.id ?? null, text: req.body?.text, language: req.body?.language, context: req.body?.context && typeof req.body.context === "object" ? req.body.context : {},
  }))));
}
