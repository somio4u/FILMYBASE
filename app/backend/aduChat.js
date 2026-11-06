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
import { draftUnits, ensureDraftFor, httpError } from "./drafts.js";
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

export function sortWithoutAi(text, context = {}, { module = "ai_movie" } = {}) {
  const t = String(text ?? "").trim();
  if (!t) return { kind: "empty" };
  // a film has no beats to extend; it has scenes to add: "add 10 scenes", "10 aur scenes jodo"
  if (module === "film" && !looksLikeQuestion(t)) {
    const add = /\b(add|jodo|jod\s*do|aur|more|another)\b.*?\b(\d{1,3})\s*(?:more\s+|new\s+|aur\s+)?scenes?\b|\b(\d{1,3})\s*(?:more\s+|new\s+|aur\s+)?scenes?\b.*?\b(add|jodo|jod\s*do)\b/i.exec(t);
    if (add) { const count = Number(add[2] ?? add[3]); if (count >= 1 && count <= 40) return { kind: "add", count }; }
  }
  // "make beat 3 longer — 8 minutes": extend one beat to a time
  const minutes = /(\d+(?:\.\d+)?)\s*(?:min|mins|minute|minutes|मिनट|ମିନିଟ୍?)/i.exec(t);
  if (module !== "film" && /\b(extend|longer|lengthen|increase|stretch|badha|badhao|lamba|lamb)\b|ବଢ଼ା|ଲମ୍ବା|बढ़ा|लंबा|लम्बा/i.test(t) && (/\b(beat|scene)\b/i.test(t) || Number.isInteger(context.beatIndex)) && minutes && !looksLikeQuestion(t)) {
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
    writeFilm: (a) => `I can write every scene that is not written yet (${a.unwritten} of ${a.total}), one after the other, in the background. Scenes already written stay as they are. Press the button to start.`,
    addFilm: (a) => `I can plan ${a.count} new scene${a.count === 1 ? '' : 's'} that fit your story and put them in the scene list. They start as “not written yet”. Press the button to do it.`,
    allWritten: () => `Every scene of this film is already written, so there is nothing left to write. If you want more scenes, say “add 5 scenes”.`,
    noSceneList: () => `There is no approved scene list in this project yet, so there are no scenes to write or add. Finish the Scene One-Liners stage first.`,
    agent: (a) => `I understood: ${a.summary}${a.targets.length ? ` It would touch ${a.targets.length} piece${a.targets.length === 1 ? "" : "s"}: ${a.targets.slice(0, 6).map((t) => t.label).join("; ")}${a.targets.length > 6 ? "…" : ""}.` : ""} Nothing changes until you press a button.`,
    clarify: (a) => `I am not sure what you want me to do with this. ${a.summary || ""} Tell me a little more, or choose: edit the current draft, create a new draft, explore an alternative, or start a new story.`,
    big: (a) => `${a.summary} This is a bigger change, so I will only start it after you confirm it.`,
    write: (dialogue) => `I can write every beat that is not finished yet${dialogue ? ", with the dialogue of every scene" : " (scenes only, no dialogue)"} — one beat after the other, in the background. Beats already approved with their dialogue stay as they are. Press the button to start.`,
    extend: (a) => ({
      which: `Which beat should I make longer? Tell me its number, for example “beat 3”.`,
      missing: `There is no beat ${a.beatIndex + 1} (the film has ${a.beatCount} beats).`,
      unwritten: `Beat ${a.beatIndex + 1} has no written scenes yet, so there is nothing to make longer. Write it first.`,
      notarget: `The Beat Sheet gives beat ${a.beatIndex + 1} no time, so I do not know how long it should be. Set its time in the Beat Sheet first.`,
      enough: `Beat ${a.beatIndex + 1} already has about ${a.writtenMinutes} minutes, which meets its Beat Sheet time of ${a.targetMinutes}. To make it longer, change its time in the Beat Sheet first.`,
      ok: `Beat ${a.beatIndex + 1} is planned for ${a.targetMinutes} minutes in the Beat Sheet and has about ${a.writtenMinutes} written. I can add scenes that fit the story until it reaches ${a.targetMinutes} minutes${a.askedMinutes && Math.abs(a.askedMinutes - a.targetMinutes) > 0.01 ? ` (you said ${a.askedMinutes}; the Beat Sheet decides the time)` : ""}. Press the button to do it.`,
    })[a.why],
  },
  hi: {
    writeFilm: (a) => `मैं हर वह scene लिख सकता हूँ जो अभी लिखा नहीं गया (${a.total} में से ${a.unwritten}), एक के बाद एक, पीछे चलते हुए। जो scenes लिखे जा चुके हैं वे जैसे हैं वैसे रहेंगे। शुरू करने के लिए बटन दबाओ।`,
    addFilm: (a) => `मैं आपकी कहानी में फिट होने वाले ${a.count} नए scenes सोचकर scene list में जोड़ सकता हूँ। वे “अभी लिखे नहीं गए” के रूप में शुरू होंगे। करने के लिए बटन दबाओ।`,
    allWritten: () => `इस film के सारे scenes पहले से लिखे हुए हैं, इसलिए लिखने को कुछ बचा नहीं है। और scenes चाहिए तो कहो “5 scenes जोड़ो”।`,
    noSceneList: () => `इस project में अभी कोई approved scene list नहीं है, इसलिए लिखने या जोड़ने के लिए scenes नहीं हैं। पहले Scene One-Liners वाला चरण पूरा करो।`,
    agent: (a) => `मैंने यह समझा: ${a.summary}${a.targets.length ? ` इसमें ${a.targets.length} हिस्से छुए जाएँगे: ${a.targets.slice(0, 6).map((t) => t.label).join("; ")}${a.targets.length > 6 ? "…" : ""}।` : ""} जब तक आप बटन नहीं दबाते, कुछ नहीं बदलेगा।`,
    clarify: (a) => `मुझे पक्का नहीं पता कि आप इससे क्या कराना चाहते हो। ${a.summary || ""} थोड़ा और बताओ, या चुनो: मौजूदा draft बदलना, नया draft बनाना, कोई दूसरा रास्ता आज़माना, या नई कहानी शुरू करना।`,
    big: (a) => `${a.summary} यह बड़ा बदलाव है, इसलिए मैं इसे आपके पक्का करने के बाद ही शुरू करूँगा।`,
    write: (dialogue) => `मैं हर अधूरा beat लिख सकता हूँ${dialogue ? ", हर scene के dialogue के साथ" : " (सिर्फ़ scenes, dialogue नहीं)"} — एक के बाद एक, पीछे चलते हुए। जो beats पहले से approve हैं और जिनका dialogue हो चुका है, वे जैसे हैं वैसे रहेंगे। शुरू करने के लिए बटन दबाओ।`,
    extend: (a) => ({
      which: `किस beat को लंबा करूँ? उसका नंबर बताओ, जैसे “beat 3”।`,
      missing: `beat ${a.beatIndex + 1} नहीं है (film में ${a.beatCount} beats हैं)।`,
      unwritten: `beat ${a.beatIndex + 1} के scenes अभी लिखे नहीं गए, इसलिए लंबा करने को कुछ नहीं है। पहले उसे लिखो।`,
      notarget: `Beat Sheet में beat ${a.beatIndex + 1} का कोई समय नहीं है, इसलिए मुझे पता नहीं कि वह कितना लंबा होना चाहिए। पहले Beat Sheet में उसका समय तय करो।`,
      enough: `beat ${a.beatIndex + 1} में पहले से करीब ${a.writtenMinutes} मिनट हैं, जो Beat Sheet के ${a.targetMinutes} मिनट के समय को पूरा करते हैं। उसे और लंबा करना हो तो पहले Beat Sheet में उसका समय बदलो।`,
      ok: `Beat Sheet में beat ${a.beatIndex + 1} के लिए ${a.targetMinutes} मिनट तय हैं और अभी करीब ${a.writtenMinutes} मिनट लिखे हैं। मैं कहानी में फिट होने वाले scenes जोड़कर उसे ${a.targetMinutes} मिनट तक ला सकता हूँ${a.askedMinutes && Math.abs(a.askedMinutes - a.targetMinutes) > 0.01 ? ` (आपने ${a.askedMinutes} कहा था; समय Beat Sheet तय करती है)` : ""}। करने के लिए बटन दबाओ।`,
    })[a.why],
  },
  or: {
    writeFilm: (a) => `ମୁଁ ଯେଉଁ ଦୃଶ୍ୟ ଏଯାଏଁ ଲେଖାହୋଇନାହିଁ ସେ ସବୁ (${a.total} ମଧ୍ୟରୁ ${a.unwritten}) ଗୋଟିଏ ପରେ ଗୋଟିଏ, ପଛରେ ଚାଲି ଲେଖିପାରିବି। ଯେଉଁ ଦୃଶ୍ୟ ଲେଖାହୋଇସାରିଛି ସେଗୁଡ଼ିକ ଯେମିତି ଅଛି ସେମିତି ରହିବ। ଆରମ୍ଭ କରିବାକୁ ବଟନ୍ ଦବାଅ।`,
    addFilm: (a) => `ମୁଁ ତୁମ ଗପ ସହ ମେଳ ଖାଉଥିବା ${a.count} ଟି ନୂଆ ଦୃଶ୍ୟ ଭାବି ସିନ୍ ତାଲିକାରେ ଯୋଡ଼ିପାରିବି। ସେଗୁଡ଼ିକ “ଏଯାଏଁ ଲେଖାହୋଇନାହିଁ” ଭାବେ ଆରମ୍ଭ ହେବ। କରିବାକୁ ବଟନ୍ ଦବାଅ।`,
    allWritten: () => `ଏହି ଫିଲ୍ମର ସବୁ ଦୃଶ୍ୟ ଆଗରୁ ଲେଖା ହୋଇସାରିଛି, ତେଣୁ ଲେଖିବାକୁ କିଛି ବାକି ନାହିଁ। ଆହୁରି ଦୃଶ୍ୟ ଚାହିଁଲେ କୁହ “5 ଦୃଶ୍ୟ ଯୋଡ଼”।`,
    noSceneList: () => `ଏହି ପ୍ରୋଜେକ୍ଟରେ ଏଯାଏଁ କୌଣସି ଅନୁମୋଦିତ ସିନ୍ ତାଲିକା ନାହିଁ, ତେଣୁ ଲେଖିବା କିମ୍ବା ଯୋଡ଼ିବା ପାଇଁ ଦୃଶ୍ୟ ନାହିଁ। ପ୍ରଥମେ Scene One-Liners ପର୍ଯ୍ୟାୟ ସାରାଅ।`,
    agent: (a) => `ମୁଁ ଏହା ବୁଝିଲି: ${a.summary}${a.targets.length ? ` ଏଥିରେ ${a.targets.length} ଟି ଅଂଶ ଛୁଇଁବ: ${a.targets.slice(0, 6).map((t) => t.label).join("; ")}${a.targets.length > 6 ? "…" : ""}।` : ""} ତୁମେ ବଟନ୍ ନ ଦବାଇଲେ କିଛି ବଦଳିବ ନାହିଁ।`,
    clarify: (a) => `ତୁମେ ମୋଠାରୁ କଣ ଚାହୁଁଛ ମୁଁ ଠିକ୍ ବୁଝିପାରିଲି ନାହିଁ। ${a.summary || ""} ଟିକେ ଆଉ କୁହ, କିମ୍ବା ବାଛ: ଏବେକାର ଡ୍ରାଫ୍ଟ ବଦଳାଇବା, ନୂଆ ଡ୍ରାଫ୍ଟ ବନାଇବା, ଅନ୍ୟ ଗୋଟେ ବାଟ ଚେଷ୍ଟା କରିବା, କିମ୍ବା ନୂଆ ଗପ ଆରମ୍ଭ କରିବା।`,
    big: (a) => `${a.summary} ଏହା ଏକ ବଡ଼ ବଦଳ, ତେଣୁ ତୁମେ ପକ୍କା କଲା ପରେ ହିଁ ମୁଁ ଏହାକୁ ଆରମ୍ଭ କରିବି।`,
    write: (dialogue) => `ମୁଁ ପ୍ରତ୍ୟେକ ଅଧୁରା ବିଟ୍ ଲେଖିପାରିବି${dialogue ? ", ପ୍ରତ୍ୟେକ ଦୃଶ୍ୟର ସଂଳାପ ସହିତ" : " (କେବଳ ଦୃଶ୍ୟ, ସଂଳାପ ନୁହେଁ)"} — ଗୋଟିଏ ପରେ ଗୋଟିଏ, ପଛରେ ଚାଲି। ଯେଉଁ ବିଟ୍ ଆଗରୁ ଅନୁମୋଦିତ ଓ ସଂଳାପ ସହିତ ଅଛି, ସେଗୁଡ଼ିକ ଯେମିତି ଅଛି ସେମିତି ରହିବ। ଆରମ୍ଭ କରିବାକୁ ବଟନ୍ ଦବାଅ।`,
    extend: (a) => ({
      which: `କେଉଁ ବିଟ୍‌କୁ ଲମ୍ବା କରିବି? ତାର ନମ୍ବର କୁହ, ଯେମିତି “beat 3”।`,
      missing: `beat ${a.beatIndex + 1} ନାହିଁ (ଫିଲ୍ମରେ ${a.beatCount} ଟି ବିଟ୍ ଅଛି)।`,
      unwritten: `beat ${a.beatIndex + 1} ର ଦୃଶ୍ୟ ଏଯାଏଁ ଲେଖାହୋଇନାହିଁ, ତେଣୁ ଲମ୍ବା କରିବାକୁ କିଛି ନାହିଁ। ପ୍ରଥମେ ତାକୁ ଲେଖ।`,
      notarget: `Beat Sheet ରେ beat ${a.beatIndex + 1} ପାଇଁ କୌଣସି ସମୟ ନାହିଁ, ତେଣୁ ସେ କେତେ ଲମ୍ବା ହେବା ଉଚିତ ମୁଁ ଜାଣିନାହିଁ। ପ୍ରଥମେ Beat Sheet ରେ ତାର ସମୟ ଠିକ୍ କର।`,
      enough: `beat ${a.beatIndex + 1} ରେ ଆଗରୁ ପ୍ରାୟ ${a.writtenMinutes} ମିନିଟ୍ ଅଛି, ଯାହା Beat Sheet ର ${a.targetMinutes} ମିନିଟ୍ ସମୟକୁ ପୂରଣ କରେ। ଆହୁରି ଲମ୍ବା କରିବାକୁ ହେଲେ ପ୍ରଥମେ Beat Sheet ରେ ସମୟ ବଦଳାଅ।`,
      ok: `Beat Sheet ରେ beat ${a.beatIndex + 1} ପାଇଁ ${a.targetMinutes} ମିନିଟ୍ ଅଛି ଓ ଏବେ ପ୍ରାୟ ${a.writtenMinutes} ମିନିଟ୍ ଲେଖା ହୋଇଛି। ମୁଁ ଗପ ସହ ମେଳ ଖାଉଥିବା ଦୃଶ୍ୟ ଯୋଡ଼ି ତାକୁ ${a.targetMinutes} ମିନିଟ୍ ପର୍ଯ୍ୟନ୍ତ ଆଣିପାରିବି${a.askedMinutes && Math.abs(a.askedMinutes - a.targetMinutes) > 0.01 ? ` (ତୁମେ ${a.askedMinutes} କହିଥିଲ; ସମୟ Beat Sheet ଠିକ୍ କରେ)` : ""}। କରିବାକୁ ବଟନ୍ ଦବାଅ।`,
    })[a.why],
  },
};

