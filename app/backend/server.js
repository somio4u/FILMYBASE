import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenAI, Type } from "@google/genai";
import { Pool } from "pg";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import path from "path";
import fs from "fs";
import fsPromises from "fs/promises";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import { XMLParser } from "fast-xml-parser";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import { createClient } from "@supabase/supabase-js";

const app = express();
// Render (and most hosts) assign the port dynamically via $PORT — 4000
// stays as the local dev default.
const PORT = process.env.PORT || 4000;
// This backend's own public URL — used to build the Google OAuth redirect
// URI. Defaults to local dev; set to the deployed Render URL in production.
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// DATABASE_URL (a full Postgres connection string, e.g. from Supabase) is
// used when set; otherwise falls back to the local "filmmaking_app" dev
// database. Supabase's pooled connection requires SSL but uses a
// self-signed chain, hence rejectUnauthorized: false.
const db = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : { database: "filmmaking_app" }
);

// The free tier's actual cap is a strict 15 requests/minute for the
// flash-lite model — a burst of parallel calls (a 5-category script
// breakdown re-check, a 14-episode import) can blow through that on its
// own, no other traffic needed. On a 429/503, Gemini tells us exactly how
// long to wait ("retryDelay":"4s" in the error body) — use that number
// directly instead of guessing with a fixed backoff schedule, since a
// guess that's too short just burns another attempt against the same
// window, and one that's too long wastes time once the window has cleared.
function parseRetryDelayMs(errorMessage) {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(errorMessage ?? "");
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

async function generateContentWithRetry(params, { retries = 4, fallbackDelayMs = 2000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (error) {
      const transient = /"code":\s*(429|503)/.test(error.message ?? "");
      if (!transient || attempt >= retries) throw error;
      const delay = parseRetryDelayMs(error.message) ?? fallbackDelayMs * 2 ** attempt;
      console.error(`Gemini call failed (${error.message.slice(0, 100)}...), retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Runs async work over `items` with at most `limit` in flight at once —
// used wherever we'd otherwise Promise.all a whole batch of Gemini calls
// (script breakdown's 5 category re-checks, an N-episode import). Spreads
// the requests out instead of bursting all of them at once, so the 15
// requests/minute free-tier cap has a fighting chance of not being blown
// through in a single instant.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const FONTS_DIR = path.join(import.meta.dirname, "fonts");
const FONTS = {
  odiaRegular: path.join(FONTS_DIR, "NotoSansOriya.ttf"),
  odiaBold: path.join(FONTS_DIR, "NotoSansOriya-Bold.ttf"),
  displayRegular: path.join(FONTS_DIR, "PlayfairDisplay-Regular.ttf"),
  displayBold: path.join(FONTS_DIR, "PlayfairDisplay-Bold.ttf"),
  impact: path.join(FONTS_DIR, "Anton-Regular.ttf"),
};

const STORY_AGENT_SYSTEM_PROMPT = `You are the Story & Screenplay Agent, an experienced story writer and screenwriter specializing in Odia (Odisha) cinema — the dramatic sensibility, family and social dynamics, festivals (Rath Yatra, Nuakhai, Raja), rural and coastal settings, and cultural texture of Odisha, in the tradition of Ollywood rather than generic Hollywood plot patterns.

When given a raw concept, generate 2-3 distinct storyline directions grounded in authentic Odia cultural context (settings, names, relationships, social themes) unless the concept explicitly asks for something else. For each storyline, write the title, logline, and summary in BOTH English and Odia (Odia script) — natural, native-quality Odia phrasing, not a literal word-for-word translation.`;

const PITCH_DECK_SYSTEM_PROMPT = `You are the Story & Screenplay Agent, specializing in Odia (Odisha) cinema. Once a storyline is chosen, format it into a full, producer-ready pitch deck — detailed enough that a producer could actually evaluate and greenlight it, not just a one-line plot summary. Include:
- A one-paragraph premise, the tone/genre, and the target audience.
- 3-5 major characters who actually drive the story (not a full cast list). For each: a name (a proper noun, stays the same in both languages), a short role/descriptor (e.g. "the reluctant elder brother"), their emotional core (what they secretly want or fear beneath the surface), and their central conflict (what stands in their way, internally or externally).
- For a web series, an elaborated synopsis per episode that genuinely establishes the whole episode — what it opens on, the complication that develops through it, and how it turns or ends (ideally on a hook into the next episode) — long enough that someone could actually picture the episode, not just guess its topic from one line.
Keep it grounded in authentic Odia cultural context. Write everything in BOTH English and Odia (Odia script) — natural, native-quality Odia phrasing, not a literal translation.`;

const THREE_ACT_SYSTEM_PROMPT = `You are the Story & Screenplay Agent, specializing in Odia (Odisha) cinema. After producer approval, break the approved story into a three-act structure — Setup, Confrontation, Resolution — with named key beats in each act.

Before the acts, state the story's Controlling Idea (its theme) as ONE precise sentence combining a VALUE and a CAUSE: the value (positive or negative — justice, love, corruption, loyalty, etc.) that the story's ending brings into the world, plus the specific reason the ending turns out that way (e.g. "Loyalty triumphs over greed because Dibakar chooses gratitude over self-preservation"). Derive it by looking at how the Resolution actually plays out — don't pick a generic topic word like "family" or "justice" alone, state the value AND why it happens. This Controlling Idea should then act as a filter: every act, and later every beat and scene, should serve or test this idea, not wander from it.

For a web series, also break down each individual episode into its own mini three-act structure, consistent with that episode's synopsis and with the overall series arc — episodes share the ONE overall Controlling Idea from the whole series, not their own separate themes. Keep it grounded in authentic Odia cultural context. Write everything in BOTH English and Odia (Odia script) — natural, native-quality Odia phrasing, not a literal translation.`;

const CHARACTER_SHEET_SYSTEM_PROMPT = `You are the Story & Screenplay Agent, specializing in Odia (Odisha) cinema. Once a pitch deck is approved, expand its Major Characters into full character sheets — deep enough to write consistent, non-shallow characters from, not just a one-line description.

Keep the SAME names and core roles already established in the pitch deck — you are deepening these characters, not replacing them. You may add at most ONE additional minor-but-necessary character (e.g. an Ally or Threshold Guardian) only if the story genuinely needs one that isn't already covered.

For each character, give:
- archetype: their PRIMARY function in the story, from: hero, mentor, threshold_guardian, herald, shapeshifter, shadow, ally, trickster. Archetypes are functions a character performs, not a fixed personality type — note in archetypeNote if they shift function at any point in the story (e.g. an Ally who briefly acts as a Shapeshifter).
- want: their conscious, stated goal.
- need: the deeper unconscious need or wound actually driving them, often different from what they consciously want.
- flaw: the central flaw that creates their conflict.
- virtues: at least 3 genuine positive qualities — characters need real virtues, not just flaws, to be worth following.
- innerConflict: the internal struggle (a belief, fear, or contradiction within themselves).
- outerConflict: the external obstacle or opposing force (often another character or the situation).
- arc: one sentence describing how they change from beginning to end (A → Z).
- introductionBeat: the SPECIFIC action or moment that should introduce this character on the page — a defining action plus what it reveals, not background description (e.g. "haggling fiercely with a shopkeeper over a few rupees, revealing her pride and poverty" — not "she is poor and proud").
- For the character playing the Shadow/antagonist role specifically, also give heroLogline: a one-line logline of THEIR OWN story, as if they were the hero of it — a shallow villain is just an obstacle; a real one believes they're right.

Keep everything grounded in authentic Odia cultural context. Write all text fields in BOTH English and Odia (Odia script) — natural, native-quality Odia phrasing, not a literal translation. Character names stay the same proper noun in both languages.`;

const BIT_SHEET_SYSTEM_PROMPT = `You are the Story & Screenplay Agent, specializing in Odia (Odisha) cinema. Once a three-act structure is locked, break it into a Bit Sheet — a more granular, beat-by-beat list of the story's major plot points, sitting between the high-level three-act structure and the scene-by-scene breakdown that comes after it.

Each bit is one significant story beat, labeled with one of these beat types. Most types (catalyst, reveal, midpoint, setback, turning_point) can appear as many times as the story needs. But a specific small set are STRUCTURAL ANCHORS — always include exactly ONE of each, even in a short Bit Sheet, at the position described:
- "opening_image": the very FIRST bit in the whole list — a snapshot of the hero/world "before," establishing tone and what will change.
- "theme_stated": early in Act 1 — a moment (often a side character's remark) that states, out loud or through action, the story's underlying thematic argument, planted so it pays off later.
- "plot_point_1": the LAST bit of Act 1 — the specific incident that hooks into the story and spins it into Act 2. Exactly one per Bit Sheet, never a generic mid-act turn.
- "all_is_lost": late in Act 2 or the start of Act 3 — a true low point distinct from an ordinary "setback," where the protagonist's old approach completely fails (often a symbolic "death" of the old way).
- "plot_point_2": the LAST bit of Act 2 — the incident that launches the final push into Act 3. Exactly one per Bit Sheet.
- "final_image": the very LAST bit in the whole list — a mirror or opposite of the opening_image, proving the change that occurred.

The CLIMAX is not one isolated bit — it is a short SEQUENCE of exactly three connected structural anchors, always in this order, near the end of Act 3:
- "crisis": the protagonist's hardest choice — a genuine dilemma between two costly options (never an obvious right/wrong pick), and it should connect back to what the catalyst set in motion.
- "climax": the action or choice that resolves the crisis, delivering an IRREVERSIBLE value swing (a clear flip from positive to negative or negative to positive — not a mild, partial win).
- "realization": immediately after the climax — the character's explicit, visible moment of KNOWING they've changed, distinct from just narrating the outcome. This is not the same as "resolution_beat" (which handles the leftover plot threads afterward).
The SHAPE of this climax sequence should match the story's own tone and genre — don't force one template onto every story. An action, thriller, or sports story often builds through raised stakes and a direct confrontation between the protagonist and their opposition. A family, moral, or devotional story may instead resolve through a convergence of several character threads arriving at one shared event, or through an authority/institution delivering a judgment or consequence, rather than a physical showdown. Pick whichever shape genuinely fits this specific story.

For each bit, give which act it belongs to, which beat type best describes it, a short title, and a one-to-two sentence description of what happens. Keep it grounded in authentic Odia cultural context. Write the title and description in BOTH English and Odia (Odia script) — natural, native-quality Odia phrasing, not a literal translation.`;

const SCENE_SYSTEM_PROMPT = `You are the Story & Screenplay Agent, specializing in Odia (Odisha) cinema. Once a Bit Sheet is approved, expand it into a full scene-by-scene list: each major plot-point bit typically becomes 1-3 scenes. For each scene, give which act it belongs to, a scene heading (interior or exterior, a location, and time of day), a single-sentence one-liner describing what happens, and your best estimate of that scene's on-screen duration in minutes. The "location" field must be JUST the place name (e.g. "Cuttack Street Market") — never include "DAY", "NIGHT", "DAWN", or any time-of-day wording in it, since time of day is always its own separate field limited to exactly DAY or NIGHT (use DAY for dawn/dusk). You will always be given a target total runtime — the combined duration of all the scenes you generate must add up to approximately that target; never limit the number of scenes to an arbitrary small count when the target runtime calls for more. Vary individual scene lengths realistically (quick transitional or action beats might be 0.5-1 minute, pivotal dialogue or emotional scenes might run 3-5 minutes) rather than making every scene the same length. When given the story's Controlling Idea (theme), keep every scene consistent with it — a scene that contradicts or ignores the theme entirely usually doesn't belong. Keep locations, character actions, and cultural texture grounded in authentic Odia settings.

EVERY scene must also genuinely earn its place. For each scene, also give:
- "purpose": either "plot_advancing" (the scene's main job is to move the story forward) or "character_revealing" (the scene's main job is to show who a character really is under pressure). Pick whichever is the scene's true primary job — a scene that does neither doesn't belong in the list.
- "turn": a short phrase naming the scene's value-shift — what changes emotionally or dramatically from the start of the scene to its end (e.g. "trust turns to suspicion," "despair turns to resolve," "confidence turns to fear"). A scene with no real turn is usually flat; reconsider it rather than forcing a fake one.

Write the location name, one-liner, and turn in BOTH English and Odia (Odia script) — natural, native-quality Odia phrasing, not a literal translation.`;

const BILINGUAL_TEXT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    en: { type: Type.STRING },
    or: { type: Type.STRING },
  },
  required: ["en", "or"],
};

const ACT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: BILINGUAL_TEXT_SCHEMA,
    beats: { type: Type.ARRAY, items: BILINGUAL_TEXT_SCHEMA },
  },
  required: ["summary", "beats"],
};

// A major character on the pitch deck — enough to actually establish who
// drives the story, not a full cast list. Name is a proper noun and stays
// the same in both languages.
const CHARACTER_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    role: BILINGUAL_TEXT_SCHEMA,
    emotionalCore: BILINGUAL_TEXT_SCHEMA,
    conflict: BILINGUAL_TEXT_SCHEMA,
  },
  required: ["name", "role", "emotionalCore", "conflict"],
};

const CHARACTER_ARCHETYPES = [
  "hero",
  "mentor",
  "threshold_guardian",
  "herald",
  "shapeshifter",
  "shadow",
  "ally",
  "trickster",
];

const CHARACTER_SHEET_ENTRY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    archetype: { type: Type.STRING, enum: CHARACTER_ARCHETYPES },
    archetypeNote: BILINGUAL_TEXT_SCHEMA,
    role: BILINGUAL_TEXT_SCHEMA,
    want: BILINGUAL_TEXT_SCHEMA,
    need: BILINGUAL_TEXT_SCHEMA,
    flaw: BILINGUAL_TEXT_SCHEMA,
    virtues: { type: Type.ARRAY, items: BILINGUAL_TEXT_SCHEMA },
    innerConflict: BILINGUAL_TEXT_SCHEMA,
    outerConflict: BILINGUAL_TEXT_SCHEMA,
    arc: BILINGUAL_TEXT_SCHEMA,
    introductionBeat: BILINGUAL_TEXT_SCHEMA,
    heroLogline: BILINGUAL_TEXT_SCHEMA,
  },
  required: [
    "name",
    "archetype",
    "archetypeNote",
    "role",
    "want",
    "need",
    "flaw",
    "virtues",
    "innerConflict",
    "outerConflict",
    "arc",
    "introductionBeat",
  ],
};

const BIT_BEAT_TYPES = [
  "opening_image",
  "theme_stated",
  "catalyst",
  "reveal",
  "plot_point_1",
  "midpoint",
  "setback",
  "all_is_lost",
  "plot_point_2",
  "crisis",
  "climax",
  "realization",
  "turning_point",
  "resolution_beat",
  "final_image",
];

const BIT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    actNumber: { type: Type.INTEGER },
    beatType: { type: Type.STRING, enum: BIT_BEAT_TYPES },
    title: BILINGUAL_TEXT_SCHEMA,
    description: BILINGUAL_TEXT_SCHEMA,
  },
  required: ["actNumber", "beatType", "title", "description"],
};

const SCENE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    actNumber: { type: Type.INTEGER },
    intExt: { type: Type.STRING, enum: ["INT", "EXT"] },
    location: BILINGUAL_TEXT_SCHEMA,
    timeOfDay: { type: Type.STRING, enum: ["DAY", "NIGHT"] },
    oneLiner: BILINGUAL_TEXT_SCHEMA,
    estimatedMinutes: { type: Type.NUMBER },
    purpose: { type: Type.STRING, enum: ["plot_advancing", "character_revealing"] },
    turn: BILINGUAL_TEXT_SCHEMA,
  },
  required: ["actNumber", "intExt", "location", "timeOfDay", "oneLiner", "estimatedMinutes", "purpose", "turn"],
};

// A single scene reference within a shoot day — points back at one entry in
// the already-generated scene list by position, rather than duplicating its
// content. For a film, the episodeIndex field is left out of the schema
// entirely (not just optional) so the model has no way to hallucinate an
// episode number for a project that was never structured into episodes.
function sceneRefSchema(isSeries) {
  return {
    type: Type.OBJECT,
    properties: isSeries
      ? { episodeIndex: { type: Type.INTEGER }, sceneIndex: { type: Type.INTEGER } }
      : { sceneIndex: { type: Type.INTEGER } },
    required: isSeries ? ["episodeIndex", "sceneIndex"] : ["sceneIndex"],
  };
}

function shootDaySchema(isSeries) {
  return {
    type: Type.OBJECT,
    properties: {
      dayNumber: { type: Type.INTEGER },
      date: { type: Type.STRING },
      location: BILINGUAL_TEXT_SCHEMA,
      sceneRefs: { type: Type.ARRAY, items: sceneRefSchema(isSeries) },
      // Which major characters (by name, from the cast list given in the
      // prompt) are actually needed on set this day — this is what makes an
      // artist-wise call schedule ("how many days is Judge Swain needed")
      // computable afterward, instead of just a bag of scenes per day.
      charactersNeeded: { type: Type.ARRAY, items: { type: Type.STRING } },
      notes: BILINGUAL_TEXT_SCHEMA,
    },
    required: ["dayNumber", "location", "sceneRefs", "charactersNeeded", "notes"],
  };
}

// A generic "item + notes" shape reused for props, art/set-dressing, and the
// enriched artist list — a name/label plus a short bilingual note on how or
// where it's used, not a full structured record for each one.
const BREAKDOWN_ITEM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    label: { type: Type.STRING },
    notes: BILINGUAL_TEXT_SCHEMA,
  },
  required: ["label", "notes"],
};

const BREAKDOWN_LOCATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    location: BILINGUAL_TEXT_SCHEMA,
    intExt: { type: Type.STRING, enum: ["INT", "EXT"] },
    sceneCount: { type: Type.INTEGER },
    notes: BILINGUAL_TEXT_SCHEMA,
  },
  required: ["location", "intExt", "sceneCount", "notes"],
};

const BREAKDOWN_COSTUME_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    character: { type: Type.STRING },
    description: BILINGUAL_TEXT_SCHEMA,
  },
  required: ["character", "description"],
};

const BREAKDOWN_CATEGORY_KEYS = ["artistList", "locationList", "props", "costumes", "art"];

const BREAKDOWN_CATEGORY_ITEM_SCHEMAS = {
  artistList: BREAKDOWN_ITEM_SCHEMA,
  locationList: BREAKDOWN_LOCATION_SCHEMA,
  props: BREAKDOWN_ITEM_SCHEMA,
  costumes: BREAKDOWN_COSTUME_SCHEMA,
  art: BREAKDOWN_ITEM_SCHEMA,
};

const BREAKDOWN_CATEGORY_DESCRIPTIONS = {
  artistList: "every character who appears, each with a short bilingual note on their overall involvement (how central they are, roughly how many scenes, anything schedule-relevant)",
  locationList: "every distinct physical location as its OWN separate entry, each with INT/EXT, how many scenes happen there, and a short bilingual note — NEVER bundle multiple different named places into one combined/vague entry (e.g. never write \"Various Locations\" or \"Village (various)\" as a single item covering several places); even a location that appears only once or briefly (a flashback, a single shot) still gets its own entry",
  props: "every significant PROPERTY (an object a character handles or that's plot-relevant — a letter, a weapon, a phone, a specific vehicle) — not generic background objects",
  costumes: "for each major character, a short bilingual description of their costume and any costume changes across the story",
  art: "ART DEPARTMENT / set-dressing needs — anything the location needs to be dressed or built for",
};

const SCREENPLAY_SYSTEM_PROMPT = `You are the Story & Screenplay Agent, specializing in Odia (Odisha) cinema — and, for dialogue specifically, an expert Odia dialogue writer and script supervisor ("Script Doctor") whose job is to make every line sound like real spoken Odia, never a textbook. Once the scene list is approved, expand ONE scene at a time into full screenplay format — action lines describing what's seen/heard, and dialogue attributed to a named character — using standard screenplay conventions. Write scene-by-scene, never the whole film at once.

CHALITA BHASHA, NOT SADHU BHASHA — this is the single most important rule for dialogue. Write natural, spoken, colloquial Odia (Chalita Bhasha), never formal/literary/Sanskritized Odia (Sadhu Bhasha), and never a stiff literal translation from English:
- Always reach for the local, everyday word over the Sanskritized/formal one. For example: "ଗ୍ରହଣ କରନ୍ତୁ" (Grahana Karantu) → "ନିଅ" (Nia) or "ଧର" (Dhara); "ପ୍ରସ୍ଥାନ କରିବା" (Prasthana Kariba) → "ବାହାରିବା" (Bahariba) or "ଯିବା" (Jiba); "ବାର୍ତ୍ତାଳାପ" (Bartalapa) → "କଥାବାର୍ତ୍ତା" (Kathabarta); "କ୍ରୋଧିତ" (Krodhita) → "ରାଗି" (Ragi). This applies throughout — nouns, adjectives, and verbs alike.
- Verb endings must match WHO is talking to WHOM, not default to the formal/respectful form for everyone. Toward an elder, a boss, or anyone owed respect, the respectful ଛନ୍ତି/କରନ୍ତି form is correct. But toward a friend, a junior, a child, or in most intimate family address, use the casual ଛି/ଛୁ/ଛ form instead ("କରୁଛନ୍ତି" → "କରୁଛି"/"କରୁଛ"/"କରୁଛୁ" depending on who's speaking to whom) — an AI default of "ଛନ୍ତି" for every single line is exactly the textbook-Odia mistake to avoid.
- Sentences are often short, broken, and imperfect — trailing off, repeating a word for emphasis, talking over each other — the way people actually speak, not complete grammatical sentences.
- EVERY LINE MUST CARRY EMOTION, NOT JUST INFORMATION. Never write dialogue as flat, cut-to-cut information-passing (character A states a fact, character B states the next fact). Real people hesitate, deflect, repeat themselves, ask questions instead of answering, or say something adjacent to what they mean when they're upset, scared, or holding something back. Preserve every beat of drama already established in the scene's one-liner and turn — do not summarize or compress it into fewer, flatter lines.
- Natural code-switching with English is common and should be used wherever a character genuinely would: urban, educated, or younger characters casually drop English words or whole phrases into an Odia sentence (a workplace term, a brand or app name, "seriously", "what a taste", or everyday loanwords like "ରୁମ୍", "ବ୍ୟାଗ୍", "ଅଙ୍କଲ୍"); older, rural, or working-class characters use little to no English and lean on regional idiom instead.
- Speech register must match the character: a security guard, a strict grandmother, a nagging in-law, joking office colleagues, and a frightened teenager should all sound distinctly different from each other in vocabulary, formality, and rhythm — never one uniform "polite Odia" voice for everyone.
- Family and social relationship terms (Ma, Bapa, Bhai, Kaka, Mausi, Thakuma, or their Odia equivalents) get used constantly in address, more often than actual names.
- Tense or emotional dialogue tends to get clipped and urgent rather than eloquent.

IMPORTANT — script, not Romanization: many real Odia shooting scripts write dialogue in Romanized/transliterated Odia (Latin letters, e.g. "Kana kahuchhanti") for on-set convenience. Do NOT do that here. The Odia field must always be written in actual Odia (Oriya) script (ଓଡ଼ିଆ), never Romanized. Code-switching means an occasional English word or short phrase embedded naturally INSIDE an Odia-script sentence (e.g. "ମୋତେ ସିରିଅସ୍ଲି କାହିଁକି ଡରାଉଛୁ?") — it does not mean writing whole sentences in Latin letters.

A character's name is a proper noun and stays the same in both languages. Action lines should be visual and concise, present tense, no camera angles or editing directions like "ANGLE ON" or "CLOSE ON". Write the action lines and dialogue text itself in BOTH English and Odia — the Odia side should carry all of the natural texture above (colloquial grammar, code-switching, register) while staying in Odia script, and the English side stays smoothly readable as a natural equivalent, not a stiff word-for-word crutch. Stay consistent with any character names and voice already established in earlier scenes you're shown.

Use "characterModifier" on a dialogue element when it genuinely applies: "CONT'D" if the same character keeps speaking after a brief action beat interrupted them without leaving the scene, "O.S." if they're heard but not seen on screen, "V.O." for narration, an inner thought, or a phone/recording voice, "ECHOING" for a remembered line from a past scene or a character who isn't physically present, replaying in another character's mind (distinct from V.O. — this is specifically a memory echoing back, not present-tense narration). Use "none" otherwise — most dialogue needs no modifier.

You may add a "flashback" element when a brief memory genuinely intrudes on the present scene: give "character" as whose POV/memory it is, and "text" describing what's remembered (rendered as "FLASH - [CHARACTER]'S POV:" followed by the description) — the description itself should still follow all the Odia rules above. An ECHOING dialogue element often follows a flashback element, giving voice to what's being remembered. You may also add ONE "transition" element (text like "CUT TO:", "CUT FLASH:", "TRANSITION SHOT.", "MATCH CUT TO:", or "DISSOLVE TO:") at the very end of a scene's elements, but only when a specific transition is dramatically meaningful, not as routine punctuation on every scene. Transition text is a technical screenplay marker, not translatable content — put the EXACT SAME English term in both the "en" and "or" fields (e.g. both read "CUT TO:"), never translate it into Odia words, matching how real Odia shooting scripts keep these terms in English.`;

