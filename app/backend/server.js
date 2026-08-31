import "dotenv/config";
import express from "express";
import "express-async-errors";
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
// Supabase's pooled connection role has an empty default search_path, so
// unqualified table names (`users`, `concepts`, ...) fail to resolve unless
// each new connection sets it explicitly.
db.on("connect", (client) => {
  client.query("SET search_path TO public").catch(() => {});
});

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

// Every export filename gets a "when was this generated" stamp — the AD
// prints these repeatedly as a schedule changes, and without a timestamp
// there's no way to tell which paper copy is the current one.
function formatExportTimestamp(date = new Date()) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const hours12 = date.getHours() % 12 || 12;
  const ampm = date.getHours() >= 12 ? "PM" : "AM";
  return `${day}-${month}-${year}_${hours12}.${minutes}${ampm}`;
}

// Stored/computed dates stay ISO (yyyy-mm-dd) internally — that's what date
// arithmetic and <input type="date"> both need — this only reformats a date
// for DISPLAY, to the day-month-year order this production actually uses.
function formatDisplayDate(isoDate) {
  if (!isoDate) return isoDate;
  const [y, m, d] = isoDate.split("-");
  if (!y || !m || !d) return isoDate;
  return `${d}-${m}-${y}`;
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
    // The scene's own literal number/label from its original source, when
    // there is one to preserve (an imported screenplay) — e.g. "5A", "36",
    // or a number that keeps counting up across episodes instead of
    // restarting at 1. Left unset (never invented) for scenes an AI agent
    // is writing from scratch, where there is no "real" number to keep;
    // every reader falls back to the scene's array position in that case.
    sceneNumber: { type: Type.STRING },
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
    properties: {
      ...(isSeries
        ? { episodeIndex: { type: Type.INTEGER }, sceneIndex: { type: Type.INTEGER } }
        : { sceneIndex: { type: Type.INTEGER } }),
      // Continuity relative to SHOOT order (not story order) — "Fresh",
      // "Cont. Scene 12", "Night costume", etc. — the same distinction a
      // real AD's day sheet tracks, since costume department needs to know
      // whether to change or reuse an outfit between back-to-back setups.
      costume: { type: Type.STRING },
      properties: { type: Type.STRING },
      // Left as an empty string when nothing is uncertain — only filled in
      // when the model genuinely isn't confident about something (a costume
      // continuity call it can't verify, an ambiguous prop) so the AD can
      // resolve it by hand instead of the app silently guessing wrong.
      adRemark: { type: Type.STRING },
    },
    required: [...(isSeries ? ["episodeIndex", "sceneIndex"] : ["sceneIndex"]), "costume", "properties", "adRemark"],
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

// Age/gender exist only on the Artist List — a casting-relevant detail
// that doesn't apply to props, locations, or art department entries.
const BREAKDOWN_ARTIST_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    label: { type: Type.STRING },
    notes: BILINGUAL_TEXT_SCHEMA,
    age: { type: Type.STRING },
    gender: { type: Type.STRING, enum: ["Male", "Female", "Unspecified"] },
  },
  required: ["label", "notes", "age", "gender"],
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

// The AD (Assistant Director) Scene Breakdown Sheet — one row per scene,
// the classic single-page-per-scene production document. sceneNumber,
// description, intExt, dayNight and location come straight from the
// already-approved scene list (100% reliable, no AI needed); only these
// four fields genuinely require inference, so the AI call is scoped to
// just them rather than re-deriving facts the app already has.
const AD_SHEET_ROW_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    mainCharacters: { type: Type.ARRAY, items: { type: Type.STRING } },
    extras: BILINGUAL_TEXT_SCHEMA,
    property: BILINGUAL_TEXT_SCHEMA,
    costumeRemarks: BILINGUAL_TEXT_SCHEMA,
  },
  required: ["mainCharacters", "extras", "property", "costumeRemarks"],
};

// A character's full master script packet — EVERY scene they appear in
// (not just one audition scene), transcribed VERBATIM from the actual
// script (never translated or paraphrased, since the actor needs to say
// exactly what's written, in whatever language/script mix the original
// already uses). Other characters' lines are included too since the actor
// needs their cues, with isTargetCharacter marking which ones are actually
// this actor's. When the character has no dialogue in a given scene at all,
// hasDialogue is false and actionDescription instead grounds what they
// physically do there, so a non-speaking scene still shows up.
const CHARACTER_SCRIPT_SCENE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    sceneHeading: { type: Type.STRING },
    sceneNumberLabel: { type: Type.STRING },
    hasDialogue: { type: Type.BOOLEAN },
    lines: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          character: { type: Type.STRING },
          text: { type: Type.STRING },
          isTargetCharacter: { type: Type.BOOLEAN },
        },
        required: ["character", "text", "isTargetCharacter"],
      },
    },
    actionDescription: { type: Type.STRING },
  },
  required: ["sceneHeading", "sceneNumberLabel", "hasDialogue", "lines", "actionDescription"],
};

const CHARACTER_SCRIPT_CHUNK_SCHEMA = {
  type: Type.OBJECT,
  properties: { scenes: { type: Type.ARRAY, items: CHARACTER_SCRIPT_SCENE_SCHEMA } },
  required: ["scenes"],
};

const BREAKDOWN_CATEGORY_ITEM_SCHEMAS = {
  artistList: BREAKDOWN_ARTIST_SCHEMA,
  locationList: BREAKDOWN_LOCATION_SCHEMA,
  props: BREAKDOWN_ITEM_SCHEMA,
  costumes: BREAKDOWN_COSTUME_SCHEMA,
  art: BREAKDOWN_ITEM_SCHEMA,
};

const BREAKDOWN_CATEGORY_DESCRIPTIONS = {
  artistList: "every character who appears, each with a short bilingual note on their overall involvement (how central they are, roughly how many scenes, anything schedule-relevant), their approximate age (an age or age range as stated or reasonably inferable from the script and dialogue — e.g. \"60s\", \"Late 20s\", \"Child, around 8\", or \"Unspecified\" if genuinely not inferable), and their gender (Male, Female, or Unspecified) — this is what a casting decision is actually made against, so infer it confidently from context (name, pronouns, family role, honorifics) rather than defaulting to Unspecified whenever possible",
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
- "artistList": every character who appears, each with a short bilingual note on their overall involvement (how central they are, roughly how many scenes, anything schedule-relevant like "appears only in exterior scenes"), their approximate age (an age or age range as stated or reasonably inferable from the script and dialogue — e.g. "60s", "Late 20s", "Child, around 8" — use "Unspecified" only when genuinely not inferable), and their gender (Male, Female, or Unspecified) — casting decisions are made against age and gender, so infer both confidently from context (name, pronouns, family role, honorifics) rather than defaulting to Unspecified.
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

// The other direction of savePhotoBuffer — needed so a photo attached a
// few turns back in the agent chat can still actually be SEEN by the
// model on a later turn (a plain text history entry like "(photo
// attached)" gives it no way to answer "what does that note say again?").
// Returns null rather than throwing on any failure so one unreadable old
// photo can't break the whole conversation.
async function loadPhotoBuffer(filename) {
  if (!filename) return null;
  const ext = path.extname(filename).toLowerCase();
  const mimeType = MIME_TYPES_BY_EXT[ext] || "image/jpeg";
  try {
    if (supabase) {
      const { data, error } = await supabase.storage.from(SUPABASE_STORAGE_BUCKET).download(filename);
      if (error) return null;
      return { buffer: Buffer.from(await data.arrayBuffer()), mimeType };
    }
    return { buffer: await fsPromises.readFile(path.join(UPLOADS_DIR, filename)), mimeType };
  } catch {
    return null;
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

// The admin-only cross-project dashboard: every project (Story & Screenplay
// or standalone Production) in one list, each showing who's assigned
// (director / production_manager logins scoped to it) and which stage
// it's actually at — "In Development" until BOTH its screenplay/scene
// list has been approved at least once AND someone is assigned to it,
// "Ongoing / Pre-Production" once both are true.
app.get("/api/projects/master-list", requireRole("admin"), async (req, res) => {
  const projectsResult = await db.query(
    `SELECT c.id, c.title, c.concept_text, c.project_type, c.pinned, c.created_at,
            COALESCE(bool_or(sl.status = 'approved'), false) AS screenplay_ready
     FROM concepts c
     LEFT JOIN pitch_decks pd ON pd.concept_id = c.id
     LEFT JOIN three_act_structures tas ON tas.pitch_deck_id = pd.id
     LEFT JOIN bit_sheets bs ON bs.three_act_structure_id = tas.id
     LEFT JOIN scene_lists sl ON sl.bit_sheet_id = bs.id OR sl.concept_id = c.id
     GROUP BY c.id, c.title, c.concept_text, c.project_type, c.pinned, c.created_at
     ORDER BY c.pinned DESC, c.created_at DESC`
  );

  const assignmentsResult = await db.query(
    "SELECT concept_id, name, role FROM users WHERE concept_id IS NOT NULL AND role IN ('director', 'production_manager')"
  );
  const assignedUsersByConceptId = new Map();
  assignmentsResult.rows.forEach((row) => {
    if (!assignedUsersByConceptId.has(row.concept_id)) assignedUsersByConceptId.set(row.concept_id, []);
    assignedUsersByConceptId.get(row.concept_id).push({ name: row.name, role: row.role });
  });

  res.json(
    projectsResult.rows.map((row) => {
      const assignedUsers = assignedUsersByConceptId.get(row.id) ?? [];
      return {
        id: row.id,
        title: row.title || row.concept_text?.slice(0, 60) || `#${row.id}`,
        projectType: row.project_type,
        pinned: row.pinned,
        createdAt: row.created_at,
        screenplayReady: row.screenplay_ready,
        assignedUsers,
        stage: row.screenplay_ready && assignedUsers.length > 0 ? "ongoing" : "in_development",
      };
    })
  );
});

app.post("/api/concepts/:id/title", requireLogin, async (req, res) => {
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

// --- Conversational "Changes" chat agent — a real back-and-forth
// conversation (not a single fire-and-forget instruction) that can ask
// clarifying questions and, once it has enough specifics, PROPOSE a
// concrete edit for the human to confirm before anything is actually
// applied. History is stored server-side per (concept, stage) so the same
// thread shows up for every login to this project, not just the browser
// that typed it.

// Resolves the latest scene_lists.id for a concept, walking the same
// concept -> pitch_deck -> three_act -> bit_sheet -> scene_list chain (or
// the direct concept_id link for a standalone production project) that
// /api/concepts/:id/full already walks — just returning the one id this
// needs rather than the whole aggregate.
async function findSceneListIdForConcept(conceptId) {
  const conceptResult = await db.query("SELECT project_type FROM concepts WHERE id = $1", [conceptId]);
  if (conceptResult.rows.length === 0) return null;

  if (conceptResult.rows[0].project_type === "production") {
    const r = await db.query(
      "SELECT id FROM scene_lists WHERE concept_id = $1 ORDER BY created_at DESC LIMIT 1",
      [conceptId]
    );
    return r.rows[0]?.id ?? null;
  }

  const r = await db.query(
    `SELECT sl.id FROM scene_lists sl
     JOIN bit_sheets bs ON bs.id = sl.bit_sheet_id
     JOIN three_act_structures tas ON tas.id = bs.three_act_structure_id
     JOIN pitch_decks pd ON pd.id = tas.pitch_deck_id
     WHERE pd.concept_id = $1 ORDER BY sl.created_at DESC LIMIT 1`,
    [conceptId]
  );
  return r.rows[0]?.id ?? null;
}

// A compact, token-cheap text summary of the schedule — not the full
// script — so the chat stays inexpensive per turn. Each scene line carries
// its [episodeIndex=X, sceneIndex=Y] identity explicitly so the model can
// reference an exact scene in a proposed edit rather than a fuzzy label.
function buildScheduleSummaryForChat(sceneList, shootSchedule) {
  if (!shootSchedule?.scheduleDays?.length) return "No shoot schedule has been generated yet.";
  const isSeries = Boolean(sceneList?.episodeScenes);
  const lines = [];
  shootSchedule.scheduleDays.forEach((day) => {
    lines.push(
      `Day ${day.dayNumber}${day.date ? ` (${day.date})` : ""} — ${day.location?.en ?? ""}${day.completed ? " [COMPLETED]" : ""}`
    );
    (day.sceneRefs ?? []).forEach((ref) => {
      const scene = lookupSceneServerSide(sceneList, ref);
      if (!scene) return;
      const epLabel = isSeries ? `Ep${ref.episodeIndex + 1} ` : "";
      const num = (scene.sceneNumber || String(ref.sceneIndex + 1)).replace(/^\s*(SCENE|SC)\.?\s*/i, "");
      lines.push(
        `  [episodeIndex=${ref.episodeIndex ?? "null"}, sceneIndex=${ref.sceneIndex}] ${epLabel}Scene ${num} — ${scene.location?.en ?? ""} — ${scene.oneLiner?.en ?? ""} | costume: ${ref.costume || "(none)"} | properties: ${ref.properties || "(none)"} | adRemark: ${ref.adRemark || "(none)"}`
      );
    });
  });
  return lines.join("\n");
}

function buildBreakdownSummaryForChat(scriptBreakdown) {
  if (!scriptBreakdown) return "No script breakdown exists yet.";
  const costumeRecommendationLines = (scriptBreakdown.costumeRecommendations ?? []).map(
    (rec) =>
      `  ${rec.character}${rec.approved ? " [APPROVED — locked]" : " [not yet approved]"}: ${rec.sets.map((s) => `${s.quantity}x ${s.category}`).join(", ") || "(no sets yet)"}`
  );
  return [
    `Artists (${scriptBreakdown.artistList?.length ?? 0}): ${(scriptBreakdown.artistList ?? []).map((a) => a.label).join(", ")}`,
    `Locations (${scriptBreakdown.locationList?.length ?? 0}): ${(scriptBreakdown.locationList ?? []).map((l) => l.location?.en).join(", ")}`,
    `Props (${scriptBreakdown.props?.length ?? 0}): ${(scriptBreakdown.props ?? []).map((p) => p.label).join(", ")}`,
    `Costumes (${scriptBreakdown.costumes?.length ?? 0}): ${(scriptBreakdown.costumes ?? []).map((c) => c.character).join(", ")}`,
    `Art/set (${scriptBreakdown.art?.length ?? 0}): ${(scriptBreakdown.art ?? []).map((a) => a.label).join(", ")}`,
    `Costume recommendations (quantities):\n${costumeRecommendationLines.join("\n") || "  (none generated yet)"}`,
  ].join("\n");
}

// The already-confirmed real cast, so the agent can tell "this is a brand
// new character" from "this role already has someone assigned" and can
// match a spoken/written character name back to a crew_members row before
// proposing assign_cast.
async function buildCastRosterForChat(sceneListId) {
  if (!sceneListId) return "Known cast: none confirmed yet.";
  const result = await db.query(
    "SELECT character_name, name, contact_number FROM crew_members WHERE scene_list_id = $1 AND category = 'artist' ORDER BY character_name",
    [sceneListId]
  );
  if (result.rows.length === 0) return "Known cast: none confirmed yet.";
  return (
    "Known cast (character → actor, contact):\n" +
    result.rows.map((r) => `  ${r.character_name || "(unlabeled)"} → ${r.name}${r.contact_number ? ` (${r.contact_number})` : ""}`).join("\n")
  );
}

// Only 'schedule' and 'breakdown' get real project grounding and the
// ability to propose an edit right now — every other stage still gets a
// genuine conversation, just without deep state injected or any action to
// propose, until those get their own deterministic tools.
async function buildStageSummaryForChat(conceptId, stageKey) {
  if (stageKey !== "schedule" && stageKey !== "breakdown") {
    return { sceneListId: null, summary: "(No specific project data is wired up for this stage yet — just have a normal conversation.)" };
  }

  const sceneListId = await findSceneListIdForConcept(conceptId);
  if (!sceneListId) return { sceneListId: null, summary: "No production data exists for this project yet." };

  const roster = await buildCastRosterForChat(sceneListId);

  if (stageKey === "breakdown") {
    const breakdownResult = await db.query(
      "SELECT content FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    return { sceneListId, summary: `${buildBreakdownSummaryForChat(breakdownResult.rows[0]?.content ?? null)}\n\n${roster}` };
  }

  const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
  const sceneList = sceneListResult.rows[0]?.content ?? null;
  const scheduleResult = await db.query(
    "SELECT content FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
    [sceneListId]
  );
  return {
    sceneListId,
    summary: `${buildScheduleSummaryForChat(sceneList, scheduleResult.rows[0]?.content ?? null)}\n\n${roster}`,
  };
}

// sceneEdits is an array (not one flat scene) so a single photo of a
// handwritten note covering several scenes — or a spoken request covering
// several scenes at once — can be proposed and confirmed as one action.
// castAssignment covers reassigning who plays a character, optionally from
// an attached photo (e.g. "she's Priyanka, cast her as Pushpa, her number is
// ..."). Every field the model could otherwise decide to omit is required,
// with an empty-array/empty-string/-1 convention for "not this kind of
// action" — a required field left optional was silently dropped by the
// model in testing even when the reply text implied it had a value.
const AGENT_CHAT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    reply: { type: Type.STRING },
    proposedAction: {
      type: Type.OBJECT,
      properties: {
        type: { type: Type.STRING, enum: ["edit_scenes", "assign_cast", "edit_costume", "none"] },
        sceneEdits: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              episodeIndex: { type: Type.INTEGER },
              sceneIndex: { type: Type.INTEGER },
              costume: { type: Type.STRING },
              properties: { type: Type.STRING },
              adRemark: { type: Type.STRING },
            },
            required: ["episodeIndex", "sceneIndex", "costume", "properties", "adRemark"],
          },
        },
        castAssignment: {
          type: Type.OBJECT,
          properties: {
            characterName: { type: Type.STRING },
            actorName: { type: Type.STRING },
            contactNumber: { type: Type.STRING },
          },
          required: ["characterName", "actorName", "contactNumber"],
        },
        costumeEdit: {
          type: Type.OBJECT,
          properties: {
            character: { type: Type.STRING },
            sets: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  category: { type: Type.STRING },
                  quantity: { type: Type.INTEGER },
                  reason: { type: Type.STRING },
                },
                required: ["category", "quantity", "reason"],
              },
            },
          },
          required: ["character", "sets"],
        },
        description: { type: Type.STRING },
      },
      required: ["type", "sceneEdits", "castAssignment", "costumeEdit", "description"],
    },
  },
  required: ["reply", "proposedAction"],
};

const AGENT_CHAT_NONE_ACTION_INSTRUCTION =
  'Every field in proposedAction is required by the response format even when unused: when proposedAction.type is "none", still set sceneEdits to an empty array, castAssignment to {characterName:"", actorName:"", contactNumber:""}, costumeEdit to {character:"", sets:[]}, and leave description as an empty string.';

const AGENT_CHAT_CAST_ASSIGNMENT_INSTRUCTION =
  'You can also propose reassigning who plays a character — e.g. the AD types a phone number and attaches a photo of a person, saying something like "she\'s Priyanka, cast her as Pushpa" (meaning: the real person in the photo is named Priyanka, and she should play the character Pushpa). To propose this, set proposedAction.type to "assign_cast" and fill castAssignment: characterName is the ROLE/character being cast (match it to one of the known cast entries above if it already exists, otherwise use the name exactly as given), actorName is the real person\'s name, and contactNumber is their phone number if given (empty string if not). Only propose this when both the character and the actor\'s name are clear — ask if either is ambiguous. When proposing assign_cast, leave sceneEdits and costumeEdit at their empty defaults.';

const AGENT_CHAT_STAY_ON_TOPIC_INSTRUCTION =
  "CRITICAL — always respond to the AD's MOST RECENT message specifically, on its own terms. If it raises a new topic, a correction, or a request unrelated to whatever was being discussed before, engage with THAT — don't drift back to or re-propose an earlier idea (especially one they just cancelled) unless they explicitly bring it up again. If they attach a new photo/document, its content is what this turn is actually about — read it fresh rather than assuming it repeats an earlier attachment's content.";

// The single biggest thing separating this from feeling like a real
// assistant (versus a command-line tool with a chat skin) is TONE — a
// terse, template-y reply reads as robotic even when the underlying logic
// is correct. This is deliberately concrete and example-heavy rather than
// a vague "be friendly" line, because a vague instruction produced exactly
// that: technically-correct, personality-free replies that repeated the
// same confirmation phrasing turn after turn.
const AGENT_CHAT_PERSONALITY_INSTRUCTION =
  'Talk the way a real assistant actually talks in conversation — the way ChatGPT, Claude, or Gemini would — not like a form, a command-line tool, or a confirmation dialog with a chat skin on it. Concretely: react to what they just said before diving into the substance (a short acknowledgment that shows you actually followed what they meant, not a generic "Got it" every time); vary your sentence structure, word choice, and how you phrase a question or a proposal from one reply to the next — never lock onto one repeated template and reuse it turn after turn; when something\'s ambiguous, ask about it the way a genuinely curious colleague would — sometimes that\'s reflecting back what you understood and checking it\'s right, sometimes it\'s a couple of small questions together, sometimes it\'s just naturally wondering out loud — not a flat "please specify X." Being warm and conversational doesn\'t mean being long-winded — stay brief, just make the brevity sound human, not clipped.';

const AGENT_CHAT_NEVER_CLAIM_DONE_INSTRUCTION =
  'CRITICAL — your reply text must NEVER claim or imply a change already happened (never "I\'ve added...", "Done", "I\'ve updated...", or similar past tense) — nothing is applied until the human clicks confirm outside this conversation, you\'re only ever proposing. That said, don\'t lock onto one fixed phrasing for this — vary it naturally each time, e.g. "Want me to go ahead and make that change?", "Should I apply that?", "Let me know if that looks right and I\'ll make the update.", "Happy to make that change if you give the word." The one hard rule is the TENSE (never implying it\'s done already); the wording around it should change every time, matching how the rest of your reply naturally reads.';

const AGENT_CHAT_COSTUME_EDIT_INSTRUCTION =
  'You can also propose changing a character\'s costume recommendation list — e.g. "add 2 more nightwear sets for Shruti" or "Abhi doesn\'t need festive wear, drop it". To propose this, set proposedAction.type to "edit_costume" and fill costumeEdit: character is the character\'s name, and sets is the COMPLETE resulting list of costume sets for that character — read their CURRENT sets from the costume recommendations below and write back the full list with the requested change folded in (added, removed, or adjusted), not just the delta — each set has a category, a quantity, and a short plain-English reason. If that character has no costume recommendation yet, sets is just the new set(s) being added. Only propose this when the character and the change are both clear. Note: once a character\'s costume recommendation is approved it\'s meant to be locked, but a direct chat request like this is a deliberate override — go ahead and propose it; the human still confirms before anything actually changes.';

const AGENT_CHAT_SYSTEM_PROMPTS = {
  schedule:
    'You are a sharp Production Scheduling Assistant, having a real back-and-forth conversation with an Assistant Director or Production Manager about their shoot schedule. The AD may attach a photo — it could be a handwritten note (properties/costume/remarks for one or more scenes) or a photo of a person for a casting decision; read it carefully and figure out which kind it is from context.\n\n' +
    AGENT_CHAT_PERSONALITY_INSTRUCTION +
    "\n\n" +
    AGENT_CHAT_STAY_ON_TOPIC_INSTRUCTION +
    "\n\n" +
    'You can propose editing one or more scenes\' costume, properties, or AD remark — ADDING to what\'s already there, never silently replacing or deleting existing info unless they explicitly ask you to remove/replace something. To propose this you must know EXACTLY which scene(s) (matching the [episodeIndex=X, sceneIndex=Y] identities in the schedule below) and what should change for each — if a handwritten note covers several scenes, include one entry in sceneEdits per scene. If you don\'t have enough information yet — which scene, or what exactly to change — ask instead of guessing, in the natural, curious way described above rather than a flat "please specify."\n\n' +
    'When you DO have enough to propose concrete edits: set proposedAction.type to "edit_scenes"; for each scene, fill in the matching episodeIndex/sceneIndex exactly as shown in the schedule below; for whichever of costume/properties/adRemark is actually changing on that scene, write the COMPLETE resulting value — read that scene\'s current value from the schedule above and write it back with the new part folded in (e.g. if properties currently says "Portable Projector & Laptop" and they ask to add a bucket, write "Portable Projector & Laptop, bucket" — the full list, not just "bucket" alone), leaving whichever fields are NOT changing on that scene as empty strings. Also write a one-sentence description of the change(s) for them to confirm.\n\n' +
    AGENT_CHAT_CAST_ASSIGNMENT_INSTRUCTION +
    "\n\n" +
    AGENT_CHAT_NONE_ACTION_INSTRUCTION +
    "\n\n" +
    AGENT_CHAT_NEVER_CLAIM_DONE_INSTRUCTION +
    "\n\nCurrent shoot schedule:\n",
  breakdown:
    'You are a sharp Script Breakdown Assistant, having a real back-and-forth conversation with a Production Manager or Director about the script breakdown (cast, locations, props, costumes, art/set). You cannot edit scenes from here, but you can handle casting and costume recommendations.\n\n' +
    AGENT_CHAT_PERSONALITY_INSTRUCTION +
    "\n\n" +
    AGENT_CHAT_STAY_ON_TOPIC_INSTRUCTION +
    "\n\n" +
    AGENT_CHAT_CAST_ASSIGNMENT_INSTRUCTION +
    "\n\n" +
    AGENT_CHAT_COSTUME_EDIT_INSTRUCTION +
    "\n\n" +
    AGENT_CHAT_NONE_ACTION_INSTRUCTION +
    "\n\n" +
    AGENT_CHAT_NEVER_CLAIM_DONE_INSTRUCTION +
    "\n\nsceneEdits must always be an empty array (this stage never edits scenes).\n\nCurrent script breakdown summary:\n",
};