const FILM_GUIDE = `WHAT THE FILM SCREENS CAN DO (explain it when asked, plainly, never invent a button that is not listed):
- Stages in order: Idea, Story (synopsis), Characters (optional), Three-Act Structure, Scene One-Liners, Screenplay. A film made as a series has its episodes in each.
- Screenplay: every scene is written one by one with "Write this scene"; the Buddy (the 💬 on the voice orb inside a scene) helps with the scene on screen — edits by voice, with Undo. Adu's card "write every scene not written yet" writes all of them in the background, with a progress card and a Stop button.
- "Add N scenes" plans new one-line scenes that fit the story; they start as "not written yet".
- Production Management (separate): script breakdown, shoot schedule, artists and their scripts.
- Drafts: a new draft or an alternative is a copy; the first draft is never changed.
- Everything proposed is shown first; nothing changes until the person presses a button.`;

const BIG = new Set(["NEW_DRAFT", "NEW_STORY", "ALTERNATIVE"]);

// What can really be done for "make beat N longer": the existing Extend adds scenes until the beat reaches ITS OWN time from the Beat Sheet
// (not minutes named in a chat), so the proposal says that time, how much is written, and whether there is anything to add.
const round1 = (n) => Math.round(n * 10) / 10;
export function extendInfo(backfill, beatIndex, askedMinutes) {
  if (beatIndex === null || beatIndex === undefined) return { beatIndex: null, askedMinutes, canExtend: false, needsClarification: true, why: "which" };
  const plot = Array.isArray(backfill?.plot) ? backfill.plot : [];
  const base = { beatIndex, askedMinutes, beatCount: plot.length, needsClarification: false };
  if (!(beatIndex >= 0 && beatIndex < plot.length)) return { ...base, canExtend: false, why: "missing" };
  const beat = backfill?.screenplayBeats?.[beatIndex];
  const scenes = Array.isArray(beat?.scenes) ? beat.scenes : [];
  const writtenMinutes = round1(scenes.reduce((n, s) => n + (Number(s?.estimatedMinutes) || 0), 0));
  const targetMinutes = Number(plot[beatIndex]?.runtimeMinutes) > 0 ? Number(plot[beatIndex].runtimeMinutes) : null;
  const filled = { ...base, writtenMinutes, targetMinutes };
  if (scenes.length === 0 || !["pending", "approved"].includes(beat?.status)) return { ...filled, canExtend: false, why: "unwritten" };
  if (!targetMinutes) return { ...filled, canExtend: false, why: "notarget" };
  if (writtenMinutes >= targetMinutes) return { ...filled, canExtend: false, why: "enough" };
  return { ...filled, canExtend: true, why: "ok" };
}

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
  return `You are Adu, a warm, practical writing friend for a filmmaker working on ${project.guide ? "a film" : "an AI Movie (a film made entirely with AI)"}. Talk like a friend in the editing room: short, clear, kind. The person is not a programmer.

RULES
- Reply in ${LANGUAGE_NAME[language] ?? LANGUAGE_NAME.en}. Keep character and place names as they are written in the story.
- You are only TALKING now: you have changed nothing and you never say you did. If the person wants a change, tell them in a sentence what you would do and that you will show it first.
- Use only the story material below. Never invent story facts, scenes or characters that are not in it. If you do not know, say so.
- Answer the question asked, in a few sentences; no long lists unless asked.

${project.guide ?? GUIDE}

THE PROJECT
Title: ${clip(project.title, 120) || "(untitled)"}
${project.brief ?? `Idea: ${clip(project.pasted_text, 600)}
Story: ${clip(flatten(b.story), 700)}
Synopsis: ${clip(flatten(b.synopsis), 700)}
Beats:
${beatLines(b) || "(the Beat Sheet is not made yet)"}
${sceneInView(b, context)}`}
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

// ---- a film (the Movie side): the same door, its own way of knowing the project
const SCENE_LIST_OF = `SELECT sl.id, sl.content FROM scene_lists sl
  LEFT JOIN bit_sheets bs ON bs.id = sl.bit_sheet_id
  LEFT JOIN three_act_structures tas ON tas.id = bs.three_act_structure_id
  LEFT JOIN pitch_decks pd ON pd.id = tas.pitch_deck_id
  WHERE COALESCE(sl.concept_id, pd.concept_id) = $1 ORDER BY sl.id DESC LIMIT 1`;

const outlineLines = (content) => {
  const rows = [];
  const add = (scene, n, ep) => rows.push(`${ep ? `Ep ${ep}, ` : ""}${n}. ${scene.intExt ?? ""}. ${clip(flatten(scene.location), 40)} - ${scene.timeOfDay ?? ""} — ${clip(flatten(scene.oneLiner), 120)}`);
  if (Array.isArray(content?.episodeScenes)) content.episodeScenes.forEach((e, ei) => (e.scenes ?? []).forEach((sc, i) => add(sc, i + 1, ei + 1)));
  else (content?.scenes ?? []).forEach((sc, i) => add(sc, i + 1, null));
  return rows;
};

export async function filmProject(db, conceptId) {
  const concept = (await db.query("SELECT id, title, concept_text FROM concepts WHERE id = $1", [conceptId])).rows[0];
  if (!concept) return null;
  const units = await draftUnits(db, "film", conceptId);
  const text = (section) => units.filter((u) => u.section === section).map((u) => u.text).join(" ");
  const list = (await db.query(SCENE_LIST_OF, [conceptId])).rows[0];
  const lines = outlineLines(list?.content);
  const written = units.filter((u) => u.section === "screenplay").length;
  const brief = `Idea: ${clip(concept.concept_text, 600)}