const SCRIPT_BREAKDOWN_SYSTEM_PROMPT = `You are an experienced Assistant Director / Script Supervisor performing a professional SCRIPT BREAKDOWN — the standard pre-scheduling analysis every production does once a script is locked, reading it closely for everything the production team needs to plan for. You are precise and thorough, not creative — extract what's actually in the script, don't invent story content.

Read the full scene-by-scene material given and produce five separate lists:
- "artistList": every character who appears, each with a short bilingual note on their overall involvement (how central they are, roughly how many scenes, anything schedule-relevant like "appears only in exterior scenes").
- "locationList": every distinct physical location as its OWN separate entry, each with INT/EXT, how many scenes happen there, and a short bilingual note (e.g. "needs to be dressed as a rundown temple courtyard"). List EVERY distinct place separately, however briefly it appears (including a flashback or a single shot) — NEVER combine multiple different named locations into one vague catch-all entry like "Various Locations" or "Village (various)".
- "props": every significant PROPERTY (an object a character handles or that's plot-relevant — a letter, a weapon, a phone, a specific vehicle) — not generic background objects. Each with a short bilingual note on which scene(s)/context it's needed in.
- "costumes": for each major character, a short bilingual description of their costume and any COSTUME CHANGES across the story (e.g. "starts in worn work clothes, changes to a clean kurta for the temple scene in Act 3").
- "art": ART DEPARTMENT / set-dressing needs — anything the location needs to be dressed or built for (signage, furniture, decorations, damage/wear, festival decor) — each with a short bilingual note.
Be thorough but only include things actually implied by the material — don't pad the lists with generic guesses. Write all bilingual fields in BOTH English and Odia (Odia script) — natural, native-quality Odia phrasing, not a literal translation. Character/prop/costume names stay as proper nouns, unchanged across both languages.`;

const PRODUCTION_SYSTEM_PROMPT = `You are the Production Management Agent, working with the Production Manager (and eventually the Producer) inside a filmmaking production platform. You think in logistics, budgets, availability, and constraints — the way an experienced line producer or production manager would. Your work is logistics and math-heavy, not creative — be precise and clear rather than exploratory.

Given the full scene list and major characters, plus availability information for each character and each location (some may be marked "unknown" — for those, just estimate reasonably rather than blocking), propose a day-by-day shoot schedule:
- Group scenes efficiently by shared location first — minimize how many times the unit has to move locations — then by which characters/artists are needed, respecting any availability windows given.
- Infer which major characters likely appear in each scene from its one-liner and location (you are not given an explicit cast list per scene) — use this to check for scheduling conflicts, not to invent new plot content.
- If availability data creates a genuine scheduling conflict (a location and a needed character's windows don't overlap, or an "unknown" estimate looks risky), say so PLAINLY in the "conflicts" list — never quietly produce an optimistic-looking schedule that papers over a real problem.
- Give each shoot day a short bilingual "notes" line explaining the grouping logic or anything the production team should know (e.g. "all Kamini's scenes at the temple location, grouped to shoot back-to-back given her limited window").
- Number days sequentially starting from 1. A single location's scenes don't have to be one single day if there are too many for one day — split across consecutive days when needed, but keep the same location grouped on consecutive days rather than scattering it.
- You will be given a TARGET number of shoot days the Production Manager wants to fit within. Try genuinely to fit the schedule into that many days by grouping efficiently — but if it's truly not feasible given the amount of material, say so PLAINLY in the "conflicts" list (e.g. "this needs at least 9 days at a realistic pace; compressing to 6 would require cutting scenes or very long days") rather than silently padding or rushing the schedule to hit the number.
Write bilingual fields (location names, notes, conflicts) in BOTH English and Odia (Odia script) — natural, native-quality Odia phrasing, not a literal translation.`;

const SCREENPLAY_ELEMENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    type: { type: Type.STRING, enum: ["action", "dialogue", "transition", "flashback"] },
    character: { type: Type.STRING },
    characterModifier: { type: Type.STRING, enum: ["none", "CONT'D", "O.S.", "V.O.", "ECHOING"] },
    parenthetical: BILINGUAL_TEXT_SCHEMA,
    text: BILINGUAL_TEXT_SCHEMA,
  },
  required: ["type", "text"],
};

// Gemini occasionally slips a stray character from an unrelated Indic or
// Arabic script into an otherwise-correct Odia sentence (e.g. a Devanagari
// letter in the middle of an Odia word). Odia script itself only occupies
// U+0B00-U+0B77, so anything from these OTHER script blocks inside an "or"
// field is always a mistake — strip it out and tidy up the resulting spacing.
// The Devanagari range deliberately excludes U+0964/U+0965 (danda / double
// danda, "।" "॥") since that punctuation is shared across Indic scripts and
// is the normal Odia full stop too — stripping it would break every sentence.
const FOREIGN_SCRIPT_REGEX = new RegExp(
  "[" +
    "؀-ۿ" + // Arabic
    "ऀ-ॣ" + // Devanagari (up to just before danda)
    "०-ॿ" + // Devanagari (just after double danda)
    "ঀ-৿" + // Bengali/Assamese
    "਀-੿" + // Gurmukhi
    "઀-૿" + // Gujarati
    "஀-௿" + // Tamil
    "ఀ-౿" + // Telugu
    "ಀ-೿" + // Kannada
    "ഀ-ൿ" + // Malayalam
    "]",
  "g"
);

// The mirror-image mistake: a stray character from Odia or some other
// non-Latin script leaking into an otherwise-correct ENGLISH sentence (seen
// twice in testing — a Hebrew letter, then an Odia letter, both mid-word in
// an "en" field). English should be plain Latin script, so anything outside
// standard ASCII, a small set of accented Latin letters (for names), and a
// few common "smart" punctuation marks Gemini legitimately uses is a mistake.
const EN_FOREIGN_SCRIPT_REGEX = /[^\x00-\x7FÀ-ſ‘’“”–—…]/g;

function sanitizeBilingualContent(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeBilingualContent);
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === "or" && typeof val === "string") {
        result[key] = val.replace(FOREIGN_SCRIPT_REGEX, "").replace(/ {2,}/g, " ").trim();
      } else if (key === "en" && typeof val === "string") {
        result[key] = val.replace(EN_FOREIGN_SCRIPT_REGEX, "").replace(/ {2,}/g, " ").trim();
      } else {
        result[key] = sanitizeBilingualContent(val);
      }
    }
    return result;
  }
  return value;
}

const SECTION_LABELS = {
  en: {
    premise: "Premise",
    toneGenre: "Tone / Genre",
    targetAudience: "Target Audience",
    majorCharacters: "Major Characters",
    emotionalCore: "Emotional Core",
    conflict: "Conflict",
    episode: "Episode",
    thankYou: "Thank You",
    tagline: "AN ODIA STORY PRESENTATION",
  },
  or: {
    premise: "ପ୍ରସଙ୍ଗ",
    toneGenre: "ଶୈଳୀ / ଧାରା",
    targetAudience: "ଲକ୍ଷ୍ୟ ଦର୍ଶକ",
    majorCharacters: "ମୁଖ୍ୟ ଚରିତ୍ର",
    emotionalCore: "ଭାବନାତ୍ମକ ମୂଳ",
    conflict: "ସଂଘର୍ଷ",
    episode: "ପର୍ବ",
    thankYou: "ଧନ୍ୟବାଦ",
    tagline: "ଏକ ଓଡ଼ିଆ କାହାଣୀ ଉପସ୍ଥାପନା",
  },
};

// Picks a color theme based on keywords in the AI-generated tone/genre text.
// A simple heuristic, not a full design system — good enough to make each
// pitch deck feel visually distinct from a genre-neutral default.
function pickTheme(toneGenreEnglish) {
  const text = toneGenreEnglish.toLowerCase();
  if (/thriller|suspense|crime|mystery|noir/.test(text)) {
    return { bg: "#170F0E", panel: "#1F1412", accent: "#D0453A" };
  }
  if (/comedy|light-hearted|humor|satire/.test(text)) {
    return { bg: "#0E2224", panel: "#132C2E", accent: "#FF8A5C" };
  }
  if (/romance|romantic/.test(text)) {
    return { bg: "#1E1022", panel: "#26142A", accent: "#E8577E" };
  }
  if (/drama|family|emotional|social/.test(text)) {
    return { bg: "#1D130F", panel: "#251A14", accent: "#D9A441" };
  }
  return { bg: "#12161A", panel: "#182022", accent: "#2FBBA6" };
}

function formatLabel(format, lang) {
  if (format?.type === "series") {
    const count = format.episodeCount ?? "?";
    const minutes = format.episodeMinutes ?? "?";
    return lang === "or"
      ? `ୱେବ ସିରିଜ୍ · ${count} ପର୍ବ × ${minutes} ମିନିଟ୍ ପ୍ରତି`
      : `WEB SERIES · ${count} EPISODES × ${minutes} MIN EACH`;
  }
  return lang === "or" ? "ପୂର୍ଣ୍ଣ ଚଳଚ୍ଚିତ୍ର" : "FEATURE FILM";
}

// A specific origin (not "*") is required once login uses cookies —
// browsers refuse to send/accept credentialed cross-origin cookies with a
// wildcard origin. FRONTEND_URL will be the deployed Vercel URL in
// production; defaults to the local Vite dev server.
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(cookieParser());
// A pasted-in screenplay (the /import-screenplay-for-production text route)
// can easily run past Express's 100kb default — a real feature-length or
// multi-episode script routinely does.
app.use(express.json({ limit: "10mb" }));

// Crew/cast photos: local disk in dev (zero setup, served back out via
// /uploads/<file> below), Supabase Storage once SUPABASE_URL/SERVICE_KEY
// are set — required in production, since Render's free tier has no
// persistent disk and would silently lose every photo on the next deploy
// or restart. photo_path in the database is just the bare filename either
// way, so the two modes are interchangeable at the DB layer.
const UPLOADS_DIR = path.join(import.meta.dirname, "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOADS_DIR));

const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "crew-photos";
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null;

const MIME_TYPES_BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };

async function savePhotoBuffer(buffer, originalName) {
  const ext = (path.extname(originalName) || ".jpg").toLowerCase();
  const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

  if (supabase) {
    const { error } = await supabase.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .upload(filename, buffer, { contentType: MIME_TYPES_BY_EXT[ext] || "application/octet-stream" });
    if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`);
  } else {
    await fsPromises.writeFile(path.join(UPLOADS_DIR, filename), buffer);
  }

  return filename;
}

async function deletePhoto(filename) {
  if (!filename) return;
  if (supabase) {
    await supabase.storage.from(SUPABASE_STORAGE_BUCKET).remove([filename]).catch(() => {});
  } else {
    await fsPromises.unlink(path.join(UPLOADS_DIR, filename)).catch(() => {});
  }
}

// Always a fully-qualified URL — Supabase Storage only ever hands out
// absolute URLs, so the local-disk branch matches that shape too (rather
// than a bare "/uploads/..." the frontend would have to know to prefix
// with BACKEND_URL only sometimes).
function photoUrlFor(filename) {
  if (!filename) return null;
  if (supabase) {
    return supabase.storage.from(SUPABASE_STORAGE_BUCKET).getPublicUrl(filename).data.publicUrl;
  }
  return `${BACKEND_URL}/uploads/${filename}`;
}

// --- Auth: real named logins so the app can tell people apart and enforce
// different permissions per role, instead of one shared link everyone uses
// identically. Sessions are a random token in an httpOnly cookie, looked up
// against the sessions table — no JWT library needed for this scale.
const SESSION_COOKIE = "session_token";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expectedHash, "hex"));
}

async function getCurrentUser(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;

  const result = await db.query(
    `SELECT u.id, u.name, u.username, u.role, u.concept_id FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  return result.rows[0] ?? null;
}

// Attaches req.user (or leaves it null) — used on every route so handlers
// can check who's asking without repeating the lookup.
app.use(async (req, res, next) => {
  req.user = await getCurrentUser(req);
  next();
});

// Wrap a route handler to require the caller be logged in as one of the
// given roles — 401 if not logged in at all, 403 if logged in as the wrong
// role. This is the actual enforcement; the frontend hiding a button is
// just a convenience, never the real gate.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: "Please log in." });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "You don't have permission to do that." });
      return;
    }
    next();
  };
}

// Just "must be logged in as someone" — for read routes that expose real
// project data. Once this is deployed on a public URL, an unauthenticated
// GET to e.g. /api/concepts/:id/full would otherwise hand out the whole
// project to anyone with the link.
const requireLogin = requireRole("admin", "director", "production_manager");

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;

  const result = await db.query("SELECT * FROM users WHERE username = $1", [username?.toLowerCase()]);
  const user = result.rows[0];

  if (!user || !verifyPassword(password ?? "", user.password_salt, user.password_hash)) {
    res.status(401).json({ error: "Incorrect username or password." });
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await db.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)", [token, user.id, expiresAt]);

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    expires: expiresAt,
  });
  res.json({ name: user.name, username: user.username, role: user.role, conceptId: user.concept_id });
});

app.post("/api/auth/logout", async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await db.query("DELETE FROM sessions WHERE token = $1", [token]);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => {
  res.json(req.user ? { name: req.user.name, username: req.user.username, role: req.user.role, conceptId: req.user.concept_id } : null);
});

// Admin-only: create and list the named logins for people this project
// gets shared with (director, production manager, ...).
app.post("/api/auth/users", requireRole("admin"), async (req, res) => {
  const { name, username, password, role, conceptId } = req.body;

  if (!name || !username || !password || !["director", "production_manager", "admin"].includes(role)) {
    res.status(400).json({ error: "Name, username, password, and a valid role are required." });
    return;
  }
  // Non-admin logins are scoped to exactly one project — a team account
  // with no assignment would otherwise see every project in the system.
  if (role !== "admin" && !conceptId) {
    res.status(400).json({ error: "Director and Production Manager accounts must be assigned to a project." });
    return;
  }

  const { hash, salt } = hashPassword(password);
  try {
    const result = await db.query(
      "INSERT INTO users (name, username, password_hash, password_salt, role, concept_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, username, role, concept_id",
      [name, username.toLowerCase(), hash, salt, role, role === "admin" ? null : conceptId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      res.status(400).json({ error: "That username is already taken." });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.get("/api/auth/users", requireRole("admin"), async (req, res) => {
  const result = await db.query(
    `SELECT u.id, u.name, u.username, u.role, u.concept_id, u.created_at, c.title AS project_title
     FROM users u LEFT JOIN concepts c ON c.id = u.concept_id
     ORDER BY u.created_at ASC`
  );
  res.json(result.rows);
});

app.delete("/api/auth/users/:id", requireRole("admin"), async (req, res) => {
  await db.query("DELETE FROM users WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is alive" });
});

app.post("/api/generate-storylines", requireRole("admin"), async (req, res) => {
  const { concept, format } = req.body;

  const formatInstruction =
    format?.type === "series"
      ? `Format: web series, ${format.episodeCount ?? "several"} episodes of ${format.episodeMinutes ?? "~25"} minutes each — shape each storyline direction so it can sustain a multi-episode arc, not just a single-sitting story.`
      : `Format: feature film, target runtime ${format?.runtimeMinutes ?? "~90"} minutes.`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-flash-lite-latest",
      contents: `Movie concept: ${concept}\n${formatInstruction}`,
      config: {
        systemInstruction: STORY_AGENT_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            storylines: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: BILINGUAL_TEXT_SCHEMA,
                  logline: BILINGUAL_TEXT_SCHEMA,
                  summary: BILINGUAL_TEXT_SCHEMA,
                },
                required: ["title", "logline", "summary"],
              },
            },
          },
          required: ["storylines"],
        },
      },
    });

    const parsed = sanitizeBilingualContent(JSON.parse(response.text));

    const insertResult = await db.query(
      "INSERT INTO concepts (concept_text, storylines) VALUES ($1, $2) RETURNING id",
      [concept, JSON.stringify(parsed.storylines)]
    );

    res.json({ conceptId: insertResult.rows[0].id, ...parsed });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/concepts/latest", requireLogin, async (req, res) => {
  const result = await db.query(
    "SELECT id, concept_text, storylines FROM concepts ORDER BY created_at DESC LIMIT 1"
  );

  if (result.rows.length === 0) {
    res.json(null);
    return;
  }

  res.json({
    conceptId: result.rows[0].id,
    concept: result.rows[0].concept_text,
    storylines: result.rows[0].storylines,
  });
});

// Lists every project (one row per generated concept), pinned first then newest — powers the sidebar History list.
app.get("/api/concepts", requireLogin, async (req, res) => {
  // A non-admin login is scoped to exactly one project — otherwise a team
  // account would browse every project in the system, not just the one
  // they were assigned to.
  const result =
    req.user.role === "admin"
      ? await db.query("SELECT id, concept_text, title, pinned, project_type, created_at FROM concepts ORDER BY pinned DESC, created_at DESC")
      : await db.query(
          "SELECT id, concept_text, title, pinned, project_type, created_at FROM concepts WHERE id = $1 ORDER BY pinned DESC, created_at DESC",
          [req.user.concept_id]
        );

  res.json(
    result.rows.map((row) => ({
      id: row.id,
      conceptText: row.concept_text,
      title: row.title,
      pinned: row.pinned,
      projectType: row.project_type,
      createdAt: row.created_at,
    }))
  );
});

app.post("/api/concepts/:id/title", requireRole("admin", "production_manager"), async (req, res) => {
  const { title } = req.body;

  if (req.user.role !== "admin" && String(req.user.concept_id) !== String(req.params.id)) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const result = await db.query("UPDATE concepts SET title = $1 WHERE id = $2 RETURNING id, title", [
    title,
    req.params.id,
  ]);

  if (result.rows.length === 0) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({ id: result.rows[0].id, title: result.rows[0].title });
});

app.post("/api/concepts/:id/pin", requireRole("admin", "production_manager"), async (req, res) => {
  const { pinned } = req.body;

  if (req.user.role !== "admin" && String(req.user.concept_id) !== String(req.params.id)) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const result = await db.query("UPDATE concepts SET pinned = $1 WHERE id = $2 RETURNING id, pinned", [
    !!pinned,
    req.params.id,
  ]);

  if (result.rows.length === 0) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({ id: result.rows[0].id, pinned: result.rows[0].pinned });
});

// Deleting a concept cascades (via FK ON DELETE CASCADE) through its whole
// chain — pitch deck, three-act structure, bit sheet, scene list, and every
// screenplay scene — so nothing orphaned is left behind.
app.delete("/api/concepts/:id", requireRole("admin"), async (req, res) => {
  const result = await db.query("DELETE FROM concepts WHERE id = $1 RETURNING id", [req.params.id]);

  if (result.rows.length === 0) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({ id: result.rows[0].id });
});