async function generateAgentChatReply(stageKey, stateSummaryText, history, userMessage, attachmentParts) {
  const systemPrompt =
    (AGENT_CHAT_SYSTEM_PROMPTS[stageKey] ??
      `You are a helpful production management assistant having a conversation about this project. No project data is wired up for this stage yet and you cannot take direct actions here — always set proposedAction.type to "none". ${AGENT_CHAT_NONE_ACTION_INSTRUCTION}\n\n`) +
    stateSummaryText;

  const lastUserParts = [...(attachmentParts ?? []), { text: userMessage }];

  // history entries carry their own imageParts (re-loaded photo bytes) when
  // one was attached — otherwise an earlier "here's a photo of my note"
  // turn becomes literally unanswerable a few messages later, since all
  // the model would have left to go on is the plain text placeholder.
  const contents = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [...(m.imageParts ?? []), { text: m.content }],
    })),
    { role: "user", parts: lastUserParts },
  ];

  const response = await generateContentWithRetry({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      maxOutputTokens: 2048,
      responseSchema: AGENT_CHAT_RESPONSE_SCHEMA,
    },
  });

  return JSON.parse(response.text);
}

function requireConceptAccess(req, conceptId) {
  return req.user.role === "admin" || String(req.user.concept_id) === String(conceptId);
}

// No fileFilter — a handwritten multi-page note might be several photos,
// but the AD may just as easily attach a PDF or Word doc (e.g. a typed
// call sheet draft) instead. Anything not actually readable is caught
// per-file in extractContentPartsForAttachments below rather than
// rejecting the whole upload for one bad file. No maxCount either — the
// AD can attach as many pages/files as one message actually needs.
const agentChatAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// A handwritten multi-page note (e.g. several pages of a Day 2 schedule)
// needs more than one photo in the same message — attachment_photo_path
// holds a JSON-encoded array of bare filenames (never a single bare path)
// so one column covers both "no photo", "one photo", and "several". Only
// images go here (they're the only attachment type shown as a thumbnail in
// chat history) — PDFs/Word docs are read once for the AI call and not
// persisted, same as the screenplay import flow.
function parseAttachmentPhotoPaths(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [raw];
  } catch {
    return [raw]; // pre-existing rows before this array format, if any
  }
}

function photoUrlsFor(raw) {
  return parseAttachmentPhotoPaths(raw).map((path) => photoUrlFor(path));
}

// Images and PDFs go in as real inlineData — the model needs to actually
// SEE them, not just get an extracted text layer, because a PDF here is
// just as likely to be a photographed/scanned handwritten page (e.g. an
// AD's multi-page property list) as a typed document, and a scanned page
// has no text layer at all for a text-extraction reader to find. Gemini
// reads PDF bytes natively (each page, including a scanned/handwritten
// one). Word docs have no equivalent native reading, so they still go
// through the same text-extraction reader the screenplay import uses. A
// file that's neither still gets acknowledged (rather than silently
// dropped) so the reply doesn't look like it ignored an attachment.
async function extractContentPartsForAttachments(files) {
  const parts = [];
  for (const file of files) {
    if (/^image\//.test(file.mimetype) || file.mimetype === "application/pdf") {
      parts.push({ inlineData: { data: file.buffer.toString("base64"), mimeType: file.mimetype } });
      continue;
    }
    try {
      const text = await extractTextFromUploadedScreenplay(file);
      parts.push({ text: `Content of attached file "${file.originalname}":\n${text}` });
    } catch (error) {
      parts.push({ text: `(Attached file "${file.originalname}" could not be read: ${error.message})` });
    }
  }
  return parts;
}

app.get("/api/agent-chat/:conceptId/:stageKey/history", requireLogin, async (req, res) => {
  const { conceptId, stageKey } = req.params;
  if (!requireConceptAccess(req, conceptId)) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const result = await db.query(
    "SELECT id, role, content, author_name, attachment_photo_path, proposed_action, resolved, created_at FROM agent_chat_messages WHERE concept_id = $1 AND stage_key = $2 ORDER BY created_at ASC",
    [conceptId, stageKey]
  );
  res.json({ messages: result.rows.map((m) => ({ ...m, attachment_photo_urls: photoUrlsFor(m.attachment_photo_path) })) });
});

app.post(
  "/api/agent-chat/:conceptId/:stageKey/message",
  requireLogin,
  agentChatAttachmentUpload.array("attachments"),
  async (req, res) => {
    const { conceptId, stageKey } = req.params;
    const { message } = req.body;
    const files = req.files ?? [];
    const imageFiles = files.filter((file) => /^image\//.test(file.mimetype));

    if (!requireConceptAccess(req, conceptId)) {
      res.status(403).json({ error: "You don't have access to this project." });
      return;
    }
    if (!message?.trim() && files.length === 0) {
      res.status(400).json({ error: "A message or at least one attachment is required." });
      return;
    }

    try {
      // Only images are persisted (as chat-history thumbnails) — a PDF/Word
      // attachment is read once for this call, same as the screenplay
      // import flow, and not kept. Its filename is still folded into the
      // stored content below, since it's the only trace of that document
      // that survives past this one turn — without it, a document
      // attachment would look like it silently vanished from history.
      const attachmentPhotoPaths = await Promise.all(imageFiles.map((file) => savePhotoBuffer(file.buffer, file.originalname)));
      const documentFiles = files.filter((file) => !/^image\//.test(file.mimetype));
      const documentNote = documentFiles.length > 0 ? `(attached: ${documentFiles.map((f) => f.originalname).join(", ")})` : "";
      const storedContent =
        [message?.trim(), documentNote].filter(Boolean).join(" ") ||
        (files.length > 1 ? `(${files.length} files attached)` : "(file attached)");

      const userInsert = await db.query(
        "INSERT INTO agent_chat_messages (concept_id, stage_key, role, content, author_name, attachment_photo_path) VALUES ($1, $2, 'user', $3, $4, $5) RETURNING id, role, content, author_name, attachment_photo_path, proposed_action, resolved, created_at",
        [
          conceptId,
          stageKey,
          storedContent,
          req.user.name,
          attachmentPhotoPaths.length > 0 ? JSON.stringify(attachmentPhotoPaths) : null,
        ]
      );

      // Last 20 messages only — enough context for a real conversation
      // without the token cost (and cash cost) growing without bound as a
      // thread gets long.
      const historyResult = await db.query(
        "SELECT role, content, attachment_photo_path FROM agent_chat_messages WHERE concept_id = $1 AND stage_key = $2 ORDER BY created_at DESC LIMIT 20",
        [conceptId, stageKey]
      );
      const historyRows = historyResult.rows.reverse().slice(0, -1); // drop the message we just inserted, already passed separately

      // A photo attached a few turns back needs to still be genuinely
      // visible to the model on a later turn ("what does that note say
      // again?"), not just a text placeholder — but re-sending EVERY past
      // photo on every turn would make a long thread's token cost balloon,
      // so only the 2 most recent photo-bearing turns get their images
      // reloaded; older ones fall back to plain text.
      const photoBearingIndexes = historyRows
        .map((row, i) => (parseAttachmentPhotoPaths(row.attachment_photo_path).length > 0 ? i : null))
        .filter((i) => i !== null)
        .slice(-2);
      const history = await Promise.all(
        historyRows.map(async (row, i) => {
          if (!photoBearingIndexes.includes(i)) return row;
          const paths = parseAttachmentPhotoPaths(row.attachment_photo_path);
          const loaded = await Promise.all(paths.map((p) => loadPhotoBuffer(p)));
          const imageParts = loaded
            .filter(Boolean)
            .map((photo) => ({ inlineData: { data: photo.buffer.toString("base64"), mimeType: photo.mimeType } }));
          return { ...row, imageParts };
        })
      );

      const { summary } = await buildStageSummaryForChat(conceptId, stageKey);
      const attachmentParts = await extractContentPartsForAttachments(files);
      const parsed = await generateAgentChatReply(
        stageKey,
        summary,
        history,
        message?.trim() || "(see attached file(s))",
        attachmentParts
      );

      const hasAction = parsed.proposedAction?.type && parsed.proposedAction.type !== "none";
      // The photo is only kept in memory for the vision call above — an
      // assign_cast action needs it again at confirm time to actually save it
      // onto the crew_members row, so it's carried inside proposed_action
      // (the first photo, if several were attached — a cast assignment only
      // ever needs one representative photo).
      const proposedAction = hasAction ? { ...parsed.proposedAction, photoPath: attachmentPhotoPaths[0] ?? null } : null;
      const assistantInsert = await db.query(
        "INSERT INTO agent_chat_messages (concept_id, stage_key, role, content, proposed_action) VALUES ($1, $2, 'assistant', $3, $4) RETURNING id, role, content, author_name, attachment_photo_path, proposed_action, resolved, created_at",
        [conceptId, stageKey, parsed.reply, proposedAction ? JSON.stringify(proposedAction) : null]
      );

      res.json({
        userMessage: { ...userInsert.rows[0], attachment_photo_urls: photoUrlsFor(userInsert.rows[0].attachment_photo_path) },
        assistantMessage: assistantInsert.rows[0],
      });
    } catch (error) {
      console.error("Agent chat message failed:", error.message);
      res.status(502).json({ error: error.message });
    }
  }
);

app.post("/api/agent-chat/:conceptId/:stageKey/resolve-action", requireLogin, async (req, res) => {
  const { conceptId, stageKey } = req.params;
  const { messageId, decision } = req.body;

  if (!requireConceptAccess(req, conceptId)) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }
  if (!["applied", "cancelled"].includes(decision)) {
    res.status(400).json({ error: "decision must be 'applied' or 'cancelled'." });
    return;
  }

  const messageResult = await db.query(
    "SELECT proposed_action FROM agent_chat_messages WHERE id = $1 AND concept_id = $2 AND stage_key = $3",
    [messageId, conceptId, stageKey]
  );
  if (messageResult.rows.length === 0) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  const action = messageResult.rows[0].proposed_action;
  if (!action) {
    res.status(400).json({ error: "This message has no proposed action." });
    return;
  }

  let appliedSchedule = null;
  let appliedCastMember = null;
  let appliedBreakdown = null;

  if (decision === "applied" && action.type === "edit_scenes" && Array.isArray(action.sceneEdits) && action.sceneEdits.length > 0) {
    const sceneListId = await findSceneListIdForConcept(conceptId);
    const latest = await db.query(
      "SELECT id, content, status FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    if (latest.rows.length === 0) {
      res.status(404).json({ error: "No shoot schedule found to apply this to." });
      return;
    }
    const content = latest.rows[0].content;
    const appliedEdits = new Set();
    const scheduleDays = content.scheduleDays.map((day) => ({
      ...day,
      sceneRefs: day.sceneRefs.map((ref) => {
        const edit = action.sceneEdits.find(
          (e) => e.sceneIndex === ref.sceneIndex && (e.episodeIndex ?? null) === (ref.episodeIndex ?? null)
        );
        if (!edit) return ref;
        appliedEdits.add(edit);
        // The model is told to write each field's COMPLETE resulting value
        // (having already read the current one from the schedule summary
        // given to it), not just the delta — so this replaces outright
        // rather than appending, which would otherwise double up whatever
        // was already there.
        return {
          ...ref,
          costume: edit.costume?.trim() ? edit.costume.trim() : ref.costume,
          properties: edit.properties?.trim() ? edit.properties.trim() : ref.properties,
          adRemark: edit.adRemark?.trim() ? edit.adRemark.trim() : ref.adRemark,
        };
      }),
    }));

    if (appliedEdits.size === 0) {
      res.status(404).json({ error: "None of those scenes were found in the current schedule." });
      return;
    }

    const updatedContent = { ...content, scheduleDays };
    // A chat-agreed field edit shouldn't silently un-approve an
    // already-approved schedule — carries the previous status forward.
    const insertResult = await db.query(
      "INSERT INTO shoot_schedules (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(updatedContent), latest.rows[0].status, "Applied a change agreed in the Changes chat"]
    );
    appliedSchedule = { ...insertResult.rows[0], sceneListId, ...updatedContent };

    // Keep the AD Scene Breakdown Sheet's matching rows in sync with this
    // same chat-agreed edit — see applySceneEditsToAdSheet's own comment
    // for why these two documents would otherwise silently drift apart.
    const latestBreakdownForSync = await db.query(
      "SELECT id, content, status FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    if (latestBreakdownForSync.rows.length > 0) {
      const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
      const { adSheet, touched } = applySceneEditsToAdSheet(
        latestBreakdownForSync.rows[0].content,
        sceneListResult.rows[0].content,
        action.sceneEdits
      );
      if (touched) {
        const updatedBreakdownContent = { ...latestBreakdownForSync.rows[0].content, adSheet };
        const breakdownInsertResult = await db.query(
          "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
          [sceneListId, JSON.stringify(updatedBreakdownContent), latestBreakdownForSync.rows[0].status, "AD Sheet synced from a change agreed in the Changes chat"]
        );
        appliedBreakdown = { ...breakdownInsertResult.rows[0], sceneListId, ...updatedBreakdownContent };
      }
    }
  }

  if (decision === "applied" && action.type === "assign_cast" && action.castAssignment?.characterName?.trim()) {
    const sceneListId = await findSceneListIdForConcept(conceptId);
    const { characterName, actorName, contactNumber } = action.castAssignment;

    const existing = await db.query(
      "SELECT id, photo_path FROM crew_members WHERE scene_list_id = $1 AND category = 'artist' AND character_name = $2",
      [sceneListId, characterName.trim()]
    );

    if (existing.rows.length > 0) {
      if (action.photoPath && existing.rows[0].photo_path) deletePhoto(existing.rows[0].photo_path);
      const updateResult = await db.query(
        "UPDATE crew_members SET name = $1, contact_number = $2, photo_path = $3 WHERE id = $4 RETURNING *",
        [actorName.trim(), contactNumber?.trim() || null, action.photoPath || existing.rows[0].photo_path, existing.rows[0].id]
      );
      appliedCastMember = serializeCrewMember(updateResult.rows[0]);
    } else {
      const insertResult = await db.query(
        `INSERT INTO crew_members (scene_list_id, category, character_name, name, contact_number, photo_path)
         VALUES ($1, 'artist', $2, $3, $4, $5) RETURNING *`,
        [sceneListId, characterName.trim(), actorName.trim(), contactNumber?.trim() || null, action.photoPath || null]
      );
      appliedCastMember = serializeCrewMember(insertResult.rows[0]);
    }
  }

  if (decision === "applied" && action.type === "edit_costume" && action.costumeEdit?.character?.trim()) {
    const sceneListId = await findSceneListIdForConcept(conceptId);
    const { character, sets } = action.costumeEdit;

    const latestBreakdown = await db.query(
      "SELECT id, content, status FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    if (latestBreakdown.rows.length > 0) {
      const breakdownContent = latestBreakdown.rows[0].content;
      const recommendations = breakdownContent.costumeRecommendations ?? [];
      const index = recommendations.findIndex((rec) => rec.character.toLowerCase() === character.trim().toLowerCase());
      const cleanSets = (sets ?? []).map((s) => ({ category: s.category, quantity: s.quantity, reason: { en: s.reason ?? "", or: "" } }));

      const updatedRecommendations =
        index === -1
          ? [...recommendations, { character: character.trim(), totalScenes: 0, sets: cleanSets, approved: false }]
          : recommendations.map((rec, i) => (i === index ? { ...rec, sets: cleanSets, approved: false } : rec));

      const updatedBreakdownContent = { ...breakdownContent, costumeRecommendations: updatedRecommendations };
      // A chat-driven edit is a deliberate override, even on a previously
      // approved (locked) recommendation — it goes back to unapproved so
      // it's reviewed again, but the breakdown's own overall status is
      // preserved (this is enrichment, not a full re-analysis).
      const insertResult = await db.query(
        "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
        [sceneListId, JSON.stringify(updatedBreakdownContent), latestBreakdown.rows[0].status, `Edited costume recommendation for ${character.trim()} via the Changes chat`]
      );
      appliedBreakdown = { ...insertResult.rows[0], sceneListId, ...updatedBreakdownContent };
    }
  }

  await db.query("UPDATE agent_chat_messages SET resolved = $1 WHERE id = $2", [decision, messageId]);

  res.json({ resolved: decision, schedule: appliedSchedule, castMember: appliedCastMember, breakdown: appliedBreakdown });
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
  const leadingText = text.slice(0, firstIndex).trim();
  // Content before the first explicit header is only ever real scene
  // material — an unlabeled cold open — if it actually contains a scene
  // heading. Otherwise it's title-page front matter (title, credits,
  // "Streaming on X", a "12 of 124" page footer, etc.), which must be
  // discarded rather than counted as its own "episode 1": treating it as
  // one shifts every real episode's number up by one, since the episode
  // ARRAY POSITION (not the header's own number) is what every other
  // stage uses to label "Episode N".
  if (leadingText.length > 0 && /^\s*(SCENE\s+\S|INT[.\s]|EXT[.\s])/im.test(leadingText)) {
    episodes.push({ episodeNumber: 1, title: null, text: leadingText });
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
    ? `This is EPISODE ${episodeNumber}${episodeTitle ? ` ("${episodeTitle}")` : ""} of a multi-episode series — extract ONLY this episode's own scenes. `
    : "";
  const targetLine = targetMinutes
    ? ` This ${isSeries ? "episode" : "film"} runs approximately ${targetMinutes} minutes — use that to calibrate each scene's estimatedMinutes so they add up in the right ballpark, without forcing an exact match.`
    : "";

  const response = await generateContentWithRetry({
    model: "gemini-flash-lite-latest",
    contents: `The user pasted an already-written screenplay below — treat it as authoritative, this is a transcription/structuring task, not a creative rewrite. ${episodeLine}Extract a faithful scene-by-scene breakdown of the ENTIRE material given — for each scene give sceneNumber (the scene's OWN literal number/label exactly as written in the source — e.g. "5A", "36", or whatever this script actually uses; copy it verbatim, including any letter suffix; NEVER assume it restarts at 1 per episode or renumber it sequentially yourself — if the source keeps counting up across episodes, or starts a scene list mid-sequence, or uses "5A"/"5B" for scenes inserted between 5 and 6, preserve that exactly, since this is what every department on set actually references), actNumber (estimate 1/2/3 from its position within this material), intExt (INT/EXT), a bilingual location (just the place name), timeOfDay (DAY/NIGHT), a bilingual oneLiner summarizing what happens — and it must name EVERY character physically present in the scene, not just whoever is speaking or central to it (someone silently dropping something off, a background figure the script names, etc. — never omit a named person from the one-liner just because their part is brief), an estimatedMinutes number (infer from the scene's length/content), a purpose ("plot_advancing" or "character_revealing"), and a bilingual turn (its value-shift).${targetLine} Odia must be real Odia (Oriya) script, never Romanized. Do not skip any scene, however short.\n\nThe pasted screenplay material:\n${episodeText}`,
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
// Shared by the initial import and the later "re-upload an updated draft"
// flow — everything up through building the scene list's own content,
// without touching the database, so the caller decides whether that's a
// brand new project or an update to an existing one.
async function parseScreenplayIntoSceneListContent(pastedText, format) {
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

  return { metadata, sceneListContent };
}

async function createProductionProjectFromScreenplayText(pastedText, format) {
  const { metadata, sceneListContent } = await parseScreenplayIntoSceneListContent(pastedText, format);

  const conceptResult = await db.query(
    "INSERT INTO concepts (concept_text, storylines, title, project_type) VALUES ($1, $2, $3, 'production') RETURNING id",
    [metadata.title, JSON.stringify([]), metadata.title]
  );
  const conceptId = conceptResult.rows[0].id;

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

const handwrittenNoteUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

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

// One scene's own literal number, in order — matches the same fallback
// every other scene-number display uses, so a diff against an older
// scene list (from before sceneNumber existed) still lines up sensibly.
function extractSceneNumbers(sceneListContent) {
  if (sceneListContent.episodeScenes) {
    return sceneListContent.episodeScenes.flatMap((episodeScene) =>
      episodeScene.scenes.map((scene, i) => scene.sceneNumber || String(i + 1))
    );
  }
  return (sceneListContent.scenes ?? []).map((scene, i) => scene.sceneNumber || String(i + 1));
}

// Re-parses a NEWER draft of a screenplay against an EXISTING production
// project — for when the writer hands over a revised script after the
// production manager has already cast artists, attached photos, and
// confirmed locations against the old one. The whole point is that none
// of that already-entered production data should be lost or silently
// altered, so:
//
// - The scene_lists row is UPDATED IN PLACE (same id), not replaced with a
//   new one — every other stage here uses INSERT-only revision history,
//   but crew_members/script_breakdowns/shoot_schedules all hang off this
//   exact scene_lists.id via a hard foreign key, so keeping that id
//   stable is what keeps all of them attached without any migration.
// - Crew/cast is linked by character or location NAME (not scene
//   position), so it's untouched by this function entirely — it's never
//   queried, updated, or re-derived here.
// - A character/location the new draft no longer contains is NOT dropped
//   from the merged breakdown list — it's kept (so its crew_members entry,
//   with contact number and photo, stays visible and attached) and
//   reported back as "no longer found" for the production manager to
//   review and remove by hand if it's really gone.
//
// Shared by both the paste-text and file-upload re-upload routes, same
// split as the original import.
async function reimportScreenplayForSceneList(sceneListId, pastedText, format) {
  const existing = await db.query("SELECT concept_id, content FROM scene_lists WHERE id = $1", [sceneListId]);
  if (existing.rows.length === 0) {
    return { status: 404, error: "Scene list not found" };
  }
  if (!existing.rows[0].content.sourceText) {
    return { status: 400, error: "This isn't an imported-screenplay project — there's no earlier script to re-upload against." };
  }

  const previousSceneListContent = existing.rows[0].content;
  const { sceneListContent: newSceneListContent } = await parseScreenplayIntoSceneListContent(pastedText, format);

  await db.query("UPDATE scene_lists SET content = $1 WHERE id = $2", [JSON.stringify(newSceneListContent), sceneListId]);

  const oldSceneNumbers = new Set(extractSceneNumbers(previousSceneListContent));
  const newSceneNumbers = new Set(extractSceneNumbers(newSceneListContent));
  const changes = {
    addedScenes: [...newSceneNumbers].filter((n) => !oldSceneNumbers.has(n)),
    removedScenes: [...oldSceneNumbers].filter((n) => !newSceneNumbers.has(n)),
    addedCharacters: [],
    removedCharacters: [],
    addedLocations: [],
    removedLocations: [],
  };

  const latestBreakdown = await db.query(
    "SELECT id, content FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
    [sceneListId]
  );

  let breakdownResult = null;
  if (latestBreakdown.rows.length > 0) {
    const previousContent = latestBreakdown.rows[0].content;
    const freshContent = await generateDeepScriptBreakdownContent(newSceneListContent.sourceText);

    const previousArtistLabels = new Set((previousContent.artistList ?? []).map((a) => a.label));
    const freshArtistLabels = new Set((freshContent.artistList ?? []).map((a) => a.label));
    const previousLocationLabels = new Set((previousContent.locationList ?? []).map((l) => l.location.en));
    const freshLocationLabels = new Set((freshContent.locationList ?? []).map((l) => l.location.en));

    changes.addedCharacters = [...freshArtistLabels].filter((l) => !previousArtistLabels.has(l));
    changes.removedCharacters = [...previousArtistLabels].filter((l) => !freshArtistLabels.has(l));
    changes.addedLocations = [...freshLocationLabels].filter((l) => !previousLocationLabels.has(l));
    changes.removedLocations = [...previousLocationLabels].filter((l) => !freshLocationLabels.has(l));

    // Kept, not dropped — see the function's header comment.
    const keptOldArtists = (previousContent.artistList ?? []).filter((a) => changes.removedCharacters.includes(a.label));
    const keptOldLocations = (previousContent.locationList ?? []).filter((l) => changes.removedLocations.includes(l.location.en));

    const mergedContent = {
      ...freshContent,
      artistList: [...freshContent.artistList, ...keptOldArtists],
      locationList: [...freshContent.locationList, ...keptOldLocations],
    };

    const feedbackParts = [];
    if (changes.addedCharacters.length) feedbackParts.push(`Added characters: ${changes.addedCharacters.join(", ")}`);
    if (changes.removedCharacters.length) feedbackParts.push(`No longer found (cast kept): ${changes.removedCharacters.join(", ")}`);
    if (changes.addedLocations.length) feedbackParts.push(`Added locations: ${changes.addedLocations.join(", ")}`);
    if (changes.removedLocations.length) feedbackParts.push(`Locations no longer found (kept): ${changes.removedLocations.join(", ")}`);

    const insertResult = await db.query(
      "INSERT INTO script_breakdowns (scene_list_id, content, feedback) VALUES ($1, $2, $3) RETURNING id, status, feedback",
      [
        sceneListId,
        JSON.stringify(mergedContent),
        feedbackParts.length ? `Re-imported screenplay — ${feedbackParts.join("; ")}` : "Re-imported screenplay",
      ]
    );
    breakdownResult = { ...insertResult.rows[0], sceneListId: Number(sceneListId), ...mergedContent };
  }

  const shootScheduleCheck = await db.query("SELECT id FROM shoot_schedules WHERE scene_list_id = $1 LIMIT 1", [sceneListId]);

  return {
    status: 200,
    body: {
      sceneList: { id: Number(sceneListId), conceptId: existing.rows[0].concept_id, ...newSceneListContent },
      breakdown: breakdownResult,
      changes,
      shootScheduleMayNeedRegeneration: shootScheduleCheck.rows.length > 0,
    },
  };
}

app.post("/api/scene-lists/:id/reimport-screenplay", requireRole("admin"), async (req, res) => {
  const { pastedText, format } = req.body;

  if (!pastedText || !pastedText.trim()) {
    res.status(400).json({ error: "Paste the updated screenplay first." });
    return;
  }

  try {
    const result = await reimportScreenplayForSceneList(req.params.id, pastedText, format);
    if (result.error) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.body);
  } catch (error) {
    console.error("Screenplay re-import failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

app.post(
  "/api/scene-lists/:id/reimport-screenplay/file",
  requireRole("admin"),
  screenplayUpload.single("file"),
  async (req, res) => {
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
      const result = await reimportScreenplayForSceneList(req.params.id, text, format);
      if (result.error) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json(result.body);
    } catch (error) {
      console.error("Screenplay re-import (file) failed:", error.message);
      res.status(error.message?.startsWith("Unsupported file type") ? 400 : 502).json({ error: error.message });
    }
  }
);

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
      `attachment; filename="${deck.title.en.replace(/[^a-z0-9]+/gi, "-")}-pitch-deck-${lang}-${formatExportTimestamp()}.pdf"`
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

// A slide deck has no natural rows/columns, so the Excel version is a
// simplified outline instead of a redesign of the presentation: one
// "Overview" sheet for the single-value fields, plus a "Major Characters"
// sheet and (series only) an "Episodes" sheet for the two list sections.
app.get("/api/pitch-deck/:id/export-excel", requireLogin, async (req, res) => {
  const lang = req.query.lang === "or" ? "or" : "en";

  try {
    const result = await db.query("SELECT content FROM pitch_decks WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Pitch deck not found" });
      return;
    }

    const deck = result.rows[0].content;
    const labels = SECTION_LABELS[lang];
    const fieldLabel = lang === "or" ? "କ୍ଷେତ୍ର" : "Field";
    const valueLabel = lang === "or" ? "ମୂଲ୍ୟ" : "Value";
    const nameLabel = lang === "or" ? "ନାମ" : "Name";
    const roleLabel = lang === "or" ? "ଭୂମିକା" : "Role";
    const titleLabel = lang === "or" ? "ଆଖ୍ୟା" : "Title";
    const loglineLabel = lang === "or" ? "ଲଗ୍‌ଲାଇନ୍" : "Logline";
    const synopsisLabel = lang === "or" ? "ସାରାଂଶ" : "Synopsis";

    const workbook = new ExcelJS.Workbook();

    const overviewSheet = workbook.addWorksheet(lang === "or" ? "ସମୀକ୍ଷା" : "Overview");
    overviewSheet.columns = [
      { header: fieldLabel, key: "field", width: 22 },
      { header: valueLabel, key: "value", width: 80 },
    ];
    overviewSheet.getRow(1).font = { bold: true };
    overviewSheet.addRow({ field: titleLabel, value: deck.title[lang] });
    overviewSheet.addRow({ field: loglineLabel, value: deck.logline[lang] });
    overviewSheet.addRow({ field: labels.premise, value: deck.premise[lang] });
    overviewSheet.addRow({ field: labels.toneGenre, value: deck.toneGenre[lang] });
    overviewSheet.addRow({ field: labels.targetAudience, value: deck.targetAudience[lang] });

    if (deck.majorCharacters && deck.majorCharacters.length > 0) {
      const charSheet = workbook.addWorksheet(labels.majorCharacters.slice(0, 31));
      charSheet.columns = [
        { header: nameLabel, key: "name", width: 22 },
        { header: roleLabel, key: "role", width: 24 },
        { header: labels.emotionalCore, key: "emotionalCore", width: 40 },
        { header: labels.conflict, key: "conflict", width: 40 },
      ];
      charSheet.getRow(1).font = { bold: true };
      deck.majorCharacters.forEach((character) => {
        charSheet.addRow({
          name: character.name,
          role: character.role[lang],
          emotionalCore: character.emotionalCore[lang],
          conflict: character.conflict[lang],
        });
      });
    }

    if (deck.episodes && deck.episodes.length > 0) {
      const episodeSheet = workbook.addWorksheet((lang === "or" ? "ପର୍ବଗୁଡ଼ିକ" : "Episodes").slice(0, 31));
      episodeSheet.columns = [
        { header: labels.episode, key: "episode", width: 12 },
        { header: titleLabel, key: "title", width: 28 },
        { header: synopsisLabel, key: "synopsis", width: 70 },
      ];
      episodeSheet.getRow(1).font = { bold: true };
      deck.episodes.forEach((episode, index) => {
        episodeSheet.addRow({ episode: index + 1, title: episode.title[lang], synopsis: episode.synopsis[lang] });
      });
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${deck.title.en.replace(/[^a-z0-9]+/gi, "-")}-pitch-deck-${lang}-${formatExportTimestamp()}.xlsx"`
    );
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Pitch deck Excel export failed:", error.message);
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
          artistList: { type: Type.ARRAY, items: BREAKDOWN_ARTIST_SCHEMA },
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

// Additive-only sibling to "Re-analyze" — that button regenerates the
// WHOLE artistList fresh each time, which risks a subtle first-pass catch
// silently vanishing on a later pass. This only ever APPENDS newly found
// characters, never touches or reorders what's already there, so it's
// safe to run at any time without risking already-cast entries.
async function findMissingCharactersInChunk(chunkText, knownLabels) {
  const contents = `The script material (one part of a larger script — the character list below spans the WHOLE script, not just this part):\n${chunkText}\n\nAlready-known characters (do NOT report any of these again, even if they appear here): ${knownLabels.join(", ") || "(none yet)"}\n\nThoroughly re-read this material and identify every character with ANY screen presence who is NOT already in the known list above — including characters who never speak, appear only briefly, or are simply named while physically present in a scene (someone silently dropping something off, a background figure the script gives a real name to, etc.). Do not skip anyone just because their part is small. Exclude only generic, unnamed background people or crowds ("a few guests", "kids playing football", "wedding crowd") — never exclude someone the script actually names. For each character found, give: a short bilingual note on their overall involvement, matching the style of an existing character-list entry; their approximate age (an age or age range as stated or reasonably inferable, e.g. "60s", "Late 20s", "Child, around 8" — "Unspecified" only if genuinely not inferable); and their gender (Male, Female, or Unspecified), inferred confidently from name/pronouns/context rather than defaulted. If none are missing from this material, return an empty array.`;

  const response = await generateContentWithRetry({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: SCRIPT_BREAKDOWN_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
      responseSchema: {
        type: Type.OBJECT,
        properties: { missingCharacters: { type: Type.ARRAY, items: BREAKDOWN_ARTIST_SCHEMA } },
        required: ["missingCharacters"],
      },
    },
  });

  return sanitizeBilingualContent(JSON.parse(response.text)).missingCharacters ?? [];
}

// Splits on "EPISODE N" boundaries when the source has them (reusing the
// same import-time splitter) so a long multi-episode script gets one
// focused scan per episode instead of one pass over the whole thing —
// the same "a single long pass misses things" lesson as the AD sheet and
// the deep breakdown re-verification.
async function findMissingCharacters(sourceText, existingArtistList) {
  const knownLabels = existingArtistList.map((a) => a.label);
  const chunks = splitScreenplayIntoEpisodes(sourceText);
  const textChunks = chunks.length > 1 ? chunks.map((c) => c.text) : [sourceText];

  const results = await mapWithConcurrency(textChunks, 3, (chunkText) => findMissingCharactersInChunk(chunkText, knownLabels));

  const seenLabelsLower = new Set(knownLabels.map((l) => l.toLowerCase()));
  const merged = [];
  results.flat().forEach((character) => {
    const key = character.label.toLowerCase();
    if (seenLabelsLower.has(key)) return;
    seenLabelsLower.add(key);
    merged.push(character);
  });
  return merged;
}

// Evidence for one chunk: for each known character who actually appears in
// THIS material, whether they have any spoken line here (including a
// voice-over/phone/radio line — dialogue attributed to them without being
// physically present) and whether they're physically present here at all
// (even silently). Merged across every chunk afterward using "ever" logic,
// since a character's overall category depends on their whole-script
// presence, not any single scene.
const CAST_CATEGORY_EVIDENCE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    evidence: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          hasDialogueHere: { type: Type.BOOLEAN },
          physicallyPresentHere: { type: Type.BOOLEAN },
        },
        required: ["label", "hasDialogueHere", "physicallyPresentHere"],
      },
    },
  },
  required: ["evidence"],
};

async function classifyCastCategoriesInChunk(chunkText, knownLabels) {
  const contents = `The script material (one part of the full script):\n${chunkText}\n\nKnown characters to check (exact names): ${knownLabels.join(", ")}\n\nFor EACH of these characters who appears ANYWHERE in this material (skip anyone who doesn't appear at all here), report two things based strictly on this material:\n- "hasDialogueHere": true if they have any actual spoken line here — this includes a voice-over, a phone-call voice, a radio/PA announcement, or any other line attributed to them even when they aren't physically in the scene.\n- "physicallyPresentHere": true if they are physically present and visible in a scene here — performing an action, standing, moving, silently reacting — even if they never speak. False if their only appearance here is as a disembodied voice (V.O., O.S., over the phone/radio, etc.) with no physical presence in the scene.\nA character can have both true (present and speaking), only physicallyPresentHere true (present but silent), or only hasDialogueHere true (heard but never physically there). Only include characters that actually appear in this material in some form — omit anyone absent from it entirely.`;

  const response = await generateContentWithRetry({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: SCRIPT_BREAKDOWN_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
      responseSchema: CAST_CATEGORY_EVIDENCE_SCHEMA,
    },
  });

  return JSON.parse(response.text).evidence ?? [];
}

// Splits into episode-sized chunks like the missing-character scan and AD
// sheet, since a character's category depends on evidence gathered across
// the ENTIRE script, not just wherever they were first introduced. Merge
// rule: ever-spoken AND ever-physically-present -> "speaking" (a real
// speaking role, cast and called normally, regardless of whether the
// dialogue and the physical presence happened in the same scene or
// different ones); ever-physically-present only -> "non_speaking_action"
// (present in scenes, never gets a line — a real on-set actor, just
// silent); ever-spoken but NEVER physically present anywhere ->
// "off_screen" (pure voice-over/phone/radio — the actor never needs to be
// on this set, no call sheet slot). Existing label/notes/age/gender on
// each artistList entry are left untouched — this only adds castCategory.
async function classifyCastCategories(sourceText, artistList) {
  const knownLabels = artistList.map((a) => a.label);
  const chunks = splitScreenplayIntoEpisodes(sourceText);
  const textChunks = chunks.length > 1 ? chunks.map((c) => c.text) : [sourceText];

  const results = await mapWithConcurrency(textChunks, 3, (chunkText) => classifyCastCategoriesInChunk(chunkText, knownLabels));

  const hasDialogueEver = new Set();
  const presentEver = new Set();
  results.flat().forEach((row) => {
    const key = row.label.toLowerCase();
    if (row.hasDialogueHere) hasDialogueEver.add(key);
    if (row.physicallyPresentHere) presentEver.add(key);
  });

  return artistList.map((item) => {
    const key = item.label.toLowerCase();
    const speaks = hasDialogueEver.has(key);
    const present = presentEver.has(key);
    const castCategory = present ? (speaks ? "speaking" : "non_speaking_action") : speaks ? "off_screen" : item.castCategory ?? "speaking";
    return { ...item, castCategory };
  });
}

// One entry per real scene, in order — the deterministic half of the AD
// sheet (SCN/description/INT-EXT/day-night/location all come straight from
// the already-approved scene list, never from the AI).
// sceneNumber is the scene's own literal number from the source screenplay
// when the import step captured one (never recomputed from array position
// — a script that uses "5A"/"5B" or keeps counting across episodes instead
// of restarting at 1 must show exactly that, since that's what the whole
// crew actually references on set). Only falls back to the array position
// for older data or AI-written scenes that never had a "real" number.
function flattenScenesForAdSheet(sceneList) {
  if (sceneList.episodeScenes) {
    const entries = [];
    sceneList.episodeScenes.forEach((episodeScene, episodeIndex) => {
      episodeScene.scenes.forEach((scene, sceneIndex) => {
        entries.push({
          sceneNumber: scene.sceneNumber || String(sceneIndex + 1),
          episodeLabel: `Episode ${episodeIndex + 1}`,
          intExt: scene.intExt,
          timeOfDay: scene.timeOfDay,
          location: scene.location,
          oneLiner: scene.oneLiner,
        });
      });
    });
    return entries;
  }
  return sceneList.scenes.map((scene, sceneIndex) => ({
    sceneNumber: scene.sceneNumber || String(sceneIndex + 1),
    episodeLabel: null,
    intExt: scene.intExt,
    timeOfDay: scene.timeOfDay,
    location: scene.location,
    oneLiner: scene.oneLiner,
  }));
}

// Resolves a scene as an AD would write it by hand (an episode label plus
// the script's own literal scene number, e.g. "Episode 4" + "7") back to
// this app's internal {episodeIndex, sceneIndex} identity — the reverse of
// flattenScenesForAdSheet's sceneNumber/episodeLabel. Returns null rather
// than guessing when nothing matches, so an unresolved handwritten note
// item can be surfaced to the AD instead of silently applied to the wrong
// scene.
function resolveSceneIdentityFromLabels(sceneList, episodeLabelRaw, sceneNumberLabelRaw) {
  const target = String(sceneNumberLabelRaw || "")
    .replace(/^\s*(SCENE|SC)\.?\s*/i, "")
    .trim()
    .toLowerCase();
  if (!target) return null;

  if (sceneList.episodeScenes) {
    const epMatch = /(\d+)/.exec(episodeLabelRaw || "");
    const candidateEpisodeIndexes = epMatch
      ? [Number(epMatch[1]) - 1]
      : sceneList.episodeScenes.map((_, i) => i);

    for (const episodeIndex of candidateEpisodeIndexes) {
      const episode = sceneList.episodeScenes[episodeIndex];
      if (!episode) continue;
      const sceneIndex = episode.scenes.findIndex(
        (s) => (s.sceneNumber || "").replace(/^\s*(SCENE|SC)\.?\s*/i, "").trim().toLowerCase() === target
      );
      if (sceneIndex !== -1) return { episodeIndex, sceneIndex };
    }
    return null;
  }

  const sceneIndex = sceneList.scenes.findIndex(
    (s) => (s.sceneNumber || "").replace(/^\s*(SCENE|SC)\.?\s*/i, "").trim().toLowerCase() === target
  );
  return sceneIndex !== -1 ? { episodeIndex: null, sceneIndex } : null;
}

// One item per distinct scene mentioned in the photo, each with the scene
// identity resolved server-side (never trusting the model's own guess at
// which internal scene that corresponds to) — unresolved items are still
// returned, flagged, so the AD can see exactly what couldn't be placed
// automatically rather than having it silently dropped or misapplied.
const HANDWRITTEN_SCHEDULE_CHANGES_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    changes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          episodeLabel: { type: Type.STRING },
          sceneNumberLabel: { type: Type.STRING },
          propertiesToAdd: { type: Type.ARRAY, items: { type: Type.STRING } },
          costumeNote: { type: Type.STRING },
          remark: { type: Type.STRING },
        },
        required: ["episodeLabel", "sceneNumberLabel", "propertiesToAdd", "costumeNote", "remark"],
      },
    },
  },
  required: ["summary", "changes"],
};