Story: ${clip(text("synopsis"), 800)}
Characters: ${clip(units.filter((u) => u.section === "characters").map((u) => u.label).join(", "), 300) || "(not made yet)"}
Structure: ${clip(text("structure"), 500)}
Scenes: ${lines.length} planned, ${written} written${lines.length ? `\n${lines.slice(0, 40).join("\n")}` : " (the scene list is not made yet)"}`;
  return { id: concept.id, title: concept.title, pasted_text: concept.concept_text, backfill: null, brief, guide: FILM_GUIDE, sceneListId: list?.id ?? null, totalScenes: lines.length, writtenScenes: written };
}

// ---- one message, start to finish ---------------------------------------------------------------------------------------------------------------
const row = (r) => ({ id: r.id, role: r.role, content: r.content, action: r.action ?? null, resolved: r.resolved, createdAt: r.created_at });

export async function loadHistory(db, projectId, userId, limit = 100, module = "ai_movie") {
  const rows = (await db.query(
    `SELECT * FROM (SELECT * FROM adu_chat_messages WHERE module = $4 AND project_ref = $1 AND user_id IS NOT DISTINCT FROM $2 ORDER BY id DESC LIMIT $3) latest ORDER BY id ASC`,
    [projectId, userId ?? null, limit, module]
  )).rows;
  return rows.map(row);
}

export async function handleAduMessage(db, models, { projectId, userId = null, text, language = "en", context = {}, module = "ai_movie" }) {
  const said = String(text ?? "").trim();
  if (!said) throw httpError("Write or say something to Adu first.", 400, "empty");
  if (said.length > MAX_TEXT) throw httpError(`That message is too long (most ${MAX_TEXT} characters).`, 400, "too_long");
  const lang = LANGUAGES.includes(language) ? language : "en";
  const project = module === "film" ? await filmProject(db, projectId) : (await db.query("SELECT id, title, pasted_text, backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0];
  if (!project) throw httpError("Project not found.", 404, "not_found");
  const draft = await ensureDraftFor(db, module, projectId, { actorUserId: userId });
  const history = await loadHistory(db, projectId, userId, MEMORY, module);
  const sorted = sortWithoutAi(said, context, { module });

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
      action = { type: "agent", draftId: draft.id, intent: read.intent, instruction: said, summary: read.summary, targets: [], unresolved: read.unresolved ?? [], options: read.allChoices ?? read.options ?? [], needsClarification: true, big: false };
      reply = SAYS[lang].clarify({ summary: read.summary && !/^Interpreted as/i.test(read.summary) ? read.summary : "" });
    } else {
      // when the classifier's model could not be asked, the Agent falls back to the words alone and its summary is only "Interpreted as …": say the person's own words instead
      const summary = /^Interpreted as/i.test(read.summary ?? "") ? `“${clip(said, 140)}”` : read.summary;
      action = {
        type: "agent", draftId: draft.id, intent: read.intent, instruction: said, summary, targets: read.targets ?? [], unresolved: read.unresolved ?? [], candidates: read.candidates ?? [],
        options: read.options ?? [], needsClarification: Boolean(read.needsClarification), constraints: read.constraints ?? {}, big: BIG.has(read.intent), confidence: read.confidence,
      };
      reply = action.needsClarification ? SAYS[lang].clarify(action) : action.big ? SAYS[lang].big(action) : SAYS[lang].agent(action);
    }
  } else if (kind === "write" && module === "film") {
    const a = { total: project.totalScenes, unwritten: Math.max(0, project.totalScenes - project.writtenScenes) };
    if (!project.sceneListId) reply = SAYS[lang].noSceneList();
    else if (a.unwritten === 0) reply = SAYS[lang].allWritten();
    else { action = { type: "write_scenes", module: "film", sceneListId: project.sceneListId, unwritten: a.unwritten, total: a.total }; reply = SAYS[lang].writeFilm(a); }
  } else if (kind === "add" && module === "film") {
    if (!project.sceneListId) reply = SAYS[lang].noSceneList();
    else { action = { type: "add_scenes", module: "film", sceneListId: project.sceneListId, count: sorted.count }; reply = SAYS[lang].addFilm({ count: sorted.count }); }
  } else if (kind === "write") {
    action = { type: "write_all", dialogue: sorted.dialogue };
    reply = SAYS[lang].write(sorted.dialogue);
  } else if (kind === "extend") {
    const info = extendInfo(project.backfill, sorted.beatIndex, sorted.minutes);
    action = { type: "extend_beat", ...info };
    reply = SAYS[lang].extend(info);
  }
  if (kind === "chat") {
    reply = await answerInWords({ db, models, draft, project, history, text: said, language: lang, context });
  }

  // both messages are saved only now: a failed answer leaves nothing half-said, and the person's words stay in the box
  const userRow = (await db.query("INSERT INTO adu_chat_messages (module, project_ref, user_id, role, content) VALUES ($4, $1, $2, 'user', $3) RETURNING *", [projectId, userId, said, module])).rows[0];
  const aduRow = (await db.query("INSERT INTO adu_chat_messages (module, project_ref, user_id, role, content, action) VALUES ($5, $1, $2, 'assistant', $3, $4) RETURNING *", [projectId, userId, reply, action ? JSON.stringify(action) : null, module])).rows[0];
  return { user: row(userRow), assistant: row(aduRow), sortedAs: kind, draftId: draft.id };
}

// the person pressed a card's button (or "no thanks"): the card is remembered as done, so it does not come back after a reload
export async function resolveMessage(db, projectId, userId, { messageId, outcome, module = "ai_movie" }) {
  const done = ["applied", "dismissed"].includes(outcome) ? outcome : "dismissed";
  const updated = (await db.query(
    `UPDATE adu_chat_messages SET resolved = true, action = COALESCE(action, '{}'::jsonb) || jsonb_build_object('outcome', $4::text)
     WHERE id = $1 AND module = $5 AND project_ref = $2 AND user_id IS NOT DISTINCT FROM $3 AND role = 'assistant' RETURNING *`,
    [Number(messageId) || 0, projectId, userId ?? null, done, module]
  )).rows[0];
  if (!updated) throw httpError("That message was not found.", 404, "not_found");
  return row(updated);
}

export async function clearHistory(db, projectId, userId, module = "ai_movie") {
  await db.query("DELETE FROM adu_chat_messages WHERE module = $3 AND project_ref = $1 AND user_id IS NOT DISTINCT FROM $2", [projectId, userId ?? null, module]);
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
  for (const [module, base] of [["ai_movie", "/api/ai-movie/assistant/:projectId"], ["film", "/api/film/assistant/:projectId"]]) {
    app.get(`${base}/history`, admin, wrap(async (req, res) => res.json({ messages: await loadHistory(db, project(req), req.user?.id ?? null, 100, module) })));
    app.delete(`${base}/history`, admin, wrap(async (req, res) => { await clearHistory(db, project(req), req.user?.id ?? null, module); res.json({ ok: true }); }));
    app.post(`${base}/resolve`, admin, wrap(async (req, res) => res.json({ message: await resolveMessage(db, project(req), req.user?.id ?? null, { messageId: req.body?.messageId, outcome: req.body?.outcome, module }) })));
    app.post(`${base}/message`, admin, wrap(async (req, res) => res.json(await handleAduMessage(db, models, {
      projectId: project(req), userId: req.user?.id ?? null, text: req.body?.text, language: req.body?.language, context: req.body?.context && typeof req.body.context === "object" ? req.body.context : {}, module,
    }))));
  }
}