// Loads one project's entire chain, scoped strictly to that concept — unlike the various
// "/latest" endpoints above, which each just grab the single newest row in their table
// regardless of which project it belongs to. This is what makes Load Project / History work
// correctly instead of silently mixing up whichever project was touched most recently anywhere.
app.get("/api/concepts/:id/full", requireLogin, async (req, res) => {
  if (req.user.role !== "admin" && String(req.user.concept_id) !== String(req.params.id)) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const conceptResult = await db.query(
    "SELECT id, concept_text, storylines, title, project_type FROM concepts WHERE id = $1",
    [req.params.id]
  );

  if (conceptResult.rows.length === 0) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const conceptRow = conceptResult.rows[0];
  const result = {
    conceptId: conceptRow.id,
    concept: conceptRow.concept_text,
    storylines: conceptRow.storylines,
    title: conceptRow.title,
    projectType: conceptRow.project_type,
    pitchDeck: null,
    characterSheet: null,
    threeActStructure: null,
    bitSheet: null,
    sceneList: null,
    scriptBreakdown: null,
    shootSchedule: null,
  };

  // A standalone 'production'-type project has no story-agent chain at
  // all — its scene list hangs directly off the concept instead of off a
  // bit sheet. Load that short path and stop, skipping the pitch-deck walk.
  if (conceptRow.project_type === "production") {
    const sceneListResult = await db.query(
      "SELECT id, content, status, feedback FROM scene_lists WHERE concept_id = $1 ORDER BY created_at DESC LIMIT 1",
      [conceptRow.id]
    );
    if (sceneListResult.rows.length === 0) {
      res.json(result);
      return;
    }
    const sceneListRow = sceneListResult.rows[0];
    result.sceneList = {
      id: sceneListRow.id,
      status: sceneListRow.status,
      feedback: sceneListRow.feedback,
      ...sceneListRow.content,
    };

    const breakdownResult = await db.query(
      "SELECT id, content, status, feedback FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListRow.id]
    );
    if (breakdownResult.rows.length > 0) {
      const breakdownRow = breakdownResult.rows[0];
      result.scriptBreakdown = {
        id: breakdownRow.id,
        sceneListId: sceneListRow.id,
        status: breakdownRow.status,
        feedback: breakdownRow.feedback,
        ...breakdownRow.content,
      };
    }

    const shootScheduleResult = await db.query(
      "SELECT id, content, status, feedback FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListRow.id]
    );
    if (shootScheduleResult.rows.length > 0) {
      const shootScheduleRow = shootScheduleResult.rows[0];
      result.shootSchedule = {
        id: shootScheduleRow.id,
        sceneListId: sceneListRow.id,
        status: shootScheduleRow.status,
        feedback: shootScheduleRow.feedback,
        ...shootScheduleRow.content,
      };
    }

    res.json(result);
    return;
  }

  const pitchDeckResult = await db.query(
    "SELECT id, content, status, feedback FROM pitch_decks WHERE concept_id = $1 ORDER BY created_at DESC LIMIT 1",
    [conceptRow.id]
  );
  if (pitchDeckResult.rows.length === 0) {
    res.json(result);
    return;
  }
  const pitchDeckRow = pitchDeckResult.rows[0];
  result.pitchDeck = {
    id: pitchDeckRow.id,
    status: pitchDeckRow.status,
    feedback: pitchDeckRow.feedback,
    ...pitchDeckRow.content,
  };

  const characterSheetResult = await db.query(
    "SELECT id, content, status, feedback FROM character_sheets WHERE pitch_deck_id = $1 ORDER BY created_at DESC LIMIT 1",
    [pitchDeckRow.id]
  );
  if (characterSheetResult.rows.length > 0) {
    const characterSheetRow = characterSheetResult.rows[0];
    result.characterSheet = {
      id: characterSheetRow.id,
      pitchDeckId: pitchDeckRow.id,
      status: characterSheetRow.status,
      feedback: characterSheetRow.feedback,
      ...characterSheetRow.content,
    };
  }

  const structureResult = await db.query(
    "SELECT id, content, status, feedback FROM three_act_structures WHERE pitch_deck_id = $1 ORDER BY created_at DESC LIMIT 1",
    [pitchDeckRow.id]
  );
  if (structureResult.rows.length === 0) {
    res.json(result);
    return;
  }
  const structureRow = structureResult.rows[0];
  result.threeActStructure = {
    id: structureRow.id,
    pitchDeckId: pitchDeckRow.id,
    status: structureRow.status,
    feedback: structureRow.feedback,
    ...structureRow.content,
  };

  const bitSheetResult = await db.query(
    "SELECT id, content, status, feedback FROM bit_sheets WHERE three_act_structure_id = $1 ORDER BY created_at DESC LIMIT 1",
    [structureRow.id]
  );
  if (bitSheetResult.rows.length === 0) {
    res.json(result);
    return;
  }
  const bitSheetRow = bitSheetResult.rows[0];
  result.bitSheet = {
    id: bitSheetRow.id,
    threeActStructureId: structureRow.id,
    status: bitSheetRow.status,
    feedback: bitSheetRow.feedback,
    ...bitSheetRow.content,
  };

  const sceneListResult = await db.query(
    "SELECT id, content, status, feedback FROM scene_lists WHERE bit_sheet_id = $1 ORDER BY created_at DESC LIMIT 1",
    [bitSheetRow.id]
  );
  if (sceneListResult.rows.length === 0) {
    res.json(result);
    return;
  }
  const sceneListRow = sceneListResult.rows[0];
  result.sceneList = {
    id: sceneListRow.id,
    bitSheetId: bitSheetRow.id,
    status: sceneListRow.status,
    feedback: sceneListRow.feedback,
    ...sceneListRow.content,
  };

  const breakdownResult = await db.query(
    "SELECT id, content, status, feedback FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
    [sceneListRow.id]
  );
  if (breakdownResult.rows.length > 0) {
    const breakdownRow = breakdownResult.rows[0];
    result.scriptBreakdown = {
      id: breakdownRow.id,
      sceneListId: sceneListRow.id,
      status: breakdownRow.status,
      feedback: breakdownRow.feedback,
      ...breakdownRow.content,
    };
  }

  const shootScheduleResult = await db.query(
    "SELECT id, content, status, feedback FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
    [sceneListRow.id]
  );
  if (shootScheduleResult.rows.length > 0) {
    const shootScheduleRow = shootScheduleResult.rows[0];
    result.shootSchedule = {
      id: shootScheduleRow.id,
      sceneListId: sceneListRow.id,
      status: shootScheduleRow.status,
      feedback: shootScheduleRow.feedback,
      ...shootScheduleRow.content,
    };
  }

  res.json(result);
});

// Fields that exist on the in-memory frontend objects but are metadata (id,
// status, foreign keys) rather than actual generated content. Stripped out
// before re-inserting an imported stage's content into a fresh row.
const STAGE_META_FIELDS = new Set([
  "id",
  "status",
  "feedback",
  "previousFeedback",
  "conceptId",
  "pitchDeckId",
  "threeActStructureId",
  "bitSheetId",
  "sceneListId",
  "episodeIndex",
  "sceneIndex",
  "createdAt",
]);

function stripStageMeta(obj) {
  if (!obj) return null;
  const content = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!STAGE_META_FIELDS.has(key)) content[key] = value;
  }
  return content;
}

// Crew/cast photos travel inside the export as inline base64 data URLs
// (there's no server-to-server file transfer at import time — it's just a
// JSON file on the user's disk) and get written back out to real files
// under uploads/crew/ here, same as a fresh upload through the UI would.
async function importCrewMembers(sceneListId, crewMembers) {
  if (!Array.isArray(crewMembers)) return;

  for (const member of crewMembers) {
    let photoPath = null;
    const match = /^data:image\/(\w+);base64,(.+)$/.exec(member.photoDataUrl ?? "");
    if (match) {
      const ext = match[1] === "jpeg" ? "jpg" : match[1];
      photoPath = await savePhotoBuffer(Buffer.from(match[2], "base64"), `import.${ext}`);
    }

    await db.query(
      `INSERT INTO crew_members (scene_list_id, category, character_name, name, role, contact_number, photo_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sceneListId,
        member.category,
        member.characterName ?? null,
        member.name,
        member.role ?? null,
        member.contactNumber ?? null,
        photoPath,
      ]
    );
  }
}

// Re-creates a full project from a previously exported JSON file (see the
// matching "Save Project" button on the frontend) — inserts a brand-new
// chain of rows rather than touching any existing project.
app.post("/api/concepts/import", requireRole("admin"), async (req, res) => {
  const { project } = req.body;

  if (!project || typeof project.concept !== "string" || !Array.isArray(project.storylines)) {
    res.status(400).json({ error: "This doesn't look like a valid exported project file." });
    return;
  }

  try {
    const projectType = project.projectType === "production" ? "production" : "story";

    const conceptResult = await db.query(
      "INSERT INTO concepts (concept_text, storylines, title, project_type) VALUES ($1, $2, $3, $4) RETURNING id",
      [project.concept, JSON.stringify(project.storylines), project.title ?? null, projectType]
    );
    const conceptId = conceptResult.rows[0].id;

    if (projectType === "production" && project.sceneList) {
      const sceneListResult = await db.query(
        "INSERT INTO scene_lists (concept_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id",
        [
          conceptId,
          JSON.stringify(stripStageMeta(project.sceneList)),
          project.sceneList.status ?? "pending",
          project.sceneList.feedback ?? null,
        ]
      );

      if (project.scriptBreakdown) {
        await db.query(
          "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4)",
          [
            sceneListResult.rows[0].id,
            JSON.stringify(stripStageMeta(project.scriptBreakdown)),
            project.scriptBreakdown.status ?? "pending",
            project.scriptBreakdown.feedback ?? null,
          ]
        );
      }

      if (project.shootSchedule) {
        await db.query(
          "INSERT INTO shoot_schedules (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4)",
          [
            sceneListResult.rows[0].id,
            JSON.stringify(stripStageMeta(project.shootSchedule)),
            project.shootSchedule.status ?? "pending",
            project.shootSchedule.feedback ?? null,
          ]
        );
      }

      if (Array.isArray(project.screenplayScenes)) {
        for (const scene of project.screenplayScenes) {
          await db.query(
            "INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content, status, feedback) VALUES ($1, $2, $3, $4, $5, $6)",
            [
              sceneListResult.rows[0].id,
              scene.episodeIndex ?? null,
              scene.sceneIndex,
              JSON.stringify(stripStageMeta(scene)),
              scene.status ?? "pending",
              scene.feedback ?? null,
            ]
          );
        }
      }

      await importCrewMembers(sceneListResult.rows[0].id, project.crewMembers);

      res.json({ conceptId });
      return;
    }

    let pitchDeckId = null;
    if (project.pitchDeck) {
      const r = await db.query(
        "INSERT INTO pitch_decks (concept_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id",
        [
          conceptId,
          JSON.stringify(stripStageMeta(project.pitchDeck)),
          project.pitchDeck.status ?? "pending",
          project.pitchDeck.feedback ?? null,
        ]
      );
      pitchDeckId = r.rows[0].id;
    }

    if (pitchDeckId && project.characterSheet) {
      await db.query(
        "INSERT INTO character_sheets (pitch_deck_id, content, status, feedback) VALUES ($1, $2, $3, $4)",
        [
          pitchDeckId,
          JSON.stringify(stripStageMeta(project.characterSheet)),
          project.characterSheet.status ?? "pending",
          project.characterSheet.feedback ?? null,
        ]
      );
    }

    let threeActStructureId = null;
    if (pitchDeckId && project.threeActStructure) {
      const r = await db.query(
        "INSERT INTO three_act_structures (pitch_deck_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id",
        [
          pitchDeckId,
          JSON.stringify(stripStageMeta(project.threeActStructure)),
          project.threeActStructure.status ?? "pending",
          project.threeActStructure.feedback ?? null,
        ]
      );
      threeActStructureId = r.rows[0].id;
    }

    let bitSheetId = null;
    if (threeActStructureId && project.bitSheet) {
      const r = await db.query(
        "INSERT INTO bit_sheets (three_act_structure_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id",
        [
          threeActStructureId,
          JSON.stringify(stripStageMeta(project.bitSheet)),
          project.bitSheet.status ?? "pending",
          project.bitSheet.feedback ?? null,
        ]
      );
      bitSheetId = r.rows[0].id;
    }

    let sceneListId = null;
    if (bitSheetId && project.sceneList) {
      const r = await db.query(
        "INSERT INTO scene_lists (bit_sheet_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id",
        [
          bitSheetId,
          JSON.stringify(stripStageMeta(project.sceneList)),
          project.sceneList.status ?? "pending",
          project.sceneList.feedback ?? null,
        ]
      );
      sceneListId = r.rows[0].id;
    }

    if (sceneListId && project.scriptBreakdown) {
      await db.query(
        "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4)",
        [
          sceneListId,
          JSON.stringify(stripStageMeta(project.scriptBreakdown)),
          project.scriptBreakdown.status ?? "pending",
          project.scriptBreakdown.feedback ?? null,
        ]
      );
    }

    if (sceneListId && project.shootSchedule) {
      await db.query(
        "INSERT INTO shoot_schedules (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4)",
        [
          sceneListId,
          JSON.stringify(stripStageMeta(project.shootSchedule)),
          project.shootSchedule.status ?? "pending",
          project.shootSchedule.feedback ?? null,
        ]
      );
    }

    if (sceneListId && Array.isArray(project.screenplayScenes)) {
      for (const scene of project.screenplayScenes) {
        await db.query(
          "INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content, status, feedback) VALUES ($1, $2, $3, $4, $5, $6)",
          [
            sceneListId,
            scene.episodeIndex ?? null,
            scene.sceneIndex,
            JSON.stringify(stripStageMeta(scene)),
            scene.status ?? "pending",
            scene.feedback ?? null,
          ]
        );
      }
    }

    if (sceneListId) {
      await importCrewMembers(sceneListId, project.crewMembers);
    }

    res.json({ conceptId });
  } catch (error) {
    console.error("Import failed:", error.message);
    res.status(500).json({ error: "Could not import this project file." });
  }
});

// --- "Skip ahead" — start a project from a later stage by pasting your own
// content, instead of typing an idea and working through every step. Each of
// these does ONE Gemini call that both treats the pasted text as authoritative
// for its own stage AND invents plausible, consistent earlier stages backward
// from it (so the normal revision/approval chain still works from that point
// on). Film format only for now — a web series needs per-episode consistency
// that a single pasted excerpt can't reliably reverse-engineer yet.

const SKIP_AHEAD_INSTRUCTION =
  "The user pasted their own already-written material below — treat it as authoritative and do not contradict or replace it. Your job is to (a) invent short, plausible EARLIER stages that this pasted material would logically have come from, staying consistent with it, and (b) faithfully restructure the pasted material itself into the requested fields (translating/expanding into the required bilingual English+Odia fields, not inventing new plot content for it). Odia must be real Odia (Oriya) script, never Romanized.";

async function generateSkipToSynopsis(pastedText, runtimeMinutes) {
  const response = await ai.models.generateContent({
    model: "gemini-flash-lite-latest",
    contents: `${SKIP_AHEAD_INSTRUCTION}\n\nThis is a feature film, target runtime ${runtimeMinutes} minutes.\n\nThe user's pasted synopsis/pitch text:\n${pastedText}\n\nProvide: a short one-to-two sentence English-only "concept" summarizing the core idea (internal reference only, not shown to the user); a matching storyline title/logline/summary (bilingual); the pasted text restructured into premise/toneGenre/targetAudience (bilingual); and 3-5 major characters (name, role, emotional core, central conflict) consistent with it.`,
    config: {
      systemInstruction: STORY_AGENT_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          concept: { type: Type.STRING },
          storylineTitle: BILINGUAL_TEXT_SCHEMA,
          storylineLogline: BILINGUAL_TEXT_SCHEMA,
          storylineSummary: BILINGUAL_TEXT_SCHEMA,
          premise: BILINGUAL_TEXT_SCHEMA,
          toneGenre: BILINGUAL_TEXT_SCHEMA,
          targetAudience: BILINGUAL_TEXT_SCHEMA,
          majorCharacters: { type: Type.ARRAY, items: CHARACTER_SCHEMA },
        },
        required: [
          "concept",
          "storylineTitle",
          "storylineLogline",
          "storylineSummary",
          "premise",
          "toneGenre",
          "targetAudience",
          "majorCharacters",
        ],
      },
    },
  });

  return sanitizeBilingualContent(JSON.parse(response.text));
}