async function parseHandwrittenScheduleNote(imageBuffer, mimeType, sceneList, sceneListId) {
  const isSeries = Boolean(sceneList.episodeScenes);
  const seriesLine = isSeries
    ? "This is a multi-episode series — if an episode number is written for an item, capture it exactly (e.g. \"Episode 4\"); if none is written, leave episodeLabel empty and it will be searched for across all episodes."
    : "This is a single film with no episodes — always leave episodeLabel empty.";

  const contents = [
    { inlineData: { data: imageBuffer.toString("base64"), mimeType } },
    {
      text: `This is a photo of an Assistant Director's handwritten note about changes to make to the shoot schedule and/or scene breakdown sheet — typically properties/props to add for a scene, a costume note, or some other remark. Read the handwriting carefully; it may be messy, abbreviated, or in a mix of English and another language written in Latin script.\n\n${seriesLine}\n\nFor each distinct scene mentioned, extract: the episode label exactly as written (or empty), the scene number exactly as written — copy it verbatim (e.g. "7", "12A"), never guess or renumber it — any properties/props to add for that scene (as a list of short item names, one per prop, not one long sentence), any costume note, and any other remark. If something in the note clearly isn't tied to a specific scene number, still include it with sceneNumberLabel left empty. Also write one short, plain-English summary paragraph covering everything you read, for a human to review before anything is applied — if any part of the handwriting was illegible or ambiguous, say so plainly in the summary instead of guessing at it.`,
    },
  ];

  const response = await generateContentWithRetry({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: SCRIPT_BREAKDOWN_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
      responseSchema: HANDWRITTEN_SCHEDULE_CHANGES_SCHEMA,
    },
  });

  const parsed = JSON.parse(response.text);
  const changes = parsed.changes.map((change) => {
    const identity = resolveSceneIdentityFromLabels(sceneList, change.episodeLabel, change.sceneNumberLabel);
    return { ...change, episodeIndex: identity?.episodeIndex ?? null, sceneIndex: identity?.sceneIndex ?? null, resolved: identity !== null };
  });

  return { summary: parsed.summary, changes };
}

// Only the four columns that genuinely need inference — who's in each
// scene, extras, properties, and costume remarks — using the already
// generated category breakdown (character/prop/costume names) as the
// vocabulary to draw from instead of inventing new entities.
const AD_SHEET_BATCH_SIZE = 15;

// One focused call per small batch of scenes (not one giant call for the
// whole script) — the same "don't trust a single long pass" lesson already
// applied to the categorized breakdown's deep-reanalysis, since a model
// asked to carefully track every incidental character across 70+ scenes in
// one shot tends to default to just the two leads for anything it isn't
// paying close attention to.
async function generateAdSheetDetailsForBatch(batchEntries, batchStartIndex, breakdownContent, sourceText) {
  const numberedScenes = batchEntries
    .map((s, i) => `${batchStartIndex + i + 1}. [${s.sceneNumber}] ${s.intExt}. ${s.location.en} — ${s.timeOfDay}: ${s.oneLiner.en}`)
    .join("\n");
  // The FULL cast (every character the breakdown ever found), not just the
  // 3-5 major characters from the character sheet — a one-scene bit player
  // like someone dropping off a baby is a real established character here
  // even though they'd never make a "major characters" list.
  const knownCharacters = (breakdownContent.artistList ?? []).map((a) => a.label).join(", ");
  const knownProps = (breakdownContent.props ?? []).map((p) => p.label).join(", ");
  const knownCostumes = (breakdownContent.costumes ?? []).map((c) => `${c.character}: ${c.description.en}`).join("; ");

  const contents = `The full script material (the authoritative source — use this to check exactly who and what is in each of the scenes below, not just their one-liners, which are compressed summaries that can omit incidental details):\n${sourceText}\n\nThese ${batchEntries.length} scenes are the ones to report back on this time, numbered by their true position in the full scene list:\n${numberedScenes}\n\nEstablished full cast list: ${knownCharacters}\n\nEstablished property list: ${knownProps || "(none yet)"}\n\nEstablished costume notes: ${knownCostumes || "(none yet)"}\n\nFor EACH of these ${batchEntries.length} scenes, in the same order given, re-read the corresponding part of the full script material carefully and determine:\n- mainCharacters: EVERY named individual who is physically part of that scene's action — whether or not they speak, and however brief their presence (someone dropping something off, a silent bystander who is nonetheless a named character, a baby being handed over, etc.). Do not default to just the scene's two lead characters — actively check for every name the script mentions in that scene. Prefer exact names from the established full cast list above when they match, but if the script clearly names someone not on that list, include them anyway using the name the script gives them — never silently drop a named person.\n- extras: unnamed/generic background people only (a crowd, "a few guests", "kids playing football") — never someone the script gives an actual name to; leave empty if none.\n- property: objects handled or referenced in that scene, preferring the established property list when relevant; leave empty if none.\n- costumeRemarks: a costume-specific note for that scene if the costume notes above say anything relevant; leave empty if nothing applies.\nReturn exactly ${batchEntries.length} rows in the same order as these scenes — do not skip, merge, or add extra rows.`;

  const response = await generateContentWithRetry({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: SCRIPT_BREAKDOWN_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      responseSchema: {
        type: Type.OBJECT,
        properties: { rows: { type: Type.ARRAY, items: AD_SHEET_ROW_SCHEMA } },
        required: ["rows"],
      },
    },
  });

  const rows = sanitizeBilingualContent(JSON.parse(response.text)).rows ?? [];
  const blankRow = { mainCharacters: [], extras: { en: "", or: "" }, property: { en: "", or: "" }, costumeRemarks: { en: "", or: "" } };
  // Defensive padding/truncation — the row COUNT must match the real scene
  // count no matter what the model returns, since every downstream row is
  // positionally joined back to its deterministic scene entry.
  return batchEntries.map((_, i) => rows[i] ?? blankRow);
}

async function generateAdSheetDetails(sceneEntries, breakdownContent, sourceText) {
  const batches = [];
  for (let i = 0; i < sceneEntries.length; i += AD_SHEET_BATCH_SIZE) {
    batches.push({ start: i, entries: sceneEntries.slice(i, i + AD_SHEET_BATCH_SIZE) });
  }

  const batchResults = await mapWithConcurrency(batches, 3, (batch) =>
    generateAdSheetDetailsForBatch(batch.entries, batch.start, breakdownContent, sourceText)
  );

  return batchResults.flat();
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

// Lets a production_manager add a character the AI analysis missed,
// without granting them the full admin-only "Edit" power over
// AI-analyzed content — same INSERT-only revision pattern as every other
// breakdown change, just scoped to appending one cast-list entry.
app.post("/api/script-breakdown/:id/add-character", requireRole("admin", "production_manager"), async (req, res) => {
  const { label } = req.body;

  if (!label || !label.trim()) {
    res.status(400).json({ error: "Character name is required." });
    return;
  }

  const existing = await db.query("SELECT scene_list_id FROM script_breakdowns WHERE id = $1", [req.params.id]);
  if (existing.rows.length === 0) {
    res.status(404).json({ error: "Script breakdown not found" });
    return;
  }

  const sceneListId = existing.rows[0].scene_list_id;
  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const latest = await db.query(
    "SELECT id, content, status FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
    [sceneListId]
  );
  if (String(latest.rows[0].id) !== String(req.params.id)) {
    res.status(409).json({ error: "Someone else updated this breakdown since you loaded it. Reload the page and try again." });
    return;
  }

  const trimmedLabel = label.trim();
  const currentArtistList = latest.rows[0].content.artistList ?? [];
  if (currentArtistList.some((item) => item.label === trimmedLabel)) {
    res.status(400).json({ error: "A character with that name already exists in the cast list." });
    return;
  }

  const updatedContent = {
    ...latest.rows[0].content,
    artistList: [...currentArtistList, { label: trimmedLabel, notes: { en: "", or: "" }, age: "Unspecified", gender: "Unspecified" }],
  };

  // A routine roster addition shouldn't silently un-approve an
  // already-approved breakdown (and hide the Shoot Schedule with it) —
  // carries the previous status forward.
  const insertResult = await db.query(
    "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
    [sceneListId, JSON.stringify(updatedContent), latest.rows[0].status, `Added missing character: ${trimmedLabel}`]
  );

  res.json({ ...insertResult.rows[0], sceneListId, ...updatedContent });
});

// A thorough AI re-scan for characters the script analysis missed —
// admin-only, matching Re-analyze/Edit, since (unlike the manual
// add-character box above) it's genuinely re-reading and reasoning about
// the whole script rather than just appending a typed name. Additive
// only: existing entries are never touched, reordered, or regenerated.
app.post("/api/script-breakdown/:id/find-missing-characters", requireRole("admin"), async (req, res) => {
  const existing = await db.query("SELECT scene_list_id FROM script_breakdowns WHERE id = $1", [req.params.id]);
  if (existing.rows.length === 0) {
    res.status(404).json({ error: "Script breakdown not found" });
    return;
  }

  const sceneListId = existing.rows[0].scene_list_id;
  const latest = await db.query(
    "SELECT id, content, status FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
    [sceneListId]
  );
  if (String(latest.rows[0].id) !== String(req.params.id)) {
    res.status(409).json({ error: "Someone else updated this breakdown since you loaded it. Reload the page and try again." });
    return;
  }

  try {
    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const sourceText = await buildBreakdownSourceText(sceneListResult.rows[0].content, sceneListId);
    const existingArtistList = latest.rows[0].content.artistList ?? [];

    const missingCharacters = await findMissingCharacters(sourceText, existingArtistList);

    if (missingCharacters.length === 0) {
      res.json({ id: latest.rows[0].id, sceneListId, ...latest.rows[0].content, addedCharacters: [] });
      return;
    }

    const updatedContent = { ...latest.rows[0].content, artistList: [...existingArtistList, ...missingCharacters] };

    // Additive-only scan shouldn't silently un-approve an already-approved
    // breakdown (and hide the Shoot Schedule with it) — carries the
    // previous status forward.
    const insertResult = await db.query(
      "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(updatedContent), latest.rows[0].status, `Found missing characters: ${missingCharacters.map((c) => c.label).join(", ")}`]
    );

    res.json({ ...insertResult.rows[0], sceneListId, ...updatedContent, addedCharacters: missingCharacters.map((c) => c.label) });
  } catch (error) {
    console.error("Find missing characters failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// Sorts the existing cast list into three production-relevant groups —
// speaking/lead, present-but-silent (action only), and off-screen
// voice/phone-only (never needs a call sheet slot on this set) — without
// adding, removing, or renaming anyone. Same permission level as
// add-character: a production tool, not a re-analysis of the AI's own
// breakdown output.
app.post("/api/script-breakdown/:id/classify-cast-categories", requireRole("admin", "production_manager"), async (req, res) => {
  const existing = await db.query("SELECT scene_list_id FROM script_breakdowns WHERE id = $1", [req.params.id]);
  if (existing.rows.length === 0) {
    res.status(404).json({ error: "Script breakdown not found" });
    return;
  }

  const sceneListId = existing.rows[0].scene_list_id;
  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const latest = await db.query(
    "SELECT id, content, status FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
    [sceneListId]
  );
  if (String(latest.rows[0].id) !== String(req.params.id)) {
    res.status(409).json({ error: "Someone else updated this breakdown since you loaded it. Reload the page and try again." });
    return;
  }

  try {
    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const sourceText = await buildBreakdownSourceText(sceneListResult.rows[0].content, sceneListId);
    const existingArtistList = latest.rows[0].content.artistList ?? [];

    const classifiedArtistList = await classifyCastCategories(sourceText, existingArtistList);
    const updatedContent = { ...latest.rows[0].content, artistList: classifiedArtistList };

    // Pure enrichment (tags existing characters, doesn't change reviewable
    // content) — carries the previous approval status forward instead of
    // silently reverting an already-approved breakdown back to pending,
    // which would hide the Shoot Schedule (it only shows once the
    // breakdown is approved).
    const insertResult = await db.query(
      "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(updatedContent), latest.rows[0].status, "Classified cast into speaking / action-only / off-screen categories"]
    );

    res.json({ ...insertResult.rows[0], sceneListId, ...updatedContent });
  } catch (error) {
    console.error("Classify cast categories failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// How many physical costume sets the wardrobe department should actually
// prepare for each character — not just what they wear, but HOW MANY of
// each look, inferred from how many scenes they're in and what kind of
// scenes those are (office, home/night, casual outings, etc.). categories
// are named per-character by the model (a doctor gets "hospital uniform",
// not a forced generic label) rather than drawn from a fixed list. A day
// player in one or two scenes should come back as a single set, quantity
// 1 — this only gets elaborate for characters who are actually in enough
// varied scenes to need it.
const COSTUME_RECOMMENDATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    recommendations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          character: { type: Type.STRING },
          totalScenes: { type: Type.INTEGER },
          sets: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                category: { type: Type.STRING },
                quantity: { type: Type.INTEGER },
                reason: BILINGUAL_TEXT_SCHEMA,
              },
              required: ["category", "quantity", "reason"],
            },
          },
        },
        required: ["character", "totalScenes", "sets"],
      },
    },
  },
  required: ["recommendations"],
};

// Same "don't trust one giant pass" lesson as AD_SHEET_BATCH_SIZE — a cast
// of 30+ characters, each needing several reasoned sets, comfortably blows
// past a single call's output budget and comes back as truncated/invalid
// JSON. Small batches keep each response well within budget and reliable.
const COSTUME_RECOMMENDATION_BATCH_SIZE = 8;

async function generateCostumeRecommendationsForBatch(characterBriefs) {
  const prompt = `You are a costume department head planning how many physical costume sets to prepare for each character in this production, based on how many scenes they're in and what kind of scenes those are (office, home/night, outdoor/casual, festive, etc.).\n\nCRITICAL — ground every recommendation strictly in the actual scene list given below for each character. Read through their specific scenes (location, time of day, one-liner) before deciding on categories — do not guess generic categories that aren't actually supported by what happens in their listed scenes, and do not copy a pattern from one character onto another. If a character's scene list says "(no AD sheet scenes found for this character)", don't invent scene context — just recommend a single minimal set and say so plainly in the reason. Each "reason" must cite something concrete from that character's own scene list (an approximate count of matching scenes, a location, or a time-of-day pattern you actually observed) — a vague reason with no reference to their real scenes is not acceptable.\n\nFor EACH character below, infer the distinct costume categories they'd realistically need from the scenes they actually appear in — name each category in plain terms that genuinely fit THIS character (e.g. "Hospital Uniform" for a doctor, "School Uniform" for a student) rather than forcing a generic fixed list — and recommend a realistic QUANTITY of each. Continuity means the same physical outfit is usually reused across scenes set at the same "look", but production still needs spares of frequently-worn categories for laundry, damage, or reshoots, so quantity should reflect that, not just "1 per look". A character in very few scenes (a day player, a one-scene role) should get a single set, quantity 1, with a short reason — don't invent an elaborate breakdown for them. A lead appearing across dozens of varied scenes should get a fuller breakdown across several categories. Write each "reason" as a short bilingual note (English, and Odia if you can — leave "or" empty if not confident) explaining the recommendation, e.g. "Worn across 18 office scenes — 2 sets recommended for continuity while one is being laundered."\n\nCharacters:\n\n${characterBriefs.join("\n\n")}`;

  const response = await generateContentWithRetry({
    model: "gemini-flash-lite-latest",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      responseSchema: COSTUME_RECOMMENDATION_SCHEMA,
    },
  });

  return JSON.parse(response.text).recommendations ?? [];
}

function buildCostumeBrief(artist, adSheet, flatScenes, costumeByCharacter) {
  const sceneLines = [];
  adSheet.forEach((row, i) => {
    if (!row.mainCharacters?.some((c) => c.toLowerCase() === artist.label.toLowerCase())) return;
    const scene = flatScenes[i];
    if (!scene) return;
    sceneLines.push(
      `${scene.episodeLabel ? `${scene.episodeLabel}, ` : ""}Scene ${scene.sceneNumber}: ${scene.intExt}. ${scene.location?.en ?? ""} — ${scene.timeOfDay ?? ""}. ${scene.oneLiner?.en ?? ""}`
    );
  });
  const costume = costumeByCharacter.get(artist.label.toLowerCase());
  return `${artist.label} (${artist.gender || "Unspecified"}, ${artist.age || "Unspecified"}) — appears in ${sceneLines.length} scene(s).\nInvolvement: ${artist.notes?.en ?? ""}\nExisting costume note: ${costume?.description?.en ?? "(none yet)"}\nScenes:\n${sceneLines.join("\n") || "(no AD sheet scenes found for this character)"}`;
}

async function generateCostumeRecommendations(scriptBreakdown, sceneList) {
  const flatScenes = flattenScenesForAdSheet(sceneList);
  const adSheet = scriptBreakdown.adSheet ?? [];
  const costumeByCharacter = new Map((scriptBreakdown.costumes ?? []).map((c) => [c.character.toLowerCase(), c]));

  const characterBriefs = (scriptBreakdown.artistList ?? []).map((artist) =>
    buildCostumeBrief(artist, adSheet, flatScenes, costumeByCharacter)
  );

  const batches = [];
  for (let i = 0; i < characterBriefs.length; i += COSTUME_RECOMMENDATION_BATCH_SIZE) {
    batches.push(characterBriefs.slice(i, i + COSTUME_RECOMMENDATION_BATCH_SIZE));
  }

  const results = await mapWithConcurrency(batches, 3, generateCostumeRecommendationsForBatch);
  return results.flat();
}

// The per-character version behind each costume entry's own "Recommend"
// trigger — cheap and fast since it's a single character, so the AD can
// pull one up on demand without waiting for (or re-triggering) the whole
// cast's recommendations to regenerate.
async function generateCostumeRecommendationForCharacter(scriptBreakdown, sceneList, characterLabel) {
  const artist = (scriptBreakdown.artistList ?? []).find((a) => a.label.toLowerCase() === characterLabel.toLowerCase());
  if (!artist) return null;

  const flatScenes = flattenScenesForAdSheet(sceneList);
  const adSheet = scriptBreakdown.adSheet ?? [];
  const costumeByCharacter = new Map((scriptBreakdown.costumes ?? []).map((c) => [c.character.toLowerCase(), c]));
  const brief = buildCostumeBrief(artist, adSheet, flatScenes, costumeByCharacter);

  const results = await generateCostumeRecommendationsForBatch([brief]);
  return results[0] ?? null;
}

app.post("/api/script-breakdown/:id/generate-costume-recommendations", requireRole("admin", "production_manager"), async (req, res) => {
  const existing = await db.query("SELECT scene_list_id FROM script_breakdowns WHERE id = $1", [req.params.id]);
  if (existing.rows.length === 0) {
    res.status(404).json({ error: "Script breakdown not found" });
    return;
  }

  const sceneListId = existing.rows[0].scene_list_id;
  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const latest = await db.query(
    "SELECT id, content, status FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
    [sceneListId]
  );
  if (String(latest.rows[0].id) !== String(req.params.id)) {
    res.status(409).json({ error: "Someone else updated this breakdown since you loaded it. Reload the page and try again." });
    return;
  }
  if (!Array.isArray(latest.rows[0].content.adSheet) || latest.rows[0].content.adSheet.length === 0) {
    res.status(400).json({ error: "Generate the AD Scene Breakdown Sheet first — costume recommendations need it to know which scenes each character is in." });
    return;
  }

  try {
    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const recommendations = await generateCostumeRecommendations(latest.rows[0].content, sceneListResult.rows[0].content);
    const updatedContent = { ...latest.rows[0].content, costumeRecommendations: recommendations };

    // Pure enrichment — carries the previous approval status forward (see
    // the same note on classify-cast-categories above).
    const insertResult = await db.query(
      "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(updatedContent), latest.rows[0].status, "Generated costume quantity recommendations"]
    );

    res.json({ ...insertResult.rows[0], sceneListId, ...updatedContent });
  } catch (error) {
    console.error("Costume recommendation generation failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// Same as above but scoped to one character — this is what each costume
// entry's own inline "Recommend" trigger calls, so pulling up one
// character's recommendation doesn't wait on (or re-run) the whole cast's.
app.post(
  "/api/script-breakdown/:id/generate-costume-recommendation",
  requireRole("admin", "production_manager"),
  async (req, res) => {
    const { character } = req.body;
    if (!character?.trim()) {
      res.status(400).json({ error: "A character name is required." });
      return;
    }

    const existing = await db.query("SELECT scene_list_id FROM script_breakdowns WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Script breakdown not found" });
      return;
    }

    const sceneListId = existing.rows[0].scene_list_id;
    if (!(await userOwnsSceneList(req.user, sceneListId))) {
      res.status(403).json({ error: "You don't have access to this project." });
      return;
    }

    const latest = await db.query(
      "SELECT id, content, status FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    if (String(latest.rows[0].id) !== String(req.params.id)) {
      res.status(409).json({ error: "Someone else updated this breakdown since you loaded it. Reload the page and try again." });
      return;
    }
    if (!Array.isArray(latest.rows[0].content.adSheet) || latest.rows[0].content.adSheet.length === 0) {
      res.status(400).json({ error: "Generate the AD Scene Breakdown Sheet first — costume recommendations need it to know which scenes this character is in." });
      return;
    }

    try {
      const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
      const recommendation = await generateCostumeRecommendationForCharacter(
        latest.rows[0].content,
        sceneListResult.rows[0].content,
        character.trim()
      );
      if (!recommendation) {
        res.status(404).json({ error: "That character wasn't found in the Artist List." });
        return;
      }

      const existingRecommendations = latest.rows[0].content.costumeRecommendations ?? [];
      const updatedRecommendations = [
        ...existingRecommendations.filter((rec) => rec.character.toLowerCase() !== character.trim().toLowerCase()),
        // Every freshly generated recommendation starts unapproved — the AD
        // reviews it (optionally adding a set by hand) and explicitly
        // approves it to lock it in.
        { ...recommendation, approved: false },
      ];
      const updatedContent = { ...latest.rows[0].content, costumeRecommendations: updatedRecommendations };

      // Pure enrichment — carries the previous approval status forward
      // (see the same note on classify-cast-categories above).
      const insertResult = await db.query(
        "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
        [sceneListId, JSON.stringify(updatedContent), latest.rows[0].status, `Generated costume quantity recommendation for ${character.trim()}`]
      );

      res.json({ ...insertResult.rows[0], sceneListId, ...updatedContent });
    } catch (error) {
      console.error("Costume recommendation generation failed:", error.message);
      res.status(502).json({ error: error.message });
    }
  }
);

// Locks in a character's costume recommendation once the AD has reviewed
// it (and optionally added their own sets via the route below) — once
// approved, the UI stops offering to regenerate it, since regenerating an
// approved plan would silently throw away a human decision.
app.post(
  "/api/script-breakdown/:id/approve-costume-recommendation",
  requireRole("admin", "production_manager"),
  async (req, res) => {
    const { character } = req.body;
    if (!character?.trim()) {
      res.status(400).json({ error: "A character name is required." });
      return;
    }

    const existing = await db.query("SELECT scene_list_id FROM script_breakdowns WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Script breakdown not found" });
      return;
    }

    const sceneListId = existing.rows[0].scene_list_id;
    if (!(await userOwnsSceneList(req.user, sceneListId))) {
      res.status(403).json({ error: "You don't have access to this project." });
      return;
    }

    const latest = await db.query(
      "SELECT id, content, status FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    if (String(latest.rows[0].id) !== String(req.params.id)) {
      res.status(409).json({ error: "Someone else updated this breakdown since you loaded it. Reload the page and try again." });
      return;
    }

    const recommendations = latest.rows[0].content.costumeRecommendations ?? [];
    const index = recommendations.findIndex((rec) => rec.character.toLowerCase() === character.trim().toLowerCase());
    if (index === -1) {
      res.status(404).json({ error: "No costume recommendation exists yet for that character." });
      return;
    }

    const updatedRecommendations = recommendations.map((rec, i) => (i === index ? { ...rec, approved: true } : rec));
    const updatedContent = { ...latest.rows[0].content, costumeRecommendations: updatedRecommendations };

    const insertResult = await db.query(
      "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(updatedContent), latest.rows[0].status, `Approved costume recommendation for ${character.trim()}`]
    );

    res.json({ ...insertResult.rows[0], sceneListId, ...updatedContent });
  }
);

// Lets the AD hand-edit a character's costume set list directly — add a
// new category, remove one, or change a quantity — by sending back the
// COMPLETE resulting list (the frontend's edit UI starts from what's
// already recommended, so the AD is editing in place, not typing from
// scratch). Creates the character's recommendation entry if one doesn't
// exist yet (e.g. a character too minor to bother generating one for).
// Always left unapproved so an edit still goes through the same review
// step before being locked in again.
app.post(
  "/api/script-breakdown/:id/set-costume-recommendation-sets",
  requireRole("admin", "production_manager"),
  async (req, res) => {
    const { character, sets } = req.body;
    if (!character?.trim() || !Array.isArray(sets)) {
      res.status(400).json({ error: "A character and a list of sets are required." });
      return;
    }
    if (sets.some((s) => !s.category?.trim() || !Number.isFinite(Number(s.quantity)))) {
      res.status(400).json({ error: "Every set needs a category and a valid quantity." });
      return;
    }

    const existing = await db.query("SELECT scene_list_id FROM script_breakdowns WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Script breakdown not found" });
      return;
    }

    const sceneListId = existing.rows[0].scene_list_id;
    if (!(await userOwnsSceneList(req.user, sceneListId))) {
      res.status(403).json({ error: "You don't have access to this project." });
      return;
    }

    const latest = await db.query(
      "SELECT id, content, status FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    if (String(latest.rows[0].id) !== String(req.params.id)) {
      res.status(409).json({ error: "Someone else updated this breakdown since you loaded it. Reload the page and try again." });
      return;
    }

    const trimmedCharacter = character.trim();
    const cleanSets = sets.map((s) => ({
      category: s.category.trim(),
      quantity: Number(s.quantity),
      reason: { en: s.reasonEn?.trim() ?? s.reason?.en ?? "", or: s.reason?.or ?? "" },
    }));
    const recommendations = latest.rows[0].content.costumeRecommendations ?? [];
    const index = recommendations.findIndex((rec) => rec.character.toLowerCase() === trimmedCharacter.toLowerCase());

    const updatedRecommendations =
      index === -1
        ? [...recommendations, { character: trimmedCharacter, totalScenes: 0, sets: cleanSets, approved: false }]
        : recommendations.map((rec, i) => (i === index ? { ...rec, sets: cleanSets, approved: false } : rec));

    const updatedContent = { ...latest.rows[0].content, costumeRecommendations: updatedRecommendations };

    const insertResult = await db.query(
      "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(updatedContent), latest.rows[0].status, `Edited costume sets for ${trimmedCharacter}`]
    );

    res.json({ ...insertResult.rows[0], sceneListId, ...updatedContent });
  }
);