app.post("/api/skip-to-synopsis", requireRole("admin"), async (req, res) => {
  const { pastedText, runtimeMinutes } = req.body;
  const minutes = Number(runtimeMinutes) > 0 ? Number(runtimeMinutes) : 90;

  if (!pastedText || !pastedText.trim()) {
    res.status(400).json({ error: "Paste some synopsis text first." });
    return;
  }

  try {
    const result = await generateSkipToSynopsis(pastedText, minutes);

    const conceptResult = await db.query(
      "INSERT INTO concepts (concept_text, storylines) VALUES ($1, $2) RETURNING id",
      [
        result.concept,
        JSON.stringify([{ title: result.storylineTitle, logline: result.storylineLogline, summary: result.storylineSummary }]),
      ]
    );
    const conceptId = conceptResult.rows[0].id;

    const pitchDeckContent = {
      title: result.storylineTitle,
      logline: result.storylineLogline,
      premise: result.premise,
      toneGenre: result.toneGenre,
      targetAudience: result.targetAudience,
      majorCharacters: result.majorCharacters,
      format: { type: "film", runtimeMinutes: minutes },
      episodes: null,
    };
    await db.query("INSERT INTO pitch_decks (concept_id, content) VALUES ($1, $2)", [
      conceptId,
      JSON.stringify(pitchDeckContent),
    ]);

    res.json({ conceptId });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

async function generateSkipToBitSheet(pastedText, runtimeMinutes) {
  const response = await ai.models.generateContent({
    model: "gemini-flash-lite-latest",
    contents: `${SKIP_AHEAD_INSTRUCTION}\n\nThis is a feature film, target runtime ${runtimeMinutes} minutes.\n\nThe user's pasted Bit Sheet (plot points) text:\n${pastedText}\n\nProvide: a short English-only "concept" (internal only); a matching storyline title/logline/summary (bilingual); a pitch deck premise/toneGenre/targetAudience (bilingual) consistent with the bit sheet; 3-5 major characters as full character sheets (name, archetype, archetypeNote, role, want, need, flaw, virtues, innerConflict, outerConflict, arc, introductionBeat, and heroLogline for whichever one plays the shadow/antagonist); a three-act controllingIdea/setup/confrontation/resolution (bilingual) consistent with it; and "bits" — the pasted content itself, restructured into an ordered array where each bit has actNumber, beatType (from the given enum), and a bilingual title/description. Assign act numbers and beat types based on where each bit logically falls in your three-act structure above.`,
    config: {
      systemInstruction: BIT_SHEET_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 10240,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          concept: { type: Type.STRING },
          storylineTitle: BILINGUAL_TEXT_SCHEMA,
          storylineLogline: BILINGUAL_TEXT_SCHEMA,
          storylineSummary: BILINGUAL_TEXT_SCHEMA,
          premise: BILINGUAL_TEXT_SCHEMA,
          toneGenre: BILINGUAL_TEXT_SCHEMA,
          targetAudience: BILINGUAL_TEXT_SCHEMA,
          majorCharacters: { type: Type.ARRAY, items: CHARACTER_SCHEMA },
          characters: { type: Type.ARRAY, items: CHARACTER_SHEET_ENTRY_SCHEMA },
          controllingIdea: BILINGUAL_TEXT_SCHEMA,
          setup: ACT_SCHEMA,
          confrontation: ACT_SCHEMA,
          resolution: ACT_SCHEMA,
          bits: { type: Type.ARRAY, items: BIT_SCHEMA },
        },
        required: [
          "concept",
          "storylineTitle",
          "storylineLogline",
          "storylineSummary",
          "premise",
          "toneGenre",
          "targetAudience",
          "majorCharacters",
          "characters",
          "controllingIdea",
          "setup",
          "confrontation",
          "resolution",
          "bits",
        ],
      },
    },
  });

  return sanitizeBilingualContent(JSON.parse(response.text));
}

app.post("/api/skip-to-bitsheet", requireRole("admin"), async (req, res) => {
  const { pastedText, runtimeMinutes } = req.body;
  const minutes = Number(runtimeMinutes) > 0 ? Number(runtimeMinutes) : 90;

  if (!pastedText || !pastedText.trim()) {
    res.status(400).json({ error: "Paste some Bit Sheet text first." });
    return;
  }

  try {
    const result = await generateSkipToBitSheet(pastedText, minutes);

    const conceptResult = await db.query(
      "INSERT INTO concepts (concept_text, storylines) VALUES ($1, $2) RETURNING id",
      [
        result.concept,
        JSON.stringify([{ title: result.storylineTitle, logline: result.storylineLogline, summary: result.storylineSummary }]),
      ]
    );
    const conceptId = conceptResult.rows[0].id;

    const pitchDeckContent = {
      title: result.storylineTitle,
      logline: result.storylineLogline,
      premise: result.premise,
      toneGenre: result.toneGenre,
      targetAudience: result.targetAudience,
      majorCharacters: result.majorCharacters,
      format: { type: "film", runtimeMinutes: minutes },
      episodes: null,
    };
    const pitchDeckResult = await db.query(
      "INSERT INTO pitch_decks (concept_id, content, status) VALUES ($1, $2, 'approved') RETURNING id",
      [conceptId, JSON.stringify(pitchDeckContent)]
    );
    const pitchDeckId = pitchDeckResult.rows[0].id;

    await db.query(
      "INSERT INTO character_sheets (pitch_deck_id, content, status) VALUES ($1, $2, 'approved')",
      [pitchDeckId, JSON.stringify({ characters: result.characters })]
    );

    const threeActContent = {
      controllingIdea: result.controllingIdea,
      setup: result.setup,
      confrontation: result.confrontation,
      resolution: result.resolution,
    };
    const threeActResult = await db.query(
      "INSERT INTO three_act_structures (pitch_deck_id, content, status) VALUES ($1, $2, 'locked') RETURNING id",
      [pitchDeckId, JSON.stringify(threeActContent)]
    );
    const threeActStructureId = threeActResult.rows[0].id;

    const bitSheetContent = { bits: result.bits, controllingIdea: result.controllingIdea };
    await db.query("INSERT INTO bit_sheets (three_act_structure_id, content) VALUES ($1, $2)", [
      threeActStructureId,
      JSON.stringify(bitSheetContent),
    ]);

    res.json({ conceptId });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

async function generateSkipToSceneList(pastedText, runtimeMinutes) {
  const response = await ai.models.generateContent({
    model: "gemini-flash-lite-latest",
    contents: `${SKIP_AHEAD_INSTRUCTION}\n\nThis is a feature film, target runtime ${runtimeMinutes} minutes.\n\nThe user's pasted scene-by-scene one-liner text:\n${pastedText}\n\nProvide: a short English-only "concept" (internal only); a matching storyline title/logline/summary (bilingual); a pitch deck premise/toneGenre/targetAudience (bilingual); 3-5 major characters as full character sheets (name, archetype, archetypeNote, role, want, need, flaw, virtues, innerConflict, outerConflict, arc, introductionBeat, and heroLogline for whichever one plays the shadow/antagonist); a three-act controllingIdea/setup/confrontation/resolution (bilingual); a bit sheet "bits" array (beat-by-beat plot points, from the given beatType enum) — all consistent with the scenes below; and "scenes" — the pasted content itself, restructured into an ordered array where each scene has actNumber, intExt (INT/EXT), a bilingual location, timeOfDay (DAY/NIGHT), a bilingual oneLiner, and an estimatedMinutes number (infer a reasonable one if not stated).`,
    config: {
      systemInstruction: SCENE_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 14336,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          concept: { type: Type.STRING },
          storylineTitle: BILINGUAL_TEXT_SCHEMA,
          storylineLogline: BILINGUAL_TEXT_SCHEMA,
          storylineSummary: BILINGUAL_TEXT_SCHEMA,
          premise: BILINGUAL_TEXT_SCHEMA,
          toneGenre: BILINGUAL_TEXT_SCHEMA,
          targetAudience: BILINGUAL_TEXT_SCHEMA,
          majorCharacters: { type: Type.ARRAY, items: CHARACTER_SCHEMA },
          characters: { type: Type.ARRAY, items: CHARACTER_SHEET_ENTRY_SCHEMA },
          controllingIdea: BILINGUAL_TEXT_SCHEMA,
          setup: ACT_SCHEMA,
          confrontation: ACT_SCHEMA,
          resolution: ACT_SCHEMA,
          bits: { type: Type.ARRAY, items: BIT_SCHEMA },
          scenes: { type: Type.ARRAY, items: SCENE_SCHEMA },
        },
        required: [
          "concept",
          "storylineTitle",
          "storylineLogline",
          "storylineSummary",
          "premise",
          "toneGenre",
          "targetAudience",
          "majorCharacters",
          "characters",
          "controllingIdea",
          "setup",
          "confrontation",
          "resolution",
          "bits",
          "scenes",
        ],
      },
    },
  });

  return sanitizeBilingualContent(JSON.parse(response.text));
}

app.post("/api/skip-to-scenelist", requireRole("admin"), async (req, res) => {
  const { pastedText, runtimeMinutes } = req.body;
  const minutes = Number(runtimeMinutes) > 0 ? Number(runtimeMinutes) : 90;

  if (!pastedText || !pastedText.trim()) {
    res.status(400).json({ error: "Paste some scene one-liner text first." });
    return;
  }

  try {
    const result = await generateSkipToSceneList(pastedText, minutes);

    const conceptResult = await db.query(
      "INSERT INTO concepts (concept_text, storylines) VALUES ($1, $2) RETURNING id",
      [
        result.concept,
        JSON.stringify([{ title: result.storylineTitle, logline: result.storylineLogline, summary: result.storylineSummary }]),
      ]
    );
    const conceptId = conceptResult.rows[0].id;

    const pitchDeckContent = {
      title: result.storylineTitle,
      logline: result.storylineLogline,
      premise: result.premise,
      toneGenre: result.toneGenre,
      targetAudience: result.targetAudience,
      majorCharacters: result.majorCharacters,
      format: { type: "film", runtimeMinutes: minutes },
      episodes: null,
    };
    const pitchDeckResult = await db.query(
      "INSERT INTO pitch_decks (concept_id, content, status) VALUES ($1, $2, 'approved') RETURNING id",
      [conceptId, JSON.stringify(pitchDeckContent)]
    );
    const pitchDeckId = pitchDeckResult.rows[0].id;

    await db.query(
      "INSERT INTO character_sheets (pitch_deck_id, content, status) VALUES ($1, $2, 'approved')",
      [pitchDeckId, JSON.stringify({ characters: result.characters })]
    );

    const threeActContent = {
      controllingIdea: result.controllingIdea,
      setup: result.setup,
      confrontation: result.confrontation,
      resolution: result.resolution,
    };
    const threeActResult = await db.query(
      "INSERT INTO three_act_structures (pitch_deck_id, content, status) VALUES ($1, $2, 'locked') RETURNING id",
      [pitchDeckId, JSON.stringify(threeActContent)]
    );
    const threeActStructureId = threeActResult.rows[0].id;

    const bitSheetContent = { bits: result.bits, controllingIdea: result.controllingIdea };
    const bitSheetResult = await db.query(
      "INSERT INTO bit_sheets (three_act_structure_id, content, status) VALUES ($1, $2, 'approved') RETURNING id",
      [threeActStructureId, JSON.stringify(bitSheetContent)]
    );
    const bitSheetId = bitSheetResult.rows[0].id;

    const sceneListContent = {
      scenes: result.scenes,
      totalEstimatedMinutes: sumSceneMinutes(result.scenes),
      targetMinutes: minutes,
    };
    await db.query("INSERT INTO scene_lists (bit_sheet_id, content) VALUES ($1, $2)", [
      bitSheetId,
      JSON.stringify(sceneListContent),
    ]);

    res.json({ conceptId });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// --- Production Management, entirely on its own: import an already-written
// screenplay (from anywhere, not necessarily built with the Story &
// Screenplay Agent) and derive just enough structure — a scene list and a
// character-name list — to start shoot scheduling. This is deliberately
// much lighter than the other skip-ahead endpoints: no pitch deck, no
// three-act structure, no bit sheet, since none of that is needed to
// schedule a shoot. Creates a standalone 'production'-type project.
// Many real, already-produced scripts are multi-episode, with scene
// numbering restarting at 1 for every episode (a literal "EPISODE N" or
// "EPISODE N: TITLE" header line marks each boundary). Splitting on that
// BEFORE extraction — rather than asking one Gemini call to both infer
// episode boundaries AND transcribe a huge wall of text — keeps each
// per-episode extraction small enough to avoid truncating scenes, and keeps
// the resulting scene list's own numbering honest (matching the real,
// per-episode numbering the shoot schedule and every other stage already
// expect via episodeScenes).
const EPISODE_HEADER_REGEX = /^\s*EPISODE\s+(\d+)\s*:?\s*(.*)$/gim;

function splitScreenplayIntoEpisodes(text) {
  const matches = [...text.matchAll(EPISODE_HEADER_REGEX)];
  if (matches.length === 0) {
    return [{ episodeNumber: 1, title: null, text }];
  }

  const episodes = [];
  const firstIndex = matches[0].index;
  if (text.slice(0, firstIndex).trim().length > 0) {
    // Content before the first explicit header — episode 1's cold open, for
    // scripts that don't bother labeling their very first episode.
    episodes.push({ episodeNumber: 1, title: null, text: text.slice(0, firstIndex).trim() });
  }

  matches.forEach((match, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    episodes.push({
      episodeNumber: Number(match[1]),
      title: match[2]?.trim() || null,
      text: text.slice(match.index, end).trim(),
    });
  });

  return episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
}

// Cheap pass over the FULL text for just title + character names — these
// need whole-script context but are tiny outputs, so no truncation risk
// even for a long multi-episode script.
async function generateScreenplayMetadataForProduction(fullText) {
  const response = await generateContentWithRetry({
    model: "gemini-flash-lite-latest",
    contents: `The user pasted an already-written screenplay below — treat it as authoritative, this is a transcription/structuring task, not a creative rewrite. Extract: a short English-only project title (a few words, internal reference only); and a list of the major character names who appear across the ENTIRE script (plain proper nouns, no descriptions).\n\nThe pasted screenplay:\n${fullText}`,
    config: {
      systemInstruction: SCENE_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 2048,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          characterNames: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["title", "characterNames"],
      },
    },
  });

  return sanitizeBilingualContent(JSON.parse(response.text));
}

// Extracts just ONE episode's (or, for a single-episode/film script, the
// whole thing's) scene-by-scene breakdown — kept separate from the metadata
// call above so a long series' scenes get extracted one episode at a time
// instead of risking truncation on one giant combined call.
async function generateEpisodeScenesForProduction(episodeText, episodeNumber, episodeTitle, isSeries, targetMinutes) {
  const episodeLine = isSeries
    ? `This is EPISODE ${episodeNumber}${episodeTitle ? ` ("${episodeTitle}")` : ""} of a multi-episode series — extract ONLY this episode's own scenes; its scene numbering restarts at 1 within the episode, same as the source. `
    : "";
  const targetLine = targetMinutes
    ? ` This ${isSeries ? "episode" : "film"} runs approximately ${targetMinutes} minutes — use that to calibrate each scene's estimatedMinutes so they add up in the right ballpark, without forcing an exact match.`
    : "";

  const response = await generateContentWithRetry({
    model: "gemini-flash-lite-latest",
    contents: `The user pasted an already-written screenplay below — treat it as authoritative, this is a transcription/structuring task, not a creative rewrite. ${episodeLine}Extract a faithful scene-by-scene breakdown of the ENTIRE material given — for each scene give actNumber (estimate 1/2/3 from its position within this material), intExt (INT/EXT), a bilingual location (just the place name), timeOfDay (DAY/NIGHT), a bilingual oneLiner summarizing what happens, an estimatedMinutes number (infer from the scene's length/content), a purpose ("plot_advancing" or "character_revealing"), and a bilingual turn (its value-shift).${targetLine} Odia must be real Odia (Oriya) script, never Romanized. Do not skip any scene, however short.\n\nThe pasted screenplay material:\n${episodeText}`,
    config: {
      systemInstruction: SCENE_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 16384,
      responseSchema: {
        type: Type.OBJECT,
        properties: { scenes: { type: Type.ARRAY, items: SCENE_SCHEMA } },
        required: ["scenes"],
      },
    },
  });

  return sanitizeBilingualContent(JSON.parse(response.text)).scenes;
}

// Shared by both the paste-text and file-upload import routes: splits the
// text into episodes, runs the AI extraction, then creates the standalone
// 'production' project + its scene list — as episodeScenes for a series, or
// a flat scenes array for a film, matching how every other stage in this
// app already expects a scene list to be shaped.
//
// `format` — { type: 'series', episodeCount, episodeMinutes } or
// { type: 'film', runtimeMinutes } — comes from the user answering "is this
// a series or a film?" at import time, same question asked when starting a
// project from scratch. It decides splitting behavior directly rather than
// leaving it to header-sniffing alone: a user who says "film" gets a flat
// scene list even if the word "episode" appears somewhere in the text, and
// a user who says "series" gets a clear error if no "EPISODE N" boundaries
// are actually found, instead of silently importing it as one flat film.
async function createProductionProjectFromScreenplayText(pastedText, format) {
  const detectedChunks = splitScreenplayIntoEpisodes(pastedText);
  const isSeries = format ? format.type === "series" : detectedChunks.length > 1;

  if (isSeries && detectedChunks.length <= 1) {
    throw new Error(
      'This was marked as a series, but no "EPISODE 1", "EPISODE 2", etc. headers were found in the script to split on. Re-check the script\'s episode headers, or import it as a film instead.'
    );
  }
  if (format?.type === "series" && detectedChunks.length !== Number(format.episodeCount)) {
    console.error(
      `Episode count mismatch: user said ${format.episodeCount} episodes, found ${detectedChunks.length} "EPISODE N" headers in the script. Proceeding with what's actually in the script.`
    );
  }

  const episodeChunks = isSeries ? detectedChunks : [{ episodeNumber: 1, title: null, text: pastedText }];
  const perEpisodeTargetMinutes = isSeries ? Number(format?.episodeMinutes) || null : null;
  const filmTargetMinutes = !isSeries ? Number(format?.runtimeMinutes) || null : null;

  const [metadata, episodeSceneLists] = await Promise.all([
    generateScreenplayMetadataForProduction(pastedText),
    mapWithConcurrency(episodeChunks, 3, (ep) =>
      generateEpisodeScenesForProduction(
        ep.text,
        ep.episodeNumber,
        ep.title,
        isSeries,
        isSeries ? perEpisodeTargetMinutes : filmTargetMinutes
      )
    ),
  ]);

  const conceptResult = await db.query(
    "INSERT INTO concepts (concept_text, storylines, title, project_type) VALUES ($1, $2, $3, 'production') RETURNING id",
    [metadata.title, JSON.stringify([]), metadata.title]
  );
  const conceptId = conceptResult.rows[0].id;

  const allScenesFlat = episodeSceneLists.flat();
  const sceneListContent = {
    ...(isSeries
      ? {
          episodeScenes: episodeSceneLists.map((scenes) => ({
            scenes,
            totalEstimatedMinutes: sumSceneMinutes(scenes),
            targetMinutes: perEpisodeTargetMinutes,
          })),
        }
      : { scenes: allScenesFlat }),
    totalEstimatedMinutes: sumSceneMinutes(allScenesFlat),
    targetMinutes: isSeries
      ? perEpisodeTargetMinutes && episodeChunks.length ? perEpisodeTargetMinutes * episodeChunks.length : null
      : filmTargetMinutes,
    format: format ?? null,
    characterNames: metadata.characterNames,
    // Kept for the Script Breakdown step, which needs the real prose (props,
    // costumes, set dressing) rather than just the derived one-liners.
    sourceText: pastedText,
  };
  await db.query(
    "INSERT INTO scene_lists (concept_id, content, status) VALUES ($1, $2, 'approved')",
    [conceptId, JSON.stringify(sceneListContent)]
  );

  return conceptId;
}

app.post("/api/import-screenplay-for-production", requireRole("admin"), async (req, res) => {
  const { pastedText, format } = req.body;

  if (!pastedText || !pastedText.trim()) {
    res.status(400).json({ error: "Paste a screenplay first." });
    return;
  }

  try {
    const conceptId = await createProductionProjectFromScreenplayText(pastedText, format);
    res.json({ conceptId });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// --- File upload variant: accepts an already-written screenplay as a real
// file (plain text, PDF, Word .docx/.doc, Final Draft .fdx, or a Scrite
// .scrite project) instead of a paste box. Each format is converted to
// plain text first, then handed to the exact same AI extraction above —
// one extraction pipeline, several format-specific text readers in front.

const screenplayUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Final Draft's native XML format: a flat list of <Paragraph Type="..."> ->
// <Text> runs. Reassembled into plain screenplay text good enough for the
// AI extraction step — this is a format reader, not a full FDX renderer.
function extractTextFromFdx(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text" });
  const doc = parser.parse(xml);
  const paragraphs = doc?.FinalDraft?.Content?.Paragraph;
  if (!paragraphs) return "";

  const list = Array.isArray(paragraphs) ? paragraphs : [paragraphs];

  function collectText(node) {
    if (node == null) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(collectText).join("");
    if (typeof node === "object") {
      if (node["#text"] != null) return String(node["#text"]);
      if (node.Text != null) return collectText(node.Text);
      return "";
    }
    return "";
  }

  return list
    .map((p) => {
      const type = p?.["@_Type"] ?? "";
      const text = collectText(p.Text).trim();
      if (!text) return "";
      if (type === "Character") return text.toUpperCase();
      return text;
    })
    .filter(Boolean)
    .join("\n");
}

// Scrite's native .scrite project file is JSON. Its exact schema isn't
// something we can verify offline, so try the documented shape first
// (structure.screenplay.elements[].scene.heading/elements[]) and fall back
// to a generic "collect every readable string" walk if that shape isn't
// there — imperfect, but keeps the import working across Scrite versions.
function extractTextFromScrite(jsonText) {
  const data = JSON.parse(jsonText);

  const elements = data?.structure?.screenplay?.elements ?? data?.screenplay?.elements;
  if (Array.isArray(elements) && elements.length > 0) {
    const lines = [];
    for (const el of elements) {
      const scene = el?.scene;
      if (!scene) continue;
      const heading = scene.heading;
      if (heading?.locationType && heading?.location) {
        lines.push(`${heading.locationType}. ${heading.location} - ${heading.moment ?? ""}`.trim());
      }
      for (const sceneEl of scene.elements ?? []) {
        const text = (sceneEl.text ?? "").trim();
        if (!text) continue;
        lines.push(sceneEl.type === "Character" ? text.toUpperCase() : text);
      }
    }
    if (lines.length > 0) return lines.join("\n");
  }

  // Generic fallback: walk the whole JSON tree and collect string leaves
  // that look like actual screenplay prose rather than IDs/flags/colors.
  const collected = [];
  function walk(node) {
    if (typeof node === "string") {
      if (node.length > 2 && !/^[0-9a-f-]{8,}$/i.test(node) && !/^#[0-9a-f]{3,8}$/i.test(node)) {
        collected.push(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      Object.values(node).forEach(walk);
    }
  }
  walk(data);
  return collected.join("\n");
}

async function extractTextFromUploadedScreenplay(file) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ext === ".txt" || ext === ".fountain") {
    return file.buffer.toString("utf-8");
  }
  if (ext === ".pdf") {
    const parser = new PDFParse({ data: file.buffer });
    const result = await parser.getText();
    return result.text;
  }
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }
  if (ext === ".doc") {
    const extractor = new WordExtractor();
    const doc = await extractor.extract(file.buffer);
    return doc.getBody();
  }
  if (ext === ".fdx") {
    return extractTextFromFdx(file.buffer.toString("utf-8"));
  }
  if (ext === ".scrite") {
    return extractTextFromScrite(file.buffer.toString("utf-8"));
  }

  throw new Error(`Unsupported file type "${ext}". Try .txt, .pdf, .docx, .doc, .fdx, or .scrite.`);
}

app.post("/api/import-screenplay-for-production/file", requireRole("admin"), screenplayUpload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded." });
    return;
  }

  try {
    const text = await extractTextFromUploadedScreenplay(req.file);

    if (!text || !text.trim()) {
      res.status(400).json({ error: "Couldn't find any readable text in that file." });
      return;
    }

    // multer puts non-file multipart fields into req.body as plain strings.
    const format = req.body.format ? JSON.parse(req.body.format) : null;
    const conceptId = await createProductionProjectFromScreenplayText(text, format);
    res.json({ conceptId });
  } catch (error) {
    console.error("Screenplay file import failed:", error.message);
    res.status(error.message?.startsWith("Unsupported file type") ? 400 : 502).json({ error: error.message });
  }
});

// Builds the bilingual pitch-deck content via Gemini. When `revision` is
// given, the prompt asks for a rewrite that addresses the producer's
// feedback instead of a first draft.
async function generatePitchDeckContent(storyline, format, revision) {
  const isSeries = format?.type === "series";

  const properties = {
    premise: BILINGUAL_TEXT_SCHEMA,
    toneGenre: BILINGUAL_TEXT_SCHEMA,
    targetAudience: BILINGUAL_TEXT_SCHEMA,
    majorCharacters: { type: Type.ARRAY, items: CHARACTER_SCHEMA },
  };
  const required = ["premise", "toneGenre", "targetAudience", "majorCharacters"];

  let formatInstruction = "Format: feature film.";
  if (isSeries) {
    formatInstruction = `Format: web series, exactly ${format.episodeCount} episodes of ${format.episodeMinutes} minutes each. Also break the story into exactly ${format.episodeCount} episodes forming one coherent arc from setup to finale. For each episode give a short punchy title (2-5 words, do NOT include the word "Episode" or a number in the title itself — that is added separately by the app) and an elaborated 5-7 sentence synopsis that genuinely establishes the whole episode: what it opens on, the conflict/complication that develops through it, and how it turns or ends — not just a one-line plot beat.`;
    properties.episodes = {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: BILINGUAL_TEXT_SCHEMA,
          synopsis: BILINGUAL_TEXT_SCHEMA,
        },
        required: ["title", "synopsis"],
      },
    };
    required.push("episodes");
  }

  let contents = `Storyline title (English): ${storyline.title.en}\nLogline (English): ${storyline.logline.en}\nSummary (English): ${storyline.summary.en}\n${formatInstruction}\n\nAlso give 3-5 major characters who actually drive this story (name, role, emotional core, central conflict).`;

  if (revision) {
    contents += `\n\nThis is a REVISION of a previous draft. The producer reviewed it and requested changes.\nProducer's feedback: "${revision.feedback}"\nPrevious premise (English): ${revision.previous.premise.en}\nPrevious tone/genre (English): ${revision.previous.toneGenre.en}\nRevise the pitch deck to address the producer's feedback directly, while keeping the same title and logline.`;
  }

  const response = await ai.models.generateContent({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: PITCH_DECK_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: isSeries ? 12288 : 3072,
      responseSchema: {
        type: Type.OBJECT,
        properties,
        required,
      },
    },
  });

  const parsed = sanitizeBilingualContent(JSON.parse(response.text));

  return {
    title: storyline.title,
    logline: storyline.logline,
    premise: parsed.premise,
    toneGenre: parsed.toneGenre,
    targetAudience: parsed.targetAudience,
    majorCharacters: parsed.majorCharacters,
    format: format ?? { type: "film" },
    episodes: parsed.episodes ?? null,
  };
}

app.post("/api/pitch-deck", requireRole("admin"), async (req, res) => {
  const { conceptId, storyline, format } = req.body;

  try {
    const content = await generatePitchDeckContent(storyline, format);

    const insertResult = await db.query(
      "INSERT INTO pitch_decks (concept_id, content) VALUES ($1, $2) RETURNING id, status, feedback",
      [conceptId ?? null, JSON.stringify(content)]
    );

    res.json({ ...insertResult.rows[0], ...content });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/pitch-deck/latest", requireLogin, async (req, res) => {
  const result = await db.query(
    "SELECT id, content, status, feedback FROM pitch_decks ORDER BY created_at DESC LIMIT 1"
  );

  if (result.rows.length === 0) {
    res.json(null);
    return;
  }

  const row = result.rows[0];
  res.json({ id: row.id, status: row.status, feedback: row.feedback, ...row.content });
});

app.post("/api/pitch-deck/:id/approve", requireRole("admin"), async (req, res) => {
  const result = await db.query(
    "UPDATE pitch_decks SET status = 'approved' WHERE id = $1 RETURNING id, content, status, feedback",
    [req.params.id]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: "Pitch deck not found" });
    return;
  }

  const row = result.rows[0];
  res.json({ id: row.id, status: row.status, feedback: row.feedback, ...row.content });
});