// The classic AD (Assistant Director) Scene Breakdown Sheet — one row per
// scene, handed to the whole crew as a single production reference.
// Generation is allowed for production_manager too (not admin-only like
// /edit and /reanalyze) since it derives a production document from
// already-approved data rather than re-touching the AI-analyzed breakdown
// itself — same permission shape as shoot-schedule generation.
app.post("/api/script-breakdown/:id/generate-ad-sheet", requireRole("admin", "production_manager"), async (req, res) => {
  const existing = await db.query("SELECT scene_list_id FROM script_breakdowns WHERE id = $1", [req.params.id]);
  if (existing.rows.length === 0) {
    res.status(404).json({ error: "Script breakdown not found" });
    return;
  }

  const sceneListId = existing.rows[0].scene_list_id;
  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const latest = await db.query(
    "SELECT id, content, status FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
    [sceneListId]
  );
  if (String(latest.rows[0].id) !== String(req.params.id)) {
    res.status(409).json({ error: "Someone else updated this breakdown since you loaded it. Reload the page and try again." });
    return;
  }

  try {
    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const sceneList = sceneListResult.rows[0].content;
    const sourceText = await buildBreakdownSourceText(sceneList, sceneListId);
    const sceneEntries = flattenScenesForAdSheet(sceneList);
    const aiDetails = await generateAdSheetDetails(sceneEntries, latest.rows[0].content, sourceText);

    const adSheet = sceneEntries.map((entry, i) => ({ ...entry, ...aiDetails[i] }));
    const updatedContent = { ...latest.rows[0].content, adSheet };

    // Pure enrichment (adds a derived document, normally run AFTER
    // approval as an operational step) — carries the previous approval
    // status forward instead of silently reverting to pending, which
    // would hide the Shoot Schedule (it only shows once approved).
    const insertResult = await db.query(
      "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(updatedContent), latest.rows[0].status, "Generated AD Scene Breakdown Sheet"]
    );

    res.json({ ...insertResult.rows[0], sceneListId, ...updatedContent });
  } catch (error) {
    console.error("AD sheet generation failed:", error.message);
    res.status(502).json({ error: error.message });
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

  // "propsAndArt" is a display-only pseudo-category — properties and art
  // department notes share the exact same {label, notes} shape, so they're
  // just concatenated into one combined document rather than being a real
  // stored category of their own (props/art stay independently editable
  // and reanalyzable on their own, unaffected by this).
  if (category !== "propsAndArt" && !BREAKDOWN_CATEGORY_KEYS.includes(category)) {
    res.status(400).json({ error: "Unknown breakdown category." });
    return;
  }

  try {
    // Same reasoning as the shoot-schedule export: script_breakdowns is
    // INSERT-only, so :id is only used to resolve which project this is —
    // the content exported is always re-fetched as the latest revision for
    // that project, never whatever specific id the frontend had in memory.
    const idLookup = await db.query("SELECT scene_list_id FROM script_breakdowns WHERE id = $1", [req.params.id]);
    if (idLookup.rows.length === 0) {
      res.status(404).json({ error: "Script breakdown not found" });
      return;
    }
    const result = await db.query(
      "SELECT content, scene_list_id FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [idLookup.rows[0].scene_list_id]
    );

    const breakdown = result.rows[0].content;
    const propsAndArtTag = { en: { prop: " (Property)", art: " (Art Note)" }, or: { prop: " (ପ୍ରପର୍ଟି)", art: " (ଆର୍ଟ ନୋଟ୍)" } };
    const items =
      category === "propsAndArt"
        ? [
            ...(breakdown.props ?? []).map((item) => ({ ...item, kind: "prop" })),
            ...(breakdown.art ?? []).map((item) => ({ ...item, kind: "art" })),
          ]
        : (breakdown[category] ?? []);
    const categoryLabels = {
      artistList: { en: "Artist List", or: "କଳାକାର ତାଲିକା" },
      locationList: { en: "Location List", or: "ସ୍ଥାନ ତାଲିକା" },
      props: { en: "Property List", or: "ପ୍ରପର୍ଟି ତାଲିକା" },
      costumes: { en: "Costume Breakdown", or: "ପୋଷାକ ବିବରଣୀ" },
      art: { en: "Art Department Notes", or: "ଆର୍ଟ ବିଭାଗ ନୋଟ୍" },
      propsAndArt: { en: "Properties & Art Department Notes", or: "ସାମଗ୍ରୀ ଓ କଳା ବିଭାଗ ମନ୍ତବ୍ୟ" },
    };
    const bodyFont = lang === "or" ? "odiaRegular" : "Helvetica";
    const headerFont = lang === "or" ? "odiaBold" : "Helvetica-Bold";

    // Real-world casting info lives in crew_members, not the AI-analyzed
    // breakdown content — join it in here so the exported list reflects
    // who's actually confirmed, not just who the script analysis found.
    let castByCharacter = new Map();
    if (category === "artistList") {
      const castResult = await db.query(
        "SELECT character_name, name, contact_number FROM crew_members WHERE scene_list_id = $1 AND category = 'artist'",
        [result.rows[0].scene_list_id]
      );
      castByCharacter = new Map(castResult.rows.map((row) => [row.character_name, row]));
    }
    const notCastLabel = lang === "or" ? "ଏପର୍ଯ୍ୟନ୍ତ କାଷ୍ଟ ହୋଇନାହିଁ — ଦୟାକରି ଅପଡେଟ୍ କରନ୍ତୁ" : "Not yet cast — please update";
    const recommendationsByCharacter = new Map(
      (breakdown.costumeRecommendations ?? []).map((rec) => [rec.character.toLowerCase(), rec])
    );

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.registerFont("odiaRegular", FONTS.odiaRegular);
    doc.registerFont("odiaBold", FONTS.odiaBold);
    doc.font(bodyFont);
    doc.font(headerFont);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${category}-${lang}-${formatExportTimestamp()}.pdf"`);
    doc.pipe(res);

    doc.font(headerFont).fontSize(22).text(categoryLabels[category][lang]);
    doc.moveDown(1);

    if (items.length === 0) {
      doc.font(bodyFont).fontSize(12).text(lang === "or" ? "କିଛି ମିଳିଲା ନାହିଁ।" : "Nothing found for this category.");
    }

    items.forEach((item) => {
      const label =
        category === "locationList"
          ? item.location[lang]
          : category === "costumes"
            ? item.character
            : item.label + (category === "propsAndArt" ? propsAndArtTag[lang][item.kind] : "");
      const noteField = category === "costumes" ? item.description : item.notes;
      doc.font(headerFont).fontSize(13).text(label, { continued: category === "locationList" });
      if (category === "locationList") {
        doc.font(bodyFont).fontSize(11).text(`  (${item.intExt} — ${item.sceneCount} scenes)`);
      }
      if (category === "artistList" && (item.age || item.gender)) {
        doc.font(bodyFont).fontSize(11).text(`  (${item.gender || "Unspecified"}, ${item.age || "Unspecified"})`);
      }
      doc.font(bodyFont).fontSize(11).text(noteField[lang], { indent: 10 });
      if (category === "artistList") {
        const cast = castByCharacter.get(item.label);
        const playedByLine = lang === "or"
          ? `କଳାକାର: ${cast ? cast.name : notCastLabel}${cast?.contact_number ? ` — ${cast.contact_number}` : ""}`
          : `Played by: ${cast ? cast.name : notCastLabel}${cast?.contact_number ? ` — ${cast.contact_number}` : ""}`;
        doc.font(bodyFont).fontSize(11).text(playedByLine, { indent: 10 });
      }
      if (category === "costumes") {
        const rec = recommendationsByCharacter.get(item.character.toLowerCase());
        if (rec) {
          const recommendedLabel = lang === "or" ? "ପ୍ରସ୍ତାବିତ ପରିମାଣ" : "Recommended quantities";
          doc.font(headerFont).fontSize(10).text(`${recommendedLabel} (${rec.totalScenes} ${lang === "or" ? "ଦୃଶ୍ୟ" : "scenes"}):`, { indent: 10 });
          rec.sets.forEach((set) => {
            const reasonText = set.reason?.[lang] ? ` — ${set.reason[lang]}` : "";
            doc.font(bodyFont).fontSize(10).text(`${set.quantity}× ${set.category}${reasonText}`, { indent: 20 });
          });
        }
      }
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

  if (category !== "propsAndArt" && !BREAKDOWN_CATEGORY_KEYS.includes(category)) {
    res.status(400).json({ error: "Unknown breakdown category." });
    return;
  }

  try {
    // Same latest-revision fix as the PDF export above — :id only resolves
    // which project this is, the content is always the current revision.
    const idLookup = await db.query("SELECT scene_list_id FROM script_breakdowns WHERE id = $1", [req.params.id]);
    if (idLookup.rows.length === 0) {
      res.status(404).json({ error: "Script breakdown not found" });
      return;
    }
    const result = await db.query(
      "SELECT content, scene_list_id FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [idLookup.rows[0].scene_list_id]
    );

    const propsAndArtTag = { en: { prop: " (Property)", art: " (Art Note)" }, or: { prop: " (ପ୍ରପର୍ଟି)", art: " (ଆର୍ଟ ନୋଟ୍)" } };
    const items =
      category === "propsAndArt"
        ? [
            ...(result.rows[0].content.props ?? []).map((item) => ({ ...item, kind: "prop" })),
            ...(result.rows[0].content.art ?? []).map((item) => ({ ...item, kind: "art" })),
          ]
        : (result.rows[0].content[category] ?? []);
    const categoryLabels = {
      artistList: { en: "Artist List", or: "କଳାକାର ତାଲିକା" },
      locationList: { en: "Location List", or: "ସ୍ଥାନ ତାଲିକା" },
      props: { en: "Property List", or: "ପ୍ରପର୍ଟି ତାଲିକା" },
      costumes: { en: "Costume Breakdown", or: "ପୋଷାକ ବିବରଣୀ" },
      art: { en: "Art Department Notes", or: "ଆର୍ଟ ବିଭାଗ ନୋଟ୍" },
      propsAndArt: { en: "Properties & Art Department Notes", or: "ସାମଗ୍ରୀ ଓ କଳା ବିଭାଗ ମନ୍ତବ୍ୟ" },
    };
    const statusLabels = lang === "or" ? ["ବାକି ଅଛି", "ହୋଇଗଲା"] : ["Pending", "Done"];
    const columnLabels =
      lang === "or"
        ? { name: "ନାମ", location: "ସ୍ଥାନ", intExt: "INT/EXT", sceneCount: "ଦୃଶ୍ୟ ସଂଖ୍ୟା", character: "ଚରିତ୍ର", notes: "ନୋଟ୍", status: "ସ୍ଥିତି", remarks: "ମନ୍ତବ୍ୟ", playedBy: "କଳାକାର", contactNumber: "ଯୋଗାଯୋଗ ନମ୍ବର", age: "ବୟସ", gender: "ଲିଙ୍ଗ", recommendedQuantities: "ପ୍ରସ୍ତାବିତ ପରିମାଣ" }
        : { name: "Name", location: "Location", intExt: "INT/EXT", sceneCount: "Scene Count", character: "Character", notes: "Notes", status: "Status", remarks: "Remarks", playedBy: "Played By", contactNumber: "Contact Number", age: "Age", gender: "Gender", recommendedQuantities: "Recommended Quantities" };
    const notCastLabel = lang === "or" ? "ଏପର୍ଯ୍ୟନ୍ତ କାଷ୍ଟ ହୋଇନାହିଁ — ଦୟାକରି ଅପଡେଟ୍ କରନ୍ତୁ" : "Not yet cast — please update";
    const recommendationsByCharacter = new Map(
      (result.rows[0].content.costumeRecommendations ?? []).map((rec) => [rec.character.toLowerCase(), rec])
    );

    // Real-world casting info lives in crew_members, not the AI-analyzed
    // breakdown content — join it in here so the exported sheet reflects
    // who's actually confirmed, not just who the script analysis found.
    let castByCharacter = new Map();
    if (category === "artistList") {
      const castResult = await db.query(
        "SELECT character_name, name, contact_number FROM crew_members WHERE scene_list_id = $1 AND category = 'artist'",
        [result.rows[0].scene_list_id]
      );
      castByCharacter = new Map(castResult.rows.map((row) => [row.character_name, row]));
    }

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
        { header: columnLabels.recommendedQuantities, key: "recommendedQuantities", width: 45 },
      ];
      rows = items.map((item) => {
        const rec = recommendationsByCharacter.get(item.character.toLowerCase());
        return {
          character: item.character,
          notes: item.description[lang],
          recommendedQuantities: rec ? rec.sets.map((set) => `${set.quantity}× ${set.category}`).join("; ") : "",
        };
      });
    } else if (category === "artistList") {
      columns = [
        { header: columnLabels.name, key: "name", width: 22 },
        { header: columnLabels.age, key: "age", width: 14 },
        { header: columnLabels.gender, key: "gender", width: 12 },
        { header: columnLabels.notes, key: "notes", width: 40 },
        { header: columnLabels.playedBy, key: "playedBy", width: 22 },
        { header: columnLabels.contactNumber, key: "contactNumber", width: 18 },
      ];
      rows = items.map((item) => {
        const cast = castByCharacter.get(item.label);
        return {
          name: item.label,
          age: item.age || "Unspecified",
          gender: item.gender || "Unspecified",
          notes: item.notes[lang],
          playedBy: cast ? cast.name : notCastLabel,
          contactNumber: cast ? cast.contact_number || "" : notCastLabel,
        };
      });
    } else {
      columns = [
        { header: columnLabels.name, key: "name", width: 22 },
        { header: columnLabels.notes, key: "notes", width: 55 },
      ];
      rows = items.map((item) => ({
        name: item.label + (category === "propsAndArt" ? propsAndArtTag[lang][item.kind] : ""),
        notes: item.notes[lang],
      }));
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
    res.setHeader("Content-Disposition", `attachment; filename="${category}-${lang}-${formatExportTimestamp()}.xlsx"`);
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

// One row per scene, landscape grid — the classic paper "AD Scene
// Breakdown Sheet" every crew department gets a copy of, rendered as a
// real table rather than the flowing-text style used by the other
// category exports (this one has too many short columns for that to read
// well on paper).
app.get("/api/script-breakdown/:id/export-ad-sheet", requireLogin, async (req, res) => {
  const lang = req.query.lang === "or" ? "or" : "en";

  try {
    const result = await db.query("SELECT content, scene_list_id FROM script_breakdowns WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Script breakdown not found" });
      return;
    }

    const adSheet = result.rows[0].content.adSheet;
    if (!adSheet || adSheet.length === 0) {
      res.status(400).json({ error: "Generate the AD Scene Breakdown Sheet first." });
      return;
    }

    const sceneListId = result.rows[0].scene_list_id;
    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const title = await fetchProjectTitleForSceneList(sceneListId, sceneListResult.rows[0].content, lang);

    const bodyFont = lang === "or" ? "odiaRegular" : "Helvetica";
    const headerFont = lang === "or" ? "odiaBold" : "Helvetica-Bold";
    const labels =
      lang === "or"
        ? { title: "ସ୍କ୍ରିପ୍ଟ ବ୍ରେକଡାଉନ୍ ସିଟ୍", scn: "SCN", description: "ଦୃଶ୍ୟ ବର୍ଣ୍ଣନା", type: "TYPE", dn: "D/N", location: "ମୁଖ୍ୟ ସ୍ଥାନ", characters: "ମୁଖ୍ୟ ଚରିତ୍ର", extras: "ଏକ୍ସଟ୍ରା", property: "ପ୍ରପର୍ଟି", costume: "ପୋଷାକ/ମନ୍ତବ୍ୟ" }
        : { title: "SCRIPT BREAKDOWN SHEET", scn: "SCN", description: "SCENE DESCRIPTION", type: "TYPE", dn: "D/N", location: "PRIMARY LOCATION", characters: "MAIN CHARACTERS", extras: "EXTRAS", property: "PROPERTY", costume: "COSTUME / REMARKS" };

    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 24 });
    doc.registerFont("odiaRegular", FONTS.odiaRegular);
    doc.registerFont("odiaBold", FONTS.odiaBold);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="ad-breakdown-sheet-${lang}-${formatExportTimestamp()}.pdf"`);
    doc.pipe(res);

    const pageLeft = doc.page.margins.left;
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    const columns = [
      { key: "scn", label: labels.scn, width: 50 },
      { key: "description", label: labels.description, width: 150 },
      { key: "type", label: labels.type, width: 32 },
      { key: "dn", label: labels.dn, width: 34 },
      { key: "location", label: labels.location, width: 95 },
      { key: "characters", label: labels.characters, width: 115 },
      { key: "extras", label: labels.extras, width: 80 },
      { key: "property", label: labels.property, width: 95 },
      { key: "costume", label: labels.costume, width: 95 },
    ];
    const cellPaddingX = 4;
    const cellPaddingY = 4;

    function drawHeaderRow(y) {
      doc.font(headerFont).fontSize(9);
      const rowHeight = Math.max(
        22,
        ...columns.map((col) => doc.heightOfString(col.label, { width: col.width - cellPaddingX * 2 }) + cellPaddingY * 2)
      );
      let x = pageLeft;
      columns.forEach((col) => {
        doc.rect(x, y, col.width, rowHeight).fill("#000");
        doc.fillColor("#fff").font(headerFont).fontSize(9).text(col.label, x + cellPaddingX, y + cellPaddingY, { width: col.width - cellPaddingX * 2 });
        x += col.width;
      });
      doc.fillColor("#000");
      return y + rowHeight;
    }

    function rowValues(row) {
      return {
        scn: row.episodeLabel ? `${row.episodeLabel}\n${row.sceneNumber}` : row.sceneNumber,
        description: row.oneLiner?.[lang] ?? "",
        type: row.intExt,
        dn: row.timeOfDay,
        location: row.location?.[lang] ?? "",
        characters: (row.mainCharacters ?? []).join(", "),
        extras: row.extras?.[lang] ?? "",
        property: row.property?.[lang] ?? "",
        costume: row.costumeRemarks?.[lang] ?? "",
      };
    }

    doc.font(headerFont).fontSize(16).text(title ? `${title} — ${labels.title}` : labels.title, pageLeft, doc.y);
    doc.moveDown(0.6);
    let y = doc.y;
    y = drawHeaderRow(y);

    adSheet.forEach((row) => {
      const values = rowValues(row);
      doc.font(bodyFont).fontSize(9);
      const rowHeight = Math.max(
        18,
        ...columns.map((col) => doc.heightOfString(String(values[col.key] ?? ""), { width: col.width - cellPaddingX * 2 }) + cellPaddingY * 2)
      );

      if (y + rowHeight > pageBottom) {
        doc.addPage({ size: "A4", layout: "landscape", margin: 24 });
        y = doc.page.margins.top;
        y = drawHeaderRow(y);
      }

      let x = pageLeft;
      columns.forEach((col) => {
        doc.rect(x, y, col.width, rowHeight).stroke("#cccccc");
        doc.font(bodyFont).fontSize(9).text(String(values[col.key] ?? ""), x + cellPaddingX, y + cellPaddingY, { width: col.width - cellPaddingX * 2 });
        x += col.width;
      });
      y += rowHeight;
    });

    doc.end();
  } catch (error) {
    console.error("AD sheet PDF export failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
});

// Same grid as the PDF version above (one row per scene), transcribed
// straight into an Excel sheet since the data's already rectangular.
app.get("/api/script-breakdown/:id/export-ad-sheet-excel", requireLogin, async (req, res) => {
  const lang = req.query.lang === "or" ? "or" : "en";

  try {
    const result = await db.query("SELECT content, scene_list_id FROM script_breakdowns WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Script breakdown not found" });
      return;
    }

    const adSheet = result.rows[0].content.adSheet;
    if (!adSheet || adSheet.length === 0) {
      res.status(400).json({ error: "Generate the AD Scene Breakdown Sheet first." });
      return;
    }

    const labels =
      lang === "or"
        ? { title: "ସ୍କ୍ରିପ୍ଟ ବ୍ରେକଡାଉନ୍ ସିଟ୍", scn: "SCN", description: "ଦୃଶ୍ୟ ବର୍ଣ୍ଣନା", type: "TYPE", dn: "D/N", location: "ମୁଖ୍ୟ ସ୍ଥାନ", characters: "ମୁଖ୍ୟ ଚରିତ୍ର", extras: "ଏକ୍ସଟ୍ରା", property: "ପ୍ରପର୍ଟି", costume: "ପୋଷାକ/ମନ୍ତବ୍ୟ" }
        : { title: "SCRIPT BREAKDOWN SHEET", scn: "SCN", description: "SCENE DESCRIPTION", type: "TYPE", dn: "D/N", location: "PRIMARY LOCATION", characters: "MAIN CHARACTERS", extras: "EXTRAS", property: "PROPERTY", costume: "COSTUME / REMARKS" };

    function rowValues(row) {
      return {
        scn: row.episodeLabel ? `${row.episodeLabel} ${row.sceneNumber}` : row.sceneNumber,
        description: row.oneLiner?.[lang] ?? "",
        type: row.intExt,
        dn: row.timeOfDay,
        location: row.location?.[lang] ?? "",
        characters: (row.mainCharacters ?? []).join(", "),
        extras: row.extras?.[lang] ?? "",
        property: row.property?.[lang] ?? "",
        costume: row.costumeRemarks?.[lang] ?? "",
      };
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(labels.title.slice(0, 31));
    sheet.columns = [
      { header: labels.scn, key: "scn", width: 14 },
      { header: labels.description, key: "description", width: 45 },
      { header: labels.type, key: "type", width: 10 },
      { header: labels.dn, key: "dn", width: 8 },
      { header: labels.location, key: "location", width: 28 },
      { header: labels.characters, key: "characters", width: 32 },
      { header: labels.extras, key: "extras", width: 24 },
      { header: labels.property, key: "property", width: 28 },
      { header: labels.costume, key: "costume", width: 28 },
    ];
    sheet.getRow(1).font = { bold: true };
    adSheet.forEach((row) => sheet.addRow(rowValues(row)));

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="ad-breakdown-sheet-${lang}-${formatExportTimestamp()}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("AD sheet Excel export failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
});

// One focused call per episode/chunk (never the whole script in one pass) —
// the same "a single long pass misses things and conflates similar minor
// characters" lesson as the AD sheet and missing-character scan. Matching
// the target character name EXACTLY is called out explicitly because a
// single loose pass over a script with several same-age/same-role minor
// characters (e.g. multiple unnamed or similarly-described kids) has been
// observed to misattribute another character's dialogue to the wrong one.
async function generateCharacterScriptForChunk(chunkText, characterLabel) {
  const contents = `The script material (one part of the full script):\n${chunkText}\n\nYou are building a MASTER SCRIPT PACKET for the actor playing "${characterLabel}" — find EVERY scene in this material where "${characterLabel}" has any screen presence at all (speaking, or silently doing something), in the order the scenes occur here. Do not skip any scene they appear in, however brief, and do not include scenes where they are absent entirely.\n\nMatch the name EXACTLY: "${characterLabel}" only. Scripts often have several similar minor characters (e.g. more than one unnamed or similarly-described child, or two characters with close roles) — never attribute another character's dialogue or presence to "${characterLabel}" just because they seem similar. If you are genuinely unsure whether a specific line or scene belongs to this exact character, leave it out rather than guessing.\n\nFor each scene "${characterLabel}" is actually in: give its real scene heading (e.g. "INT. LIVING ROOM - DAY") and its real number/label exactly as written in the script (e.g. "Scene 4", "12A") — copy it verbatim, never invent or renumber it. If "${characterLabel}" has ANY dialogue in that scene, set hasDialogue true, leave actionDescription empty, and extract the COMPLETE dialogue exchange for that scene VERBATIM exactly as written — every line, from every character who speaks in it (the actor needs their cues too) — copied word for word, never paraphrased, summarized, translated, or invented, marking "isTargetCharacter": true only on "${characterLabel}"'s own lines. If "${characterLabel}" has NO dialogue in that scene but is present or doing something, set hasDialogue false, leave lines empty, and instead write a factual one-to-two-sentence actionDescription (in English) of what they actually do in that scene, grounded strictly in the script's own action lines — never invented.`;

  const response = await generateContentWithRetry({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: SCRIPT_BREAKDOWN_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      responseSchema: CHARACTER_SCRIPT_CHUNK_SCHEMA,
    },
  });

  return JSON.parse(response.text).scenes ?? [];
}

// Splits on "EPISODE N" boundaries when the source has them (same splitter
// used at import time and by the AD sheet / missing-character scan) so a
// long multi-episode script gets one focused scan per episode instead of
// one pass over everything — and the episode label attached to each scene
// comes from OUR OWN loop position, never the model, since episode numbering
// is deterministic and must never be left to the AI to guess or renumber.
async function generateCharacterScript(sourceText, characterLabel) {
  const chunks = splitScreenplayIntoEpisodes(sourceText);
  const isSeries = chunks.length > 1;

  const perChunkScenes = await mapWithConcurrency(chunks, 3, async (chunk) => {
    const scenes = await generateCharacterScriptForChunk(chunk.text, characterLabel);
    return scenes.map((scene) => ({
      ...scene,
      episodeLabel: isSeries ? `Episode ${chunk.episodeNumber}` : null,
    }));
  });

  return perChunkScenes.flat();
}

app.get("/api/scene-lists/:sceneListId/character-script", requireLogin, async (req, res) => {
  const { sceneListId } = req.params;
  const characterLabel = req.query.character;

  if (!characterLabel?.trim()) {
    res.status(400).json({ error: "A character name is required." });
    return;
  }
  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  try {
    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    if (sceneListResult.rows.length === 0) {
      res.status(404).json({ error: "Scene list not found" });
      return;
    }

    const sourceText = await buildBreakdownSourceText(sceneListResult.rows[0].content, sceneListId);
    const scenes = await generateCharacterScript(sourceText, characterLabel.trim());
    res.json({ scenes });
  } catch (error) {
    console.error("Character script generation failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// Shared by both the logged-in export route and the public (token-gated)
// route an artist opens from a WhatsApp link — the PDF itself is identical
// either way, only how the caller is allowed to reach it differs.
function renderCharacterScriptPdf(res, characterLabel, lang, scenes) {
  const bodyFont = lang === "or" ? "odiaRegular" : "Helvetica";
  const headerFont = lang === "or" ? "odiaBold" : "Helvetica-Bold";
  const labels =
    lang === "or" ? { title: "CHARACTER SCRIPT", action: "କାର୍ଯ୍ୟ" } : { title: "CHARACTER SCRIPT", action: "Action" };

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  doc.registerFont("odiaRegular", FONTS.odiaRegular);
  doc.registerFont("odiaBold", FONTS.odiaBold);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="character-script-${characterLabel.trim().replace(/\s+/g, "-")}-${formatExportTimestamp()}.pdf"`
  );
  doc.pipe(res);

  doc.font(headerFont).fontSize(20).text(`${labels.title} — ${characterLabel.trim()}`);
  doc.moveDown(1);

  if (scenes.length === 0) {
    doc.font(bodyFont).fontSize(12).text("No scenes were found for this character.");
  }

  scenes.forEach((scene, index) => {
    if (index > 0) doc.moveDown(1);
    const sceneLabel = scene.episodeLabel ? `${scene.episodeLabel}, ${scene.sceneNumberLabel}` : scene.sceneNumberLabel;
    doc.font(bodyFont).fontSize(12).fillColor("#555").text(`${sceneLabel} — ${scene.sceneHeading}`).fillColor("#000");
    doc.moveDown(0.4);

    if (scene.hasDialogue) {
      scene.lines.forEach((line) => {
        if (line.isTargetCharacter) {
          doc.font(headerFont).fontSize(12).fillColor("#000").text(line.character.toUpperCase());
          doc.font(headerFont).fontSize(12).fillColor("#000").text(line.text, { indent: 20 });
        } else {
          doc.font(bodyFont).fontSize(11).fillColor("#777").text(line.character.toUpperCase());
          doc.font(bodyFont).fontSize(11).fillColor("#777").text(line.text, { indent: 20 });
        }
        doc.fillColor("#000");
        doc.moveDown(0.6);
      });
    } else {
      doc.font(bodyFont).fontSize(11).fillColor("#555").text(`${labels.action}: ${scene.actionDescription}`).fillColor("#000");
    }
  });

  doc.end();
}

app.get("/api/scene-lists/:sceneListId/character-script/export", requireLogin, async (req, res) => {
  const { sceneListId } = req.params;
  const characterLabel = req.query.character;
  const lang = req.query.lang === "or" ? "or" : "en";

  if (!characterLabel?.trim()) {
    res.status(400).json({ error: "A character name is required." });
    return;
  }
  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  try {
    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    if (sceneListResult.rows.length === 0) {
      res.status(404).json({ error: "Scene list not found" });
      return;
    }

    const sourceText = await buildBreakdownSourceText(sceneListResult.rows[0].content, sceneListId);
    const scenes = await generateCharacterScript(sourceText, characterLabel.trim());
    renderCharacterScriptPdf(res, characterLabel.trim(), lang, scenes);
  } catch (error) {
    console.error("Character script PDF export failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
});

// A narrative script packet doesn't map to a grid, so the Excel version is
// a one-row-per-scene log instead of a transcript — scene heading, whether
// this character has dialogue in it, and the dialogue/action content
// flattened into a single cell (a reader who wants the full script layout
// still has the PDF right next to this).
async function renderCharacterScriptExcel(res, characterLabel, lang, scenes) {
  const labels =
    lang === "or"
      ? { scene: "ଦୃଶ୍ୟ", heading: "ଦୃଶ୍ୟ ଶୀର୍ଷକ", hasDialogue: "ସଂଳାପ ଅଛି?", content: "ବିଷୟବସ୍ତୁ", yes: "ହଁ", no: "ନାହିଁ" }
      : { scene: "Scene", heading: "Scene Heading", hasDialogue: "Has Dialogue?", content: "Content", yes: "Yes", no: "No" };

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet((lang === "or" ? "ଚରିତ୍ର ସ୍କ୍ରିପ୍ଟ" : "Character Script").slice(0, 31));
  sheet.columns = [
    { header: labels.scene, key: "scene", width: 16 },
    { header: labels.heading, key: "heading", width: 34 },
    { header: labels.hasDialogue, key: "hasDialogue", width: 14 },
    { header: labels.content, key: "content", width: 80 },
  ];
  sheet.getRow(1).font = { bold: true };

  scenes.forEach((scene) => {
    const sceneLabel = scene.episodeLabel ? `${scene.episodeLabel}, ${scene.sceneNumberLabel}` : scene.sceneNumberLabel;
    const content = scene.hasDialogue
      ? scene.lines.map((line) => `${line.character.toUpperCase()}: ${line.text}`).join("\n")
      : scene.actionDescription;
    const addedRow = sheet.addRow({
      scene: sceneLabel,
      heading: scene.sceneHeading,
      hasDialogue: scene.hasDialogue ? labels.yes : labels.no,
      content,
    });
    addedRow.getCell("content").alignment = { wrapText: true, vertical: "top" };
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="character-script-${characterLabel.trim().replace(/\s+/g, "-")}-${formatExportTimestamp()}.xlsx"`
  );
  await workbook.xlsx.write(res);
  res.end();
}

app.get("/api/scene-lists/:sceneListId/character-script/export-excel", requireLogin, async (req, res) => {
  const { sceneListId } = req.params;
  const characterLabel = req.query.character;
  const lang = req.query.lang === "or" ? "or" : "en";

  if (!characterLabel?.trim()) {
    res.status(400).json({ error: "A character name is required." });
    return;
  }
  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  try {
    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    if (sceneListResult.rows.length === 0) {
      res.status(404).json({ error: "Scene list not found" });
      return;
    }

    const sourceText = await buildBreakdownSourceText(sceneListResult.rows[0].content, sceneListId);
    const scenes = await generateCharacterScript(sourceText, characterLabel.trim());
    await renderCharacterScriptExcel(res, characterLabel.trim(), lang, scenes);
  } catch (error) {
    console.error("Character script Excel export failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
});

// Signs a (sceneListId, character) pair so an artist can open their own
// character-script PDF from a WhatsApp link without an app login — the
// token proves the link was minted by someone who actually had access to
// this project, without needing a database row or an expiry to manage.
// Never signs anything beyond "this one character's own scenes are OK to
// hand out", the same scope the AD/director already shares by hand today.
const PUBLIC_LINK_SECRET = process.env.PUBLIC_LINK_SECRET || "dev-only-insecure-secret-change-in-production";

function signPublicCharacterScriptLink(sceneListId, characterLabel) {
  return crypto
    .createHmac("sha256", PUBLIC_LINK_SECRET)
    .update(`${sceneListId}:${characterLabel.trim().toLowerCase()}`)
    .digest("hex");
}

function verifyPublicCharacterScriptLink(sceneListId, characterLabel, token) {
  if (!token) return false;
  const expected = signPublicCharacterScriptLink(sceneListId, characterLabel);
  const expectedBuf = Buffer.from(expected, "hex");
  const givenBuf = Buffer.from(String(token), "hex");
  return expectedBuf.length === givenBuf.length && crypto.timingSafeEqual(expectedBuf, givenBuf);
}

app.get("/api/scene-lists/:sceneListId/character-script/share-link", requireLogin, async (req, res) => {
  const { sceneListId } = req.params;
  const characterLabel = req.query.character;
  const lang = req.query.lang === "or" ? "or" : "en";

  if (!characterLabel?.trim()) {
    res.status(400).json({ error: "A character name is required." });
    return;
  }
  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const token = signPublicCharacterScriptLink(sceneListId, characterLabel.trim());
  const url = `${BACKEND_URL}/api/public/character-script?sceneListId=${encodeURIComponent(sceneListId)}&character=${encodeURIComponent(characterLabel.trim())}&token=${token}&lang=${lang}`;
  res.json({ url });
});

// No login required — this is the link an artist with no app account opens
// straight from WhatsApp. Reached only via a token minted by the route
// above, so it can't be used to fetch an arbitrary character's script
// without first having had legitimate access to mint that link.
app.get("/api/public/character-script", async (req, res) => {
  const { sceneListId, character, token } = req.query;
  const lang = req.query.lang === "or" ? "or" : "en";

  if (!sceneListId || !character?.trim() || !verifyPublicCharacterScriptLink(sceneListId, character, token)) {
    res.status(403).send("This link is invalid or has expired. Please ask for a new one.");
    return;
  }

  try {
    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    if (sceneListResult.rows.length === 0) {
      res.status(404).send("This project could not be found.");
      return;
    }

    const sourceText = await buildBreakdownSourceText(sceneListResult.rows[0].content, sceneListId);
    const scenes = await generateCharacterScript(sourceText, character.trim());
    renderCharacterScriptPdf(res, character.trim(), lang, scenes);
  } catch (error) {
    console.error("Public character script PDF failed:", error.message);
    if (!res.headersSent) {
      res.status(500).send("Something went wrong generating this script.");
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

// Keeps the AD Scene Breakdown Sheet's per-scene property/costumeRemarks in
// sync whenever a scene's costume or properties change through ANY route —
// the manual scene editor, a chat-agreed edit, or a handwritten note. These
// are two independent copies of overlapping information (the shoot
// schedule's sceneRefs carry a costume/properties note per scheduled scene;
// the AD sheet carries the same per real scene) — letting them drift apart
// is exactly the kind of thing that erodes trust in either document. Each
// edit writes the COMPLETE resulting value (matching how the shoot schedule
// side is written), replacing that row's field outright, not appending to
// it; a field an edit didn't touch is left as-is on that row.
function applySceneEditsToAdSheet(breakdownContent, sceneList, edits) {
  if (!Array.isArray(breakdownContent?.adSheet)) return { adSheet: breakdownContent?.adSheet, touched: false };
  const identities = allSceneIdentities(sceneList);
  let touched = false;
  const adSheet = breakdownContent.adSheet.map((row, flatIndex) => {
    const identity = identities[flatIndex];
    const match = /^e(\d+)-s(\d+)$/.exec(identity) ?? /^s(\d+)$/.exec(identity);
    const rowEpisodeIndex = match?.[2] !== undefined ? Number(match[1]) : null;
    const rowSceneIndex = match?.[2] !== undefined ? Number(match[2]) : Number(match?.[1]);
    const edit = edits.find((e) => e.sceneIndex === rowSceneIndex && (e.episodeIndex ?? null) === (rowEpisodeIndex ?? null));
    if (!edit) return row;
    const hasProperties = Boolean(edit.properties?.trim());
    const hasCostume = Boolean(edit.costume?.trim());
    if (!hasProperties && !hasCostume) return row;
    touched = true;
    return {
      ...row,
      property: hasProperties ? { en: edit.properties.trim(), or: row.property?.or ?? "" } : row.property,
      // The Odia side has no translation for a hand-typed/chat-written note,
      // so it's cleared rather than left showing stale text next to a
      // completely different English value.
      costumeRemarks: hasCostume ? { en: edit.costume.trim(), or: "" } : row.costumeRemarks,
    };
  });
  return { adSheet, touched };
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

function missingScheduleIdentities(scheduleDays, sceneList, isSeries, alreadyCovered) {
  const scheduled = scheduledSceneIdentities(scheduleDays, isSeries);
  return allSceneIdentities(sceneList).filter((id) => !scheduled.has(id) && !alreadyCovered?.has(id));
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

async function generateShootScheduleContent(
  sceneList,
  characterNames,
  availability,
  targetDays,
  revision,
  { specialInstructions, completedDays, sourceText, breakdownContent } = {}
) {
  const isSeries = Boolean(sceneList.episodeScenes);
  const sceneText = flattenScenesForScheduling(sceneList);
  const characterNamesText = characterNames.join(", ");
  const totalScenes = allSceneIdentities(sceneList).length;

  // Scenes already covered by a completed day (manually recorded from a
  // real shoot day that already happened) are never re-scheduled — the AI
  // is only ever asked to plan the REMAINING scenes, continuing the day
  // numbering after whatever's already been shot.
  const alreadyCovered = new Set();
  (completedDays ?? []).forEach((day) => {
    (day.sceneRefs ?? []).forEach((ref) => {
      alreadyCovered.add(isSeries ? `e${ref.episodeIndex}-s${ref.sceneIndex}` : `s${ref.sceneIndex}`);
    });
  });
  const remainingSceneCount = totalScenes - alreadyCovered.size;
  const nextDayNumber = (completedDays ?? []).reduce((max, d) => Math.max(max, d.dayNumber), 0) + 1;

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

  const alreadyShotText =
    alreadyCovered.size > 0
      ? `\n\n${alreadyCovered.size} of the ${totalScenes} scenes have ALREADY BEEN SHOT on a completed day and must NOT appear in your schedule at all — only plan the remaining ${remainingSceneCount} scenes. Number your shoot days starting from Day ${nextDayNumber} (the completed days before it are already numbered 1 through ${nextDayNumber - 1}).`
      : "";

  const knownCostumes = (breakdownContent?.costumes ?? []).map((c) => `${c.character}: ${c.description.en}`).join("; ");
  const knownProps = (breakdownContent?.props ?? []).map((p) => p.label).join(", ");
  const groundingText = sourceText
    ? `\n\nThe full script text (use this — not just the one-liners above — to work out costume continuity and which properties each scene actually needs):\n${sourceText}\n\nEstablished costume notes: ${knownCostumes || "(none yet)"}\n\nEstablished property list: ${knownProps || "(none yet)"}`
    : "";

  const specialInstructionsText = specialInstructions?.trim()
    ? `\n\nThe Production Manager's specific instructions for this schedule — follow these exactly, they override any default assumption: "${specialInstructions.trim()}"`
    : "";

  let contents = `${formatLine}\n\nMajor characters: ${characterNamesText}\n\nScene list:\n${sceneText}\n\n${availabilityText}${targetDaysText}${alreadyShotText}${groundingText}${specialInstructionsText}\n\nIMPORTANT: every one of the ${remainingSceneCount} remaining scenes must appear in exactly one shoot day's sceneRefs — do not skip any scene and do not invent scenes that aren't listed above, and never include a scene already marked as shot.\n\nTOP PRIORITY — minimize each character's number of distinct shoot days: for every character who isn't in nearly every scene (a guest role, a day player, a recurring-but-not-daily character), the production is paying for their call days, so group ALL of their scenes onto as FEW days as possible — ideally exactly one single day — even if that means deviating from pure location-based grouping to do it. Only split a character across more than one day when it's genuinely unavoidable (e.g. their scenes are simply too many to fit in one realistic shoot day). When a character's own availability was given as "unknown" (no specific constraint), treat that as freedom to consolidate — schedule all of their scenes together in whichever single day makes that possible, rather than spreading them across the schedule by story or location order.\n\nSECOND PRIORITY — never split a continuity block of scenes: whenever a set of scenes shares the same standing set decoration, an expensive or hard-to-repeat art/property setup, or a costume that has real cost/time attached (a built set, a special installation, a rented prop, a costume that takes real time to get in and out of), schedule that ENTIRE bundle of scenes together in one continuous run within a single day, in their natural order, rather than moving just one scene out of the group by itself. Treat these bundles as a single indivisible unit when building the day-by-day plan — the crew strikes and re-dresses a set once, not repeatedly, so once a bundle is scheduled, every scene in it stays together.\n\nThird priority — shoot LINEARLY by location, not by episode or story order: group every scene that shares the same physical location together (even across different episodes) and shoot them back-to-back in scene order within that group, exactly like a real production would, rather than following story chronology, EXCEPT where doing so would split a character (per the top priority above) across more days than necessary. Keep INT (indoor) and EXT (outdoor) scenes in separate day groups — outdoor scenes depend on weather/daylight, so schedule them as their own block and say so explicitly in that day's "notes" (e.g. "Weather-dependent — reschedule if rain"). For each shoot day, also give "charactersNeeded": the major characters (from the list above, by exact name) who appear in at least one of that day's scenes, inferred from the scenes' one-liners and locations — this is what tells each artist which shoot days they're actually called for. For EACH scene in sceneRefs, also give: "costume" (continuity relative to shoot order — "Fresh" for a new/changed outfit, "Cont. Scene X" when it's the same outfit as an already-scheduled scene X with no change, or a short costume description if genuinely a first appearance); "properties" (objects/set-dressing that scene needs, preferring the established property list above); and "adRemark" (leave as an empty string "" when nothing is uncertain — only write something here when you are genuinely not confident about a costume-continuity call or a property and need the Assistant Director to confirm it by hand).`;

  if (revision) {
    contents += `\n\nThis is a REVISION of a previous shoot schedule. The Production Manager reviewed it and requested changes.\nFeedback: "${revision.feedback}"\nRevise the schedule to address the feedback directly.`;
  }

  let parsed = await callShootScheduleGemini(contents, isSeries);

  // If the model dropped any real scenes, give it one corrective retry
  // listing exactly which ones were missed — capped at a single retry, same
  // pattern as the scene-list pacing retry above.
  const missing = missingScheduleIdentities(parsed.scheduleDays, sceneList, isSeries, alreadyCovered);
  if (missing.length > 0) {
    const missingText = missing
      .map((id) => (isSeries ? id.replace(/^e(\d+)-s(\d+)$/, "episode $1, scene $2") : id.replace(/^s(\d+)$/, "scene $1")))
      .join("; ");
    const correctionNote = `\n\nIMPORTANT CORRECTION NEEDED: your schedule left out these scenes entirely (0-indexed): ${missingText}. Revise the schedule so every one of the remaining scenes is assigned to a shoot day, adding days if needed.`;
    parsed = await callShootScheduleGemini(contents + correctionNote, isSeries);
  }

  // The model isn't perfectly reliable about several things it's explicitly
  // told: not to re-include an already-shot scene, not to schedule the same
  // scene twice, and not to invent a scene that isn't in the real list
  // (seen referencing an out-of-range sceneIndex for an episode). Enforce
  // all three in code rather than trust the prompt alone: drop anything not
  // in the real scene list, anything already covered by a completed day,
  // and a scene's second-or-later occurrence across the new days.
  const validIdentities = new Set(allSceneIdentities(sceneList));
  const seenNew = new Set(alreadyCovered);
  const dedupedDays = parsed.scheduleDays.map((day) => ({
    ...day,
    sceneRefs: day.sceneRefs.filter((ref) => {
      const id = isSeries ? `e${ref.episodeIndex}-s${ref.sceneIndex}` : `s${ref.sceneIndex}`;
      if (!validIdentities.has(id) || seenNew.has(id)) return false;
      seenNew.add(id);
      return true;
    }),
  }));

  // Dedup can only ever remove a scene's later duplicate, never its only
  // occurrence — so anything still missing here was dropped by the model
  // outright, surviving even the corrective retry above. Rather than lose
  // it silently, force it onto the last day with a flag so the AD notices
  // and relocates it by hand instead of it just never getting shot.
  const stillMissing = allSceneIdentities(sceneList).filter((id) => !seenNew.has(id));
  if (stillMissing.length > 0 && dedupedDays.length > 0) {
    const lastDay = dedupedDays[dedupedDays.length - 1];
    stillMissing.forEach((id) => {
      const seriesMatch = id.match(/^e(\d+)-s(\d+)$/);
      const filmMatch = id.match(/^s(\d+)$/);
      const ref = seriesMatch
        ? { episodeIndex: Number(seriesMatch[1]), sceneIndex: Number(seriesMatch[2]) }
        : { sceneIndex: Number(filmMatch[1]) };
      lastDay.sceneRefs.push({
        ...ref,
        costume: "",
        properties: "",
        adRemark: "Auto-added — the generated schedule left this scene unplaced; please move it to the right day by hand.",
      });
    });
  }

  // Renumber the AI's days to continue right after the last completed one,
  // and only date-assign the NEW days (starting from availability.startDate,
  // which the caller supplies for this NEW block specifically) — a
  // completed day's real date (from when it actually happened) is never
  // recomputed or overwritten.
  const renumberedNewDays = dedupedDays.map((day, i) => ({ ...day, dayNumber: nextDayNumber + i, completed: false }));
  const datedNewDays = assignScheduleDates(renumberedNewDays, availability.startDate);
  const scheduleDays = [...(completedDays ?? []), ...datedNewDays];

  return {
    ...parsed,
    scheduleDays,
    artistSchedule: buildArtistWiseSchedule(scheduleDays),
    availability,
    targetDays,
    specialInstructions: specialInstructions ?? null,
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
  const { sceneListId, availability, targetDays, specialInstructions } = req.body;

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
      "SELECT status, content FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    if (breakdownResult.rows.length === 0 || breakdownResult.rows[0].status !== "approved") {
      res.status(400).json({ error: "Run and approve the script breakdown before building a shoot schedule." });
      return;
    }

    // Any day already marked completed (a real shoot day that's already
    // happened — recorded via /record-day, whether transcribed from a
    // paper sheet or confirmed after the fact) carries forward untouched;
    // only its ACTUALLY-shot scenes count as covered, so anything the AD
    // reported as not-completed on a previous day naturally flows into
    // this new plan instead of vanishing.
    const latestSchedule = await db.query(
      "SELECT content FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    const completedDays = (latestSchedule.rows[0]?.content?.scheduleDays ?? []).filter((d) => d.completed);

    const sceneList = sceneListResult.rows[0].content;
    const characterNames = await fetchCharacterNamesForSceneList(sceneListId, sceneList);
    const sourceText = await buildBreakdownSourceText(sceneList, sceneListId);
    const content = await generateShootScheduleContent(sceneList, characterNames, availability, targetDays, null, {
      specialInstructions,
      completedDays,
      sourceText,
      breakdownContent: breakdownResult.rows[0].content,
    });

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

// Records what ACTUALLY happened on a real shoot day — either transcribing
// a paper AD sheet for a day that's already been shot (before this feature
// existed), or confirming which of a previously PLANNED day's scenes were
// genuinely completed once shooting wrapped. Only the scenes listed here
// count as "shot"; anything from that day left out (because the AD
// reported it wasn't finished) simply remains unscheduled and will be
// picked up automatically the next time the schedule is (re)generated.
// Lets the AD report what actually happened today in his own words,
// referencing scenes by their real script scene numbers (the same ones
// on his paper sheet) — rather than making him understand or click
// through the app's own internal scene ordering. The candidate list is
// bounded to just today's PLANNED scenes (typically a handful to a few
// dozen), which is what makes this reliable: the model only has to match
// a short report against a short, concrete list, not search the whole
// script. Never commits anything by itself — the frontend shows the
// interpretation back to the AD/PM to confirm or correct before saving.
async function parseCompletedScenesFromReport(sceneList, plannedSceneRefs, reportText) {
  const isSeries = Boolean(sceneList.episodeScenes);
  const listText = plannedSceneRefs
    .map((ref, i) => {
      const scene = lookupSceneServerSide(sceneList, ref);
      const num = (scene?.sceneNumber || String(ref.sceneIndex + 1)).replace(/^\s*(SCENE|SC)\.?\s*/i, "");
      const epLabel = isSeries ? `Episode ${ref.episodeIndex + 1}, ` : "";
      return `${i}. ${epLabel}Scene ${num}: ${scene?.oneLiner?.en ?? ""}`;
    })
    .join("\n");

  const contents = `Today's planned shoot list, numbered:\n${listText}\n\nThe Assistant Director's report on what actually happened today:\n"${reportText}"\n\nFor EACH numbered item above, determine whether the AD's report says it was completed today or not. Match by the scene number and episode mentioned in the report — the AD refers to scenes by their real script scene numbers, exactly as listed above — do not guess from position alone. If the report doesn't mention an item at all, assume it was NOT completed (safer default — an unmentioned scene should roll forward rather than be silently marked done). Return "completedIndexes" (0-indexed positions from the list above that the report confirms were completed) and "notCompletedIndexes" (everything else). Every index from 0 to ${plannedSceneRefs.length - 1} must appear in exactly one of the two arrays.`;

  const response = await generateContentWithRetry({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      systemInstruction: PRODUCTION_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 2048,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          completedIndexes: { type: Type.ARRAY, items: { type: Type.INTEGER } },
          notCompletedIndexes: { type: Type.ARRAY, items: { type: Type.INTEGER } },
        },
        required: ["completedIndexes", "notCompletedIndexes"],
      },
    },
  });

  return JSON.parse(response.text);
}

app.post("/api/shoot-schedule/:sceneListId/parse-day-completion", requireRole("admin", "production_manager"), async (req, res) => {
  const { sceneListId } = req.params;
  const { dayNumber, reportText } = req.body;

  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }
  if (typeof dayNumber !== "number" || !reportText?.trim()) {
    res.status(400).json({ error: "A dayNumber and a completion report are required." });
    return;
  }

  try {
    const latestSchedule = await db.query(
      "SELECT content FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    const day = (latestSchedule.rows[0]?.content?.scheduleDays ?? []).find((d) => d.dayNumber === dayNumber);
    if (!day) {
      res.status(404).json({ error: "That shoot day wasn't found in the current schedule." });
      return;
    }

    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const sceneList = sceneListResult.rows[0].content;

    const { completedIndexes, notCompletedIndexes } = await parseCompletedScenesFromReport(sceneList, day.sceneRefs, reportText);

    const describeRef = (ref) => {
      const scene = lookupSceneServerSide(sceneList, ref);
      const num = (scene?.sceneNumber || String(ref.sceneIndex + 1)).replace(/^\s*(SCENE|SC)\.?\s*/i, "");
      const epLabel = typeof ref.episodeIndex === "number" ? `Episode ${ref.episodeIndex + 1}, ` : "";
      return `${epLabel}Scene ${num}${scene?.oneLiner?.en ? `: ${scene.oneLiner.en}` : ""}`;
    };

    res.json({
      dayNumber,
      completedIndexes,
      completed: completedIndexes.map((i) => ({ index: i, label: describeRef(day.sceneRefs[i]) })),
      notCompleted: notCompletedIndexes.map((i) => ({ index: i, label: describeRef(day.sceneRefs[i]) })),
    });
  } catch (error) {
    console.error("Parsing day completion failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// Reads a photo of a handwritten AD note and returns what it understood —
// never applies anything itself. The AD reviews the summary and the
// per-scene breakdown (each one flagged resolved/unresolved) and only then
// confirms, which calls /apply-handwritten-changes below with the exact
// list shown on screen (possibly edited first).
app.post(
  "/api/shoot-schedule/:sceneListId/interpret-handwritten-note",
  requireRole("admin", "production_manager"),
  handwrittenNoteUpload.single("image"),
  async (req, res) => {
    const { sceneListId } = req.params;

    if (!(await userOwnsSceneList(req.user, sceneListId))) {
      res.status(403).json({ error: "You don't have access to this project." });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "An image file is required." });
      return;
    }

    try {
      const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
      if (sceneListResult.rows.length === 0) {
        res.status(404).json({ error: "Scene list not found" });
        return;
      }
      const sceneList = sceneListResult.rows[0].content;

      const result = await parseHandwrittenScheduleNote(req.file.buffer, req.file.mimetype, sceneList, sceneListId);
      res.json(result);
    } catch (error) {
      console.error("Interpreting handwritten note failed:", error.message);
      res.status(502).json({ error: error.message });
    }
  }
);

// Applies a confirmed list of per-scene changes (from the route above,
// reviewed and confirmed by the AD) directly — no AI call here at all, so
// this is exactly as reliable as the manual per-scene edit endpoint it
// reuses: properties are ADDED to whatever's already there (never
// overwritten), and both the shoot schedule's sceneRefs and the AD Scene
// Breakdown Sheet's matching row are updated together, in one INSERT-only
// revision each, so the two stay in sync.
app.post("/api/shoot-schedule/:sceneListId/apply-handwritten-changes", requireRole("admin", "production_manager"), async (req, res) => {
  const { sceneListId } = req.params;
  const { changes } = req.body;

  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    res.status(400).json({ error: "A list of changes is required." });
    return;
  }

  const resolvedChanges = changes.filter((c) => typeof c.sceneIndex === "number");
  if (resolvedChanges.length === 0) {
    res.status(400).json({ error: "None of these changes had a resolved scene to apply to." });
    return;
  }

  try {
    const latestSchedule = await db.query(
      "SELECT id, content, status FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    let scheduleResult = null;
    if (latestSchedule.rows.length > 0) {
      const scheduleContent = latestSchedule.rows[0].content;
      let scheduleTouched = false;
      const scheduleDays = scheduleContent.scheduleDays.map((day) => ({
        ...day,
        sceneRefs: day.sceneRefs.map((ref) => {
          const change = resolvedChanges.find(
            (c) => c.sceneIndex === ref.sceneIndex && (c.episodeIndex ?? null) === (ref.episodeIndex ?? null)
          );
          if (!change) return ref;
          scheduleTouched = true;
          const mergedProperties = [ref.properties, ...(change.propertiesToAdd ?? [])].filter(Boolean).join(", ");
          return {
            ...ref,
            properties: mergedProperties,
            costume: change.costumeNote?.trim() ? change.costumeNote.trim() : ref.costume,
            adRemark: change.remark?.trim() ? [ref.adRemark, change.remark.trim()].filter(Boolean).join(" — ") : ref.adRemark,
          };
        }),
      }));

      if (scheduleTouched) {
        const updatedScheduleContent = { ...scheduleContent, scheduleDays };
        // Pure enrichment — carries the previous approval status forward
        // instead of silently un-approving an already-approved schedule.
        const insertResult = await db.query(
          "INSERT INTO shoot_schedules (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
          [sceneListId, JSON.stringify(updatedScheduleContent), latestSchedule.rows[0].status, "Applied changes from a handwritten AD note (photo)"]
        );
        scheduleResult = { ...insertResult.rows[0], sceneListId, ...updatedScheduleContent };
      }
    }

    const latestBreakdown = await db.query(
      "SELECT id, content, status FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    let breakdownResult = null;
    if (latestBreakdown.rows.length > 0 && Array.isArray(latestBreakdown.rows[0].content.adSheet)) {
      const breakdownContent = latestBreakdown.rows[0].content;
      const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
      const identities = allSceneIdentities(sceneListResult.rows[0].content);
      let breakdownTouched = false;
      const adSheet = breakdownContent.adSheet.map((row, flatIndex) => {
        const identity = identities[flatIndex];
        const match = /^e(\d+)-s(\d+)$/.exec(identity) ?? /^s(\d+)$/.exec(identity);
        const rowEpisodeIndex = match?.[2] !== undefined ? Number(match[1]) : null;
        const rowSceneIndex = match?.[2] !== undefined ? Number(match[2]) : Number(match?.[1]);
        const change = resolvedChanges.find((c) => c.sceneIndex === rowSceneIndex && (c.episodeIndex ?? null) === (rowEpisodeIndex ?? null));
        if (!change) return row;
        breakdownTouched = true;
        const addedProps = (change.propertiesToAdd ?? []).join(", ");
        return {
          ...row,
          property: { en: [row.property?.en, addedProps].filter(Boolean).join(", "), or: row.property?.or ?? "" },
          // The Odia side has no translation for a hand-typed note, so it's
          // cleared rather than left showing the old costume's description
          // next to a completely different English value.
          costumeRemarks: change.costumeNote?.trim() ? { en: change.costumeNote.trim(), or: "" } : row.costumeRemarks,
        };
      });

      if (breakdownTouched) {
        const updatedBreakdownContent = { ...breakdownContent, adSheet };
        // Pure enrichment — carries the previous approval status forward
        // (see the same note on classify-cast-categories above).
        const insertResult = await db.query(
          "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
          [sceneListId, JSON.stringify(updatedBreakdownContent), latestBreakdown.rows[0].status, "Applied changes from a handwritten AD note (photo) to the AD Sheet"]
        );
        breakdownResult = { ...insertResult.rows[0], sceneListId, ...updatedBreakdownContent };
      }
    }

    res.json({ schedule: scheduleResult, breakdown: breakdownResult });
  } catch (error) {
    console.error("Applying handwritten changes failed:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/shoot-schedule/:sceneListId/record-day", requireRole("admin", "production_manager"), async (req, res) => {
  const { sceneListId } = req.params;
  const { day } = req.body;

  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }
  if (!day || typeof day.dayNumber !== "number" || !Array.isArray(day.sceneRefs)) {
    res.status(400).json({ error: "A day with a dayNumber and sceneRefs is required." });
    return;
  }

  try {
    const latestSchedule = await db.query(
      "SELECT id, content, status FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );

    const previousContent = latestSchedule.rows[0]?.content ?? { scheduleDays: [], conflicts: [] };
    const recordedDay = { ...day, completed: true };
    // Replacing by dayNumber lets the same day be re-recorded (e.g. the AD
    // first reports 4 of 6 scenes done, then later confirms the rest) —
    // never appended as a duplicate.
    const otherDays = (previousContent.scheduleDays ?? []).filter((d) => d.dayNumber !== recordedDay.dayNumber);
    const scheduleDays = [...otherDays, recordedDay].sort((a, b) => a.dayNumber - b.dayNumber);

    const updatedContent = {
      ...previousContent,
      scheduleDays,
      artistSchedule: buildArtistWiseSchedule(scheduleDays),
    };

    // Marking progress on an already-approved schedule shouldn't silently
    // un-approve it — carries the previous status forward.
    const insertResult = await db.query(
      "INSERT INTO shoot_schedules (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(updatedContent), latestSchedule.rows[0]?.status ?? "pending", `Recorded Day ${recordedDay.dayNumber} as shot`]
    );

    res.json({ ...insertResult.rows[0], sceneListId, ...updatedContent });
  } catch (error) {
    console.error("Recording shoot day failed:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Direct, deterministic edit of one scene's costume/properties/AD-remark —
// no AI call at all. Free-text "request changes" feedback goes through a
// full Gemini regeneration of the whole schedule, which is unreliable for
// a small tweak like adding one prop (it can reshuffle days that were
// already carefully hand-balanced) and gives no visible confirmation the
// AD can trust. This is the fix: a plain field edit the AD can add to or
// remove from directly, applied instantly and exactly as typed.
app.post("/api/shoot-schedule/:id/edit-scene", requireRole("admin", "production_manager"), async (req, res) => {
  const { episodeIndex, sceneIndex, costume, properties, adRemark } = req.body;

  if (typeof sceneIndex !== "number") {
    res.status(400).json({ error: "A sceneIndex is required." });
    return;
  }

  const existing = await db.query("SELECT scene_list_id FROM shoot_schedules WHERE id = $1", [req.params.id]);
  if (existing.rows.length === 0) {
    res.status(404).json({ error: "Shoot schedule not found" });
    return;
  }

  const sceneListId = existing.rows[0].scene_list_id;
  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const latest = await db.query(
    "SELECT id, content, status FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
    [sceneListId]
  );
  if (String(latest.rows[0].id) !== String(req.params.id)) {
    res.status(409).json({ error: "Someone else updated this shoot schedule since you loaded it. Reload the page and try again." });
    return;
  }

  const content = latest.rows[0].content;
  let found = false;
  const scheduleDays = content.scheduleDays.map((day) => ({
    ...day,
    sceneRefs: day.sceneRefs.map((ref) => {
      if (ref.sceneIndex !== sceneIndex || (ref.episodeIndex ?? null) !== (episodeIndex ?? null)) return ref;
      found = true;
      return {
        ...ref,
        costume: costume ?? ref.costume,
        properties: properties ?? ref.properties,
        adRemark: adRemark ?? ref.adRemark,
      };
    }),
  }));

  if (!found) {
    res.status(404).json({ error: "That scene wasn't found in the current schedule." });
    return;
  }

  const updatedContent = { ...content, scheduleDays };

  // A direct field edit shouldn't silently un-approve an already-approved
  // schedule — carries the previous status forward.
  const insertResult = await db.query(
    "INSERT INTO shoot_schedules (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
    [sceneListId, JSON.stringify(updatedContent), latest.rows[0].status, "AD edited a scene's costume/properties/remark directly"]
  );

  // Keep the AD Scene Breakdown Sheet's matching row in sync with this same
  // edit — see applySceneEditsToAdSheet's own comment for why these two
  // documents would otherwise silently drift apart.
  let breakdownResult = null;
  const latestBreakdown = await db.query(
    "SELECT id, content, status FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
    [sceneListId]
  );
  if (latestBreakdown.rows.length > 0) {
    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const { adSheet, touched } = applySceneEditsToAdSheet(latestBreakdown.rows[0].content, sceneListResult.rows[0].content, [
      { episodeIndex, sceneIndex, costume, properties },
    ]);
    if (touched) {
      const updatedBreakdownContent = { ...latestBreakdown.rows[0].content, adSheet };
      const breakdownInsertResult = await db.query(
        "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
        [sceneListId, JSON.stringify(updatedBreakdownContent), latestBreakdown.rows[0].status, "AD Sheet synced from a direct scene edit"]
      );
      breakdownResult = { ...breakdownInsertResult.rows[0], sceneListId, ...updatedBreakdownContent };
    }
  }

  res.json({ ...insertResult.rows[0], sceneListId, ...updatedContent, breakdown: breakdownResult });
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

app.post("/api/shoot-schedule/:id/request-changes", requireRole("admin", "director", "production_manager"), async (req, res) => {
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
    const sceneList = sceneListResult.rows[0].content;
    const characterNames = await fetchCharacterNamesForSceneList(sceneListId, sceneList);

    // Same grounding the initial generation gets — this route was silently
    // regenerating from just the one-line scene summaries with no memory of
    // which days are already shot, which would both re-schedule completed
    // days and lose the costume/property continuity the full script gives.
    const breakdownResult = await db.query(
      "SELECT content FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    const completedDays = (previous.scheduleDays ?? []).filter((d) => d.completed);
    const sourceText = await buildBreakdownSourceText(sceneList, sceneListId);

    const revisedContent = await generateShootScheduleContent(
      sceneList,
      characterNames,
      previous.availability,
      previous.targetDays,
      { feedback, previous },
      {
        specialInstructions: previous.specialInstructions,
        completedDays,
        sourceText,
        breakdownContent: breakdownResult.rows[0]?.content ?? null,
      }
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

// Same grouping as the web UI's groupSceneRefsForDisplay — by episode, then
// by location within that episode — so the printed sheet reads "Episode 2:
// 3 scenes in the Living Room, 4 in the Bedroom" as clearly as the app
// does, rather than a flat row-by-row table. Preserves the schedule's own
// shoot order (first-appearance order) at both levels.
function groupSceneRefsForPdf(sceneRefs, sceneList, lang) {
  const episodeGroups = [];
  const episodeIndexToGroup = new Map();

  sceneRefs.forEach((ref) => {
    const scene = lookupSceneServerSide(sceneList, ref);
    if (!scene) return;
    const episodeKey = typeof ref.episodeIndex === "number" ? ref.episodeIndex : null;

    let episodeGroup = episodeIndexToGroup.get(episodeKey);
    if (!episodeGroup) {
      episodeGroup = { episodeIndex: episodeKey, locationGroups: [], locationKeyToGroup: new Map() };
      episodeIndexToGroup.set(episodeKey, episodeGroup);
      episodeGroups.push(episodeGroup);
    }

    const locationLabel = scene.location?.[lang] || scene.location?.en || "";
    let locationGroup = episodeGroup.locationKeyToGroup.get(locationLabel);
    if (!locationGroup) {
      locationGroup = { location: locationLabel, items: [] };
      episodeGroup.locationKeyToGroup.set(locationLabel, locationGroup);
      episodeGroup.locationGroups.push(locationGroup);
    }
    locationGroup.items.push({ ref, scene });
  });

  return episodeGroups;
}

// The one PDF every department actually needs: a day-by-day call schedule
// (scenes, location, cast called) followed by a per-artist summary — how
// many days and which ones — so it can be forwarded as-is to artists and
// the director instead of them reading the app itself.
app.get("/api/shoot-schedule/:id/export", requireLogin, async (req, res) => {
  const lang = req.query.lang === "or" ? "or" : "en";
  // Optional — scopes this exact same grid-table sheet to one day instead
  // of the whole schedule, reusing all the same per-scene grid-drawing
  // logic rather than a separate PDF layout for a day's "master breakdown".
  const dayFilter = req.query.day ? Number(req.query.day) : null;

  try {
    // The browser's own shootSchedule.id can go stale the moment a
    // different login (or a different tab) creates a newer revision —
    // shoot_schedules is INSERT-only, "latest by created_at" is always the
    // real current state. Exporting by the exact id the frontend happened
    // to have in memory would silently produce a PDF of an old revision
    // even though the app itself shows the current one right next to it.
    // :id is only used to resolve which project this is; the content
    // exported is always re-fetched as the latest for that project.
    const idLookup = await db.query("SELECT scene_list_id FROM shoot_schedules WHERE id = $1", [req.params.id]);
    if (idLookup.rows.length === 0) {
      res.status(404).json({ error: "Shoot schedule not found" });
      return;
    }
    const result = await db.query(
      "SELECT scene_list_id, content FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [idLookup.rows[0].scene_list_id]
    );

    const { scene_list_id: sceneListId, content: schedule } = result.rows[0];
    if (dayFilter && !(schedule.scheduleDays ?? []).some((d) => d.dayNumber === dayFilter)) {
      res.status(404).json({ error: `Day ${dayFilter} was not found in this schedule.` });
      return;
    }
    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const sceneList = sceneListResult.rows[0]?.content ?? {};
    const isSeries = Boolean(sceneList.episodeScenes);
    const title = await fetchProjectTitleForSceneList(sceneListId, sceneList, lang);

    const bodyFont = lang === "or" ? "odiaRegular" : "Helvetica";
    const headerFont = lang === "or" ? "odiaBold" : "Helvetica-Bold";
    const labels =
      lang === "or"
        ? {
            schedule: "ସୁଟିଂ ସୂଚୀ", day: "ଦିନ", location: "ସ୍ଥାନ", cast: "କଳାକାର", notes: "ଟିପ୍ପଣୀ", artistSummary: "କଳାକାର-ଅନୁଯାୟୀ ସାରାଂଶ", totalDays: "ମୋଟ ଦିନ", days: "ଦିନଗୁଡ଼ିକ", completed: "ସମାପ୍ତ", costume: "ପୋଷାକ", properties: "ପ୍ରପର୍ଟି", adRemark: "AD ମନ୍ତବ୍ୟ",
            wrapped: "ସମାପ୍ତ", pending: "ବାକି", inProgress: "ଚାଲୁଛି", episode: "ଏପିସୋଡ୍", scenes: "ଦୃଶ୍ୟ", unspecified: "ଅନିର୍ଦ୍ଦିଷ୍ଟ",
          }
        : {
            schedule: "Shoot Schedule", day: "Day", location: "Location", cast: "Cast Called", notes: "Notes", artistSummary: "Artist-Wise Summary", totalDays: "Total Days", days: "Days", completed: "COMPLETED", costume: "Costume", properties: "Properties", adRemark: "AD Remark",
            wrapped: "WRAPPED", pending: "PENDING", inProgress: "IN PROGRESS", episode: "Episode", scenes: "scenes", unspecified: "Unspecified",
          };

    // Per-scene cast (who's actually IN that scene, not the whole day's
    // call list) comes from the AD Scene Breakdown Sheet, if one's been
    // generated — same positional flattening it was built from, so a
    // sceneRef's position in that array lines up with its adSheet row.
    const breakdownResult = await db.query(
      "SELECT content FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    const adSheetRows = breakdownResult.rows[0]?.content?.adSheet ?? null;
    const castByIdentity = new Map();
    // The AD sheet only carries the literal sceneNumber label per row, not
    // an episode/scene INDEX — rebuild the same positional order it was
    // generated in (flattenScenesForAdSheet's own order) to get a reliable
    // e{ep}-s{idx} key per row.
    if (adSheetRows) {
      let flatIndex = 0;
      if (isSeries) {
        (sceneList.episodeScenes ?? []).forEach((episodeScene, episodeIndex) => {
          episodeScene.scenes.forEach((_, sceneIndex) => {
            castByIdentity.set(`e${episodeIndex}-s${sceneIndex}`, adSheetRows[flatIndex]);
            flatIndex += 1;
          });
        });
      } else {
        (sceneList.scenes ?? []).forEach((_, sceneIndex) => {
          castByIdentity.set(`s${sceneIndex}`, adSheetRows[flatIndex]);
          flatIndex += 1;
        });
      }
    }
    const notAvailableLabel = lang === "or" ? "—" : "—";

    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 24 });
    doc.registerFont("odiaRegular", FONTS.odiaRegular);
    doc.registerFont("odiaBold", FONTS.odiaBold);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="shoot-schedule${dayFilter ? `-day-${dayFilter}` : ""}-${lang}-${formatExportTimestamp()}.pdf"`
    );
    doc.pipe(res);

    const pageLeft = doc.page.margins.left;
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    const columns = [
      { key: "scn", label: "SC NO", width: 55 },
      { key: "location", label: labels.location, width: 140 },
      { key: "artist", label: labels.cast, width: 160 },
      { key: "costume", label: labels.costume, width: 170 },
      { key: "properties", label: labels.properties, width: 235 },
    ];
    const cellPaddingX = 4;
    const cellPaddingY = 4;

    function drawHeaderRow(y) {
      doc.font(headerFont).fontSize(9);
      const rowHeight = Math.max(
        22,
        ...columns.map((col) => doc.heightOfString(col.label, { width: col.width - cellPaddingX * 2 }) + cellPaddingY * 2)
      );
      let x = pageLeft;
      columns.forEach((col) => {
        doc.rect(x, y, col.width, rowHeight).fill("#000");
        doc.fillColor("#fff").font(headerFont).fontSize(9).text(col.label, x + cellPaddingX, y + cellPaddingY, { width: col.width - cellPaddingX * 2 });
        x += col.width;
      });
      doc.fillColor("#000");
      return y + rowHeight;
    }

    const scheduleDaysToRender = dayFilter
      ? schedule.scheduleDays.filter((d) => d.dayNumber === dayFilter)
      : schedule.scheduleDays;

    scheduleDaysToRender.forEach((day, dayIndex) => {
      if (dayIndex > 0) doc.addPage({ size: "A4", layout: "landscape", margin: 24 });

      // A completed day gets a red band behind its header so it reads as
      // "already shot" at a glance when flipping through a printed copy,
      // matching the same red the app's own UI uses for a wrapped day.
      const dayTitle = `${day.date ? `${formatDisplayDate(day.date)}  —  ` : ""}${labels.day} ${day.dayNumber}${day.completed ? `  — ${labels.completed}` : ""}`;
      if (day.completed) {
        const bandHeight = 30;
        doc.rect(pageLeft, doc.page.margins.top - 4, doc.page.width - pageLeft - doc.page.margins.right, bandHeight).fill("#fdecea");
        doc.fillColor("#b3261e").font(headerFont).fontSize(16).text(dayTitle, pageLeft + 6, doc.page.margins.top);
        doc.fillColor("#000");
      } else {
        doc.font(headerFont).fontSize(16).text(dayTitle, pageLeft, doc.page.margins.top);
      }
      doc.font(bodyFont).fontSize(11).text(`${labels.location}: ${day.location?.[lang] ?? ""}`, pageLeft);
      doc.moveDown(0.5);

      let y = doc.y;
      y = drawHeaderRow(y);

      const tableWidth = columns.reduce((s, c) => s + c.width, 0);
      function drawGroupBanner(bannerY, text) {
        const bandHeight = 18;
        if (bannerY + bandHeight > pageBottom) {
          doc.addPage({ size: "A4", layout: "landscape", margin: 24 });
          bannerY = doc.page.margins.top;
          bannerY = drawHeaderRow(bannerY);
        }
        doc.rect(pageLeft, bannerY, tableWidth, bandHeight).fill("#eef2f7");
        doc.fillColor("#1a1a1a").font(headerFont).fontSize(10).text(text, pageLeft + 6, bannerY + 4);
        doc.fillColor("#000");
        return bannerY + bandHeight;
      }

      // Grouped by episode, then by location within it — "Episode 2: 3
      // scenes in the Living Room, 4 in the Bedroom" as a banner row ahead
      // of each block, instead of a flat table the AD has to scan line by
      // line to see the same thing.
      groupSceneRefsForPdf(day.sceneRefs ?? [], sceneList, lang).forEach((episodeGroup) => {
        episodeGroup.locationGroups.forEach((locationGroup) => {
          const episodePrefix = episodeGroup.episodeIndex !== null ? `${labels.episode} ${episodeGroup.episodeIndex + 1} — ` : "";
          const bannerText = `${episodePrefix}${locationGroup.location || labels.unspecified} (${locationGroup.items.length} ${labels.scenes})`;
          y = drawGroupBanner(y, bannerText);

          locationGroup.items.forEach(({ ref, scene }) => {
            const identity = isSeries ? `e${ref.episodeIndex}-s${ref.sceneIndex}` : `s${ref.sceneIndex}`;
            const adSheetRow = castByIdentity.get(identity);
            // The stored sceneNumber is sometimes a bare code ("1A", "7") and
            // sometimes the verbatim script text including the word itself
            // ("SCENE 1") — strip that prefix so the cell never reads "SCENE
            // SCENE 1", regardless of which form this particular scene has.
            const realSceneNumber = (scene.sceneNumber || String(ref.sceneIndex + 1)).replace(/^\s*(SCENE|SC)\.?\s*/i, "");
            const scn = isSeries ? `Ep${ref.episodeIndex + 1}\n${realSceneNumber}` : realSceneNumber;
            const artist = adSheetRow ? (adSheetRow.mainCharacters ?? []).join(", ") || notAvailableLabel : (day.charactersNeeded ?? []).join(", ") || notAvailableLabel;
            const properties = [ref.properties, adSheetRow?.extras?.[lang]].filter(Boolean).join("; ");

            const values = {
              scn,
              location: `${scene.intExt}. ${scene.location?.[lang] ?? ""}`,
              artist,
              costume: ref.costume || notAvailableLabel,
              properties: properties || notAvailableLabel,
            };

            doc.font(bodyFont).fontSize(9);
            const rowHeight = Math.max(
              18,
              ...columns.map((col) => doc.heightOfString(String(values[col.key] ?? ""), { width: col.width - cellPaddingX * 2 }) + cellPaddingY * 2)
            );

            if (y + rowHeight > pageBottom) {
              doc.addPage({ size: "A4", layout: "landscape", margin: 24 });
              y = doc.page.margins.top;
              y = drawHeaderRow(y);
              y = drawGroupBanner(y, bannerText);
            }

            let x = pageLeft;
            columns.forEach((col) => {
              doc.rect(x, y, col.width, rowHeight).stroke("#cccccc");
              doc.font(bodyFont).fontSize(9).text(String(values[col.key] ?? ""), x + cellPaddingX, y + cellPaddingY, { width: col.width - cellPaddingX * 2 });
              x += col.width;
            });
            if (ref.adRemark) {
              const remarkHeight = doc.heightOfString(`AD Remark: ${ref.adRemark}`, { width: tableWidth - cellPaddingX * 2 }) + cellPaddingY * 2;
              doc
                .font(bodyFont)
                .fontSize(8)
                .fillColor("#b45309")
                .text(`AD Remark: ${ref.adRemark}`, pageLeft + cellPaddingX, y + rowHeight, { width: tableWidth - cellPaddingX * 2 })
                .fillColor("#000");
              y += rowHeight + remarkHeight;
            } else {
              y += rowHeight;
            }
          });
        });
      });

      if (day.notes?.[lang]) {
        doc.moveDown(0.5);
        doc.font(headerFont).fontSize(10).text(`${labels.notes}: `, pageLeft, y + 6, { continued: true }).font(bodyFont).text(day.notes[lang]);
      }
    });

    // The Artist-Wise Summary covers the WHOLE schedule (every day an
    // artist is needed across the project) — not meaningful once this
    // export is scoped to a single day, so it's skipped entirely there.
    if (!dayFilter) {
      doc.addPage({ size: "A4", margin: 50 });
      doc.font(headerFont).fontSize(18).text(labels.artistSummary);
      doc.moveDown(1);

      // Same wrapped/pending/in-progress classification as the app's own
      // Artist-Wise Summary view — cross-references each artist's call days
      // against which schedule days are actually marked completed, so the
      // printed sheet shows who's done and no longer needed on set.
      const completedByDayNumber = Object.fromEntries(schedule.scheduleDays.map((d) => [d.dayNumber, Boolean(d.completed)]));
      const statusColors = {
        wrapped: { bg: "#fdecea", text: "#b3261e", label: labels.wrapped },
        pending: { bg: "#fdf3e0", text: "#8a5a00", label: labels.pending },
        "in-progress": { bg: "#e8f0fe", text: "#1a56b0", label: labels.inProgress },
      };

      (schedule.artistSchedule ?? []).forEach((entry) => {
        const completedFlags = entry.days.map((d) => completedByDayNumber[d.dayNumber]);
        const allDone = completedFlags.every(Boolean);
        const noneDone = completedFlags.every((c) => !c);
        const status = statusColors[allDone ? "wrapped" : noneDone ? "pending" : "in-progress"];

        const chipText = status.label;
        doc.font(headerFont).fontSize(9);
        const chipWidth = doc.widthOfString(chipText) + 14;
        const chipY = doc.y;
        doc.rect(pageLeft, chipY, chipWidth, 16).fill(status.bg);
        doc.fillColor(status.text).text(chipText, pageLeft + 7, chipY + 4);
        doc.fillColor("#000");
        doc.font(headerFont).fontSize(13).text(entry.character, pageLeft + chipWidth + 8, chipY - 2);
        doc.moveDown(0.3);
        doc
          .font(bodyFont)
          .fontSize(11)
          .text(
            `${labels.totalDays}: ${entry.totalDays}  —  ${labels.days}: ${entry.days.map((d) => `Day ${d.dayNumber}${d.date ? ` (${formatDisplayDate(d.date)})` : ""}${completedByDayNumber[d.dayNumber] ? " (done)" : ""}`).join(", ")}`,
            { indent: 10 }
          );
        doc.moveDown(0.6);
      });
    }

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

// Same grid data as the PDF export above — one sheet per shoot day
// (transcribing the same episode/location group banners as merged rows
// ahead of that group's scenes), plus an Artist-Wise Summary sheet when
// this isn't scoped to a single day.
app.get("/api/shoot-schedule/:id/export-excel", requireLogin, async (req, res) => {
  const lang = req.query.lang === "or" ? "or" : "en";
  const dayFilter = req.query.day ? Number(req.query.day) : null;

  try {
    const idLookup = await db.query("SELECT scene_list_id FROM shoot_schedules WHERE id = $1", [req.params.id]);
    if (idLookup.rows.length === 0) {
      res.status(404).json({ error: "Shoot schedule not found" });
      return;
    }
    const result = await db.query(
      "SELECT scene_list_id, content FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [idLookup.rows[0].scene_list_id]
    );

    const { scene_list_id: sceneListId, content: schedule } = result.rows[0];
    if (dayFilter && !(schedule.scheduleDays ?? []).some((d) => d.dayNumber === dayFilter)) {
      res.status(404).json({ error: `Day ${dayFilter} was not found in this schedule.` });
      return;
    }
    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const sceneList = sceneListResult.rows[0]?.content ?? {};
    const isSeries = Boolean(sceneList.episodeScenes);

    const labels =
      lang === "or"
        ? {
            day: "ଦିନ", location: "ସ୍ଥାନ", cast: "କଳାକାର", notes: "ଟିପ୍ପଣୀ", artistSummary: "କଳାକାର-ଅନୁଯାୟୀ ସାରାଂଶ", totalDays: "ମୋଟ ଦିନ", days: "ଦିନଗୁଡ଼ିକ", completed: "ସମାପ୍ତ", costume: "ପୋଷାକ", properties: "ପ୍ରପର୍ଟି", adRemark: "AD ମନ୍ତବ୍ୟ",
            wrapped: "ସମାପ୍ତ", pending: "ବାକି", inProgress: "ଚାଲୁଛି", episode: "ଏପିସୋଡ୍", scenes: "ଦୃଶ୍ୟ", unspecified: "ଅନିର୍ଦ୍ଦିଷ୍ଟ", character: "ଚରିତ୍ର", status: "ସ୍ଥିତି",
          }
        : {
            day: "Day", location: "Location", cast: "Cast Called", notes: "Notes", artistSummary: "Artist-Wise Summary", totalDays: "Total Days", days: "Days", completed: "COMPLETED", costume: "Costume", properties: "Properties", adRemark: "AD Remark",
            wrapped: "WRAPPED", pending: "PENDING", inProgress: "IN PROGRESS", episode: "Episode", scenes: "scenes", unspecified: "Unspecified", character: "Character", status: "Status",
          };

    const breakdownResult = await db.query(
      "SELECT content FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    const adSheetRows = breakdownResult.rows[0]?.content?.adSheet ?? null;
    const castByIdentity = new Map();
    if (adSheetRows) {
      let flatIndex = 0;
      if (isSeries) {
        (sceneList.episodeScenes ?? []).forEach((episodeScene, episodeIndex) => {
          episodeScene.scenes.forEach((_, sceneIndex) => {
            castByIdentity.set(`e${episodeIndex}-s${sceneIndex}`, adSheetRows[flatIndex]);
            flatIndex += 1;
          });
        });
      } else {
        (sceneList.scenes ?? []).forEach((_, sceneIndex) => {
          castByIdentity.set(`s${sceneIndex}`, adSheetRows[flatIndex]);
          flatIndex += 1;
        });
      }
    }
    const notAvailableLabel = "—";

    const columns = [
      { header: "SC NO", key: "scn", width: 14 },
      { header: labels.location, key: "location", width: 28 },
      { header: labels.cast, key: "artist", width: 32 },
      { header: labels.costume, key: "costume", width: 30 },
      { header: labels.properties, key: "properties", width: 40 },
      { header: labels.adRemark, key: "adRemark", width: 30 },
    ];

    const workbook = new ExcelJS.Workbook();
    const scheduleDaysToRender = dayFilter
      ? schedule.scheduleDays.filter((d) => d.dayNumber === dayFilter)
      : schedule.scheduleDays;

    scheduleDaysToRender.forEach((day) => {
      const sheet = workbook.addWorksheet(`${labels.day} ${day.dayNumber}`.slice(0, 31));
      sheet.columns = columns;
      sheet.getRow(1).font = { bold: true };

      const dayTitle = `${day.date ? `${formatDisplayDate(day.date)} — ` : ""}${labels.day} ${day.dayNumber}${day.completed ? ` — ${labels.completed}` : ""} — ${labels.location}: ${day.location?.[lang] ?? ""}`;
      const titleRow = sheet.addRow({ scn: dayTitle });
      sheet.mergeCells(titleRow.number, 1, titleRow.number, columns.length);
      titleRow.font = { bold: true };
      titleRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: day.completed ? "FFFDECEA" : "FFEEF2F7" } };
      sheet.addRow({});

      groupSceneRefsForPdf(day.sceneRefs ?? [], sceneList, lang).forEach((episodeGroup) => {
        episodeGroup.locationGroups.forEach((locationGroup) => {
          const episodePrefix = episodeGroup.episodeIndex !== null ? `${labels.episode} ${episodeGroup.episodeIndex + 1} — ` : "";
          const bannerText = `${episodePrefix}${locationGroup.location || labels.unspecified} (${locationGroup.items.length} ${labels.scenes})`;
          const bannerRow = sheet.addRow({ scn: bannerText });
          sheet.mergeCells(bannerRow.number, 1, bannerRow.number, columns.length);
          bannerRow.font = { bold: true };
          bannerRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF2F7" } };

          locationGroup.items.forEach(({ ref, scene }) => {
            const identity = isSeries ? `e${ref.episodeIndex}-s${ref.sceneIndex}` : `s${ref.sceneIndex}`;
            const adSheetRow = castByIdentity.get(identity);
            const realSceneNumber = (scene.sceneNumber || String(ref.sceneIndex + 1)).replace(/^\s*(SCENE|SC)\.?\s*/i, "");
            const scn = isSeries ? `Ep${ref.episodeIndex + 1} ${realSceneNumber}` : realSceneNumber;
            const artist = adSheetRow ? (adSheetRow.mainCharacters ?? []).join(", ") || notAvailableLabel : (day.charactersNeeded ?? []).join(", ") || notAvailableLabel;
            const properties = [ref.properties, adSheetRow?.extras?.[lang]].filter(Boolean).join("; ");

            sheet.addRow({
              scn,
              location: `${scene.intExt}. ${scene.location?.[lang] ?? ""}`,
              artist,
              costume: ref.costume || notAvailableLabel,
              properties: properties || notAvailableLabel,
              adRemark: ref.adRemark || "",
            });
          });
        });
      });

      if (day.notes?.[lang]) {
        const notesRow = sheet.addRow({ scn: `${labels.notes}: ${day.notes[lang]}` });
        sheet.mergeCells(notesRow.number, 1, notesRow.number, columns.length);
      }
    });

    if (!dayFilter) {
      const summarySheet = workbook.addWorksheet(labels.artistSummary.slice(0, 31));
      summarySheet.columns = [
        { header: labels.character, key: "character", width: 22 },
        { header: labels.status, key: "status", width: 14 },
        { header: labels.totalDays, key: "totalDays", width: 12 },
        { header: labels.days, key: "days", width: 70 },
      ];
      summarySheet.getRow(1).font = { bold: true };

      const completedByDayNumber = Object.fromEntries(schedule.scheduleDays.map((d) => [d.dayNumber, Boolean(d.completed)]));
      const statusLabels = { wrapped: labels.wrapped, pending: labels.pending, "in-progress": labels.inProgress };

      (schedule.artistSchedule ?? []).forEach((entry) => {
        const completedFlags = entry.days.map((d) => completedByDayNumber[d.dayNumber]);
        const allDone = completedFlags.every(Boolean);
        const noneDone = completedFlags.every((c) => !c);
        const status = statusLabels[allDone ? "wrapped" : noneDone ? "pending" : "in-progress"];

        summarySheet.addRow({
          character: entry.character,
          status,
          totalDays: entry.totalDays,
          days: entry.days.map((d) => `Day ${d.dayNumber}${d.date ? ` (${formatDisplayDate(d.date)})` : ""}${completedByDayNumber[d.dayNumber] ? " (done)" : ""}`).join(", "),
        });
      });
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="shoot-schedule${dayFilter ? `-day-${dayFilter}` : ""}-${lang}-${formatExportTimestamp()}.xlsx"`
    );
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Shoot schedule Excel export failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
});

// A focused, single-day version of the four Script Breakdown category
// sheets — "just Day 2's costume/location/artist/property list" — built
// straight from that day's own sceneRefs (which already carry the
// costume/properties note per scene) rather than filtering the whole
// project's catalogs, since a day's breakdown is naturally scene-scoped.
app.get("/api/shoot-schedule/:id/export-day", requireLogin, async (req, res) => {
  const lang = req.query.lang === "or" ? "or" : "en";
  const dayNumber = Number(req.query.day);
  const category = req.query.category;
  const DAY_EXPORT_CATEGORIES = ["artists", "locations", "costumes", "properties"];

  if (!Number.isFinite(dayNumber)) {
    res.status(400).json({ error: "A day number is required." });
    return;
  }
  if (!DAY_EXPORT_CATEGORIES.includes(category)) {
    res.status(400).json({ error: "Unknown day-export category." });
    return;
  }

  try {
    // Same "always the latest revision" reasoning as the main export above.
    const idLookup = await db.query("SELECT scene_list_id FROM shoot_schedules WHERE id = $1", [req.params.id]);
    if (idLookup.rows.length === 0) {
      res.status(404).json({ error: "Shoot schedule not found" });
      return;
    }
    const result = await db.query(
      "SELECT scene_list_id, content FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [idLookup.rows[0].scene_list_id]
    );
    const { scene_list_id: sceneListId, content: schedule } = result.rows[0];
    const day = (schedule.scheduleDays ?? []).find((d) => d.dayNumber === dayNumber);
    if (!day) {
      res.status(404).json({ error: `Day ${dayNumber} was not found in this schedule.` });
      return;
    }

    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const sceneList = sceneListResult.rows[0]?.content ?? {};
    const isSeries = Boolean(sceneList.episodeScenes);
    const title = await fetchProjectTitleForSceneList(sceneListId, sceneList, lang);

    const bodyFont = lang === "or" ? "odiaRegular" : "Helvetica";
    const headerFont = lang === "or" ? "odiaBold" : "Helvetica-Bold";
    const labels =
      lang === "or"
        ? {
            artists: "କଳାକାର ବିଭାଜନ", locations: "ସ୍ଥାନ ବିଭାଜନ", costumes: "ପୋଷାକ ବିଭାଜନ", properties: "ସାମଗ୍ରୀ ବିଭାଜନ",
            day: "ଦିନ", episode: "ଏପିସୋଡ୍", scene: "ଦୃଶ୍ୟ", scenes: "ଦୃଶ୍ୟ", notCast: "ଏପର୍ଯ୍ୟନ୍ତ କାଷ୍ଟ ହୋଇନାହିଁ", none: "କିଛି ମିଳିଲା ନାହିଁ।",
          }
        : {
            artists: "Artist Breakdown", locations: "Location Breakdown", costumes: "Costume Breakdown", properties: "Property Breakdown",
            day: "Day", episode: "Episode", scene: "Scene", scenes: "scenes", notCast: "Not yet cast", none: "Nothing found for this day.",
          };

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.registerFont("odiaRegular", FONTS.odiaRegular);
    doc.registerFont("odiaBold", FONTS.odiaBold);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="day-${dayNumber}-${category}-${lang}-${formatExportTimestamp()}.pdf"`);
    doc.pipe(res);

    doc.font(headerFont).fontSize(20).text(`${title} — ${labels.day} ${dayNumber}`);
    doc.font(headerFont).fontSize(16).fillColor("#555").text(labels[category]);
    doc.fillColor("#000");
    doc.moveDown(1);

    if (category === "artists") {
      const characters = day.charactersNeeded ?? [];
      const castResult = await db.query(
        "SELECT character_name, name, contact_number FROM crew_members WHERE scene_list_id = $1 AND category = 'artist'",
        [sceneListId]
      );
      const castByCharacter = new Map(castResult.rows.map((row) => [row.character_name, row]));

      if (characters.length === 0) doc.font(bodyFont).fontSize(12).text(labels.none);
      characters.forEach((name) => {
        const cast = castByCharacter.get(name);
        doc.font(headerFont).fontSize(13).text(name);
        const playedByLine = cast
          ? `${cast.name}${cast.contact_number ? ` — ${cast.contact_number}` : ""}`
          : labels.notCast;
        doc.font(bodyFont).fontSize(11).text(playedByLine, { indent: 10 });
        doc.moveDown(0.6);
      });
    } else if (category === "locations") {
      const groups = groupSceneRefsForPdf(day.sceneRefs ?? [], sceneList, lang);
      let any = false;
      groups.forEach((episodeGroup) => {
        episodeGroup.locationGroups.forEach((locationGroup) => {
          any = true;
          const episodePrefix = episodeGroup.episodeIndex !== null ? `${labels.episode} ${episodeGroup.episodeIndex + 1} — ` : "";
          const intExt = locationGroup.items[0]?.scene?.intExt ?? "";
          doc.font(headerFont).fontSize(13).text(`${episodePrefix}${locationGroup.location}`);
          doc.font(bodyFont).fontSize(11).text(`${intExt} — ${locationGroup.items.length} ${labels.scenes}`, { indent: 10 });
          doc.moveDown(0.6);
        });
      });
      if (!any) doc.font(bodyFont).fontSize(12).text(labels.none);
    } else {
      // costumes / properties — one line per scene that actually has a
      // note for that field, in the day's own shoot order.
      const field = category === "costumes" ? "costume" : "properties";
      const refs = (day.sceneRefs ?? []).filter((ref) => ref[field]?.trim());
      if (refs.length === 0) doc.font(bodyFont).fontSize(12).text(labels.none);
      refs.forEach((ref) => {
        const scene = lookupSceneServerSide(sceneList, ref);
        const epLabel = isSeries ? `${labels.episode} ${ref.episodeIndex + 1}, ` : "";
        const sceneNumber = String(scene?.sceneNumber || ref.sceneIndex + 1).replace(/^\s*(SCENE|SC)\.?\s*/i, "");
        const sceneLabel = `${epLabel}${labels.scene} ${sceneNumber}`;
        doc.font(headerFont).fontSize(13).text(sceneLabel);
        doc.font(bodyFont).fontSize(11).text(ref[field], { indent: 10 });
        doc.moveDown(0.6);
      });
    }

    doc.end();
  } catch (error) {
    console.error("Day export failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
});

// Excel counterpart of the single-day category breakdown above — same
// per-category data, one row per entry instead of a flowing list.
app.get("/api/shoot-schedule/:id/export-day-excel", requireLogin, async (req, res) => {
  const lang = req.query.lang === "or" ? "or" : "en";
  const dayNumber = Number(req.query.day);
  const category = req.query.category;
  const DAY_EXPORT_CATEGORIES = ["artists", "locations", "costumes", "properties"];

  if (!Number.isFinite(dayNumber)) {
    res.status(400).json({ error: "A day number is required." });
    return;
  }
  if (!DAY_EXPORT_CATEGORIES.includes(category)) {
    res.status(400).json({ error: "Unknown day-export category." });
    return;
  }

  try {
    const idLookup = await db.query("SELECT scene_list_id FROM shoot_schedules WHERE id = $1", [req.params.id]);
    if (idLookup.rows.length === 0) {
      res.status(404).json({ error: "Shoot schedule not found" });
      return;
    }
    const result = await db.query(
      "SELECT scene_list_id, content FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [idLookup.rows[0].scene_list_id]
    );
    const { scene_list_id: sceneListId, content: schedule } = result.rows[0];
    const day = (schedule.scheduleDays ?? []).find((d) => d.dayNumber === dayNumber);
    if (!day) {
      res.status(404).json({ error: `Day ${dayNumber} was not found in this schedule.` });
      return;
    }

    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const sceneList = sceneListResult.rows[0]?.content ?? {};
    const isSeries = Boolean(sceneList.episodeScenes);

    const labels =
      lang === "or"
        ? {
            artists: "କଳାକାର ବିଭାଜନ", locations: "ସ୍ଥାନ ବିଭାଜନ", costumes: "ପୋଷାକ ବିଭାଜନ", properties: "ସାମଗ୍ରୀ ବିଭାଜନ",
            character: "ଚରିତ୍ର", playedBy: "କଳାକାର", contactNumber: "ଯୋଗାଯୋଗ ନମ୍ବର", notCast: "ଏପର୍ଯ୍ୟନ୍ତ କାଷ୍ଟ ହୋଇନାହିଁ",
            location: "ସ୍ଥାନ", intExt: "INT/EXT", sceneCount: "ଦୃଶ୍ୟ ସଂଖ୍ୟା", scene: "ଦୃଶ୍ୟ", notes: "ଟିପ୍ପଣୀ",
          }
        : {
            artists: "Artist Breakdown", locations: "Location Breakdown", costumes: "Costume Breakdown", properties: "Property Breakdown",
            character: "Character", playedBy: "Played By", contactNumber: "Contact Number", notCast: "Not yet cast",
            location: "Location", intExt: "INT/EXT", sceneCount: "Scene Count", scene: "Scene", notes: "Notes",
          };

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(labels[category].slice(0, 31));

    if (category === "artists") {
      sheet.columns = [
        { header: labels.character, key: "character", width: 24 },
        { header: labels.playedBy, key: "playedBy", width: 24 },
        { header: labels.contactNumber, key: "contactNumber", width: 18 },
      ];
      sheet.getRow(1).font = { bold: true };
      const characters = day.charactersNeeded ?? [];
      const castResult = await db.query(
        "SELECT character_name, name, contact_number FROM crew_members WHERE scene_list_id = $1 AND category = 'artist'",
        [sceneListId]
      );
      const castByCharacter = new Map(castResult.rows.map((row) => [row.character_name, row]));
      characters.forEach((name) => {
        const cast = castByCharacter.get(name);
        sheet.addRow({ character: name, playedBy: cast ? cast.name : labels.notCast, contactNumber: cast?.contact_number || "" });
      });
    } else if (category === "locations") {
      sheet.columns = [
        { header: labels.location, key: "location", width: 28 },
        { header: labels.intExt, key: "intExt", width: 10 },
        { header: labels.sceneCount, key: "sceneCount", width: 12 },
      ];
      sheet.getRow(1).font = { bold: true };
      groupSceneRefsForPdf(day.sceneRefs ?? [], sceneList, lang).forEach((episodeGroup) => {
        episodeGroup.locationGroups.forEach((locationGroup) => {
          const intExt = locationGroup.items[0]?.scene?.intExt ?? "";
          sheet.addRow({ location: locationGroup.location, intExt, sceneCount: locationGroup.items.length });
        });
      });
    } else {
      // costumes / properties — one row per scene that actually has a note.
      sheet.columns = [
        { header: labels.scene, key: "scene", width: 18 },
        { header: labels[category], key: "note", width: 55 },
      ];
      sheet.getRow(1).font = { bold: true };
      const field = category === "costumes" ? "costume" : "properties";
      (day.sceneRefs ?? []).filter((ref) => ref[field]?.trim()).forEach((ref) => {
        const scene = lookupSceneServerSide(sceneList, ref);
        const epLabel = isSeries ? `Ep${ref.episodeIndex + 1} ` : "";
        const sceneNumber = String(scene?.sceneNumber || ref.sceneIndex + 1).replace(/^\s*(SCENE|SC)\.?\s*/i, "");
        sheet.addRow({ scene: `${epLabel}${sceneNumber}`, note: ref[field] });
      });
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="day-${dayNumber}-${category}-${lang}-${formatExportTimestamp()}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Day Excel export failed:", error.message);
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
// column); 'art_department' / 'costume_department' / 'direction_team' /
// 'production_team' are each that department's crew; 'crew' is the
// catch-all "other/additional crew" list for anyone who doesn't fit the
// named departments. All eight are the same shape — only the frontend
// renders/groups them differently.
const CREW_CATEGORIES = [
  "artist",
  "location",
  "art_department",
  "costume_department",
  "direction_team",
  "production_team",
  "crew",
];

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

// The Director's status view: everything is derived straight from data that
// already exists elsewhere, never a separate "finalized" flag to remember to
// flip — a character/location is "finalized" purely because the production
// team has already attached a real crew_members entry to it (the same
// InlineCastAttachment add-flow used everywhere else), and a scene is "shot"
// purely because it sits inside a shoot-schedule day marked completed. So the
// moment production adds an actor or records a completed shoot day, this view
// updates itself with no extra step.
function computeDirectorOverview(sceneList, breakdownContent, shootSchedule, crewMembers) {
  const castFinalized = new Set(
    crewMembers.filter((m) => m.category === "artist").map((m) => m.characterName.toLowerCase())
  );
  const locationFinalized = new Set(
    crewMembers.filter((m) => m.category === "location").map((m) => m.characterName.toLowerCase())
  );

  const characters = (breakdownContent?.artistList ?? []).map((item) => ({
    label: item.label,
    age: item.age ?? null,
    gender: item.gender ?? null,
    finalized: castFinalized.has(item.label.toLowerCase()),
  }));

  const locations = (breakdownContent?.locationList ?? []).map((item) => ({
    label: item.location?.en ?? "",
    intExt: item.intExt,
    finalized: locationFinalized.has((item.location?.en ?? "").toLowerCase()),
  }));

  const crewRoster = crewMembers
    .filter((m) => !["artist", "location"].includes(m.category))
    .map((m) => ({ name: m.name, role: m.role, contactNumber: m.contactNumber, category: m.category }));

  // Reuses the exact same "e{episodeIndex}-s{sceneIndex}" identity scheme the
  // shoot-schedule generator already verifies coverage against, so a scene
  // only counts as shot when it's inside a day the AD has actually marked
  // completed — a scheduled-but-not-yet-shot day doesn't count.
  const isSeries = Boolean(sceneList.episodeScenes);
  const shotIdentities = new Set();
  (shootSchedule?.scheduleDays ?? [])
    .filter((day) => day.completed)
    .forEach((day) =>
      (day.sceneRefs ?? []).forEach((ref) => {
        shotIdentities.add(isSeries ? `e${ref.episodeIndex}-s${ref.sceneIndex}` : `s${ref.sceneIndex}`);
      })
    );

  const identities = allSceneIdentities(sceneList);
  const scenes = flattenScenesForAdSheet(sceneList).map((scene, index) => ({
    episodeLabel: scene.episodeLabel,
    sceneNumber: scene.sceneNumber,
    oneLiner: scene.oneLiner?.en ?? "",
    shot: shotIdentities.has(identities[index]),
  }));

  return {
    cast: {
      finalizedCount: characters.filter((c) => c.finalized).length,
      totalCount: characters.length,
      characters,
    },
    locations: {
      finalizedCount: locations.filter((l) => l.finalized).length,
      totalCount: locations.length,
      locations,
    },
    crewRoster,
    scenes: {
      shotCount: scenes.filter((s) => s.shot).length,
      totalCount: scenes.length,
      scenes,
    },
  };
}

app.get("/api/scene-lists/:sceneListId/director-overview", requireLogin, async (req, res) => {
  const { sceneListId } = req.params;
  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
  if (sceneListResult.rows.length === 0) {
    res.status(404).json({ error: "Scene list not found" });
    return;
  }

  const [breakdownResult, scheduleResult, crewResult] = await Promise.all([
    db.query("SELECT content FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1", [sceneListId]),
    db.query("SELECT content FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1", [sceneListId]),
    db.query("SELECT * FROM crew_members WHERE scene_list_id = $1", [sceneListId]),
  ]);

  const overview = computeDirectorOverview(
    sceneListResult.rows[0].content,
    breakdownResult.rows[0]?.content ?? null,
    scheduleResult.rows[0]?.content ?? null,
    crewResult.rows.map(serializeCrewMember)
  );

  res.json(overview);
});

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

// One combined sheet across every category (cast, locations, art/costume
// department, general crew) — a department head or the director wants a
// single phone-book-style list, not five separate category exports.
app.get("/api/crew/export-excel", requireLogin, async (req, res) => {
  const lang = req.query.lang === "or" ? "or" : "en";

  if (!(await userOwnsSceneList(req.user, req.query.sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const categoryLabels = lang === "or"
    ? { artist: "କଳାକାର", location: "ସ୍ଥାନ", art_department: "ଆର୍ଟ ବିଭାଗ", costume_department: "ପୋଷାକ ବିଭାଗ", direction_team: "ନିର୍ଦ୍ଦେଶନା ଦଳ", production_team: "ପ୍ରଡକ୍ସନ୍ ଦଳ", crew: "ଅନ୍ୟାନ୍ୟ କ୍ରୁ" }
    : { artist: "Artist", location: "Location", art_department: "Art Department", costume_department: "Costume Department", direction_team: "Direction Team", production_team: "Production Team", crew: "Other / Additional Crew" };
  const columnLabels = lang === "or"
    ? { category: "ବିଭାଗ", linkedTo: "ଚରିତ୍ର/ସ୍ଥାନ", name: "ନାମ", role: "ପଦବୀ", contactNumber: "ଯୋଗାଯୋଗ ନମ୍ବର" }
    : { category: "Category", linkedTo: "Character / Location", name: "Name", role: "Role", contactNumber: "Contact Number" };

  try {
    // Cast is excluded — it's already shown against each character in the
    // Script Breakdown's Artist List, so this sheet stays crew-only rather
    // than replicating it.
    const result = await db.query(
      "SELECT category, character_name, name, role, contact_number FROM crew_members WHERE scene_list_id = $1 AND category != 'artist' ORDER BY category, created_at ASC",
      [req.query.sceneListId]
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(lang === "or" ? "କ୍ରୁ ଓ କାଷ୍ଟ" : "Cast & Crew");
    sheet.columns = [
      { header: columnLabels.category, key: "category", width: 20 },
      { header: columnLabels.linkedTo, key: "linkedTo", width: 28 },
      { header: columnLabels.name, key: "name", width: 24 },
      { header: columnLabels.role, key: "role", width: 22 },
      { header: columnLabels.contactNumber, key: "contactNumber", width: 18 },
    ];
    sheet.getRow(1).font = { bold: true };

    result.rows.forEach((row) => {
      sheet.addRow({
        category: categoryLabels[row.category] || row.category,
        linkedTo: row.character_name || "",
        name: row.name,
        role: row.role || "",
        contactNumber: row.contact_number || "",
      });
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="cast-and-crew-${lang}-${formatExportTimestamp()}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Cast & Crew Excel export failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
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

// Catches every error thrown or rejected inside a route handler (including
// async ones, via express-async-errors above). Without this, an unhandled
// rejection anywhere — a bad DB query, a storage upload failure, a Gemini
// API error — would crash the entire Node process and take the whole app
// down for every user until it's manually restarted, rather than just
// failing the one request that hit it.
app.use((err, req, res, next) => {
  console.error(`Error on ${req.method} ${req.path}:`, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || "Something went wrong on the server." });
});

// Last-resort safety net for errors outside the request/response cycle
// (e.g. a fire-and-forget promise). Logs instead of crashing the process.
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

app.listen(PORT, () => {
  console.log(`Backend server running at http://localhost:${PORT}`);
});