app.post("/api/pitch-deck/:id/request-changes", requireRole("admin"), async (req, res) => {
  const { feedback } = req.body;

  try {
    const existing = await db.query("SELECT concept_id, content FROM pitch_decks WHERE id = $1", [
      req.params.id,
    ]);

    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Pitch deck not found" });
      return;
    }

    const { concept_id: conceptId, content: previous } = existing.rows[0];

    await db.query("UPDATE pitch_decks SET status = 'changes_requested', feedback = $1 WHERE id = $2", [
      feedback,
      req.params.id,
    ]);

    const revisedContent = await generatePitchDeckContent(
      { title: previous.title, logline: previous.logline, summary: previous.premise },
      previous.format,
      { feedback, previous }
    );

    const insertResult = await db.query(
      "INSERT INTO pitch_decks (concept_id, content) VALUES ($1, $2) RETURNING id, status, feedback",
      [conceptId, JSON.stringify(revisedContent)]
    );

    res.json({ ...insertResult.rows[0], ...revisedContent, previousFeedback: feedback });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/pitch-deck/:id/export", requireLogin, async (req, res) => {
  const lang = req.query.lang === "or" ? "or" : "en";

  try {
    const result = await db.query("SELECT content FROM pitch_decks WHERE id = $1", [
      req.params.id,
    ]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Pitch deck not found" });
      return;
    }

    const deck = result.rows[0].content;
    const theme = pickTheme(deck.toneGenre.en);
    const labels = SECTION_LABELS[lang];

    // coverFont: the elegant main story title. headerFont: punchy all-caps
    // section labels/episode titles. bodyFont: paragraph text.
    // Odia has no equivalent of the English display fonts, so it reuses its
    // one bold weight for both display roles.
    const coverFont = lang === "or" ? "odiaBold" : "displayBold";
    const headerFont = lang === "or" ? "odiaBold" : "impact";
    const bodyFont = lang === "or" ? "odiaRegular" : "Helvetica";

    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 0 });

    doc.registerFont("odiaRegular", FONTS.odiaRegular);
    doc.registerFont("odiaBold", FONTS.odiaBold);
    doc.registerFont("displayBold", FONTS.displayBold);
    doc.registerFont("impact", FONTS.impact);

    // Trigger font parsing now, before piping to the response, so a bad
    // font file fails cleanly instead of crashing mid-stream.
    doc.font(coverFont);
    doc.font(headerFont);
    doc.font(bodyFont);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${deck.title.en.replace(/[^a-z0-9]+/gi, "-")}-pitch-deck-${lang}.pdf"`
    );
    doc.pipe(res);

    const W = doc.page.width;
    const H = doc.page.height;
    const margin = 60;

    function fillBackground(color) {
      doc.rect(0, 0, W, H).fill(color);
    }

    function drawCornerLines(x, y, direction) {
      doc.save();
      doc.strokeColor(theme.accent).lineWidth(1.5).opacity(0.6);
      for (let i = 0; i < 4; i++) {
        const offset = i * 7 * direction;
        doc.moveTo(x, y + offset).lineTo(x + 90 * direction, y + offset).stroke();
      }
      doc.restore();
    }

    function drawPill(text, y) {
      doc.font(headerFont).fontSize(11);
      const textWidth = doc.widthOfString(text.toUpperCase());
      const pillWidth = textWidth + 40;
      const pillX = W / 2 - pillWidth / 2;
      doc.roundedRect(pillX, y, pillWidth, 26, 13).lineWidth(1).strokeColor(theme.accent).stroke();
      doc.fillColor(theme.accent).text(text.toUpperCase(), pillX, y + 7, { width: pillWidth, align: "center" });
    }

    // A section slide: a lighter band up top with a big punchy title
    // straddling the boundary into a darker body panel below — the same
    // rhythm as a magazine-style pitch deck (light image area -> bold title
    // -> dark text panel), just without a photo in the light area.
    function sectionSlide(title, bodyText) {
      doc.addPage();
      const bandHeight = H * 0.4;
      fillBackground(theme.panel);
      doc.rect(0, bandHeight, W, H - bandHeight).fill(theme.bg);
      doc.rect(0, bandHeight - 3, W, 6).fill(theme.accent);

      doc.fillColor(theme.accent).font(headerFont).fontSize(52);
      doc.text(title.toUpperCase(), margin, bandHeight - 58, { width: W - margin * 2 });

      doc.fillColor("#F0EEE9").font(bodyFont).fontSize(15);
      doc.text(bodyText, margin, bandHeight + 45, { width: W - margin * 2, lineGap: 6 });
    }

    // Slide 1: Cover
    fillBackground(theme.bg);
    drawCornerLines(margin, margin, 1);
    drawCornerLines(W - margin, H - margin, -1);
    drawPill(formatLabel(deck.format, lang), margin);

    doc
      .fillColor("#F5F1EA")
      .font(coverFont)
      .fontSize(40)
      .text(deck.title[lang], margin, H / 2 - 70, { width: W - margin * 2, align: "center" });
    doc
      .fillColor(theme.accent)
      .font(bodyFont)
      .fontSize(15)
      .text(deck.logline[lang], margin + 60, H / 2 + 10, { width: W - (margin + 60) * 2, align: "center" });
    doc
      .fillColor(theme.accent)
      .opacity(0.7)
      .font(headerFont)
      .fontSize(10)
      .text(labels.tagline, margin, H - margin - 10, { width: W - margin * 2, align: "center" });
    doc.opacity(1);

    // Slide 2: Premise
    sectionSlide(labels.premise, deck.premise[lang]);

    // Slide 3: Tone / Genre
    sectionSlide(labels.toneGenre, deck.toneGenre[lang]);

    // Slide 4: Target Audience
    sectionSlide(labels.targetAudience, deck.targetAudience[lang]);

    // Major Characters slide(s) — one block per character (name, role,
    // emotional core, conflict), paginating onto a fresh dark panel if the
    // list runs past the bottom margin instead of overflowing off-page.
    if (deck.majorCharacters && deck.majorCharacters.length > 0) {
      function newCharactersPanel() {
        doc.addPage();
        fillBackground(theme.panel);
        doc.y = margin;
      }

      newCharactersPanel();
      doc.fillColor(theme.accent).font(headerFont).fontSize(36);
      doc.text(labels.majorCharacters.toUpperCase(), margin, margin, { width: W - margin * 2 });
      doc.y = margin + 60;

      deck.majorCharacters.forEach((character) => {
        if (doc.y > H - margin - 110) {
          newCharactersPanel();
        }

        doc.fillColor("#F5F1EA").font(headerFont).fontSize(18);
        doc.text(character.name, margin, doc.y, { width: W - margin * 2 });
        doc.fillColor(theme.accent).font(bodyFont).fontSize(12);
        doc.text(character.role[lang], margin, doc.y + 2, { width: W - margin * 2 });
        doc.moveDown(0.4);
        doc.fillColor("#F0EEE9").font(bodyFont).fontSize(11);
        doc.text(`${labels.emotionalCore}: ${character.emotionalCore[lang]}`, margin, doc.y, {
          width: W - margin * 2,
          lineGap: 3,
        });
        doc.text(`${labels.conflict}: ${character.conflict[lang]}`, margin, doc.y + 4, {
          width: W - margin * 2,
          lineGap: 3,
        });
        doc.y += 20;
      });
    }

    // Episode slides (web series only): one per episode, a colored block
    // carrying the episode number as a big graphic anchor (standing in for
    // a still photo), paired with the title and synopsis on a dark panel.
    if (deck.episodes) {
      deck.episodes.forEach((episode, index) => {
        doc.addPage();
        const leftWidth = W * 0.3;
        doc.rect(0, 0, leftWidth, H).fill(theme.accent);
        doc.rect(leftWidth, 0, W - leftWidth, H).fill(theme.panel);

        const numberStr = String(index + 1).padStart(2, "0");
        doc
          .fillColor(theme.bg)
          .font("impact")
          .fontSize(150)
          .text(numberStr, 0, H / 2 - 95, { width: leftWidth, align: "center" });

        const textX = leftWidth + margin;
        const textWidth = W - leftWidth - margin * 2;
        doc
          .fillColor(theme.accent)
          .font(headerFont)
          .fontSize(14)
          .text(`${labels.episode.toUpperCase()} ${index + 1}`, textX, 60, { width: textWidth });
        doc
          .fillColor("#F5F1EA")
          .font(headerFont)
          .fontSize(30)
          .text(episode.title[lang], textX, 90, { width: textWidth });
        doc
          .fillColor("#F0EEE9")
          .font(bodyFont)
          .fontSize(14)
          .text(episode.synopsis[lang], textX, 150, { width: textWidth, lineGap: 5 });
      });
    }

    // Closing slide
    doc.addPage();
    fillBackground(theme.bg);
    drawCornerLines(margin, margin, 1);
    drawCornerLines(W - margin, H - margin, -1);
    doc
      .fillColor(theme.accent)
      .font(headerFont)
      .fontSize(64)
      .text(labels.thankYou.toUpperCase(), margin, H / 2 - 40, { width: W - margin * 2, align: "center" });
    doc
      .fillColor(theme.accent)
      .opacity(0.7)
      .font(headerFont)
      .fontSize(10)
      .text(labels.tagline, margin, H - margin - 10, { width: W - margin * 2, align: "center" });
    doc.opacity(1);

    doc.end();
  } catch (error) {
    console.error("PDF export failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
});

// Builds the full Character Sheet via Gemini, deepening the pitch deck's
// thin Major Characters into archetype/want/need/flaw/virtues/arc etc. When
// `revision` is given, the prompt asks for a rewrite addressing feedback.
async function generateCharacterSheetContent(deck, revision) {
  const isSeries = deck.format?.type === "series" && Array.isArray(deck.episodes);

  const seedCharacters = (deck.majorCharacters ?? [])
    .map((c) => `${c.name} — ${c.role.en}. Emotional core: ${c.emotionalCore.en}. Conflict: ${c.conflict.en}.`)
    .join("\n");

  let contents = `Title (English): ${deck.title.en}\nLogline (English): ${deck.logline.en}\nPremise (English): ${deck.premise.en}\nTone/Genre (English): ${deck.toneGenre.en}\n${isSeries ? `Format: web series, ${deck.episodes.length} episodes.` : "Format: feature film."}\n\nPitch deck's Major Characters to deepen:\n${seedCharacters}`;

  if (revision) {
    contents += `\n\nThis is a REVISION of a previous character sheet. The Story Writer reviewed it and requested changes.\nFeedback: "${revision.feedback}"\nRevise the character sheet to address the feedback directly.`;
  }

  const response = await ai.models.generateContent({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: CHARACTER_SHEET_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      responseSchema: {
        type: Type.OBJECT,
        properties: { characters: { type: Type.ARRAY, items: CHARACTER_SHEET_ENTRY_SCHEMA } },
        required: ["characters"],
      },
    },
  });

  return sanitizeBilingualContent(JSON.parse(response.text));
}

app.post("/api/character-sheet", requireRole("admin"), async (req, res) => {
  const { pitchDeckId } = req.body;

  try {
    const pitchDeckResult = await db.query("SELECT content, status FROM pitch_decks WHERE id = $1", [
      pitchDeckId,
    ]);

    if (pitchDeckResult.rows.length === 0) {
      res.status(404).json({ error: "Pitch deck not found" });
      return;
    }

    if (pitchDeckResult.rows[0].status !== "approved") {
      res.status(400).json({ error: "The pitch deck must be approved before creating characters." });
      return;
    }

    const content = await generateCharacterSheetContent(pitchDeckResult.rows[0].content);

    const insertResult = await db.query(
      "INSERT INTO character_sheets (pitch_deck_id, content) VALUES ($1, $2) RETURNING id, status, feedback",
      [pitchDeckId, JSON.stringify(content)]
    );

    res.json({ ...insertResult.rows[0], pitchDeckId, ...content });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/character-sheet/latest", requireLogin, async (req, res) => {
  const result = await db.query(
    "SELECT id, pitch_deck_id, content, status, feedback FROM character_sheets ORDER BY created_at DESC LIMIT 1"
  );

  if (result.rows.length === 0) {
    res.json(null);
    return;
  }

  const row = result.rows[0];
  res.json({ id: row.id, pitchDeckId: row.pitch_deck_id, status: row.status, feedback: row.feedback, ...row.content });
});

app.post("/api/character-sheet/:id/approve", requireRole("admin"), async (req, res) => {
  const result = await db.query(
    "UPDATE character_sheets SET status = 'approved' WHERE id = $1 RETURNING id, pitch_deck_id, content, status, feedback",
    [req.params.id]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: "Character sheet not found" });
    return;
  }

  const row = result.rows[0];
  res.json({ id: row.id, pitchDeckId: row.pitch_deck_id, status: row.status, feedback: row.feedback, ...row.content });
});

app.post("/api/character-sheet/:id/request-changes", requireRole("admin"), async (req, res) => {
  const { feedback } = req.body;

  try {
    const existing = await db.query("SELECT pitch_deck_id, content FROM character_sheets WHERE id = $1", [
      req.params.id,
    ]);

    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Character sheet not found" });
      return;
    }

    const { pitch_deck_id: pitchDeckId, content: previous } = existing.rows[0];

    await db.query("UPDATE character_sheets SET status = 'changes_requested', feedback = $1 WHERE id = $2", [
      feedback,
      req.params.id,
    ]);

    const pitchDeckResult = await db.query("SELECT content FROM pitch_decks WHERE id = $1", [pitchDeckId]);
    const deck = pitchDeckResult.rows[0].content;

    const revisedContent = await generateCharacterSheetContent(deck, { feedback, previous });

    const insertResult = await db.query(
      "INSERT INTO character_sheets (pitch_deck_id, content) VALUES ($1, $2) RETURNING id, status, feedback",
      [pitchDeckId, JSON.stringify(revisedContent)]
    );

    res.json({ ...insertResult.rows[0], pitchDeckId, ...revisedContent, previousFeedback: feedback });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// Builds the bilingual three-act structure via Gemini. When `revision` is
// given, the prompt asks for a rewrite that addresses the Story Writer's
// feedback instead of a first draft.
// Advisory pacing guidance for a given runtime — not schema-enforced (the
// beats array has no min/max), just a prompt hint so the AI doesn't put
// feature-length complexity into a 12-minute short, or a bare-bones
// structure into a 120-minute feature.
function pacingGuidance(minutes) {
  if (minutes <= 15) {
    return "This is a very short film — keep each act extremely lean, with only 1-2 essential beats per act and a tight, minimal plot.";
  }
  if (minutes <= 40) {
    return "This is a short film — keep each act focused, with around 2-3 beats per act and no subplots.";
  }
  if (minutes <= 90) {
    return "This is a mid-length film — each act can have around 3-4 beats, allowing for one supporting subplot.";
  }
  return "This is a standard feature-length film — each act can have 4-6 beats, including secondary character arcs and subplots where appropriate.";
}

function episodePacingGuidance(minutes) {
  if (minutes <= 15) {
    return "keep each episode's own three-act mini-structure extremely lean — only 1-2 beats per act";
  }
  if (minutes <= 30) {
    return "keep each episode's own three-act mini-structure compact — around 2 beats per act";
  }
  return "each episode's own three-act mini-structure can have around 3-4 beats per act, reflecting a fuller episode";
}

async function generateThreeActContent(deck, characterSheet, revision) {
  const isSeries = deck.format?.type === "series" && Array.isArray(deck.episodes);

  let contents = `Title (English): ${deck.title.en}\nLogline (English): ${deck.logline.en}\nPremise (English): ${deck.premise.en}\nTone/Genre (English): ${deck.toneGenre.en}`;

  if (characterSheet?.characters?.length) {
    const characterLines = characterSheet.characters
      .map((c) => `${c.name} (${c.archetype}) — wants: ${c.want.en}; needs: ${c.need.en}; arc: ${c.arc.en}.`)
      .join("\n");
    contents += `\n\nMajor characters, already fully designed — keep the acts and beats consistent with each character's want/need/arc rather than reinventing them:\n${characterLines}`;
  }

  const properties = {
    controllingIdea: BILINGUAL_TEXT_SCHEMA,
    setup: ACT_SCHEMA,
    confrontation: ACT_SCHEMA,
    resolution: ACT_SCHEMA,
  };
  const required = ["controllingIdea", "setup", "confrontation", "resolution"];

  if (isSeries) {
    const episodeList = deck.episodes
      .map((episode, index) => `Episode ${index + 1}: ${episode.title.en} — ${episode.synopsis.en}`)
      .join("\n");

    const episodeMinutes = deck.format.episodeMinutes ?? null;
    const totalMinutes =
      deck.format.episodeCount && episodeMinutes ? deck.format.episodeCount * episodeMinutes : null;

    const overallPacingLine = totalMinutes
      ? ` The series runs ${deck.format.episodeCount} episodes × ${episodeMinutes} minutes (${totalMinutes} minutes total) — for the OVERALL structure, ${pacingGuidance(totalMinutes).charAt(0).toLowerCase()}${pacingGuidance(totalMinutes).slice(1)}`
      : "";
    const perEpisodePacingLine = episodeMinutes
      ? ` Each individual episode runs ${episodeMinutes} minutes — ${episodePacingGuidance(episodeMinutes)}.`
      : "";

    contents += `\n\nThis is a web series with exactly ${deck.episodes.length} episodes:\n${episodeList}\n\nProvide "setup", "confrontation", "resolution" as a three-act structure for the ENTIRE series arc (the overall bird's-eye story spanning all episodes).${overallPacingLine} ALSO provide "episodeStructures": an array of exactly ${deck.episodes.length} objects, in episode order, each with its OWN "setup", "confrontation", "resolution" — a compact three-act mini-structure for what happens within just that single episode, consistent with its synopsis above.${perEpisodePacingLine}`;

    properties.episodeStructures = {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          setup: ACT_SCHEMA,
          confrontation: ACT_SCHEMA,
          resolution: ACT_SCHEMA,
        },
        required: ["setup", "confrontation", "resolution"],
      },
    };
    required.push("episodeStructures");
  } else if (deck.format?.runtimeMinutes) {
    contents += `\n\nThis is a feature film with a target runtime of ${deck.format.runtimeMinutes} minutes. ${pacingGuidance(deck.format.runtimeMinutes)}`;
  }

  if (revision) {
    contents += `\n\nThis is a REVISION of a previous three-act structure. The Story Writer reviewed it and requested changes.\nStory Writer's feedback: "${revision.feedback}"\nPrevious setup summary (English): ${revision.previous.setup.summary.en}\nPrevious confrontation summary (English): ${revision.previous.confrontation.summary.en}\nPrevious resolution summary (English): ${revision.previous.resolution.summary.en}\nRevise the three-act structure to address the feedback directly.`;
  }

  const response = await ai.models.generateContent({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: THREE_ACT_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: isSeries ? 16384 : 4096,
      responseSchema: {
        type: Type.OBJECT,
        properties,
        required,
      },
    },
  });

  return sanitizeBilingualContent(JSON.parse(response.text));
}

app.post("/api/three-act-structure", requireRole("admin"), async (req, res) => {
  const { pitchDeckId } = req.body;

  try {
    const pitchDeckResult = await db.query("SELECT content FROM pitch_decks WHERE id = $1", [
      pitchDeckId,
    ]);

    if (pitchDeckResult.rows.length === 0) {
      res.status(404).json({ error: "Pitch deck not found" });
      return;
    }

    const characterSheetResult = await db.query(
      "SELECT content, status FROM character_sheets WHERE pitch_deck_id = $1 ORDER BY created_at DESC LIMIT 1",
      [pitchDeckId]
    );

    if (characterSheetResult.rows.length === 0 || characterSheetResult.rows[0].status !== "approved") {
      res.status(400).json({ error: "Characters must be created and approved before generating the three-act structure." });
      return;
    }

    const content = await generateThreeActContent(pitchDeckResult.rows[0].content, characterSheetResult.rows[0].content);

    const insertResult = await db.query(
      "INSERT INTO three_act_structures (pitch_deck_id, content) VALUES ($1, $2) RETURNING id, status, feedback",
      [pitchDeckId, JSON.stringify(content)]
    );

    res.json({ ...insertResult.rows[0], pitchDeckId, ...content });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/three-act-structure/latest", requireLogin, async (req, res) => {
  const result = await db.query(
    "SELECT id, pitch_deck_id, content, status, feedback FROM three_act_structures ORDER BY created_at DESC LIMIT 1"
  );

  if (result.rows.length === 0) {
    res.json(null);
    return;
  }

  const row = result.rows[0];
  res.json({ id: row.id, pitchDeckId: row.pitch_deck_id, status: row.status, feedback: row.feedback, ...row.content });
});

app.get("/api/three-act-structure/history", requireLogin, async (req, res) => {
  const result = await db.query(
    "SELECT id, status, feedback, created_at FROM three_act_structures WHERE pitch_deck_id = $1 ORDER BY created_at ASC",
    [req.query.pitchDeckId]
  );

  res.json(
    result.rows.map((row) => ({
      id: row.id,
      status: row.status,
      feedback: row.feedback,
      createdAt: row.created_at,
    }))
  );
});

app.post("/api/three-act-structure/:id/lock", requireRole("admin"), async (req, res) => {
  const result = await db.query(
    "UPDATE three_act_structures SET status = 'locked' WHERE id = $1 RETURNING id, pitch_deck_id, content, status, feedback",
    [req.params.id]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: "Three-act structure not found" });
    return;
  }

  const row = result.rows[0];
  res.json({ id: row.id, pitchDeckId: row.pitch_deck_id, status: row.status, feedback: row.feedback, ...row.content });
});

app.post("/api/three-act-structure/:id/request-changes", requireRole("admin"), async (req, res) => {
  const { feedback } = req.body;

  try {
    const existing = await db.query(
      "SELECT pitch_deck_id, content FROM three_act_structures WHERE id = $1",
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Three-act structure not found" });
      return;
    }

    const { pitch_deck_id: pitchDeckId, content: previous } = existing.rows[0];

    await db.query(
      "UPDATE three_act_structures SET status = 'changes_requested', feedback = $1 WHERE id = $2",
      [feedback, req.params.id]
    );

    const pitchDeckResult = await db.query("SELECT content FROM pitch_decks WHERE id = $1", [
      pitchDeckId,
    ]);
    const deck = pitchDeckResult.rows[0].content;

    const characterSheetResult = await db.query(
      "SELECT content FROM character_sheets WHERE pitch_deck_id = $1 ORDER BY created_at DESC LIMIT 1",
      [pitchDeckId]
    );
    const characterSheet = characterSheetResult.rows[0]?.content;

    const revisedContent = await generateThreeActContent(deck, characterSheet, { feedback, previous });

    const insertResult = await db.query(
      "INSERT INTO three_act_structures (pitch_deck_id, content) VALUES ($1, $2) RETURNING id, status, feedback",
      [pitchDeckId, JSON.stringify(revisedContent)]
    );

    res.json({ ...insertResult.rows[0], pitchDeckId, ...revisedContent, previousFeedback: feedback });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/three-act-structure/:id", requireLogin, async (req, res) => {
  const result = await db.query(
    "SELECT id, pitch_deck_id, content, status, feedback, created_at FROM three_act_structures WHERE id = $1",
    [req.params.id]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: "Three-act structure not found" });
    return;
  }

  const row = result.rows[0];
  res.json({
    id: row.id,
    pitchDeckId: row.pitch_deck_id,
    status: row.status,
    feedback: row.feedback,
    createdAt: row.created_at,
    ...row.content,
  });
});

// A Bit Sheet bridges the high-level three-act structure and the scene-by-
// scene breakdown: roughly one bit per 8 minutes of runtime, clamped to a
// sane range — not a hard rule, just a starting suggestion for the prompt.
// Floor raised to 12 (from 10): opening_image, theme_stated, plot_point_1,
// all_is_lost, plot_point_2, final_image, plus the 3-bit climax sequence
// (crisis/climax/realization) are now 8 mandatory structural anchors (see
// BIT_SHEET_SYSTEM_PROMPT) — a shorter list would leave no room for the
// catalyst/midpoint/setback beats that anchor the middle of the story too.
function suggestBitCount(minutes) {
  if (!minutes) return 12;
  return Math.min(24, Math.max(12, Math.round(minutes / 8)));
}

// Builds the bilingual Bit Sheet via Gemini, from a LOCKED three-act
// structure. For a web series, generates one Bit Sheet per episode (using
// that episode's own mini three-act structure); for a film, one Bit Sheet
// covering the whole three-act structure. When `revision` is given, the
// prompt asks for a rewrite that addresses feedback instead of a first draft.
async function generateBitSheetContent(threeAct, deck, revision) {
  const isSeries =
    deck.format?.type === "series" &&
    Array.isArray(deck.episodes) &&
    Array.isArray(threeAct.episodeStructures);

  const properties = {};
  const required = [];
  let contents;

  if (isSeries) {
    const episodesText = deck.episodes
      .map((episode, index) => {
        const structure = threeAct.episodeStructures[index];
        const suggested = suggestBitCount(deck.format.episodeMinutes);
        return `Episode ${index + 1}: ${episode.title.en} (aim for roughly ${suggested} bits)\nSetup: ${actText(structure.setup)}\nConfrontation: ${actText(structure.confrontation)}\nResolution: ${actText(structure.resolution)}`;
      })
      .join("\n\n");

    contents = `This is a web series with ${deck.episodes.length} episodes. Here is each episode's own three-act mini-structure:\n\n${episodesText}\n\nFor EACH episode, break its three acts into its OWN complete Bit Sheet — an ordered list of its major plot-point beats. Each episode is a self-contained mini-story, so each episode's Bit Sheet must include its own opening_image, theme_stated, plot_point_1, all_is_lost, plot_point_2, and final_image anchors positioned within that episode, not just once for the whole series. Return "episodeBits": an array of exactly ${deck.episodes.length} objects, in episode order, each with a "bits" array covering just that episode.`;

    properties.episodeBits = {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { bits: { type: Type.ARRAY, items: BIT_SCHEMA } },
        required: ["bits"],
      },
    };
    required.push("episodeBits");
  } else {
    const suggested = suggestBitCount(deck.format?.runtimeMinutes);
    contents = `Here is the film's locked three-act structure:\nSetup: ${actText(threeAct.setup)}\nConfrontation: ${actText(threeAct.confrontation)}\nResolution: ${actText(threeAct.resolution)}\n\nBreak this into a Bit Sheet — an ordered list of the film's major plot-point beats (aim for roughly ${suggested} bits, covering all three acts in order). Return "bits": a single array covering the whole film.`;

    properties.bits = { type: Type.ARRAY, items: BIT_SCHEMA };
    required.push("bits");
  }

  if (threeAct.controllingIdea) {
    contents += `\n\nThe story's Controlling Idea (theme) is: "${threeAct.controllingIdea.en}" — the theme_stated bit especially, and every other bit generally, should stay true to this idea.`;
  }

  if (revision) {
    contents += `\n\nThis is a REVISION of a previous Bit Sheet. The Story Writer reviewed it and requested changes.\nFeedback: "${revision.feedback}"\nRevise the Bit Sheet to address the feedback directly.`;
  }

  const response = await ai.models.generateContent({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: BIT_SHEET_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: isSeries ? 12288 : 6144,
      responseSchema: {
        type: Type.OBJECT,
        properties,
        required,
      },
    },
  });

  const content = sanitizeBilingualContent(JSON.parse(response.text));
  // Carry the Controlling Idea forward so later stages (scene generation,
  // screenplay dialogue) can reference it without an extra database join.
  return threeAct.controllingIdea ? { ...content, controllingIdea: threeAct.controllingIdea } : content;
}

app.post("/api/bit-sheet", requireRole("admin"), async (req, res) => {
  const { threeActStructureId } = req.body;

  try {
    const threeActResult = await db.query(
      "SELECT pitch_deck_id, content, status FROM three_act_structures WHERE id = $1",
      [threeActStructureId]
    );

    if (threeActResult.rows.length === 0) {
      res.status(404).json({ error: "Three-act structure not found" });
      return;
    }

    const { pitch_deck_id: pitchDeckId, content: threeAct, status } = threeActResult.rows[0];

    if (status !== "locked") {
      res.status(400).json({ error: "The three-act structure must be locked before generating a bit sheet." });
      return;
    }

    const pitchDeckResult = await db.query("SELECT content FROM pitch_decks WHERE id = $1", [pitchDeckId]);
    const deck = pitchDeckResult.rows[0].content;

    const content = await generateBitSheetContent(threeAct, deck);

    const insertResult = await db.query(
      "INSERT INTO bit_sheets (three_act_structure_id, content) VALUES ($1, $2) RETURNING id, status, feedback",
      [threeActStructureId, JSON.stringify(content)]
    );

    res.json({ ...insertResult.rows[0], threeActStructureId, ...content });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/bit-sheet/latest", requireLogin, async (req, res) => {
  const result = await db.query(
    "SELECT id, three_act_structure_id, content, status, feedback FROM bit_sheets ORDER BY created_at DESC LIMIT 1"
  );

  if (result.rows.length === 0) {
    res.json(null);
    return;
  }

  const row = result.rows[0];
  res.json({
    id: row.id,
    threeActStructureId: row.three_act_structure_id,
    status: row.status,
    feedback: row.feedback,
    ...row.content,
  });
});

app.post("/api/bit-sheet/:id/approve", requireRole("admin"), async (req, res) => {
  const result = await db.query(
    "UPDATE bit_sheets SET status = 'approved' WHERE id = $1 RETURNING id, three_act_structure_id, content, status, feedback",
    [req.params.id]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: "Bit sheet not found" });
    return;
  }

  const row = result.rows[0];
  res.json({
    id: row.id,
    threeActStructureId: row.three_act_structure_id,
    status: row.status,
    feedback: row.feedback,
    ...row.content,
  });
});

app.post("/api/bit-sheet/:id/request-changes", requireRole("admin"), async (req, res) => {
  const { feedback } = req.body;

  try {
    const existing = await db.query("SELECT three_act_structure_id, content FROM bit_sheets WHERE id = $1", [
      req.params.id,
    ]);

    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Bit sheet not found" });
      return;
    }

    const { three_act_structure_id: threeActStructureId, content: previous } = existing.rows[0];

    await db.query("UPDATE bit_sheets SET status = 'changes_requested', feedback = $1 WHERE id = $2", [
      feedback,
      req.params.id,
    ]);

    const threeActResult = await db.query("SELECT pitch_deck_id, content FROM three_act_structures WHERE id = $1", [
      threeActStructureId,
    ]);
    const { pitch_deck_id: pitchDeckId, content: threeAct } = threeActResult.rows[0];

    const pitchDeckResult = await db.query("SELECT content FROM pitch_decks WHERE id = $1", [pitchDeckId]);
    const deck = pitchDeckResult.rows[0].content;

    const revisedContent = await generateBitSheetContent(threeAct, deck, { feedback, previous });

    const insertResult = await db.query(
      "INSERT INTO bit_sheets (three_act_structure_id, content) VALUES ($1, $2) RETURNING id, status, feedback",
      [threeActStructureId, JSON.stringify(revisedContent)]
    );

    res.json({ ...insertResult.rows[0], threeActStructureId, ...revisedContent, previousFeedback: feedback });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// Builds the bilingual scene-by-scene one-liner list via Gemini, from an
// APPROVED Bit Sheet. For a web series, generates one scene list per episode
// (using that episode's own Bit Sheet); for a film, one scene list covering
// the whole Bit Sheet. When `revision` is given, the prompt asks for a
// rewrite that addresses feedback instead of a first draft.
function actText(act) {
  return `${act.summary.en} Key beats: ${act.beats.map((beat) => beat.en).join("; ")}`;
}

function bitSheetOutlineText(bits) {
  return bits
    .map((bit, index) => `${index + 1}. [Act ${bit.actNumber} - ${bit.beatType}] ${bit.title.en}: ${bit.description.en}`)
    .join("\n");
}

function sumSceneMinutes(scenes) {
  return Math.round(scenes.reduce((total, scene) => total + (scene.estimatedMinutes || 0), 0) * 10) / 10;
}

// A rough "2 minutes per scene" pacing guideline — used only to give the AI
// a starting scene-count suggestion in the prompt, never enforced as a rule.
function suggestSceneCount(targetMinutes) {
  return Math.max(3, Math.round(targetMinutes / 2));
}

function isFarFromTarget(total, target) {
  if (!target) return false;
  return Math.abs(total - target) / target > 0.25;
}

// Attaches the target runtime and the actual estimated total (summed from
// each scene's estimatedMinutes) onto the content, so both the retry check
// below and the frontend can see how closely the scene list matches the
// runtime the Story Writer originally asked for.
function annotateSceneListTotals(content, isSeries, episodeTargetMinutes, filmTargetMinutes) {
  if (isSeries) {
    return {
      ...content,
      episodeScenes: content.episodeScenes.map((episodeScene) => ({
        ...episodeScene,
        totalEstimatedMinutes: sumSceneMinutes(episodeScene.scenes),
        targetMinutes: episodeTargetMinutes,
      })),
    };
  }
  return {
    ...content,
    totalEstimatedMinutes: sumSceneMinutes(content.scenes),
    targetMinutes: filmTargetMinutes,
  };
}

function sceneListNeedsRetry(content, isSeries) {
  if (isSeries) {
    return content.episodeScenes.some((episodeScene) =>
      isFarFromTarget(episodeScene.totalEstimatedMinutes, episodeScene.targetMinutes)
    );
  }
  return isFarFromTarget(content.totalEstimatedMinutes, content.targetMinutes);
}

function buildRetryCorrectionNote(content, isSeries) {
  if (isSeries) {
    const lines = content.episodeScenes
      .map((episodeScene, index) =>
        isFarFromTarget(episodeScene.totalEstimatedMinutes, episodeScene.targetMinutes)
          ? `Episode ${index + 1}: your scenes totaled ${episodeScene.totalEstimatedMinutes} minutes against a target of ${episodeScene.targetMinutes} minutes — adjust the number and length of scenes so the total is much closer to the target.`
          : null
      )
      .filter(Boolean)
      .join("\n");
    return `\n\nIMPORTANT CORRECTION NEEDED:\n${lines}`;
  }

  return `\n\nIMPORTANT CORRECTION NEEDED: your scenes totaled ${content.totalEstimatedMinutes} minutes against a target of ${content.targetMinutes} minutes — adjust the number and length of scenes so the total is much closer to the target.`;
}

// A longer target runtime means more scenes, which means more output tokens
// — a fixed budget that worked for a 20-minute episode silently truncates
// (and breaks JSON parsing) for a 120-minute feature. ~150 tokens/minute is
// a generous estimate (bilingual location + one-liner + fields per scene,
// roughly one scene per 2 minutes), capped to stay within reasonable bounds.
function estimateTokenBudget(totalTargetMinutes, isSeries) {
  const fallback = isSeries ? 16384 : 8192;
  if (!totalTargetMinutes) return fallback;
  const estimated = Math.ceil(totalTargetMinutes * 150);
  return Math.min(32768, Math.max(fallback, estimated));
}

async function callSceneListGemini(contents, isSeries, totalTargetMinutes) {
  const properties = isSeries
    ? {
        episodeScenes: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: { scenes: { type: Type.ARRAY, items: SCENE_SCHEMA } },
            required: ["scenes"],
          },
        },
      }
    : { scenes: { type: Type.ARRAY, items: SCENE_SCHEMA } };
  const required = isSeries ? ["episodeScenes"] : ["scenes"];

  const response = await ai.models.generateContent({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: SCENE_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: estimateTokenBudget(totalTargetMinutes, isSeries),
      responseSchema: {
        type: Type.OBJECT,
        properties,
        required,
      },
    },
  });

  return sanitizeBilingualContent(JSON.parse(response.text));
}

async function generateSceneListContent(bitSheet, deck, revision) {
  const isSeries =
    deck.format?.type === "series" &&
    Array.isArray(deck.episodes) &&
    Array.isArray(bitSheet.episodeBits);

  const episodeTargetMinutes = isSeries ? deck.format.episodeMinutes ?? null : null;
  const filmTargetMinutes = !isSeries ? deck.format?.runtimeMinutes ?? null : null;

  // One Gemini call returns scenes for every episode at once (series) or the
  // whole film — the token budget needs to cover that combined total, not
  // just a single episode's runtime.
  const totalTargetMinutes = isSeries
    ? deck.format.episodeCount && episodeTargetMinutes
      ? deck.format.episodeCount * episodeTargetMinutes
      : null
    : filmTargetMinutes;

  let contents;

  if (isSeries) {
    const episodesText = deck.episodes
      .map((episode, index) => {
        const bits = bitSheet.episodeBits[index].bits;
        const targetLine = episodeTargetMinutes
          ? ` Target on-screen runtime for this episode: ${episodeTargetMinutes} minutes (aim for roughly ${suggestSceneCount(episodeTargetMinutes)} scenes, adjusted as pacing requires).`
          : "";
        return `Episode ${index + 1}: ${episode.title.en}${targetLine}\nBit Sheet (major plot points, in order):\n${bitSheetOutlineText(bits)}`;
      })
      .join("\n\n");

    contents = `This is a web series with ${deck.episodes.length} episodes. Here is each episode's own Bit Sheet — its major plot-point beats, already verified:\n\n${episodesText}\n\nFor EACH episode, expand its Bit Sheet into a full scene-by-scene list — each bit typically becomes 1-3 scenes — whose scenes' combined "estimatedMinutes" add up to approximately that episode's target runtime given above. Return "episodeScenes": an array of exactly ${deck.episodes.length} objects, in episode order, each with a "scenes" array covering just that episode.`;
  } else {
    const targetLine = filmTargetMinutes
      ? `Target on-screen runtime for the whole film: ${filmTargetMinutes} minutes (aim for roughly ${suggestSceneCount(filmTargetMinutes)} scenes, adjusted as pacing requires).`
      : "";
    contents = `Here is the film's Bit Sheet — its major plot-point beats, already verified, in order:\n${bitSheetOutlineText(bitSheet.bits)}\n${targetLine}\n\nExpand this Bit Sheet into a full scene-by-scene list for the entire film — each bit typically becomes 1-3 scenes — whose scenes' combined "estimatedMinutes" add up to approximately the target runtime given above. Return "scenes": a single array covering the whole film.`;
  }

  if (bitSheet.controllingIdea) {
    contents += `\n\nThe story's Controlling Idea (theme) is: "${bitSheet.controllingIdea.en}" — keep scenes true to it.`;
  }

  if (revision) {
    contents += `\n\nThis is a REVISION of a previous scene list. The Screenplay Writer reviewed it and requested changes.\nFeedback: "${revision.feedback}"\nRevise the scene list to address this feedback directly, keeping the same overall structure otherwise.`;
  }

  let content = await callSceneListGemini(contents, isSeries, totalTargetMinutes);
  content = annotateSceneListTotals(content, isSeries, episodeTargetMinutes, filmTargetMinutes);

  // If the estimated total is far from the target runtime, give the model one
  // chance to correct itself — capped at a single retry so a persistently
  // stubborn response can't burn through the daily API quota.
  if (sceneListNeedsRetry(content, isSeries)) {
    const correctionNote = buildRetryCorrectionNote(content, isSeries);
    content = await callSceneListGemini(contents + correctionNote, isSeries, totalTargetMinutes);
    content = annotateSceneListTotals(content, isSeries, episodeTargetMinutes, filmTargetMinutes);
  }

  // Carry the Controlling Idea forward so the screenplay-writing stage can
  // reference it too, without an extra database join.
  return bitSheet.controllingIdea ? { ...content, controllingIdea: bitSheet.controllingIdea } : content;
}

app.post("/api/scene-list", requireRole("admin"), async (req, res) => {
  const { bitSheetId } = req.body;

  try {
    const bitSheetResult = await db.query(
      "SELECT three_act_structure_id, content, status FROM bit_sheets WHERE id = $1",
      [bitSheetId]
    );

    if (bitSheetResult.rows.length === 0) {
      res.status(404).json({ error: "Bit sheet not found" });
      return;
    }

    const { three_act_structure_id: threeActStructureId, content: bitSheet, status } = bitSheetResult.rows[0];

    if (status !== "approved") {
      res.status(400).json({ error: "The bit sheet must be approved before generating scenes." });
      return;
    }

    const threeActResult = await db.query("SELECT pitch_deck_id FROM three_act_structures WHERE id = $1", [
      threeActStructureId,
    ]);
    const pitchDeckResult = await db.query("SELECT content FROM pitch_decks WHERE id = $1", [
      threeActResult.rows[0].pitch_deck_id,
    ]);
    const deck = pitchDeckResult.rows[0].content;

    const content = await generateSceneListContent(bitSheet, deck);

    const insertResult = await db.query(
      "INSERT INTO scene_lists (bit_sheet_id, content) VALUES ($1, $2) RETURNING id, status, feedback",
      [bitSheetId, JSON.stringify(content)]
    );

    res.json({ ...insertResult.rows[0], bitSheetId, ...content });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/scene-list/latest", requireLogin, async (req, res) => {
  const result = await db.query(
    "SELECT id, bit_sheet_id, content, status, feedback FROM scene_lists ORDER BY created_at DESC LIMIT 1"
  );

  if (result.rows.length === 0) {
    res.json(null);
    return;
  }

  const row = result.rows[0];
  res.json({
    id: row.id,
    bitSheetId: row.bit_sheet_id,
    status: row.status,
    feedback: row.feedback,
    ...row.content,
  });
});

app.post("/api/scene-list/:id/approve", requireRole("admin"), async (req, res) => {
  const result = await db.query(
    "UPDATE scene_lists SET status = 'approved' WHERE id = $1 RETURNING id, bit_sheet_id, content, status, feedback",
    [req.params.id]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: "Scene list not found" });
    return;
  }

  const row = result.rows[0];
  res.json({
    id: row.id,
    bitSheetId: row.bit_sheet_id,
    status: row.status,
    feedback: row.feedback,
    ...row.content,
  });
});

app.post("/api/scene-list/:id/request-changes", requireRole("admin"), async (req, res) => {
  const { feedback } = req.body;

  try {
    const existing = await db.query("SELECT bit_sheet_id, content FROM scene_lists WHERE id = $1", [
      req.params.id,
    ]);

    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Scene list not found" });
      return;
    }

    const { bit_sheet_id: bitSheetId, content: previous } = existing.rows[0];

    await db.query("UPDATE scene_lists SET status = 'changes_requested', feedback = $1 WHERE id = $2", [
      feedback,
      req.params.id,
    ]);

    const bitSheetResult = await db.query("SELECT three_act_structure_id, content FROM bit_sheets WHERE id = $1", [
      bitSheetId,
    ]);
    const { three_act_structure_id: threeActStructureId, content: bitSheet } = bitSheetResult.rows[0];

    const threeActResult = await db.query("SELECT pitch_deck_id FROM three_act_structures WHERE id = $1", [
      threeActStructureId,
    ]);
    const pitchDeckResult = await db.query("SELECT content FROM pitch_decks WHERE id = $1", [
      threeActResult.rows[0].pitch_deck_id,
    ]);
    const deck = pitchDeckResult.rows[0].content;

    const revisedContent = await generateSceneListContent(bitSheet, deck, { feedback, previous });

    const insertResult = await db.query(
      "INSERT INTO scene_lists (bit_sheet_id, content) VALUES ($1, $2) RETURNING id, status, feedback",
      [bitSheetId, JSON.stringify(revisedContent)]
    );

    res.json({ ...insertResult.rows[0], bitSheetId, ...revisedContent, previousFeedback: feedback });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

function sceneOutlineLine(scene, index) {
  return `Scene ${index + 1} (Act ${scene.actNumber}, ${scene.intExt}. ${scene.location.en} - ${scene.timeOfDay}): ${scene.oneLiner.en}`;
}

function elementsToPlainText(elements) {
  return elements
    .map((element) => (element.type === "dialogue" ? `${element.character}: ${element.text.en}` : element.text.en))
    .join("\n");
}

// Builds the full screenplay content — action lines and dialogue — for ONE
// scene at a time, per the agent spec's "scene-by-scene, not the whole film
// at once" instruction. `allScenes` gives the AI the full outline for
// continuity; `previousElements` (the immediately preceding scene's already-
// written content, if any) helps keep character voice consistent scene to
// scene. When `revision` is given, the prompt asks for a rewrite instead.
async function generateScreenplaySceneContent(deck, allScenes, sceneIndex, previousElements, controllingIdea, revision) {
  const targetScene = allScenes[sceneIndex];
  const outlineText = allScenes.map((scene, index) => sceneOutlineLine(scene, index)).join("\n");
  const suggestedElementCount = Math.max(3, Math.round(targetScene.estimatedMinutes * 5));

  let contents = `Story title: ${deck.title.en}\nLogline: ${deck.logline.en}\nTone/Genre: ${deck.toneGenre.en}\n\nFull scene outline for context (already established elsewhere — do not rewrite these, just stay consistent with them):\n${outlineText}\n\nNow write the FULL screenplay content — action lines and dialogue — for ONLY this one scene:\n${sceneOutlineLine(targetScene, sceneIndex)}\n\nThis scene is estimated at ${targetScene.estimatedMinutes} minute(s) of screen time — aim for roughly ${suggestedElementCount} elements (a natural mix of action lines and dialogue exchanges), but let the actual scene content decide.`;

  if (controllingIdea) {
    contents += `\n\nThe story's Controlling Idea (theme) is: "${controllingIdea.en}" — let the dialogue and action reflect it where natural, without stating it outright.`;
  }

  if (previousElements) {
    contents += `\n\nHere is the immediately PRECEDING scene's screenplay content, for character voice and continuity:\n${elementsToPlainText(previousElements)}`;
  }

  if (revision) {
    contents += `\n\nThis is a REVISION of a previous draft of this scene. The Screenplay Writer reviewed it and requested changes.\nPrevious draft:\n${elementsToPlainText(revision.previous.elements)}\nFeedback: "${revision.feedback}"\nRevise the scene to address the feedback directly.`;
  }

  const response = await ai.models.generateContent({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: SCREENPLAY_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
      responseSchema: {
        type: Type.OBJECT,
        properties: { elements: { type: Type.ARRAY, items: SCREENPLAY_ELEMENT_SCHEMA } },
        required: ["elements"],
      },
    },
  });

  return sanitizeBilingualContent(JSON.parse(response.text));
}

async function fetchLatestScreenplayScene(sceneListId, episodeIndex, sceneIndex) {
  const hasEpisode = episodeIndex !== null && episodeIndex !== undefined;
  const query = hasEpisode
    ? "SELECT id, content, status, feedback FROM screenplay_scenes WHERE scene_list_id = $1 AND episode_index = $2 AND scene_index = $3 ORDER BY created_at DESC LIMIT 1"
    : "SELECT id, content, status, feedback FROM screenplay_scenes WHERE scene_list_id = $1 AND episode_index IS NULL AND scene_index = $2 ORDER BY created_at DESC LIMIT 1";
  const params = hasEpisode ? [sceneListId, episodeIndex, sceneIndex] : [sceneListId, sceneIndex];
  const result = await db.query(query, params);
  return result.rows[0] || null;
}

async function fetchSceneListContext(sceneListId) {
  const result = await db.query(
    `SELECT sl.content AS scene_list_content, sl.status AS scene_list_status, pd.content AS pitch_deck_content
     FROM scene_lists sl
     JOIN bit_sheets bs ON bs.id = sl.bit_sheet_id
     JOIN three_act_structures tas ON tas.id = bs.three_act_structure_id
     JOIN pitch_decks pd ON pd.id = tas.pitch_deck_id
     WHERE sl.id = $1`,
    [sceneListId]
  );
  return result.rows[0] || null;
}

app.post("/api/screenplay/scene", requireRole("admin"), async (req, res) => {
  const { sceneListId, episodeIndex, sceneIndex } = req.body;
  const hasEpisode = episodeIndex !== null && episodeIndex !== undefined;

  try {
    const context = await fetchSceneListContext(sceneListId);

    if (!context) {
      res.status(404).json({ error: "Scene list not found" });
      return;
    }

    if (context.scene_list_status !== "approved") {
      res.status(400).json({ error: "The scene list must be approved before writing the screenplay." });
      return;
    }

    const allScenes = hasEpisode
      ? context.scene_list_content.episodeScenes[episodeIndex].scenes
      : context.scene_list_content.scenes;

    const previousRow =
      sceneIndex > 0
        ? await fetchLatestScreenplayScene(sceneListId, hasEpisode ? episodeIndex : null, sceneIndex - 1)
        : null;

    const content = await generateScreenplaySceneContent(
      context.pitch_deck_content,
      allScenes,
      sceneIndex,
      previousRow ? previousRow.content.elements : null,
      context.scene_list_content.controllingIdea
    );

    const insertResult = await db.query(
      "INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content) VALUES ($1, $2, $3, $4) RETURNING id, episode_index, scene_index, status, feedback",
      [sceneListId, hasEpisode ? episodeIndex : null, sceneIndex, JSON.stringify(content)]
    );

    res.json({
      ...insertResult.rows[0],
      sceneListId,
      episodeIndex: insertResult.rows[0].episode_index,
      sceneIndex: insertResult.rows[0].scene_index,
      ...content,
    });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/screenplay/scenes", requireLogin, async (req, res) => {
  const result = await db.query(
    `SELECT DISTINCT ON (episode_index, scene_index) id, episode_index, scene_index, content, status, feedback, created_at
     FROM screenplay_scenes
     WHERE scene_list_id = $1
     ORDER BY episode_index, scene_index, created_at DESC`,
    [req.query.sceneListId]
  );

  res.json(
    result.rows.map((row) => ({
      id: row.id,
      episodeIndex: row.episode_index,
      sceneIndex: row.scene_index,
      status: row.status,
      feedback: row.feedback,
      ...row.content,
    }))
  );
});

app.post("/api/screenplay/scene/:id/request-changes", requireRole("admin"), async (req, res) => {
  const { feedback } = req.body;

  try {
    const existing = await db.query(
      "SELECT scene_list_id, episode_index, scene_index, content FROM screenplay_scenes WHERE id = $1",
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Screenplay scene not found" });
      return;
    }

    const {
      scene_list_id: sceneListId,
      episode_index: episodeIndex,
      scene_index: sceneIndex,
      content: previous,
    } = existing.rows[0];
    const hasEpisode = episodeIndex !== null;

    await db.query("UPDATE screenplay_scenes SET status = 'changes_requested', feedback = $1 WHERE id = $2", [
      feedback,
      req.params.id,
    ]);

    const context = await fetchSceneListContext(sceneListId);
    const allScenes = hasEpisode
      ? context.scene_list_content.episodeScenes[episodeIndex].scenes
      : context.scene_list_content.scenes;

    const previousRow =
      sceneIndex > 0 ? await fetchLatestScreenplayScene(sceneListId, hasEpisode ? episodeIndex : null, sceneIndex - 1) : null;

    const revisedContent = await generateScreenplaySceneContent(
      context.pitch_deck_content,
      allScenes,
      sceneIndex,
      previousRow ? previousRow.content.elements : null,
      context.scene_list_content.controllingIdea,
      { feedback, previous }
    );

    const insertResult = await db.query(
      "INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content) VALUES ($1, $2, $3, $4) RETURNING id, episode_index, scene_index, status, feedback",
      [sceneListId, episodeIndex, sceneIndex, JSON.stringify(revisedContent)]
    );

    res.json({
      ...insertResult.rows[0],
      sceneListId,
      episodeIndex: insertResult.rows[0].episode_index,
      sceneIndex: insertResult.rows[0].scene_index,
      ...revisedContent,
      previousFeedback: feedback,
    });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// --- Production Management: once the scene list is approved, propose a
// day-by-day shoot schedule from character/location availability. Scene
// references point back into the existing scene list by position rather
// than duplicating scene content.

function flattenScenesForScheduling(sceneList) {
  if (sceneList.episodeScenes) {
    const lines = [];
    sceneList.episodeScenes.forEach((episodeScene, episodeIndex) => {
      episodeScene.scenes.forEach((scene, sceneIndex) => {
        lines.push(
          `Episode ${episodeIndex + 1}, Scene ${sceneIndex + 1}: ${scene.intExt}. ${scene.location.en} — ${scene.timeOfDay}. ${scene.oneLiner.en}`
        );
      });
    });
    return lines.join("\n");
  }
  return sceneList.scenes
    .map((scene, sceneIndex) => `Scene ${sceneIndex + 1}: ${scene.intExt}. ${scene.location.en} — ${scene.timeOfDay}. ${scene.oneLiner.en}`)
    .join("\n");
}

// Prefers the richest material available for a script breakdown: the raw
// text of an imported screenplay, then actual written screenplay scenes
// (action + dialogue) if the Story Agent wrote them, falling back to the
// scene list's one-liners if neither exists yet.
async function buildBreakdownSourceText(sceneList, sceneListId) {
  if (sceneList.sourceText) {
    return sceneList.sourceText;
  }

  const scenesResult = await db.query(
    `SELECT DISTINCT ON (episode_index, scene_index) episode_index, scene_index, content, created_at
     FROM screenplay_scenes
     WHERE scene_list_id = $1
     ORDER BY episode_index, scene_index, created_at DESC`,
    [sceneListId]
  );

  if (scenesResult.rows.length > 0) {
    return scenesResult.rows
      .map((row) => {
        const elements = row.content.elements ?? [];
        const body = elements
          .map((el) => (el.type === "dialogue" ? `${el.character}: ${el.text.en}` : el.text.en))
          .join("\n");
        return `Scene ${row.scene_index + 1}:\n${body}`;
      })
      .join("\n\n");
  }

  return flattenScenesForScheduling(sceneList);
}

async function generateScriptBreakdownContent(sourceText, revision) {
  let contents = `The script material:\n${sourceText}`;

  if (revision) {
    contents += `\n\nThis is a REVISION of a previous breakdown. Feedback: "${revision.feedback}"\nRevise the breakdown to address the feedback directly.`;
  }

  const response = await generateContentWithRetry({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: SCRIPT_BREAKDOWN_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 12288,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          artistList: { type: Type.ARRAY, items: BREAKDOWN_ITEM_SCHEMA },
          locationList: { type: Type.ARRAY, items: BREAKDOWN_LOCATION_SCHEMA },
          props: { type: Type.ARRAY, items: BREAKDOWN_ITEM_SCHEMA },
          costumes: { type: Type.ARRAY, items: BREAKDOWN_COSTUME_SCHEMA },
          art: { type: Type.ARRAY, items: BREAKDOWN_ITEM_SCHEMA },
        },
        required: ["artistList", "locationList", "props", "costumes", "art"],
      },
    },
  });

  return sanitizeBilingualContent(JSON.parse(response.text));
}

// Runs the initial breakdown, then immediately re-verifies every category
// against the full script the same way the manual "reanalyze" button does —
// each category gets its own focused re-read rather than trusting the single
// combined first pass, since a breakdown is what the crew orders/books
// against and a missed prop or background artist becomes a real production
// problem later.
async function generateDeepScriptBreakdownContent(sourceText, revision) {
  const firstPass = await generateScriptBreakdownContent(sourceText, revision);

  const refinedEntries = await mapWithConcurrency(BREAKDOWN_CATEGORY_KEYS, 3, async (category) => {
    const refreshed = await generateBreakdownCategoryContent(sourceText, category, firstPass[category]);
    return [category, refreshed];
  });

  return { ...firstPass, ...Object.fromEntries(refinedEntries) };
}

app.post("/api/script-breakdown", requireRole("admin"), async (req, res) => {
  const { sceneListId } = req.body;

  try {
    const sceneListResult = await db.query("SELECT content, status FROM scene_lists WHERE id = $1", [sceneListId]);

    if (sceneListResult.rows.length === 0) {
      res.status(404).json({ error: "Scene list not found" });
      return;
    }

    if (sceneListResult.rows[0].status !== "approved") {
      res.status(400).json({ error: "The scene list must be approved before running a script breakdown." });
      return;
    }

    const sourceText = await buildBreakdownSourceText(sceneListResult.rows[0].content, sceneListId);
    const content = await generateDeepScriptBreakdownContent(sourceText);

    const insertResult = await db.query(
      "INSERT INTO script_breakdowns (scene_list_id, content) VALUES ($1, $2) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(content)]
    );

    res.json({ ...insertResult.rows[0], sceneListId, ...content });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// Re-checks the script for just ONE category (in case the first pass missed
// something) rather than regenerating the whole breakdown. Shown the
// previous list for that category so it corrects/extends it instead of
// starting blind, but told explicitly to re-verify against the full script.
async function generateBreakdownCategoryContent(sourceText, category, existingItems) {
  const contents = `The script material:\n${sourceText}\n\nThe current "${category}" list from a previous pass (it may have missed things):\n${JSON.stringify(existingItems ?? [])}\n\nRe-read the ENTIRE script carefully and produce a fresh, COMPLETE "${category}" list — ${BREAKDOWN_CATEGORY_DESCRIPTIONS[category]}. Specifically double-check for anything subtle or easy to miss on a first pass (brief appearances, background mentions, minor characters/props/locations mentioned only once) that the previous list may have left out. Don't just repeat the previous list unchanged — verify each entry against the script and correct or extend it.`;

  const response = await generateContentWithRetry({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: SCRIPT_BREAKDOWN_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      responseSchema: {
        type: Type.OBJECT,
        properties: { [category]: { type: Type.ARRAY, items: BREAKDOWN_CATEGORY_ITEM_SCHEMAS[category] } },
        required: [category],
      },
    },
  });

  return sanitizeBilingualContent(JSON.parse(response.text))[category];
}

app.post("/api/script-breakdown/:id/reanalyze", requireRole("admin"), async (req, res) => {
  const { category } = req.body;

  if (!BREAKDOWN_CATEGORY_KEYS.includes(category)) {
    res.status(400).json({ error: "Unknown breakdown category." });
    return;
  }

  try {
    const existing = await db.query("SELECT scene_list_id, content FROM script_breakdowns WHERE id = $1", [req.params.id]);

    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Script breakdown not found" });
      return;
    }

    const { scene_list_id: sceneListId, content: previous } = existing.rows[0];
    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const sourceText = await buildBreakdownSourceText(sceneListResult.rows[0].content, sceneListId);

    const refreshedCategory = await generateBreakdownCategoryContent(sourceText, category, previous[category]);
    const updatedContent = { ...previous, [category]: refreshedCategory };

    const insertResult = await db.query(
      "INSERT INTO script_breakdowns (scene_list_id, content, feedback) VALUES ($1, $2, $3) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(updatedContent), `Re-analyzed: ${category}`]
    );

    res.json({ ...insertResult.rows[0], sceneListId, ...updatedContent });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// Direct manual edit — the user adding/correcting items themselves, no AI
// involved. Still inserted as a new row (matching every other stage's
// non-destructive revision history) so it goes back to "pending" and needs
// approval again, same as any AI-driven change.
app.post("/api/script-breakdown/:id/edit", requireRole("admin"), async (req, res) => {
  const { content } = req.body;

  if (!content || typeof content !== "object") {
    res.status(400).json({ error: "Missing breakdown content." });
    return;
  }

  try {
    const existing = await db.query("SELECT scene_list_id FROM script_breakdowns WHERE id = $1", [req.params.id]);

    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Script breakdown not found" });
      return;
    }

    const sceneListId = existing.rows[0].scene_list_id;

    // Conflict guard: if someone else has already saved a newer version of
    // this breakdown since the editor loaded :id, refuse to silently bury
    // their change under this edit — the editor is working from stale data.
    const latest = await db.query(
      "SELECT id FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    if (String(latest.rows[0].id) !== String(req.params.id)) {
      res.status(409).json({ error: "Someone else updated this breakdown since you loaded it. Reload the page and try again." });
      return;
    }

    const sanitized = sanitizeBilingualContent(content);

    const insertResult = await db.query(
      "INSERT INTO script_breakdowns (scene_list_id, content, feedback) VALUES ($1, $2, $3) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(sanitized), "Manually edited"]
    );

    res.json({ ...insertResult.rows[0], sceneListId, ...sanitized });
  } catch (error) {
    console.error("Manual edit failed:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/script-breakdown/:id/approve", requireRole("admin", "director"), async (req, res) => {
  const target = await db.query("SELECT scene_list_id FROM script_breakdowns WHERE id = $1", [req.params.id]);
  if (target.rows.length === 0) {
    res.status(404).json({ error: "Script breakdown not found" });
    return;
  }
  if (!(await userOwnsSceneList(req.user, target.rows[0].scene_list_id))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const result = await db.query(
    "UPDATE script_breakdowns SET status = 'approved' WHERE id = $1 RETURNING id, scene_list_id, content, status, feedback",
    [req.params.id]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: "Script breakdown not found" });
    return;
  }

  const row = result.rows[0];
  res.json({ id: row.id, sceneListId: row.scene_list_id, status: row.status, feedback: row.feedback, ...row.content });
});

app.post("/api/script-breakdown/:id/request-changes", requireRole("admin", "director"), async (req, res) => {
  const { feedback } = req.body;

  try {
    const existing = await db.query("SELECT scene_list_id, content FROM script_breakdowns WHERE id = $1", [req.params.id]);

    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Script breakdown not found" });
      return;
    }

    const { scene_list_id: sceneListId, content: previous } = existing.rows[0];

    if (!(await userOwnsSceneList(req.user, sceneListId))) {
      res.status(403).json({ error: "You don't have access to this project." });
      return;
    }

    await db.query("UPDATE script_breakdowns SET status = 'changes_requested', feedback = $1 WHERE id = $2", [
      feedback,
      req.params.id,
    ]);

    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const sourceText = await buildBreakdownSourceText(sceneListResult.rows[0].content, sceneListId);

    const revisedContent = await generateDeepScriptBreakdownContent(sourceText, { feedback, previous });

    const insertResult = await db.query(
      "INSERT INTO script_breakdowns (scene_list_id, content) VALUES ($1, $2) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(revisedContent)]
    );

    res.json({ ...insertResult.rows[0], sceneListId, ...revisedContent, previousFeedback: feedback });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// PDF export for one breakdown category at a time — same landscape/theme
// styling as the pitch-deck export, just a simple title + list layout since
// this is a working document for the crew, not a pitch presentation.
app.get("/api/script-breakdown/:id/export", requireLogin, async (req, res) => {
  const lang = req.query.lang === "or" ? "or" : "en";
  const category = req.query.category;

  if (!BREAKDOWN_CATEGORY_KEYS.includes(category)) {
    res.status(400).json({ error: "Unknown breakdown category." });
    return;
  }

  try {
    const result = await db.query("SELECT content FROM script_breakdowns WHERE id = $1", [req.params.id]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Script breakdown not found" });
      return;
    }

    const breakdown = result.rows[0].content;
    const items = breakdown[category] ?? [];
    const categoryLabels = {
      artistList: { en: "Artist List", or: "କଳାକାର ତାଲିକା" },
      locationList: { en: "Location List", or: "ସ୍ଥାନ ତାଲିକା" },
      props: { en: "Property List", or: "ପ୍ରପର୍ଟି ତାଲିକା" },
      costumes: { en: "Costume Breakdown", or: "ପୋଷାକ ବିବରଣୀ" },
      art: { en: "Art Department Notes", or: "ଆର୍ଟ ବିଭାଗ ନୋଟ୍" },
    };
    const bodyFont = lang === "or" ? "odiaRegular" : "Helvetica";
    const headerFont = lang === "or" ? "odiaBold" : "Helvetica-Bold";

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.registerFont("odiaRegular", FONTS.odiaRegular);
    doc.registerFont("odiaBold", FONTS.odiaBold);
    doc.font(bodyFont);
    doc.font(headerFont);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${category}-${lang}.pdf"`);
    doc.pipe(res);

    doc.font(headerFont).fontSize(22).text(categoryLabels[category][lang]);
    doc.moveDown(1);

    if (items.length === 0) {
      doc.font(bodyFont).fontSize(12).text(lang === "or" ? "କିଛି ମିଳିଲା ନାହିଁ।" : "Nothing found for this category.");
    }

    items.forEach((item) => {
      const label = category === "locationList" ? item.location[lang] : category === "costumes" ? item.character : item.label;
      const noteField = category === "costumes" ? item.description : item.notes;
      doc.font(headerFont).fontSize(13).text(label, { continued: category === "locationList" });
      if (category === "locationList") {
        doc.font(bodyFont).fontSize(11).text(`  (${item.intExt} — ${item.sceneCount} scenes)`);
      }
      doc.font(bodyFont).fontSize(11).text(noteField[lang], { indent: 10 });
      doc.moveDown(0.8);
    });

    doc.end();
  } catch (error) {
    console.error("PDF export failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
});

// A PDF is fine to read or print, but a department head tracking down props
// or confirming artists needs something they can actually check items off
// in — hence the same category data as a real spreadsheet, with a
// dropdown "Status" column (Pending/Done) and a blank "Remarks" column for
// their own notes, instead of just a static list.
app.get("/api/script-breakdown/:id/export-excel", requireLogin, async (req, res) => {
  const lang = req.query.lang === "or" ? "or" : "en";
  const category = req.query.category;

  if (!BREAKDOWN_CATEGORY_KEYS.includes(category)) {
    res.status(400).json({ error: "Unknown breakdown category." });
    return;
  }

  try {
    const result = await db.query("SELECT content FROM script_breakdowns WHERE id = $1", [req.params.id]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Script breakdown not found" });
      return;
    }

    const items = result.rows[0].content[category] ?? [];
    const categoryLabels = {
      artistList: { en: "Artist List", or: "କଳାକାର ତାଲିକା" },
      locationList: { en: "Location List", or: "ସ୍ଥାନ ତାଲିକା" },
      props: { en: "Property List", or: "ପ୍ରପର୍ଟି ତାଲିକା" },
      costumes: { en: "Costume Breakdown", or: "ପୋଷାକ ବିବରଣୀ" },
      art: { en: "Art Department Notes", or: "ଆର୍ଟ ବିଭାଗ ନୋଟ୍" },
    };
    const statusLabels = lang === "or" ? ["ବାକି ଅଛି", "ହୋଇଗଲା"] : ["Pending", "Done"];
    const columnLabels =
      lang === "or"
        ? { name: "ନାମ", location: "ସ୍ଥାନ", intExt: "INT/EXT", sceneCount: "ଦୃଶ୍ୟ ସଂଖ୍ୟା", character: "ଚରିତ୍ର", notes: "ନୋଟ୍", status: "ସ୍ଥିତି", remarks: "ମନ୍ତବ୍ୟ" }
        : { name: "Name", location: "Location", intExt: "INT/EXT", sceneCount: "Scene Count", character: "Character", notes: "Notes", status: "Status", remarks: "Remarks" };

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(categoryLabels[category][lang].slice(0, 31));

    let columns;
    let rows;
    if (category === "locationList") {
      columns = [
        { header: columnLabels.location, key: "location", width: 28 },
        { header: columnLabels.intExt, key: "intExt", width: 10 },
        { header: columnLabels.sceneCount, key: "sceneCount", width: 12 },
        { header: columnLabels.notes, key: "notes", width: 45 },
      ];
      rows = items.map((item) => ({ location: item.location[lang], intExt: item.intExt, sceneCount: item.sceneCount, notes: item.notes[lang] }));
    } else if (category === "costumes") {
      columns = [
        { header: columnLabels.character, key: "character", width: 22 },
        { header: columnLabels.notes, key: "notes", width: 55 },
      ];
      rows = items.map((item) => ({ character: item.character, notes: item.description[lang] }));
    } else {
      columns = [
        { header: columnLabels.name, key: "name", width: 22 },
        { header: columnLabels.notes, key: "notes", width: 55 },
      ];
      rows = items.map((item) => ({ name: item.label, notes: item.notes[lang] }));
    }
    columns.push({ header: columnLabels.status, key: "status", width: 12 }, { header: columnLabels.remarks, key: "remarks", width: 30 });

    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };

    rows.forEach((row) => {
      const addedRow = sheet.addRow({ ...row, status: statusLabels[0] });
      addedRow.getCell("status").dataValidation = {
        type: "list",
        allowBlank: false,
        formulae: [`"${statusLabels.join(",")}"`],
      };
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${category}-${lang}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Excel export failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
});

// Actual calendar dates are simple day-increment arithmetic from the
// Production Manager's chosen start date — not something to leave to the AI
// to invent. Assigns sequential dates, one per shoot day, in order.
function assignScheduleDates(scheduleDays, startDate) {
  if (!startDate) return scheduleDays;
  const [year, month, day] = startDate.split("-").map(Number);
  const start = Date.UTC(year, month - 1, day);
  return scheduleDays.map((scheduleDay, index) => {
    const date = new Date(start + index * 24 * 60 * 60 * 1000);
    return { ...scheduleDay, date: date.toISOString().slice(0, 10) };
  });
}

// Every real scene's identity — "e{episodeIndex}-s{sceneIndex}" for a
// series, "s{sceneIndex}" for a film — used to verify the schedule the
// model returns actually covers every scene exactly once, since nothing in
// a free-form generation stops the model from silently dropping some.
function allSceneIdentities(sceneList) {
  if (sceneList.episodeScenes) {
    const ids = [];
    sceneList.episodeScenes.forEach((episodeScene, episodeIndex) => {
      episodeScene.scenes.forEach((_, sceneIndex) => ids.push(`e${episodeIndex}-s${sceneIndex}`));
    });
    return ids;
  }
  return sceneList.scenes.map((_, sceneIndex) => `s${sceneIndex}`);
}

function scheduledSceneIdentities(scheduleDays, isSeries) {
  const ids = new Set();
  scheduleDays.forEach((day) => {
    (day.sceneRefs ?? []).forEach((ref) => {
      ids.add(isSeries ? `e${ref.episodeIndex}-s${ref.sceneIndex}` : `s${ref.sceneIndex}`);
    });
  });
  return ids;
}

function missingScheduleIdentities(scheduleDays, sceneList, isSeries) {
  const scheduled = scheduledSceneIdentities(scheduleDays, isSeries);
  return allSceneIdentities(sceneList).filter((id) => !scheduled.has(id));
}

async function callShootScheduleGemini(contents, isSeries) {
  const response = await generateContentWithRetry({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: PRODUCTION_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          scheduleDays: { type: Type.ARRAY, items: shootDaySchema(isSeries) },
          conflicts: { type: Type.ARRAY, items: BILINGUAL_TEXT_SCHEMA },
        },
        required: ["scheduleDays", "conflicts"],
      },
    },
  });

  return sanitizeBilingualContent(JSON.parse(response.text));
}

async function generateShootScheduleContent(sceneList, characterNames, availability, targetDays, revision) {
  const isSeries = Boolean(sceneList.episodeScenes);
  const sceneText = flattenScenesForScheduling(sceneList);
  const characterNamesText = characterNames.join(", ");
  const totalScenes = allSceneIdentities(sceneList).length;

  const availabilityText = [
    "Character availability:",
    ...(availability.characters ?? []).map(
      (c) => `- ${c.name}: ${c.unknown ? "unknown, estimate" : c.availableDates || "unknown, estimate"}`
    ),
    "Location availability:",
    ...(availability.locations ?? []).map(
      (l) => `- ${l.location}: ${l.unknown ? "unknown, estimate" : l.availableDates || "unknown, estimate"}`
    ),
  ].join("\n");

  const targetDaysText = targetDays ? `\n\nTarget: fit this schedule within ${targetDays} shoot days if at all realistic.` : "";

  const formatLine = isSeries
    ? `This is a multi-episode series scene list, laid out episode by episode below (scene numbering restarts at 1 within each episode) — ${totalScenes} scenes total across all episodes. Every sceneRef you output MUST include the correct episodeIndex (0-indexed, matching the episode's position below) AND sceneIndex (0-indexed within that episode).`
    : `This is a single continuous film with NO episodes — ${totalScenes} scenes total. Every sceneRef you output must be JUST a 0-indexed sceneIndex into this one scene list; never invent or include an episode number, this project has none.`;

  let contents = `${formatLine}\n\nMajor characters: ${characterNamesText}\n\nScene list:\n${sceneText}\n\n${availabilityText}${targetDaysText}\n\nIMPORTANT: every one of the ${totalScenes} scenes listed above must appear in exactly one shoot day's sceneRefs — do not skip any scene and do not invent scenes that aren't listed above.\n\nFor each shoot day, also give "charactersNeeded": the major characters (from the list above, by exact name) who appear in at least one of that day's scenes, inferred from the scenes' one-liners and locations — this is what tells each artist which shoot days they're actually called for.`;

  if (revision) {
    contents += `\n\nThis is a REVISION of a previous shoot schedule. The Production Manager reviewed it and requested changes.\nFeedback: "${revision.feedback}"\nRevise the schedule to address the feedback directly.`;
  }

  let parsed = await callShootScheduleGemini(contents, isSeries);

  // If the model dropped any real scenes, give it one corrective retry
  // listing exactly which ones were missed — capped at a single retry, same
  // pattern as the scene-list pacing retry above.
  const missing = missingScheduleIdentities(parsed.scheduleDays, sceneList, isSeries);
  if (missing.length > 0) {
    const missingText = missing
      .map((id) => (isSeries ? id.replace(/^e(\d+)-s(\d+)$/, "episode $1, scene $2") : id.replace(/^s(\d+)$/, "scene $1")))
      .join("; ");
    const correctionNote = `\n\nIMPORTANT CORRECTION NEEDED: your schedule left out these scenes entirely (0-indexed): ${missingText}. Revise the schedule so every one of the ${totalScenes} scenes is assigned to a shoot day, adding days if needed.`;
    parsed = await callShootScheduleGemini(contents + correctionNote, isSeries);
  }

  const scheduleDays = assignScheduleDates(parsed.scheduleDays, availability.startDate);

  return {
    ...parsed,
    scheduleDays,
    artistSchedule: buildArtistWiseSchedule(scheduleDays),
    availability,
    targetDays,
  };
}

// Inverts the day-by-day schedule into a per-artist view — for each
// character who appears in any day's charactersNeeded, which days (number +
// date) they're called for and how many total shoot days that is. This is
// the actual answer to "how many days is Judge Swain needed, how many days
// is Bijay needed" — one pass over the same schedule the days themselves
// already carry, no separate AI call required.
function buildArtistWiseSchedule(scheduleDays) {
  const byCharacter = new Map();

  scheduleDays.forEach((day) => {
    (day.charactersNeeded ?? []).forEach((name) => {
      if (!byCharacter.has(name)) byCharacter.set(name, []);
      byCharacter.get(name).push({ dayNumber: day.dayNumber, date: day.date ?? null });
    });
  });

  return [...byCharacter.entries()]
    .map(([character, days]) => ({
      character,
      totalDays: days.length,
      days: days.sort((a, b) => a.dayNumber - b.dayNumber),
    }))
    .sort((a, b) => b.totalDays - a.totalDays || a.character.localeCompare(b.character));
}

// A standalone 'production'-type project (imported screenplay) carries its
// own plain characterNames list directly on the scene list content, since
// it has no character-sheet chain at all. A normal story-agent project has
// to walk bit_sheet -> three_act -> pitch_deck -> character_sheet instead.
async function fetchCharacterNamesForSceneList(sceneListId, sceneList) {
  if (Array.isArray(sceneList.characterNames)) {
    return sceneList.characterNames;
  }

  const result = await db.query(
    `SELECT cs.content AS content
     FROM scene_lists sl
     JOIN bit_sheets bs ON bs.id = sl.bit_sheet_id
     JOIN three_act_structures tas ON tas.id = bs.three_act_structure_id
     JOIN character_sheets cs ON cs.pitch_deck_id = tas.pitch_deck_id
     WHERE sl.id = $1
     ORDER BY cs.created_at DESC LIMIT 1`,
    [sceneListId]
  );
  const characterSheet = result.rows[0]?.content ?? null;
  return (characterSheet?.characters ?? []).map((c) => c.name);
}

// Same standalone-production-vs-normal-pipeline branch as the character
// names lookup above, just for the project's title — used to head the
// shoot schedule PDF so it's identifiable once printed/forwarded on its own.
async function fetchProjectTitleForSceneList(sceneListId, sceneList, lang) {
  if (Array.isArray(sceneList.characterNames)) {
    const result = await db.query(
      "SELECT c.title FROM scene_lists sl JOIN concepts c ON c.id = sl.concept_id WHERE sl.id = $1",
      [sceneListId]
    );
    return result.rows[0]?.title || null;
  }

  const result = await db.query(
    `SELECT pd.content AS content
     FROM scene_lists sl
     JOIN bit_sheets bs ON bs.id = sl.bit_sheet_id
     JOIN three_act_structures tas ON tas.id = bs.three_act_structure_id
     JOIN pitch_decks pd ON pd.id = tas.pitch_deck_id
     WHERE sl.id = $1`,
    [sceneListId]
  );
  return result.rows[0]?.content?.title?.[lang] ?? null;
}

app.post("/api/shoot-schedule", requireRole("admin", "production_manager"), async (req, res) => {
  const { sceneListId, availability, targetDays } = req.body;

  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  try {
    const sceneListResult = await db.query("SELECT content, status FROM scene_lists WHERE id = $1", [sceneListId]);

    if (sceneListResult.rows.length === 0) {
      res.status(404).json({ error: "Scene list not found" });
      return;
    }

    if (sceneListResult.rows[0].status !== "approved") {
      res.status(400).json({ error: "The scene list must be approved before building a shoot schedule." });
      return;
    }

    const breakdownResult = await db.query(
      "SELECT status FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    if (breakdownResult.rows.length === 0 || breakdownResult.rows[0].status !== "approved") {
      res.status(400).json({ error: "Run and approve the script breakdown before building a shoot schedule." });
      return;
    }

    const characterNames = await fetchCharacterNamesForSceneList(sceneListId, sceneListResult.rows[0].content);
    const content = await generateShootScheduleContent(sceneListResult.rows[0].content, characterNames, availability, targetDays);

    const insertResult = await db.query(
      "INSERT INTO shoot_schedules (scene_list_id, content) VALUES ($1, $2) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(content)]
    );

    res.json({ ...insertResult.rows[0], sceneListId, ...content });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/shoot-schedule/:id/approve", requireRole("admin", "director"), async (req, res) => {
  const target = await db.query("SELECT scene_list_id FROM shoot_schedules WHERE id = $1", [req.params.id]);
  if (target.rows.length === 0) {
    res.status(404).json({ error: "Shoot schedule not found" });
    return;
  }
  if (!(await userOwnsSceneList(req.user, target.rows[0].scene_list_id))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const result = await db.query(
    "UPDATE shoot_schedules SET status = 'approved' WHERE id = $1 RETURNING id, scene_list_id, content, status, feedback",
    [req.params.id]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: "Shoot schedule not found" });
    return;
  }

  const row = result.rows[0];
  res.json({ id: row.id, sceneListId: row.scene_list_id, status: row.status, feedback: row.feedback, ...row.content });
});

app.post("/api/shoot-schedule/:id/request-changes", requireRole("admin", "director"), async (req, res) => {
  const { feedback } = req.body;

  try {
    const existing = await db.query("SELECT scene_list_id, content FROM shoot_schedules WHERE id = $1", [req.params.id]);

    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Shoot schedule not found" });
      return;
    }

    const { scene_list_id: sceneListId, content: previous } = existing.rows[0];

    if (!(await userOwnsSceneList(req.user, sceneListId))) {
      res.status(403).json({ error: "You don't have access to this project." });
      return;
    }

    const latest = await db.query(
      "SELECT id FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    if (String(latest.rows[0].id) !== String(req.params.id)) {
      res.status(409).json({ error: "Someone else updated this shoot schedule since you loaded it. Reload the page and try again." });
      return;
    }

    await db.query("UPDATE shoot_schedules SET status = 'changes_requested', feedback = $1 WHERE id = $2", [
      feedback,
      req.params.id,
    ]);

    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const characterNames = await fetchCharacterNamesForSceneList(sceneListId, sceneListResult.rows[0].content);

    const revisedContent = await generateShootScheduleContent(
      sceneListResult.rows[0].content,
      characterNames,
      previous.availability,
      previous.targetDays,
      { feedback, previous }
    );

    const insertResult = await db.query(
      "INSERT INTO shoot_schedules (scene_list_id, content) VALUES ($1, $2) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(revisedContent)]
    );

    res.json({ ...insertResult.rows[0], sceneListId, ...revisedContent, previousFeedback: feedback });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// Mirrors the frontend's lookupScene: resolves a {episodeIndex, sceneIndex}
// shoot-schedule reference back to the real scene object, for the PDF.
function lookupSceneServerSide(sceneList, ref) {
  if (sceneList.episodeScenes) {
    return sceneList.episodeScenes[ref.episodeIndex]?.scenes?.[ref.sceneIndex] ?? null;
  }
  return sceneList.scenes?.[ref.sceneIndex] ?? null;
}

// The one PDF every department actually needs: a day-by-day call schedule
// (scenes, location, cast called) followed by a per-artist summary — how
// many days and which ones — so it can be forwarded as-is to artists and
// the director instead of them reading the app itself.
app.get("/api/shoot-schedule/:id/export", requireLogin, async (req, res) => {
  const lang = req.query.lang === "or" ? "or" : "en";

  try {
    const result = await db.query("SELECT scene_list_id, content FROM shoot_schedules WHERE id = $1", [req.params.id]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Shoot schedule not found" });
      return;
    }

    const { scene_list_id: sceneListId, content: schedule } = result.rows[0];
    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const sceneList = sceneListResult.rows[0]?.content ?? {};
    const isSeries = Boolean(sceneList.episodeScenes);
    const title = await fetchProjectTitleForSceneList(sceneListId, sceneList, lang);

    const bodyFont = lang === "or" ? "odiaRegular" : "Helvetica";
    const headerFont = lang === "or" ? "odiaBold" : "Helvetica-Bold";
    const labels =
      lang === "or"
        ? { schedule: "ସୁଟିଂ ସୂଚୀ", day: "ଦିନ", location: "ସ୍ଥାନ", cast: "କଳାକାର", notes: "ଟିପ୍ପଣୀ", artistSummary: "କଳାକାର-ଅନୁଯାୟୀ ସାରାଂଶ", totalDays: "ମୋଟ ଦିନ", days: "ଦିନଗୁଡ଼ିକ" }
        : { schedule: "Shoot Schedule", day: "Day", location: "Location", cast: "Cast Called", notes: "Notes", artistSummary: "Artist-Wise Summary", totalDays: "Total Days", days: "Days" };

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.registerFont("odiaRegular", FONTS.odiaRegular);
    doc.registerFont("odiaBold", FONTS.odiaBold);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="shoot-schedule-${lang}.pdf"`);
    doc.pipe(res);

    doc.font(headerFont).fontSize(20).text(title || labels.schedule);
    if (title) doc.font(bodyFont).fontSize(13).fillColor("#555").text(labels.schedule).fillColor("#000");
    doc.moveDown(1);

    schedule.scheduleDays.forEach((day) => {
      doc
        .font(headerFont)
        .fontSize(14)
        .text(`${labels.day} ${day.dayNumber}${day.date ? `  —  ${day.date}` : ""}`);
      doc.font(bodyFont).fontSize(11).text(`${labels.location}: ${day.location?.[lang] ?? ""}`);

      (day.sceneRefs ?? []).forEach((ref) => {
        const scene = lookupSceneServerSide(sceneList, ref);
        if (!scene) return;
        const sceneLabel = isSeries
          ? `Episode ${ref.episodeIndex + 1}, Scene ${ref.sceneIndex + 1}`
          : `Scene ${ref.sceneIndex + 1}`;
        doc
          .font(bodyFont)
          .fontSize(10)
          .text(`  • ${sceneLabel} (${scene.intExt}. ${scene.location?.[lang] ?? ""} — ${scene.timeOfDay}): ${scene.oneLiner?.[lang] ?? ""}`, {
            indent: 10,
          });
      });

      if (day.charactersNeeded?.length) {
        doc.font(headerFont).fontSize(10).text(`${labels.cast}: `, { continued: true }).font(bodyFont).text(day.charactersNeeded.join(", "));
      }
      if (day.notes?.[lang]) {
        doc.font(headerFont).fontSize(10).text(`${labels.notes}: `, { continued: true }).font(bodyFont).text(day.notes[lang]);
      }
      doc.moveDown(0.8);
    });

    doc.addPage();
    doc.font(headerFont).fontSize(18).text(labels.artistSummary);
    doc.moveDown(1);

    (schedule.artistSchedule ?? []).forEach((entry) => {
      doc.font(headerFont).fontSize(13).text(entry.character);
      doc
        .font(bodyFont)
        .fontSize(11)
        .text(`${labels.totalDays}: ${entry.totalDays}  —  ${labels.days}: ${entry.days.map((d) => `Day ${d.dayNumber}${d.date ? ` (${d.date})` : ""}`).join(", ")}`, {
          indent: 10,
        });
      doc.moveDown(0.6);
    });

    doc.end();
  } catch (error) {
    console.error("PDF export failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
});

// --- Crew & Cast: real-world data the production attaches directly onto
// the Script Breakdown's own lists, not AI-generated content. 'artist'
// entries are cast confirmed against a specific character from the Artist
// List (character_name = the character's label); 'location' entries are a
// confirmed real-world location/photo attached to a Location List entry
// (character_name = that location's English name, reusing the same link
// column); 'art_department' / 'costume_department' are that department's
// crew; 'crew' is the general master crew list. All five are the same
// shape — only the frontend renders/groups them differently.
const CREW_CATEGORIES = ["artist", "location", "art_department", "costume_department", "crew"];

// True if this scene list belongs to a project the current user is
// actually scoped to — admin is scoped to everything, a director/PM login
// only to their one assigned concept_id. Without this, a scoped team
// account could act on some other project just by passing a different
// sceneListId, even though they'd never see it listed anywhere.
async function userOwnsSceneList(user, sceneListId) {
  if (user.role === "admin") return true;
  if (!sceneListId) return false;

  const result = await db.query(
    `SELECT COALESCE(sl.concept_id, pd.concept_id) AS concept_id
     FROM scene_lists sl
     LEFT JOIN bit_sheets bs ON bs.id = sl.bit_sheet_id
     LEFT JOIN three_act_structures tas ON tas.id = bs.three_act_structure_id
     LEFT JOIN pitch_decks pd ON pd.id = tas.pitch_deck_id
     WHERE sl.id = $1`,
    [sceneListId]
  );
  const conceptId = result.rows[0]?.concept_id;
  return conceptId != null && String(conceptId) === String(user.concept_id);
}

// Memory storage rather than disk — savePhotoBuffer() decides where the
// bytes actually end up (local disk or Supabase Storage).
const crewPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

function serializeCrewMember(row) {
  return {
    id: row.id,
    sceneListId: row.scene_list_id,
    category: row.category,
    characterName: row.character_name,
    name: row.name,
    role: row.role,
    contactNumber: row.contact_number,
    photoUrl: photoUrlFor(row.photo_path),
  };
}

app.get("/api/crew", requireLogin, async (req, res) => {
  if (!(await userOwnsSceneList(req.user, req.query.sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const result = await db.query(
    "SELECT * FROM crew_members WHERE scene_list_id = $1 ORDER BY created_at ASC",
    [req.query.sceneListId]
  );
  res.json(result.rows.map(serializeCrewMember));
});

app.post("/api/crew", requireRole("admin", "production_manager"), crewPhotoUpload.single("photo"), async (req, res) => {
  const { sceneListId, category, characterName, name, role, contactNumber } = req.body;

  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }
  if (!CREW_CATEGORIES.includes(category)) {
    res.status(400).json({ error: "Unknown crew category." });
    return;
  }
  if (!name || !name.trim()) {
    res.status(400).json({ error: "Name is required." });
    return;
  }

  const photoPath = req.file ? await savePhotoBuffer(req.file.buffer, req.file.originalname) : null;

  const result = await db.query(
    `INSERT INTO crew_members (scene_list_id, category, character_name, name, role, contact_number, photo_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [sceneListId, category, characterName || null, name.trim(), role || null, contactNumber || null, photoPath]
  );

  res.json(serializeCrewMember(result.rows[0]));
});

app.patch("/api/crew/:id", requireRole("admin", "production_manager"), crewPhotoUpload.single("photo"), async (req, res) => {
  const { name, role, contactNumber } = req.body;

  const existing = await db.query("SELECT photo_path, scene_list_id FROM crew_members WHERE id = $1", [req.params.id]);
  if (existing.rows.length === 0) {
    res.status(404).json({ error: "Crew member not found" });
    return;
  }
  if (!(await userOwnsSceneList(req.user, existing.rows[0].scene_list_id))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const photoPath = req.file ? await savePhotoBuffer(req.file.buffer, req.file.originalname) : existing.rows[0].photo_path;
  if (req.file && existing.rows[0].photo_path) {
    deletePhoto(existing.rows[0].photo_path);
  }

  const result = await db.query(
    `UPDATE crew_members SET name = $1, role = $2, contact_number = $3, photo_path = $4 WHERE id = $5 RETURNING *`,
    [name?.trim() || existing.rows[0].name, role ?? null, contactNumber ?? null, photoPath, req.params.id]
  );

  res.json(serializeCrewMember(result.rows[0]));
});

app.delete("/api/crew/:id", requireRole("admin", "production_manager"), async (req, res) => {
  const existing = await db.query("SELECT scene_list_id FROM crew_members WHERE id = $1", [req.params.id]);
  if (existing.rows.length === 0) {
    res.status(404).json({ error: "Crew member not found" });
    return;
  }
  if (!(await userOwnsSceneList(req.user, existing.rows[0].scene_list_id))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const result = await db.query("DELETE FROM crew_members WHERE id = $1 RETURNING photo_path", [req.params.id]);
  if (result.rows[0]?.photo_path) {
    deletePhoto(result.rows[0].photo_path);
  }
  res.json({ ok: true });
});

// Keeps an already-confirmed artist/location attached to its character or
// location after it gets renamed in the Script Breakdown's edit mode —
// otherwise the crew_members row would silently stop matching anything
// (character_name is a plain string link, not a foreign key) and the
// confirmed cast/location would look unconfirmed again.
app.post("/api/crew/rename-link", requireRole("admin", "production_manager"), async (req, res) => {
  const { sceneListId, category, oldName, newName } = req.body;

  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const result = await db.query(
    "UPDATE crew_members SET character_name = $1 WHERE scene_list_id = $2 AND category = $3 AND character_name = $4 RETURNING *",
    [newName, sceneListId, category, oldName]
  );

  res.json(result.rows.map(serializeCrewMember));
});

// Same shape as POST /api/crew, but for a contact picked from "Connect
// Google Contacts" instead of a manual multipart upload — the photo (if
// any) is a Google-hosted URL, fetched and saved server-side into the same
// uploads/crew/ directory so it's stored the same way regardless of source.
app.post("/api/crew/from-contact", requireRole("admin", "production_manager"), async (req, res) => {
  const { sceneListId, category, characterName, name, contactNumber, photoUrl } = req.body;

  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }
  if (!CREW_CATEGORIES.includes(category)) {
    res.status(400).json({ error: "Unknown crew category." });
    return;
  }
  if (!name || !name.trim()) {
    res.status(400).json({ error: "Name is required." });
    return;
  }

  let photoPath = null;
  if (photoUrl) {
    try {
      const photoResponse = await fetch(photoUrl);
      if (photoResponse.ok) {
        const buffer = Buffer.from(await photoResponse.arrayBuffer());
        const contentType = photoResponse.headers.get("content-type") ?? "image/jpeg";
        const ext = "." + (contentType.split("/")[1] ?? "jpg").split(";")[0].replace("jpeg", "jpg");
        photoPath = await savePhotoBuffer(buffer, `contact${ext}`);
      }
    } catch (error) {
      console.error("Failed to fetch contact photo:", error.message);
    }
  }

  const result = await db.query(
    `INSERT INTO crew_members (scene_list_id, category, character_name, name, role, contact_number, photo_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [sceneListId, category, characterName || null, name.trim(), null, contactNumber || null, photoPath]
  );

  res.json(serializeCrewMember(result.rows[0]));
});

// --- Google Contacts: lets cast/crew/location entries be picked from the
// user's real Google Contacts instead of typed by hand. Single-row token
// storage (google_auth_tokens) since this is a local single-user app.
const GOOGLE_REDIRECT_URI = `${BACKEND_URL}/api/auth/google/callback`;
const GOOGLE_CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";

app.get("/api/auth/google", (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    res.status(500).send("GOOGLE_CLIENT_ID is not set in the backend .env file yet.");
    return;
  }
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: GOOGLE_CONTACTS_SCOPE,
    access_type: "offline",
    // Forces Google to hand back a refresh_token every time (default
    // behavior only returns one on the very first consent), so this can be
    // reconnected later without losing the ability to refresh silently.
    prompt: "consent",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get("/api/auth/google/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    res.redirect(`${FRONTEND_URL}/?googleContactsError=1`);
    return;
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenResponse.json();

    if (!tokens.access_token) {
      throw new Error(tokens.error_description || "Google did not return an access token.");
    }

    const expiryDate = Date.now() + (tokens.expires_in ?? 3600) * 1000;

    // Single-row table: replace whatever was there before.
    await db.query("DELETE FROM google_auth_tokens");
    await db.query(
      "INSERT INTO google_auth_tokens (access_token, refresh_token, expiry_date) VALUES ($1, $2, $3)",
      [tokens.access_token, tokens.refresh_token, expiryDate]
    );

    res.redirect(`${FRONTEND_URL}/?googleContactsConnected=1`);
  } catch (error) {
    console.error("Google OAuth callback failed:", error.message);
    res.redirect(`${FRONTEND_URL}/?googleContactsError=1`);
  }
});

async function getGoogleAccessToken() {
  const result = await db.query("SELECT * FROM google_auth_tokens ORDER BY id DESC LIMIT 1");
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  if (Date.now() < Number(row.expiry_date) - 60000) {
    return row.access_token;
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const tokens = await response.json();
  if (!tokens.access_token) return null;

  const expiryDate = Date.now() + (tokens.expires_in ?? 3600) * 1000;
  await db.query("UPDATE google_auth_tokens SET access_token = $1, expiry_date = $2, updated_at = now() WHERE id = $3", [
    tokens.access_token,
    expiryDate,
    row.id,
  ]);

  return tokens.access_token;
}

app.get("/api/google/status", requireLogin, async (req, res) => {
  const result = await db.query("SELECT id FROM google_auth_tokens LIMIT 1");
  res.json({ connected: result.rows.length > 0 });
});

app.get("/api/google/contacts", requireRole("admin", "production_manager"), async (req, res) => {
  try {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) {
      res.status(401).json({ error: "Google Contacts is not connected." });
      return;
    }

    const contacts = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        personFields: "names,phoneNumbers,photos",
        pageSize: "1000",
        ...(pageToken ? { pageToken } : {}),
      });
      const response = await fetch(`https://people.googleapis.com/v1/people/me/connections?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || "Google People API request failed.");

      (data.connections ?? []).forEach((person) => {
        const name = person.names?.[0]?.displayName;
        if (!name) return;
        contacts.push({
          name,
          phone: person.phoneNumbers?.[0]?.value ?? null,
          photoUrl: person.photos?.find((p) => !p.default)?.url ?? null,
        });
      });
      pageToken = data.nextPageToken ?? "";
    } while (pageToken);

    res.json(contacts);
  } catch (error) {
    console.error("Google Contacts fetch failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running at http://localhost:${PORT}`);
});
