import "dotenv/config";
import express from "express";
import "express-async-errors";
import cors from "cors";
import { GoogleGenAI, Type } from "@google/genai";
import { Pool } from "pg";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel } from "docx";
import path from "path";
import fs from "fs";
import fsPromises from "fs/promises";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import { XMLParser } from "fast-xml-parser";
import AdmZip from "adm-zip";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import { createClient } from "@supabase/supabase-js";
import {
  AKHADA_FIXED_SYNOPSIS,
  AKHADA_FIXED_CHARACTERS,
  AKHADA_FIXED_THREE_ACT,
  AKHADA_FIXED_BEATS,
} from "./reference-material/akhada/fixed-stage-content.js";

const app = express();
// Render (and most hosts) assign the port dynamically via $PORT — 4000
// stays as the local dev default.
const PORT = process.env.PORT || 4000;
// This backend's own public URL — used to build the Google OAuth redirect
// URI. Defaults to local dev; set to the deployed Render URL in production.
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

// Two supported ways to authenticate to Gemini: a plain AI Studio API key
// (GEMINI_API_KEY), or a Google Cloud service-account key for Vertex AI
// (GOOGLE_SERVICE_ACCOUNT_JSON — the full JSON key file's contents, as a
// single-line env var). Vertex AI billing is separate from AI Studio's
// prepaid-credit system, which is why this exists — switch to it if AI
// Studio credits run out. The service account's own project_id is used
// directly, so no separate project env var is needed.
const googleServiceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const googleServiceAccount = googleServiceAccountJson ? JSON.parse(googleServiceAccountJson) : null;
const ai = googleServiceAccount
  ? new GoogleGenAI({
      vertexai: true,
      project: googleServiceAccount.project_id,
      location: process.env.GOOGLE_CLOUD_LOCATION || "us-central1",
      googleAuthOptions: { credentials: googleServiceAccount },
    })
  : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Silent otherwise: a misspelled/missing env var would fall back to the free
// AI Studio key with zero indication anything was wrong, which is exactly
// the kind of "did my Vertex AI switch actually take effect?" question this
// line exists to answer from Render's logs.
console.log(
  googleServiceAccount
    ? `Using Vertex AI (project: ${googleServiceAccount.project_id}, location: ${process.env.GOOGLE_CLOUD_LOCATION || "us-central1"})`
    : "Using AI Studio free-tier Gemini API key (GOOGLE_SERVICE_ACCOUNT_JSON not set)"
);

// The AI Studio "-latest" alias doesn't resolve on Vertex AI, so every call
// in this file uses this constant (a real, explicit model id valid on both
// AI Studio and Vertex AI) instead of a literal model name.
const GEMINI_MODEL_NAME = "gemini-2.5-flash-lite";
// AI Movie's final Write Dialogue pass only (the user's own call): that one
// prompt carries by far the longest rule list in the app -- natural Hindi
// code-switching, the NARRATOR, camera direction, subtext, the closing
// button, screen-only writing, headings/names -- and a real scene showed
// Flash-Lite dropping several of those rules at once. Everything else
// stays on the cheaper GEMINI_MODEL_NAME above.
const AI_MOVIE_DIALOGUE_MODEL_NAME = "gemini-2.5-flash";
// The screenplay first-draft writer and its "write more scenes" step (used
// by fill-to-target and Extend) also use 2.5 Flash -- the user's call after
// a real Akhada test run: on Flash-Lite, Beat 1 came out at 0.4 of its 2.5
// minutes (or borrowed later beats), while 2.5 Flash reached 2.2 minutes
// with scenes that all genuinely belonged to Beat 1. Slower and costs more
// per call, but this is where screenplay quality is decided.
const AI_MOVIE_SCREENPLAY_WRITER_MODEL_NAME = "gemini-2.5-flash";
// The story writers (storylines, pitch deck, character sheet, three-act,
// bit sheet, scene list) — shared by the Movie stages and the automatic
// pipeline. Also 2.5 Flash (the user's call, 2026-10-06): in a real
// automatic run the Bit Sheet writer on Flash-Lite stayed at 5/10 for all
// three revision rounds — it couldn't act on the story editor's notes.
const STORY_WRITER_MODEL_NAME = "gemini-2.5-flash";
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

// Self-healing schema check for the AI Movie tables, run automatically on
// every server start (which Render does on every deploy). This exists
// because this sandbox has no network access to the live Supabase
// database — every AI Movie table/column added here mid-session needed a
// separate manual "run this SQL in Supabase" step from the user, and it
// kept recurring on each new feature. From here on, an AI Movie schema
// change shipped in code takes effect on the live database automatically
// the moment it deploys — every statement below is idempotent (IF NOT
// EXISTS), safe to run on every single startup. When a future change adds
// another AI Movie column/table, add its statement here too, not just to
// schema.sql, so this keeps actually being the fix.
async function ensureAiMovieSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS ai_movie_projects (
      id SERIAL PRIMARY KEY,
      title TEXT,
      pasted_text TEXT NOT NULL,
      detected_stage TEXT,
      backfill JSONB,
      assets JSONB,
      stage_status JSONB NOT NULL DEFAULT '{}',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `ALTER TABLE ai_movie_projects ADD COLUMN IF NOT EXISTS stage_status JSONB NOT NULL DEFAULT '{}'`,
    `CREATE TABLE IF NOT EXISTS ai_movie_reference_files (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
      category TEXT NOT NULL DEFAULT 'other',
      label TEXT,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  ];

  for (const statement of statements) {
    try {
      await db.query(statement);
    } catch (error) {
      console.error("AI Movie schema self-heal step failed (server will still start):", error.message);
    }
  }
  console.log("AI Movie schema check complete.");
}

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

// A real "stuck at 95% forever" was traced back to this call having no
// timeout at all — if Gemini/Vertex ever stalls (no error, just never
// responds), nothing here ever finds out, so the whole request (and the
// frontend poll waiting on it) hangs until it gives up on its own. This
// bounds every attempt to GEMINI_CALL_TIMEOUT_MS and treats a timeout the
// same as a 429/503 — worth retrying, not a reason to give up immediately.
//
// 90s turned out to be too tight: a real 166KB/13-episode script's own
// first-pass breakdown call (the whole script, all 5 categories,
// trilingual) legitimately runs past 90s on its own, with no stall at all
// — so EVERY attempt (and every retry, since a retry repeats the exact
// same call) kept getting killed by this timeout before Gemini could ever
// actually finish, which is a big part of why analysis never completed.
// withTimeout also can't cancel the underlying request, so a premature
// timeout doesn't even free up the in-flight call — it just piles a
// redundant one on top, making the rate-limit exhaustion worse, not
// better. Raised with real margin above the observed range instead of
// nudged up incrementally, to actually stop recurring.
const GEMINI_CALL_TIMEOUT_MS = 240_000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gemini call timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// Every Gemini/Vertex call already retries a 429 several times (see
// generateContentWithRetry above), but a SUSTAINED quota exhaustion — the
// whole Google Cloud project out of budget, not just one burst — outlasts
// that retry budget and the raw error (a nested JSON blob with a Google
// Cloud docs URL) ends up on screen verbatim, which reads as the app being
// broken rather than what it actually is: a real, external quota limit
// that needs to be checked/raised in Google Cloud Console, not a bug here.
function friendlyGeminiErrorMessage(rawMessage) {
  if (/RESOURCE_EXHAUSTED|"code":\s*429/.test(rawMessage ?? "")) {
    return "The AI service's usage quota is temporarily exhausted (this is a Google Cloud limit, not an app bug). This usually clears on its own within a few minutes to an hour — please try again shortly. If it keeps happening, the project's Vertex AI quota may need to be raised in Google Cloud Console.";
  }
  return rawMessage;
}

async function generateContentWithRetry(params, { retries = 4, fallbackDelayMs = 2000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTimeout(ai.models.generateContent(params), GEMINI_CALL_TIMEOUT_MS);
    } catch (error) {
      const transient = /"code":\s*(429|503)/.test(error.message ?? "") || /timed out after/.test(error.message ?? "");
      if (!transient || attempt >= retries) throw error;
      const delay = parseRetryDelayMs(error.message) ?? fallbackDelayMs * 2 ** attempt;
      console.error(`Gemini call failed (${error.message.slice(0, 100)}...), retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Gemini occasionally emits a malformed escape sequence inside an otherwise
// well-formed JSON response (seen in testing: "Bad Unicode escape" on a
// large 20-episode scene-list batch) — a content glitch, not a transient
// HTTP error, so generateContentWithRetry's 429/503 retry doesn't cover it.
// This retries the WHOLE generation call (a fresh attempt usually doesn't
// repeat the same glitch) whenever JSON.parse itself fails, on top of that
// existing transient-error retry.
const MAX_GEMINI_OUTPUT_TOKENS = 65536;

async function generateJsonContent(params, { jsonRetries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= jsonRetries; attempt++) {
    let response;
    try {
      // generateContentWithRetry has its own 429/503 retry, but a call this
      // loop wraps can still exhaust that inner budget (seen for real: 3
      // large concurrent script-breakdown calls tripped Vertex's own
      // RESOURCE_EXHAUSTED, which killed the call outright on the very
      // first outer attempt since this used to sit OUTSIDE the try). It's
      // now inside the loop too, so a persistent-but-not-permanent quota
      // hiccup gets a few more spaced-out attempts instead of failing the
      // whole calling function immediately.
      response = await generateContentWithRetry(params);
      return JSON.parse(response.text);
    } catch (error) {
      lastError = error;
      // Cut off for running out of room (finish reason MAX_TOKENS): the same
      // request would just be cut off again, so the next try gets double
      // the room, up to the models' 65,536 maximum. Seen for real: a long
      // film's English/Odia/Hindi scene list stopping mid-answer, all 4 tries.
      const cutOff = response?.candidates?.[0]?.finishReason === "MAX_TOKENS";
      const currentLimit = params.config?.maxOutputTokens;
      if (cutOff && currentLimit && currentLimit < MAX_GEMINI_OUTPUT_TOKENS) {
        const biggerLimit = Math.min(MAX_GEMINI_OUTPUT_TOKENS, currentLimit * 2);
        console.error(`Answer was cut off at ${currentLimit} tokens -- retrying with room for ${biggerLimit}.`);
        params = { ...params, config: { ...params.config, maxOutputTokens: biggerLimit } };
      }
      // Log a bounded snippet of the actual broken text (not just the parse
      // error) — the error alone only ever says "unterminated string at
      // position N", which isn't enough on its own to tell a genuine
      // truncation (budget too low) apart from a malformed escape mid-string
      // (a content glitch), and diagnosing this blind wastes a full pipeline
      // run each time it recurs. Only applies when a response actually came
      // back and JSON.parse itself failed — a generateContentWithRetry
      // throw (e.g. a sustained 429) never reached that point.
      if (response) {
        const snippetStart = Math.max(0, (error.message.match(/position (\d+)/)?.[1] ?? 0) - 120);
        console.error(
          `JSON parse failed (attempt ${attempt + 1}/${jsonRetries + 1}, finish reason: ${response.candidates?.[0]?.finishReason ?? "unknown"}): ${error.message}\nNear-failure snippet: ${response.text?.slice(snippetStart, snippetStart + 240)}\nResponse length: ${response.text?.length}`
        );
      } else {
        console.error(`Gemini call failed (attempt ${attempt + 1}/${jsonRetries + 1}): ${error.message}`);
      }
    }
  }
  throw lastError;
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
  hindiRegular: path.join(FONTS_DIR, "NotoSansDevanagari-Regular.ttf"),
  hindiBold: path.join(FONTS_DIR, "NotoSansDevanagari-Bold.ttf"),
  displayRegular: path.join(FONTS_DIR, "PlayfairDisplay-Regular.ttf"),
  displayBold: path.join(FONTS_DIR, "PlayfairDisplay-Bold.ttf"),
  impact: path.join(FONTS_DIR, "Anton-Regular.ttf"),
};

const STORY_AGENT_SYSTEM_PROMPT = `You are the Story & Screenplay Agent, an experienced story writer and screenwriter specializing in Odia (Odisha) cinema — the dramatic sensibility, family and social dynamics, festivals (Rath Yatra, Nuakhai, Raja), rural and coastal settings, and cultural texture of Odisha, in the tradition of Ollywood rather than generic Hollywood plot patterns.

When given a raw concept, generate exactly 3 distinct storyline directions grounded in authentic Odia cultural context (settings, names, relationships, social themes) unless the concept explicitly asks for something else. For each storyline, write the title, logline, and summary in THREE languages — English, Odia (Odia script), and Hindi (Devanagari script) — each a natural, native-quality version, not a literal word-for-word translation of the others.`;

const PITCH_DECK_SYSTEM_PROMPT = `You are the Story & Screenplay Agent, specializing in Odia (Odisha) cinema. Once a storyline is chosen, format it into a full, producer-ready pitch deck — detailed enough that a producer could actually evaluate and greenlight it, not just a one-line plot summary. Include:
- A one-page (or two-page, only if genuinely needed) narrative "story" section — the single most important part of the whole deck, since a real producer will read this closely and skim everything else. See detailed instructions below.
- A one-paragraph premise, the tone/genre, and the target audience.
- The major characters who actually drive the story (not a full cast list; how many is given in the request). For each: a name (a proper noun, stays the same in both languages), a short role/descriptor (e.g. "the reluctant elder brother"), their emotional core (what they secretly want or fear beneath the surface), and their central conflict (what stands in their way, internally or externally).
- For a web series, an elaborated synopsis per episode that genuinely establishes the whole episode — what it opens on, the complication that develops through it, and how it turns or ends (ideally on a hook into the next episode) — long enough that someone could actually picture the episode, not just guess its topic from one line.
Keep it grounded in authentic Odia cultural context. Write everything in THREE languages — English, Odia (Odia script), and Hindi (Devanagari script) — each a natural, native-quality version, not a literal translation of the others.
Write the ENGLISH text in plain, everyday words throughout — every section, not just the story pages. This will often be read by someone who isn't a fluent English speaker, so avoid literary or "impressive" vocabulary (no words like "ostracized", "ubiquitous", "harbinger", "ineffable", "salvage", "utilize", "myriad") — use the simple word a person would actually say out loud instead ("left out", "everywhere", "sign", "save", "use", "many"). Keep sentences short and direct. This is about word choice, not about making the story simple or less engaging — the story itself should still be vivid and gripping, just told in plain language anyone can follow on a first read.`;

// The producer explicitly said this is the ONE page that actually gets read
// closely and decides whether a story gets backed at all — nobody reads a
// 25-episode breakdown before deciding whether they like a story. So this
// is deliberately the most carefully-specified instruction in the whole
// pitch deck prompt: real narrative storytelling prose, not another dry
// summary restating the premise.
const PITCH_DECK_STORY_PAGES_INSTRUCTION = `Also give "storyPages" — this is the single most important thing in the entire pitch deck, more important than the premise, the character list, or any episode breakdown, because it is the one piece a producer or investor will actually read closely before deciding whether they like this story at all. Write it as genuine, vivid narrative storytelling — real scenes, real turns, real emotional stakes — never a dry restatement of the premise, never a bullet-style beat list, and never generic marketing language ("an emotional rollercoaster", "a story that will touch hearts"). Open with a hook that immediately pulls the reader in. Across the piece, make sure it clearly delivers:
- How the story actually FLOWS from beginning to end — the real shape of the journey, not just the setup.
- The central relationships: who they are to each other, and how that bond is tested, changes, breaks, or deepens.
- The emotional course of the story: what the characters want, fear, lose, and ultimately gain or fail to gain.
- The key situations and conflicts they are forced into, and what raises the stakes at each turn.
- A sense of where it is all heading and how it lands — the reader should finish this feeling the shape of the whole story, not just its opening.
It MUST tell the whole story through the central conflict, the climax and the ending — never stop at the set-up or end on a teaser line; a producer has to see how it ends. (Seen for real: story pages that stopped right after the set-up, so the story judge could never see the core conflict.)
Return it as an array of 1 or 2 items — each item is one full page of prose, roughly 350-450 words. Only use 2 pages if the story genuinely has enough distinct dramatic movement to need it; a strong 1-page version is preferred over padding to 2. If you do write 2 pages, page 2 must continue directly where page 1 left off — the two pages should read as one continuous piece of writing, never repeating or re-summarizing what page 1 already covered.
Since this is the page that actually gets read, the ENGLISH must be in plain, simple, everyday words — someone who isn't a fluent English speaker needs to follow it easily on a first read. Do NOT reach for literary or "impressive" vocabulary to make the writing sound polished (avoid things like "ostracized", "salvage", "utilize", "harbinger", "myriad", "ineffable") — say it the plain way instead ("left out", "save", "use", "many", "hard to describe"). The vividness should come from real, specific detail and genuine emotional stakes, never from fancy word choice.`;

const THREE_ACT_SYSTEM_PROMPT = `You are the Story & Screenplay Agent, specializing in Odia (Odisha) cinema. After producer approval, break the approved story into a three-act structure — Setup, Confrontation, Resolution — with named key beats in each act.

Before the acts, state the story's Controlling Idea (its theme) as ONE precise sentence combining a VALUE and a CAUSE: the value (positive or negative — justice, love, corruption, loyalty, etc.) that the story's ending brings into the world, plus the specific reason the ending turns out that way (e.g. "Loyalty triumphs over greed because Dibakar chooses gratitude over self-preservation"). Derive it by looking at how the Resolution actually plays out — don't pick a generic topic word like "family" or "justice" alone, state the value AND why it happens. This Controlling Idea should then act as a filter: every act, and later every beat and scene, should serve or test this idea, not wander from it.

For a web series, also break down each individual episode into its own mini three-act structure, consistent with that episode's synopsis and with the overall series arc — episodes share the ONE overall Controlling Idea from the whole series, not their own separate themes. Keep it grounded in authentic Odia cultural context. Write everything in THREE languages — English, Odia (Odia script), and Hindi (Devanagari script) — each a natural, native-quality version, not a literal translation of the others.`;

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

Keep everything grounded in authentic Odia cultural context. Write all text fields in THREE languages — English, Odia (Odia script), and Hindi (Devanagari script) — each a natural, native-quality version, not a literal translation of the others. Character names stay the same proper noun across all three languages.`;

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

For each bit, give which act it belongs to, which beat type best describes it, a short title, and a one-to-two sentence description of what happens. Keep it grounded in authentic Odia cultural context. Write the title and description in THREE languages — English, Odia (Odia script), and Hindi (Devanagari script) — each a natural, native-quality version, not a literal translation of the others.`;

const SCENE_SYSTEM_PROMPT = `You are the Story & Screenplay Agent, specializing in Odia (Odisha) cinema. Once a Bit Sheet is approved, expand it into a full scene-by-scene list: each major plot-point bit typically becomes 1-3 scenes. For each scene, give which act it belongs to, a scene heading (interior or exterior, a location, and time of day), a single-sentence one-liner describing what happens, and your best estimate of that scene's on-screen duration in minutes. The "location" field must be JUST the place name (e.g. "Cuttack Street Market") — never include "DAY", "NIGHT", "DAWN", or any time-of-day wording in it, since time of day is always its own separate field limited to exactly DAY or NIGHT (use DAY for dawn/dusk). You will always be given a target total runtime — the combined duration of all the scenes you generate must add up to approximately that target; never limit the number of scenes to an arbitrary small count when the target runtime calls for more. Vary individual scene lengths realistically (quick transitional or action beats might be 0.5-1 minute, pivotal dialogue or emotional scenes might run 3-5 minutes) rather than making every scene the same length. When given the story's Controlling Idea (theme), keep every scene consistent with it — a scene that contradicts or ignores the theme entirely usually doesn't belong. Keep locations, character actions, and cultural texture grounded in authentic Odia settings.

EVERY scene must also genuinely earn its place. For each scene, also give:
- "purpose": either "plot_advancing" (the scene's main job is to move the story forward) or "character_revealing" (the scene's main job is to show who a character really is under pressure). Pick whichever is the scene's true primary job — a scene that does neither doesn't belong in the list.
- "turn": a short phrase naming the scene's value-shift — what changes emotionally or dramatically from the start of the scene to its end (e.g. "trust turns to suspicion," "despair turns to resolve," "confidence turns to fear"). A scene with no real turn is usually flat; reconsider it rather than forcing a fake one.

Write the location name, one-liner, and turn in THREE languages — English, Odia (Odia script), and Hindi (Devanagari script) — each a natural, native-quality version, not a literal translation of the others.`;

const BILINGUAL_TEXT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    en: { type: Type.STRING },
    or: { type: Type.STRING },
    hi: { type: Type.STRING },
  },
  required: ["en", "or", "hi"],
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

// The final screenplay's dialogue language is a per-generation choice (the
// Director picks English/Odia/Hindi when writing each scene) — everything
// ELSE in the screenplay (action lines, scene description, transitions,
// character names) always stays in English regardless of that choice. This
// is a deliberate, narrower scope than the rest of the app's trilingual
// content: the user explicitly asked for dialogue-only translation here,
// not a fully trilingual screenplay.
const SCREENPLAY_BASE_PROMPT = `You are the Story & Screenplay Agent, specializing in Odia (Odisha) cinema. Once the scene list is approved, expand ONE scene at a time into full screenplay format — action lines describing what's seen/heard, and dialogue attributed to a named character — using standard screenplay conventions. Write scene-by-scene, never the whole film at once.

Action lines, scene description, and transitions are ALWAYS written in plain English, no matter what language the dialogue below is in — never translate these into Odia or Hindi. A character's name is a proper noun and always stays in English/Latin script. Action lines should be visual and concise, present tense, no camera angles or editing directions like "ANGLE ON" or "CLOSE ON". Stay consistent with any character names and voice already established in earlier scenes you're shown.

NEVER write the scene heading/slugline (e.g. "INT. KITCHEN - NIGHT") as one of your elements — the app already displays that heading on its own, separately from your content. Your very first element must jump straight into actual action or dialogue, never restate where or when the scene takes place.

Alongside "elements", also return "charactersPresent": every character who is physically in the scene, not just whoever speaks — a real Odia shooting script always lists this under the scene heading as "Characters: X, Y, Z" (matching how the app renders it), so someone who's silently there (or briefly glimpsed, or present but not part of the dialogue) still belongs in this list.

AVOID reflexive genre-stock description shorthand — phrases like "eyes narrow", "jaw clenches", "marble floor", "victorious smile", or any other generic gesture reached for on autopilot. Ground each scene's action description in specific, concrete detail the camera can see and the microphone can hear, unique to THIS scene's actual location, character, and moment, never an interchangeable stock line that could be pasted into any other scene in the story. If you're shown phrases already overused earlier in this same story below, do not reuse them or close variants — find a fresh, specific way to convey the same beat.

Use "characterModifier" on a dialogue element when it genuinely applies: "CONT'D" if the same character keeps speaking after a brief action beat interrupted them without leaving the scene, "O.S." if they're heard but not seen on screen, "V.O." for narration, an inner thought, or a phone/recording voice, "ECHOING" for a remembered line from a past scene or a character who isn't physically present, replaying in another character's mind (distinct from V.O. — this is specifically a memory echoing back, not present-tense narration). Use "none" otherwise — most dialogue needs no modifier.

You may add a "flashback" element when a brief memory genuinely intrudes on the present scene: give "character" as whose POV/memory it is, and "text" describing what's remembered (rendered as "FLASH - [CHARACTER]'S POV:" followed by the description, always in English). An ECHOING dialogue element often follows a flashback element, giving voice to what's being remembered. You may also add ONE "transition" element (text like "CUT TO:", "CUT FLASH:", "TRANSITION SHOT.", "MATCH CUT TO:", or "DISSOLVE TO:") at the very end of a scene's elements, but only when a specific transition is dramatically meaningful, not as routine punctuation on every scene. Transition text is a technical screenplay marker, always in English, never translated.

EVERY "dialogue" element MUST have a real, non-empty "character" naming exactly who is speaking (matching a name already established for this story) — never leave it blank, generic, or omitted. A screenplay where the reader can't tell who's talking is unusable on set. For "action", "transition", and "flashback" elements, "character" only applies to "flashback" (whose memory it is); leave it as an empty string for "action" and "transition".

CONTINUITY OF OBJECTS AND REVEALS: you are shown the full scene-by-scene outline for this exact reason — before writing, check it for any prop, document, injury, secret, or reveal that this scene's one-liner connects to in an earlier or later scene, and make sure it's planted, referenced, and paid off consistently (an object introduced in one scene should still exist/matter if a later scene's outline depends on it; a reveal shouldn't come out of nowhere if the outline shows it was seeded earlier). Don't invent a new unearned twist that the outline doesn't support.

SHOW, DON'T TELL: never name a character's emotion directly in an action line ("he feels betrayed", "she is nervous") — dramatize it through a specific physical action, choice, or reaction instead. Keep the protagonist active: even in a scene where they're being manipulated, pressured, or outmatched, give them a real choice, reaction, or small act of resistance/agency in the moment, rather than having them simply absorb what's happening to them.`;

const SCREENPLAY_DIALOGUE_CRAFT = {
  en: `DIALOGUE LANGUAGE FOR THIS SCENE: English. Write dialogue (and any "parenthetical") in natural, contemporary spoken English — the way real people actually talk, never a stiff or literary register.
- EVERY LINE MUST CARRY EMOTION, NOT JUST INFORMATION. Never write dialogue as flat, cut-to-cut information-passing (character A states a fact, character B states the next fact). Real people hesitate, deflect, repeat themselves, ask questions instead of answering, or say something adjacent to what they mean when they're upset, scared, or holding something back. Preserve every beat of drama already established in the scene's one-liner and turn — do not summarize or compress it into fewer, flatter lines.
- Sentences are often short, broken, and imperfect — trailing off, repeating a word for emphasis, talking over each other — the way people actually speak, not complete grammatical sentences.
- Speech register must match the character: a security guard, a strict grandmother, a nagging in-law, joking office colleagues, and a frightened teenager should all sound distinctly different from each other in vocabulary, formality, and rhythm — never one uniform "polite" voice for everyone.
- Tense or emotional dialogue tends to get clipped and urgent rather than eloquent.
- Real dialogue lines are often shorter than you'd guess — many effective lines are just 2-8 words ("Kothay jete hobe?", "Pouchhe gechhi.", "Sorry sorry sorry Mummy") rather than a full sentence. Don't pad a line into a complete grammatical thought when a fragment lands harder.
- If a minor/secondary character's background clearly establishes a different mother tongue than this story's main characters (an outsider from another state, a migrant worker, someone explicitly marked as non-native), let THEM speak in their own natural language/register instead of forcing every character into one shared dialogue language — a Kolkata auto driver talking to an Odia stranger would naturally speak Bengali or Hindi, not Odia.`,

  or: `DIALOGUE LANGUAGE FOR THIS SCENE: Odia. You are an expert Odia dialogue writer and script supervisor ("Script Doctor") whose job is to make every line sound like real spoken Odia, never a textbook.

CHALITA BHASHA, NOT SADHU BHASHA — this is the single most important rule. Write natural, spoken, colloquial Odia (Chalita Bhasha), never formal/literary/Sanskritized Odia (Sadhu Bhasha), and never a stiff literal translation from English:
- Always reach for the local, everyday word over the Sanskritized/formal one. For example: "ଗ୍ରହଣ କରନ୍ତୁ" (Grahana Karantu) → "ନିଅ" (Nia) or "ଧର" (Dhara); "ପ୍ରସ୍ଥାନ କରିବା" (Prasthana Kariba) → "ବାହାରିବା" (Bahariba) or "ଯିବା" (Jiba); "ବାର୍ତ୍ତାଳାପ" (Bartalapa) → "କଥାବାର୍ତ୍ତା" (Kathabarta); "କ୍ରୋଧିତ" (Krodhita) → "ରାଗି" (Ragi). This applies throughout — nouns, adjectives, and verbs alike.
- Verb endings must match WHO is talking to WHOM, not default to the formal/respectful form for everyone. Toward an elder, a boss, or anyone owed respect, the respectful ଛନ୍ତି/କରନ୍ତି form is correct. But toward a friend, a junior, a child, or in most intimate family address, use the casual ଛି/ଛୁ/ଛ form instead ("କରୁଛନ୍ତି" → "କରୁଛି"/"କରୁଛ"/"କରୁଛୁ" depending on who's speaking to whom) — an AI default of "ଛନ୍ତି" for every single line is exactly the textbook-Odia mistake to avoid.
- Sentences are often short, broken, and imperfect — trailing off, repeating a word for emphasis, talking over each other — the way people actually speak, not complete grammatical sentences.
- EVERY LINE MUST CARRY EMOTION, NOT JUST INFORMATION. Never write dialogue as flat, cut-to-cut information-passing (character A states a fact, character B states the next fact). Real people hesitate, deflect, repeat themselves, ask questions instead of answering, or say something adjacent to what they mean when they're upset, scared, or holding something back. Preserve every beat of drama already established in the scene's one-liner and turn — do not summarize or compress it into fewer, flatter lines.
- Natural code-switching with English is common and should be used wherever a character genuinely would: urban, educated, or younger characters casually drop English words or whole phrases into an Odia sentence (a workplace term, a brand or app name, "seriously", "what a taste", or everyday loanwords like "ରୁମ୍", "ବ୍ୟାଗ୍", "ଅଙ୍କଲ୍"); older, rural, or working-class characters use little to no English and lean on regional idiom instead.
- Speech register must match the character: a security guard, a strict grandmother, a nagging in-law, joking office colleagues, and a frightened teenager should all sound distinctly different from each other in vocabulary, formality, and rhythm — never one uniform "polite Odia" voice for everyone.
- Family and social relationship terms (Ma, Bapa, Bhai, Kaka, Mausi, Thakuma, or their Odia equivalents) get used constantly in address, more often than actual names.
- Tense or emotional dialogue tends to get clipped and urgent rather than eloquent.
- Real dialogue lines are often shorter than you'd guess — many effective lines are just a handful of words rather than a full sentence. Don't pad a line into a complete grammatical thought when a short, clipped fragment lands harder.
- If a minor/secondary character's background clearly establishes a different mother tongue (an outsider from another state, a migrant worker, someone explicitly non-Odia), let THEM speak in their own natural language instead of forcing every character to speak Odia — e.g. a Bengali or Hindi-speaking outsider talking to an Odia character would naturally use their own language, not Odia.

IMPORTANT — script, not Romanization: many real Odia shooting scripts write dialogue in Romanized/transliterated Odia (Latin letters, e.g. "Kana kahuchhanti") for on-set convenience. Do NOT do that here. Dialogue must always be written in actual Odia (Oriya) script (ଓଡ଼ିଆ), never Romanized. Code-switching means an occasional English word or short phrase embedded naturally INSIDE an Odia-script sentence (e.g. "ମୋତେ ସିରିଅସ୍ଲି କାହିଁକି ଡରାଉଛୁ?") — it does not mean writing whole sentences in Latin letters.

FINAL PROOFREAD, EVERY LINE — before finalizing, reread each Odia sentence you've written and correct any spelling/grammar mistake, the same way a careful native proofreader would, rather than trusting your first draft:
- Matra (vowel sign) accuracy: don't confuse similar-looking vowel signs (ି vs ୀ, ୁ vs ୂ, େ vs ୈ) — the wrong one changes or breaks the word.
- Correct conjunct/compound letters (ଯୁକ୍ତାକ୍ଷର) for the actual word intended, not a visually-similar wrong conjunct.
- Nasal marks: don't drop or misuse ଁ (chandrabindu) and ଂ (anusvara) — many common words need one and are misspelled without it.
- Postposition/case particles (େର, କୁ, ର, ଠାରୁ, ପାଇଁ) must attach correctly to the preceding word with correct spelling — a common AI mistake is a subtly wrong or missing particle.
- Verb-ending agreement must match the subject's person, number, and the respect level already established for that speaker/listener pair (see the ଛନ୍ତି vs ଛି/ଛୁ/ଛ rule above) — check this per line, not just once for the whole scene.
- If a word could be a Sadhu Bhasha holdover you missed, replace it with the natural spoken word (see the Chalita Bhasha rule above) as part of this same pass.`,

  hi: `DIALOGUE LANGUAGE FOR THIS SCENE: Hindi. You are an expert Hindi dialogue writer and script supervisor ("Script Doctor") whose job is to make every line sound like real spoken Hindi, never a textbook.

BOLCHAAL KI HINDI, NOT SHUDDH/SANSKRITIZED HINDI — this is the single most important rule. Write natural, spoken, colloquial Hindi (Bolchaal ki Hindi), never formal/literary/heavily-Sanskritized Hindi (Shuddh Hindi), and never a stiff literal translation from English:
- Always reach for the local, everyday word over the Sanskritized/formal one. For example: "स्वीकार करें" (Sweekar Karein) → "लो" (Lo) or "ठीक है" (Theek Hai); "प्रस्थान करना" (Prasthan Karna) → "निकलना" (Nikalna) or "जाना" (Jaana); "वार्तालाप" (Vartalap) → "बातचीत" (Baatcheet); "क्रोधित" (Krodhit) → "गुस्सा" (Gussa). This applies throughout — nouns, adjectives, and verbs alike.
- Pronouns and verb endings must match WHO is talking to WHOM, not default to the formal "आप" for everyone. Toward an elder, a boss, or anyone owed respect, "आप" and its verb forms are correct. But toward a friend, a junior, a child, or in most intimate family address, use "तुम"/"तू" instead — an AI default of "आप" for every single line is exactly the textbook-Hindi mistake to avoid.
- Sentences are often short, broken, and imperfect — trailing off, repeating a word for emphasis, talking over each other — the way people actually speak, not complete grammatical sentences.
- EVERY LINE MUST CARRY EMOTION, NOT JUST INFORMATION. Never write dialogue as flat, cut-to-cut information-passing (character A states a fact, character B states the next fact). Real people hesitate, deflect, repeat themselves, ask questions instead of answering, or say something adjacent to what they mean when they're upset, scared, or holding something back. Preserve every beat of drama already established in the scene's one-liner and turn — do not summarize or compress it into fewer, flatter lines.
- Natural code-switching with English is common and should be used wherever a character genuinely would: urban, educated, or younger characters casually drop English words or whole phrases into a Hindi sentence (a workplace term, a brand or app name, "seriously", "what a vibe", or everyday loanwords like "फ़ोन", "गाड़ी", "ऑफिस"); older, rural, or working-class characters use little to no English and lean on regional idiom instead.
- Speech register must match the character: a security guard, a strict grandmother, a nagging in-law, joking office colleagues, and a frightened teenager should all sound distinctly different from each other in vocabulary, formality, and rhythm — never one uniform "polite Hindi" voice for everyone.
- Family and social relationship terms (Maa, Papa, Bhaiya, Chacha, Mausi, Dadi, or their regional equivalents) get used constantly in address, more often than actual names.
- Tense or emotional dialogue tends to get clipped and urgent rather than eloquent.
- Real dialogue lines are often shorter than you'd guess — many effective lines are just a handful of words rather than a full sentence. Don't pad a line into a complete grammatical thought when a short, clipped fragment lands harder.
- If a minor/secondary character's background clearly establishes a different mother tongue (an outsider from another state or region, someone explicitly non-native), let THEM speak in their own natural language instead of forcing every character to speak Hindi.

IMPORTANT — script, not Romanization: dialogue must always be written in actual Hindi (Devanagari) script, never Romanized/transliterated Hindi (Latin letters, e.g. "Kya kar rahe ho"). Code-switching means an occasional English word or short phrase embedded naturally INSIDE a Devanagari sentence — it does not mean writing whole sentences in Latin letters.`,
};

// The screen-only rule (shared with AI Movie's writers) was missing here:
// in a real automatic run the script editor marked whole acts 6/10 because
// action lines described smells, thoughts and feelings — and the writer
// had even been asked for "sensory detail".
function buildScreenplaySystemPrompt(dialogueLanguage) {
  const craft = SCREENPLAY_DIALOGUE_CRAFT[dialogueLanguage] ?? SCREENPLAY_DIALOGUE_CRAFT.en;
  return `${SCREENPLAY_BASE_PROMPT}\n\n${AI_MOVIE_SCREEN_ONLY_RULE}\n\n${craft}`;
}

const SCRIPT_BREAKDOWN_SYSTEM_PROMPT = `You are an experienced Assistant Director / Script Supervisor performing a professional SCRIPT BREAKDOWN — the standard pre-scheduling analysis every production does once a script is locked, reading it closely for everything the production team needs to plan for. You are precise and thorough, not creative — extract what's actually in the script, don't invent story content.

Read the full scene-by-scene material given and produce five separate lists:
- "artistList": every character who appears, each with a short bilingual note on their overall involvement (how central they are, roughly how many scenes, anything schedule-relevant like "appears only in exterior scenes"), their approximate age (an age or age range as stated or reasonably inferable from the script and dialogue — e.g. "60s", "Late 20s", "Child, around 8" — use "Unspecified" only when genuinely not inferable), and their gender (Male, Female, or Unspecified) — casting decisions are made against age and gender, so infer both confidently from context (name, pronouns, family role, honorifics) rather than defaulting to Unspecified.
- "locationList": every distinct physical location as its OWN separate entry, each with INT/EXT, how many scenes happen there, and a short bilingual note (e.g. "needs to be dressed as a rundown temple courtyard"). List EVERY distinct place separately, however briefly it appears (including a flashback or a single shot) — NEVER combine multiple different named locations into one vague catch-all entry like "Various Locations" or "Village (various)".
- "props": every significant PROPERTY (an object a character handles or that's plot-relevant — a letter, a weapon, a phone, a specific vehicle) — not generic background objects. Each with a short bilingual note on which scene(s)/context it's needed in.
- "costumes": for each major character, a short bilingual description of their costume and any COSTUME CHANGES across the story (e.g. "starts in worn work clothes, changes to a clean kurta for the temple scene in Act 3").
- "art": ART DEPARTMENT / set-dressing needs — anything the location needs to be dressed or built for (signage, furniture, decorations, damage/wear, festival decor) — each with a short bilingual note.
Be thorough but only include things actually implied by the material — don't pad the lists with generic guesses. Write all bilingual fields in THREE languages — English, Odia (Odia script), and Hindi (Devanagari script) — each a natural, native-quality version, not a literal translation of the others. Character/prop/costume names stay as proper nouns, unchanged across all three languages.`;

const PRODUCTION_SYSTEM_PROMPT = `You are the Production Management Agent, working with the Production Manager (and eventually the Producer) inside a filmmaking production platform. You think in logistics, budgets, availability, and constraints — the way an experienced line producer or production manager would. Your work is logistics and math-heavy, not creative — be precise and clear rather than exploratory.

Given the full scene list and major characters, plus availability information for each character and each location (some may be marked "unknown" — for those, just estimate reasonably rather than blocking), propose a day-by-day shoot schedule:
- Group scenes efficiently by shared location first — minimize how many times the unit has to move locations — then by which characters/artists are needed, respecting any availability windows given.
- Infer which major characters likely appear in each scene from its one-liner and location (you are not given an explicit cast list per scene) — use this to check for scheduling conflicts, not to invent new plot content.
- If availability data creates a genuine scheduling conflict (a location and a needed character's windows don't overlap, or an "unknown" estimate looks risky), say so PLAINLY in the "conflicts" list — never quietly produce an optimistic-looking schedule that papers over a real problem.
- Give each shoot day a short bilingual "notes" line explaining the grouping logic or anything the production team should know (e.g. "all Kamini's scenes at the temple location, grouped to shoot back-to-back given her limited window").
- Number days sequentially starting from 1. A single location's scenes don't have to be one single day if there are too many for one day — split across consecutive days when needed, but keep the same location grouped on consecutive days rather than scattering it.
- You will be given a TARGET number of shoot days the Production Manager wants to fit within. Try genuinely to fit the schedule into that many days by grouping efficiently — but if it's truly not feasible given the amount of material, say so PLAINLY in the "conflicts" list (e.g. "this needs at least 9 days at a realistic pace; compressing to 6 would require cutting scenes or very long days") rather than silently padding or rushing the schedule to hit the number.
Write bilingual fields (location names, notes, conflicts) in THREE languages — English, Odia (Odia script), and Hindi (Devanagari script) — each a natural, native-quality version, not a literal translation of the others.`;

// Plain strings, not BILINGUAL_TEXT_SCHEMA — the screenplay's dialogue
// language is a single per-generation choice (see SCREENPLAY_DIALOGUE_CRAFT),
// not a fixed trilingual object like the rest of the app's content.
const SCREENPLAY_ELEMENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    type: { type: Type.STRING, enum: ["action", "dialogue", "transition", "flashback"] },
    character: { type: Type.STRING },
    characterModifier: { type: Type.STRING, enum: ["none", "CONT'D", "O.S.", "V.O.", "ECHOING"] },
    parenthetical: { type: Type.STRING },
    text: { type: Type.STRING },
  },
  required: ["type", "character", "text"],
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

// Same idea as FOREIGN_SCRIPT_REGEX, mirrored for Hindi: Devanagari itself
// (U+0900-U+097F, including the shared danda punctuation) is never stripped
// — only a stray character from some OTHER Indic or Arabic script leaking
// into a "hi" field is a mistake.
const HI_FOREIGN_SCRIPT_REGEX = new RegExp(
  "[" +
    "؀-ۿ" + // Arabic
    "଀-୷" + // Odia
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

function sanitizeBilingualContent(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeBilingualContent);
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === "or" && typeof val === "string") {
        result[key] = val.replace(FOREIGN_SCRIPT_REGEX, "").replace(/ {2,}/g, " ").trim();
      } else if (key === "hi" && typeof val === "string") {
        result[key] = val.replace(HI_FOREIGN_SCRIPT_REGEX, "").replace(/ {2,}/g, " ").trim();
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
    story: "Story",
    premise: "Synopsis",
    genre: "Format",
    toneGenre: "Tone / Genre",
    targetAudience: "Target Audience",
    highlights: "Unique Elements",
    sponsorshipAngle: "Sponsorship Angle",
    majorCharacters: "Major Characters",
    emotionalCore: "Emotional Core",
    conflict: "Conflict",
    episode: "Episode",
    hook: "Hook",
    thankYou: "Thank You",
    tagline: "AN ODIA STORY PRESENTATION",
  },
  or: {
    story: "କାହାଣୀ",
    premise: "କାହାଣୀ ସାରାଂଶ",
    genre: "ଫର୍ମାଟ୍",
    toneGenre: "ଶୈଳୀ / ଧାରା",
    targetAudience: "ଲକ୍ଷ୍ୟ ଦର୍ଶକ",
    highlights: "ବିଶେଷତ୍ୱ",
    sponsorshipAngle: "ପ୍ରାୟୋଜକ ଦୃଷ୍ଟିକୋଣ",
    majorCharacters: "ମୁଖ୍ୟ ଚରିତ୍ର",
    emotionalCore: "ଭାବନାତ୍ମକ ମୂଳ",
    conflict: "ସଂଘର୍ଷ",
    episode: "ପର୍ବ",
    hook: "ହୁକ୍",
    thankYou: "ଧନ୍ୟବାଦ",
    tagline: "ଏକ ଓଡ଼ିଆ କାହାଣୀ ଉପସ୍ଥାପନା",
  },
  hi: {
    story: "कहानी",
    premise: "सारांश",
    genre: "फ़ॉर्मेट",
    toneGenre: "शैली / जॉनर",
    targetAudience: "लक्षित दर्शक",
    highlights: "खास बातें",
    sponsorshipAngle: "प्रायोजक दृष्टिकोण",
    majorCharacters: "मुख्य किरदार",
    emotionalCore: "भावनात्मक केंद्र",
    conflict: "संघर्ष",
    episode: "एपिसोड",
    hook: "हुक",
    thankYou: "धन्यवाद",
    tagline: "एक ओड़िया कहानी प्रस्तुति",
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
    if (lang === "or") return `ୱେବ ସିରିଜ୍ · ${count} ପର୍ବ × ${minutes} ମିନିଟ୍ ପ୍ରତି`;
    if (lang === "hi") return `वेब सीरीज़ · ${count} एपिसोड × ${minutes} मिनट प्रति`;
    return `WEB SERIES · ${count} EPISODES × ${minutes} MIN EACH`;
  }
  if (format?.type === "vertical") {
    const count = format.episodeCount ?? "?";
    const minutes = format.episodeMinutes ?? "?";
    if (lang === "or") return `ଭର୍ଟିକାଲ୍ ଡ୍ରାମା · ${count} ପର୍ବ × ${minutes} ମିନିଟ୍ ପ୍ରତି`;
    if (lang === "hi") return `वर्टिकल ड्रामा · ${count} एपिसोड × ${minutes} मिनट प्रति`;
    return `VERTICAL DRAMA · ${count} EPISODES × ${minutes} MIN EACH`;
  }
  if (lang === "or") return "ପୂର୍ଣ୍ଣ ଚଳଚ୍ଚିତ୍ର";
  if (lang === "hi") return "फ़ीचर फ़िल्म";
  return "FEATURE FILM";
}

// A friendly, sponsor-facing one-liner ("8-episode crime drama" / "crime
// drama feature film") — distinct from formatLabel()'s more technical badge
// text, and folding in the short genre label rather than just the runtime.
function formatWithGenreLabel(format, genre, lang) {
  const genreText = (genre?.[lang] || genre?.en || "").trim();
  if (format?.type === "series" || format?.type === "vertical") {
    const count = format.episodeCount ?? "?";
    if (lang === "or") return `${count}-ପର୍ବ ${genreText}`.trim();
    if (lang === "hi") return `${count}-एपिसोड ${genreText}`.trim();
    return `${count}-episode ${genreText}`.trim();
  }
  if (lang === "or") return `${genreText} ଚଳଚ୍ଚିତ୍ର`.trim();
  if (lang === "hi") return `${genreText} फ़ीचर फ़िल्म`.trim();
  return `${genreText} feature film`.trim();
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

// A quick, isolated way to check the Gemini/Vertex AI connection itself —
// one tiny short-story request, nothing else in the pipeline (no scene
// list, no background job, no polling) — so a slow or failing response
// here points straight at the API/billing setup, not at any app logic.
// Open this URL directly in a browser while logged into the app (it needs
// the same admin session cookie the app itself uses).
app.get("/api/test-gemini", requireRole("admin"), async (req, res) => {
  const startedAt = Date.now();
  try {
    const response = await generateContentWithRetry({
      model: GEMINI_MODEL_NAME,
      contents: "Write a very short story (3-4 sentences) about a fisherman on the Odisha coast who finds something unexpected in his net.",
    });
    res.json({
      ok: true,
      backend: googleServiceAccount ? "vertex-ai" : "ai-studio-free-tier",
      model: GEMINI_MODEL_NAME,
      elapsedMs: Date.now() - startedAt,
      story: response.text,
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      backend: googleServiceAccount ? "vertex-ai" : "ai-studio-free-tier",
      model: GEMINI_MODEL_NAME,
      elapsedMs: Date.now() - startedAt,
      error: error.message,
    });
  }
});

// A revision used to show the writer little or nothing of its previous
// draft (for a film: no Bit Sheet, Scene List or Character Sheet at all,
// only one-line summaries of a Three-Act Structure) — so every "revision"
// was really a fresh rewrite, often breaking what already worked (seen for
// real: a Three-Act draft went 6/10 -> 5/10 with brand-new problems). Now
// every story writer gets its full previous draft — in English only, to
// save room — plus this rule.
function previousDraftForRevision(previous, omitKeys = [], fresh = false) {
  const englishOnly = (value) => {
    if (Array.isArray(value)) return value.map(englishOnly);
    if (value && typeof value === "object") {
      if (typeof value.en === "string" && ("or" in value || "hi" in value)) return value.en;
      return Object.fromEntries(Object.entries(value).filter(([key]) => !omitKeys.includes(key)).map(([key, v]) => [key, englishOnly(v)]));
    }
    return value;
  };
  const draftJson = JSON.stringify(englishOnly(previous));
  // A "fresh version" (the second batch in reviseUntilGood) may restructure.
  if (fresh) {
    return `Your best version so far (English), for reference:\n${draftJson}\n\nWrite a NEW version that fixes every problem listed in the feedback. You may restructure freely — keep only what genuinely works.`;
  }
  return `Your previous draft (English):\n${draftJson}\n\nKeep everything in it that already works — the same characters, events and order — and change only what the feedback asks for. Do not rewrite the story from scratch.`;
}

async function generateStorylinesContent(concept, format) {
  const formatInstruction =
    format?.type === "vertical"
      ? `Format: vertical micro-drama, ${format.episodeCount ?? "many"} episodes of only ${format.episodeMinutes ?? "~1-2"} minutes each — shape each storyline direction so it can sustain a long run of very short, hook-driven episodes (ReelShort/short-drama app style), not a single continuous film arc. This is a LOW-BUDGET format meant to shoot in just 2-3 days: every storyline direction must be one that naturally plays out with around 5 main characters (plus a little background crowd at most) and within a small, contained setting — think a family home and its immediate surroundings, or one workplace — driven by dialogue and personal drama, NOT a story that needs many locations, a large cast, or spectacle to work.`
      : format?.type === "series"
        ? `Format: web series, ${format.episodeCount ?? "several"} episodes of ${format.episodeMinutes ?? "~25"} minutes each — shape each storyline direction so it can sustain a multi-episode arc, not just a single-sitting story.`
        : `Format: feature film, target runtime ${format?.runtimeMinutes ?? "~90"} minutes.`;

  return sanitizeBilingualContent(
    await generateJsonContent({
      model: STORY_WRITER_MODEL_NAME,
      contents: `Movie concept: ${concept}\n${formatInstruction}`,
      config: {
        systemInstruction: STORY_AGENT_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        // No cap — a fixed budget here truncates mid-JSON on a long/heavy
        // concept (e.g. a 60-episode vertical drama with several storyline
        // options), which looks like a random parse bug but is actually
        // just running out of budget; left to the model's own maximum.
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
    })
  );
}

app.post("/api/generate-storylines", requireRole("admin"), async (req, res) => {
  const { concept, format } = req.body;

  try {
    const parsed = await generateStorylinesContent(concept, format);

    // A real project name from the very first step, not the raw pasted idea
    // text — the user picks one of these storylines shortly anyway, so its
    // own title is a real name immediately, not just after a manual rename.
    const initialTitle = parsed.storylines[0]?.title?.en ?? null;

    const insertResult = await db.query(
      "INSERT INTO concepts (concept_text, storylines, title) VALUES ($1, $2, $3) RETURNING id",
      [concept, JSON.stringify(parsed.storylines), initialTitle]
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

// Tracks breakdown ids currently being auto-backfilled so a burst of page
// loads/polls doesn't kick off the same expensive classification pass
// several times at once. Reset on every deploy/restart — worst case after
// one, a harmless extra pass runs once more.
const breakdownAutoBackfillInFlight = new Set();

function breakdownNeedsCastTierBackfill(breakdownContent) {
  return (breakdownContent.artistList ?? []).some((item) => item.castCategory === "speaking" && !item.castTier);
}

function breakdownNeedsEpisodeNumberBackfill(breakdownContent, sceneListContent) {
  if (!sceneListContent?.episodeScenes) return false; // only ever relevant for a series
  return BREAKDOWN_CATEGORY_KEYS.some((category) =>
    (breakdownContent[category] ?? []).some((item) => !item.episodeNumbers || item.episodeNumbers.length === 0)
  );
}

// Fire-and-forget: called every time a breakdown is loaded (never awaited,
// so it adds zero latency to that request) — if it's missing cast tiers or
// episode numbers a fresh "Analyze Script" run would now include, this
// computes and saves them in the background so simply opening the project
// again shortly after picks up the fix, with nothing for anyone to click.
// Exists specifically for a breakdown analyzed before this feature shipped
// (a fresh analysis already gets both automatically — see
// generateDeepScriptBreakdownContent).
// Remembers the last OUTCOME per breakdown id too (not just "in flight"),
// so a failure is visible instead of just silently vanishing back to
// "not_needed" on the load that retries it — the frontend surfaces this
// rather than staying silent about whether the background fix worked.
const breakdownAutoBackfillLastError = new Map();

// Returns a status string the frontend shows: "in_progress" (just
// started, nothing to report yet), "retrying_after_failure" (the last
// attempt errored — see breakdownAutoBackfillLastError — and a fresh one
// just started), or "not_needed" (nothing missing).
function triggerScriptBreakdownAutoBackfill(sceneListRow, breakdownRow) {
  if (breakdownAutoBackfillInFlight.has(breakdownRow.id)) return "in_progress";

  const needsCastTier = breakdownNeedsCastTierBackfill(breakdownRow.content);
  const needsEpisodeNumbers = breakdownNeedsEpisodeNumberBackfill(breakdownRow.content, sceneListRow.content);
  if (!needsCastTier && !needsEpisodeNumbers) return "not_needed";

  const hadPriorFailure = breakdownAutoBackfillLastError.has(breakdownRow.id);
  breakdownAutoBackfillInFlight.add(breakdownRow.id);
  breakdownAutoBackfillLastError.delete(breakdownRow.id);
  (async () => {
    try {
      const sourceText = await buildBreakdownSourceText(sceneListRow.content, sceneListRow.id);
      let updated = breakdownRow.content;
      if (needsCastTier) {
        updated = { ...updated, artistList: await classifyCastCategories(sourceText, updated.artistList ?? []) };
      }
      if (needsEpisodeNumbers) {
        updated = await classifyEpisodeNumbers(sourceText, updated);
      }
      await db.query("INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4)", [
        sceneListRow.id,
        JSON.stringify(updated),
        breakdownRow.status,
        "Auto-backfilled cast tiers / episode numbers",
      ]);
    } catch (error) {
      console.error(`Auto-backfill failed for breakdown ${breakdownRow.id}:`, error.message);
      breakdownAutoBackfillLastError.set(breakdownRow.id, error.message);
    } finally {
      breakdownAutoBackfillInFlight.delete(breakdownRow.id);
    }
  })();
  return hadPriorFailure ? "retrying_after_failure" : "in_progress";
}

// Loads one project's entire chain, scoped strictly to that concept — unlike the various
// "/latest" endpoints above, which each just grab the single newest row in their table
// regardless of which project it belongs to. This is what makes Load Project / History work
// correctly instead of silently mixing up whichever project was touched most recently anywhere.
app.get("/api/concepts/:id/full", requireLogin, async (req, res) => {
  // A bad/missing id here (e.g. a frontend request fired before its own
  // conceptId state was ready) used to reach the query below and crash with
  // Postgres' own raw "invalid input syntax for type integer" message.
  if (!/^\d+$/.test(req.params.id)) {
    res.status(400).json({ error: "Invalid project id." });
    return;
  }

  if (req.user.role !== "admin" && String(req.user.concept_id) !== String(req.params.id)) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const conceptResult = await db.query(
    "SELECT id, concept_text, storylines, title, project_type, clapboard_banner_path FROM concepts WHERE id = $1",
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
    clapboardBannerUrl: photoUrlFor(conceptRow.clapboard_banner_path),
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
        autoBackfillStatus: triggerScriptBreakdownAutoBackfill(sceneListRow, breakdownRow),
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
      autoBackfillStatus: triggerScriptBreakdownAutoBackfill(sceneListRow, breakdownRow),
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
        type: { type: Type.STRING, enum: ["edit_scenes", "assign_cast", "edit_costume", "regenerate_schedule", "regenerate_breakdown", "none"] },
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
        regenerateInstructions: { type: Type.STRING },
        explicitSceneRefs: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              episodeLabel: { type: Type.STRING },
              sceneNumberLabel: { type: Type.STRING },
            },
            required: ["episodeLabel", "sceneNumberLabel"],
          },
        },
        characterFilters: { type: Type.ARRAY, items: { type: Type.STRING } },
        targetDayNumber: { type: Type.INTEGER },
      },
      required: [
        "type",
        "sceneEdits",
        "castAssignment",
        "costumeEdit",
        "description",
        "regenerateInstructions",
        "explicitSceneRefs",
        "characterFilters",
        "targetDayNumber",
      ],
    },
  },
  required: ["reply", "proposedAction"],
};

const AGENT_CHAT_NONE_ACTION_INSTRUCTION =
  'Every field in proposedAction is required by the response format even when unused: when proposedAction.type is "none", still set sceneEdits to an empty array, castAssignment to {characterName:"", actorName:"", contactNumber:""}, costumeEdit to {character:"", sets:[]}, description to an empty string, regenerateInstructions to an empty string, explicitSceneRefs to an empty array, characterFilters to an empty array, and targetDayNumber to 0.';

const AGENT_CHAT_CAST_ASSIGNMENT_INSTRUCTION =
  'You can also propose reassigning who plays a character — e.g. the AD types a phone number and attaches a photo of a person, saying something like "she\'s Priyanka, cast her as Pushpa" (meaning: the real person in the photo is named Priyanka, and she should play the character Pushpa). To propose this, set proposedAction.type to "assign_cast" and fill castAssignment: characterName is the ROLE/character being cast (match it to one of the known cast entries above if it already exists, otherwise use the name exactly as given), actorName is the real person\'s name, and contactNumber is their phone number if given (empty string if not). Only propose this when both the character and the actor\'s name are clear — ask if either is ambiguous. When proposing assign_cast, leave sceneEdits and costumeEdit at their empty defaults.';

const AGENT_CHAT_STAY_ON_TOPIC_INSTRUCTION =
  "CRITICAL — always respond to the AD's MOST RECENT message specifically, on its own terms. If it raises a new topic, a correction, or a request unrelated to whatever was being discussed before, engage with THAT — don't drift back to or re-propose an earlier idea (especially one they just cancelled) unless they explicitly bring it up again. If they attach a new photo/document, its content is what this turn is actually about — read it fresh rather than assuming it repeats an earlier attachment's content.";

// A real gap this caught in production: asked to restructure which scenes
// fall on which shoot day — a wholesale rebuild, not a named-scene edit —
// the model had no matching action type, but still attached the schema's
// required proposedAction object, and rather than defaulting it to "none"
// it reused a stale, unrelated proposedAction still sitting in the
// conversation from an earlier, already-resolved request. The human
// confirmed it (the reply text sounded like it addressed their actual ask),
// and that old unrelated edit got silently reapplied while the real request
// was never attempted — a false "done" with real consequences on real
// production data. The fix isn't just "admit you can't" (that pushes the AD
// out to a different page for something they came to this one panel to get
// done — the whole point of this chat existing) — it's a real action type
// that hands the broad request to the same full-document regeneration a
// dedicated "Request Changes" button already uses, without ever leaving
// this conversation. Named explicitly per stage: actionType is which
// proposedAction.type to use, subjectLabel names what gets rebuilt.
function agentChatRegenerateInstruction(actionType, subjectLabel) {
  return (
    `You can also handle BROAD requests — reorganizing which scenes are on which day, filtering the ${subjectLabel} down to specific characters/locations, or any other wholesale restructuring that isn't a small named-scene tweak. For these, set proposedAction.type to "${actionType}" and write regenerateInstructions: a clear, complete, self-contained restatement of exactly what they want changed — written the way a Production Manager would type it into a formal written revision request, in plain English, folding in every constraint they've given across this conversation (not just their latest message) so nothing gets lost. Do NOT try to compute the actual scene-by-scene result yourself — leave sceneEdits, castAssignment, and costumeEdit at their empty defaults; a separate full regeneration step rebuilds the ${subjectLabel} from your instructions once they confirm, and it can take a little while since it replaces the whole thing. Your reply should briefly reflect back what you understood they want and ask them to confirm before you rebuild it — don't downplay that this replaces the current ${subjectLabel} entirely. Reserve this for genuinely broad requests; a single named scene's costume/property/remark still goes through the narrower edit above.\n\n` +
    `Also fill in, so the AD can see a real preview of exactly which scenes this touches before confirming: explicitSceneRefs — every scene they named directly by episode/scene number (episodeLabel + sceneNumberLabel exactly as they wrote it, e.g. "Episode 2" + "3"); characterFilters — every character name they mentioned whose scenes should all be included (e.g. "Bablu" for "all of Bablu's scenes"), which will be resolved against the real script server-side, not by you; and targetDayNumber — the shoot day number they want these scenes moved to/scheduled on, or 0 if none was stated. Leave any of these at their empty default (empty array or 0) when not applicable.\n\n` +
    `CRITICAL — you only have the specific action types spelled out in this whole prompt, nothing else. If the AD asks for something truly none of them cover (not actually about the ${subjectLabel} at all), set proposedAction.type to "none" with every field at its empty default and say so honestly. But never punt a request to reorganize/restructure the ${subjectLabel} to "go do that somewhere else" — that capability lives right here now, use it. And never attach a proposedAction left over from an earlier, different request just because the schema requires one to be present — reusing an unrelated old action and letting the human confirm it as if it fulfilled their new request is far worse than asking one more clarifying question.`
  );
}

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
    "\n\n" +
    agentChatRegenerateInstruction("regenerate_schedule", "shoot schedule") +
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
    "\n\n" +
    agentChatRegenerateInstruction("regenerate_breakdown", "script breakdown") +
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
    model: GEMINI_MODEL_NAME,
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
      let proposedAction = hasAction ? { ...parsed.proposedAction, photoPath: attachmentPhotoPaths[0] ?? null } : null;

      // For a schedule restructuring proposal, resolve exactly which real
      // scenes it touches (never trusting the model's own scene content) so
      // the AD sees a concrete table before confirming, not just prose.
      if (proposedAction?.type === "regenerate_schedule") {
        const sceneListId = await findSceneListIdForConcept(conceptId);
        if (sceneListId) {
          const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
          const sceneList = sceneListResult.rows[0]?.content;
          if (sceneList) {
            proposedAction = {
              ...proposedAction,
              affectedScenes: resolveAffectedScenesForProposal(
                sceneList,
                proposedAction.explicitSceneRefs,
                proposedAction.characterFilters
              ),
            };
          }
        }
      }
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
  let appliedScheduleSummary = null;
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

  // A broad, whole-document rebuild — "restructure Day 2 around just these
  // characters", "reorganize this by location" — driven from right inside
  // this chat instead of forcing the AD out to the standalone "Request
  // Changes" button, which does the exact same full regeneration. Reuses
  // that route's own generation function so behavior stays identical
  // either way this gets triggered.
  if (decision === "applied" && action.type === "regenerate_schedule" && action.regenerateInstructions?.trim()) {
    const sceneListId = await findSceneListIdForConcept(conceptId);
    const existing = await db.query(
      "SELECT content FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    if (existing.rows.length > 0) {
      const previous = existing.rows[0].content;
      const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
      const sceneList = sceneListResult.rows[0].content;
      const characterNames = await fetchCharacterNamesForSceneList(sceneListId, sceneList);
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
        { feedback: action.regenerateInstructions.trim(), previous },
        {
          specialInstructions: previous.specialInstructions,
          completedDays,
          sourceText,
          breakdownContent: breakdownResult.rows[0]?.content ?? null,
        }
      );

      // Same as the standalone Request Changes route — a full rebuild
      // intentionally drops back to pending for genuine re-review, unlike
      // the narrow edit_scenes action above which carries status forward.
      const insertResult = await db.query(
        "INSERT INTO shoot_schedules (scene_list_id, content, feedback) VALUES ($1, $2, $3) RETURNING id, status, feedback",
        [sceneListId, JSON.stringify(revisedContent), `Restructured via the Changes chat: ${action.regenerateInstructions.trim()}`]
      );
      appliedSchedule = { ...insertResult.rows[0], sceneListId, ...revisedContent };
      appliedScheduleSummary = buildScheduleDaySummary(sceneList, revisedContent.scheduleDays);
    }
  }

  if (decision === "applied" && action.type === "regenerate_breakdown" && action.regenerateInstructions?.trim()) {
    const sceneListId = await findSceneListIdForConcept(conceptId);
    const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
    const sourceText = await buildBreakdownSourceText(sceneListResult.rows[0].content, sceneListId);
    const existing = await db.query(
      "SELECT content FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
      [sceneListId]
    );
    const previous = existing.rows[0]?.content ?? null;

    const revisedContent = await generateDeepScriptBreakdownContent(sourceText, {
      feedback: action.regenerateInstructions.trim(),
      previous,
    });

    const insertResult = await db.query(
      "INSERT INTO script_breakdowns (scene_list_id, content, feedback) VALUES ($1, $2, $3) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(revisedContent), `Restructured via the Changes chat: ${action.regenerateInstructions.trim()}`]
    );
    appliedBreakdown = { ...insertResult.rows[0], sceneListId, ...revisedContent };
  }

  await db.query("UPDATE agent_chat_messages SET resolved = $1 WHERE id = $2", [decision, messageId]);

  res.json({
    resolved: decision,
    schedule: appliedSchedule,
    scheduleSummary: appliedScheduleSummary,
    castMember: appliedCastMember,
    breakdown: appliedBreakdown,
  });
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
      await setConceptTitleIfMissing(conceptId, project.pitchDeck.title);
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

// --- AI Movie pipeline (separate from the shooting-production pipeline
// above). This is its first, deliberately small piece: given ANY pasted
// text of unknown type, identify which stage of development it represents.
// Nothing downstream is built yet — the frontend just shows the detected
// stage back to the user and stops there.
const AI_MOVIE_STAGE_ANALYSIS_SYSTEM_PROMPT = `You read a piece of pasted filmmaking material and identify which single stage of story development it represents, without being told in advance which stage it is. Pick exactly one:
- "concept": a short raw idea or premise, not yet developed into a full story.
- "story": a fuller prose telling of the story, not yet shaped into a formal pitch document and not broken into scenes.
- "synopsis": a structured pitch-style summary (premise, characters, tone/genre, target audience).
- "bitsheet": an ordered list of story beats/plot points (a beat sheet).
- "screenplay": formatted script pages — scene headings, action lines, dialogue.
- "other": doesn't clearly match any of the above, or isn't filmmaking material at all.
Judge by the actual shape and content of the text itself, not by any label the user may have put on it.`;

async function analyzeAiMovieStage(pastedText) {
  return generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents: `Identify which stage this pasted material represents:\n\n${pastedText}`,
    config: {
      systemInstruction: AI_MOVIE_STAGE_ANALYSIS_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 256,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          stage: { type: Type.STRING, enum: ["concept", "story", "synopsis", "bitsheet", "screenplay", "other"] },
        },
        required: ["stage"],
      },
    },
  });
}

app.post("/api/ai-movie/analyze-stage", requireRole("admin"), async (req, res) => {
  const { pastedText, projectId } = req.body;

  if (!pastedText || !pastedText.trim()) {
    res.status(400).json({ error: "Paste some text first." });
    return;
  }

  try {
    const result = await analyzeAiMovieStage(pastedText);

    // Persist as we go, same as every other stage of this app — a fresh
    // paste creates its own project row (returned so the frontend can keep
    // sending it back on every later call for this same project); re-
    // analyzing an already-saved project just updates that row in place.
    let id = projectId;
    if (id) {
      await db.query(
        "UPDATE ai_movie_projects SET pasted_text = $1, detected_stage = $2, updated_at = now() WHERE id = $3",
        [pastedText, result.stage, id]
      );
    } else {
      const inserted = await db.query(
        "INSERT INTO ai_movie_projects (pasted_text, detected_stage, created_by) VALUES ($1, $2, $3) RETURNING id",
        [pastedText, result.stage, req.user.id]
      );
      id = inserted.rows[0].id;
    }

    res.json({ ...result, projectId: id });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// Second AI Movie piece: once a stage is identified, work BACKWARD from it
// and invent whichever earlier layers are missing — never touching the
// pasted material itself, which stays exactly as given for its own detected
// stage (no rewrite, no critique, no quality judgment). This is a
// deliberately separate system prompt from the shooting-production agents
// above — this pipeline is for a movie that is never physically shot, so
// unlike every other generation prompt in this file, it must NOT reason
// about budget, feasibility, or any real-world production constraint.
const AI_MOVIE_BACKFILL_SYSTEM_PROMPT = `You are working on an AI Movie — a film that will be entirely AI-generated, never physically shot. Because of that, never reason about budget, cast/crew/location availability, shoot schedules, or any real-world production constraint — anything that can be imagined can be included, with no limitation.

The user has pasted material below at a specific, already-identified stage of development. Treat that pasted material as final and authoritative for its own stage — never rewrite it, never critique or "improve" it, never second-guess it. Your only job is to invent the EARLIER, missing layers the schema below asks for, fully consistent with what was pasted (same story, same characters, same world — you are filling in what came before it, not changing it).`;

// AI Movie's own bilingual field shape — English + Hindi only, deliberately
// separate from the shared BILINGUAL_TEXT_SCHEMA (en/or/hi) used everywhere
// else in this app. The Movie/shooting pipeline's Odia work (colloquial
// dialogue, Odia PDF export, the language toggle) is untouched by this —
// AI Movie's Odia output was coming back Romanized/phonetic rather than
// real Odia script, so Odia is dropped from AI Movie's own fields in favor
// of Hindi, which was coming back usable.
const AI_MOVIE_BILINGUAL_TEXT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    en: { type: Type.STRING },
    hi: { type: Type.STRING },
  },
  required: ["en", "hi"],
};

const AI_MOVIE_STORY_LAYER_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    summary: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
  },
  required: ["title", "summary"],
};

const AI_MOVIE_SYNOPSIS_LAYER_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    logline: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    premise: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    toneGenre: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    targetAudience: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
  },
  required: ["logline", "premise", "toneGenre", "targetAudience"],
};

const AI_MOVIE_PLOT_BEAT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    description: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    // Estimated screen-time this beat needs, in minutes -- drives how many
    // scenes (and how long each) the Screenplay stage writes for it later,
    // instead of picking a scene count in isolation.
    runtimeMinutes: { type: Type.NUMBER },
  },
  required: ["title", "description", "runtimeMinutes"],
};

const AI_MOVIE_CHARACTER_ARC_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    want: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    need: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    arc: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
  },
  required: ["name", "want", "need", "arc"],
};

// The macro shape (Act 1 / Act 2 / Act 3, plus any others a story genuinely
// needs — an Indian-interval film often reads better as four: Act 1, Act
// 2A, Act 2B, Act 3) with the turning point that ends each one. Sits
// between Characters and Beat Sheet: this is the big-picture container the
// detailed beats below get organized inside, not a beat-by-beat list itself.
const AI_MOVIE_THREE_ACT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    actName: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    description: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    turningPoint: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
  },
  required: ["actName", "description", "turningPoint"],
};

// Which earlier layers each detected stage needs filled in behind it.
// 'concept' and 'story' are already the earliest layer (nothing behind
// them); 'other' is too uncertain to safely backfill from at all.
const AI_MOVIE_BACKFILL_LAYERS_NEEDED = {
  concept: [],
  story: [],
  synopsis: ["story"],
  bitsheet: ["story", "synopsis", "characterArc", "threeAct"],
  screenplay: ["story", "synopsis", "characterArc", "threeAct", "plot"],
  other: [],
};

async function generateAiMovieBackfill(pastedText, stage, referenceMaterialText) {
  const needed = AI_MOVIE_BACKFILL_LAYERS_NEEDED[stage] ?? [];
  if (needed.length === 0) return {};

  const properties = {};
  const required = [];
  if (needed.includes("story")) {
    properties.story = AI_MOVIE_STORY_LAYER_SCHEMA;
    required.push("story");
  }
  if (needed.includes("synopsis")) {
    properties.synopsis = AI_MOVIE_SYNOPSIS_LAYER_SCHEMA;
    required.push("synopsis");
  }
  if (needed.includes("plot")) {
    properties.plot = { type: Type.ARRAY, items: AI_MOVIE_PLOT_BEAT_SCHEMA };
    required.push("plot");
  }
  if (needed.includes("characterArc")) {
    properties.characterArc = { type: Type.ARRAY, items: AI_MOVIE_CHARACTER_ARC_SCHEMA };
    required.push("characterArc");
  }
  if (needed.includes("threeAct")) {
    properties.threeAct = { type: Type.ARRAY, items: AI_MOVIE_THREE_ACT_SCHEMA };
    required.push("threeAct");
  }

  const referenceBlock = referenceMaterialText
    ? `\n\nThe user has also provided reference material below (a real book/source it draws from, and/or manually-specified character/property/art details). Treat it as authoritative grounding — stay faithful to it rather than inventing conflicting details:\n\n${referenceMaterialText}`
    : "";

  return generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents: `The pasted material below was already identified as being at the "${stage}" stage. Invent only the earlier layers this schema asks for — nothing else — fully consistent with it:\n\n${pastedText}${referenceBlock}`,
    config: {
      systemInstruction: AI_MOVIE_BACKFILL_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      responseSchema: { type: Type.OBJECT, properties, required },
    },
  });
}

// Third AI Movie piece: a SILENT agent — never a visible chat participant,
// never shown anywhere while the story is being worked on — that reads
// everything gathered so far (the pasted material plus whatever backfill
// just invented) and extracts structured lists of the characters,
// properties (props/objects), and environments (locations) it finds, each
// with a visual description detailed enough to later become an actual
// image-generation prompt once the Production side exists. That later step
// — turning these into real prompts, and generating images from them — is
// deliberately NOT built here.
const AI_MOVIE_ASSET_EXTRACTION_SYSTEM_PROMPT = `You are working on an AI Movie — a film that will be entirely AI-generated, never physically shot. Read through the whole story material given to you and extract three structured lists that will later be used to generate reference images:
- "characters": every named character who appears, with a vivid visual description (appearance, build, age, distinguishing features, typical wardrobe) detailed enough that an image generator could draw them consistently every time.
- "properties": physical objects/props that matter to the story, each with a vivid visual description.
- "environments": distinct locations/settings the story takes place in, each with a vivid visual description (architecture, era, mood, lighting, color palette).
Since this is never physically shot, describe everything as vividly and imaginatively as the story calls for — never limit any description by real-world budget or production feasibility.`;

const AI_MOVIE_ASSET_ENTRY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    // AI Movie is English/Hindi only, never Odia -- unlike the Movie/shooting
    // side, which still uses the shared en/or/hi BILINGUAL_TEXT_SCHEMA.
    visualDescription: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
  },
  required: ["name", "visualDescription"],
};

async function generateAiMovieAssetExtraction(fullText, referenceMaterialText) {
  const referenceBlock = referenceMaterialText
    ? `\n\nThe user also provided reference material below (a real book/source, and/or manually-specified character/property/art details) — treat it as authoritative and prefer its details over anything you'd otherwise guess:\n\n${referenceMaterialText}`
    : "";

  return generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents: `Extract the characters, properties, and environments from this story material:\n\n${fullText}${referenceBlock}`,
    config: {
      systemInstruction: AI_MOVIE_ASSET_EXTRACTION_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          characters: { type: Type.ARRAY, items: AI_MOVIE_ASSET_ENTRY_SCHEMA },
          properties: { type: Type.ARRAY, items: AI_MOVIE_ASSET_ENTRY_SCHEMA },
          environments: { type: Type.ARRAY, items: AI_MOVIE_ASSET_ENTRY_SCHEMA },
        },
        required: ["characters", "properties", "environments"],
      },
    },
  });
}

// Flattens whatever backfill produced into plain text, alongside the
// original pasted material — used both by the silent asset-extraction
// agent (reading everything gathered so far) and, further below, as the
// "approved story so far" context handed to each forward stage's own
// generation call.
//
// includeScreenplay: false is for the screenplay-writing calls themselves
// (next beat, beat Request Changes, scene revise, Write Dialogue). Those
// already get the scenes they should see through their own dedicated
// "scenes already written before this beat" + "this beat's other scenes"
// context -- adding the whole screenplay here too sent every scene twice,
// and worse, also showed the model the OLD version of the very beat being
// regenerated and every beat already written AFTER it. The asset
// extractor still reads every scene (that's exactly its job), so it keeps
// the default.
function flattenAiMovieContentForExtraction(pastedText, backfill, { includeScreenplay = true } = {}) {
  const parts = [pastedText];
  if (backfill?.story) parts.push(`Story: ${backfill.story.title.en}\n${backfill.story.summary.en}`);
  if (backfill?.synopsis) {
    parts.push(
      `Synopsis: ${backfill.synopsis.logline.en}\n${backfill.synopsis.premise.en}\n${backfill.synopsis.toneGenre.en}\n${backfill.synopsis.targetAudience.en}`
    );
  }
  if (backfill?.characterArc) {
    parts.push(
      `Character Arc:\n${backfill.characterArc.map((c) => `${c.name} — wants ${c.want.en}, needs ${c.need.en}, arc: ${c.arc.en}`).join("\n")}`
    );
  }
  if (backfill?.threeAct) {
    parts.push(
      `Three-Act Structure:\n${backfill.threeAct
        .map((act) => `${act.actName.en}: ${act.description.en} (turning point: ${act.turningPoint.en})`)
        .join("\n")}`
    );
  }
  // Numbered, so a writer told "Beat 4" can find it -- and match it to
  // reference material that numbers its scenes the same way.
  if (backfill?.plot) parts.push(`Beat Sheet:\n${backfill.plot.map((beat, i) => `Beat ${i + 1} — ${beat.title.en}: ${beat.description.en}`).join("\n")}`);
  if (includeScreenplay && backfill?.screenplayBeats) {
    const scenes = backfill.screenplayBeats.filter((b) => b.scenes).flatMap((b) => b.scenes);
    if (scenes.length > 0) {
      // sceneToPromptText, not a direct scene.action read -- a scene revised
      // into interleaved action/dialogue "content" has no "action" field at
      // all, and reading .en off of it broke every later AI call on the
      // project with "Cannot read properties of undefined (reading 'en')".
      parts.push(`Screenplay:\n${scenes.map((scene) => sceneToPromptText(scene)).join("\n\n")}`);
    }
  }
  return parts.join("\n\n");
}

// The step-by-step review chain this whole pipeline now follows: Story ->
// Synopsis -> Characters -> Three-Act Structure -> Beat Sheet ('plot') ->
// Screenplay. Matches standard screenwriting order (cast the wants/needs
// before plotting beats around them) and mirrors the shooting pipeline's
// own Idea -> Synopsis -> Characters -> Bit Sheet chain. 'story' is always
// covered by whatever the paste/backfill/reference-generation step already
// produced (auto-approved, never separately reviewed); everything after it
// is generated ONE layer at a time, only once the layer before it has been
// approved.
const AI_MOVIE_STAGE_ORDER = ["story", "synopsis", "characterArc", "threeAct", "plot", "screenplay"];

// How far into AI_MOVIE_STAGE_ORDER a given Analyze result already covers,
// so that prefix can be auto-approved the moment Proceed finishes — the
// pasted material (plus whatever backfill invented behind it) is already
// "final and authoritative," never something to second-guess with a
// review step. -1 ('other') means nothing is confidently covered.
const AI_MOVIE_DETECTED_STAGE_COVERED_INDEX = { concept: 0, story: 0, synopsis: 1, bitsheet: 4, screenplay: 5, other: -1 };

function approvedStageStatusUpTo(index) {
  const status = {};
  for (let i = 0; i <= index; i++) status[AI_MOVIE_STAGE_ORDER[i]] = { status: "approved", feedback: null };
  return status;
}

// One text blob of everything the user has attached for a project via the
// Reference Material section (a real book/source, manually-specified
// character/property/art details, or anything else) — fed into both
// generation calls below as grounding they must stay faithful to.
//
// Capped in total size: a project can have a dozen-plus real documents
// attached (a full handoff package — story drafts, scene breakdowns, whole
// screenplay acts), and dumping all of it uncapped into one prompt was
// seen to make generation slow enough to time out before any response came
// back at all (the caller saw a bare network failure, not even a real
// error message). Keeps whole documents up to the budget rather than
// slicing mid-document, so whatever's included stays coherent; newest
// first, since that's most likely to be the current/active material.
//
// The per-document cap used to be 20,000 characters, which silently cut
// Akhada's own Scenic Breakdown (~33,000 characters, all 46 scenes) off at
// Scene 28 -- so every beat from 29 onward (Granthaloka through the
// Samudra Manthan climax) was being written without the user's own visual
// description of it. 40,000 fits a full-length scene breakdown whole, and
// the bigger total leaves room for extra attachments before the project's
// core documents would ever be pushed out. (~100,000 characters is roughly
// 25,000 tokens -- small next to what Gemini can take in one call.)
const AI_MOVIE_REFERENCE_MATERIAL_CHAR_BUDGET = 100_000;
const AI_MOVIE_REFERENCE_DOCUMENT_CHAR_CAP = 40_000;

async function getAiMovieReferenceMaterialText(projectId) {
  if (!projectId) return "";
  const result = await db.query(
    "SELECT category, label, content FROM ai_movie_reference_files WHERE project_id = $1 ORDER BY created_at DESC",
    [projectId]
  );

  const included = [];
  let total = 0;
  for (const row of result.rows) {
    const content =
      row.content.length > AI_MOVIE_REFERENCE_DOCUMENT_CHAR_CAP
        ? `${row.content.slice(0, AI_MOVIE_REFERENCE_DOCUMENT_CHAR_CAP)}\n(truncated for length)`
        : row.content;
    const entry = `[${row.category}] ${row.label ?? ""}\n${content}`;
    if (total > 0 && total + entry.length > AI_MOVIE_REFERENCE_MATERIAL_CHAR_BUDGET) break;
    included.push(entry);
    total += entry.length;
  }

  const omitted = result.rows.length - included.length;
  const text = included.join("\n\n---\n\n");
  if (!text) return text;
  // Reference files are often written before this app's own language rules
  // settled (Akhada's handoff still says "write the dialogue in Odia"),
  // while every AI Movie prompt asks for English + Hindi -- two opposite
  // orders in the same call, and a likely contributor to dialogue drifting
  // out of Hindi. The user's files are never edited; this one note tells
  // the model which order wins, without discarding anything else in them.
  const languageNote =
    "Language note: if anything in these reference files says which language to WRITE in (for example \"write the dialogue in Odia\"), ignore only that instruction — this AI Movie is written in English and Hindi only, exactly as your own instructions above say. Everything else in these files still applies in full, including Odia culture, names, places, and real Odia texts (such as the Malika verses) as part of the story itself.";
  const body = omitted > 0 ? `${text}\n\n---\n\n(${omitted} more attached document(s) omitted for length.)` : text;
  return `${languageNote}\n\n${body}`;
}

app.post("/api/ai-movie/backfill", requireRole("admin"), async (req, res) => {
  const { pastedText, stage, projectId } = req.body;

  if (!pastedText || !pastedText.trim()) {
    res.status(400).json({ error: "Paste some text first." });
    return;
  }
  if (!stage) {
    res.status(400).json({ error: "Analyze the text first." });
    return;
  }

  try {
    const referenceMaterialText = await getAiMovieReferenceMaterialText(projectId);
    const backfill = await generateAiMovieBackfill(pastedText, stage, referenceMaterialText);
    const assets = await generateAiMovieAssetExtraction(
      flattenAiMovieContentForExtraction(pastedText, backfill),
      referenceMaterialText
    );
    // Whatever the paste already covers (plus anything backfill just
    // invented behind it) is auto-approved — that's the whole point of
    // "final and authoritative, never rewritten." The step-by-step review
    // chain only kicks in for layers still ahead of it.
    const coveredIndex = AI_MOVIE_DETECTED_STAGE_COVERED_INDEX[stage] ?? -1;
    const stageStatus = approvedStageStatusUpTo(coveredIndex);

    if (projectId) {
      const title = backfill.story?.title?.en ?? null;
      await db.query(
        "UPDATE ai_movie_projects SET backfill = $1, assets = $2, stage_status = $3, title = COALESCE(title, $4), updated_at = now() WHERE id = $5",
        [JSON.stringify(backfill), JSON.stringify(assets), JSON.stringify(stageStatus), title, projectId]
      );
    }

    res.json({ backfill, assets, stageStatus });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// Fifth AI Movie piece: originate a Story straight from Reference Material
// alone, for when the user hasn't pasted anything into the main box yet.
// Unlike the backfill agent above (which protects whatever was pasted and
// only invents the layers BEHIND it), this one has nothing to protect — but
// it now only originates the Story layer, auto-approved, same as a plain
// 'story'-stage paste would be — Synopsis/Plot/Character Arc/Screenplay
// still go through the real step-by-step review chain from there, rather
// than arriving pre-generated with nothing to review.
const AI_MOVIE_SEED_FROM_REFERENCE_SYSTEM_PROMPT = `You are working on an AI Movie — a film that will be entirely AI-generated, never physically shot. Because of that, never reason about budget, cast/crew/location availability, shoot schedules, or any real-world production constraint — anything that can be imagined can be included, with no limitation.

The user hasn't written any story text yet. Below is reference material they've provided (a real book/source, and/or character/property/art details) — read it closely and originate a genuine, original Story (title + summary) from it. Stay faithful to the reference material — you are building a real story out of it, not inventing something unrelated to it.`;

async function generateAiMovieSeedFromReference(referenceMaterialText) {
  const result = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents: `Reference material:\n\n${referenceMaterialText}`,
    config: {
      systemInstruction: AI_MOVIE_SEED_FROM_REFERENCE_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
      responseSchema: {
        type: Type.OBJECT,
        properties: { story: AI_MOVIE_STORY_LAYER_SCHEMA },
        required: ["story"],
      },
    },
  });
  return result.story;
}

app.post("/api/ai-movie/generate-from-reference", requireRole("admin"), async (req, res) => {
  const { projectId } = req.body;

  if (!projectId) {
    res.status(400).json({ error: "Attach some reference material first." });
    return;
  }

  const referenceMaterialText = await getAiMovieReferenceMaterialText(projectId);
  if (!referenceMaterialText) {
    res.status(400).json({ error: "Attach some reference material first." });
    return;
  }

  try {
    const story = await generateAiMovieSeedFromReference(referenceMaterialText);
    const backfill = { story };
    const pastedText = `${story.title.en}\n\n${story.summary.en}`;
    const assets = await generateAiMovieAssetExtraction(
      flattenAiMovieContentForExtraction(pastedText, backfill),
      referenceMaterialText
    );
    const stageStatus = approvedStageStatusUpTo(0); // 'story' only

    await db.query(
      "UPDATE ai_movie_projects SET pasted_text = $1, detected_stage = 'story', backfill = $2, assets = $3, stage_status = $4, title = COALESCE(title, $5), updated_at = now() WHERE id = $6",
      [pastedText, JSON.stringify(backfill), JSON.stringify(assets), JSON.stringify(stageStatus), story.title.en, projectId]
    );

    res.json({ pastedText, stage: "story", backfill, assets, stageStatus });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// Sixth AI Movie piece: the step-by-step review chain itself. Once Story is
// approved (by whichever path got it there), each later layer —
// Synopsis, Plot, Character Arc, Screenplay — is generated ONE AT A TIME,
// using only the already-approved layers before it as fixed context, and
// sits as "pending" until the user reviews it: either Approve (locks it,
// unlocking the next layer) or Request Changes (regenerates just this
// layer with the user's feedback folded in, still pending after).
const AI_MOVIE_STAGE_GENERATION_SYSTEM_PROMPT = `You are working on an AI Movie — a film that will be entirely AI-generated, never physically shot. Because of that, never reason about budget, cast/crew/location availability, shoot schedules, or any real-world production constraint — anything that can be imagined can be included, with no limitation.

You are given the story's already-approved, locked earlier layers below — treat them as fixed and fully consistent, never contradict or rewrite them. Generate ONLY the one new layer the schema asks for, as a natural continuation of everything already locked in.`;

// No dialogue yet, deliberately — this stage writes the scenic breakdown
// only (scene heading + what happens), matching the user's own original
// Scenic Breakdown file, which separated visual description from dialogue
// on purpose. Dialogue becomes its own later pass, designed separately.
const AI_MOVIE_SCREENPLAY_SCENE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    sceneHeading: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    action: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    // The model's own estimate of this one scene's screen time, using the
    // standard page ≈ minute rule of thumb -- shown in the UI as a running
    // total against the beat's own runtimeMinutes target, so the estimate
    // that drove the scene count/lengths is actually checkable afterward,
    // not just an invisible internal step.
    estimatedMinutes: { type: Type.NUMBER },
  },
  required: ["sceneHeading", "action", "estimatedMinutes"],
};

const AI_MOVIE_FORWARD_STAGE_SCHEMAS = {
  synopsis: AI_MOVIE_SYNOPSIS_LAYER_SCHEMA,
  characterArc: { type: Type.ARRAY, items: AI_MOVIE_CHARACTER_ARC_SCHEMA },
  threeAct: { type: Type.ARRAY, items: AI_MOVIE_THREE_ACT_SCHEMA },
  plot: { type: Type.ARRAY, items: AI_MOVIE_PLOT_BEAT_SCHEMA },
  screenplay: { type: Type.ARRAY, items: AI_MOVIE_SCREENPLAY_SCENE_SCHEMA },
};

// Dialogue lives entirely outside AI_MOVIE_SCREENPLAY_SCENE_SCHEMA on
// purpose -- normal scene generation and the general scene-revise action
// both stay dialogue-free, matching the deliberate "no dialogue yet" design
// above. A scene only gets this structure once the user explicitly asks for
// dialogue, one scene at a time: an ORDERED list of blocks, action and
// dialogue interleaved exactly as they happen (action, a line, more action,
// a reply...), matching how a real screenplay reads -- never a separate
// action paragraph followed by a stacked list of lines.
// Standard screenplay transitions. A fixed list (enforced by the schema
// AND by the cleanup below) so a transition can never come back garbled or
// translated. Longest first, so "SMASH CUT TO:" is matched before "CUT TO:".
const AI_MOVIE_TRANSITIONS = [
  "SMASH CUT TO:",
  "SHARP CUT TO:",
  "MATCH CUT TO:",
  "JUMP CUT TO:",
  "DISSOLVE TO:",
  "INTERCUT WITH:",
  "FREEZE FRAME:",
  "FADE TO BLACK.",
  "TIME CUT:",
  "FADE OUT.",
  "CUT TO:",
];

const AI_MOVIE_SCENE_CONTENT_BLOCK_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    type: { type: Type.STRING, enum: ["action", "dialogue", "transition"] },
    text: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    // Only for type "transition" -- one of the standard terms, always in
    // English (like the scene heading), printed on its own right-aligned line.
    transition: { type: Type.STRING, enum: AI_MOVIE_TRANSITIONS },
    character: { type: Type.STRING },
    line: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    // Standard screenplay dialogue extras, both optional (see
    // AI_MOVIE_CONTENT_BLOCK_FORMAT_RULE): a short acting note under the
    // character name, and V.O./O.S. after it.
    parenthetical: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    extension: { type: Type.STRING, enum: ["V.O.", "O.S."] },
  },
  required: ["type"],
};

const AI_MOVIE_CONTENT_BLOCK_FORMAT_RULE = `DIALOGUE BLOCK EXTRAS (standard screenplay format, both optional on any dialogue block):
- "parenthetical": a very short acting note shown under the character name — 1 to 4 words, e.g. "quietly", "without looking up", "to Meera" — ONLY when how the line is said isn't already obvious from the line itself. Real scripts use these sparingly: most lines need none. No brackets, just the words; the "hi" version in Hindi.
- "extension": "V.O." when the voice comes from someone NOT physically in the scene (voiceover, a memory, a voice on a broadcast); "O.S." when the speaker IS in the scene's place but off camera (behind a door, from the next room). The NARRATOR is always "V.O.". Leave it out for everyone speaking on camera.
EVERY DIALOGUE BLOCK HAS REAL SPOKEN WORDS. A wordless reaction — a nod, a head-shake, a silence, a look — is an ACTION block ("Omm shakes his head."), never a dialogue block with an empty line.
TRANSITIONS (CUT TO:, SHARP CUT TO:, SMASH CUT TO:, MATCH CUT TO:, DISSOLVE TO:, FREEZE FRAME:, FADE OUT., and the rest of the allowed list) are NEVER written inside action text — each one is its own block with "type": "transition" and the "transition" field set to exactly one allowed value. Use them sparingly: most scenes simply end with no transition at all. Use one only when the cut itself carries meaning — a shock, a jump in time, or the scene's final decisive beat.`;

// Only "type" is actually required above (text/character/line all vary by
// type), so a real Gemini response has come back missing one -- the screen
// then crashed reading ".en" off of undefined. Guarantees every block that
// reaches the frontend has a real, safe bilingual object, falling back to
// the other language (or an empty string) rather than ever being missing
// outright.
function ensureAiMovieBilingualText(value) {
  const en = typeof value?.en === "string" ? value.en : "";
  const hi = typeof value?.hi === "string" && value.hi ? value.hi : en;
  return { en, hi };
}

// Code-level guarantee behind AI_MOVIE_HEADING_AND_NAMES_RULE: the heading
// is always the English slugline in both languages, and a heading the model
// repeated as the opening words of the action text (seen for real:
// "INT. AKHADA RING - TIMELESS Rakhyaka पांचों के सामने...") is trimmed off.
// Applied to every scene the writers return AND on the way out of a project
// load, so headings already saved as "अंत. ..." display correctly too.
// Splits a standard English slugline into its three parts -- needed later
// by Production to group scenes by location and time of day, the way a
// real script breakdown does. The LAST " - " part is the time ("INT.
// AKHADA RING - FAILED UNITY - TIMELESS" -> place "AKHADA RING - FAILED
// UNITY", time "TIMELESS"). Returns null when the heading doesn't start
// with INT./EXT. at all, rather than guessing.
function parseAiMovieSlugline(heading) {
  const match = heading.match(/^(INT\.?\s*\/\s*EXT\.?|EXT\.?\s*\/\s*INT\.?|I\/E\.?|INT\.?|EXT\.?)\s+(.+)$/);
  if (!match) return null;
  const intExt = /\//.test(match[1]) ? "INT/EXT" : match[1].startsWith("INT") ? "INT" : "EXT";
  const parts = match[2].split(/\s+[-–—]\s+/);
  const timeOfDay = parts.length > 1 ? parts.pop().trim() : "";
  return { intExt, location: parts.join(" - ").trim(), timeOfDay };
}

// First-draft writers are told not to write dialogue, but a real test run
// still had them type lines straight into the action text
// ("OMM\n(gesturing)\nThat's not just strain...") -- which prints as a
// plain action paragraph, never as dialogue. When the English and Hindi
// action split into the same number of paragraphs, each paragraph that
// starts with a character-name line is turned into a real dialogue block,
// in both languages by position. Anything that doesn't line up exactly is
// left as written.
const AI_MOVIE_TYPED_CUE_LINE = /^([A-Z][A-Z0-9 .'-]{0,30}?)(?:\s*\((V\.O\.|O\.S\.)\))?$/;
const AI_MOVIE_NOT_A_CUE = /\b(CLOSE|ON|CAMERA|ANGLE|INT|EXT|CUT|FADE|POV|INSERT|WIDE|SHOT|BACK|LATER|TEXT|SUPER|TITLE|MONTAGE|FLASHBACK|CONTINUOUS|DISSOLVE|NO DIALOGUE)\b/;

function splitAiMovieTypedDialogue(action) {
  const paragraphs = (text) => (text ?? "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const lines = (paragraph) => paragraph.split("\n").map((l) => l.trim()).filter(Boolean);
  const en = paragraphs(action?.en);
  const hi = paragraphs(action?.hi);
  if (en.length < 2 || en.length !== hi.length) return null;
  let found = false;
  const blocks = en.map((paragraph, i) => {
    const enLines = lines(paragraph);
    const hiLines = lines(hi[i]);
    const cue = enLines.length >= 2 && enLines[0].match(AI_MOVIE_TYPED_CUE_LINE);
    if (!cue || AI_MOVIE_NOT_A_CUE.test(cue[1]) || hiLines.length !== enLines.length) {
      return { type: "action", text: { en: paragraph, hi: hi[i] } };
    }
    found = true;
    const hasNote = enLines.length >= 3 && /^\(.*\)$/.test(enLines[1]);
    const from = hasNote ? 2 : 1;
    const block = {
      type: "dialogue",
      character: cue[1].trim(),
      line: { en: enLines.slice(from).join(" "), hi: hiLines.slice(from).join(" ") },
    };
    if (hasNote) block.parenthetical = { en: enLines[1], hi: hiLines[1] };
    if (cue[2]) block.extension = cue[2];
    return block;
  });
  return found ? sanitizeAiMovieContentBlocks(blocks) : null;
}

function normalizeAiMovieSceneFormat(scene) {
  // Standard screenplay sluglines are always in capitals.
  const heading = (scene?.sceneHeading?.en ?? "").trim().toUpperCase();
  // Also drops a heading line the Hindi text opens with in its own
  // (translated) form -- seen for real: "EXT. रिसीवर गैंट्री - CONTINUOUS",
  // which the exact-English match above can't catch.
  const stripHeading = (text) => {
    if (typeof text !== "string" || !heading) return text;
    const trimmed = text.trimStart();
    if (trimmed.toUpperCase().startsWith(heading)) return trimmed.slice(heading.length).trimStart();
    const firstLine = trimmed.split("\n", 1)[0];
    return /^(INT|EXT|I\/E)[.\s/]/i.test(firstLine) && firstLine.length <= 80 ? trimmed.slice(firstLine.length).trimStart() : text;
  };
  const stripBilingual = (value) => (value ? { ...value, en: stripHeading(value.en), hi: stripHeading(value.hi) } : value);

  const normalized = { ...scene, sceneHeading: { en: heading, hi: heading }, slugline: parseAiMovieSlugline(heading) };
  if (scene?.action) normalized.action = stripBilingual(scene.action);
  const hasContent = Array.isArray(scene?.content) && scene.content.length > 0;
  if (!hasContent && normalized.action) {
    const typedDialogue = splitAiMovieTypedDialogue(normalized.action);
    if (typedDialogue) {
      delete normalized.action;
      normalized.content = typedDialogue;
      return normalized;
    }
  }
  if (Array.isArray(scene?.content) && scene.content.length > 0) {
    const [first, ...rest] = scene.content;
    const trimmedFirst = first.type === "action" ? { ...first, text: stripBilingual(first.text) } : first;
    normalized.content = splitAiMovieTrailingTransitions([trimmedFirst, ...rest]);
  }
  return normalized;
}

// The parenthetical/extension extras only survive when they're real: an
// empty parenthetical is dropped, the extension must be exactly V.O./O.S.,
// and the NARRATOR is forced to V.O. (it's never on screen) whatever the
// model sent.
function sanitizeAiMovieDialogueBlock(block) {
  const character = typeof block.character === "string" ? block.character : "";
  const cleaned = { type: "dialogue", character, line: ensureAiMovieBilingualText(block.line) };
  if (typeof block.parenthetical?.en === "string" && block.parenthetical.en.trim()) {
    const parenthetical = ensureAiMovieBilingualText(block.parenthetical);
    const unwrap = (text) => text.trim().replace(/^\(\s*/, "").replace(/\s*\)$/, "");
    cleaned.parenthetical = { en: unwrap(parenthetical.en), hi: unwrap(parenthetical.hi) };
  }
  const extension = character.trim().toUpperCase() === "NARRATOR" ? "V.O." : block.extension;
  if (extension === "V.O." || extension === "O.S.") cleaned.extension = extension;
  return cleaned;
}

function sanitizeAiMovieContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks
    .map((block) => {
      if (block?.type === "dialogue") {
        // A real test run returned "OMM (shaking his head):" with no words
        // at all -- a silent reaction dressed up as a line, which would
        // print as an empty speech. Dropped: a line must have words.
        const cleaned = sanitizeAiMovieDialogueBlock(block);
        return cleaned.line.en.trim() || cleaned.line.hi.trim() ? cleaned : null;
      }
      // A transition block only survives if it's one of the standard terms
      // -- anything else would print as a garbled "transition", so it's
      // dropped rather than guessed at.
      if (block?.type === "transition") {
        const transition = typeof block.transition === "string" ? block.transition.trim().toUpperCase() : "";
        return AI_MOVIE_TRANSITIONS.includes(transition) ? { type: "transition", transition } : null;
      }
      return { type: "action", text: ensureAiMovieBilingualText(block.text) };
    })
    .filter(Boolean);
}

// Scenes written before transitions had their own block type carry them
// stuck onto the end of an action paragraph ("...he turns away. SHARP CUT
// TO:") -- and the model may still slip one in there. Splits any such
// trailing transition out into its own block, in both languages at once
// (it's the same English term in the Hindi text too, per the script-
// switching rule). Anything that isn't a clean trailing match is left
// exactly as it was.
function splitAiMovieTrailingTransitions(blocks) {
  const result = [];
  for (const block of blocks) {
    const en = block.type === "action" ? block.text?.en ?? "" : "";
    const transition = en && AI_MOVIE_TRANSITIONS.find((t) => en.trimEnd().toUpperCase().endsWith(t));
    if (!transition) {
      result.push(block);
      continue;
    }
    const strip = (text) => {
      const trimmed = (text ?? "").trimEnd();
      return trimmed.toUpperCase().endsWith(transition) ? trimmed.slice(0, trimmed.length - transition.length).trimEnd() : text;
    };
    const remaining = { ...block, text: { en: strip(block.text.en), hi: strip(block.text.hi) } };
    if (remaining.text.en) result.push(remaining);
    result.push({ type: "transition", transition });
  }
  return result;
}

// Renders one scene as plain text for prompt context -- covers all three
// shapes a scene can be in: still action-only, the new interleaved
// action/dialogue "content" blocks, or older data saved with the earlier
// separate flat "dialogue" list (still readable, just not re-split).
function sceneToPromptText(scene) {
  const heading = scene.sceneHeading?.en ?? "";
  if (Array.isArray(scene.content) && scene.content.length > 0) {
    const body = scene.content
      .map((block) =>
        block.type === "dialogue"
          ? `${block.character}${block.extension ? ` (${block.extension})` : ""}\n${block.parenthetical?.en ? `(${block.parenthetical.en})\n` : ""}${block.line?.en ?? ""}`
          : block.type === "transition"
            ? block.transition
            : block.text?.en ?? ""
      )
      .join("\n\n");
    return `${heading}\n${body}`;
  }
  const legacyDialogueBlock =
    Array.isArray(scene.dialogue) && scene.dialogue.length > 0
      ? `\n\n${scene.dialogue.map((d) => `${d.character}\n${d.line?.en ?? ""}`).join("\n\n")}`
      : "";
  return `${heading}\n${scene.action?.en ?? ""}${legacyDialogueBlock}`;
}

// Repeat catcher. A real test run on Akhada showed the writers padding a
// short beat with near-word-for-word copies of scenes already written
// (Beat 4 came back as 12 scenes, 9 of them copies of Beats 1-3 or of each
// other). A scene is dropped when at least 40% of its three-word runs
// already appear in the text it's checked against (the scenes written
// before it) -- a real new scene, even one in the same place with the same
// people, never repeats that much of the wording. (Set to 40% from the
// test data: clear copies overlapped 44-57%, genuinely different scenes
// never more than ~30%. A re-worded repeat overlaps less than that, so
// the beat checker below also catches repeats by meaning.)
const AI_MOVIE_REPEAT_OVERLAP_LIMIT = 0.4;

function aiMovieWordTriples(text) {
  const words = (text ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const triples = new Set();
  for (let i = 0; i + 2 < words.length; i++) triples.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return triples;
}

function dropAiMovieRepeatedScenes(newScenes, earlierText) {
  const seen = aiMovieWordTriples(earlierText);
  const kept = [];
  for (const scene of newScenes) {
    const triples = aiMovieWordTriples(sceneToPromptText(scene).split("\n").slice(1).join("\n"));
    let repeated = 0;
    for (const triple of triples) if (seen.has(triple)) repeated++;
    if (triples.size > 0 && repeated / triples.size >= AI_MOVIE_REPEAT_OVERLAP_LIMIT) continue;
    kept.push(scene);
    for (const triple of triples) seen.add(triple);
  }
  return kept;
}

// Real, checkable screen-time estimate -- never the AI's own self-reported
// "estimatedMinutes" guess, which tested for real came back well off.
//
// Uses the industry's own "one page = one minute" method the way
// screenwriting software (Final Draft etc.) actually measures a page: a
// standard page is ~55 lines of 12pt Courier; action lines wrap at ~60
// characters, dialogue sits in a narrow ~35-character column under a
// one-line character name, and a blank line separates every element.
// This replaced a plain words / 200 count, which a real scene proved
// wrong: its ~270 words said "~1.5 min", but laid out as a real page it's
// ~0.8 of a page -- matching the ~50-60 seconds it would actually run.
// Measured on the English text (every scene always has one, whatever the
// reader's display language).
const AI_MOVIE_LINES_PER_PAGE = 55;
const AI_MOVIE_ACTION_CHARS_PER_LINE = 60;
const AI_MOVIE_DIALOGUE_CHARS_PER_LINE = 35;
const AI_MOVIE_PARENTHETICAL_CHARS_PER_LINE = 25;

// How many printed lines this text takes when wrapped at `width`
// characters, one paragraph per line break -- whole words only, like a
// real screenplay page.
function countAiMovieWrappedLines(text, width) {
  let lines = 0;
  for (const paragraph of (text ?? "").split(/\n+/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let lineLength = 0;
    lines++;
    for (const word of words) {
      if (lineLength > 0 && lineLength + 1 + word.length > width) {
        lines++;
        lineLength = word.length;
      } else {
        lineLength += (lineLength > 0 ? 1 : 0) + word.length;
      }
    }
  }
  return lines;
}

function countAiMovieScenePageLines(scene) {
  // Scene heading + the blank line after it.
  let lines = 2;
  const addAction = (text) => {
    const n = countAiMovieWrappedLines(text, AI_MOVIE_ACTION_CHARS_PER_LINE);
    if (n > 0) lines += n + 1;
  };
  const addDialogue = (text, parenthetical) => {
    // Character name line + an optional parenthetical (its own narrower
    // ~25-character column) + the wrapped line itself + a blank line.
    const parentheticalLines = parenthetical ? countAiMovieWrappedLines(`(${parenthetical})`, AI_MOVIE_PARENTHETICAL_CHARS_PER_LINE) : 0;
    lines += 1 + parentheticalLines + Math.max(1, countAiMovieWrappedLines(text, AI_MOVIE_DIALOGUE_CHARS_PER_LINE)) + 1;
  };
  if (Array.isArray(scene.content) && scene.content.length > 0) {
    for (const block of scene.content) {
      if (block.type === "dialogue") addDialogue(block.line?.en, block.parenthetical?.en);
      // A transition is one right-aligned line plus the blank line after it.
      else if (block.type === "transition") lines += 2;
      else addAction(block.text?.en);
    }
  } else {
    addAction(scene.action?.en);
    if (Array.isArray(scene.dialogue)) {
      for (const line of scene.dialogue) addDialogue(line.line?.en);
    }
  }
  return lines;
}

// Rounded to the whole SECOND (still stored in minutes): the screen now
// shows scene times in seconds ("12 sec" -- the user's call), and the old
// 0.1-minute rounding could only ever say 0, 6, 12, 18... seconds.
function computeAiMovieSceneMinutes(scene) {
  return Math.round((countAiMovieScenePageLines(scene) / AI_MOVIE_LINES_PER_PAGE) * 60) / 60;
}

// "12 sec", "1 min 6 sec", "3 min" -- the same wording the screen uses.
function formatAiMovieDuration(minutes) {
  const totalSeconds = Math.round((Number(minutes) || 0) * 60);
  if (totalSeconds < 60) return `${totalSeconds} sec`;
  const wholeMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${wholeMinutes} min ${seconds} sec` : `${wholeMinutes} min`;
}

// A silent, one-time "voice brief" per named character -- generated
// automatically the moment the Beat Sheet is approved (the earliest point
// the full cast AND the complete beat-by-beat story progression both
// exist), never a separate button or approval screen the user has to deal
// with. Feeds "Write Dialogue" with more than just want/need/arc: an
// inferred background, profession, and speech-cadence brief a dialogue
// writer can actually use to keep each character's spoken voice distinct.
const AI_MOVIE_CHARACTER_DIALOGUE_BRIEF_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    brief: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
  },
  required: ["name", "brief"],
};

const AI_MOVIE_CHARACTER_DIALOGUE_BRIEF_SYSTEM_PROMPT = `You are a character and dialect analyst working on an AI Movie — a film that will be entirely AI-generated, never physically shot.

You are given the story's approved Story, Synopsis, Character Arc (want/need/arc for every character), Three-Act Structure, and complete Beat Sheet (the whole story's beat-by-beat progression) below. For EVERY named character in the Character Arc layer, write a short, practical brief a dialogue writer can use later to make that character's spoken lines sound distinct and authentic — not a biography, just what actually shapes how they talk: their likely socio-economic background and social milieu, their profession or role and any vocabulary that comes naturally with it, their speech cadence and habits (talkative or terse, blunt or polite, confident or hesitant, any verbal tics), and how their voice should shift across the story given their own arc (e.g. more guarded early on, more direct once they've changed by the end). Base every detail on what the story, beats, and their own want/need/arc actually imply — never invent unrelated backstory. Keep each brief tight (a few sentences) and immediately usable, not exhaustive.`;

async function generateAiMovieCharacterDialogueBriefs(priorContextText, referenceMaterialText) {
  const referenceBlock = referenceMaterialText
    ? `\n\nThe user has also provided reference material below — treat it as authoritative grounding, stay faithful to it:\n\n${referenceMaterialText}`
    : "";

  const result = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents: `The story's approved layers so far:\n\n${priorContextText}${referenceBlock}\n\nNow write a dialogue voice brief for every named character.`,
    config: {
      systemInstruction: AI_MOVIE_CHARACTER_DIALOGUE_BRIEF_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          briefs: { type: Type.ARRAY, items: AI_MOVIE_CHARACTER_DIALOGUE_BRIEF_SCHEMA },
        },
        required: ["briefs"],
      },
    },
  });
  return result.briefs;
}

// Shared by every place that feeds a dialogue writer the character voice
// briefs -- the manual "Write Dialogue" endpoint and the automatic
// fill-to-target dialogue phase alike.
function aiMovieCharacterDialogueBriefsText(backfill) {
  return Array.isArray(backfill?.characterDialogueBriefs)
    ? backfill.characterDialogueBriefs.map((b) => `${b.name}: ${b.brief.en}`).join("\n\n")
    : "";
}

// Same "just open the project" self-heal already used for a stuck
// screenplay beat -- covers a project whose Beat Sheet was already approved
// BEFORE this brief existed, so the normal approval-time trigger never ran
// for it and never will again (it's a one-time event, not a stage the user
// can re-approve). Fires in the background; the GET response doesn't wait
// on it, same as the screenplay buffer fill.
//
// Guarded, because this is called on EVERY project GET -- and the screen
// polls that every 4 seconds while beats are writing. Unguarded, a missing
// brief started a brand-new Gemini call on every poll, overlapping ones
// still in flight, and a brief that kept failing was retried every 4
// seconds forever -- burning quota the real beat writing needs. Now: at
// most one attempt per project at a time, and a failed attempt waits out a
// cooldown before the next. (In-memory only on purpose -- a server restart
// simply allows one fresh attempt, which is exactly right.)
const AI_MOVIE_BRIEF_BACKFILL_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
const aiMovieBriefBackfillInFlight = new Set();
const aiMovieBriefBackfillLastFailedAt = new Map();

async function backfillAiMovieCharacterDialogueBriefsIfMissing(projectId, pastedText, backfill) {
  if (!Array.isArray(backfill?.plot) || !Array.isArray(backfill?.characterArc) || backfill.characterDialogueBriefs) return;
  if (aiMovieBriefBackfillInFlight.has(projectId)) return;
  const lastFailedAt = aiMovieBriefBackfillLastFailedAt.get(projectId);
  if (lastFailedAt && Date.now() - lastFailedAt < AI_MOVIE_BRIEF_BACKFILL_RETRY_COOLDOWN_MS) return;

  aiMovieBriefBackfillInFlight.add(projectId);
  try {
    const referenceMaterialText = await getAiMovieReferenceMaterialText(projectId);
    const briefs = await generateAiMovieCharacterDialogueBriefs(
      flattenAiMovieContentForExtraction(pastedText, backfill),
      referenceMaterialText
    );
    await saveAiMovieBackfillField(projectId, "characterDialogueBriefs", briefs);
    aiMovieBriefBackfillLastFailedAt.delete(projectId);
  } catch (error) {
    aiMovieBriefBackfillLastFailedAt.set(projectId, Date.now());
    console.error("Background character dialogue brief backfill failed (next attempt after cooldown):", error.message);
  } finally {
    aiMovieBriefBackfillInFlight.delete(projectId);
  }
}

// Scene cards: a silent story analyst gives every written scene a small
// card -- what the scene is FOR (moves the plot, reveals character, or
// both), the main emotion the AUDIENCE should feel, how strong it is on a
// 1-10 scale measured against the whole film, and the emotional turn from
// the scene's start to its end. Standard story-craft bookkeeping (a scene
// that doesn't turn is usually a weak scene), and the emotion data is what
// music, lighting, and performance will need later in Production.
// Written in the background for any scene that doesn't have one yet --
// existing scenes included -- never as a separate step the user runs.
const AI_MOVIE_SCENE_CARD_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    purpose: { type: Type.STRING, enum: ["plot_advancing", "character_revealing", "both"] },
    emotion: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    intensity: { type: Type.NUMBER },
    turn: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
  },
  required: ["purpose", "emotion", "intensity", "turn"],
};

const AI_MOVIE_SCENE_CARD_SYSTEM_PROMPT = `You are a story analyst on an AI Movie. For EACH scene given (in order, one card per scene), write a scene card:
- "purpose": "plot_advancing" if it mainly moves the story's events forward, "character_revealing" if it mainly shows who someone is or how they are changing, "both" if it genuinely does both.
- "emotion": the main emotion the AUDIENCE should feel in this scene, in one or two words (e.g. "dread", "quiet grief", "joy"). Write it in simple English, and in natural Hindi for "hi".
- "intensity": 1 to 10, measured against the WHOLE film, not just this beat — 10 is reserved for the film's very biggest moments (the interval cliffhanger, the climax); a quiet transition is 1-3.
- "turn": the scene's emotional value at its START → at its END, e.g. "hope → dread". If the emotion genuinely doesn't change, say so honestly with the same value on both sides (e.g. "calm → calm") — do not invent a turn that isn't in the scene.
Judge only from what is actually written in each scene.`;

async function generateAiMovieSceneCards(beatLabel, scenesText, sceneCount) {
  const result = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents: `${beatLabel}\n\nIts ${sceneCount} scenes, in order:\n\n${scenesText}\n\nWrite exactly ${sceneCount} scene cards, one per scene, in the same order.`,
    config: {
      systemInstruction: AI_MOVIE_SCENE_CARD_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
      responseSchema: {
        type: Type.OBJECT,
        properties: { cards: { type: Type.ARRAY, items: AI_MOVIE_SCENE_CARD_SCHEMA } },
        required: ["cards"],
      },
    },
  });
  return result.cards.map((card) => ({
    purpose: ["plot_advancing", "character_revealing", "both"].includes(card.purpose) ? card.purpose : "both",
    emotion: ensureAiMovieBilingualText(card.emotion),
    intensity: Math.min(10, Math.max(1, Math.round(Number(card.intensity) || 1))),
    turn: ensureAiMovieBilingualText(card.turn),
  }));
}

// Same guards as the voice-brief self-heal (it's triggered from the same
// polled project GET): one run per project at a time, a cooldown after a
// failure. Works through beats in order, one Gemini call per beat.
//
// Each card is saved straight onto its own scene with one atomic database
// update -- and ONLY if that scene still has the heading it had when it
// was read. The user may revise or regenerate a scene while this runs in
// the background; a card written for the old scene is then simply
// skipped (and the new scene gets its own card on a later pass), so this
// can never overwrite newer work or attach a card to the wrong scene.
const aiMovieSceneCardsInFlight = new Set();
const aiMovieSceneCardsLastFailedAt = new Map();

async function fillAiMovieSceneCardsIfMissing(projectId, backfill) {
  const screenplayBeats = backfill?.screenplayBeats;
  if (!Array.isArray(screenplayBeats)) return;
  const needsCards = (beat) =>
    (beat.status === "pending" || beat.status === "approved") && Array.isArray(beat.scenes) && beat.scenes.some((scene) => !scene.card);
  if (!screenplayBeats.some(needsCards)) return;
  if (aiMovieSceneCardsInFlight.has(projectId)) return;
  const lastFailedAt = aiMovieSceneCardsLastFailedAt.get(projectId);
  if (lastFailedAt && Date.now() - lastFailedAt < AI_MOVIE_BRIEF_BACKFILL_RETRY_COOLDOWN_MS) return;

  aiMovieSceneCardsInFlight.add(projectId);
  try {
    const plot = backfill.plot ?? [];
    for (let beatIndex = 0; beatIndex < screenplayBeats.length; beatIndex++) {
      const beat = screenplayBeats[beatIndex];
      if (!needsCards(beat)) continue;
      const meta = plot[beatIndex];
      const beatLabel = `Beat ${beatIndex + 1} of ${screenplayBeats.length}: ${meta?.title?.en ?? ""} — ${meta?.description?.en ?? ""}`;
      const scenesText = beat.scenes.map((scene, i) => `SCENE ${i + 1}\n${sceneToPromptText(scene)}`).join("\n\n");
      const cards = await generateAiMovieSceneCards(beatLabel, scenesText, beat.scenes.length);
      // A wrong count can't be matched to scenes reliably -- treat it as a
      // failure (cooldown) rather than retrying this beat on every poll.
      if (cards.length !== beat.scenes.length) throw new Error(`Expected ${beat.scenes.length} scene cards, got ${cards.length}`);
      for (let sceneIndex = 0; sceneIndex < beat.scenes.length; sceneIndex++) {
        const scene = beat.scenes[sceneIndex];
        if (scene.card || !cards[sceneIndex]) continue;
        await db.query(
          `UPDATE ai_movie_projects
             SET backfill = jsonb_set(backfill, $2::text[], $3::jsonb)
           WHERE id = $1 AND backfill #>> $4::text[] = $5`,
          [
            projectId,
            ["screenplayBeats", String(beatIndex), "scenes", String(sceneIndex), "card"],
            JSON.stringify(cards[sceneIndex]),
            ["screenplayBeats", String(beatIndex), "scenes", String(sceneIndex), "sceneHeading", "en"],
            scene.sceneHeading?.en ?? "",
          ]
        );
      }
    }
    aiMovieSceneCardsLastFailedAt.delete(projectId);
  } catch (error) {
    aiMovieSceneCardsLastFailedAt.set(projectId, Date.now());
    console.error("Background scene card fill failed (next attempt after cooldown):", error.message);
  } finally {
    aiMovieSceneCardsInFlight.delete(projectId);
  }
}

async function generateAiMovieForwardStage(stageKey, priorContextText, referenceMaterialText, feedback) {
  const referenceBlock = referenceMaterialText
    ? `\n\nThe user has also provided reference material below — treat it as authoritative grounding, stay faithful to it:\n\n${referenceMaterialText}`
    : "";
  const feedbackBlock = feedback
    ? `\n\nThe user reviewed an earlier draft of this exact layer and asked for these changes — revise accordingly, still fully consistent with the locked layers above:\n${feedback}`
    : "";
  // Beat Sheet entries also need an honest screen-time estimate -- this
  // later drives how many scenes (and how long each) the Screenplay stage
  // writes for that beat, instead of guessing a scene count in isolation.
  const stageSpecificBlock =
    stageKey === "plot"
      ? `\n\nFor each beat, also estimate "runtimeMinutes" — roughly how many minutes of screen time this beat needs, based on its own scope and dramatic weight (a quick transitional or dialogue beat might be 1-2 minutes; a big action, song, or emotional set-piece might be 5+ minutes). Be honest and varied — most beats should NOT be the same length.`
      : "";

  const result = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents: `The story's approved layers so far:\n\n${priorContextText}${referenceBlock}${feedbackBlock}${stageSpecificBlock}\n\nNow generate the "${stageKey}" layer.`,
    config: {
      systemInstruction: AI_MOVIE_STAGE_GENERATION_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      responseSchema: { type: Type.OBJECT, properties: { [stageKey]: AI_MOVIE_FORWARD_STAGE_SCHEMAS[stageKey] }, required: [stageKey] },
    },
  });
  return result[stageKey];
}

// Screenplay is uniquely large — the task is to expand a 46-beat sheet into
// roughly 120-150 full scenes ("a beat is a pocket, not one scene"), which
// no single Gemini call can hold regardless of token budget: a first
// attempt at "the whole screenplay in one call" produced only 3 scenes
// before running out of room. Screenplay generation writes ONE beat's
// scenes at a time, using every scene already written as context, so the
// result reads as one continuous draft instead of 46 disconnected
// fragments.
//
// Reviewed the same way, one beat at a time: backfill.screenplayBeats is an
// array parallel to backfill.plot, each entry { scenes, status, feedback }
// with status one of not_started / generating / pending / approved / error.
// A background "buffer" of AI_MOVIE_SCREENPLAY_BUFFER_SIZE beats stays
// generated ahead of whichever beat the user is currently reviewing, topped
// back up each time they approve one — so there's always a small queue of
// ready beats waiting, never a wait for the next one to write itself.
// Beat boundaries. A real test run on Akhada showed every writer drifting
// across beats: Beat 1 also wrote Beats 5-7, Beat 2 re-wrote Beats 3-6, and
// the Pahandi song beat (8) went on to write the sky breach and the
// Rakhyaka's fight (Beats 9-11) -- so the film's biggest moments got used
// up in the wrong place. The writers only ever saw this beat's title, with
// an unnumbered Beat Sheet and reference files numbered "SCENE 1..46", so
// they couldn't tell where this beat ended. Every writer working on one
// beat -- new scenes, expansion, Request Changes, Extend, Write Dialogue,
// song sheet, Script Doctor -- now gets this note naming the beat by
// number, the beats on either side, and what that means. It goes at the
// very END of each prompt, next to the task itself: placed earlier (before
// ~30 pages of reference material) a second test run showed Beat 1 still
// ignoring it.
function aiMovieBeatForWriters(beats, beatIndex) {
  return {
    ...beats[beatIndex],
    boundaryNote: aiMovieBeatBoundaryNote(beats, beatIndex),
    beatNumber: beatIndex + 1,
    beatSheetText: beats.map((b, i) => `Beat ${i + 1} — ${b.title.en}: ${b.description.en}`).join("\n"),
  };
}

// Beat checker. Even with the boundary note at the end of the prompt, a
// third test run still had Beat 1 writing Beat 4's gantry scene and Beat
// 5's call to Rudra's sister -- the cheaper writing model reliably follows
// its reference file past where the beat ends. So every batch of new
// scenes gets one small, cheap check: given only the numbered Beat Sheet,
// which beat does each scene mainly show? Scenes that belong to another
// beat are dropped. Best effort -- if the check itself fails, the scenes
// are kept as written rather than failing the whole beat.
const AI_MOVIE_BEAT_CHECK_SYSTEM_PROMPT = `You check a film screenplay draft for scenes written under the wrong beat. You get the film's numbered Beat Sheet and the new scenes written for ONE beat. For each scene, name the ONE beat number whose events that scene mainly shows. A scene that shows this beat's own events in more detail — their steps, the reactions, the place around them — belongs to this beat, even when it adds small details the Beat Sheet line doesn't mention. Only name a different beat when the scene's main events are clearly that other beat's events, as the Beat Sheet describes them.
Also mark "repeatsEarlier": true when a scene mainly shows AGAIN something already shown — in an earlier scene of this list, or in this beat's scenes already written (if given) — just re-worded, instead of moving the moment forward. The same event shown from a genuinely new angle that adds something (a new reaction, a new consequence) is not a repeat.`;

async function keepAiMovieScenesInTheirBeat(beat, scenes, existingBeatScenesText = "") {
  if (!beat?.beatSheetText || !Number.isInteger(beat.beatNumber) || scenes.length === 0) return scenes;
  const scenesText = scenes.map((scene, i) => `SCENE ${i + 1}\n${sceneToPromptText(scene)}`).join("\n\n");
  const existingBlock = existingBeatScenesText ? `\n\nThis beat's scenes already written (context only, not to be judged):\n\n${existingBeatScenesText}` : "";
  try {
    const result = await generateJsonContent({
      model: GEMINI_MODEL_NAME,
      contents: `Beat Sheet:\n${beat.beatSheetText}${existingBlock}\n\nThese NEW scenes were written for Beat ${beat.beatNumber}:\n\n${scenesText}\n\nFor each new scene: which beat's events does it mainly show, and does it just repeat something already shown?`,
      config: {
        systemInstruction: AI_MOVIE_BEAT_CHECK_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        maxOutputTokens: 2048,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            scenes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: { sceneNumber: { type: Type.NUMBER }, beatNumber: { type: Type.NUMBER }, repeatsEarlier: { type: Type.BOOLEAN } },
                required: ["sceneNumber", "beatNumber", "repeatsEarlier"],
              },
            },
          },
          required: ["scenes"],
        },
      },
    });
    const dropped = new Set(
      (result.scenes ?? [])
        .filter((entry) => Math.round(Number(entry.beatNumber)) !== beat.beatNumber || entry.repeatsEarlier === true)
        .map((entry) => Math.round(Number(entry.sceneNumber)))
    );
    if (dropped.size > 0) {
      const headings = scenes.filter((_, i) => dropped.has(i + 1)).map((scene) => scene.sceneHeading?.en).join(" | ");
      console.log(`Beat ${beat.beatNumber}: dropped ${dropped.size} of ${scenes.length} new scene(s) -- another beat's events, or a repeat: ${headings}`);
    }
    return scenes.filter((_, i) => !dropped.has(i + 1));
  } catch (error) {
    console.error("Beat check failed, keeping the scenes as written:", error.message);
    return scenes;
  }
}

function aiMovieBeatBoundaryBlock(beat) {
  return beat?.boundaryNote ? `\n\n${beat.boundaryNote}` : "";
}

function aiMovieBeatBoundaryNote(beats, beatIndex) {
  const beat = beats?.[beatIndex];
  if (!beat) return "";
  const number = beatIndex + 1;
  const previous = beats[beatIndex - 1];
  const next = beats[beatIndex + 1];
  const lines = [
    `THIS BEAT'S BOUNDARIES: you are working on Beat ${number} of ${beats.length} ("${beat.title.en}") and ONLY that beat.`,
    previous
      ? `- The beat before it, Beat ${number - 1} ("${previous.title.en}"), is handled on its own — never re-stage its events here.`
      : "- This is the film's first beat.",
    next
      ? `- The beat after it, Beat ${number + 1} ("${next.title.en}": ${next.description.en}), is written separately, later. NONE of its events may appear here — not as a lead-in, a teaser, or "the next natural step". The same goes for every later beat.`
      : "- This is the film's last beat.",
    `- If the reference material numbers its scenes or beats the same way (e.g. "SCENE ${number}"), only the part numbered ${number} belongs to this beat. Read the other numbered parts for context only — never write them.`,
  ];
  if (isAiMovieSongBeat(beat)) {
    lines.push(
      "- This is a SONG beat: the song itself fills most of this beat's screen time (its song sheet — music, singers, how it is filmed — is written separately). Write the scene(s) the song sits in: what we see just before and while it plays, with one plain action line where the song begins. Never add events from other beats to fill the time."
    );
  }
  return lines.join("\n");
}

// The INTERVAL -- placed by the user on a beat card (their choice: never
// guessed automatically), stored as backfill.intervalAfterBeat. Every
// writer working on that beat is told it ends at the interval, and the beat
// right after is told it opens the second half, per the project's own
// Rule 1 (Indian film: the scene before the interval is one of the biggest
// moments in the whole film, cut at the peak). Appended to the story
// context every writer already receives, so all of them -- new scenes,
// expansion, Request Changes, Write Dialogue -- get it the same way.
function withAiMovieIntervalNote(priorContextText, backfill, beatIndex) {
  const intervalAfterBeat = backfill?.intervalAfterBeat;
  if (!Number.isInteger(intervalAfterBeat)) return priorContextText;
  if (beatIndex === intervalAfterBeat) {
    return `${priorContextText}\n\nINTERVAL: this beat ENDS AT THE FILM'S INTERVAL (Indian cinema's mid-film break). Its final scene must end on one of the very biggest moments of the whole film — a shock, a twist, or a strong emotional peak — as big as the climax in its own way, so the audience is desperate to come back. Build to that peak and cut to interval AT the peak, never after it has cooled down. Earlier scenes in this beat should build toward it.`;
  }
  if (beatIndex === intervalAfterBeat + 1) {
    return `${priorContextText}\n\nAFTER THE INTERVAL: this beat opens the second half of the film, right after the interval. Its first scene should pick the story straight back up with fresh energy and a strong hook, not a slow recap.`;
  }
  return priorContextText;
}

const AI_MOVIE_SCREENPLAY_BUFFER_SIZE = 4;

// Basic screenplay format, shared word-for-word by every agent that writes
// scene text (first draft, expansion, per-scene revise, Write Dialogue).
// A real scene came back reading like a novel -- "the weight of unspoken
// things hangs in his eyes", "adds a layer of mystery and fear" -- words
// the camera can't film, so ~40% of it added length on the page but zero
// seconds on screen, and the scene's duration (page ~ minute) came out
// well over what it would actually run. The wrong/right pairs are taken
// from that exact scene; contrastive examples like these are what made the
// Hindi script-switching rule actually stick earlier.
const AI_MOVIE_SCREEN_ONLY_RULE = `SCREEN-ONLY WRITING (basic screenplay format — this overrides any urge to write "vividly" in prose): action text describes ONLY what the camera can see and the microphone can hear — people, faces, bodies, movement, objects, light, weather, sound. NEVER write a character's inner thoughts, feelings named as abstractions, the meaning or symbolism of a moment, or what the audience should feel. Show every feeling through something visible or audible instead.
- WRONG: "The weight of unspoken things hangs in his eyes." RIGHT: "He looks away. His grip tightens on the staff."
- WRONG: "The announcement hangs in the air, adding a layer of mystery and fear." RIGHT: "Silence. A torch crackles."
- WRONG: "Her doubts wrestle with the undeniable reality." RIGHT: "Tara shakes her head once. She doesn't look up."
- WRONG: "Their low voices express shared grief and respect, signalling an agreement of ancient wisdom." RIGHT: "The clan members murmur and bow their heads."
Every sentence must be something that takes real screen time. Never add words just to make a scene longer — to make a scene longer, add more real on-screen moments: actions, reactions, events, lines.
Never copy the reference material's notes to the writer into the action — lines like "(They speak — dialogue later)", "No dialogue needed", or a closing comment on what the moment means ("A careful man, breaking the world by the book.", "The city is sick.") are instructions for you, not things on screen — and never add notes like that of your own ("NO DIALOGUE.").`;

// Scene headings and names, in both languages. A real Hindi scene heading
// came back as "अंत. अखाड़ा रिंग" -- "INT." translated into "अंत.", which
// means "the end" -- and names switched between Latin ("Rudra") and
// Devanagari ("रुद्र") inside one scene. The user chose Latin-script names
// everywhere: one spelling that always matches the character list and the
// English character cue above each line. (The heading is also enforced in
// code -- see normalizeAiMovieSceneFormat -- this just keeps the model
// from fighting it.)
const AI_MOVIE_HEADING_AND_NAMES_RULE = `SCENE HEADINGS AND NAMES: the scene heading is ALWAYS standard English screenplay format ("INT. AKHADA RING - TIMELESS", "EXT. GRAND ROAD - DAY") — in the "hi" field too, exactly the same English text, never translated (translating "INT." into Hindi turns it into a different word entirely). Never repeat the scene heading inside the action text. Every character name, in every "hi" field, is written in ENGLISH (Latin) letters exactly as it appears in the character list — "Rudra आगे बढ़ता है", never "रुद्र आगे बढ़ता है" — so each name has one spelling everywhere.`;

// The other half of the script-switching rule. With only "switch often,
// never zero", a real test run over-switched into words no Hindi speaker
// says in English -- "Rudra की jaw कस जाती है", "तीर्थयात्रियों का ocean",
// "saffron रंग", and a formal "अनुरोध" sitting next to "patience". The
// wrong/right pairs below are taken from that run.
const AI_MOVIE_HINDI_SWITCH_LIMITS_RULE = `LIMITS ON ENGLISH INSIDE HINDI: switch ONLY words that people in India really say in English in everyday talk — tech, work and modern-life words (phone, power, grid, system, signal, data, screen, payment, deal, sir, sorry, OK) and this story's own sci-fi names and terms (Receiver, holo-banner, nav chip). NEVER switch an ordinary word that has a common everyday Hindi word — body parts, colours, nature, feelings, family, simple actions:
- WRONG: "Rudra की jaw कस जाती है" RIGHT: "Rudra का जबड़ा कस जाता है"
- WRONG: "तीर्थयात्रियों का ocean" RIGHT: "तीर्थयात्रियों का समंदर"
- WRONG: "saffron रंग के कपड़े" RIGHT: "केसरिया कपड़े"
- WRONG: "कृपया patience बनाए रखने का अनुरोध है" RIGHT: "थोड़ा सब्र रखिए"
- Faith words are ALWAYS Hindi — god, temple, pray, prayer, devotee, worship, soul, blessing: WRONG "हमारे god यहीं रहे", "उनके temple", "pray करने की जगह" RIGHT "हमारे भगवान यहीं रहे", "उनके मंदिर", "पूजा करने की जगह". Same for everyday feeling words: WRONG "पृथ्वी एक memory है", "एक ghost की तरह" RIGHT "पृथ्वी एक याद है", "वीरान".
- The NARRATOR's Hindi is plain spoken Hindi with very few English words at all.
Keep the Hindi around the English words casual and spoken — never a formal, bookish word ("अनुरोध", "कृपया", "प्रतीक्षा") next to an English one. In ACTION text, even fewer switches: plain, simple Hindi, with English only for camera directions and the story's own tech names.`;

// How a beat is meant to reach its fixed time. The same test run showed
// the writers hitting the number with the wrong material: scenes borrowed
// from other beats, near-copies of scenes already written, a made-up
// cut-away (Samir watching a live feed of the off-world prayer room, which
// no beat mentions), and the reference file's own notes to the writer
// copied into the action ("A careful man, breaking the world by the
// book.", "(They speak -- dialogue later)").
const AI_MOVIE_FILL_TIME_HONESTLY_RULE = `FILLING A BEAT'S TIME HONESTLY: a beat's Beat Sheet line, and the reference material's paragraph for it, are a SUMMARY, not the finished scene — a beat with a real target time needs many more on-screen moments than the summary lists. Reach the time by showing THIS beat's own events in fuller on-screen detail: break each event into its steps, and show the reactions, small physical actions, sounds, and the place around them. Good ways to add real screen time inside a beat:
- the moments just before and just after its main event;
- the event's effect on the place and people this beat already involves (the city below as its lights fail, the crowd looking up);
- a small private action that shows who a character is (Samir's hands on the controls, Omm wiping grease off his palm);
- letting a big moment play out in full — step by step, with the silence after it — instead of in one line.
NEVER reach it by:
- writing events that belong to another beat (earlier or later);
- cutting away to characters or storylines this beat doesn't involve — e.g. showing someone watching a screen of this beat's events when the beat never mentions them;
- repeating or re-wording a scene that already exists, in this beat or an earlier one.
WHAT A SCENE IS: a new scene starts only when the place or the time changes. Everything that happens continuously in one place is ONE scene — never chop it into a row of short "CONTINUOUS" scenes of a shot or two each. Each event happens ONCE: once Rudra has pushed the slider, no later scene shows him pushing it again. And no dialogue in this pass — write "Omm begs him to pull back", never a character name followed by a spoken line.`;

const AI_MOVIE_SCREENPLAY_BEAT_SYSTEM_PROMPT = `You are working on an AI Movie — a film that will be entirely AI-generated, never physically shot. Because of that, never reason about budget, cast/crew/location availability, shoot schedules, or any real-world production constraint — anything that can be imagined can be included, with no limitation.

You are given the story's already-approved, locked layers (Story, Synopsis, Characters, Three-Act Structure, full Beat Sheet) below, plus every screenplay scene already written so far. Write ONLY the scenes for the ONE beat named at the end — a beat is a pocket, not a single scene, so expand it into however many full scenes this ONE beat genuinely needs to be properly established: never fewer than 2, but no upper limit either — a simple beat might need only 2, a dense or eventful one might need 7 or more. The beat comes with its own target screen-time in minutes — use the standard screenwriting rule of thumb that one screenplay page equals about one minute of screen time to translate that target into an implied page count, and let the scene count AND each scene's own length follow from that: a beat with a small target should stay tight (fewer/shorter scenes), a beat with a large target earns more room (more and/or longer scenes). Give each scene its own honest "estimatedMinutes" estimate, and keep the sum of those estimates close to the beat's target — never pad or compress scenes just to hit the number exactly, but treat the target as the real guide for scope, not a suggestion to ignore. That target is a starting guide, not a hard ceiling: if the user's own feedback below explicitly asks for this beat (or a scene in it) to be longer, slower, or more detailed, honor that even if it pushes the total well past the original target — the user is always free to make the story longer, and a later regeneration of this same beat can simply carry forward a bigger target next time. Each scene needs a scene heading and a vivid action/visual description. Do NOT write any dialogue — that is a separate, later pass; describe what happens and what's said only in action-line terms (e.g. "she pleads with him"), never as quoted lines. Continue directly from the last scene already written (same characters, same momentum, no repeats) — never jump ahead to a later beat.

${AI_MOVIE_FILL_TIME_HONESTLY_RULE}

${AI_MOVIE_SCREEN_ONLY_RULE}

${AI_MOVIE_HEADING_AND_NAMES_RULE}`;

async function generateAiMovieScreenplayBeat(priorContextText, referenceMaterialText, scenesSoFarText, beat, feedback) {
  const referenceBlock = referenceMaterialText
    ? `\n\nThe user has also provided reference material below — treat it as authoritative grounding, stay faithful to it:\n\n${referenceMaterialText}`
    : "";
  const feedbackBlock = feedback
    ? `\n\nThe user reviewed an earlier draft of this exact beat's scenes and asked for these changes — revise accordingly, still fully consistent with the locked layers above:\n${feedback}`
    : "";
  const scenesBlock = scenesSoFarText ? `\n\nScreenplay scenes already written so far:\n\n${scenesSoFarText}` : "";
  // Older beats (generated before runtimeMinutes was added to the schema) may
  // not carry a target -- fall back to letting the beat's own content decide,
  // same as before this feature existed.
  const runtimeBlock =
    typeof beat.runtimeMinutes === "number" && beat.runtimeMinutes > 0
      ? ` Target roughly ${beat.runtimeMinutes} minutes of screen time for this beat (about ${beat.runtimeMinutes} screenplay pages, by the page-equals-minute rule of thumb) — let that drive how many scenes you write and how long each one is.`
      : "";

  const result = await generateJsonContent({
    model: AI_MOVIE_SCREENPLAY_WRITER_MODEL_NAME,
    contents: `The story's approved layers so far:\n\n${priorContextText}${referenceBlock}${feedbackBlock}${scenesBlock}\n\nNow write the scenes for this beat:\n${beat.title.en}: ${beat.description.en}${runtimeBlock}${aiMovieBeatBoundaryBlock(beat)}`,
    config: {
      systemInstruction: AI_MOVIE_SCREENPLAY_BEAT_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      // A beat with a genuinely open-ended scene count (no maxItems cap —
      // some beats need well more than 4) needs more headroom than a
      // fixed-small-count beat would -- and on 2.5 Flash its "thinking"
      // counts against this same limit (see Write Dialogue). Only a ceiling.
      maxOutputTokens: 32768,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          // minItems only -- deliberately no maxItems. A hard ceiling was
          // tried and rejected: the scene count should be driven by what
          // the beat actually needs, not forced toward a target range. The
          // floor exists only to rule out the earlier real bug (beats
          // reliably coming back with just 1 scene).
          scenes: { type: Type.ARRAY, items: AI_MOVIE_SCREENPLAY_SCENE_SCHEMA, minItems: "2" },
        },
        required: ["scenes"],
      },
    },
  });
  const scenes = result.scenes.map((scene) => {
    const normalized = normalizeAiMovieSceneFormat(scene);
    return { ...normalized, estimatedMinutes: computeAiMovieSceneMinutes(normalized) };
  });
  // Repeats of earlier beats' scenes (or of each other), and scenes that
  // belong to a different beat, are dropped -- but a beat is never left with
  // nothing at all.
  const fresh = await keepAiMovieScenesInTheirBeat(beat, dropAiMovieRepeatedScenes(scenes, scenesSoFarText));
  return fresh.length > 0 ? fresh : scenes.slice(0, 1);
}

// The beat's own runtimeMinutes (set back at the Beat Sheet stage) is the
// film's real, designed pacing -- fixed, never adjusted down just because
// a first generation attempt came up short. If a beat's real (computed)
// total falls short of its target, the fix is to write MORE screenplay for
// it -- additional scenes, continuing directly on -- not to shrink the
// target to match. Only used once initial generation already came in
// short; asks for new scenes only, never touching what's already there.
const AI_MOVIE_SCREENPLAY_BEAT_EXPAND_SYSTEM_PROMPT = `You are working on an AI Movie — a film that will be entirely AI-generated, never physically shot. Because of that, never reason about budget, cast/crew/location availability, shoot schedules, or any real-world production constraint — anything that can be imagined can be included, with no limitation.

You are given the story's already-approved, locked layers, every screenplay scene already written in earlier beats, and this ONE beat's own scenes already written so far, given below as fixed, unchangeable context — do NOT repeat, summarize, or rewrite any of them. This beat's real runtime target has not been reached yet by what's there so far, so write ADDITIONAL new scenes only for this SAME beat, continuing directly from its last existing scene (same characters, same momentum, no repeats, never jumping ahead to a later beat), to cover roughly the additional screen time named at the end. Each new scene needs a scene heading and a vivid action/visual description. Do NOT write any dialogue — that is a separate, later pass. Give each new scene its own honest "estimatedMinutes."

${AI_MOVIE_FILL_TIME_HONESTLY_RULE}

${AI_MOVIE_SCREEN_ONLY_RULE}

${AI_MOVIE_HEADING_AND_NAMES_RULE}`;

async function generateAiMovieScreenplayBeatExpansion(
  priorContextText,
  referenceMaterialText,
  scenesSoFarText,
  beat,
  existingBeatScenesText,
  remainingMinutes
) {
  const referenceBlock = referenceMaterialText
    ? `\n\nThe user has also provided reference material below — treat it as authoritative grounding, stay faithful to it:\n\n${referenceMaterialText}`
    : "";
  const scenesBlock = scenesSoFarText ? `\n\nScreenplay scenes already written in earlier beats:\n\n${scenesSoFarText}` : "";

  const result = await generateJsonContent({
    model: AI_MOVIE_SCREENPLAY_WRITER_MODEL_NAME,
    contents: `The story's approved layers so far:\n\n${priorContextText}${referenceBlock}${scenesBlock}\n\nThis beat (${beat.title.en}: ${beat.description.en}) already has these scenes, fixed -- do not repeat them:\n\n${existingBeatScenesText}\n\nWrite additional new scenes only for this same beat, covering roughly ${remainingMinutes} more minutes of screen time — about ${remainingMinutes} standard screenplay pages (roughly ${Math.round(remainingMinutes * AI_MOVIE_LINES_PER_PAGE)} formatted lines), built from real on-screen moments (actions, reactions, events), never from extra descriptive words.${aiMovieBeatBoundaryBlock(beat)}`,
    config: {
      systemInstruction: AI_MOVIE_SCREENPLAY_BEAT_EXPAND_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 32768, // room for 2.5 Flash thinking, same as the first draft
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          scenes: { type: Type.ARRAY, items: AI_MOVIE_SCREENPLAY_SCENE_SCHEMA, minItems: "1" },
        },
        required: ["scenes"],
      },
    },
  });
  const scenes = result.scenes.map((scene) => {
    const normalized = normalizeAiMovieSceneFormat(scene);
    return { ...normalized, estimatedMinutes: computeAiMovieSceneMinutes(normalized) };
  });
  // A new scene that mostly repeats one already written (in this beat or an
  // earlier one) is padding, not screen time -- dropped. If nothing new is
  // left, the caller stops asking for more.
  return keepAiMovieScenesInTheirBeat(beat, dropAiMovieRepeatedScenes(scenes, `${scenesSoFarText ?? ""}\n\n${existingBeatScenesText}`), existingBeatScenesText);
}

// Closing a beat's shortfall against its fixed target doesn't always mean
// more description or more scenes -- sometimes the honest way to genuinely
// fill more screen time is dialogue between characters already in a scene.
// So before ever writing new scenes, this first tries adding real dialogue
// to existing scenes that don't have any yet (reusing the exact same
// dialogue writer "Write Dialogue" uses, so it's held to the same quality
// bar -- natural, colloquial, code-mixed, and free to genuinely decide a
// given scene doesn't need dialogue, same as always). Only once that's
// been tried does it fall back to writing more scenes. Both phases are
// bounded so a stubborn shortfall can never loop forever or burn unbounded
// Gemini calls, and "close enough" (90% of target) avoids an endless chase
// of the last few seconds.
// 3 rounds (was 2): once durations started being measured honestly (the
// page method), freshly written beats come in shorter against their fixed
// targets more often, so one extra round of new scenes is allowed.
const AI_MOVIE_BEAT_EXPAND_MAX_ROUNDS = 3;
const AI_MOVIE_BEAT_DIALOGUE_FILL_MAX_SCENES = 3;
const AI_MOVIE_BEAT_SHORTFALL_TOLERANCE = 0.9;

async function fillAiMovieScreenplayBeatToTarget(
  scenes,
  targetMinutes,
  priorContextText,
  referenceMaterialText,
  scenesSoFarText,
  beat,
  characterDialogueBriefsText
) {
  let currentScenes = scenes;
  if (typeof targetMinutes !== "number" || targetMinutes <= 0) return currentScenes;

  const isShort = () => currentScenes.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0) < targetMinutes * AI_MOVIE_BEAT_SHORTFALL_TOLERANCE;

  // Phase 1: dialogue on existing dialogue-less scenes.
  let dialogueAttempts = 0;
  for (let i = 0; i < currentScenes.length && dialogueAttempts < AI_MOVIE_BEAT_DIALOGUE_FILL_MAX_SCENES && isShort(); i++) {
    const scene = currentScenes[i];
    if (Array.isArray(scene.content) && scene.content.length > 0) continue;
    dialogueAttempts++;
    try {
      const beatSiblingScenesText = currentScenes
        .filter((_, j) => j !== i)
        .map((s) => sceneToPromptText(s))
        .join("\n\n");
      const { characters, content } = await generateAiMovieSceneDialogue(
        priorContextText,
        referenceMaterialText,
        scenesSoFarText,
        beatSiblingScenesText,
        beat,
        sceneToPromptText(scene),
        null,
        characterDialogueBriefsText
      );
      // Only counts as progress when the model actually added dialogue --
      // its honest "this scene doesn't need any" answer leaves the scene
      // untouched and moves on to the next candidate.
      if (Array.isArray(content) && content.some((block) => block.type === "dialogue")) {
        currentScenes = currentScenes.map((s, j) => {
          if (j !== i) return s;
          const updated = normalizeAiMovieSceneFormat({ ...s, content, characters });
          return { ...updated, estimatedMinutes: computeAiMovieSceneMinutes(updated) };
        });
      }
    } catch (error) {
      console.error("Beat dialogue-fill attempt failed, moving on:", error.message);
    }
  }

  // Phase 2: still short after trying dialogue -- write more scenes,
  // continuing directly on, never touching what's already there.
  for (let round = 0; round < AI_MOVIE_BEAT_EXPAND_MAX_ROUNDS && isShort(); round++) {
    const total = currentScenes.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0);
    const remaining = Math.round((targetMinutes - total) * 10) / 10;
    const existingBeatScenesText = currentScenes.map((s) => sceneToPromptText(s)).join("\n\n");
    try {
      const moreScenes = await generateAiMovieScreenplayBeatExpansion(
        priorContextText,
        referenceMaterialText,
        scenesSoFarText,
        beat,
        existingBeatScenesText,
        remaining
      );
      if (!moreScenes || moreScenes.length === 0) break;
      currentScenes = [...currentScenes, ...moreScenes];
    } catch (error) {
      console.error("Beat expansion round failed, keeping what's already written:", error.message);
      break;
    }
  }
  return currentScenes;
}

// Updates just the backfill JSON for one field, without touching
// stage_status -- used throughout screenplay generation so partial/in-
// progress work is visible and saved without the stage looking approved.
async function saveAiMovieBackfillField(projectId, stageKey, content) {
  const result = await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
  const backfill = { ...(result.rows[0]?.backfill ?? {}), [stageKey]: content };
  await db.query("UPDATE ai_movie_projects SET backfill = $1, updated_at = now() WHERE id = $2", [JSON.stringify(backfill), projectId]);
}

// Revising one scene never touches its siblings -- only the beat's OTHER
// scenes are given as fixed, unchangeable context, alongside every scene
// written in earlier beats. General-purpose: covers making it longer/
// shorter, a tone or content change, fixing a detail, or anything else --
// one box per scene rather than a separate button per kind of change. Allowed to
// return more than one scene: if the change genuinely earns a scene break
// (e.g. a location or time change mid-revision), splitting is fine, but it
// should stay one scene whenever the change doesn't call for that.
//
// Unlike normal screenplay generation, revise IS allowed to reach for
// dialogue -- lengthening a scene doesn't always mean more description or
// more scenes; sometimes the honest way to genuinely fill more screen time
// is dialogue between characters already there. Returns EITHER a plain
// action-only scene (the default) OR a full interleaved action/dialogue
// scene via "content" (same shape "Write Dialogue" produces), never both.
const AI_MOVIE_SCREENPLAY_SCENE_REVISE_RESULT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    sceneHeading: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    action: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    content: { type: Type.ARRAY, items: AI_MOVIE_SCENE_CONTENT_BLOCK_SCHEMA },
    estimatedMinutes: { type: Type.NUMBER },
  },
  required: ["sceneHeading", "estimatedMinutes"],
};

const AI_MOVIE_SCREENPLAY_SCENE_REVISE_SYSTEM_PROMPT = `You are working on an AI Movie — a film that will be entirely AI-generated, never physically shot. Because of that, never reason about budget, cast/crew/location availability, shoot schedules, or any real-world production constraint — anything that can be imagined can be included, with no limitation.

You are given the story's already-approved, locked layers below, every screenplay scene already written in earlier beats, and the current beat's own other scenes (fixed context — do not rewrite them). The user wants ONE specific scene, named at the end, revised — this could be almost anything: longer, shorter, a different tone, different content or focus, a fixed detail, or anything else the instruction below asks for. If the instruction asks for more screen time, making the story longer is always allowed and expected here — never resist it or try to stay close to any earlier length target. If no specific instruction is given, use your own judgment to genuinely improve the scene (richer ON-SCREEN detail, better pacing, a stronger beat) rather than leaving it unchanged. If the change naturally needs a scene break (a real change of location, time, or focus partway through), it is fine to return two or more scenes in its place instead of one — otherwise keep it as a single scene. Keep full continuity with the fixed scenes around it (same characters, same momentum) unless the instruction specifically asks to change that. Give each returned scene its own honest, updated "estimatedMinutes."

By default, still write plain action only in the "action" field, no dialogue — that's the normal case, same as before. BUT more screen time doesn't always mean more description or an extra scene: when the instruction is asking for a longer scene (or more detail, more weight) AND the scene already has characters genuinely interacting, dialogue between them is often the more honest way to actually fill that time — use it. When you do, return the scene via "content" instead of "action": an ORDERED list of action and dialogue blocks, interleaved exactly as they happen, in the SAME natural, colloquial, code-mixed style "Write Dialogue" uses elsewhere in this app — never formal or textbook language, and for Hindi, a real script switch for everyday English words (e.g. "payment कब होगा?", never a translation like "भुगतान कब होगा?" or a transliteration like "पेमेंट कब होगा?"). Leave "content" empty when you're not adding dialogue.

${AI_MOVIE_HINDI_SWITCH_LIMITS_RULE}

${AI_MOVIE_SCREEN_ONLY_RULE}

${AI_MOVIE_HEADING_AND_NAMES_RULE}

${AI_MOVIE_CONTENT_BLOCK_FORMAT_RULE}`;

async function generateAiMovieScreenplaySceneRevision(
  priorContextText,
  referenceMaterialText,
  scenesSoFarText,
  beatSiblingScenesText,
  beat,
  targetSceneText,
  instruction
) {
  const referenceBlock = referenceMaterialText
    ? `\n\nThe user has also provided reference material below — treat it as authoritative grounding, stay faithful to it:\n\n${referenceMaterialText}`
    : "";
  const scenesBlock = scenesSoFarText ? `\n\nScreenplay scenes already written in earlier beats:\n\n${scenesSoFarText}` : "";
  const siblingBlock = beatSiblingScenesText
    ? `\n\nThis scene's own beat (${beat.title.en}: ${beat.description.en}) also has these other scenes, unchanged, around it:\n\n${beatSiblingScenesText}`
    : "";
  const instructionBlock = instruction
    ? ` The user specifically asked for: ${instruction}`
    : " No specific instruction was given -- use your own judgment to genuinely improve the scene.";

  const result = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents: `The story's approved layers so far:\n\n${priorContextText}${referenceBlock}${scenesBlock}${siblingBlock}\n\nRevise this one scene:\n\n${targetSceneText}${instructionBlock}${aiMovieBeatBoundaryBlock(beat)}`,
    config: {
      systemInstruction: AI_MOVIE_SCREENPLAY_SCENE_REVISE_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      // Raised from 4096 for the same reason as Write Dialogue below: a
      // revise can now return dialogue-bearing content, sometimes across
      // more than one scene, in both languages.
      maxOutputTokens: 8192,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          scenes: { type: Type.ARRAY, items: AI_MOVIE_SCREENPLAY_SCENE_REVISE_RESULT_SCHEMA, minItems: "1" },
        },
        required: ["scenes"],
      },
    },
  });
  return result.scenes.map((scene) => {
    const hasContent = Array.isArray(scene.content) && scene.content.length > 0;
    const cleaned = hasContent
      ? { ...scene, sceneHeading: ensureAiMovieBilingualText(scene.sceneHeading), content: sanitizeAiMovieContentBlocks(scene.content) }
      : { ...scene, sceneHeading: ensureAiMovieBilingualText(scene.sceneHeading), action: ensureAiMovieBilingualText(scene.action), content: undefined };
    const normalized = normalizeAiMovieSceneFormat(cleaned);
    return { ...normalized, estimatedMinutes: computeAiMovieSceneMinutes(normalized) };
  });
}

// Writes dialogue for ONE scene, only once the user asks for it -- never
// forced into every scene just because the button exists. A pure action/
// visual scene is allowed to come back as a single unchanged action block;
// that's a real, honest answer here, not a failure to try. Unlike a plain
// bolt-on list, this re-splits the scene's own action text around the
// inserted lines so the result reads as one continuous interleaved
// screenplay, not two separate sections.
//
// This is the ONE place in AI Movie deliberately written to sound like real
// people actually talking rather than a correct, formal translation --
// e.g. Hindi speakers naturally keep everyday English words in English
// mid-sentence ("payment", "delivery") instead of translating them, and
// phrase things directly rather than the stiffer, textbook-correct way a
// literal translation would. This is scoped ONLY to this final dialogue
// pass (and the action text re-split alongside it) -- the Beat Sheet and
// the earlier dialogue-free Screenplay generation stage stay exactly as
// they were, still writing clean, neutral prose; this natural/colloquial
// treatment is deliberately NOT applied there.
//
// This is also the ONE place given a full cinematic-craft addendum (camera
// direction, held reactions, object symbolism, subtext, a decisive closing
// beat, and a character roster line) -- again deliberately scoped to only
// this final pass, at the user's own explicit direction, not the earlier
// dialogue-free Screenplay generation stage.
const AI_MOVIE_SCENE_DIALOGUE_SYSTEM_PROMPT = `You are working on an AI Movie — a film that will be entirely AI-generated, never physically shot. Because of that, never reason about budget, cast/crew/location availability, shoot schedules, or any real-world production constraint — anything that can be imagined can be included, with no limitation.

You are given the story's already-approved, locked layers below (including full Characters), every screenplay scene already written in earlier beats, and the current beat's own other scenes (fixed context — do not touch them, only the one scene named at the end). Break this ONE scene's existing action description into an ORDERED sequence of blocks — action and dialogue interleaved exactly as they naturally occur (a bit of action, then a line, more action, a reply, and so on) — matching how a real screenplay actually reads, never a block of action followed by a separate stack of dialogue. IF NO INSTRUCTION IS GIVEN BELOW, decide honestly whether this scene genuinely needs spoken dialogue at all: many purely visual, physical, or transitional scenes are complete with NO dialogue — if that's true here, return the scene as a single "action" block with the same events as the original, rather than inventing lines just to fill the space (still cleaned up to the screen-only rule at the end of these instructions). Preserve everything that actually HAPPENS in the scene — the real plot, who does what — never remove or invent new plot events. You may, however, enrich HOW it's shown (see the cinematic craft below): that's shaping the same events, not changing them.

IMPORTANT EXCEPTION: that freedom to decide "no dialogue needed" and hand the scene back unchanged applies ONLY when no instruction is given below. The instant an instruction IS given, it is a direct request from the user that you MUST fulfill — never fall back to "this scene doesn't need dialogue" or return the scene unchanged just because it's not what you'd have chosen on your own. Whatever the instruction asks for (a specific line, a topic to cover, narration, the narrator, more/different dialogue), make it actually appear in your output.

A NARRATOR is also always available for every scene, on top of whoever is in the Characters layer — it is NOT one of the story's characters, so never look for it there or hold back for lack of an established personality for it. Use it for narration/voiceover: setting up the past, present, or future, bridging elapsed time, or framing the emotional weight of a moment — whenever the scene's own action genuinely calls for that kind of voiceover, or (per the exception above, this is mandatory, not optional) whenever the instruction given below asks for the narrator or for backstory/context to be explained. Write its lines exactly like any other dialogue block, using the exact character name "NARRATOR". The NARRATOR is never someone inside the story: a voice on a broadcast, a screen, a call, or a loudspeaker belongs to that speaker — give them their own name (e.g. "COUNCIL BROADCASTER"), never "NARRATOR". The narrator's voice is fixed and consistent across every scene: very simple, direct, everyday language (never literary or ornate); empathetic, on the audience's side; spoken with a strong, confident conviction; and unafraid of a little blunt, hard-hitting phrasing when the moment earns it. With no instruction given, only use it when a voiceover genuinely belongs — most such scenes still need no narrator at all, exactly like most scenes need no dialogue.

This is the FINAL on-screen text the audience actually hears, so both the dialogue lines AND the action text in your output must sound like real, natural, everyday speech and prose — NEVER formal, textbook, or dictionary-correct language, in either English or Hindi. For the Hindi field specifically, this means a genuine SCRIPT SWITCH, not a translation and not a transliteration: for an everyday English word a real bilingual speaker would just say in English (payment, delivery, order, deal, phone, message, and so on), write that exact word in LATIN LETTERS, sitting inside the otherwise-Devanagari sentence — do NOT translate it into its formal Hindi equivalent, and do NOT spell it out phonetically in Devanagari either. Concretely, for "payment": "payment कब होगा?" is CORRECT; "भुगतान कब होगा?" is WRONG (that's a translation); "पेमेंट कब होगा?" is ALSO WRONG (that's a Devanagari transliteration, not English) — only actual Latin-script "payment" is right. Same logic for "delivery": "delivery होते ही" is correct, "डिलीवरी होते ही" is wrong. Do this naturally and often wherever the scene's own vocabulary calls for it — every scene with dialogue should have real Latin-script English words genuinely embedded mid-sentence like this, not zero — while the surrounding grammar, verbs, and connecting words stay in Devanagari Hindi. Beyond that script-mixing, also prefer direct, casual, specific phrasing over generic formal phrasing, and ground lines in the scene's own concrete details rather than vague generic dialogue. When dialogue is warranted, write it tight and naturalistic — never expository ("as you know…") or overwritten — consistent with each speaking character's established personality, wants, and voice from the Characters layer above (or, for the narrator, the fixed NARRATOR voice described above), and use each character's name exactly as it appears in that layer — except the narrator, whose name is always exactly "NARRATOR".

This pass also gives the scene its final cinematic shape, on top of the dialogue itself:
- Character roster: also return "characters" — one line naming every character present in this scene, plus a short note on any background presence (e.g. "RUDRA, OM, plus a dozen temple worshippers in the background"). Names only, no new plot detail.
- Camera direction: within the action blocks, reach for real screenplay camera-directive language where it earns its place — TIGHT CLOSE-UP ON, SLOW DOLLY IN ON, CAMERA HOLDS ON, FOCUS SHIFTS TO — guiding the reader's eye like an actual shot list, not just descriptive prose. Cuts (CUT TO:, SHARP CUT TO: and the like) are never inside action text: they are their own "transition" blocks (see the transitions rule below). These specific directive terms are conventionally English even in a Hindi script, exactly like the loanwords in the script-switching rule above — but that is NOT license to write the rest of the Hindi field in English: everything around those terms must still be genuine, natural Hindi.
- The held reaction: don't always cut to whoever's speaking or moving — sometimes the stronger choice is to hold on a silent face while everything else happens around or off-screen from them (a swallowed sob, a blank stare, a tightening jaw). Use it where the moment earns it, not in every scene.
- Object symbolism: let tension or stillness show up in a tangible nearby detail (drifting smoke, spilled water, fallen ash, torn cloth) as well as in a face.
- Subtext: let lines carry what a character is concealing, not only what they say outright — warm on the surface, colder underneath, when the story calls for it. Dead air (a character who deliberately doesn't answer) is a valid, often stronger choice than a line.
- The button: end the scene on a decisive beat — a loaded look, an unanswered question, or a FREEZE FRAME: / SHARP CUT TO: as the final "transition" block — never let it just trail off.

The "characters" field, and every "hi" field in every block above, still needs its own real, separately-written Hindi text — never the English copied over, left blank, or written in English. This matters even more now that there's more to juggle per scene: treat the Hindi field as just as important as the English one, for every single field, every time.

${AI_MOVIE_HINDI_SWITCH_LIMITS_RULE}

${AI_MOVIE_SCREEN_ONLY_RULE}

${AI_MOVIE_HEADING_AND_NAMES_RULE}

${AI_MOVIE_CONTENT_BLOCK_FORMAT_RULE}
NEVER bring pictures or events from this beat's other scenes into this one — they already have their own scenes and would play on screen twice. If narration (or dialogue) needs more screen time than this scene's own pictures give, let it play over this scene's own images for longer — a slower camera move, a held shot, a small extra detail of the same moment — never over the next scene's.
Also: this is the pass where speech gets written, so any speech the original action only DESCRIBES ("he asks for more information", "she pleads with him", "they argue") must become real dialogue lines in your output — never leave a spoken moment as a description, unless it is genuinely inaudible (background murmuring). And every character you list as present must visibly DO something in the scene (an action, a reaction, or a line) — otherwise leave them out of the list.`;

async function generateAiMovieSceneDialogue(
  priorContextText,
  referenceMaterialText,
  scenesSoFarText,
  beatSiblingScenesText,
  beat,
  targetSceneText,
  instruction,
  characterDialogueBriefsText
) {
  const referenceBlock = referenceMaterialText
    ? `\n\nThe user has also provided reference material below — treat it as authoritative grounding, stay faithful to it:\n\n${referenceMaterialText}`
    : "";
  const briefsBlock = characterDialogueBriefsText
    ? `\n\nCharacter dialogue voice briefs — inferred from the full story and beat progression, use these to keep each character's spoken voice distinct and authentic:\n\n${characterDialogueBriefsText}`
    : "";
  const scenesBlock = scenesSoFarText ? `\n\nScreenplay scenes already written in earlier beats:\n\n${scenesSoFarText}` : "";
  const siblingBlock = beatSiblingScenesText
    ? `\n\nThis scene's own beat (${beat.title.en}: ${beat.description.en}) also has these other scenes, fixed context only:\n\n${beatSiblingScenesText}`
    : "";
  const instructionBlock = instruction
    ? ` The user has explicitly asked for this — you MUST include it in your output, do not decide dialogue/narration is unnecessary here, and do not return the scene unchanged: ${instruction}`
    : "";
  const taskLine = instruction
    ? "Write the dialogue/narration the user explicitly asked for below, for this one scene:"
    : "Write dialogue (or decide none is needed) for this one scene:";

  const result = await generateJsonContent({
    model: AI_MOVIE_DIALOGUE_MODEL_NAME,
    contents: `The story's approved layers so far:\n\n${priorContextText}${referenceBlock}${briefsBlock}${scenesBlock}${siblingBlock}\n\n${taskLine}\n\n${targetSceneText}${instructionBlock}${aiMovieBeatBoundaryBlock(beat)}`,
    config: {
      systemInstruction: AI_MOVIE_SCENE_DIALOGUE_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      // Was 2048 -- too small once a scene carries interleaved dialogue,
      // camera direction, AND a full separate Hindi version of every block
      // (Devanagari costs noticeably more tokens than English). Raised again
      // for Gemini 2.5 Flash: it "thinks" before answering, and on this model
      // that thinking counts against this same limit -- this app's
      // @google/genai version (0.3.1) can't cap thinking separately, so the
      // ceiling itself leaves room for thinking plus the full scene. Only a
      // ceiling: a call costs what it actually uses.
      maxOutputTokens: 32768,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          characters: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
          content: { type: Type.ARRAY, items: AI_MOVIE_SCENE_CONTENT_BLOCK_SCHEMA, minItems: "1" },
        },
        required: ["characters", "content"],
      },
    },
  });
  const content = sanitizeAiMovieContentBlocks(result.content);
  // A real test run had this pass paste its neighbouring scenes into the
  // answer (Beat 2's third scene came back as scenes 1 + 2 + itself). And
  // when the user asked for a long narrator voice-over on Beat 1's first
  // scene, it pulled in scene 2's pictures to make room for it -- they'd
  // have played on screen twice. Refusing the whole answer threw away
  // good narration too (the user saw only an error), so now just the
  // copied parts are taken out and everything new is kept.
  const trimmed = removeAiMovieCopiedText(content, targetSceneText, `${scenesSoFarText ?? ""}\n\n${beatSiblingScenesText ?? ""}`);
  if (trimmed.length === 0) {
    throw new Error("The dialogue came back repeating other scenes instead of this one -- please try again.");
  }
  if (trimmed.length !== content.length || JSON.stringify(trimmed) !== JSON.stringify(content)) {
    console.log(`${beat?.beatNumber ? `Beat ${beat.beatNumber}: ` : ""}Write Dialogue -- took out text copied from other scenes, kept the rest.`);
  }
  return { characters: ensureAiMovieBilingualText(result.characters), content: trimmed };
}

// Takes out of a rewritten scene the action text that really belongs to
// OTHER scenes: an action paragraph is kept when less than 40% of its
// three-word runs come from the other scenes (and not from this scene's
// own original text). A mixed paragraph -- this scene's own lines plus
// copied ones -- keeps its own sentences, when the English and Hindi
// split into the same number of sentences so they can be matched up;
// otherwise the whole copied paragraph goes. Dialogue lines are always
// kept.
function removeAiMovieCopiedText(content, ownSceneText, otherScenesText) {
  const own = aiMovieWordTriples(ownSceneText);
  const others = aiMovieWordTriples(otherScenesText);
  const copiedShare = (text) => {
    const triples = aiMovieWordTriples(text);
    if (triples.size === 0) return 0;
    let copied = 0;
    for (const triple of triples) if (others.has(triple) && !own.has(triple)) copied++;
    return copied / triples.size;
  };
  const sentences = (text) => (text ?? "").split(/(?<=[.!?।])\s+/).filter((sentence) => sentence.trim());
  return content.flatMap((block) => {
    if (block.type !== "action" || copiedShare(block.text?.en) < AI_MOVIE_REPEAT_OVERLAP_LIMIT) return [block];
    const en = sentences(block.text.en);
    const hi = sentences(block.text.hi);
    if (en.length > 1 && en.length === hi.length) {
      const keep = en.map((sentence) => copiedShare(sentence) < AI_MOVIE_REPEAT_OVERLAP_LIMIT);
      if (keep.some(Boolean)) {
        return [{ ...block, text: { en: en.filter((_, i) => keep[i]).join(" "), hi: hi.filter((_, i) => keep[i]).join(" ") } }];
      }
    }
    return [];
  });
}

// A beat's "generating" status is only ever meant to be transient, within
// one continuous background fill loop -- but that loop runs detached from
// any HTTP request, so a server restart or redeploy while a beat is
// mid-flight (this app auto-deploys on every push to main) abandons it
// there permanently: no error, no way to notice, no way to retry, since
// the buffer-fill logic only ever looks for "not_started" beats and treats
// "generating" as already-spoken-for. Self-heals by treating any beat
// that's been sitting in "generating" longer than a real Gemini call
// (with retries) ever legitimately takes as abandoned, resetting it back
// to "not_started" so the normal fill logic picks it straight back up.
// Older data with no generatingSince at all predates this fix entirely and
// is always treated as abandoned, since a live one would already carry it.
const AI_MOVIE_STUCK_GENERATING_THRESHOLD_MS = 10 * 60 * 1000;

// Returns the (possibly-unchanged) beats array and whether anything was
// revived -- the caller uses the returned array directly rather than
// re-deriving which beats counted as stuck a second time.
async function reviveStuckAiMovieScreenplayBeats(projectId, screenplayBeats) {
  const now = Date.now();
  let anyRevived = false;
  const revived = screenplayBeats.map((beat) => {
    if (beat.status !== "generating") return beat;
    const startedAt = beat.generatingSince ? new Date(beat.generatingSince).getTime() : null;
    const isStuck = !startedAt || now - startedAt > AI_MOVIE_STUCK_GENERATING_THRESHOLD_MS;
    if (!isStuck) return beat;
    anyRevived = true;
    return { scenes: null, status: "not_started", feedback: null };
  });
  if (!anyRevived) return { beats: screenplayBeats, revived: false };
  await saveAiMovieBackfillField(projectId, "screenplayBeats", revived);
  return { beats: revived, revived: true };
}

// Builds the "scenes already written" context text out of every beat before
// the given index that has scenes yet (regardless of approval status --
// continuity only cares that a beat came before this one in the draft).
function flattenAiMovieScreenplayScenesSoFar(screenplayBeats, beforeIndex) {
  return screenplayBeats
    .slice(0, beforeIndex)
    .filter((b) => b.scenes)
    .flatMap((b) => b.scenes)
    .map((s) => sceneToPromptText(s))
    .join("\n\n");
}

// Writes exactly the next not-yet-started beat's scenes (if any), saving
// status transitions (not_started -> generating -> pending/error) as it
// goes so a project reload at any moment reflects real progress. Returns
// "generated", "no_more", or "error" -- fillAiMovieScreenplayBuffer below
// uses this to know whether to keep looping.
async function generateNextAiMovieScreenplayBeat(projectId) {
  const projectResult = await db.query("SELECT pasted_text, backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
  const project = projectResult.rows[0];
  if (!project) return "no_more";

  const beats = project.backfill?.plot ?? [];
  const screenplayBeats = project.backfill?.screenplayBeats ?? [];
  const nextIndex = screenplayBeats.findIndex((b) => b.status === "not_started");
  if (nextIndex === -1) return "no_more";

  screenplayBeats[nextIndex] = { ...screenplayBeats[nextIndex], status: "generating", generatingSince: new Date().toISOString() };
  await saveAiMovieBackfillField(projectId, "screenplayBeats", screenplayBeats);

  try {
    const referenceMaterialText = await getAiMovieReferenceMaterialText(projectId);
    const priorContextText = withAiMovieIntervalNote(
      flattenAiMovieContentForExtraction(project.pasted_text, project.backfill, { includeScreenplay: false }),
      project.backfill,
      nextIndex
    );
    const scenesSoFarText = flattenAiMovieScreenplayScenesSoFar(screenplayBeats, nextIndex);
    const initialScenes = await generateAiMovieScreenplayBeat(priorContextText, referenceMaterialText, scenesSoFarText, aiMovieBeatForWriters(beats, nextIndex), null);
    // A song beat is mostly the song, which is only a short paragraph on
    // the page -- measured by pages it always looks short, and a real test
    // run showed it then padded with the NEXT beats' plot (the Pahandi beat
    // wrote the breach and the Rakhyaka's fight). The song sheet sets the
    // song's real length and Extend counts it, so no padding here.
    const scenes = isAiMovieSongBeat(beats[nextIndex]) ? initialScenes : await fillAiMovieScreenplayBeatToTarget(
      initialScenes,
      beats[nextIndex].runtimeMinutes,
      priorContextText,
      referenceMaterialText,
      scenesSoFarText,
      aiMovieBeatForWriters(beats, nextIndex),
      aiMovieCharacterDialogueBriefsText(project.backfill)
    );

    const latest = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0].backfill;
    const latestBeats = latest.screenplayBeats ?? screenplayBeats;
    latestBeats[nextIndex] = { scenes, status: "pending", feedback: null };
    await saveAiMovieBackfillField(projectId, "screenplayBeats", latestBeats);
    return "generated";
  } catch (error) {
    console.error(`Screenplay beat ${nextIndex} generation failed:`, error.message);
    const latest = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0].backfill;
    const latestBeats = latest.screenplayBeats ?? screenplayBeats;
    latestBeats[nextIndex] = { ...latestBeats[nextIndex], status: "error", feedback: error.message };
    await saveAiMovieBackfillField(projectId, "screenplayBeats", latestBeats);
    return "error";
  }
}

// Keeps generating beats until the buffer (pending + generating beats,
// i.e. everything written but not yet approved) reaches the target size,
// or there's nothing left to generate, or a beat fails. Runs beats
// strictly one at a time (never in parallel), both for continuity and to
// keep Gemini call volume predictable.
async function fillAiMovieScreenplayBuffer(projectId) {
  for (;;) {
    const result = await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
    const screenplayBeats = result.rows[0]?.backfill?.screenplayBeats ?? [];
    const inFlight = screenplayBeats.filter((b) => b.status === "pending" || b.status === "generating").length;
    if (inFlight >= AI_MOVIE_SCREENPLAY_BUFFER_SIZE) return;
    const outcome = await generateNextAiMovieScreenplayBeat(projectId);
    if (outcome !== "generated") return;
  }
}

app.post("/api/ai-movie/stages/:stage/generate", requireRole("admin"), async (req, res) => {
  const stageKey = req.params.stage;
  const { projectId, feedback } = req.body;

  if (!AI_MOVIE_FORWARD_STAGE_SCHEMAS[stageKey]) {
    res.status(400).json({ error: "Not a valid stage to generate." });
    return;
  }
  if (!projectId) {
    res.status(400).json({ error: "No project to generate into." });
    return;
  }

  const projectResult = await db.query("SELECT pasted_text, backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
  const project = projectResult.rows[0];
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  if (stageKey === "screenplay") {
    const beats = project.backfill?.plot ?? [];
    if (beats.length === 0) {
      res.status(400).json({ error: "Generate the Beat Sheet first." });
      return;
    }
    // A fresh click always restarts the draft from beat one, rather than
    // trying to reconcile with a half-finished previous attempt.
    const screenplayBeats = beats.map(() => ({ scenes: null, status: "not_started", feedback: null }));
    await saveAiMovieBackfillField(projectId, "screenplayBeats", screenplayBeats);
    await db.query(
      "UPDATE ai_movie_projects SET stage_status = stage_status - 'screenplay', updated_at = now() WHERE id = $1",
      [projectId]
    );
    // Respond immediately and fill the buffer afterward -- no single
    // request holds open across what's really several sequential Gemini
    // calls. Progress is entirely readable from the project's own backfill
    // (backfill.screenplayBeats), so the client just polls the normal
    // project-detail endpoint rather than a separate status endpoint.
    res.json({ started: true });
    fillAiMovieScreenplayBuffer(projectId);
    return;
  }

  try {
    const referenceMaterialText = await getAiMovieReferenceMaterialText(projectId);
    const priorContextText = flattenAiMovieContentForExtraction(project.pasted_text, project.backfill);
    const content = await generateAiMovieForwardStage(stageKey, priorContextText, referenceMaterialText, feedback);

    const backfill = { ...(project.backfill ?? {}), [stageKey]: content };
    await db.query(
      "UPDATE ai_movie_projects SET backfill = $1, stage_status = stage_status || $2::jsonb, updated_at = now() WHERE id = $3",
      [JSON.stringify(backfill), JSON.stringify({ [stageKey]: { status: "pending", feedback: feedback ?? null } }), projectId]
    );

    res.json({ stageKey, content });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

// Approves one beat's scenes and, unless the whole screenplay is now done,
// tops the generation buffer back up by one -- fire-and-forget, same
// non-blocking pattern as the initial kickoff.
app.post("/api/ai-movie/stages/screenplay/beats/:index/approve", requireRole("admin"), async (req, res) => {
  const beatIndex = Number(req.params.index);
  const { projectId } = req.body;
  if (!projectId) {
    res.status(400).json({ error: "No project to approve into." });
    return;
  }

  const projectResult = await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
  const project = projectResult.rows[0];
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const screenplayBeats = project.backfill?.screenplayBeats ?? [];
  if (!Number.isInteger(beatIndex) || beatIndex < 0 || beatIndex >= screenplayBeats.length) {
    res.status(400).json({ error: "Not a valid beat." });
    return;
  }

  screenplayBeats[beatIndex] = { ...screenplayBeats[beatIndex], status: "approved" };
  await saveAiMovieBackfillField(projectId, "screenplayBeats", screenplayBeats);

  const allApproved = screenplayBeats.every((b) => b.status === "approved");
  if (allApproved) {
    await db.query(
      "UPDATE ai_movie_projects SET stage_status = stage_status || $1::jsonb, updated_at = now() WHERE id = $2",
      [JSON.stringify({ screenplay: { status: "approved", feedback: null } }), projectId]
    );

    // Same silent asset-list refresh every other stage's approval already
    // does on completion -- screenplay scenes are exactly where brand-new
    // props/characters/locations tend to show up first, so this stage
    // needs it as much as any other. Best-effort: approval itself must
    // still succeed even if this fails.
    try {
      const latest = (await db.query("SELECT pasted_text, backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0];
      const referenceMaterialText = await getAiMovieReferenceMaterialText(projectId);
      const assets = await generateAiMovieAssetExtraction(
        flattenAiMovieContentForExtraction(latest.pasted_text, latest.backfill),
        referenceMaterialText
      );
      await db.query("UPDATE ai_movie_projects SET assets = $1, updated_at = now() WHERE id = $2", [JSON.stringify(assets), projectId]);
    } catch (error) {
      console.error("Silent asset refresh failed after full screenplay approval (approval itself still succeeded):", error.message);
    }
  } else {
    fillAiMovieScreenplayBuffer(projectId);
  }

  res.json({ beatIndex, allApproved });
});

// Regenerates one beat's scenes -- with feedback (a real Request Changes)
// or without (a plain retry after that beat's status came back "error").
// Small enough (one beat, not 46) to stay a normal synchronous call.
app.post("/api/ai-movie/stages/screenplay/beats/:index/request-changes", requireRole("admin"), async (req, res) => {
  const beatIndex = Number(req.params.index);
  const { projectId, feedback } = req.body;
  if (!projectId) {
    res.status(400).json({ error: "No project to regenerate into." });
    return;
  }

  const projectResult = await db.query("SELECT pasted_text, backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
  const project = projectResult.rows[0];
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const beats = project.backfill?.plot ?? [];
  const screenplayBeats = project.backfill?.screenplayBeats ?? [];
  if (!Number.isInteger(beatIndex) || beatIndex < 0 || beatIndex >= beats.length) {
    res.status(400).json({ error: "Not a valid beat." });
    return;
  }

  try {
    const referenceMaterialText = await getAiMovieReferenceMaterialText(projectId);
    const priorContextText = withAiMovieIntervalNote(
      flattenAiMovieContentForExtraction(project.pasted_text, project.backfill, { includeScreenplay: false }),
      project.backfill,
      beatIndex
    );
    const scenesSoFarText = flattenAiMovieScreenplayScenesSoFar(screenplayBeats, beatIndex);
    const initialScenes = await generateAiMovieScreenplayBeat(priorContextText, referenceMaterialText, scenesSoFarText, aiMovieBeatForWriters(beats, beatIndex), feedback || null);
    // The beat's own runtimeMinutes target (set back at the Beat Sheet
    // stage) never gets adjusted down to match a short regeneration -- if
    // the new scenes come up short, more screenplay gets written for this
    // same beat until it actually reaches that fixed target.
    // No padding on a song beat -- same reason as first-draft generation.
    const scenes = isAiMovieSongBeat(beats[beatIndex]) ? initialScenes : await fillAiMovieScreenplayBeatToTarget(
      initialScenes,
      beats[beatIndex].runtimeMinutes,
      priorContextText,
      referenceMaterialText,
      scenesSoFarText,
      aiMovieBeatForWriters(beats, beatIndex),
      aiMovieCharacterDialogueBriefsText(project.backfill)
    );

    const latest = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0].backfill;
    const latestBeats = latest.screenplayBeats ?? screenplayBeats;
    // Keeps anything else on the beat (e.g. its song sheet) -- only the
    // scenes are being redone here.
    // Its old Script Doctor notes described scenes that no longer exist.
    latestBeats[beatIndex] = { ...latestBeats[beatIndex], scenes, status: "pending", feedback: feedback || null, doctorNotes: null };
    await saveAiMovieBackfillField(projectId, "screenplayBeats", latestBeats);

    res.json({ beatIndex, scenes, runtimeMinutes: Math.round(scenes.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0) * 10) / 10 });
  } catch (error) {
    console.error(`Screenplay beat ${beatIndex} regeneration failed:`, error.message);
    res.status(502).json({ error: error.message });
  }
});

// Song agent. Indian films carry songs as real story moments -- Akhada's
// own beat sheet marks three ("The Pahandi (Song)", "Granthaloka Welcome
// (Song)", "The Maha Guru's Secret (Song)"). A beat counts as a song beat
// when its title or description says "song". The sheet covers everything
// EXCEPT the lyrics -- the user's call: a real lyricist writes the words,
// so the agent only hands them a short brief. Picturization (how the song
// is filmed, section by section) follows the same screen-only rule as
// every scene writer.
function isAiMovieSongBeat(beatMeta) {
  return /\bsongs?\b/i.test(`${beatMeta?.title?.en ?? ""} ${beatMeta?.description?.en ?? ""}`);
}

const AI_MOVIE_SONG_SHEET_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    workingTitle: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    situation: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    storyPurpose: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    mood: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    musicStyle: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    singers: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    durationMinutes: { type: Type.NUMBER },
    lyricistBrief: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    picturization: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          section: { type: Type.STRING },
          visuals: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
        },
        required: ["section", "visuals"],
      },
    },
  },
  required: ["workingTitle", "situation", "storyPurpose", "mood", "musicStyle", "singers", "durationMinutes", "lyricistBrief", "picturization"],
};

const AI_MOVIE_SONG_SHEET_SYSTEM_PROMPT = `You are an Indian film song-situation writer and picturization planner, working on an AI Movie — a film that will be entirely AI-generated, never physically shot, so never limit anything by budget or real-world feasibility.

You are given the story's locked layers, the reference material, and one beat that carries a song, with its scenes. Write the SONG SHEET for it:
- "workingTitle": a short working title for the song.
- "situation": where the song sits in the story and why a song belongs exactly here.
- "storyPurpose": what has changed — in the story or in a character — by the time the song ends. A good film song moves the story or the feeling forward; it is never a pause.
- "mood": the feeling of the song, in a few words.
- "musicStyle": genre, tempo (slow / medium / fast, rough BPM) and the key instruments or sounds.
- "singers": who sings — on screen and/or playback (e.g. "chorus of pilgrims, a lead female voice").
- "durationMinutes": how long the song runs on screen (most film songs run 2.5 to 4 minutes).
- "lyricistBrief": a short brief for the human lyricist — the theme, key images, the emotion of each part, words or ideas that belong to this world (names, places, rituals). DO NOT WRITE ANY LYRICS: not a single line, not a refrain, not a hook, not a sample verse, in any language. A real lyricist writes every word.
- "picturization": how the song is filmed, section by section, in order — use section names like "Prelude", "Mukhda", "Interlude 1", "Antara 1", "Interlude 2", "Antara 2", "Final Mukhda", "Outro". For each, describe only what the camera sees: people, movement, places, light, camera moves, and the story moments that happen during that section. Picture ONLY this beat's own moments — never events from earlier or later beats (a real test run filled the prelude and first verse with earlier beats' opening shots and the next beat's power surge).
Write simple, easy English, and natural Hindi for every "hi" field.

${AI_MOVIE_SCREEN_ONLY_RULE}

${AI_MOVIE_HEADING_AND_NAMES_RULE}`;

// Backstop for the no-lyrics rule: a quoted passage of 4+ words inside the
// lyricist brief or the filming plan is almost certainly a sung line the
// model slipped in anyway. It's swapped for a visible note rather than
// silently deleted, so it's clear something was taken out.
function removeAiMovieQuotedLyrics(text) {
  return (text ?? "").replace(/["“]([^"“”]+)["”]/g, (whole, inner) =>
    inner.trim().split(/\s+/).length >= 4 ? "(lyric removed — for the lyricist)" : whole
  );
}

function removeAiMovieQuotedLyricsBilingual(value) {
  return { en: removeAiMovieQuotedLyrics(value.en), hi: removeAiMovieQuotedLyrics(value.hi) };
}

async function generateAiMovieSongSheet(priorContextText, referenceMaterialText, beat, beatScenesText) {
  const referenceBlock = referenceMaterialText
    ? `\n\nThe user has also provided reference material below — treat it as authoritative grounding, stay faithful to it:\n\n${referenceMaterialText}`
    : "";
  const result = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents: `The story's approved layers so far:\n\n${priorContextText}${referenceBlock}\n\nThe song beat: ${beat.title.en}: ${beat.description.en}\n\nIts scenes:\n\n${beatScenesText}\n\nNow write the song sheet for this beat. No lyrics.${aiMovieBeatBoundaryBlock(beat)}`,
    config: {
      systemInstruction: AI_MOVIE_SONG_SHEET_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      responseSchema: AI_MOVIE_SONG_SHEET_SCHEMA,
    },
  });
  const duration = Number(result.durationMinutes);
  return {
    workingTitle: ensureAiMovieBilingualText(result.workingTitle),
    situation: ensureAiMovieBilingualText(result.situation),
    storyPurpose: ensureAiMovieBilingualText(result.storyPurpose),
    mood: ensureAiMovieBilingualText(result.mood),
    musicStyle: ensureAiMovieBilingualText(result.musicStyle),
    singers: ensureAiMovieBilingualText(result.singers),
    // Kept to a real film-song range, so one odd number can't swallow a
    // beat's whole runtime.
    durationMinutes: Math.min(6, Math.max(1, Math.round((Number.isFinite(duration) ? duration : 3) * 10) / 10)),
    lyricistBrief: removeAiMovieQuotedLyricsBilingual(ensureAiMovieBilingualText(result.lyricistBrief)),
    picturization: (Array.isArray(result.picturization) ? result.picturization : [])
      .filter((part) => typeof part?.section === "string" && part.section.trim())
      .map((part) => ({ section: part.section.trim(), visuals: removeAiMovieQuotedLyricsBilingual(ensureAiMovieBilingualText(part.visuals)) })),
  };
}

// The song's own length counts toward its beat's total: on the page a song
// is only a short paragraph, so the page-method estimate badly
// under-measures a song beat, and Extend would otherwise pad it with
// scenes it doesn't need. The beat's target itself never changes.
function aiMovieBeatSongMinutes(screenplayBeat) {
  const minutes = screenplayBeat?.song?.durationMinutes;
  return typeof minutes === "number" && minutes > 0 ? minutes : 0;
}

app.post("/api/ai-movie/stages/screenplay/beats/:index/song", requireRole("admin"), async (req, res) => {
  const beatIndex = Number(req.params.index);
  const { projectId } = req.body;
  if (!projectId) {
    res.status(400).json({ error: "No project to write into." });
    return;
  }
  const projectResult = await db.query("SELECT pasted_text, backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
  const project = projectResult.rows[0];
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }
  const beats = project.backfill?.plot ?? [];
  const screenplayBeats = project.backfill?.screenplayBeats ?? [];
  const beat = screenplayBeats[beatIndex];
  if (!Number.isInteger(beatIndex) || !beats[beatIndex] || !beat || !Array.isArray(beat.scenes)) {
    res.status(400).json({ error: "This beat has no written scenes yet." });
    return;
  }
  if (!isAiMovieSongBeat(beats[beatIndex])) {
    res.status(400).json({ error: "This beat isn't marked as a song beat in the Beat Sheet." });
    return;
  }

  try {
    const referenceMaterialText = await getAiMovieReferenceMaterialText(projectId);
    const priorContextText = withAiMovieIntervalNote(
      flattenAiMovieContentForExtraction(project.pasted_text, project.backfill, { includeScreenplay: false }),
      project.backfill,
      beatIndex
    );
    const song = await generateAiMovieSongSheet(
      priorContextText,
      referenceMaterialText,
      aiMovieBeatForWriters(beats, beatIndex),
      beat.scenes.map((scene) => sceneToPromptText(scene)).join("\n\n")
    );
    // One atomic update of just this beat's song -- can't clobber scenes
    // saved at the same moment by background work.
    await db.query(
      "UPDATE ai_movie_projects SET backfill = jsonb_set(backfill, $2::text[], $3::jsonb), updated_at = now() WHERE id = $1",
      [projectId, ["screenplayBeats", String(beatIndex), "song"], JSON.stringify(song)]
    );
    res.json({ beatIndex, song });
  } catch (error) {
    console.error(`Song sheet for beat ${beatIndex} failed:`, error.message);
    res.status(502).json({ error: error.message });
  }
});

// Script Doctor: a per-beat review (the user's choice -- per beat, and
// nothing changes until they click). Lists only real problems, each tied
// to one scene (or the whole beat), with a fix phrased as a direct
// instruction a writer can carry out -- which the screen can send straight
// to that scene's Request Changes. Each note remembers the heading of the
// scene it was about, so the screen can refuse to apply it once that scene
// has changed.
const AI_MOVIE_DOCTOR_CATEGORIES = ["pacing", "story_logic", "continuity", "character", "setup_payoff", "world_rules", "emotion", "interval"];

const AI_MOVIE_DOCTOR_NOTE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    sceneNumber: { type: Type.NUMBER },
    category: { type: Type.STRING, enum: AI_MOVIE_DOCTOR_CATEGORIES },
    severity: { type: Type.STRING, enum: ["major", "minor"] },
    problem: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    fix: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
  },
  required: ["sceneNumber", "category", "severity", "problem", "fix"],
};

const AI_MOVIE_DOCTOR_SYSTEM_PROMPT = `You are a demanding but constructive script doctor with deep experience of both Hindi (Bollywood) and Hollywood films, working on an AI Movie — a film that will be entirely AI-generated, never physically shot, so never raise budget or feasibility concerns.

You are given the story's locked layers, the reference material (which includes the story's own world rules and guardrails), every scene written in earlier beats, and ONE beat's scenes to review, each with its scene card (purpose, emotion, intensity, emotional turn), plus the beat's fixed target time and its current real length. Find only REAL problems an audience would feel — never invent problems to fill a list. If the beat works, return few notes or none.

Check for:
- "pacing": a scene that doesn't earn its time, drags, or rushes a moment that needs room — judged against the beat's fixed target time. Each scene's real length is shown next to its number; whenever you talk about screen time, say it in seconds ("trim this to about 12 seconds"), never as decimal minutes.
- "story_logic": something that doesn't make sense given everything before it.
- "continuity": people, objects, injuries, clothes, time of day, or places that don't match earlier scenes.
- "character": someone acting or speaking unlike their established self at this point of their arc.
- "setup_payoff": something set up earlier that should pay off here but doesn't, or something introduced here that will clearly need a payoff later.
- "world_rules": breaking the story's own rules or lore, or the reference material's guardrails.
- "emotion": a scene with no emotional turn (its card shows the same value at start and end) where the story needs one, or an emotion that doesn't fit the moment.
- "interval": ONLY if this beat ends at the interval — whether its final scene truly cuts at a peak.

Check these FIRST — in a real test run they were the biggest problems and a review missed every one of them:
- Wrong beat (category "story_logic", severity "major"): a scene showing events that belong to a DIFFERENT beat — one already covered earlier, or the next beat or any later one (see this beat's boundaries in the story context). Fix: "Cut this scene — its events belong to Beat N."
- Repeats (category "pacing", severity "major"): a scene that repeats, or nearly repeats, another scene in this beat or an earlier one — same events, same wording. Fix: "Cut this scene — it repeats scene N."
- Empty speech (category "character", severity "major"): a character cue with no spoken words under it.
- A made-up cut-away (category "story_logic"): a scene about characters or a storyline this beat doesn't involve, added only to fill time.
SONG BEATS: the song itself fills most of the beat's time — its length is not a pacing problem, and never suggest cutting a song below what the beat's target time allows.
Only point at text that is really in the scene you name — never describe a line or detail that isn't there.

For each note:
- "sceneNumber": the scene's number WITHIN this beat (1 = its first scene); 0 if the note is about the whole beat.
- "category": one of the above; "severity": "major" if the audience would notice or it breaks something, "minor" for polish.
- "problem": what is wrong — specific, pointing at the exact moment.
- "fix": ONE concrete instruction a writer can carry out directly on that scene, written as an instruction (e.g. "Make Rudra hesitate before he pushes the slider, and let Omm see it"). Keep what already works; change only what fixes the problem.
At most 8 notes, most important first. Simple, easy English, and natural Hindi for every "hi" field.`;

async function generateAiMovieScriptDoctorNotes(priorContextText, referenceMaterialText, scenesSoFarText, beat, beatReviewText) {
  const referenceBlock = referenceMaterialText
    ? `\n\nReference material (authoritative — including the story's own rules and guardrails):\n\n${referenceMaterialText}`
    : "";
  const scenesBlock = scenesSoFarText ? `\n\nScenes already written in earlier beats:\n\n${scenesSoFarText}` : "";
  const result = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents: `The story's approved layers so far:\n\n${priorContextText}${referenceBlock}${scenesBlock}\n\nReview this beat — ${beat.title.en}: ${beat.description.en}\n\n${beatReviewText}${aiMovieBeatBoundaryBlock(beat)}`,
    config: {
      systemInstruction: AI_MOVIE_DOCTOR_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      responseSchema: {
        type: Type.OBJECT,
        properties: { notes: { type: Type.ARRAY, items: AI_MOVIE_DOCTOR_NOTE_SCHEMA } },
        required: ["notes"],
      },
    },
  });
  return Array.isArray(result.notes) ? result.notes : [];
}

app.post("/api/ai-movie/stages/screenplay/beats/:index/doctor", requireRole("admin"), async (req, res) => {
  const beatIndex = Number(req.params.index);
  const { projectId } = req.body;
  if (!projectId) {
    res.status(400).json({ error: "No project to review." });
    return;
  }
  const projectResult = await db.query("SELECT pasted_text, backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
  const project = projectResult.rows[0];
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }
  const beats = project.backfill?.plot ?? [];
  const screenplayBeats = project.backfill?.screenplayBeats ?? [];
  const beat = screenplayBeats[beatIndex];
  if (!Number.isInteger(beatIndex) || !beats[beatIndex] || !beat || !Array.isArray(beat.scenes) || beat.scenes.length === 0) {
    res.status(400).json({ error: "This beat has no written scenes to review yet." });
    return;
  }

  try {
    const referenceMaterialText = await getAiMovieReferenceMaterialText(projectId);
    const priorContextText = withAiMovieIntervalNote(
      flattenAiMovieContentForExtraction(project.pasted_text, project.backfill, { includeScreenplay: false }),
      project.backfill,
      beatIndex
    );
    const scenesSoFarText = flattenAiMovieScreenplayScenesSoFar(screenplayBeats, beatIndex);
    const totalMinutes =
      Math.round((beat.scenes.reduce((sum, scene) => sum + computeAiMovieSceneMinutes(scene), 0) + aiMovieBeatSongMinutes(beat)) * 10) / 10;
    const target = beats[beatIndex].runtimeMinutes;
    const beatReviewText = [
      `Fixed target time: ${typeof target === "number" ? formatAiMovieDuration(target) : "none"}. Current real length: ${formatAiMovieDuration(totalMinutes)}${beat.song ? ` (including a ${formatAiMovieDuration(beat.song.durationMinutes)} song)` : ""}.`,
      ...beat.scenes.map((scene, i) => {
        const card = scene.card
          ? ` [card: ${scene.card.purpose}, ${scene.card.emotion?.en} ${scene.card.intensity}/10, ${scene.card.turn?.en}]`
          : "";
        return `SCENE ${i + 1} (${formatAiMovieDuration(computeAiMovieSceneMinutes(scene))})${card}\n${sceneToPromptText(scene)}`;
      }),
    ].join("\n\n");

    const rawNotes = await generateAiMovieScriptDoctorNotes(priorContextText, referenceMaterialText, scenesSoFarText, aiMovieBeatForWriters(beats, beatIndex), beatReviewText);
    // Only notes that point at a real scene (or the whole beat) survive, and
    // each remembers the heading of its scene at review time.
    const notes = rawNotes
      .map((note) => {
        const sceneNumber = Math.round(Number(note.sceneNumber));
        if (!Number.isInteger(sceneNumber) || sceneNumber < 0 || sceneNumber > beat.scenes.length) return null;
        return {
          sceneNumber,
          sceneHeading: sceneNumber > 0 ? beat.scenes[sceneNumber - 1].sceneHeading?.en ?? "" : null,
          category: AI_MOVIE_DOCTOR_CATEGORIES.includes(note.category) ? note.category : "story_logic",
          severity: note.severity === "major" ? "major" : "minor",
          problem: ensureAiMovieBilingualText(note.problem),
          fix: ensureAiMovieBilingualText(note.fix),
          applied: false,
        };
      })
      .filter((note) => note && note.fix.en.trim())
      .slice(0, 8);
    const doctorNotes = { notes, reviewedAt: new Date().toISOString() };
    await db.query(
      "UPDATE ai_movie_projects SET backfill = jsonb_set(backfill, $2::text[], $3::jsonb), updated_at = now() WHERE id = $1",
      [projectId, ["screenplayBeats", String(beatIndex), "doctorNotes"], JSON.stringify(doctorNotes)]
    );
    res.json({ beatIndex, doctorNotes });
  } catch (error) {
    console.error(`Script Doctor for beat ${beatIndex} failed:`, error.message);
    res.status(502).json({ error: error.message });
  }
});

// Grows an already-written beat to its fixed Beat Sheet time WITHOUT
// throwing anything away -- every existing scene, and any dialogue already
// written for them, stays exactly as it is; only new material is added
// (dialogue in scenes that have none yet, then new scenes continuing the
// beat), using the same fill-to-target step new beats already get. Exists
// because the beat's target never moves (it's the film's designed pacing,
// per the user): once durations started being measured honestly, beats
// written earlier showed up short, and the only fix before this was a full
// Request Changes -- which regenerates the whole beat from scratch.
app.post("/api/ai-movie/stages/screenplay/beats/:index/extend-to-target", requireRole("admin"), async (req, res) => {
  const beatIndex = Number(req.params.index);
  const { projectId } = req.body;
  if (!projectId) {
    res.status(400).json({ error: "No project to extend." });
    return;
  }

  const projectResult = await db.query("SELECT pasted_text, backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
  const project = projectResult.rows[0];
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const beats = project.backfill?.plot ?? [];
  const screenplayBeats = project.backfill?.screenplayBeats ?? [];
  if (!Number.isInteger(beatIndex) || beatIndex < 0 || beatIndex >= beats.length) {
    res.status(400).json({ error: "Not a valid beat." });
    return;
  }
  const beat = screenplayBeats[beatIndex];
  if (!beat || (beat.status !== "pending" && beat.status !== "approved") || !Array.isArray(beat.scenes)) {
    res.status(400).json({ error: "This beat has no written scenes to extend yet." });
    return;
  }
  const targetMinutes = beats[beatIndex].runtimeMinutes;
  if (typeof targetMinutes !== "number" || targetMinutes <= 0) {
    res.status(400).json({ error: "This beat has no target time in the Beat Sheet." });
    return;
  }

  try {
    const referenceMaterialText = await getAiMovieReferenceMaterialText(projectId);
    const priorContextText = withAiMovieIntervalNote(
      flattenAiMovieContentForExtraction(project.pasted_text, project.backfill, { includeScreenplay: false }),
      project.backfill,
      beatIndex
    );
    const scenesSoFarText = flattenAiMovieScreenplayScenesSoFar(screenplayBeats, beatIndex);
    // Re-measure first: saved scenes may still carry durations from the
    // older words/200 count, which would make the beat look closer to its
    // target than it really is and stop the fill before it starts.
    const measuredScenes = beat.scenes.map((scene) => {
      const normalized = normalizeAiMovieSceneFormat(scene);
      return { ...normalized, estimatedMinutes: computeAiMovieSceneMinutes(normalized) };
    });
    const scenes = await fillAiMovieScreenplayBeatToTarget(
      measuredScenes,
      Math.max(0, targetMinutes - aiMovieBeatSongMinutes(beat)),
      priorContextText,
      referenceMaterialText,
      scenesSoFarText,
      aiMovieBeatForWriters(beats, beatIndex),
      aiMovieCharacterDialogueBriefsText(project.backfill)
    );

    // The fill step deliberately swallows individual failed AI calls (so
    // one bad call never loses the rest) -- which means a total failure
    // would otherwise come back looking like success with nothing added.
    // Say so plainly instead, and leave the beat exactly as it was.
    const sumMinutes = (list) => list.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0);
    if (sumMinutes(scenes) <= sumMinutes(measuredScenes)) {
      res.status(502).json({ error: "Nothing could be added to this beat this time — please try again." });
      return;
    }

    // Back to "pending": the beat genuinely has new material worth one
    // more look before it's final again.
    const latest = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0].backfill;
    const latestBeats = latest.screenplayBeats ?? screenplayBeats;
    latestBeats[beatIndex] = { ...latestBeats[beatIndex], scenes, status: "pending" };
    await saveAiMovieBackfillField(projectId, "screenplayBeats", latestBeats);

    const totalMinutes = Math.round((scenes.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0) + aiMovieBeatSongMinutes(beat)) * 10) / 10;
    res.json({ beatIndex, scenes, totalMinutes, targetMinutes });
  } catch (error) {
    console.error(`Screenplay beat ${beatIndex} extend-to-target failed:`, error.message);
    res.status(502).json({ error: error.message });
  }
});

// Revises ONE scene within an already-written beat -- general purpose (make
// it longer/shorter, change its tone or content, fix a detail, or anything
// else), even well after the beat itself was approved. Splices the result
// (usually one scene, occasionally more if the change earns a real scene
// break) back into that beat's scenes in place, leaving every other scene
// in the beat untouched, and puts the beat back to "pending" since its
// content has genuinely changed and deserves one more look before being
// final again. Also drops any dialogue already written for this scene --
// dialogue written for content that no longer exists would go stale
// silently, so the scene simply goes back to needing "Write Dialogue"
// again after a real content revision.
app.post("/api/ai-movie/stages/screenplay/beats/:beatIndex/scenes/:sceneIndex/revise", requireRole("admin"), async (req, res) => {
  const beatIndex = Number(req.params.beatIndex);
  const sceneIndex = Number(req.params.sceneIndex);
  const { projectId, instruction, doctorNoteIndex } = req.body;
  if (!projectId) {
    res.status(400).json({ error: "No project to revise into." });
    return;
  }

  const projectResult = await db.query("SELECT pasted_text, backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
  const project = projectResult.rows[0];
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const beats = project.backfill?.plot ?? [];
  const screenplayBeats = project.backfill?.screenplayBeats ?? [];
  if (!Number.isInteger(beatIndex) || beatIndex < 0 || beatIndex >= beats.length) {
    res.status(400).json({ error: "Not a valid beat." });
    return;
  }
  const beat = screenplayBeats[beatIndex];
  if (!beat || (beat.status !== "pending" && beat.status !== "approved") || !Array.isArray(beat.scenes)) {
    res.status(400).json({ error: "This beat has no written scenes to revise yet." });
    return;
  }
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= beat.scenes.length) {
    res.status(400).json({ error: "Not a valid scene." });
    return;
  }

  try {
    const referenceMaterialText = await getAiMovieReferenceMaterialText(projectId);
    const priorContextText = withAiMovieIntervalNote(
      flattenAiMovieContentForExtraction(project.pasted_text, project.backfill, { includeScreenplay: false }),
      project.backfill,
      beatIndex
    );
    const scenesSoFarText = flattenAiMovieScreenplayScenesSoFar(screenplayBeats, beatIndex);
    const beatSiblingScenesText = beat.scenes
      .filter((_, i) => i !== sceneIndex)
      .map((s) => sceneToPromptText(s))
      .join("\n\n");
    const targetScene = beat.scenes[sceneIndex];
    const targetSceneText = sceneToPromptText(targetScene);

    const replacementScenes = await generateAiMovieScreenplaySceneRevision(
      priorContextText,
      referenceMaterialText,
      scenesSoFarText,
      beatSiblingScenesText,
      aiMovieBeatForWriters(beats, beatIndex),
      targetSceneText,
      instruction || null
    );

    const latest = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0].backfill;
    const latestBeats = latest.screenplayBeats ?? screenplayBeats;
    const latestScenes = latestBeats[beatIndex]?.scenes ?? beat.scenes;
    const newScenes = [...latestScenes.slice(0, sceneIndex), ...replacementScenes, ...latestScenes.slice(sceneIndex + 1)];
    latestBeats[beatIndex] = { ...latestBeats[beatIndex], scenes: newScenes, status: "pending" };
    // A fix applied from the Script Doctor is marked done in the same save.
    const doctorNote = latestBeats[beatIndex].doctorNotes?.notes?.[doctorNoteIndex];
    if (Number.isInteger(doctorNoteIndex) && doctorNote) doctorNote.applied = true;
    await saveAiMovieBackfillField(projectId, "screenplayBeats", latestBeats);
    // The beat's own runtimeMinutes target is deliberately left alone here
    // -- it's the film's designed pacing from the Beat Sheet and stays
    // fixed, same as a full-beat Request Changes (user's explicit call). A
    // revised scene that pushes the beat over its target simply shows as
    // over target on screen, visible rather than silently rewritten.

    res.json({
      beatIndex,
      scenes: newScenes,
      runtimeMinutes: Math.round(newScenes.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0) * 10) / 10,
      doctorNotes: latestBeats[beatIndex].doctorNotes ?? null,
    });
  } catch (error) {
    console.error(`Screenplay beat ${beatIndex} scene ${sceneIndex} revision failed:`, error.message);
    res.status(502).json({ error: error.message });
  }
});

// Writes (or rewrites) dialogue for ONE scene -- only once its beat is
// approved, per the user's own spec: dialogue is a refinement made on
// already-finalized scenes, right there in place, not a separate pass done
// after the whole screenplay. Unlike a scene revision, this deliberately
// does NOT put the beat back to "pending" -- the scene's actual content
// (heading/action) isn't touched, only dialogue layered on top of it, so
// there's nothing there that needs a fresh review pass.
// Typing straight into the script (user request): the user edits one
// scene on the page, in the language they're reading, and submits it.
// This editor only CORRECTS -- spelling, grammar, punctuation, and
// language (anything typed in English, in romanized Hindi, or in another
// language like Odia inside the Hindi version becomes natural Hindi; the
// reverse for the English version) -- then writes the other language to
// match. It never rewrites the user's content. It also says what it fixed,
// so the user can see every change.
const AI_MOVIE_SCENE_EDIT_SYSTEM_PROMPT = `You are a careful script editor on a film screenplay. The writer has typed or edited ONE scene themselves, directly on the script page, in the language named below. Your job is to CORRECT it, never to rewrite it.

1. Fix spelling, grammar and punctuation.
2. Fix the language of the edited version:
   - If the edited version is HINDI: every Hindi field must be natural, everyday spoken Hindi in Devanagari. Anything the writer typed in full English sentences, in Hindi written with English letters (romanized Hindi, e.g. "aaj hum chalte hain"), or in another language (e.g. Odia) must be rewritten as natural Hindi with exactly the same meaning. Words people in India really say in English may stay in English, following the limits below — and such a word is written in ENGLISH LETTERS inside the Hindi sentence ("Samir अपना ship चला रहा है", "एक और delivery"), never spelled out in Devanagari ("शिप", "डिलीवरी"). NEVER replace a correct Hindi word with an English one — a real Hindi word ("चेतावनी", "स्पष्ट", "लाल", "ज़िले", "बिजली") always stays Hindi. The only English-for-Hindi change allowed is turning an English word that was spelled out in Devanagari ("कंसोल", "डिस्प्ले") into English letters ("console", "display").
   - If the edited version is ENGLISH: every English field must be simple, natural English. Anything typed in Hindi, Odia or any other language must be translated into English with the same meaning.
3. Keep EVERYTHING else the writer wrote: the same events, the same lines, the same order, the same characters, the same scene heading. Do not add new events or lines, do not remove any, and do not "improve" the style, the wording or the drama. If a sentence is already correct, leave it exactly as it is.
4. Keep the standard screenplay format: the scene heading is a standard English slugline in capitals; a character's name is in capital English letters; an acting note is 1 to 4 words. Keep every block as the kind of block it is (action stays action, dialogue stays dialogue).
5. Then write the OTHER language version of every block as a faithful translation of the corrected text (the Hindi version following the rules below), so both languages say the same thing.
6. "fixes": a short list, in simple English, of what you corrected (e.g. "Changed an English sentence in the second action line into Hindi", "Fixed the spelling of 'vibration'"). An empty list if nothing needed fixing.

${AI_MOVIE_HINDI_SWITCH_LIMITS_RULE}

${AI_MOVIE_HEADING_AND_NAMES_RULE}

${AI_MOVIE_CONTENT_BLOCK_FORMAT_RULE}`;

// The AI returns one correction per block, numbered -- and the scene is
// rebuilt here from the writer's OWN blocks (same lines, same order, same
// types, same characters), taking only the corrected wording from the AI.
// A real test run had the AI simply drop a dialogue line the writer had
// just added; built this way, no line can go missing. A block the AI
// skipped keeps the writer's own text.
const AI_MOVIE_SCENE_EDIT_CORRECTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    number: { type: Type.NUMBER },
    text: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    line: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    parenthetical: AI_MOVIE_BILINGUAL_TEXT_SCHEMA,
    character: { type: Type.STRING },
  },
  required: ["number"],
};

async function generateAiMovieSceneEditCorrection(language, sceneHeading, blocks, characterNames, beat) {
  const languageName = language === "hi" ? "HINDI" : "ENGLISH";
  const blocksText = blocks
    .map((block, i) => {
      if (block.type === "dialogue") {
        const note = block.parenthetical ? ` (acting note: ${block.parenthetical})` : "";
        return `${i + 1}. DIALOGUE — character: ${block.character}${note} — line: ${block.line}`;
      }
      if (block.type === "transition") return `${i + 1}. TRANSITION — ${block.transition}`;
      return `${i + 1}. ACTION — ${block.text}`;
    })
    .join("\n");
  const result = await generateJsonContent({
    model: AI_MOVIE_DIALOGUE_MODEL_NAME,
    contents: `The film's characters (spell their names exactly like this): ${characterNames.join(", ") || "(none listed)"}.\nThis scene belongs to the beat: ${beat.title.en}: ${beat.description.en}\n\nThe writer edited the ${languageName} version of this scene. Scene heading: ${sceneHeading}\n\nIts numbered blocks:\n${blocksText}\n\nReturn "blocks": exactly ONE entry for EVERY numbered block above — ${blocks.length} entries, same numbers, none skipped, none merged, none added. For an ACTION block fill "text"; for a DIALOGUE block fill "character" (capital English letters), "line", and "parenthetical" only if it had an acting note; for a TRANSITION block just the number. Every text field has both "en" and "hi".`,
    config: {
      systemInstruction: AI_MOVIE_SCENE_EDIT_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      // 2.5 Flash thinks before answering, and that counts against this
      // same ceiling -- same headroom as Write Dialogue.
      maxOutputTokens: 32768,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          sceneHeading: { type: Type.STRING },
          blocks: { type: Type.ARRAY, items: AI_MOVIE_SCENE_EDIT_CORRECTION_SCHEMA },
          fixes: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["sceneHeading", "blocks", "fixes"],
      },
    },
  });

  const corrections = new Map((Array.isArray(result.blocks) ? result.blocks : []).map((c) => [Math.round(Number(c?.number)), c]));
  // The writer's own text for the language they edited, the AI's for both
  // when it has one; never empty.
  const bilingual = (corrected, ownText) => {
    const own = ownText ?? "";
    const en = typeof corrected?.en === "string" && corrected.en.trim() ? corrected.en : language === "en" ? own : "";
    const hi = typeof corrected?.hi === "string" && corrected.hi.trim() ? corrected.hi : language === "hi" ? own : "";
    return { en: en || own, hi: hi || own };
  };
  let skipped = 0;
  const content = blocks.map((block, i) => {
    const correction = corrections.get(i + 1);
    if (!correction) skipped++;
    if (block.type === "dialogue") {
      const rebuilt = {
        type: "dialogue",
        character: (typeof correction?.character === "string" && correction.character.trim() ? correction.character : block.character).trim().toUpperCase(),
        line: bilingual(correction?.line ?? correction?.text, block.line),
      };
      if (block.parenthetical) rebuilt.parenthetical = bilingual(correction?.parenthetical, block.parenthetical);
      if (block.extension) rebuilt.extension = block.extension;
      return rebuilt;
    }
    if (block.type === "transition") return { type: "transition", transition: block.transition };
    return { type: "action", text: bilingual(correction?.text ?? correction?.line, block.text) };
  });
  if (skipped > 0) console.log(`Scene edit: the AI skipped ${skipped} of ${blocks.length} block(s); kept the writer's own text for them.`);
  return {
    sceneHeading: typeof result.sceneHeading === "string" && result.sceneHeading.trim() ? result.sceneHeading : sceneHeading,
    content: sanitizeAiMovieContentBlocks(content),
    fixes: Array.isArray(result.fixes) ? result.fixes.filter((fix) => typeof fix === "string" && fix.trim()) : [],
  };
}

// The edited blocks as the screen sends them: one language only, plain
// strings. Anything malformed is dropped; empty blocks too.
function cleanAiMovieEditedBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  return blocks
    .map((block) => {
      if (block?.type === "dialogue") {
        const cleaned = { type: "dialogue", character: text(block.character).toUpperCase(), line: text(block.line) };
        if (text(block.parenthetical)) cleaned.parenthetical = text(block.parenthetical).replace(/^\(\s*|\s*\)$/g, "");
        if (block.extension === "V.O." || block.extension === "O.S.") cleaned.extension = block.extension;
        return cleaned.character && cleaned.line ? cleaned : null;
      }
      if (block?.type === "transition") {
        const transition = text(block.transition).toUpperCase();
        return transition ? { type: "transition", transition } : null;
      }
      const actionText = text(block?.text);
      return actionText ? { type: "action", text: actionText } : null;
    })
    .filter(Boolean)
    .slice(0, 200);
}

app.post("/api/ai-movie/stages/screenplay/beats/:beatIndex/scenes/:sceneIndex/edit", requireRole("admin"), async (req, res) => {
  const beatIndex = Number(req.params.beatIndex);
  const sceneIndex = Number(req.params.sceneIndex);
  const { projectId, language, sceneHeading } = req.body;
  if (!projectId) {
    res.status(400).json({ error: "No project to save into." });
    return;
  }
  const blocks = cleanAiMovieEditedBlocks(req.body.blocks);
  if (blocks.length === 0) {
    res.status(400).json({ error: "The scene is empty -- write at least one line before submitting." });
    return;
  }

  const projectResult = await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
  const project = projectResult.rows[0];
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }
  const beats = project.backfill?.plot ?? [];
  const screenplayBeats = project.backfill?.screenplayBeats ?? [];
  const beat = screenplayBeats[beatIndex];
  if (!Number.isInteger(beatIndex) || !beats[beatIndex] || !beat || !Array.isArray(beat.scenes)) {
    res.status(400).json({ error: "Not a valid beat." });
    return;
  }
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= beat.scenes.length) {
    res.status(400).json({ error: "Not a valid scene." });
    return;
  }

  try {
    const characterNames = (project.backfill?.characterArc ?? []).map((c) => c?.name).filter(Boolean);
    const heading = typeof sceneHeading === "string" && sceneHeading.trim() ? sceneHeading.trim() : beat.scenes[sceneIndex].sceneHeading?.en ?? "";
    const corrected = await generateAiMovieSceneEditCorrection(language === "en" ? "en" : "hi", heading, blocks, characterNames, beats[beatIndex]);

    const latest = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0].backfill;
    const latestBeats = latest.screenplayBeats ?? screenplayBeats;
    const latestScenes = latestBeats[beatIndex]?.scenes ?? beat.scenes;
    const newScenes = latestScenes.map((s, i) => {
      if (i !== sceneIndex) return s;
      // The old action text, legacy dialogue list and scene card described
      // the scene before the edit -- the card is rewritten in the
      // background the next time the project opens.
      const { action: _action, dialogue: _dialogue, card: _card, ...rest } = s;
      const updated = normalizeAiMovieSceneFormat({
        ...rest,
        sceneHeading: { en: corrected.sceneHeading, hi: corrected.sceneHeading },
        content: corrected.content,
        editedByUser: true,
      });
      return { ...updated, estimatedMinutes: computeAiMovieSceneMinutes(updated) };
    });
    latestBeats[beatIndex] = { ...latestBeats[beatIndex], scenes: newScenes };
    await saveAiMovieBackfillField(projectId, "screenplayBeats", latestBeats);

    res.json({ beatIndex, sceneIndex, scene: newScenes[sceneIndex], fixes: corrected.fixes });
  } catch (error) {
    console.error(`Screenplay beat ${beatIndex} scene ${sceneIndex} edit failed:`, error.message);
    res.status(502).json({ error: error.message });
  }
});

// "Check full script" (the user's choice, alongside the per-scene Submit):
// once the screenplay is written, one button checks every written beat --
// one AI call per beat, in the background -- and corrects BOTH languages
// of every scene in place: natural Hindi in the Hindi version (English
// sentences, romanized Hindi or Odia become Hindi), simple correct English
// in the English version, spelling / grammar / punctuation everywhere.
// Content is never rewritten. Like the per-scene editor, the AI only
// returns corrected text for numbered pieces, and the scenes are updated
// in code piece by piece -- nothing can be dropped or added. Progress and
// the report live in backfill.scriptCheck, so the screen can show them.
const AI_MOVIE_SCRIPT_CHECK_SYSTEM_PROMPT = `You are a careful script editor doing a final language check on a finished film screenplay, one beat at a time. Every piece of text comes in two versions, English ("en") and Hindi ("hi"). CORRECT each version in place — never rewrite.

1. Fix spelling, grammar and punctuation in both versions.
2. Hindi version: must be natural, everyday spoken Hindi in Devanagari. Any part written in full English sentences, in Hindi written with English letters (romanized Hindi), or in another language (e.g. Odia) must become natural Hindi with exactly the same meaning. Words people in India really say in English may stay in English, following the limits below — written in ENGLISH LETTERS inside the Hindi sentence, never spelled out in Devanagari.
3. English version: must be simple, natural English. Any part in Hindi, Odia or another language must be translated into English.
   NEVER replace a correct Hindi word with an English one — a real Hindi word ("चेतावनी", "स्पष्ट", "लाल", "ज़िले", "बिजली") always stays Hindi. The only English-for-Hindi change allowed is turning an English word that was spelled out in Devanagari ("कंसोल", "डिस्प्ले") into English letters ("console", "display").
4. The two versions must say the same thing. If they clearly differ, correct the English to match the Hindi.
5. Keep everything else exactly as it is: the same events, lines, meaning, order and characters. Do not improve style, wording or drama. If a piece is already correct in both versions, leave it out of your answer.
6. "fixes": a short list per scene, in simple English, of what you corrected.

${AI_MOVIE_HINDI_SWITCH_LIMITS_RULE}

${AI_MOVIE_HEADING_AND_NAMES_RULE}`;

// Every correctable piece of text in a beat's scenes, with an id like
// "S2.3" (scene 2, piece 3) and a function that writes a correction back.
function aiMovieScriptCheckPieces(scenes) {
  const pieces = [];
  scenes.forEach((scene, sceneIndex) => {
    const add = (kind, label, get, set) => {
      const value = get();
      if (!value || (!value.en?.trim() && !value.hi?.trim())) return;
      pieces.push({ id: `S${sceneIndex + 1}.${pieces.filter((p) => p.sceneIndex === sceneIndex).length + 1}`, sceneIndex, kind, label, value, set });
    };
    if (Array.isArray(scene.content) && scene.content.length > 0) {
      scene.content.forEach((block, blockIndex) => {
        if (block.type === "dialogue") {
          add("line", `DIALOGUE line of ${block.character}`, () => block.line, (v) => (scene.content[blockIndex] = { ...scene.content[blockIndex], line: v }));
          if (block.parenthetical) {
            add("note", `acting note of ${block.character}`, () => block.parenthetical, (v) => (scene.content[blockIndex] = { ...scene.content[blockIndex], parenthetical: v }));
          }
        } else if (block.type === "action") {
          add("action", "ACTION", () => block.text, (v) => (scene.content[blockIndex] = { ...scene.content[blockIndex], text: v }));
        }
      });
    } else {
      add("action", "ACTION", () => scene.action, (v) => (scene.action = v));
      (scene.dialogue ?? []).forEach((line, lineIndex) => {
        add("line", `DIALOGUE line of ${line.character}`, () => line.line, (v) => (scene.dialogue[lineIndex] = { ...scene.dialogue[lineIndex], line: v }));
      });
    }
  });
  return pieces;
}

async function generateAiMovieScriptCheckCorrections(beatMeta, beatNumber, scenes, characterNames) {
  const pieces = aiMovieScriptCheckPieces(scenes);
  if (pieces.length === 0) return { pieces, corrections: new Map(), fixes: [] };
  const text = scenes
    .map((scene, sceneIndex) => {
      const own = pieces.filter((p) => p.sceneIndex === sceneIndex);
      return `SCENE ${sceneIndex + 1} — ${scene.sceneHeading?.en ?? ""}\n${own.map((p) => `[${p.id}] ${p.label}\n  en: ${p.value.en}\n  hi: ${p.value.hi}`).join("\n")}`;
    })
    .join("\n\n");
  const result = await generateJsonContent({
    model: AI_MOVIE_DIALOGUE_MODEL_NAME,
    contents: `The film's characters (spell their names exactly like this): ${characterNames.join(", ") || "(none listed)"}.\n\nBeat ${beatNumber} — ${beatMeta.title.en}: ${beatMeta.description.en}\n\n${text}\n\nReturn "corrections": one entry for each piece that needed a correction, with its exact id and BOTH corrected versions ("en" and "hi"). Leave out pieces that are already correct.`,
    config: {
      systemInstruction: AI_MOVIE_SCRIPT_CHECK_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 32768,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          corrections: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { id: { type: Type.STRING }, en: { type: Type.STRING }, hi: { type: Type.STRING } },
              required: ["id", "en", "hi"],
            },
          },
          fixes: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { scene: { type: Type.NUMBER }, fix: { type: Type.STRING } },
              required: ["scene", "fix"],
            },
          },
        },
        required: ["corrections", "fixes"],
      },
    },
  });
  const corrections = new Map(
    (Array.isArray(result.corrections) ? result.corrections : [])
      .filter((c) => typeof c?.id === "string" && typeof c.en === "string" && typeof c.hi === "string" && c.en.trim() && c.hi.trim())
      .map((c) => [c.id.trim(), { en: c.en, hi: c.hi }])
  );
  const fixes = (Array.isArray(result.fixes) ? result.fixes : []).filter((f) => typeof f?.fix === "string" && f.fix.trim());
  return { pieces, corrections, fixes };
}

// Only one check runs per project at a time in this server process.
const aiMovieScriptChecksRunning = new Set();

async function saveAiMovieScriptCheckState(projectId, state) {
  await db.query("UPDATE ai_movie_projects SET backfill = jsonb_set(backfill, '{scriptCheck}', $1::jsonb) WHERE id = $2", [JSON.stringify(state), projectId]);
}

async function runAiMovieScriptCheck(projectId, state) {
  aiMovieScriptChecksRunning.add(projectId);
  try {
    for (;;) {
      const project = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0];
      if (!project) return;
      const beats = project.backfill?.plot ?? [];
      const screenplayBeats = project.backfill?.screenplayBeats ?? [];
      const beatIndex = state.beatIndexes[state.done];
      if (beatIndex === undefined) break;
      const scenes = (screenplayBeats[beatIndex]?.scenes ?? []).map((scene) => JSON.parse(JSON.stringify(scene)));
      const characterNames = (project.backfill?.characterArc ?? []).map((c) => c?.name).filter(Boolean);
      try {
        const { pieces, corrections, fixes } = await generateAiMovieScriptCheckCorrections(beats[beatIndex], beatIndex + 1, scenes, characterNames);
        let changed = 0;
        for (const piece of pieces) {
          const correction = corrections.get(piece.id);
          if (!correction) continue;
          if (correction.en === piece.value.en && correction.hi === piece.value.hi) continue;
          piece.set(correction);
          changed++;
        }
        if (changed > 0) {
          const updatedScenes = scenes.map((scene) => ({ ...scene, estimatedMinutes: computeAiMovieSceneMinutes(normalizeAiMovieSceneFormat(scene)) }));
          // Written into just this beat's scenes, so work saved elsewhere
          // in the project meanwhile isn't overwritten.
          await db.query(
            "UPDATE ai_movie_projects SET backfill = jsonb_set(backfill, ARRAY['screenplayBeats', $1::text, 'scenes'], $2::jsonb), updated_at = now() WHERE id = $3",
            [String(beatIndex), JSON.stringify(updatedScenes), projectId]
          );
        }
        state.report.push({ beat: beatIndex + 1, changed, fixes: fixes.map((f) => ({ scene: Math.round(Number(f.scene)) || null, fix: f.fix })) });
      } catch (error) {
        console.error(`Full script check: beat ${beatIndex + 1} failed:`, error.message);
        state.report.push({ beat: beatIndex + 1, changed: 0, fixes: [], error: error.message });
      }
      state.done += 1;
      state.updatedAt = new Date().toISOString();
      await saveAiMovieScriptCheckState(projectId, state);
    }
    state.status = "done";
    state.finishedAt = new Date().toISOString();
    await saveAiMovieScriptCheckState(projectId, state);
  } catch (error) {
    console.error("Full script check stopped:", error.message);
    state.status = "error";
    state.error = error.message;
    await saveAiMovieScriptCheckState(projectId, state).catch(() => {});
  } finally {
    aiMovieScriptChecksRunning.delete(projectId);
  }
}

app.post("/api/ai-movie/projects/:id/script-check", requireRole("admin"), async (req, res) => {
  const projectId = Number(req.params.id);
  const project = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0];
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }
  if (aiMovieScriptChecksRunning.has(projectId)) {
    res.json({ started: false, alreadyRunning: true });
    return;
  }
  const previous = project.backfill?.scriptCheck;
  // A check cut off by a server restart picks up where it stopped.
  if (previous?.status === "running" && Array.isArray(previous.beatIndexes) && previous.done < previous.beatIndexes.length) {
    runAiMovieScriptCheck(projectId, previous);
    res.json({ started: true, resumed: true });
    return;
  }
  const beatIndexes = (project.backfill?.screenplayBeats ?? [])
    .map((beat, index) => (Array.isArray(beat?.scenes) && beat.scenes.length > 0 ? index : null))
    .filter((index) => index !== null);
  if (beatIndexes.length === 0) {
    res.status(400).json({ error: "No beats are written yet -- there's nothing to check." });
    return;
  }
  const state = { status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), beatIndexes, done: 0, report: [] };
  await saveAiMovieScriptCheckState(projectId, state);
  runAiMovieScriptCheck(projectId, state);
  res.json({ started: true });
});

// Beat-wide narration (user request): one NARRATOR voice-over that flows
// across 3, 4, 5 consecutive scenes, described once for the whole beat.
// The screen sends the beat's scenes one at a time, in order, through the
// normal Write Dialogue call, each carrying the same brief -- so every
// scene is written after the one before it is saved, and sees that
// scene's narration as context to continue from.
function aiMovieNarrationInstruction(narrationBrief, sceneIndex, sceneCount) {
  if (typeof narrationBrief !== "string" || !narrationBrief.trim()) return null;
  const number = sceneIndex + 1;
  const ending =
    number >= sceneCount
      ? "This is the beat's last scene: bring the narration to a clean close here."
      : "Leave the rest of the narration for the scenes after this one.";
  return `ONE CONTINUOUS NARRATION ACROSS THIS BEAT: the user wants a single NARRATOR voice-over that flows across this beat's scenes, in order. This is scene ${number} of ${sceneCount}. The user's brief for the whole narration: "${narrationBrief.trim()}". Write ONLY the part of it that plays over THIS scene: pick up exactly where the narration in the earlier scenes of this beat (shown above) left off, never repeat a line already said, and move it one step further. ${ending} Keep any dialogue this scene already has, word for word.`;
}

app.post("/api/ai-movie/stages/screenplay/beats/:beatIndex/scenes/:sceneIndex/dialogue", requireRole("admin"), async (req, res) => {
  const beatIndex = Number(req.params.beatIndex);
  const sceneIndex = Number(req.params.sceneIndex);
  const { projectId, instruction, narrationBrief } = req.body;
  if (!projectId) {
    res.status(400).json({ error: "No project to write dialogue into." });
    return;
  }

  const projectResult = await db.query("SELECT pasted_text, backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
  const project = projectResult.rows[0];
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const beats = project.backfill?.plot ?? [];
  const screenplayBeats = project.backfill?.screenplayBeats ?? [];
  if (!Number.isInteger(beatIndex) || beatIndex < 0 || beatIndex >= beats.length) {
    res.status(400).json({ error: "Not a valid beat." });
    return;
  }
  const beat = screenplayBeats[beatIndex];
  if (!beat || beat.status !== "approved" || !Array.isArray(beat.scenes)) {
    res.status(400).json({ error: "Approve this beat first before writing dialogue for its scenes." });
    return;
  }
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= beat.scenes.length) {
    res.status(400).json({ error: "Not a valid scene." });
    return;
  }

  try {
    const referenceMaterialText = await getAiMovieReferenceMaterialText(projectId);
    const priorContextText = withAiMovieIntervalNote(
      flattenAiMovieContentForExtraction(project.pasted_text, project.backfill, { includeScreenplay: false }),
      project.backfill,
      beatIndex
    );
    const scenesSoFarText = flattenAiMovieScreenplayScenesSoFar(screenplayBeats, beatIndex);
    const beatSiblingScenesText = beat.scenes
      .filter((_, i) => i !== sceneIndex)
      .map((s) => sceneToPromptText(s))
      .join("\n\n");
    const targetScene = beat.scenes[sceneIndex];
    const targetSceneText = sceneToPromptText(targetScene);
    const characterDialogueBriefsText = aiMovieCharacterDialogueBriefsText(project.backfill);

    const { characters, content } = await generateAiMovieSceneDialogue(
      priorContextText,
      referenceMaterialText,
      scenesSoFarText,
      beatSiblingScenesText,
      aiMovieBeatForWriters(beats, beatIndex),
      targetSceneText,
      aiMovieNarrationInstruction(narrationBrief, sceneIndex, beat.scenes.length) || instruction || null,
      characterDialogueBriefsText
    );

    const latest = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId])).rows[0].backfill;
    const latestBeats = latest.screenplayBeats ?? screenplayBeats;
    const latestScenes = latestBeats[beatIndex]?.scenes ?? beat.scenes;
    // Drops any older flat "dialogue" list this scene might still carry --
    // "content" is now the one authoritative shape once dialogue exists.
    const newScenes = latestScenes.map((s, i) => {
      if (i !== sceneIndex) return s;
      const { dialogue: _legacyDialogue, ...rest } = s;
      const updated = normalizeAiMovieSceneFormat({ ...rest, content, characters });
      return { ...updated, estimatedMinutes: computeAiMovieSceneMinutes(updated) };
    });
    latestBeats[beatIndex] = { ...latestBeats[beatIndex], scenes: newScenes };
    await saveAiMovieBackfillField(projectId, "screenplayBeats", latestBeats);

    res.json({ beatIndex, sceneIndex, content, characters, estimatedMinutes: newScenes[sceneIndex].estimatedMinutes });
  } catch (error) {
    console.error(`Screenplay beat ${beatIndex} scene ${sceneIndex} dialogue failed:`, error.message);
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/ai-movie/stages/:stage/approve", requireRole("admin"), async (req, res) => {
  const stageKey = req.params.stage;
  const { projectId } = req.body;

  if (!AI_MOVIE_STAGE_ORDER.includes(stageKey)) {
    res.status(400).json({ error: "Not a valid stage." });
    return;
  }
  if (!projectId) {
    res.status(400).json({ error: "No project to approve." });
    return;
  }

  await db.query(
    "UPDATE ai_movie_projects SET stage_status = stage_status || $1::jsonb, updated_at = now() WHERE id = $2",
    [JSON.stringify({ [stageKey]: { status: "approved", feedback: null } }), projectId]
  );

  const projectResult = await db.query("SELECT pasted_text, backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
  const project = projectResult.rows[0];
  const referenceMaterialText = await getAiMovieReferenceMaterialText(projectId);

  // Refresh the silent asset list with whatever's newly locked in — best
  // effort: approval itself must still succeed even if this call fails.
  let assets = null;
  try {
    assets = await generateAiMovieAssetExtraction(
      flattenAiMovieContentForExtraction(project.pasted_text, project.backfill),
      referenceMaterialText
    );
    await db.query("UPDATE ai_movie_projects SET assets = $1, updated_at = now() WHERE id = $2", [JSON.stringify(assets), projectId]);
  } catch (error) {
    console.error("Silent asset refresh failed after approval (approval itself still succeeded):", error.message);
  }

  // Same silent, no-approval-screen treatment, independent of the asset
  // refresh above -- run only once the Beat Sheet is approved, the earliest
  // point the full cast AND the whole beat-by-beat progression both exist,
  // which is exactly what this brief needs. Re-approving a regenerated Beat
  // Sheet later naturally refreshes it again through this same code path.
  if (stageKey === "plot") {
    try {
      const briefs = await generateAiMovieCharacterDialogueBriefs(
        flattenAiMovieContentForExtraction(project.pasted_text, project.backfill),
        referenceMaterialText
      );
      await saveAiMovieBackfillField(projectId, "characterDialogueBriefs", briefs);
    } catch (error) {
      console.error("Silent character dialogue brief generation failed after Beat Sheet approval (approval itself still succeeded):", error.message);
    }
  }

  res.json({ ok: true, assets });
});

app.get("/api/ai-movie/projects", requireRole("admin"), async (req, res) => {
  const result = await db.query(
    "SELECT id, title, pasted_text, detected_stage, updated_at FROM ai_movie_projects ORDER BY updated_at DESC"
  );
  res.json(result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    pastedText: row.pasted_text,
    detectedStage: row.detected_stage,
    updatedAt: row.updated_at,
  })));
});

app.get("/api/ai-movie/projects/:id", requireRole("admin"), async (req, res) => {
  const result = await db.query("SELECT * FROM ai_movie_projects WHERE id = $1", [req.params.id]);
  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  // Self-heal any beat abandoned mid-generation by a server restart before
  // the response reflects it, so simply opening the project is enough to
  // get a permanently-stuck beat moving again -- no separate "unstick"
  // button needed.
  if (Array.isArray(row.backfill?.screenplayBeats)) {
    const { beats, revived } = await reviveStuckAiMovieScreenplayBeats(row.id, row.backfill.screenplayBeats);
    if (revived) {
      row.backfill = { ...row.backfill, screenplayBeats: beats };
      fillAiMovieScreenplayBuffer(row.id);
    }
  }

  // Same idea: a project whose Beat Sheet was already approved before the
  // character dialogue brief existed never got one and never will through
  // the normal trigger -- backfill it quietly in the background, no redo
  // of anything already done.
  backfillAiMovieCharacterDialogueBriefsIfMissing(row.id, row.pasted_text, row.backfill);
  fillAiMovieSceneCardsIfMissing(row.id, row.backfill);

  // Every scene's heading is normalized (English slugline in both
  // languages, never repeated inside the action) and its duration is
  // recomputed on the way out with the current
  // page-method estimate -- scenes saved under the older words/200 count
  // would otherwise sit next to new ones measured differently, making each
  // beat's "Estimated total" a mix of two rulers. Pure arithmetic on the
  // scene's own text (no AI call), and nothing stored is changed.
  if (Array.isArray(row.backfill?.screenplayBeats)) {
    row.backfill = {
      ...row.backfill,
      screenplayBeats: row.backfill.screenplayBeats.map((beat) =>
        Array.isArray(beat.scenes)
          ? {
              ...beat,
              scenes: beat.scenes.map((scene) => {
                const normalized = normalizeAiMovieSceneFormat(scene);
                return { ...normalized, estimatedMinutes: computeAiMovieSceneMinutes(normalized) };
              }),
            }
          : beat
      ),
    };
  }

  res.json({
    id: row.id,
    title: row.title,
    pastedText: row.pasted_text,
    detectedStage: row.detected_stage,
    backfill: row.backfill,
    assets: row.assets,
    // A project saved before the step-by-step review chain existed has no
    // stage_status at all — treat everything already present in its
    // backfill as approved, same as this pipeline always treated it,
    // rather than suddenly asking for a review pass on old work.
    stageStatus:
      row.stage_status && Object.keys(row.stage_status).length > 0
        ? row.stage_status
        : Object.fromEntries(Object.keys(row.backfill ?? {}).map((key) => [key, { status: "approved", feedback: null }])),
  });
});

// Places (or, with afterBeat: null, removes) the INTERVAL. One interval
// per film, so placing it again simply moves it. Saved with one atomic
// update so it can never clobber screenplay work being saved at the same
// moment in the background.
app.post("/api/ai-movie/projects/:id/interval", requireRole("admin"), async (req, res) => {
  const { afterBeat } = req.body;
  const result = await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [req.params.id]);
  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: "Project not found." });
    return;
  }
  const beatCount = row.backfill?.plot?.length ?? 0;
  if (afterBeat !== null && (!Number.isInteger(afterBeat) || afterBeat < 0 || afterBeat >= beatCount - 1)) {
    res.status(400).json({ error: "The interval has to go after a beat that has another beat following it." });
    return;
  }
  await db.query("UPDATE ai_movie_projects SET backfill = jsonb_set(backfill, '{intervalAfterBeat}', $2::jsonb), updated_at = now() WHERE id = $1", [
    req.params.id,
    JSON.stringify(afterBeat),
  ]);
  res.json({ intervalAfterBeat: afterBeat });
});

// Industry-format screenplay PDF for an AI Movie -- the standard US
// screenplay page, so "one page = one minute" actually holds for what gets
// printed: Letter size, Courier 12 (10 characters per inch, ~55 lines per
// page), 1.5" left / 1" right / 1" top and bottom margins, scene heading
// in capitals with the scene number in both margins, character name at
// 3.7" from the page edge, parenthetical at 3.1", dialogue in the 2.5"-6"
// column, transitions right-aligned, a title page, and page numbers top
// right. Same measurements the page-method duration estimate assumes.
//
// ?lang=hi prints the Hindi text in the Hindi font (which also carries
// Latin letters, so embedded English words print correctly), while scene
// headings, character names, extensions and transitions stay in English
// Courier -- the same convention the screen uses. Every written scene is
// included in order, approved or not: this is a working draft.
const AI_MOVIE_PDF = {
  pageLeft: 108,
  pageRight: 540,
  top: 72,
  bottom: 72,
  characterX: 266,
  parentheticalX: 223,
  parentheticalWidth: 158,
  dialogueX: 180,
  dialogueWidth: 252,
  fontSize: 12,
  // Courier's own metrics give ~9.4pt lines at 12pt; screenplays run at
  // 6 lines per inch (12pt), so this gap makes up the difference.
  courierLineGap: 2.6,
};

function aiMovieCueWithContd(blocks, blockIndex) {
  const block = blocks[blockIndex];
  let cue = (block.character ?? "").toUpperCase();
  if (block.extension) cue += ` (${block.extension})`;
  let sawActionBetween = false;
  for (let i = blockIndex - 1; i >= 0; i--) {
    if (blocks[i].type !== "dialogue") {
      sawActionBetween = true;
      continue;
    }
    if (blocks[i].character === block.character && sawActionBetween) cue += " (CONT'D)";
    break;
  }
  return cue;
}

// PDF's built-in Courier only carries the basic Western character set, so
// anything else prints as junk (the Scenic Breakdown's "DEEP SPACE → SKY
// OVER PURI" came out as "DEEP SPACE !' SKY OVER PURI"). A few common
// symbols get a plain-text stand-in; any other text Courier can't print
// (e.g. a name typed in Devanagari) switches to the Hindi font, which
// carries both scripts -- so nothing is ever silently mangled.
const AI_MOVIE_WINANSI_EXTRAS = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

function aiMovieFitsCourier(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 128 || (code >= 160 && code <= 255) || AI_MOVIE_WINANSI_EXTRAS.includes(ch)) continue;
    return false;
  }
  return true;
}

function aiMovieCourierText(text) {
  return (text ?? "").replace(/→/g, "->").replace(/←/g, "<-").replace(/[⟶➔]/g, "->");
}

function renderAiMovieScreenplayPdf(res, { title, scenes, lang }) {
  const P = AI_MOVIE_PDF;
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: P.top, bottom: P.bottom, left: P.pageLeft, right: 612 - P.pageRight },
    bufferPages: true,
  });
  doc.registerFont("hindiRegular", FONTS.hindiRegular);
  doc.registerFont("hindiBold", FONTS.hindiBold);
  const bodyFont = lang === "hi" ? "hindiRegular" : "Courier";
  // Every text write goes through here so the Courier check above always
  // applies -- headings, names, transitions, and English action alike.
  const write = (font, text, x, y, options) => {
    const isCourier = font.startsWith("Courier");
    const printable = isCourier ? aiMovieCourierText(text) : text;
    const chosen = isCourier && !aiMovieFitsCourier(printable) ? (font === "Courier-Bold" ? "hindiBold" : "hindiRegular") : font;
    const gap = chosen.startsWith("Courier") ? P.courierLineGap : 0;
    return doc.font(chosen).fontSize(options?.fontSize ?? P.fontSize).text(printable, x, y, { lineGap: gap, ...options });
  };
  const pick = (value) => (value?.[lang] || value?.en || "").trim();

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${(title || "screenplay").replace(/[^a-z0-9]+/gi, "-")}-screenplay-${lang}-${formatExportTimestamp()}.pdf"`
  );
  doc.pipe(res);

  // Title page.
  write("Courier-Bold", (title || "Untitled").toUpperCase(), P.pageLeft, 260, { width: P.pageRight - P.pageLeft, align: "center", fontSize: 24 });
  doc.moveDown(1);
  write("Courier", "Screenplay", P.pageLeft, doc.y, { width: P.pageRight - P.pageLeft, align: "center" });
  write("Courier", `${lang === "hi" ? "Hindi" : "English"} draft — ${new Date().toISOString().slice(0, 10)}`, P.pageLeft, 792 - P.bottom - 20, { lineBreak: false });

  doc.addPage();
  const blankLine = () => doc.font("Courier").fontSize(P.fontSize).text(" ", P.pageLeft, doc.y, { lineGap: P.courierLineGap });
  const spaceLeft = () => doc.page.height - doc.page.margins.bottom - doc.y;
  const lineHeight = () => doc.font("Courier").fontSize(P.fontSize).currentLineHeight(true) + P.courierLineGap;
  // Keeps a heading or a character name from being stranded alone at the
  // bottom of a page (standard screenplay pagination).
  const keepLines = (n) => {
    if (spaceLeft() < lineHeight() * n) doc.addPage();
  };

  scenes.forEach((scene, sceneIndex) => {
    const number = String(sceneIndex + 1);
    keepLines(4);
    const headingY = doc.y;
    write("Courier-Bold", pick(scene.sceneHeading).toUpperCase() || "SCENE", P.pageLeft, headingY, { width: P.pageRight - P.pageLeft - 36 });
    const afterHeadingY = doc.y;
    write("Courier-Bold", number, 72, headingY, { width: 30, lineBreak: false });
    write("Courier-Bold", number, P.pageRight + 8, headingY, { width: 30, lineBreak: false });
    doc.y = afterHeadingY;
    blankLine();

    const writeAction = (text) => {
      for (const paragraph of (text ?? "").split(/\n+/).map((t) => t.trim()).filter(Boolean)) {
        write(bodyFont, paragraph, P.pageLeft, doc.y, { width: P.pageRight - P.pageLeft });
        blankLine();
      }
    };
    const writeDialogue = (cue, parenthetical, line) => {
      keepLines(parenthetical ? 4 : 3);
      write("Courier", cue, P.characterX, doc.y, { width: P.pageRight - P.characterX });
      if (parenthetical) write(bodyFont, `(${parenthetical})`, P.parentheticalX, doc.y, { width: P.parentheticalWidth });
      write(bodyFont, line, P.dialogueX, doc.y, { width: P.dialogueWidth });
      blankLine();
    };

    if (Array.isArray(scene.content) && scene.content.length > 0) {
      scene.content.forEach((block, blockIndex) => {
        if (block.type === "dialogue") writeDialogue(aiMovieCueWithContd(scene.content, blockIndex), pick(block.parenthetical), pick(block.line));
        else if (block.type === "transition") {
          write("Courier", block.transition, P.pageLeft, doc.y, { width: P.pageRight - P.pageLeft, align: "right" });
          blankLine();
        } else writeAction(pick(block.text));
      });
    } else {
      writeAction(pick(scene.action));
      if (Array.isArray(scene.dialogue)) {
        for (const line of scene.dialogue) writeDialogue((line.character ?? "").toUpperCase(), "", pick(line.line));
      }
    }

    // A song sheet prints as a SONG block after its beat's scenes: the
    // working title, the situation, then the filming plan section by
    // section. (No lyrics exist -- a lyricist writes those.)
    if (scene.songAfter) {
      const song = scene.songAfter;
      keepLines(4);
      write("Courier-Bold", `SONG — "${pick(song.workingTitle).toUpperCase()}" (${song.durationMinutes} MIN)`, P.pageLeft, doc.y, { width: P.pageRight - P.pageLeft });
      blankLine();
      writeAction(pick(song.situation));
      for (const part of song.picturization ?? []) {
        keepLines(3);
        write("Courier-Bold", `${part.section.toUpperCase()}:`, P.pageLeft, doc.y, { width: P.pageRight - P.pageLeft });
        writeAction(pick(part.visuals));
      }
      write("Courier", "END OF SONG.", P.pageLeft, doc.y, { width: P.pageRight - P.pageLeft, align: "right" });
      blankLine();
    }

    // Indian scripts mark the break with a centred INTERVAL line.
    if (scene.intervalAfter) {
      keepLines(3);
      blankLine();
      write("Courier-Bold", "INTERVAL", P.pageLeft, doc.y, { width: P.pageRight - P.pageLeft, align: "center" });
      blankLine();
      blankLine();
    }
  });

  // Page numbers, top right, from the second script page on (the title
  // page and first page of a screenplay are conventionally unnumbered).
  const range = doc.bufferedPageRange();
  for (let i = range.start + 2; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    write("Courier", `${i - range.start}.`, P.pageRight - 60, 36, { width: 60, align: "right", lineBreak: false });
  }
  doc.end();
}

app.get("/api/ai-movie/projects/:id/screenplay.pdf", requireRole("admin"), async (req, res) => {
  const lang = req.query.lang === "hi" ? "hi" : "en";
  const result = await db.query("SELECT title, backfill FROM ai_movie_projects WHERE id = $1", [req.params.id]);
  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: "Project not found." });
    return;
  }
  const intervalAfterBeat = row.backfill?.intervalAfterBeat;
  const scenes = (row.backfill?.screenplayBeats ?? []).flatMap((beat, beatIndex) =>
    Array.isArray(beat.scenes)
      ? beat.scenes.map((scene, sceneIndex) => {
          const isLast = sceneIndex === beat.scenes.length - 1;
          return {
            ...normalizeAiMovieSceneFormat(scene),
            songAfter: isLast ? beat.song ?? null : null,
            intervalAfter: beatIndex === intervalAfterBeat && isLast,
          };
        })
      : []
  );
  if (scenes.length === 0) {
    res.status(400).json({ error: "No screenplay scenes written yet." });
    return;
  }
  renderAiMovieScreenplayPdf(res, { title: row.backfill?.story?.title?.en || row.title, scenes, lang });
});

// Deleting a project also removes its reference files — the
// ai_movie_reference_files.project_id foreign key is ON DELETE CASCADE, so
// one row delete here is enough.
app.delete("/api/ai-movie/projects/:id", requireRole("admin"), async (req, res) => {
  const result = await db.query("DELETE FROM ai_movie_projects WHERE id = $1", [req.params.id]);
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Project not found." });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/ai-movie/projects/import", requireRole("admin"), async (req, res) => {
  const { project } = req.body;

  if (!project || !project.pastedText || !project.pastedText.trim()) {
    res.status(400).json({ error: "This file doesn't look like an AI Movie project export." });
    return;
  }

  const inserted = await db.query(
    "INSERT INTO ai_movie_projects (title, pasted_text, detected_stage, backfill, assets, stage_status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    [
      project.title ?? null,
      project.pastedText,
      project.detectedStage ?? null,
      JSON.stringify(project.backfill ?? {}),
      JSON.stringify(project.assets ?? {}),
      JSON.stringify(project.stageStatus ?? {}),
      req.user.id,
    ]
  );

  // Optional: an export can also carry the project's reference files (the
  // Akhada story bible, scenic breakdown, rules) -- without them every
  // writer on the imported project would lose its grounding. Older export
  // files simply don't have this list.
  const referenceFiles = Array.isArray(project.referenceFiles) ? project.referenceFiles : [];
  for (const file of referenceFiles) {
    if (typeof file?.content !== "string" || !file.content.trim()) continue;
    await db.query(
      "INSERT INTO ai_movie_reference_files (project_id, category, label, content) VALUES ($1, $2, $3, $4)",
      [inserted.rows[0].id, typeof file.category === "string" && file.category ? file.category : "other", file.label ?? null, file.content]
    );
  }

  res.json({ id: inserted.rows[0].id });
});

// One-off, purpose-built: creates a brand-new AI Movie project named
// "Akhada" and attaches the real story bible files the user handed off
// (agent task + 46-beat plot/characters/world lore, the full scenic
// breakdown of those 46 beats, and the two extra project rules) as
// Reference Material, auto-categorized the same way any other upload is.
// Nothing here is invented — these are the user's own already-written
// files, read straight off disk. Once seeded, the normal Generate-from-
// Reference / per-stage Generate buttons take it from there.
const AI_MOVIE_AKHADA_SEED_DIR = path.join(import.meta.dirname, "reference-material", "akhada");
const AI_MOVIE_AKHADA_SEED_FILES = [
  { file: "1_agent_handoff.md", label: "Akhada Agent Handoff (task, 46-beat plot, characters, world lore)" },
  { file: "2_scenic_breakdown.md", label: "Akhada Scenic Breakdown (46 beats, full visual description)" },
  { file: "3_rules_addendum.md", label: "Akhada Project Rules Addendum (interval cliffhanger, simple English)" },
];

app.post("/api/ai-movie/projects/seed-akhada", requireRole("admin"), async (req, res) => {
  const inserted = await db.query(
    "INSERT INTO ai_movie_projects (title, pasted_text, created_by) VALUES ('Akhada', '', $1) RETURNING id",
    [req.user.id]
  );
  const projectId = inserted.rows[0].id;

  for (const { file, label } of AI_MOVIE_AKHADA_SEED_FILES) {
    const content = fs.readFileSync(path.join(AI_MOVIE_AKHADA_SEED_DIR, file), "utf8");
    const category = await classifyAiMovieReferenceCategory(content);
    await db.query(
      "INSERT INTO ai_movie_reference_files (project_id, category, label, content) VALUES ($1, $2, $3, $4)",
      [projectId, category, label, content]
    );
  }

  res.json({ projectId });
});

// One-off, purpose-built companion to seed-akhada: the Akhada story bible
// already has its Synopsis, Characters, Three-Act Structure, and Beat
// Sheet fully written (see fixed-stage-content.js) — there is nothing for
// an AI to invent at these stages, only English content that needs a
// faithful Odia/Hindi translation to fit the app's bilingual schema. This
// skips the normal one-stage-at-a-time Generate/Approve chain for exactly
// those four layers and fills + auto-approves them all in one call, so the
// project lands ready for the Screenplay stage without four redundant
// review steps over content that was never going to change.
async function translateAkhadaFixedContent(englishPayload, responseSchema, maxOutputTokens) {
  return generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents: `This is finished English story-bible content for a film — already final, nothing to change. Add a faithful Hindi (hi) translation to every bilingual text field. Keep the English exactly as given; do not shorten, add to, or otherwise alter its meaning. Any plain number field (e.g. runtimeMinutes) is not text to translate — copy it through completely unchanged:\n\n${JSON.stringify(englishPayload)}`,
    config: {
      systemInstruction:
        "You are a professional Hindi translator working on a finished film story bible. You never alter, invent, or edit the given English content — you only add a faithful translation of it, matching the required schema exactly.",
      responseMimeType: "application/json",
      maxOutputTokens,
      responseSchema,
    },
  });
}

// Saves one stage's translated content and marks it approved in the same
// query the rest of the app already uses for approval, so a stage filled
// in here is indistinguishable from one approved the normal way.
async function saveAiMovieFilledStage(projectId, stageKey, content) {
  const result = await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
  const backfill = { ...(result.rows[0]?.backfill ?? {}), [stageKey]: content };
  await db.query(
    "UPDATE ai_movie_projects SET backfill = $1, stage_status = stage_status || $2::jsonb, updated_at = now() WHERE id = $3",
    [JSON.stringify(backfill), JSON.stringify({ [stageKey]: { status: "approved", feedback: null } }), projectId]
  );
}

// In-memory only (fine for a job that finishes in a couple of minutes, and
// resets harmlessly on a redeploy — the client just re-POSTs to restart
// it). Lets the client tell "still working" apart from "failed" without
// keeping one HTTP request open the whole time.
const akhadaFillStatus = new Map();

app.post("/api/ai-movie/projects/:id/fill-akhada-stages", requireRole("admin"), async (req, res) => {
  const projectId = req.params.id;
  const projectResult = await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
  const project = projectResult.rows[0];
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }
  if (!project.backfill?.story) {
    res.status(400).json({ error: "Generate the Story first." });
    return;
  }

  // Respond immediately and keep working after — five sequential Gemini
  // calls held open in one request/response was reliably hitting a
  // network-level timeout before it could ever finish (the same
  // "something went wrong" shape as the earlier oversized-reference-
  // material bug, just caused by call COUNT this time instead of text
  // size). Each stage is saved to the database the moment it's translated,
  // so progress survives even if a later stage fails, and the client polls
  // fill-akhada-status instead of waiting on one long-lived response.
  akhadaFillStatus.set(projectId, "running");
  res.json({ started: true });

  try {
    const synopsis = await translateAkhadaFixedContent(AKHADA_FIXED_SYNOPSIS, AI_MOVIE_SYNOPSIS_LAYER_SCHEMA, 2048);
    await saveAiMovieFilledStage(projectId, "synopsis", synopsis);

    const characterArc = await translateAkhadaFixedContent(
      AKHADA_FIXED_CHARACTERS,
      { type: Type.ARRAY, items: AI_MOVIE_CHARACTER_ARC_SCHEMA },
      4096
    );
    await saveAiMovieFilledStage(projectId, "characterArc", characterArc);

    const threeAct = await translateAkhadaFixedContent(
      AKHADA_FIXED_THREE_ACT,
      { type: Type.ARRAY, items: AI_MOVIE_THREE_ACT_SCHEMA },
      4096
    );
    await saveAiMovieFilledStage(projectId, "threeAct", threeAct);

    // Split into two batches for reliability — a single 46-beat call
    // produces enough output text (title + description, times three
    // languages, times 46) to risk the response getting cut off mid-JSON
    // before it finishes, the same failure mode hit earlier with a large
    // script analysis. Two smaller batches stay well within budget.
    const beatsMid = Math.ceil(AKHADA_FIXED_BEATS.length / 2);
    const plotPart1 = await translateAkhadaFixedContent(
      AKHADA_FIXED_BEATS.slice(0, beatsMid),
      { type: Type.ARRAY, items: AI_MOVIE_PLOT_BEAT_SCHEMA },
      16384
    );
    const plotPart2 = await translateAkhadaFixedContent(
      AKHADA_FIXED_BEATS.slice(beatsMid),
      { type: Type.ARRAY, items: AI_MOVIE_PLOT_BEAT_SCHEMA },
      16384
    );
    await saveAiMovieFilledStage(projectId, "plot", [...plotPart1, ...plotPart2]);

    akhadaFillStatus.set(projectId, "done");
  } catch (error) {
    console.error("Akhada fixed-stage fill failed:", error.message);
    akhadaFillStatus.set(projectId, { error: error.message });
  }
});

app.get("/api/ai-movie/projects/:id/fill-akhada-status", requireRole("admin"), (req, res) => {
  const status = akhadaFillStatus.get(req.params.id) ?? "none";
  if (status === "running" || status === "done" || status === "none") {
    res.json({ status });
    return;
  }
  res.json({ status: "error", error: status.error });
});

// One-off, purpose-built companion to fill-akhada-stages: a Beat Sheet
// filled in (or generated) before runtimeMinutes existed on the schema has
// no duration on any beat at all. Rather than re-translate/regenerate the
// whole Beat Sheet again, this patches ONLY the runtimeMinutes number on
// each beat, matched positionally against AKHADA_FIXED_BEATS (the same
// exact, user-supplied figures used to seed a fresh Akhada project) --
// title/description text, already-written screenplay scenes, and every
// other stage are left completely untouched. Purely numeric and instant
// (no Gemini call), so no background-job/polling pattern is needed here.
app.post("/api/ai-movie/projects/:id/fill-akhada-beat-durations", requireRole("admin"), async (req, res) => {
  const projectId = req.params.id;
  const projectResult = await db.query("SELECT title, backfill FROM ai_movie_projects WHERE id = $1", [projectId]);
  const project = projectResult.rows[0];
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }
  const beats = project.backfill?.plot;
  if (!Array.isArray(beats) || beats.length === 0) {
    res.status(400).json({ error: "Generate the Beat Sheet first." });
    return;
  }

  // A safety check, not a hard requirement -- flags any beat whose title
  // doesn't closely match the expected one at that position (translation
  // drift, or a Beat Sheet that was edited/regenerated away from the fixed
  // content) rather than silently applying a number to the wrong beat.
  const normalize = (s) => (s ?? "").trim().toLowerCase();
  let updated = 0;
  const mismatches = [];
  const newBeats = beats.map((beat, index) => {
    const fixedBeat = AKHADA_FIXED_BEATS[index];
    if (!fixedBeat) return beat;
    if (normalize(beat.title?.en) !== normalize(fixedBeat.title)) {
      mismatches.push({ index, expected: fixedBeat.title, found: beat.title?.en ?? null });
      return beat;
    }
    updated += 1;
    return { ...beat, runtimeMinutes: fixedBeat.runtimeMinutes };
  });

  await saveAiMovieBackfillField(projectId, "plot", newBeats);
  res.json({ ok: true, updated, total: beats.length, mismatches });
});

// Fourth AI Movie piece: reference/grounding material the user hands the
// agents directly (a real book their story draws from, character/property/
// art details they want to specify themselves) rather than leaving
// everything to invention. Creates the project row on the fly (same lazy-
// create as analyze-stage) so attaching a reference file can be the very
// first thing a user does, before pasting any story text at all.
async function ensureAiMovieProjectId(projectId, userId) {
  if (projectId) return projectId;
  const inserted = await db.query(
    "INSERT INTO ai_movie_projects (pasted_text, created_by) VALUES ('', $1) RETURNING id",
    [userId]
  );
  return inserted.rows[0].id;
}

const AI_MOVIE_REFERENCE_FILE_CATEGORIES = ["book", "characters", "properties", "art", "other"];

// The user doesn't pick a category by hand — whatever they paste or upload
// gets silently read and sorted into one of these by itself. Falls back to
// "other" on any classification failure rather than blocking the save;
// getting the reference material saved matters more than labeling it
// perfectly.
const AI_MOVIE_REFERENCE_CATEGORY_SYSTEM_PROMPT = `You read a piece of reference material a filmmaker is attaching to their AI Movie project and classify what kind of material it is. Pick exactly one:
- "book": material from or about a real book/novel/published work the story draws from (an excerpt, a summary, plot events).
- "characters": details specifically about one or more characters (appearance, personality, backstory).
- "properties": details about physical objects/props.
- "art": details about visual/art direction, environments, locations, mood, or style.
- "other": doesn't clearly match any of the above.
Judge by the actual content, not by any filename or label.`;

async function classifyAiMovieReferenceCategory(content) {
  try {
    const result = await generateJsonContent({
      model: GEMINI_MODEL_NAME,
      contents: `Classify this reference material:\n\n${content.slice(0, 8000)}`,
      config: {
        systemInstruction: AI_MOVIE_REFERENCE_CATEGORY_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        maxOutputTokens: 128,
        responseSchema: {
          type: Type.OBJECT,
          properties: { category: { type: Type.STRING, enum: AI_MOVIE_REFERENCE_FILE_CATEGORIES } },
          required: ["category"],
        },
      },
    });
    return result.category;
  } catch (error) {
    console.error("Reference material auto-categorize failed, defaulting to 'other':", error.message);
    return "other";
  }
}

app.post("/api/ai-movie/reference-files", requireRole("admin"), async (req, res) => {
  const { projectId, label, content } = req.body;

  if (!content || !content.trim()) {
    res.status(400).json({ error: "Paste some content first." });
    return;
  }

  const id = await ensureAiMovieProjectId(projectId, req.user.id);
  const category = await classifyAiMovieReferenceCategory(content);

  const inserted = await db.query(
    "INSERT INTO ai_movie_reference_files (project_id, category, label, content) VALUES ($1, $2, $3, $4) RETURNING id",
    [id, category, label || null, content]
  );

  res.json({ id: inserted.rows[0].id, projectId: id });
});

// Reference Material uploads can be a .zip containing several documents —
// each supported file inside becomes its own reference entry (so it can be
// labeled, listed, and removed individually, same as if it had been
// uploaded on its own). Unsupported/unreadable entries inside are skipped
// rather than failing the whole zip.
async function extractFilesFromZip(buffer) {
  const zip = new AdmZip(buffer);
  const results = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    try {
      const content = await extractTextFromUploadedScreenplay({ originalname: entry.entryName, buffer: entry.getData() });
      if (content && content.trim()) results.push({ label: entry.entryName, content });
    } catch {
      // Unsupported or unreadable entry inside the zip — skip it, don't fail the whole zip.
    }
  }
  return results;
}

const aiMovieReferenceFileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.post(
  "/api/ai-movie/reference-files/upload",
  requireRole("admin"),
  aiMovieReferenceFileUpload.array("files", 20),
  async (req, res) => {
    if (!req.files || req.files.length === 0) {
      res.status(400).json({ error: "No file uploaded." });
      return;
    }

    const id = await ensureAiMovieProjectId(req.body.projectId, req.user.id);
    const created = [];
    const errors = [];

    for (const file of req.files) {
      const ext = path.extname(file.originalname).toLowerCase();
      try {
        const items =
          ext === ".zip"
            ? await extractFilesFromZip(file.buffer)
            : [{ label: file.originalname, content: await extractTextFromUploadedScreenplay(file) }];

        const readable = items.filter((item) => item.content && item.content.trim());
        if (readable.length === 0) {
          errors.push({ filename: file.originalname, error: "Couldn't read any text out of that file." });
          continue;
        }

        for (const item of readable) {
          const category = await classifyAiMovieReferenceCategory(item.content);
          // Just the file's own name — repeating the zip's filename on
          // every single row it contained made long lists unreadable
          // (every label started with the same long, identical prefix).
          const label = ext === ".zip" ? path.basename(item.label) : item.label;
          const inserted = await db.query(
            "INSERT INTO ai_movie_reference_files (project_id, category, label, content) VALUES ($1, $2, $3, $4) RETURNING id",
            [id, category, label, item.content]
          );
          created.push(inserted.rows[0].id);
        }
      } catch (error) {
        errors.push({ filename: file.originalname, error: error.message });
      }
    }

    res.json({ projectId: id, created, errors });
  }
);

app.get("/api/ai-movie/reference-files", requireRole("admin"), async (req, res) => {
  const { projectId } = req.query;
  if (!projectId) {
    res.json([]);
    return;
  }

  const result = await db.query(
    "SELECT id, category, label, created_at FROM ai_movie_reference_files WHERE project_id = $1 ORDER BY created_at",
    [projectId]
  );
  res.json(result.rows.map((row) => ({ id: row.id, category: row.category, label: row.label, createdAt: row.created_at })));
});

app.delete("/api/ai-movie/reference-files/:id", requireRole("admin"), async (req, res) => {
  await db.query("DELETE FROM ai_movie_reference_files WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
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
    model: GEMINI_MODEL_NAME,
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
    await setConceptTitleIfMissing(conceptId, pitchDeckContent.title);

    res.json({ conceptId });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

async function generateSkipToBitSheet(pastedText, runtimeMinutes) {
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL_NAME,
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
    await setConceptTitleIfMissing(conceptId, pitchDeckContent.title);

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
    model: GEMINI_MODEL_NAME,
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
    await setConceptTitleIfMissing(conceptId, pitchDeckContent.title);

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
  // No cap — a script with a large cast could genuinely need more than a
  // small fixed budget for the character-name list alone.
  const parsed = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents: `The user pasted an already-written screenplay below — treat it as authoritative, this is a transcription/structuring task, not a creative rewrite. Extract: a short English-only project title (a few words, internal reference only); and a list of the major character names who appear across the ENTIRE script (plain proper nouns, no descriptions).\n\nThe pasted screenplay:\n${fullText}`,
    config: {
      systemInstruction: SCENE_SYSTEM_PROMPT,
      responseMimeType: "application/json",
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

  return sanitizeBilingualContent(parsed);
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

  // No maxOutputTokens cap — an uploaded script's own length is whatever it
  // is (a real one already truncated a fixed budget), so this is left to
  // the model's own maximum rather than another number we'd just have to
  // keep raising. generateJsonContent also adds the retry-on-parse-failure
  // safety net this call didn't have before (it used generateContentWithRetry
  // directly, with a raw, unprotected JSON.parse).
  const parsed = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents: `The user pasted an already-written screenplay below — treat it as authoritative, this is a transcription/structuring task, not a creative rewrite. ${episodeLine}Extract a faithful scene-by-scene breakdown of the ENTIRE material given — for each scene give sceneNumber (the scene's OWN literal number/label exactly as written in the source — e.g. "5A", "36", or whatever this script actually uses; copy it verbatim, including any letter suffix; NEVER assume it restarts at 1 per episode or renumber it sequentially yourself — if the source keeps counting up across episodes, or starts a scene list mid-sequence, or uses "5A"/"5B" for scenes inserted between 5 and 6, preserve that exactly, since this is what every department on set actually references), actNumber (estimate 1/2/3 from its position within this material), intExt (INT/EXT), a bilingual location (just the place name), timeOfDay (DAY/NIGHT), a bilingual oneLiner summarizing what happens — and it must name EVERY character physically present in the scene, not just whoever is speaking or central to it (someone silently dropping something off, a background figure the script names, etc. — never omit a named person from the one-liner just because their part is brief), an estimatedMinutes number (infer from the scene's length/content), a purpose ("plot_advancing" or "character_revealing"), and a bilingual turn (its value-shift).${targetLine} Odia must be real Odia (Oriya) script, never Romanized. Do not skip any scene, however short.\n\nThe pasted screenplay material:\n${episodeText}`,
    config: {
      systemInstruction: SCENE_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: { scenes: { type: Type.ARRAY, items: SCENE_SCHEMA } },
        required: ["scenes"],
      },
    },
  });

  return sanitizeBilingualContent(parsed).scenes;
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

  if (ext === ".txt" || ext === ".fountain" || ext === ".md" || ext === ".markdown") {
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

  throw new Error(`Unsupported file type "${ext}". Try .txt, .md, .pdf, .docx, .doc, .fdx, or .scrite.`);
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

// A 'story' type concept's own title stays NULL until the user manually
// renames it — the pasted idea text (e.g. "i need a gen z drama in
// bhubaneswar...") was showing up as the project name everywhere (All
// Projects cards, History list, the project picker) even after a real name
// existed on the chosen storyline/pitch deck. Auto-fill it the moment a
// pitch deck exists, from that storyline's own title, so a real project
// name appears from the start instead of only after a manual rename.
// Guarded on IS NULL so it never overwrites a name the user set on purpose.
async function setConceptTitleIfMissing(conceptId, title) {
  if (!conceptId || !title?.en) return;
  await db.query("UPDATE concepts SET title = $1 WHERE id = $2 AND title IS NULL", [title.en, conceptId]);
}

// Builds the bilingual pitch-deck content via Gemini. When `revision` is
// given, the prompt asks for a rewrite that addresses the producer's
// feedback instead of a first draft.
// A single call asking for "exactly N episodes" has no hard enforcement —
// a Gemini array schema can't constrain length, it's a text instruction
// only, and testing found it drifting badly on larger counts, ESPECIALLY on
// a revision call (a real run: 60 requested -> 66, then 30, then 33 across
// 3 revision rounds). Episodes are generated in small batches instead (same
// fix already applied to three-act/bit-sheet/scene-list) — a batch of 10 is
// small enough that Gemini reliably returns exactly that many, so the
// ASSEMBLED total is correct by construction, not by hoping a huge one-shot
// count instruction was followed.
const PITCH_DECK_EPISODE_BATCH_SIZE = 10;

async function generatePitchDeckEpisodeBatch(
  storyline, format, isVerticalDrama, batchStart, batchCount, totalCount, priorEpisodesSummary, revision
) {
  const positionNote =
    batchStart === 0
      ? `These are the FIRST ${batchCount} episodes (1-${batchCount} of ${totalCount} total) — establish the setup and hook the audience immediately.`
      : batchStart + batchCount >= totalCount
        ? `These are the FINAL ${batchCount} episodes (${batchStart + 1}-${totalCount} of ${totalCount} total) — this batch must bring the whole ${totalCount}-episode arc to a satisfying resolution.`
        : `These are episodes ${batchStart + 1}-${batchStart + batchCount} of ${totalCount} total — continue building the arc from what's already happened, developing it further toward the eventual resolution (don't resolve everything yet).`;

  let contents = `Storyline title (English): ${storyline.title.en}\nLogline (English): ${storyline.logline.en}\nSummary (English): ${storyline.summary.en}\n\n${priorEpisodesSummary ? `Episodes already established so far (for continuity — do not repeat or contradict them):\n${priorEpisodesSummary}\n\n` : ""}${positionNote}\n\nWrite EXACTLY ${batchCount} episodes for THIS BATCH ONLY (not the whole series — the rest are handled separately).`;

  contents += isVerticalDrama
    ? ` Each episode is only ${format.episodeMinutes} minutes — extremely short, fast-paced (ReelShort/short-drama app style), NOT a scaled-down web-series episode. For each episode give a short punchy title (2-5 words, do NOT include the word "Episode" or a number in the title itself), a tight 3-4 sentence synopsis that gets straight to the point — establish the situation fast, land one sharp turn, no wasted setup or padding — and a separate "hook" field: the EXACT, SPECIFIC beat the episode ends on, stated concretely — it can be a line of dialogue OR a silent action/visual beat, whichever genuinely suits that episode better; never a vague placeholder like "things get complicated". Every episode in this batch, including the last one if this is the final batch, must end on a real hook of this kind.`
    : ` Each episode is ${format.episodeMinutes} minutes. For each episode give a short punchy title (2-5 words, do NOT include the word "Episode" or a number in the title itself) and an elaborated 5-7 sentence synopsis that genuinely establishes the whole episode: what it opens on, the conflict/complication that develops through it, and how it turns or ends.`;

  if (revision) {
    const previousChunk = (revision.previous.episodes ?? []).slice(batchStart, batchStart + batchCount);
    contents += `\n\nThis is a REVISION. The producer reviewed the whole pitch deck and requested changes.\nFeedback: "${revision.feedback}"\nPrevious draft for JUST this batch of episodes:\n${JSON.stringify(previousChunk)}\nRevise this batch to address the feedback directly, while keeping exactly ${batchCount} episodes in this batch.`;
  }

  const episodeItemSchema = isVerticalDrama
    ? {
        type: Type.OBJECT,
        properties: { title: BILINGUAL_TEXT_SCHEMA, synopsis: BILINGUAL_TEXT_SCHEMA, hook: BILINGUAL_TEXT_SCHEMA },
        required: ["title", "synopsis", "hook"],
      }
    : {
        type: Type.OBJECT,
        properties: { title: BILINGUAL_TEXT_SCHEMA, synopsis: BILINGUAL_TEXT_SCHEMA },
        required: ["title", "synopsis"],
      };

  const parsed = await generateJsonContent({
    model: STORY_WRITER_MODEL_NAME,
    contents,
    config: {
      systemInstruction: PITCH_DECK_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: { episodes: { type: Type.ARRAY, items: episodeItemSchema } },
        required: ["episodes"],
      },
    },
  });

  return sanitizeBilingualContent(parsed).episodes;
}

async function generatePitchDeckContent(storyline, format, revision) {
  const isSeries = format?.type === "series" || format?.type === "vertical";
  const isVerticalDrama = format?.type === "vertical";

  const properties = {
    premise: BILINGUAL_TEXT_SCHEMA,
    storyPages: { type: Type.ARRAY, items: BILINGUAL_TEXT_SCHEMA },
    genre: BILINGUAL_TEXT_SCHEMA,
    toneGenre: BILINGUAL_TEXT_SCHEMA,
    targetAudience: BILINGUAL_TEXT_SCHEMA,
    highlights: { type: Type.ARRAY, items: BILINGUAL_TEXT_SCHEMA },
    sponsorshipAngle: BILINGUAL_TEXT_SCHEMA,
    majorCharacters: { type: Type.ARRAY, items: CHARACTER_SCHEMA },
  };
  const required = ["premise", "storyPages", "genre", "toneGenre", "targetAudience", "highlights", "sponsorshipAngle", "majorCharacters"];

  // Episodes are no longer requested here at all — generated separately, in
  // batches, below. This call only produces the story/pitch materials every
  // episode will be grounded in.
  const formatInstruction = isVerticalDrama
    ? `Format: vertical micro-drama, exactly ${format.episodeCount} episodes of only ${format.episodeMinutes} minutes each — these are extremely short, fast-paced episodes (think ReelShort/short-drama app style), NOT scaled-down web-series episodes.

BUDGET-FRIENDLY PRODUCTION CONSTRAINT — this is a low-budget format meant to shoot in just 2-3 days total, so the story itself must be conceived to need very little: around 5 main characters (plus a little background crowd at most, never a large cast), and a small, contained setting — a single family home (its rooms — kitchen, bedroom, drawing room, dining room — count as one location) plus at most one more interior (like a shop or restaurant) and a couple of simple free exterior spots. Never invent a plot that requires many locations, a big cast, or spectacle — the drama must come from dialogue, relationships, and what happens between these few people in this one small world.`
    : isSeries
      ? `Format: web series, exactly ${format.episodeCount} episodes of ${format.episodeMinutes} minutes each.\n\n${NO_BUDGET_LIMIT_INSTRUCTION}`
      : `Format: feature film.\n\n${NO_BUDGET_LIMIT_INSTRUCTION}`;
  const majorCharactersInstruction = isVerticalDrama
    ? "Also give 3-5 major characters who actually drive this story (name, role, emotional core, central conflict)."
    : "Also give every major character who actually drives this story — as many as the story genuinely needs, typically 4-10 for a film or web series (hero, antagonist, love interest, family, allies, rivals...) — each with name, role, emotional core, central conflict. Don't trim the cast to save money.";

  let contents = `Storyline title (English): ${storyline.title.en}\nLogline (English): ${storyline.logline.en}\nSummary (English): ${storyline.summary.en}\n${formatInstruction}\n\n${majorCharactersInstruction}\n\nAlso give: "genre" — a SHORT genre label, just 2-4 words (e.g. "Crime Drama", "Romantic Comedy", "Family Slice-of-Life"), distinct from the longer "toneGenre" prose description; "targetAudience" — cover the age group, the region/market this is aimed at, and what specifically appeals to that audience (not just an age range alone); "highlights" — exactly 4 short, punchy bullet points (5-15 words each) on what makes this story stand out from similar shows — genuinely distinctive hooks, not generic praise; "sponsorshipAngle" — a short paragraph aimed at a potential brand sponsor: why a brand should back this specific story, and at least one concrete branding/placement idea (e.g. title sponsorship, a natural product-placement moment, a brand-integrated segment) grounded in this story's actual content, not a generic pitch.\n\nEvery one of those fields — premise, genre, toneGenre, targetAudience, highlights, sponsorshipAngle — must ALSO be in plain, simple, everyday English, exactly like storyPages below: no literary or "impressive" words (nothing like "prodigy", "despises", "backdrop", "backlash", "navigate a turbulent landscape"), just the plain way a person would actually say it out loud. This is a hard requirement across every field, not only the story pages.\n\n${PITCH_DECK_STORY_PAGES_INSTRUCTION}`;

  if (revision) {
    contents += `\n\nThis is a REVISION of a previous draft. The producer reviewed it and requested changes.\nProducer's feedback: "${revision.feedback}"\n${previousDraftForRevision(revision.previous, ["episodes"], revision.fresh)}\nRevise the pitch deck to address the producer's feedback directly, while keeping the same title and logline.`;
  }

  const core = sanitizeBilingualContent(
    await generateJsonContent({
      model: STORY_WRITER_MODEL_NAME,
      contents,
      config: {
        systemInstruction: PITCH_DECK_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        // Every bilingual field here is now trilingual (en/or/hi) — premise,
        // 1-2 pages of storyPages prose, 3-5 full character sheets,
        // highlights, and sponsorshipAngle all in three languages easily
        // exceeds any fixed budget, truncating the JSON mid-string (looks
        // like a parse bug, isn't — see generateJsonContent's retry, which
        // can't fix a genuinely too-small budget). Left uncapped rather than
        // raised again, since raising it kept just moving the same failure.
        responseSchema: {
          type: Type.OBJECT,
          properties,
          required,
        },
      },
    })
  );

  const result = {
    title: storyline.title,
    logline: storyline.logline,
    premise: core.premise,
    storyPages: core.storyPages,
    genre: core.genre,
    toneGenre: core.toneGenre,
    targetAudience: core.targetAudience,
    highlights: core.highlights,
    sponsorshipAngle: core.sponsorshipAngle,
    majorCharacters: core.majorCharacters,
    format: format ?? { type: "film" },
    episodes: null,
  };

  if (!isSeries) return result;

  const totalCount = format.episodeCount;
  const chunkStarts = [];
  for (let i = 0; i < totalCount; i += PITCH_DECK_EPISODE_BATCH_SIZE) chunkStarts.push(i);

  // A real, repeatedly-observed failure: asking a batch for "EXACTLY N
  // episodes" doesn't reliably get exactly N back — a real 60-episode
  // concept cycled through 67, 63, 68, 62, 68, 61, 61 episodes across many
  // separate attempts, NEVER once landing on 60, because the judge-revision
  // loop only ever asks the model to try again and gets the same class of
  // miss back. An overshoot is trimmed from the END of whichever batch
  // produced it (safe — that's just this batch's own extra episode(s), not
  // borrowed from a different, correct batch); an undershoot is left for
  // the existing judge-loop retry, since inventing missing story content
  // isn't something code can safely do.
  function enforceBatchEpisodeCount(episodes, expectedCount) {
    return episodes.length > expectedCount ? episodes.slice(0, expectedCount) : episodes;
  }

  if (revision) {
    // Each batch has the OLD version of just its own chunk as continuity
    // grounding (same pattern as three-act/bit-sheet/scene-list revisions),
    // so batches are independent and can run concurrently.
    const chunkResults = await mapWithConcurrency(chunkStarts, 3, async (start) => {
      const batchCount = Math.min(PITCH_DECK_EPISODE_BATCH_SIZE, totalCount - start);
      const batch = await generatePitchDeckEpisodeBatch(storyline, format, isVerticalDrama, start, batchCount, totalCount, null, revision);
      return enforceBatchEpisodeCount(batch, batchCount);
    });
    result.episodes = chunkResults.flat();
  } else {
    // No prior episodes exist yet on a first pass — each batch needs to see
    // every earlier batch's episodes to keep the arc coherent, so these run
    // strictly in order, not concurrently.
    let allEpisodes = [];
    for (const start of chunkStarts) {
      const batchCount = Math.min(PITCH_DECK_EPISODE_BATCH_SIZE, totalCount - start);
      const priorSummary = allEpisodes.length
        ? allEpisodes.map((ep, i) => `${i + 1}. ${ep.title.en}: ${ep.synopsis.en}`).join("\n")
        : null;
      const batch = await generatePitchDeckEpisodeBatch(
        storyline, format, isVerticalDrama, start, batchCount, totalCount, priorSummary, null
      );
      allEpisodes = allEpisodes.concat(enforceBatchEpisodeCount(batch, batchCount));
    }
    result.episodes = allEpisodes;
  }

  // The trim above only ever fixes an OVERSHOOT — it can't invent missing
  // story content for an undershoot. Observed in practice: with overshoots
  // now trimmed away, some attempts land UNDER instead (a real run got 59
  // when 60 were requested) and would otherwise hard-fail after burning all
  // 3 revision rounds. One top-up batch for exactly the shortfall, framed
  // as the final episodes completing the arc, is far cheaper than another
  // full revision round and fixes the common case (a small gap) outright.
  if (result.episodes.length < totalCount) {
    const shortfall = totalCount - result.episodes.length;
    const priorSummary = result.episodes.map((ep, i) => `${i + 1}. ${ep.title.en}: ${ep.synopsis.en}`).join("\n");
    const topUp = await generatePitchDeckEpisodeBatch(
      storyline, format, isVerticalDrama, result.episodes.length, shortfall, totalCount, priorSummary, null
    );
    result.episodes = result.episodes.concat(enforceBatchEpisodeCount(topUp, shortfall));
  }

  return result;
}

app.post("/api/pitch-deck", requireRole("admin"), async (req, res) => {
  const { conceptId, storyline, format } = req.body;

  try {
    const content = await generatePitchDeckContent(storyline, format);

    const insertResult = await db.query(
      "INSERT INTO pitch_decks (concept_id, content) VALUES ($1, $2) RETURNING id, status, feedback",
      [conceptId ?? null, JSON.stringify(content)]
    );
    await setConceptTitleIfMissing(conceptId, content.title);

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
    await setConceptTitleIfMissing(conceptId, revisedContent.title);

    res.json({ ...insertResult.rows[0], ...revisedContent, previousFeedback: feedback });
  } catch (error) {
    console.error("Gemini API call failed:", error.message);
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/pitch-deck/:id/export", requireLogin, async (req, res) => {
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";

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
    // Odia and Hindi have no equivalent of the English display fonts, so
    // each reuses its own one bold weight for both display roles.
    const coverFont = lang === "or" ? "odiaBold" : lang === "hi" ? "hindiBold" : "displayBold";
    const headerFont = lang === "or" ? "odiaBold" : lang === "hi" ? "hindiBold" : "impact";
    const bodyFont = lang === "or" ? "odiaRegular" : lang === "hi" ? "hindiRegular" : "Helvetica";

    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 0 });

    doc.registerFont("odiaRegular", FONTS.odiaRegular);
    doc.registerFont("odiaBold", FONTS.odiaBold);
    doc.registerFont("hindiRegular", FONTS.hindiRegular);
    doc.registerFont("hindiBold", FONTS.hindiBold);
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

    // The Story page(s) — the single most important page in the whole
    // deck (see PITCH_DECK_STORY_PAGES_INSTRUCTION), so it gets its own
    // full-bleed, text-forward layout rather than the lighter "band" style
    // used for the shorter supporting sections below.
    function storyPageSlide(index, total, bodyText) {
      doc.addPage();
      fillBackground(theme.bg);
      doc.rect(0, 0, W, 6).fill(theme.accent);

      doc.fillColor(theme.accent).font(headerFont).fontSize(30);
      const heading = total > 1 ? `${labels.story.toUpperCase()} (${index + 1}/${total})` : labels.story.toUpperCase();
      doc.text(heading, margin, margin, { width: W - margin * 2 });

      doc.fillColor("#F0EEE9").font(bodyFont).fontSize(13.5);
      doc.text(bodyText, margin, margin + 55, { width: W - margin * 2, lineGap: 5 });
    }

    // Slide 1: Cover
    fillBackground(theme.bg);
    drawCornerLines(margin, margin, 1);
    drawCornerLines(W - margin, H - margin, -1);
    drawPill(deck.genre ? formatWithGenreLabel(deck.format, deck.genre, lang) : formatLabel(deck.format, lang), margin);

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

    // Story page(s) — right after the cover, ahead of everything else.
    if (deck.storyPages && deck.storyPages.length > 0) {
      deck.storyPages.forEach((page, i, arr) => storyPageSlide(i, arr.length, page[lang]));
    }

    // Slide 2: Premise
    sectionSlide(labels.premise, deck.premise[lang]);

    // Slide 3: Tone / Genre
    sectionSlide(labels.toneGenre, deck.toneGenre[lang]);

    // Slide 4: Target Audience
    sectionSlide(labels.targetAudience, deck.targetAudience[lang]);

    // Slide 5: Unique Elements / highlights — only when the deck actually
    // has them (older decks generated before this field existed won't).
    if (deck.highlights && deck.highlights.length > 0) {
      sectionSlide(labels.highlights, deck.highlights.map((h) => `•  ${h[lang]}`).join("\n\n"));
    }

    // Slide 6: Sponsorship Angle
    if (deck.sponsorshipAngle) {
      sectionSlide(labels.sponsorshipAngle, deck.sponsorshipAngle[lang]);
    }

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
        if (episode.hook) {
          const synopsisHeight = doc.heightOfString(episode.synopsis[lang], { width: textWidth, lineGap: 5 });
          const hookY = 150 + synopsisHeight + 16;
          doc
            .fillColor(theme.accent)
            .font(headerFont)
            .fontSize(12)
            .text(labels.hook.toUpperCase(), textX, hookY, { width: textWidth });
          doc
            .fillColor("#F0EEE9")
            .font(bodyFont)
            .fontSize(14)
            .text(episode.hook[lang], textX, doc.y + 2, { width: textWidth, lineGap: 5 });
        }
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
// A real .pptx, not a spreadsheet — a presentation is what a "Download
// Presentation" button should actually hand someone. Only reachable once
// a Character Sheet exists (gated on the frontend): that's what turns the
// pitch deck's thin Major Characters into archetype/want/need/flaw/arc
// content worth putting in front of a producer, so the character slides
// below always prefer it over the deck's own thin character blurbs.
app.get("/api/pitch-deck/:id/export-ppt", requireLogin, async (req, res) => {
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";

  try {
    const result = await db.query("SELECT content FROM pitch_decks WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Pitch deck not found" });
      return;
    }
    const deck = result.rows[0].content;
    const labels = SECTION_LABELS[lang];
    const theme = pickTheme(deck.toneGenre.en);
    const hex = (c) => c.replace("#", "");

    const characterSheetResult = await db.query(
      "SELECT content FROM character_sheets WHERE pitch_deck_id = $1 ORDER BY created_at DESC LIMIT 1",
      [req.params.id]
    );
    const richCharacters = characterSheetResult.rows[0]?.content?.characters ?? null;

    const archetypeLabels =
      lang === "or"
        ? { hero: "ନାୟକ", mentor: "ଗୁରୁ", threshold_guardian: "ପ୍ରହରୀ", herald: "ଦୂତ", shapeshifter: "ରୂପ ପରିବର୍ତ୍ତନକାରୀ", shadow: "ଛାୟା", ally: "ସହଯୋଗୀ", trickster: "ଚତୁର" }
        : lang === "hi"
          ? { hero: "नायक", mentor: "गुरु", threshold_guardian: "प्रहरी", herald: "दूत", shapeshifter: "रूप बदलने वाला", shadow: "छाया", ally: "सहयोगी", trickster: "चालाक" }
          : { hero: "Hero", mentor: "Mentor", threshold_guardian: "Threshold Guardian", herald: "Herald", shapeshifter: "Shapeshifter", shadow: "Shadow", ally: "Ally", trickster: "Trickster" };
    const fieldLabels =
      lang === "or"
        ? { want: "ଚାହିଦା", need: "ଆବଶ୍ୟକତା", flaw: "ତ୍ରୁଟି", arc: "ଚରିତ୍ର ଯାତ୍ରା", introductionBeat: "ପରିଚୟ" }
        : lang === "hi"
          ? { want: "चाहत", need: "ज़रूरत", flaw: "कमी", arc: "किरदार का सफ़र", introductionBeat: "परिचय" }
          : { want: "Want", need: "Need", flaw: "Flaw", arc: "Arc", introductionBeat: "Introduction" };

    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: "WIDE", width: 10, height: 5.63 });
    pptx.layout = "WIDE";

    function addBackground(slide, color) {
      slide.background = { color: hex(color) };
    }

    // Cover
    const cover = pptx.addSlide();
    addBackground(cover, theme.bg);
    const coverFormatLine = deck.genre ? formatWithGenreLabel(deck.format, deck.genre, lang) : formatLabel(deck.format, lang);
    cover.addText(coverFormatLine.toUpperCase(), {
      x: 0, y: 0.4, w: "100%", h: 0.4, align: "center", fontSize: 12, bold: true, color: hex(theme.accent), charSpacing: 2,
    });
    cover.addText(deck.title[lang], {
      x: 0.6, y: 2.0, w: 8.8, h: 1.2, align: "center", fontSize: 36, bold: true, color: "F5F1EA", fontFace: "Georgia",
    });
    cover.addText(deck.logline[lang], {
      x: 1.2, y: 3.2, w: 7.6, h: 1.0, align: "center", fontSize: 14, italic: true, color: hex(theme.accent),
    });
    cover.addText(labels.tagline, {
      x: 0.6, y: 5.0, w: 8.8, h: 0.4, align: "center", fontSize: 9, color: hex(theme.accent),
    });

    // Section slide helper — a light band with a title, dark body below.
    function sectionSlide(title, body) {
      const slide = pptx.addSlide();
      addBackground(slide, theme.panel);
      slide.addShape("rect", { x: 0, y: 0, w: "100%", h: 2.0, fill: { color: hex(theme.panel) } });
      slide.addShape("rect", { x: 0, y: 2.0, w: "100%", h: 3.63, fill: { color: hex(theme.bg) } });
      slide.addText(title.toUpperCase(), {
        x: 0.6, y: 1.3, w: 8.8, h: 0.8, fontSize: 30, bold: true, color: hex(theme.accent),
      });
      slide.addText(body, {
        x: 0.6, y: 2.3, w: 8.8, h: 3.0, fontSize: 15, color: "F0EEE9", valign: "top",
      });
    }

    // The Story page(s) — the single most important part of the deck (see
    // PITCH_DECK_STORY_PAGES_INSTRUCTION) — full-bleed, text-forward, right
    // after the cover and ahead of every supporting section.
    if (deck.storyPages && deck.storyPages.length > 0) {
      const total = deck.storyPages.length;
      deck.storyPages.forEach((page, i) => {
        const slide = pptx.addSlide();
        addBackground(slide, theme.bg);
        slide.addShape("rect", { x: 0, y: 0, w: "100%", h: 0.06, fill: { color: hex(theme.accent) } });
        const heading = total > 1 ? `${labels.story.toUpperCase()} (${i + 1}/${total})` : labels.story.toUpperCase();
        slide.addText(heading, {
          x: 0.6, y: 0.35, w: 8.8, h: 0.6, fontSize: 22, bold: true, color: hex(theme.accent),
        });
        slide.addText(page[lang], {
          x: 0.6, y: 1.1, w: 8.8, h: 4.3, fontSize: 13, color: "F0EEE9", valign: "top", lineSpacingMultiple: 1.2,
        });
      });
    }

    sectionSlide(labels.premise, deck.premise[lang]);
    sectionSlide(labels.toneGenre, deck.toneGenre[lang]);
    sectionSlide(labels.targetAudience, deck.targetAudience[lang]);

    // Highlights — a bulleted "what makes this stand out" slide, only when
    // the deck actually has them (older decks generated before this field
    // existed won't, and shouldn't get a blank slide).
    if (deck.highlights && deck.highlights.length > 0) {
      const slide = pptx.addSlide();
      addBackground(slide, theme.panel);
      slide.addText(labels.highlights.toUpperCase(), {
        x: 0.6, y: 0.5, w: 8.8, h: 0.7, fontSize: 28, bold: true, color: hex(theme.accent),
      });
      const bulletItems = deck.highlights.map((h) => ({ text: h[lang], options: { bullet: true, breakLine: true } }));
      slide.addText(bulletItems, {
        x: 0.8, y: 1.6, w: 8.4, h: 3.4, fontSize: 16, color: "F0EEE9", valign: "top", lineSpacingMultiple: 1.3,
      });
    }

    if (deck.sponsorshipAngle) {
      sectionSlide(labels.sponsorshipAngle, deck.sponsorshipAngle[lang]);
    }

    // Character slides — one per character, preferring the deep Character
    // Sheet data (archetype/want/need/flaw/arc) when it exists.
    if (richCharacters && richCharacters.length > 0) {
      richCharacters.forEach((character) => {
        const slide = pptx.addSlide();
        addBackground(slide, theme.panel);
        slide.addText(character.name, { x: 0.6, y: 0.35, w: 6.5, h: 0.6, fontSize: 26, bold: true, color: "F5F1EA" });
        slide.addText(archetypeLabels[character.archetype] ?? character.archetype, {
          x: 0.6, y: 0.95, w: 6.5, h: 0.4, fontSize: 13, bold: true, color: hex(theme.accent),
        });
        slide.addText(character.role[lang], { x: 0.6, y: 1.4, w: 8.8, h: 0.5, fontSize: 13, italic: true, color: "F0EEE9" });

        const bodyLines = [
          `${fieldLabels.want}: ${character.want[lang]}`,
          `${fieldLabels.need}: ${character.need[lang]}`,
          `${fieldLabels.flaw}: ${character.flaw[lang]}`,
          `${fieldLabels.arc}: ${character.arc[lang]}`,
        ].join("\n\n");
        slide.addText(bodyLines, { x: 0.6, y: 2.0, w: 8.8, h: 3.3, fontSize: 12, color: "F0EEE9", valign: "top", lineSpacingMultiple: 1.15 });
      });
    } else if (deck.majorCharacters && deck.majorCharacters.length > 0) {
      const slide = pptx.addSlide();
      addBackground(slide, theme.panel);
      slide.addText(labels.majorCharacters.toUpperCase(), { x: 0.6, y: 0.4, w: 8.8, h: 0.6, fontSize: 24, bold: true, color: hex(theme.accent) });
      const rows = deck.majorCharacters.map((c) => [
        { text: c.name, options: { bold: true, color: "F5F1EA" } },
        { text: c.role[lang], options: { color: "F0EEE9" } },
        { text: c.emotionalCore[lang], options: { color: "F0EEE9" } },
      ]);
      slide.addTable(rows, { x: 0.6, y: 1.2, w: 8.8, h: 3.8, fontSize: 11, color: "F0EEE9", border: { type: "none" } });
    }

    // Episode slides (series only)
    if (deck.episodes) {
      deck.episodes.forEach((episode, index) => {
        const slide = pptx.addSlide();
        addBackground(slide, theme.panel);
        slide.addShape("rect", { x: 0, y: 0, w: 3.0, h: "100%", fill: { color: hex(theme.accent) } });
        slide.addText(String(index + 1).padStart(2, "0"), {
          x: 0, y: 1.8, w: 3.0, h: 2.0, align: "center", fontSize: 80, bold: true, color: hex(theme.bg),
        });
        slide.addText(`${labels.episode.toUpperCase()} ${index + 1}`, { x: 3.3, y: 0.5, w: 6.1, h: 0.4, fontSize: 12, bold: true, color: hex(theme.accent) });
        slide.addText(episode.title[lang], { x: 3.3, y: 0.9, w: 6.1, h: 0.7, fontSize: 22, bold: true, color: "F5F1EA" });
        if (episode.hook) {
          slide.addText(episode.synopsis[lang], { x: 3.3, y: 1.7, w: 6.1, h: 2.4, fontSize: 13, color: "F0EEE9", valign: "top" });
          slide.addText(`${labels.hook.toUpperCase()}`, { x: 3.3, y: 4.2, w: 6.1, h: 0.35, fontSize: 12, bold: true, color: hex(theme.accent) });
          slide.addText(episode.hook[lang], { x: 3.3, y: 4.55, w: 6.1, h: 1.0, fontSize: 13, color: "F0EEE9", valign: "top" });
        } else {
          slide.addText(episode.synopsis[lang], { x: 3.3, y: 1.7, w: 6.1, h: 3.5, fontSize: 13, color: "F0EEE9", valign: "top" });
        }
      });
    }

    // Closing
    const closing = pptx.addSlide();
    addBackground(closing, theme.bg);
    closing.addText(labels.thankYou.toUpperCase(), {
      x: 0.6, y: 2.2, w: 8.8, h: 1.0, align: "center", fontSize: 44, bold: true, color: hex(theme.accent),
    });
    closing.addText(labels.tagline, { x: 0.6, y: 5.0, w: 8.8, h: 0.4, align: "center", fontSize: 9, color: hex(theme.accent) });

    const buffer = await pptx.write({ outputType: "nodebuffer" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${deck.title.en.replace(/[^a-z0-9]+/gi, "-")}-pitch-deck-${lang}-${formatExportTimestamp()}.pptx"`
    );
    res.send(buffer);
  } catch (error) {
    console.error("Pitch deck PPT export failed:", error.message);
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
  const isSeries =
    (deck.format?.type === "series" || deck.format?.type === "vertical") && Array.isArray(deck.episodes);

  const seedCharacters = (deck.majorCharacters ?? [])
    .map((c) => `${c.name} — ${c.role.en}. Emotional core: ${c.emotionalCore.en}. Conflict: ${c.conflict.en}.`)
    .join("\n");

  let contents = `Title (English): ${deck.title.en}\nLogline (English): ${deck.logline.en}\nPremise (English): ${deck.premise.en}\nTone/Genre (English): ${deck.toneGenre.en}\n${isSeries ? `Format: web series, ${deck.episodes.length} episodes.` : "Format: feature film."}\n\nPitch deck's Major Characters to deepen:\n${seedCharacters}`;

  if (revision) {
    contents += `\n\nThis is a REVISION of a previous character sheet. The Story Writer reviewed it and requested changes.\nFeedback: "${revision.feedback}"\n${revision.previous ? `${previousDraftForRevision(revision.previous, [], revision.fresh)}\n` : ""}Revise the character sheet to address the feedback directly.`;
  }

  // 11 trilingual (en/or/hi) fields per character, up to 5 characters —
  // easily exceeds a modest budget and truncates mid-JSON (same failure
  // mode as the pitch deck's core-content call). generateJsonContent also
  // adds a retry-on-parse-failure safety net this call didn't have before.
  const parsed = await generateJsonContent({
    model: STORY_WRITER_MODEL_NAME,
    contents,
    config: {
      systemInstruction: CHARACTER_SHEET_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: { characters: { type: Type.ARRAY, items: CHARACTER_SHEET_ENTRY_SCHEMA } },
        required: ["characters"],
      },
    },
  });

  return sanitizeBilingualContent(parsed);
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

// Same chunking rationale as BIT_SHEET_EPISODE_BATCH_SIZE — the per-episode
// "episodeStructures" array used to be generated in the SAME single call as
// the overall series arc, with only a 16384-token budget for the whole
// thing. That's the exact failure mode already found (and fixed) for the
// bit sheet at just 8 episodes; a 60-episode vertical drama would very
// likely truncate here too. Now the overall arc is one small call, and
// per-episode structures are generated in batches referencing it.
const THREE_ACT_EPISODE_BATCH_SIZE = 5;

async function generateThreeActEpisodeBatch(deck, episodesChunk, startIndex, overallContext, revision) {
  const episodeList = episodesChunk
    .map((episode, i) => `Episode ${startIndex + i + 1}: ${episode.title.en} — ${episode.synopsis.en}`)
    .join("\n");
  const episodeMinutes = deck.format.episodeMinutes ?? null;
  const perEpisodePacingLine = episodeMinutes
    ? ` Each individual episode runs ${episodeMinutes} minutes — ${episodePacingGuidance(episodeMinutes)}.`
    : "";

  let contents = `${overallContext}\n\nHere is ONE BATCH of ${episodesChunk.length} episodes (out of ${deck.episodes.length} total):\n${episodeList}\n\nFor EACH episode in this batch, provide its OWN compact three-act mini-structure ("setup"/"confrontation"/"resolution") — what happens within just that single episode, consistent with its synopsis above and with the overall series structure already given.${perEpisodePacingLine} Return "episodeStructures": an array of exactly ${episodesChunk.length} objects, in the same order as the episodes given above (this batch only, not the whole series).`;

  if (revision) {
    const previousChunk = (revision.previous.episodeStructures ?? []).slice(startIndex, startIndex + episodesChunk.length);
    contents += `\n\nThis is a REVISION of a previous three-act structure. The Story Writer reviewed it and requested changes.\nFeedback: "${revision.feedback}"\nPrevious draft for JUST this batch of episodes:\n${JSON.stringify(previousChunk)}\nRevise this batch to address the feedback directly.`;
  }

  const parsed = await generateJsonContent({
    model: STORY_WRITER_MODEL_NAME,
    contents,
    config: {
      systemInstruction: THREE_ACT_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          episodeStructures: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { setup: ACT_SCHEMA, confrontation: ACT_SCHEMA, resolution: ACT_SCHEMA },
              required: ["setup", "confrontation", "resolution"],
            },
          },
        },
        required: ["episodeStructures"],
      },
    },
  });

  return sanitizeBilingualContent(parsed).episodeStructures;
}

async function generateThreeActContent(deck, characterSheet, revision) {
  const isSeries =
    (deck.format?.type === "series" || deck.format?.type === "vertical") && Array.isArray(deck.episodes);

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
    const episodeTitles = deck.episodes.map((episode, index) => `${index + 1}. ${episode.title.en}`).join("; ");
    const episodeMinutes = deck.format.episodeMinutes ?? null;
    const totalMinutes =
      deck.format.episodeCount && episodeMinutes ? deck.format.episodeCount * episodeMinutes : null;
    const overallPacingLine = totalMinutes
      ? ` The series runs ${deck.format.episodeCount} episodes × ${episodeMinutes} minutes (${totalMinutes} minutes total) — for the OVERALL structure, ${pacingGuidance(totalMinutes).charAt(0).toLowerCase()}${pacingGuidance(totalMinutes).slice(1)}`
      : "";

    // Per-episode structures are generated separately, in batches, below —
    // this call only produces the bird's-eye overall arc.
    contents += `\n\nThis is a web series with exactly ${deck.episodes.length} episodes: ${episodeTitles}.\n\nProvide "setup", "confrontation", "resolution" as a three-act structure for the ENTIRE series arc (the overall bird's-eye story spanning all episodes) — do NOT provide per-episode detail here, that is handled separately.${overallPacingLine}`;
  } else if (deck.format?.runtimeMinutes) {
    contents += `\n\nThis is a feature film with a target runtime of ${deck.format.runtimeMinutes} minutes. ${pacingGuidance(deck.format.runtimeMinutes)}`;
  }

  if (revision) {
    contents += `\n\nThis is a REVISION of a previous three-act structure. The Story Writer reviewed it and requested changes.\nStory Writer's feedback: "${revision.feedback}"\n${previousDraftForRevision(revision.previous, ["episodeStructures"], revision.fresh)}\nRevise the three-act structure to address the feedback directly.`;
  }

  const overall = sanitizeBilingualContent(
    await generateJsonContent({
      model: STORY_WRITER_MODEL_NAME,
      contents,
      config: {
        systemInstruction: THREE_ACT_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties,
          required,
        },
      },
    })
  );
  if (!isSeries) return overall;

  const overallContext = `Story title: ${deck.title.en}\nOverall series three-act structure already locked:\nSetup: ${overall.setup.summary.en}\nConfrontation: ${overall.confrontation.summary.en}\nResolution: ${overall.resolution.summary.en}\nControlling idea (theme): ${overall.controllingIdea.en}`;

  const chunkStarts = [];
  for (let i = 0; i < deck.episodes.length; i += THREE_ACT_EPISODE_BATCH_SIZE) chunkStarts.push(i);

  // Same real, observed failure as the pitch deck's episode batches: a
  // batch asked for "exactly N" doesn't reliably come back at exactly N.
  // Unlike the pitch deck, this stage has no judge-revision loop to retry
  // through — assertEpisodeCount just throws immediately — so an overshoot
  // here is a guaranteed hard failure unless trimmed first.
  const chunkResults = await mapWithConcurrency(chunkStarts, 3, async (start) => {
    const expectedCount = Math.min(THREE_ACT_EPISODE_BATCH_SIZE, deck.episodes.length - start);
    const batch = await generateThreeActEpisodeBatch(
      deck,
      deck.episodes.slice(start, start + THREE_ACT_EPISODE_BATCH_SIZE),
      start,
      overallContext,
      revision
    );
    return batch.length > expectedCount ? batch.slice(0, expectedCount) : batch;
  });

  let episodeStructures = chunkResults.flat();
  // Same undershoot gap as the pitch deck (see its own comment) — one
  // top-up batch for exactly the shortfall, rather than a hard fail with
  // no revision loop to fall back on for this stage.
  if (episodeStructures.length < deck.episodes.length) {
    const shortfall = deck.episodes.length - episodeStructures.length;
    const topUp = await generateThreeActEpisodeBatch(
      deck,
      deck.episodes.slice(episodeStructures.length, episodeStructures.length + shortfall),
      episodeStructures.length,
      overallContext,
      revision
    );
    episodeStructures = episodeStructures.concat(topUp.length > shortfall ? topUp.slice(0, shortfall) : topUp);
  }

  return { ...overall, episodeStructures };
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
// A short film can't hold 12+ beats (seen for real: 15 beats for a 10-minute
// film squeezed its scene list) — under 40 minutes it's about one beat per
// 2.5 minutes, never fewer than the 8 structural anchors.
function suggestBitCount(minutes) {
  if (!minutes) return 12;
  if (minutes < 40) return Math.min(12, Math.max(8, Math.round(minutes / 2.5)));
  return Math.min(24, Math.max(12, Math.round(minutes / 8)));
}

// Builds the bilingual Bit Sheet via Gemini, from a LOCKED three-act
// structure. For a web series, generates one Bit Sheet per episode (using
// that episode's own mini three-act structure); for a film, one Bit Sheet
// covering the whole three-act structure. When `revision` is given, the
// prompt asks for a rewrite that addresses feedback instead of a first draft.
// One Gemini call per batch of episodes, not one call for the whole series —
// a real test with just 8 vertical-drama episodes already truncated the JSON
// response at 12288 tokens (each episode needs its own full set of trilingual
// structural bits). Same lesson as AD_SHEET_BATCH_SIZE: chunk and run
// concurrently rather than betting on ever-larger single-call token budgets,
// since a 60-episode vertical drama would overflow almost any single-call
// ceiling. See project_gemini_token_budget memory for the earlier pitch-deck
// version of this same failure mode.
const BIT_SHEET_EPISODE_BATCH_SIZE = 5;

async function generateBitSheetEpisodeBatch(episodesChunk, structuresChunk, startIndex, deck, isVerticalDrama, threeAct, revision) {
  const episodesText = episodesChunk
    .map((episode, i) => {
      const structure = structuresChunk[i];
      const suggested = suggestBitCount(deck.format.episodeMinutes);
      const hookLine = isVerticalDrama && episode.hook ? `\nHook this episode must end on: ${episode.hook.en}` : "";
      return `Episode ${startIndex + i + 1}: ${episode.title.en} (aim for roughly ${suggested} bits)\nSetup: ${actText(structure.setup)}\nConfrontation: ${actText(structure.confrontation)}\nResolution: ${actText(structure.resolution)}${hookLine}`;
    })
    .join("\n\n");

  let contents = isVerticalDrama
    ? `This is a vertical micro-drama with ${deck.episodes.length} short episodes in total. Here is ONE BATCH of ${episodesChunk.length} of them, each with its own three-act mini-structure, plus the specific hook it must end on:\n\n${episodesText}\n\nFor EACH episode in this batch, break its three acts into its OWN complete Bit Sheet — an ordered list of its major plot-point beats. Each episode is a self-contained mini-story, so each episode's Bit Sheet must include its own opening_image, theme_stated, plot_point_1, all_is_lost, plot_point_2, and final_image anchors positioned within that episode, not just once for the whole series. Since these episodes are extremely short, keep each episode's bit list lean — the final bit (final_image) MUST be the concrete moment that delivers that episode's hook, exactly as given above, not a softer or different beat. Return "episodeBits": an array of exactly ${episodesChunk.length} objects, in the same order as the episodes given above (this batch only, not the whole series).`
    : `This is a web series with ${deck.episodes.length} episodes in total. Here is ONE BATCH of ${episodesChunk.length} of them, each with its own three-act mini-structure:\n\n${episodesText}\n\nFor EACH episode in this batch, break its three acts into its OWN complete Bit Sheet — an ordered list of its major plot-point beats. Each episode is a self-contained mini-story, so each episode's Bit Sheet must include its own opening_image, theme_stated, plot_point_1, all_is_lost, plot_point_2, and final_image anchors positioned within that episode, not just once for the whole series. Return "episodeBits": an array of exactly ${episodesChunk.length} objects, in the same order as the episodes given above (this batch only, not the whole series).`;

  if (threeAct.controllingIdea) {
    contents += `\n\nThe story's Controlling Idea (theme) is: "${threeAct.controllingIdea.en}" — the theme_stated bit especially, and every other bit generally, should stay true to this idea.`;
  }

  if (revision) {
    const previousChunk = (revision.previous.episodeBits ?? []).slice(startIndex, startIndex + episodesChunk.length);
    contents += `\n\nThis is a REVISION of a previous Bit Sheet. The Story Writer reviewed the whole thing and requested changes.\nFeedback: "${revision.feedback}"\nPrevious draft for JUST this batch of episodes:\n${JSON.stringify(previousChunk)}\nRevise this batch to address the feedback directly.`;
  }

  const parsed = await generateJsonContent({
    model: STORY_WRITER_MODEL_NAME,
    contents,
    config: {
      systemInstruction: BIT_SHEET_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          episodeBits: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { bits: { type: Type.ARRAY, items: BIT_SCHEMA } },
              required: ["bits"],
            },
          },
        },
        required: ["episodeBits"],
      },
    },
  });

  return sanitizeBilingualContent(parsed).episodeBits;
}

async function generateBitSheetContent(threeAct, deck, revision) {
  const isVerticalDrama = deck.format?.type === "vertical";
  const isSeries =
    (deck.format?.type === "series" || isVerticalDrama) &&
    Array.isArray(deck.episodes) &&
    Array.isArray(threeAct.episodeStructures);

  if (isSeries) {
    const chunkStarts = [];
    for (let i = 0; i < deck.episodes.length; i += BIT_SHEET_EPISODE_BATCH_SIZE) chunkStarts.push(i);

    // Same real, observed overshoot failure as the pitch deck and three-act
    // batches — no revision loop here either, so it's trimmed before
    // assertEpisodeCount ever gets a chance to hard-fail the whole run.
    const chunkResults = await mapWithConcurrency(chunkStarts, 3, async (start) => {
      const expectedCount = Math.min(BIT_SHEET_EPISODE_BATCH_SIZE, deck.episodes.length - start);
      const batch = await generateBitSheetEpisodeBatch(
        deck.episodes.slice(start, start + BIT_SHEET_EPISODE_BATCH_SIZE),
        threeAct.episodeStructures.slice(start, start + BIT_SHEET_EPISODE_BATCH_SIZE),
        start,
        deck,
        isVerticalDrama,
        threeAct,
        revision
      );
      return batch.length > expectedCount ? batch.slice(0, expectedCount) : batch;
    });

    let episodeBits = chunkResults.flat();
    // Same undershoot gap as the pitch deck/three-act (see their comments).
    if (episodeBits.length < deck.episodes.length) {
      const shortfall = deck.episodes.length - episodeBits.length;
      const topUp = await generateBitSheetEpisodeBatch(
        deck.episodes.slice(episodeBits.length, episodeBits.length + shortfall),
        threeAct.episodeStructures.slice(episodeBits.length, episodeBits.length + shortfall),
        episodeBits.length,
        deck,
        isVerticalDrama,
        threeAct,
        revision
      );
      episodeBits = episodeBits.concat(topUp.length > shortfall ? topUp.slice(0, shortfall) : topUp);
    }

    const content = { episodeBits };
    return threeAct.controllingIdea ? { ...content, controllingIdea: threeAct.controllingIdea } : content;
  }

  const suggested = suggestBitCount(deck.format?.runtimeMinutes);
  let contents = `Here is the film's locked three-act structure:\nSetup: ${actText(threeAct.setup)}\nConfrontation: ${actText(threeAct.confrontation)}\nResolution: ${actText(threeAct.resolution)}\n\nBreak this into a Bit Sheet — an ordered list of the film's major plot-point beats (aim for roughly ${suggested} bits, covering all three acts in order). Return "bits": a single array covering the whole film.`;

  if (threeAct.controllingIdea) {
    contents += `\n\nThe story's Controlling Idea (theme) is: "${threeAct.controllingIdea.en}" — the theme_stated bit especially, and every other bit generally, should stay true to this idea.`;
  }

  if (revision) {
    contents += `\n\nThis is a REVISION of a previous Bit Sheet. The Story Writer reviewed it and requested changes.\nFeedback: "${revision.feedback}"\n${revision.previous ? `${previousDraftForRevision({ bits: revision.previous.bits }, [], revision.fresh)}\n` : ""}Revise the Bit Sheet to address the feedback directly.`;
  }

  const content = sanitizeBilingualContent(
    await generateJsonContent({
      model: STORY_WRITER_MODEL_NAME,
      contents,
      config: {
        systemInstruction: BIT_SHEET_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: { bits: { type: Type.ARRAY, items: BIT_SCHEMA } },
          required: ["bits"],
        },
      },
    })
  );
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

// Film-only: a batched series/vertical-drama scene list checks and retries
// its runtime target per-batch instead (see generateSceneListEpisodeBatch).
function sceneListNeedsRetry(content) {
  return isFarFromTarget(content.totalEstimatedMinutes, content.targetMinutes);
}

function buildRetryCorrectionNote(content) {
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
  // 300, not the old 150: every scene is now written in English, Odia AND
  // Hindi, and Odia/Hindi text takes far more tokens than English.
  const estimated = Math.ceil(totalTargetMinutes * 300);
  return Math.min(MAX_GEMINI_OUTPUT_TOKENS, Math.max(fallback, estimated));
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

  const parsed = await generateJsonContent({
    model: STORY_WRITER_MODEL_NAME,
    contents,
    config: {
      systemInstruction: SCENE_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      // + room for 2.5 Flash's thinking, which counts against this ceiling.
      maxOutputTokens: Math.min(MAX_GEMINI_OUTPUT_TOKENS, estimateTokenBudget(totalTargetMinutes, isSeries) + 8192),
      responseSchema: {
        type: Type.OBJECT,
        properties,
        required,
      },
    },
  });

  return sanitizeBilingualContent(parsed);
}

// Same chunking rationale as BIT_SHEET_EPISODE_BATCH_SIZE — a scene list call
// covering many episodes at once (a high-episode-count vertical drama can
// run to 60) risks the same output-token truncation the bit sheet hit.
const SCENE_LIST_EPISODE_BATCH_SIZE = 5;

// Generates the scene list for ONE batch of episodes. For a vertical drama,
// `lockedLocations` is null only for the very first batch — that batch is
// responsible for INVENTING the series' small, reusable location set; every
// later batch is given that exact list and required to reuse it verbatim,
// which is why the first batch must finish before the rest can start.
async function generateSceneListEpisodeBatch(deck, bitSheet, episodesChunk, startIndex, episodeTargetMinutes, isVerticalDrama, lockedLocations, revision) {
  const episodesText = episodesChunk
    .map((episode, i) => {
      const bits = bitSheet.episodeBits[startIndex + i].bits;
      const targetLine = episodeTargetMinutes
        ? ` Target on-screen runtime for this episode: ${episodeTargetMinutes} minutes (aim for roughly ${suggestSceneCount(episodeTargetMinutes)} scenes, adjusted as pacing requires).`
        : "";
      return `Episode ${startIndex + i + 1}: ${episode.title.en}${targetLine}\nBit Sheet (major plot points, in order):\n${bitSheetOutlineText(bits)}`;
    })
    .join("\n\n");

  let contents = `This is a ${isVerticalDrama ? "vertical micro-drama" : "web series"} with ${deck.episodes.length} episodes in total. Here is ONE BATCH of ${episodesChunk.length} of them, each with its own Bit Sheet — its major plot-point beats, already verified:\n\n${episodesText}\n\nFor EACH episode in this batch, expand its Bit Sheet into a full scene-by-scene list — each bit typically becomes 1-3 scenes — whose scenes' combined "estimatedMinutes" add up to approximately that episode's target runtime given above. Return "episodeScenes": an array of exactly ${episodesChunk.length} objects, in the same order as the episodes given above (this batch only, not the whole series).`;

  if (isVerticalDrama) {
    contents += lockedLocations
      ? `\n\nBUDGET-FRIENDLY PRODUCTION CONSTRAINT — this is a low-budget vertical micro-drama shooting in 2-3 days total. The series' small, fixed location set has ALREADY been decided from earlier episodes — do NOT invent any new location. Every scene's "location" English value in this batch MUST be EXACTLY one of these strings, verbatim: ${lockedLocations.map((l) => `"${l}"`).join(", ")}.`
      : `\n\nBUDGET-FRIENDLY PRODUCTION CONSTRAINT — this is a low-budget vertical micro-drama meant to shoot in 2-3 days total, so the scene list MUST be built around a very small, reusable set of locations, not story variety for its own sake. These are the FIRST episodes, so you are ESTABLISHING the fixed location set every later batch of episodes will be required to reuse verbatim:
- Use AT MOST 4-5 distinct physical locations for the WHOLE series — reuse the same handful of locations across many episodes rather than inventing a new place for each one.
- Strongly prefer ONE house as the primary location, and treat its different rooms (kitchen, a bedroom, the drawing/living room, the dining room) as separate scene locations WITHIN that one house — that still counts as ONE location for the production (one address, one set to build/dress), not several.
- At most one more interior location (e.g. one restaurant/shop/office) and a couple of simple, easy-to-access exterior locations (a street, a terrace, a park) that need no permission or set dressing — never multiple different houses or multiple different exterior neighborhoods.
- The story must be carried by dialogue and character drama happening WITHIN this small set of locations, not by moving the story to new places or spectacle — favor confrontations, revelations, and emotional beats that naturally happen at home, at the one shop, or on the street outside, over anything that would require a new set.
- Give each location a clear, reusable English name (e.g. "House — Kitchen", "House — Drawing Room", "Street Outside House", "The Shop") that later batches of episodes will match exactly.`;
  } else {
    contents += `\n\n${NO_BUDGET_LIMIT_INSTRUCTION}`;
  }

  if (bitSheet.controllingIdea) {
    contents += `\n\nThe story's Controlling Idea (theme) is: "${bitSheet.controllingIdea.en}" — keep scenes true to it.`;
  }

  if (revision) {
    const previousChunk = (revision.previous.episodeScenes ?? []).slice(startIndex, startIndex + episodesChunk.length);
    contents += `\n\nThis is a REVISION of a previous scene list. The Screenplay Writer reviewed the whole thing and requested changes.\nFeedback: "${revision.feedback}"\nPrevious draft for JUST this batch of episodes:\n${JSON.stringify(previousChunk)}\nRevise this batch to address the feedback directly, keeping the same overall structure otherwise.`;
  }

  const totalTargetForBatch = episodeTargetMinutes ? episodeTargetMinutes * episodesChunk.length : null;
  let content = await callSceneListGemini(contents, true, totalTargetForBatch);

  // Per-batch retry if THIS batch's own runtime total is far off target —
  // capped at one retry so a persistently stubborn response can't burn
  // through the daily API quota.
  const perEpisodeTotals = content.episodeScenes.map((es) => sumSceneMinutes(es.scenes));
  if (perEpisodeTotals.some((total) => isFarFromTarget(total, episodeTargetMinutes))) {
    const lines = perEpisodeTotals
      .map((total, i) =>
        isFarFromTarget(total, episodeTargetMinutes)
          ? `Episode ${startIndex + i + 1}: your scenes totaled ${total} minutes against a target of ${episodeTargetMinutes} minutes — adjust the number and length of scenes so the total is much closer to the target.`
          : null
      )
      .filter(Boolean)
      .join("\n");
    content = await callSceneListGemini(contents + `\n\nIMPORTANT CORRECTION NEEDED:\n${lines}`, true, totalTargetForBatch);
  }

  return content.episodeScenes;
}

// Films and (non-vertical) web series have no budget cap -- the user's
// call: only a vertical micro-drama is written to a small shoot (about 5
// characters, 4-5 locations). Everything else uses as many characters and
// places as its story needs.
const NO_BUDGET_LIMIT_INSTRUCTION = "NO BUDGET LIMIT for this format: use as many characters and as many different locations as the story genuinely needs. Never shrink the cast or keep the story in a few places just to save money.";

// A feature film's scene list used to be ONE answer covering the whole
// film, every scene in English, Odia and Hindi -- for a 2-hour film that
// ran past the model's room and was cut off mid-answer (seen for real in
// the automatic pipeline). It's now written in parts of about 30 minutes
// each, in story order; a short film is still a single part.
const FILM_SCENE_LIST_PART_MINUTES = 30;

function splitFilmBitsIntoParts(bits, filmTargetMinutes) {
  const partCount = Math.max(1, Math.min(bits.length, Math.ceil((filmTargetMinutes || 0) / FILM_SCENE_LIST_PART_MINUTES)));
  const parts = [];
  for (let p = 0; p < partCount; p++) {
    const start = Math.round((p * bits.length) / partCount);
    const end = Math.round(((p + 1) * bits.length) / partCount);
    // This part's share of the runtime, in proportion to its number of bits.
    const targetMinutes = filmTargetMinutes && bits.length > 0 ? Math.round(((filmTargetMinutes * (end - start)) / bits.length) * 10) / 10 : null;
    parts.push({ start, end, targetMinutes: targetMinutes ?? filmTargetMinutes ?? null });
  }
  return parts;
}

async function generateFilmSceneListPart(bitSheet, part, partIndex, partCount, filmTargetMinutes, scenesSoFar, revision) {
  const isOnlyPart = partCount === 1;
  const targetLine = part.targetMinutes
    ? isOnlyPart
      ? `Target on-screen runtime for the whole film: ${filmTargetMinutes} minutes (aim for roughly ${suggestSceneCount(filmTargetMinutes)} scenes, adjusted as pacing requires).`
      : `This part covers about ${part.targetMinutes} minutes of the film's ${filmTargetMinutes}-minute runtime (aim for roughly ${suggestSceneCount(part.targetMinutes)} scenes, adjusted as pacing requires).`
    : "";
  let contents = isOnlyPart
    ? `Here is the film's Bit Sheet — its major plot-point beats, already verified, in order:\n${bitSheetOutlineText(bitSheet.bits)}\n${targetLine}\n\nExpand this Bit Sheet into a full scene-by-scene list for the entire film — each bit typically becomes 1-3 scenes — whose scenes' combined "estimatedMinutes" add up to approximately the target runtime given above. Return "scenes": a single array covering the whole film.`
    : `Here is the film's whole Bit Sheet — its major plot-point beats, already verified, in order:\n${bitSheetOutlineText(bitSheet.bits)}\n\nThe film's scene list is being written in ${partCount} parts, in story order. This is PART ${partIndex + 1} of ${partCount}: write scenes ONLY for bits ${part.start + 1} to ${part.end} above — each bit typically becomes 1-3 scenes. Do not write any scene for a bit outside that range; earlier and later bits are written in their own parts.\n${targetLine} The scenes' combined "estimatedMinutes" should add up to approximately that. Return "scenes": the array for this part only.`;

  if (scenesSoFar.length > 0) {
    const lastScenes = scenesSoFar
      .slice(-3)
      .map((scene) => `- ${scene.sceneNumber ? `[${scene.sceneNumber}] ` : ""}${scene.intExt}. ${scene.location.en} — ${scene.timeOfDay}: ${scene.oneLiner.en}`)
      .join("\n");
    const placesSoFar = [...new Set(scenesSoFar.map((scene) => scene.location.en))].join("; ");
    contents += `\n\nThe last scenes already written, just before this part — carry straight on from them, never repeat them:\n${lastScenes}\n\nPlaces already used in the film (when the story returns to one of these, use exactly the same name; new places are fine wherever the story needs them): ${placesSoFar}\n\nContinue the scene numbering from the last scene above in the same style.`;
  }

  contents += `\n\n${NO_BUDGET_LIMIT_INSTRUCTION}`;

  if (bitSheet.controllingIdea) {
    contents += `\n\nThe story's Controlling Idea (theme) is: "${bitSheet.controllingIdea.en}" — keep scenes true to it.`;
  }

  if (revision) {
    contents += `\n\nThis is a REVISION of a previous scene list. The Screenplay Writer reviewed it and requested changes.\nFeedback: "${revision.feedback}"\n${revision.previous?.scenes ? `${previousDraftForRevision({ scenes: revision.previous.scenes }, [], revision.fresh)}\n${partCount > 1 ? "(That is the whole film's previous list; write only this part's scenes.)\n" : ""}` : ""}Revise the scene list to address this feedback directly, keeping the same overall structure otherwise.`;
  }

  let content = await callSceneListGemini(contents, false, part.targetMinutes);
  content = annotateSceneListTotals(content, false, null, part.targetMinutes);

  // If the estimated total is far from the target runtime, give the model one
  // chance to correct itself — capped at a single retry so a persistently
  // stubborn response can't burn through the daily API quota.
  if (sceneListNeedsRetry(content)) {
    const correctionNote = buildRetryCorrectionNote(content);
    content = await callSceneListGemini(contents + correctionNote, false, part.targetMinutes);
  }
  return content.scenes ?? [];
}

async function generateSceneListContent(bitSheet, deck, revision) {
  const isVerticalDrama = deck.format?.type === "vertical";
  const isSeries =
    (deck.format?.type === "series" || isVerticalDrama) &&
    Array.isArray(deck.episodes) &&
    Array.isArray(bitSheet.episodeBits);

  const episodeTargetMinutes = isSeries ? deck.format.episodeMinutes ?? null : null;
  const filmTargetMinutes = !isSeries ? deck.format?.runtimeMinutes ?? null : null;

  if (isSeries) {
    const chunkStarts = [];
    for (let i = 0; i < deck.episodes.length; i += SCENE_LIST_EPISODE_BATCH_SIZE) chunkStarts.push(i);

    const episodeScenesChunks = new Array(chunkStarts.length);
    let lockedLocations = null;
    let remainingStarts = chunkStarts;

    // Same real, observed overshoot failure as the other stages' episode
    // batches — no revision loop here either, so it's trimmed before
    // assertEpisodeCount ever gets a chance to hard-fail the whole run.
    const enforceCount = (batch, expectedCount) => (batch.length > expectedCount ? batch.slice(0, expectedCount) : batch);

    if (isVerticalDrama) {
      // The first batch runs alone to establish the fixed location set that
      // every later batch must then reuse verbatim.
      const firstStart = chunkStarts[0];
      const firstChunk = deck.episodes.slice(firstStart, firstStart + SCENE_LIST_EPISODE_BATCH_SIZE);
      const firstScenes = enforceCount(
        await generateSceneListEpisodeBatch(
          deck, bitSheet, firstChunk, firstStart, episodeTargetMinutes, isVerticalDrama, null, revision
        ),
        Math.min(SCENE_LIST_EPISODE_BATCH_SIZE, deck.episodes.length - firstStart)
      );
      episodeScenesChunks[0] = firstScenes;
      lockedLocations = [...new Set(firstScenes.flatMap((es) => es.scenes.map((s) => s.location.en)))];
      remainingStarts = chunkStarts.slice(1);
    }

    const remainingResults = await mapWithConcurrency(remainingStarts, 3, async (start) => {
      const episodesChunk = deck.episodes.slice(start, start + SCENE_LIST_EPISODE_BATCH_SIZE);
      const batch = await generateSceneListEpisodeBatch(
        deck, bitSheet, episodesChunk, start, episodeTargetMinutes, isVerticalDrama, lockedLocations, revision
      );
      return enforceCount(batch, Math.min(SCENE_LIST_EPISODE_BATCH_SIZE, deck.episodes.length - start));
    });
    remainingStarts.forEach((start, i) => {
      episodeScenesChunks[chunkStarts.indexOf(start)] = remainingResults[i];
    });

    let episodeScenes = episodeScenesChunks.flat();
    // Same undershoot gap as the other batched stages (see their comments).
    if (episodeScenes.length < deck.episodes.length) {
      const shortfall = deck.episodes.length - episodeScenes.length;
      const topUp = await generateSceneListEpisodeBatch(
        deck,
        bitSheet,
        deck.episodes.slice(episodeScenes.length, episodeScenes.length + shortfall),
        episodeScenes.length,
        episodeTargetMinutes,
        isVerticalDrama,
        lockedLocations,
        revision
      );
      episodeScenes = episodeScenes.concat(enforceCount(topUp, shortfall));
    }

    let content = { episodeScenes };
    content = annotateSceneListTotals(content, true, episodeTargetMinutes, null);
    return bitSheet.controllingIdea ? { ...content, controllingIdea: bitSheet.controllingIdea } : content;
  }

  const parts = splitFilmBitsIntoParts(bitSheet.bits, filmTargetMinutes);
  let scenes = [];
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex];
    const partScenes = await generateFilmSceneListPart(bitSheet, part, partIndex, parts.length, filmTargetMinutes, scenes, revision);
    scenes = scenes.concat(partScenes);
  }
  // Written in parts, each part numbered its scenes slightly differently
  // (seen for real: "1.17", then "2.01", then "3.1") -- renumber the joined
  // list one way: act.scene, counting from 1 inside each act.
  if (parts.length > 1) {
    const countPerAct = {};
    scenes = scenes.map((scene) => {
      const act = scene.actNumber || 1;
      countPerAct[act] = (countPerAct[act] ?? 0) + 1;
      return { ...scene, sceneNumber: `${act}.${countPerAct[act]}` };
    });
  }
  const content = annotateSceneListTotals({ scenes }, false, null, filmTargetMinutes);

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

// Scenes written before dialogue language became a per-scene choice stored
// text as a {en, or, hi} bilingual object, not a plain string — reading
// those old rows as if text were already a string just stringifies the
// object ("[object Object]") into whatever prompt consumes it. This reads
// either shape.
function screenplayElementText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return value.en ?? value.or ?? value.hi ?? "";
  return "";
}

function elementsToPlainText(elements) {
  return elements
    .map((element) => {
      const text = screenplayElementText(element.text);
      return element.type === "dialogue" ? `${element.character}: ${text}` : text;
    })
    .join("\n");
}

// Screenplay elements are now plain strings (see SCREENPLAY_ELEMENT_SCHEMA),
// not {en,or,hi} objects, so sanitizeBilingualContent's key-based cleaning
// doesn't apply — this strips stray foreign-script characters using the
// element's OWN language instead: action/transition/flashback text is always
// English, while dialogue/parenthetical follow the scene's dialogueLanguage.
// A slugline the model sometimes writes as its own first line (e.g. "INT.
// KITCHEN - NIGHT") even though the app always renders the scene heading
// itself — left in, it shows up as a visible duplicate heading (once in the
// model's own casing, once in the app's own ALL-CAPS render) in the exported
// script. The base prompt now tells the model not to do this; this is the
// defensive backstop for whenever it does anyway.
const SLUGLINE_REGEX = /^\s*(INT|EXT)\b/i;

function sanitizeScreenplayElements(elements, dialogueLanguage) {
  const dialogueRegex =
    dialogueLanguage === "or" ? FOREIGN_SCRIPT_REGEX : dialogueLanguage === "hi" ? HI_FOREIGN_SCRIPT_REGEX : EN_FOREIGN_SCRIPT_REGEX;
  const clean = (text, regex) => (typeof text === "string" ? text.replace(regex, "").replace(/ {2,}/g, " ").trim() : text);

  const cleaned = (elements ?? []).map((element) => {
    const isDialogue = element.type === "dialogue";
    // An acting note written at the start of the spoken line ("(a bit
    // defensively) କ'ଣ କହୁଛୁ...", seen for real) moves to the acting-note
    // slot, so it prints as a parenthetical and is never read out.
    if (isDialogue && typeof element.text === "string") {
      const note = element.text.match(/^\s*\(([^()]{1,80})\)\s*/);
      if (note && element.text.slice(note[0].length).trim()) {
        element = {
          ...element,
          parenthetical: element.parenthetical?.trim() ? element.parenthetical : note[1].trim(),
          text: element.text.slice(note[0].length),
        };
      }
    }
    return {
      ...element,
      text: clean(element.text, isDialogue ? dialogueRegex : EN_FOREIGN_SCRIPT_REGEX),
      parenthetical: element.parenthetical != null ? clean(element.parenthetical, dialogueRegex) : element.parenthetical,
    };
  });

  if (cleaned.length > 0 && cleaned[0].type !== "dialogue" && SLUGLINE_REGEX.test(cleaned[0].text ?? "")) {
    cleaned.shift();
  }

  // Same two safety fixes as AI Movie: a line typed straight into an
  // action paragraph ("KALIA\n(softly)\nAma, the bell...") becomes a real
  // dialogue element, and a dialogue element with no words is dropped
  // (it would print as an empty speech).
  return cleaned
    .map((element) => {
      if (element.type !== "action" || typeof element.text !== "string") return element;
      const lines = element.text.split("\n").map((line) => line.trim()).filter(Boolean);
      const cue = lines.length >= 2 && lines[0].match(/^([A-Z][A-Z0-9 .'-]{0,30}?)(?:\s*\((V\.O\.|O\.S\.)\))?$/);
      if (!cue || AI_MOVIE_NOT_A_CUE.test(cue[1])) return element;
      const hasNote = lines.length >= 3 && /^\(.*\)$/.test(lines[1]);
      return {
        type: "dialogue",
        character: cue[1].trim(),
        characterModifier: cue[2] ?? "none",
        parenthetical: hasNote ? lines[1].replace(/^\(\s*|\s*\)$/g, "") : "",
        text: lines.slice(hasNote ? 2 : 1).join(" "),
      };
    })
    .filter((element) => element.type !== "dialogue" || (typeof element.text === "string" && element.text.trim()));
}

// Builds the full screenplay content — action lines and dialogue — for ONE
// scene at a time, per the agent spec's "scene-by-scene, not the whole film
// at once" instruction. `allScenes` gives the AI the full outline for
// continuity; `previousElements` (the immediately preceding scene's already-
// written content, if any) helps keep character voice consistent scene to
// scene. When `revision` is given, the prompt asks for a rewrite instead.
// `dialogueLanguage` ("en"/"or"/"hi") is a per-scene choice made when the
// Director clicks "Write This Scene" — action lines stay English regardless.
// Standard screenplay format: 1 page ≈ 1 minute of screen time, at roughly
// 200-250 words per page (a natural mix of action description and dialogue,
// in standard Courier 12pt formatting). The previous "aim for N elements"
// heuristic (elements = estimatedMinutes * 5) didn't map to this convention
// at all and reliably under-shot real page length — a 3-minute scene needs
// ~3-4 pages / ~700-800 words of actual content, not just a handful of short
// lines. wordsPerElementText only counts "text" fields (the actual page
// content), never the "character" name field.
function suggestScreenplayWordCount(estimatedMinutes) {
  const pages = Math.max(0.5, estimatedMinutes);
  return Math.round(pages * 225);
}

function countScreenplayWords(elements) {
  return elements.reduce((total, element) => {
    const text = typeof element.text === "string" ? element.text : "";
    const parenthetical = typeof element.parenthetical === "string" ? element.parenthetical : "";
    return total + `${text} ${parenthetical}`.trim().split(/\s+/).filter(Boolean).length;
  }, 0);
}

// Joins just the action/flashback description text of a scene (never
// dialogue — characters repeating a catchphrase is normal, generic stock
// gestures reused in every scene's ACTION lines is the actual problem the
// external reviews flagged, e.g. "marble floor" turning up 46 times).
function collectActionText(elements) {
  return (elements ?? [])
    .filter((element) => element.type === "action" || element.type === "flashback")
    .map((element) => element.text || "")
    .join(" ");
}

// 3- and 4-word phrases, lowercased and stripped of punctuation — coarse but
// cheap (pure string processing, no AI call) and good enough to catch the
// kind of reused stock description a full read-through would notice.
function actionPhraseNgrams(text) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const ngrams = [];
  for (const n of [3, 4]) {
    for (let i = 0; i + n <= words.length; i++) {
      ngrams.push(words.slice(i, i + n).join(" "));
    }
  }
  return ngrams;
}

// Tracks how often each description phrase has been used so far in one
// auto-pipeline run, so (a) new scenes can be told which phrases to avoid
// reusing, and (b) the final quality pass can point at exactly which ones
// became overused across the finished script.
function createPhraseTracker() {
  const counts = new Map();
  return {
    counts,
    recordText(text) {
      for (const gram of actionPhraseNgrams(text)) {
        counts.set(gram, (counts.get(gram) ?? 0) + 1);
      }
    },
    recordElements(elements) {
      this.recordText(collectActionText(elements));
    },
    topOverused(limit = 10, minCount = 2) {
      return [...counts.entries()]
        .filter(([, count]) => count >= minCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([phrase]) => phrase);
    },
  };
}

// Reviewer (deterministic, not AI, and — unlike the sampled dialogue-
// authenticity reviewer below — run once against the ENTIRE finished
// screenplay rather than a handful of scenes, since cross-episode repetition
// is exactly the kind of pattern a per-scene sample structurally can't see.
function reviewScreenplayRepetition(sceneRows) {
  const tracker = createPhraseTracker();
  const perScene = sceneRows.map((row) => {
    const text = collectActionText(row.content?.elements);
    tracker.recordText(text);
    return { row, text: text.toLowerCase() };
  });

  // Scales with script size — a 6-scene short shouldn't need the same
  // tolerance as a 50-episode series with hundreds of scenes.
  const threshold = Math.max(4, Math.round(sceneRows.length * 0.08));
  const overusedPhrases = tracker.topOverused(12, threshold);

  if (overusedPhrases.length === 0) {
    return { needsRevision: false, issues: [], overusedPhrases: [], offendingScenes: [] };
  }

  const offendingScenes = perScene
    .filter(({ text }) => overusedPhrases.some((phrase) => text.includes(phrase)))
    .map(({ row }) => row);

  const issues = overusedPhrases.map(
    (phrase) => `The description "${phrase}" is reused ${tracker.counts.get(phrase)} times across the screenplay — too repetitive, needs varied phrasing.`
  );

  return { needsRevision: true, issues, overusedPhrases, offendingScenes };
}

async function generateScreenplaySceneContent(deck, allScenes, sceneIndex, previousElements, controllingIdea, revision, dialogueLanguage, avoidPhrases) {
  const targetScene = allScenes[sceneIndex];
  const outlineText = allScenes.map((scene, index) => sceneOutlineLine(scene, index)).join("\n");
  const suggestedWords = suggestScreenplayWordCount(targetScene.estimatedMinutes);

  let contents = `Story title: ${deck.title.en}\nLogline: ${deck.logline.en}\nTone/Genre: ${deck.toneGenre.en}\n\nFull scene outline for context (already established elsewhere — do not rewrite these, just stay consistent with them):\n${outlineText}\n\nNow write the FULL screenplay content — action lines and dialogue — for ONLY this one scene:\n${sceneOutlineLine(targetScene, sceneIndex)}\n\nThis scene is estimated at ${targetScene.estimatedMinutes} minute(s) of screen time. STANDARD SCREENPLAY FORMAT RULE: one page equals roughly one minute of screen time, at roughly 200-250 words of combined action and dialogue per page — so this scene needs to read as approximately ${targetScene.estimatedMinutes} page(s), meaning roughly ${suggestedWords} words total across all its action lines and dialogue combined. This is a hard length target, not a rough suggestion: write enough real action description and full dialogue exchanges — including natural back-and-forth, reactions, and beats — to genuinely fill that length. Never compress a multi-minute scene into just a couple of short lines regardless of how simple the one-liner sounds.`;

  if (controllingIdea) {
    contents += `\n\nThe story's Controlling Idea (theme) is: "${controllingIdea.en}" — let the dialogue and action reflect it where natural, without stating it outright.`;
  }

  if (previousElements) {
    contents += `\n\nHere is the immediately PRECEDING scene's screenplay content, for character voice and continuity:\n${elementsToPlainText(previousElements)}`;
  }

  if (revision) {
    contents += `\n\nThis is a REVISION of a previous draft of this scene. The Screenplay Writer reviewed it and requested changes.\nPrevious draft:\n${elementsToPlainText(revision.previous.elements)}\nFeedback: "${revision.feedback}"\nRevise the scene to address the feedback directly.`;
  }

  if (avoidPhrases?.length > 0) {
    contents += `\n\nDescriptive phrases already overused earlier in this same story — do NOT reuse these or close variants, find a fresh, specific way to convey the same beat:\n${avoidPhrases.join(", ")}`;
  }

  async function callGemini(promptContents) {
    const parsed = await generateJsonContent({
      // Gemini 2.5 Flash, same as AI Movie's screenplay writer (the user's
      // call): it follows the long dialogue-craft rules far better than
      // Flash-Lite. It "thinks" before answering, and that thinking counts
      // against the output ceiling, hence the extra headroom (more again
      // for Odia/Hindi, which take far more tokens per word) -- only a
      // ceiling, a call costs what it actually uses.
      model: AI_MOVIE_SCREENPLAY_WRITER_MODEL_NAME,
      contents: promptContents,
      config: {
        systemInstruction: buildScreenplaySystemPrompt(dialogueLanguage),
        responseMimeType: "application/json",
        maxOutputTokens: Math.min(MAX_GEMINI_OUTPUT_TOKENS, Math.max(24576, suggestedWords * 12)),
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            elements: { type: Type.ARRAY, items: SCREENPLAY_ELEMENT_SCHEMA },
            charactersPresent: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ["elements", "charactersPresent"],
        },
      },
    });
    return {
      elements: sanitizeScreenplayElements(parsed.elements, dialogueLanguage),
      charactersPresent: Array.isArray(parsed.charactersPresent) ? parsed.charactersPresent : [],
    };
  }

  let { elements, charactersPresent } = await callGemini(contents);

  // If the model under-shot the page-length target badly, give it one
  // chance to expand — capped at a single retry, same discipline as the
  // scene list's runtime-correction retry.
  const actualWords = countScreenplayWords(elements);
  if (actualWords < suggestedWords * 0.7) {
    const correctionNote = `\n\nIMPORTANT CORRECTION NEEDED: your draft only came to about ${actualWords} words, but a ${targetScene.estimatedMinutes}-minute scene needs roughly ${suggestedWords} words to fill its standard-format page length (1 page ≈ 1 minute). Rewrite the scene with substantially more action description and fuller dialogue exchanges — more back-and-forth, more beats — to genuinely reach that length, not just pad existing lines.`;
    ({ elements, charactersPresent } = await callGemini(contents + correctionNote));
  }

  return { elements, charactersPresent, dialogueLanguage };
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
  const { sceneListId, episodeIndex, sceneIndex, dialogueLanguage: rawDialogueLanguage } = req.body;
  const hasEpisode = episodeIndex !== null && episodeIndex !== undefined;
  const dialogueLanguage = ["en", "hi"].includes(rawDialogueLanguage) ? rawDialogueLanguage : "or";

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
      context.scene_list_content.controllingIdea,
      undefined,
      dialogueLanguage
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

// ---------------------------------------------------------------------
// Movie: typing straight into the script + Submit, and "Check full
// script" -- the same two tools AI Movie has, adapted to Movie's scenes:
// action lines are always English, dialogue (and acting notes) are in the
// scene's own dialogue language (English / Odia / Hindi), one language
// per scene. The corrector judges the dialogue by Movie's OWN language
// rules (SCREENPLAY_DIALOGUE_CRAFT -- e.g. Odia and Hindi loanwords in
// the local script), not AI Movie's. As in AI Movie, the AI only returns
// corrected text for numbered pieces and the scene is rebuilt in code
// from the writer's own elements, so no line can be lost or added. Every
// change is saved as a new version of the scene, like Request Changes.
const MOVIE_LANGUAGE_NAMES = { en: "English", or: "Odia", hi: "Hindi" };

function buildMovieScriptCorrectorPrompt(dialogueLanguage) {
  const languageName = MOVIE_LANGUAGE_NAMES[dialogueLanguage] ?? "English";
  return `You are a careful script editor on a film screenplay. You CORRECT the text you are given — you never rewrite it.

1. Fix spelling, grammar and punctuation.
2. ACTION lines are always simple, natural English. Any part of an action line written in another language (Odia, Hindi, or romanized Indian languages) must be translated into English with the same meaning.
3. DIALOGUE lines and ACTING NOTES are in ${languageName}. Any part written in another language, or written with English letters (romanized ${languageName}), must become proper ${languageName} in its own script with the same meaning — except a minor character the story clearly marks as speaking another language, whose line stays as it is.${dialogueLanguage === "en" ? "" : `
   No English letters may be left in a ${languageName} dialogue line or acting note. An English word the character would really say (like "phone" or "seriously") can stay as that English word, but spelled out in ${languageName} script — never in English letters.`}
4. Judge what correct, natural ${languageName} dialogue looks like by the writer's own dialogue style guide below — use it ONLY to spot real mistakes; never rewrite a line that is already fine.
5. Keep everything else exactly as it is: the same events, lines, meaning, order and characters. Do not add or remove anything, and do not improve the style, the wording or the drama.
6. "fixes": a short list, in simple English, of what you corrected.

THE WRITER'S DIALOGUE STYLE GUIDE:
${SCREENPLAY_DIALOGUE_CRAFT[dialogueLanguage] ?? SCREENPLAY_DIALOGUE_CRAFT.en}`;
}

// Numbered pieces of one or more scenes: every action line, dialogue
// line and acting note.
function movieScriptPieces(scenes) {
  const pieces = [];
  scenes.forEach((scene, sceneIndex) => {
    let count = 0;
    (scene.elements ?? []).forEach((element, elementIndex) => {
      const id = () => `S${sceneIndex + 1}.${++count}`;
      if (element.type === "dialogue") {
        if (element.text?.trim()) pieces.push({ id: id(), sceneIndex, elementIndex, field: "text", label: `DIALOGUE line of ${element.character}`, value: element.text });
        if (element.parenthetical?.trim()) pieces.push({ id: id(), sceneIndex, elementIndex, field: "parenthetical", label: `ACTING NOTE of ${element.character}`, value: element.parenthetical });
      } else if (element.type === "action" || element.type === "flashback") {
        if (element.text?.trim()) pieces.push({ id: id(), sceneIndex, elementIndex, field: "text", label: "ACTION", value: element.text });
      }
    });
  });
  return pieces;
}

async function generateMovieScriptCorrections(scenes, dialogueLanguage, characterNames) {
  const pieces = movieScriptPieces(scenes);
  if (pieces.length === 0) return { pieces, corrections: new Map(), fixes: [] };
  const text = scenes
    .map((scene, sceneIndex) => {
      const own = pieces.filter((p) => p.sceneIndex === sceneIndex);
      return `SCENE ${sceneIndex + 1}${scene.heading ? ` — ${scene.heading}` : ""}\n${own.map((p) => `[${p.id}] ${p.label}: ${p.value}`).join("\n")}`;
    })
    .join("\n\n");
  const result = await generateJsonContent({
    model: AI_MOVIE_DIALOGUE_MODEL_NAME,
    contents: `The story's characters (spell their names exactly like this): ${characterNames.join(", ") || "(none listed)"}.\n\n${text}\n\nReturn "corrections": one entry for each piece that needed a correction, with its exact id and the corrected text. Leave out pieces that are already correct.`,
    config: {
      systemInstruction: buildMovieScriptCorrectorPrompt(dialogueLanguage),
      responseMimeType: "application/json",
      maxOutputTokens: 32768,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          corrections: {
            type: Type.ARRAY,
            items: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, text: { type: Type.STRING } }, required: ["id", "text"] },
          },
          fixes: {
            type: Type.ARRAY,
            items: { type: Type.OBJECT, properties: { scene: { type: Type.NUMBER }, fix: { type: Type.STRING } }, required: ["scene", "fix"] },
          },
        },
        required: ["corrections", "fixes"],
      },
    },
  });
  const corrections = new Map(
    (Array.isArray(result.corrections) ? result.corrections : [])
      .filter((c) => typeof c?.id === "string" && typeof c.text === "string" && c.text.trim())
      .map((c) => [c.id.trim(), c.text])
  );
  const fixes = (Array.isArray(result.fixes) ? result.fixes : []).filter((f) => typeof f?.fix === "string" && f.fix.trim());
  return { pieces, corrections, fixes };
}

// Applies the corrections to copies of the scenes' elements; returns the
// new elements per scene and how many pieces changed in each.
function applyMovieScriptCorrections(scenes, pieces, corrections) {
  const elementsByScene = scenes.map((scene) => (scene.elements ?? []).map((element) => ({ ...element })));
  const changedByScene = scenes.map(() => 0);
  for (const piece of pieces) {
    const corrected = corrections.get(piece.id);
    if (typeof corrected !== "string" || corrected === piece.value) continue;
    elementsByScene[piece.sceneIndex][piece.elementIndex][piece.field] = corrected;
    changedByScene[piece.sceneIndex]++;
  }
  return { elementsByScene, changedByScene };
}

async function movieCharacterNamesForSceneList(sceneListId) {
  const result = await db.query(
    `SELECT cs.content FROM scene_lists sl
     JOIN bit_sheets bs ON bs.id = sl.bit_sheet_id
     JOIN three_act_structures tas ON tas.id = bs.three_act_structure_id
     JOIN character_sheets cs ON cs.pitch_deck_id = tas.pitch_deck_id
     WHERE sl.id = $1 ORDER BY cs.created_at DESC LIMIT 1`,
    [sceneListId]
  );
  const characters = result.rows[0]?.content?.characters ?? [];
  return characters.map((c) => (typeof c?.name === "string" ? c.name : c?.name?.en)).filter(Boolean);
}

// The elements as the screen sends them after typing: plain strings.
function cleanMovieEditedElements(elements) {
  if (!Array.isArray(elements)) return [];
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const modifiers = ["none", "CONT'D", "O.S.", "V.O.", "ECHOING"];
  return elements
    .map((element) => {
      const type = ["action", "dialogue", "transition", "flashback"].includes(element?.type) ? element.type : "action";
      const cleaned = { type, character: text(element?.character).toUpperCase(), text: text(element?.text) };
      if (type === "dialogue") {
        cleaned.characterModifier = modifiers.includes(element?.characterModifier) ? element.characterModifier : "none";
        cleaned.parenthetical = text(element?.parenthetical).replace(/^\(\s*|\s*\)$/g, "");
        return cleaned.character && cleaned.text ? cleaned : null;
      }
      return cleaned.text ? cleaned : null;
    })
    .filter(Boolean)
    .slice(0, 300);
}

async function insertMovieScreenplayVersion(previousRow, elements, extra = {}) {
  const content = { ...previousRow.content, elements, ...extra };
  const inserted = await db.query(
    "INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content) VALUES ($1, $2, $3, $4) RETURNING id, episode_index, scene_index, status, feedback, created_at",
    [previousRow.scene_list_id, previousRow.episode_index, previousRow.scene_index, JSON.stringify(content)]
  );
  const row = inserted.rows[0];
  return { id: row.id, episodeIndex: row.episode_index, sceneIndex: row.scene_index, status: row.status, feedback: row.feedback, createdAt: row.created_at, ...content };
}

app.post("/api/screenplay/scene/:id/edit", requireRole("admin"), async (req, res) => {
  const elements = cleanMovieEditedElements(req.body.elements);
  if (elements.length === 0) {
    res.status(400).json({ error: "The scene is empty -- write at least one line before submitting." });
    return;
  }
  const existing = await db.query("SELECT id, scene_list_id, episode_index, scene_index, content FROM screenplay_scenes WHERE id = $1", [req.params.id]);
  const previousRow = existing.rows[0];
  if (!previousRow) {
    res.status(404).json({ error: "Screenplay scene not found" });
    return;
  }
  try {
    const dialogueLanguage = ["en", "or", "hi"].includes(previousRow.content?.dialogueLanguage) ? previousRow.content.dialogueLanguage : "en";
    const characterNames = await movieCharacterNamesForSceneList(previousRow.scene_list_id);
    const scenes = [{ elements }];
    const { pieces, corrections, fixes } = await generateMovieScriptCorrections(scenes, dialogueLanguage, characterNames);
    const { elementsByScene } = applyMovieScriptCorrections(scenes, pieces, corrections);
    const saved = await insertMovieScreenplayVersion(previousRow, sanitizeScreenplayElements(elementsByScene[0], dialogueLanguage), { editedByUser: true });
    res.json({ scene: saved, fixes: fixes.map((f) => f.fix) });
  } catch (error) {
    console.error(`Movie screenplay scene ${req.params.id} edit failed:`, error.message);
    res.status(502).json({ error: error.message });
  }
});

// Full script check: in the background, a few scenes per AI call, grouped
// by dialogue language. Progress and the report are kept in memory (a
// server restart clears them; every scene already corrected stays saved,
// and running it again simply finds little left to fix).
const movieScriptChecks = new Map();
const MOVIE_SCRIPT_CHECK_BATCH = 4;

async function runMovieScriptCheck(sceneListId, state) {
  try {
    const rows = (
      await db.query(
        `SELECT DISTINCT ON (episode_index, scene_index) id, scene_list_id, episode_index, scene_index, content
         FROM screenplay_scenes WHERE scene_list_id = $1 ORDER BY episode_index, scene_index, created_at DESC`,
        [sceneListId]
      )
    ).rows.filter((row) => Array.isArray(row.content?.elements) && row.content.elements.length > 0);
    const characterNames = await movieCharacterNamesForSceneList(sceneListId);
    const batches = [];
    for (const language of ["en", "or", "hi"]) {
      const ofLanguage = rows.filter((row) => (row.content?.dialogueLanguage ?? "en") === language);
      for (let i = 0; i < ofLanguage.length; i += MOVIE_SCRIPT_CHECK_BATCH) batches.push({ language, rows: ofLanguage.slice(i, i + MOVIE_SCRIPT_CHECK_BATCH) });
    }
    state.totalScenes = rows.length;
    for (const batch of batches) {
      const scenes = batch.rows.map((row) => ({ elements: row.content.elements }));
      try {
        const { pieces, corrections, fixes } = await generateMovieScriptCorrections(scenes, batch.language, characterNames);
        const { elementsByScene, changedByScene } = applyMovieScriptCorrections(scenes, pieces, corrections);
        for (let i = 0; i < batch.rows.length; i++) {
          const row = batch.rows[i];
          if (changedByScene[i] > 0) await insertMovieScreenplayVersion(row, sanitizeScreenplayElements(elementsByScene[i], batch.language));
          state.report.push({
            episodeIndex: row.episode_index,
            sceneIndex: row.scene_index,
            changed: changedByScene[i],
            fixes: fixes.filter((f) => Math.round(Number(f.scene)) === i + 1).map((f) => f.fix),
          });
        }
      } catch (error) {
        console.error("Movie full script check: a batch failed:", error.message);
        for (const row of batch.rows) state.report.push({ episodeIndex: row.episode_index, sceneIndex: row.scene_index, changed: 0, fixes: [], error: true });
      }
      state.doneScenes += batch.rows.length;
    }
    state.status = "done";
    state.finishedAt = new Date().toISOString();
  } catch (error) {
    console.error("Movie full script check stopped:", error.message);
    state.status = "error";
    state.error = error.message;
  }
}

app.post("/api/scene-lists/:id/script-check", requireRole("admin"), async (req, res) => {
  const sceneListId = Number(req.params.id);
  if (movieScriptChecks.get(sceneListId)?.status === "running") {
    res.json({ started: false, alreadyRunning: true });
    return;
  }
  const state = { status: "running", startedAt: new Date().toISOString(), totalScenes: 0, doneScenes: 0, report: [] };
  movieScriptChecks.set(sceneListId, state);
  runMovieScriptCheck(sceneListId, state);
  res.json({ started: true });
});

app.get("/api/scene-lists/:id/script-check", requireLogin, (req, res) => {
  res.json(movieScriptChecks.get(Number(req.params.id)) ?? { status: "none" });
});

// Production's script breakdown is built from the written scenes -- so a
// scene edited (or corrected by the full check) after the breakdown was
// made leaves the breakdown out of date. The screen asks this and shows
// a plain note rather than letting the two drift apart silently.
app.get("/api/scene-lists/:id/breakdown-freshness", requireLogin, async (req, res) => {
  const result = await db.query(
    `SELECT (SELECT max(created_at) FROM script_breakdowns WHERE scene_list_id = $1) AS breakdown_at,
            (SELECT max(created_at) FROM screenplay_scenes WHERE scene_list_id = $1) AS script_at`,
    [req.params.id]
  );
  const { breakdown_at: breakdownAt, script_at: scriptAt } = result.rows[0] ?? {};
  res.json({ breakdownAt, scriptAt, stale: Boolean(breakdownAt && scriptAt && new Date(scriptAt) > new Date(breakdownAt)) });
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
      { feedback, previous },
      previous.dialogueLanguage ?? "en"
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
          .map((el) => {
            const text = screenplayElementText(el.text);
            return el.type === "dialogue" ? `${el.character}: ${text}` : text;
          })
          .join("\n");
        return `Scene ${row.scene_index + 1}:\n${body}`;
      })
      .join("\n\n");
  }

  return flattenScenesForScheduling(sceneList);
}

// One category at a time across the WHOLE script, not all 5 in one call.
// A real 166KB/13-episode script proved this matters: asking for all 5
// categories together (90+ scenes' worth of artists/locations/props/
// costumes/art, each with trilingual notes) produced a response that hit
// the MODEL's own actual output ceiling — not a maxOutputTokens config
// value (already left uncapped), an intrinsic limit — and got cut off
// mid-string on every one of 4 retry attempts in a row, since a retry
// asks for the exact same amount of content and hits the same wall again.
// One category's worth of content comfortably fits well under that
// ceiling on its own.
async function generateScriptBreakdownContent(sourceText, revision) {
  const results = await mapWithConcurrency(BREAKDOWN_CATEGORY_KEYS, 1, async (category) => {
    let contents = `The script material:\n${sourceText}\n\nProduce the "${category}" list — ${BREAKDOWN_CATEGORY_DESCRIPTIONS[category]}. Be thorough but only include things actually implied by the material.`;
    if (revision) {
      contents += `\n\nThis is a REVISION of a previous breakdown. Feedback: "${revision.feedback}"\nRevise this category's list to address the feedback directly, where relevant.`;
    }

    const parsed = await generateJsonContent({
      model: GEMINI_MODEL_NAME,
      contents,
      config: {
        systemInstruction: SCRIPT_BREAKDOWN_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: { [category]: { type: Type.ARRAY, items: BREAKDOWN_CATEGORY_ITEM_SCHEMAS[category] } },
          required: [category],
        },
      },
    });
    return [category, parsed[category]];
  });

  return sanitizeBilingualContent(Object.fromEntries(results));
}

// Runs the initial breakdown, then immediately re-verifies every category
// against the full script the same way the manual "reanalyze" button does —
// each category gets its own focused re-read rather than trusting the single
// combined first pass, since a breakdown is what the crew orders/books
// against and a missed prop or background artist becomes a real production
// problem later.
async function generateDeepScriptBreakdownContent(sourceText, revision) {
  const firstPass = await generateScriptBreakdownContent(sourceText, revision);

  // Sequential across categories, not concurrent — each category call below
  // now runs its OWN concurrent batch of per-episode chunk calls (see
  // generateBreakdownCategoryContent), so running 3 categories at once here
  // too would stack up to 9 simultaneous Gemini calls. Still backed by the
  // same safety net: generateContentWithRetry retries a transient 429/503
  // (or a stalled call, via the timeout) automatically, and a genuinely
  // persistent failure on ONE category just keeps that category's
  // first-pass result instead of losing the other four along with it.
  const refinedEntries = await mapWithConcurrency(BREAKDOWN_CATEGORY_KEYS, 1, async (category) => {
    try {
      const refreshed = await generateBreakdownCategoryContent(sourceText, category, firstPass[category]);
      return [category, refreshed];
    } catch (error) {
      console.error(`Breakdown refinement failed for "${category}", keeping the first-pass result:`, error.message);
      return [category, firstPass[category]];
    }
  });

  const combined = { ...firstPass, ...Object.fromEntries(refinedEntries) };

  // Speaking/non-speaking + Lead/Sidekick/Extra, run as part of every fresh
  // analysis rather than requiring a separate "Classify Cast Categories"
  // click afterward — a real cast list only showed Extra/Non-Speaking
  // because this step was previously a manual, easy-to-miss follow-up.
  const withCastTiers = { ...combined, artistList: await classifyCastCategories(sourceText, combined.artistList ?? []) };

  // Tags every item in every category with which episode(s) it appears in
  // (episode-level only, not exact scenes — see classifyEpisodeNumbers for
  // why). Runs after refinement/cast-tiering so it sees the final lists.
  return await classifyEpisodeNumbers(sourceText, withCastTiers);
}

// The first-ever breakdown on a long script is a first pass PLUS 5
// concurrent per-category refinement calls, each re-sending the whole
// script — easily several minutes for a real feature-length or
// multi-episode script, well past Render's own proxy timeout for a single
// request (a real 166KB/13-episode script reliably hit a 502 here). So
// this responds immediately and does the actual generation in the
// background, exactly like the auto-pipeline's own runAutoPipeline —
// the frontend polls (via the existing /full endpoint) for the new row
// to show up instead of waiting on this one request.
app.post("/api/script-breakdown", requireRole("admin"), async (req, res) => {
  const { sceneListId } = req.body;

  const sceneListResult = await db.query("SELECT content, status FROM scene_lists WHERE id = $1", [sceneListId]);

  if (sceneListResult.rows.length === 0) {
    res.status(404).json({ error: "Scene list not found" });
    return;
  }

  if (sceneListResult.rows[0].status !== "approved") {
    res.status(400).json({ error: "The scene list must be approved before running a script breakdown." });
    return;
  }

  res.json({ status: "processing" });

  try {
    const sourceText = await buildBreakdownSourceText(sceneListResult.rows[0].content, sceneListId);
    const content = await generateDeepScriptBreakdownContent(sourceText);

    await db.query("INSERT INTO script_breakdowns (scene_list_id, content) VALUES ($1, $2)", [sceneListId, JSON.stringify(content)]);
  } catch (error) {
    // Nothing left to respond to (the request already returned above) — the
    // frontend's poll just never finds a new row and eventually gives up.
    // The one exception worth calling out: if the project got deleted (or
    // the scene list changed) while this was still running, this INSERT's
    // own foreign key fails right at the end — expected, not a real error.
    if (error.code !== "23503") {
      console.error("Script breakdown generation failed:", error.message);
    }
  }
});

// Different category schemas key their items differently (a bilingual
// "location" object vs a plain "label"/"character" string) — this is the
// one place that needs to know which, so chunk results can be matched
// against the already-known list without double-counting the same entry.
function breakdownItemKey(category, item) {
  if (category === "locationList") return item?.location?.en?.toLowerCase() ?? "";
  if (category === "costumes") return item?.character?.toLowerCase() ?? "";
  return item?.label?.toLowerCase() ?? "";
}

// Same idea as breakdownItemKey, but the original-case display text — used
// when building a prompt for a human/model to read, never as a lookup key.
function breakdownItemDisplayLabel(category, item) {
  if (category === "locationList") return item?.location?.en ?? "";
  if (category === "costumes") return item?.character ?? "";
  return item?.label ?? "";
}

// Re-checks ONE category against ONE chunk of the script (an episode, when
// the script has episode markers) — additive-only, the same "append what a
// first pass may have missed, never touch or reorder what's already there"
// design as findMissingCharactersInChunk below. A call that only sees one
// chunk can't safely decide an EXISTING entry is wrong (it hasn't seen the
// rest of the script), so it only ever adds newly-found items.
async function generateBreakdownCategoryAdditionsForChunk(chunkText, category, knownKeys) {
  const contents = `The script material (one part of a larger script):\n${chunkText}\n\nThe current "${category}" list from earlier passes over the WHOLE script (do NOT report any of these again, even if they appear here): ${knownKeys.join(", ") || "(none yet)"}\n\nThoroughly re-read this material and identify anything belonging in the "${category}" list that is NOT already in the known list above — ${BREAKDOWN_CATEGORY_DESCRIPTIONS[category]}. Specifically catch anything subtle or easy to miss on a first pass (brief appearances, background mentions, minor items mentioned only once). If nothing new is found in this material, return an empty array.`;

  const parsed = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents,
    config: {
      systemInstruction: SCRIPT_BREAKDOWN_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: { [category]: { type: Type.ARRAY, items: BREAKDOWN_CATEGORY_ITEM_SCHEMAS[category] } },
        required: [category],
      },
    },
  });

  return sanitizeBilingualContent(parsed)[category] ?? [];
}

// Re-checks the script for just ONE category (in case the first pass missed
// something) rather than regenerating the whole breakdown. Used to send the
// WHOLE script in a single call and ask for a fresh COMPLETE list back —
// on a real 166KB/13-episode script, that response (170K+ characters, no
// output cap) reliably got cut off mid-string on every retry attempt,
// producing invalid JSON every time and never actually finishing. Chunked
// by episode instead (same splitter used by findMissingCharacters below),
// so each individual response stays a small fraction of that size, and
// merged additively into the first pass rather than replacing it — a
// per-chunk call only ever adds, so nothing already found gets lost.
async function generateBreakdownCategoryContent(sourceText, category, existingItems) {
  const chunks = splitScreenplayIntoEpisodes(sourceText);
  const textChunks = chunks.length > 1 ? chunks.map((c) => c.text) : [sourceText];
  const knownKeys = (existingItems ?? []).map((item) => breakdownItemKey(category, item)).filter(Boolean);

  const results = await mapWithConcurrency(textChunks, 3, (chunkText) =>
    generateBreakdownCategoryAdditionsForChunk(chunkText, category, knownKeys)
  );

  const seenKeys = new Set(knownKeys);
  const merged = [...(existingItems ?? [])];
  results.flat().forEach((item) => {
    const key = breakdownItemKey(category, item);
    if (!key || seenKeys.has(key)) return;
    seenKeys.add(key);
    merged.push(item);
  });
  return merged;
}

// Additive-only sibling to "Re-analyze" — that button regenerates the
// WHOLE artistList fresh each time, which risks a subtle first-pass catch
// silently vanishing on a later pass. This only ever APPENDS newly found
// characters, never touches or reorders what's already there, so it's
// safe to run at any time without risking already-cast entries.
async function findMissingCharactersInChunk(chunkText, knownLabels) {
  const contents = `The script material (one part of a larger script — the character list below spans the WHOLE script, not just this part):\n${chunkText}\n\nAlready-known characters (do NOT report any of these again, even if they appear here): ${knownLabels.join(", ") || "(none yet)"}\n\nThoroughly re-read this material and identify every character with ANY screen presence who is NOT already in the known list above — including characters who never speak, appear only briefly, or are simply named while physically present in a scene (someone silently dropping something off, a background figure the script gives a real name to, etc.). Do not skip anyone just because their part is small. Exclude only generic, unnamed background people or crowds ("a few guests", "kids playing football", "wedding crowd") — never exclude someone the script actually names. For each character found, give: a short bilingual note on their overall involvement, matching the style of an existing character-list entry; their approximate age (an age or age range as stated or reasonably inferable, e.g. "60s", "Late 20s", "Child, around 8" — "Unspecified" only if genuinely not inferable); and their gender (Male, Female, or Unspecified), inferred confidently from name/pronouns/context rather than defaulted. If none are missing from this material, return an empty array.`;

  const parsed = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents,
    config: {
      systemInstruction: SCRIPT_BREAKDOWN_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: { missingCharacters: { type: Type.ARRAY, items: BREAKDOWN_ARTIST_SCHEMA } },
        required: ["missingCharacters"],
      },
    },
  });

  return sanitizeBilingualContent(parsed).missingCharacters ?? [];
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

  const parsed = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents,
    config: {
      systemInstruction: SCRIPT_BREAKDOWN_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: CAST_CATEGORY_EVIDENCE_SCHEMA,
    },
  });

  return parsed.evidence ?? [];
}

const CAST_TIER_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    tiers: {
      type: Type.ARRAY,
      items: { type: Type.STRING, enum: ["lead", "sidekick", "extra"] },
    },
  },
  required: ["tiers"],
};

// Judges each SPEAKING character's narrative importance across the WHOLE
// script in one call, unlike castCategory's per-episode evidence-gathering
// just below (an independent boolean fact ORed across episodes) — "lead vs
// sidekick vs extra" is a holistic, whole-story judgment that can't be
// decomposed into per-chunk facts, so this reads the full script at once.
// Safe to do in one call even on a large script: the truncation problem
// fixed earlier was about large bilingual LIST outputs (170K+ characters);
// this response is tiny (one word per character).
//
// Positional, not label-matched, and deliberately so: an earlier version
// asked the model to echo each name back alongside its tier and matched by
// that echoed text — on a real 87-character cast list, most names came
// back with zero match (a respelling, dropped honorific, different
// capitalization — any small drift breaks an exact string match at this
// scale), so nearly everyone silently fell back to "extra" with no error
// raised anywhere. Asking for a plain array in the SAME order as the input
// list removes that failure mode entirely — the correspondence is by
// position, not by the model re-typing text correctly.
async function classifyCastTiers(sourceText, speakingLabels) {
  if (speakingLabels.length === 0) return [];

  const numberedList = speakingLabels.map((label, i) => `${i + 1}. ${label}`).join("\n");
  const contents = `The script material:\n${sourceText}\n\nThe speaking characters in this story, numbered:\n${numberedList}\n\nFor EACH numbered character above, judge their overall narrative importance across the WHOLE story:\n- "lead": a backbone/central character the story revolves around (usually just a handful of people).\n- "sidekick": a supporting character who meaningfully drives scenes or the plot forward alongside a lead, without being the story's own center.\n- "extra": a minor speaking character with limited overall impact on the story (a few lines, a small role).\nBase this on their actual weight in the story (how central they are to the plot, screen time, dramatic stakes) — not just how many scenes they technically appear in.\n\nReturn a "tiers" array with EXACTLY ${speakingLabels.length} entries, in the SAME ORDER as the numbered list above (entry 1 = character 1, entry 2 = character 2, and so on) — never skip, merge, or reorder an entry.`;

  const parsed = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents,
    config: {
      systemInstruction: SCRIPT_BREAKDOWN_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: CAST_TIER_SCHEMA,
    },
  });

  const tiers = parsed.tiers ?? [];
  if (tiers.length !== speakingLabels.length) {
    // A misaligned array would silently misassign every character after
    // the point it drifted — safer to report nothing than trust it.
    console.error(`classifyCastTiers: expected ${speakingLabels.length} entries, got ${tiers.length} — discarding this pass.`);
    return [];
  }
  return tiers;
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
// each artistList entry are left untouched — this adds castCategory, then
// (for speaking characters only) castTier — the Lead/Sidekick/Extra
// distinction the casting UI uses to decide who needs individual casting
// versus one shared "Junior Artist Coordinator" slot. Non-speaking
// characters get castTier: null — they're excluded from casting entirely.
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

  const withCastCategory = artistList.map((item) => {
    const key = item.label.toLowerCase();
    const speaks = hasDialogueEver.has(key);
    const present = presentEver.has(key);
    const castCategory = present ? (speaks ? "speaking" : "non_speaking_action") : speaks ? "off_screen" : item.castCategory ?? "speaking";
    return { ...item, castCategory };
  });

  const speakingItems = withCastCategory.filter((item) => item.castCategory === "speaking");
  const tiers = await classifyCastTiers(sourceText, speakingItems.map((item) => item.label));

  // Positional zip against speakingItems (the exact array the labels above
  // were derived from), not a label-text lookup — see classifyCastTiers for
  // why matching by re-typed text silently failed at real cast-list scale.
  const tierByKey = new Map();
  speakingItems.forEach((item, i) => {
    if (tiers[i]) tierByKey.set(item.label.toLowerCase(), tiers[i]);
  });

  return withCastCategory.map((item) => {
    if (item.castCategory !== "speaking") return { ...item, castTier: null };
    const tier = tierByKey.get(item.label.toLowerCase()) ?? item.castTier ?? "extra";
    return { ...item, castTier: tier };
  });
}

const EPISODE_NUMBERS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    episodeNumbers: {
      type: Type.ARRAY,
      items: { type: Type.ARRAY, items: { type: Type.INTEGER } },
    },
  },
  required: ["episodeNumbers"],
};

// Which EPISODE(s) each item of one category appears in — episode-level
// only (not exact scene numbers), per the deliberate choice to keep this
// cheap: getting real scene numbers right would need its own chunked pass
// per category, meaningfully slowing down an already-long analysis for a
// large script. Positional (see classifyCastTiers above for why), one call
// per category rather than mixing all 5 into one prompt, since a nested
// "array of arrays, but only within category boundaries" instruction is
// more error-prone than five simple flat lists.
async function classifyEpisodeNumbersForCategory(sourceText, category, labels) {
  if (labels.length === 0) return [];

  const numberedList = labels.map((label, i) => `${i + 1}. ${label}`).join("\n");
  const contents = `The script material:\n${sourceText}\n\nThe full "${category}" list for this script, numbered:\n${numberedList}\n\nFor EACH numbered item above, list every EPISODE NUMBER (as marked by "EPISODE N" headers in the script) in which it actually appears or is referenced.\n\nReturn an "episodeNumbers" array with EXACTLY ${labels.length} entries, in the SAME ORDER as the numbered list above (entry 1 = item 1, and so on) — never skip, merge, or reorder an entry. Each entry is itself an array of episode numbers, e.g. [2, 3, 4] — use an empty array only if an item genuinely appears nowhere (shouldn't normally happen, since every item comes from the script itself).`;

  const parsed = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents,
    config: {
      systemInstruction: SCRIPT_BREAKDOWN_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: EPISODE_NUMBERS_SCHEMA,
    },
  });

  const result = parsed.episodeNumbers ?? [];
  if (result.length !== labels.length) {
    console.error(`classifyEpisodeNumbersForCategory(${category}): expected ${labels.length} entries, got ${result.length} — discarding this pass.`);
    return [];
  }
  return result;
}

// Runs across all 5 categories, one small call each — but "small" is only
// the RESPONSE; each call below still re-sends the WHOLE sourceText as
// context (same as every other breakdown call), so 3 of these at once hits
// the exact same Vertex AI RESOURCE_EXHAUSTED confirmed elsewhere in this
// file. Sequential, and a category that still fails after retries just
// skips episode-tagging for that one category instead of losing the
// breakdown that's otherwise already complete at this point.
// Skipped entirely for a single-episode film/short
// (splitScreenplayIntoEpisodes returns just one chunk) — there's only ever
// one "episode" there, not worth tagging.
async function classifyEpisodeNumbers(sourceText, breakdownContent) {
  if (splitScreenplayIntoEpisodes(sourceText).length <= 1) return breakdownContent;

  const updated = { ...breakdownContent };
  await mapWithConcurrency(BREAKDOWN_CATEGORY_KEYS, 1, async (category) => {
    const items = breakdownContent[category] ?? [];
    const labels = items.map((item) => breakdownItemDisplayLabel(category, item));
    try {
      const episodeNumbersList = await classifyEpisodeNumbersForCategory(sourceText, category, labels);
      updated[category] = items.map((item, i) => ({
        ...item,
        episodeNumbers: episodeNumbersList[i] ?? item.episodeNumbers ?? [],
      }));
    } catch (error) {
      console.error(`Episode-number tagging failed for "${category}", leaving it untagged:`, error.message);
    }
  });
  return updated;
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

// Turns a chat proposal's explicitSceneRefs (literal labels the AD typed)
// and characterFilters (names the AD mentioned, e.g. "all of Bablu's
// scenes") into a real, deterministic list of affected scenes the AD can
// review before confirming — resolved against the actual scene_list
// content, never trusting the model's own idea of what a scene contains.
// Character matching is a plain substring search over each scene's real
// one-liner (which always names every character present), not an AI call.
function resolveAffectedScenesForProposal(sceneList, explicitSceneRefs, characterFilters) {
  const isSeries = Boolean(sceneList.episodeScenes);
  const refs = [];

  (explicitSceneRefs ?? []).forEach(({ episodeLabel, sceneNumberLabel }) => {
    const resolved = resolveSceneIdentityFromLabels(sceneList, episodeLabel, sceneNumberLabel);
    if (resolved) refs.push(resolved);
  });

  (characterFilters ?? []).forEach((name) => {
    const needle = (name || "").trim().toLowerCase();
    if (!needle) return;
    if (isSeries) {
      sceneList.episodeScenes.forEach((episode, episodeIndex) => {
        (episode.scenes ?? []).forEach((scene, sceneIndex) => {
          if ((scene.oneLiner?.en ?? "").toLowerCase().includes(needle)) {
            refs.push({ episodeIndex, sceneIndex });
          }
        });
      });
    } else {
      (sceneList.scenes ?? []).forEach((scene, sceneIndex) => {
        if ((scene.oneLiner?.en ?? "").toLowerCase().includes(needle)) {
          refs.push({ episodeIndex: null, sceneIndex });
        }
      });
    }
  });

  const seen = new Set();
  const deduped = refs.filter((ref) => {
    const key = `${ref.episodeIndex ?? ""}-${ref.sceneIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped
    .map((ref) => {
      const scene = lookupSceneServerSide(sceneList, ref);
      if (!scene) return null;
      return {
        episodeIndex: ref.episodeIndex,
        sceneIndex: ref.sceneIndex,
        sceneNumber: (scene.sceneNumber || String(ref.sceneIndex + 1)).replace(/^\s*(SCENE|SC)\.?\s*/i, ""),
        intExt: scene.intExt || "",
        location: scene.location?.en ?? "",
        timeOfDay: scene.timeOfDay || "",
        description: scene.oneLiner?.en ?? "",
      };
    })
    .filter(Boolean);
}

// A plain, deterministic "Day 3: Ep2 Sc3, Sc4 / Day 4: Ep2 Sc7, ..." summary
// built straight from the real regenerated schedule content — used instead
// of an AI-written description of what changed, so it can never mismatch
// what was actually applied.
function buildScheduleDaySummary(sceneList, scheduleDays) {
  const isSeries = Boolean(sceneList.episodeScenes);
  return (scheduleDays ?? [])
    .slice()
    .sort((a, b) => a.dayNumber - b.dayNumber)
    .map((day) => {
      const labels = (day.sceneRefs ?? []).map((ref) => {
        const scene = lookupSceneServerSide(sceneList, ref);
        const num = (scene?.sceneNumber || String(ref.sceneIndex + 1)).replace(/^\s*(SCENE|SC)\.?\s*/i, "");
        const epLabel = isSeries && typeof ref.episodeIndex === "number" ? `Ep${ref.episodeIndex + 1} ` : "";
        return `${epLabel}Sc${num}`;
      });
      return `Day ${day.dayNumber}${day.completed ? " (completed)" : ""}: ${labels.length ? labels.join(", ") : "(no scenes)"}`;
    })
    .join("\n");
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
    model: GEMINI_MODEL_NAME,
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

  const parsed = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents,
    config: {
      systemInstruction: SCRIPT_BREAKDOWN_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: { rows: { type: Type.ARRAY, items: AD_SHEET_ROW_SCHEMA } },
        required: ["rows"],
      },
    },
  });

  const rows = sanitizeBilingualContent(parsed).rows ?? [];
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

  // Same lesson as generateDeepScriptBreakdownContent: each batch re-sends
  // the WHOLE script, so several of these at once reliably trips Vertex
  // AI's own rate limit (a real 166KB script + several batches confirmed
  // it) — sequential is slower but actually finishes. A batch that still
  // fails after retries falls back to blank rows for just that batch
  // instead of losing the whole AD sheet.
  const blankRow = { mainCharacters: [], extras: { en: "", or: "" }, property: { en: "", or: "" }, costumeRemarks: { en: "", or: "" } };
  const batchResults = await mapWithConcurrency(batches, 1, async (batch) => {
    try {
      return await generateAdSheetDetailsForBatch(batch.entries, batch.start, breakdownContent, sourceText);
    } catch (error) {
      console.error(`AD sheet batch starting at scene ${batch.start} failed, filling with blank rows:`, error.message);
      return batch.entries.map(() => blankRow);
    }
  });

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
    // Same deleted-mid-run race as /api/script-breakdown's own insert.
    if (error.code === "23503") {
      res.status(409).json({ error: "This project was deleted or changed while the analysis was still running. Please try again." });
      return;
    }
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

// A standalone way to (re)tag every category with episode numbers on a
// breakdown that already exists — "Analyze Script" only runs once per
// project (the button disappears once a breakdown exists), so a project
// analyzed before this feature shipped has no other way to pick it up
// short of deleting and rebuilding the whole breakdown from scratch.
app.post("/api/script-breakdown/:id/classify-episode-numbers", requireRole("admin", "production_manager"), async (req, res) => {
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

    const updatedContent = await classifyEpisodeNumbers(sourceText, latest.rows[0].content);

    // Pure enrichment, same reasoning as classify-cast-categories above —
    // carries the previous approval status forward.
    const insertResult = await db.query(
      "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4) RETURNING id, status, feedback",
      [sceneListId, JSON.stringify(updatedContent), latest.rows[0].status, "Tagged every category with episode numbers"]
    );

    res.json({ ...insertResult.rows[0], sceneListId, ...updatedContent });
  } catch (error) {
    console.error("Classify episode numbers failed:", error.message);
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
    model: GEMINI_MODEL_NAME,
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

  // Same reasoning as /api/script-breakdown: one batch per ~15 scenes, each
  // re-sending the whole script, run sequentially now for rate-limit
  // safety — a real script easily pushes this past Render's own request
  // timeout. Respond immediately and let the frontend poll for the new
  // row instead of holding this request open.
  res.json({ status: "processing" });

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
    await db.query(
      "INSERT INTO script_breakdowns (scene_list_id, content, status, feedback) VALUES ($1, $2, $3, $4)",
      [sceneListId, JSON.stringify(updatedContent), latest.rows[0].status, "Generated AD Scene Breakdown Sheet"]
    );
  } catch (error) {
    console.error("AD sheet generation failed:", error.message);
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
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";
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
    const bodyFont = lang === "or" ? "odiaRegular" : lang === "hi" ? "hindiRegular" : "Helvetica";
    const headerFont = lang === "or" ? "odiaBold" : lang === "hi" ? "hindiBold" : "Helvetica-Bold";

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
    const notCastLabel =
      lang === "or"
        ? "ଏପର୍ଯ୍ୟନ୍ତ କାଷ୍ଟ ହୋଇନାହିଁ — ଦୟାକରି ଅପଡେଟ୍ କରନ୍ତୁ"
        : lang === "hi"
          ? "अभी तक कास्ट नहीं हुआ — कृपया अपडेट करें"
          : "Not yet cast — please update";
    const recommendationsByCharacter = new Map(
      (breakdown.costumeRecommendations ?? []).map((rec) => [rec.character.toLowerCase(), rec])
    );

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.registerFont("odiaRegular", FONTS.odiaRegular);
    doc.registerFont("odiaBold", FONTS.odiaBold);
    doc.registerFont("hindiRegular", FONTS.hindiRegular);
    doc.registerFont("hindiBold", FONTS.hindiBold);
    doc.font(bodyFont);
    doc.font(headerFont);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${category}-${lang}-${formatExportTimestamp()}.pdf"`);
    doc.pipe(res);

    doc.font(headerFont).fontSize(22).text(categoryLabels[category][lang]);
    doc.moveDown(1);

    if (items.length === 0) {
      doc.font(bodyFont).fontSize(12).text(
        lang === "or" ? "କିଛି ମିଳିଲା ନାହିଁ।" : lang === "hi" ? "इस श्रेणी में कुछ नहीं मिला।" : "Nothing found for this category."
      );
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
        const playedByPrefix = lang === "or" ? "କଳାକାର" : lang === "hi" ? "अभिनेता" : "Played by";
        const playedByLine = `${playedByPrefix}: ${cast ? cast.name : notCastLabel}${cast?.contact_number ? ` — ${cast.contact_number}` : ""}`;
        doc.font(bodyFont).fontSize(11).text(playedByLine, { indent: 10 });
      }
      if (category === "costumes") {
        const rec = recommendationsByCharacter.get(item.character.toLowerCase());
        if (rec) {
          const recommendedLabel = lang === "or" ? "ପ୍ରସ୍ତାବିତ ପରିମାଣ" : lang === "hi" ? "अनुशंसित मात्रा" : "Recommended quantities";
          const scenesWord = lang === "or" ? "ଦୃଶ୍ୟ" : lang === "hi" ? "दृश्य" : "scenes";
          doc.font(headerFont).fontSize(10).text(`${recommendedLabel} (${rec.totalScenes} ${scenesWord}):`, { indent: 10 });
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
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";
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
    const statusLabels =
      lang === "or" ? ["ବାକି ଅଛି", "ହୋଇଗଲା"] : lang === "hi" ? ["बाकी", "पूरा"] : ["Pending", "Done"];
    const columnLabels =
      lang === "or"
        ? { name: "ନାମ", location: "ସ୍ଥାନ", intExt: "INT/EXT", sceneCount: "ଦୃଶ୍ୟ ସଂଖ୍ୟା", character: "ଚରିତ୍ର", notes: "ନୋଟ୍", status: "ସ୍ଥିତି", remarks: "ମନ୍ତବ୍ୟ", playedBy: "କଳାକାର", contactNumber: "ଯୋଗାଯୋଗ ନମ୍ବର", age: "ବୟସ", gender: "ଲିଙ୍ଗ", recommendedQuantities: "ପ୍ରସ୍ତାବିତ ପରିମାଣ" }
        : lang === "hi"
          ? { name: "नाम", location: "स्थान", intExt: "INT/EXT", sceneCount: "दृश्य संख्या", character: "किरदार", notes: "टिप्पणी", status: "स्थिति", remarks: "टिप्पणी", playedBy: "अभिनेता", contactNumber: "संपर्क नंबर", age: "उम्र", gender: "लिंग", recommendedQuantities: "अनुशंसित मात्रा" }
          : { name: "Name", location: "Location", intExt: "INT/EXT", sceneCount: "Scene Count", character: "Character", notes: "Notes", status: "Status", remarks: "Remarks", playedBy: "Played By", contactNumber: "Contact Number", age: "Age", gender: "Gender", recommendedQuantities: "Recommended Quantities" };
    const notCastLabel =
      lang === "or"
        ? "ଏପର୍ଯ୍ୟନ୍ତ କାଷ୍ଟ ହୋଇନାହିଁ — ଦୟାକରି ଅପଡେଟ୍ କରନ୍ତୁ"
        : lang === "hi"
          ? "अभी तक कास्ट नहीं हुआ — कृपया अपडेट करें"
          : "Not yet cast — please update";
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
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";

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

    const bodyFont = lang === "or" ? "odiaRegular" : lang === "hi" ? "hindiRegular" : "Helvetica";
    const headerFont = lang === "or" ? "odiaBold" : lang === "hi" ? "hindiBold" : "Helvetica-Bold";
    const labels =
      lang === "or"
        ? { title: "ସ୍କ୍ରିପ୍ଟ ବ୍ରେକଡାଉନ୍ ସିଟ୍", scn: "SCN", description: "ଦୃଶ୍ୟ ବର୍ଣ୍ଣନା", type: "TYPE", dn: "D/N", location: "ମୁଖ୍ୟ ସ୍ଥାନ", characters: "ମୁଖ୍ୟ ଚରିତ୍ର", extras: "ଏକ୍ସଟ୍ରା", property: "ପ୍ରପର୍ଟି", costume: "ପୋଷାକ/ମନ୍ତବ୍ୟ" }
        : lang === "hi"
          ? { title: "स्क्रिप्ट ब्रेकडाउन शीट", scn: "SCN", description: "दृश्य विवरण", type: "TYPE", dn: "D/N", location: "मुख्य स्थान", characters: "मुख्य किरदार", extras: "अतिरिक्त कलाकार", property: "सामग्री", costume: "पोशाक/टिप्पणी" }
          : { title: "SCRIPT BREAKDOWN SHEET", scn: "SCN", description: "SCENE DESCRIPTION", type: "TYPE", dn: "D/N", location: "PRIMARY LOCATION", characters: "MAIN CHARACTERS", extras: "EXTRAS", property: "PROPERTY", costume: "COSTUME / REMARKS" };

    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 24 });
    doc.registerFont("odiaRegular", FONTS.odiaRegular);
    doc.registerFont("odiaBold", FONTS.odiaBold);
    doc.registerFont("hindiRegular", FONTS.hindiRegular);
    doc.registerFont("hindiBold", FONTS.hindiBold);

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
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";

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
        : lang === "hi"
          ? { title: "स्क्रिप्ट ब्रेकडाउन शीट", scn: "SCN", description: "दृश्य विवरण", type: "TYPE", dn: "D/N", location: "मुख्य स्थान", characters: "मुख्य किरदार", extras: "अतिरिक्त कलाकार", property: "सामग्री", costume: "पोशाक/टिप्पणी" }
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
    model: GEMINI_MODEL_NAME,
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
  const bodyFont = lang === "or" ? "odiaRegular" : lang === "hi" ? "hindiRegular" : "Helvetica";
  const headerFont = lang === "or" ? "odiaBold" : lang === "hi" ? "hindiBold" : "Helvetica-Bold";
  const labels =
    lang === "or"
      ? { title: "CHARACTER SCRIPT", action: "କାର୍ଯ୍ୟ" }
      : lang === "hi"
        ? { title: "CHARACTER SCRIPT", action: "क्रिया" }
        : { title: "CHARACTER SCRIPT", action: "Action" };

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  doc.registerFont("odiaRegular", FONTS.odiaRegular);
  doc.registerFont("odiaBold", FONTS.odiaBold);
  doc.registerFont("hindiRegular", FONTS.hindiRegular);
  doc.registerFont("hindiBold", FONTS.hindiBold);

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
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";

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
      : lang === "hi"
        ? { scene: "दृश्य", heading: "दृश्य शीर्षक", hasDialogue: "संवाद है?", content: "सामग्री", yes: "हाँ", no: "नहीं" }
        : { scene: "Scene", heading: "Scene Heading", hasDialogue: "Has Dialogue?", content: "Content", yes: "Yes", no: "No" };

  const workbook = new ExcelJS.Workbook();
  const sheetTitle = lang === "or" ? "ଚରିତ୍ର ସ୍କ୍ରିପ୍ଟ" : lang === "hi" ? "किरदार स्क्रिप्ट" : "Character Script";
  const sheet = workbook.addWorksheet(sheetTitle.slice(0, 31));
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
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";

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
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";

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
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";

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
    model: GEMINI_MODEL_NAME,
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
    model: GEMINI_MODEL_NAME,
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

// Finds scenes on OTHER, not-yet-shot days that the AD says they also shot
// today ahead of schedule. Same "match by real script scene number, never
// guess from position" approach as parseCompletedScenesFromReport, just
// searching across every remaining day's sceneRefs instead of one day's.
async function parseExtraScenesFromReport(sceneList, candidateDays, reportText) {
  const isSeries = Boolean(sceneList.episodeScenes);
  const candidates = [];
  candidateDays.forEach((d) => {
    (d.sceneRefs ?? []).forEach((ref, index) => {
      const scene = lookupSceneServerSide(sceneList, ref);
      const num = (scene?.sceneNumber || String(ref.sceneIndex + 1)).replace(/^\s*(SCENE|SC)\.?\s*/i, "");
      const epLabel = isSeries ? `Episode ${ref.episodeIndex + 1}, ` : "";
      candidates.push({
        dayNumber: d.dayNumber,
        index,
        label: `Day ${d.dayNumber} — ${epLabel}Scene ${num}${scene?.oneLiner?.en ? `: ${scene.oneLiner.en}` : ""}`,
      });
    });
  });

  if (candidates.length === 0 || !reportText?.trim()) return [];

  const listText = candidates.map((c, i) => `${i}. ${c.label}`).join("\n");
  const contents = `Scenes currently scheduled on OTHER, not-yet-shot days, numbered:\n${listText}\n\nThe Assistant Director says they ALSO shot some extra scenes today, ahead of their originally scheduled day:\n"${reportText}"\n\nMatch by the real script scene number and episode mentioned — the AD refers to scenes by their real script scene numbers exactly as listed above, never guess from position alone. Only include an index if the report clearly says that scene was shot today. Return "matchedIndexes" (0-indexed positions from the list above).`;

  const response = await generateContentWithRetry({
    model: GEMINI_MODEL_NAME,
    contents,
    config: {
      systemInstruction: PRODUCTION_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 2048,
      responseSchema: {
        type: Type.OBJECT,
        properties: { matchedIndexes: { type: Type.ARRAY, items: { type: Type.INTEGER } } },
        required: ["matchedIndexes"],
      },
    },
  });

  const { matchedIndexes } = JSON.parse(response.text);
  return matchedIndexes.map((i) => candidates[i]).filter(Boolean);
}

app.post("/api/shoot-schedule/:sceneListId/parse-day-completion", requireRole("admin", "production_manager"), async (req, res) => {
  const { sceneListId } = req.params;
  const { dayNumber, reportText, extraReportText } = req.body;

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
    const allDays = latestSchedule.rows[0]?.content?.scheduleDays ?? [];
    const day = allDays.find((d) => d.dayNumber === dayNumber);
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

    let extraMatches = [];
    if (extraReportText?.trim()) {
      const otherDays = allDays.filter((d) => d.dayNumber !== dayNumber && !d.completed);
      extraMatches = await parseExtraScenesFromReport(sceneList, otherDays, extraReportText);
    }

    res.json({
      dayNumber,
      completedIndexes,
      completed: completedIndexes.map((i) => ({ index: i, label: describeRef(day.sceneRefs[i]) })),
      notCompleted: notCompletedIndexes.map((i) => ({ index: i, label: describeRef(day.sceneRefs[i]) })),
      extraMatches,
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
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";
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

    const bodyFont = lang === "or" ? "odiaRegular" : lang === "hi" ? "hindiRegular" : "Helvetica";
    const headerFont = lang === "or" ? "odiaBold" : lang === "hi" ? "hindiBold" : "Helvetica-Bold";
    const labels =
      lang === "or"
        ? {
            schedule: "ସୁଟିଂ ସୂଚୀ", day: "ଦିନ", location: "ସ୍ଥାନ", cast: "କଳାକାର", notes: "ଟିପ୍ପଣୀ", artistSummary: "କଳାକାର-ଅନୁଯାୟୀ ସାରାଂଶ", totalDays: "ମୋଟ ଦିନ", days: "ଦିନଗୁଡ଼ିକ", completed: "ସମାପ୍ତ", costume: "ପୋଷାକ", properties: "ପ୍ରପର୍ଟି", adRemark: "AD ମନ୍ତବ୍ୟ",
            wrapped: "ସମାପ୍ତ", pending: "ବାକି", inProgress: "ଚାଲୁଛି", episode: "ଏପିସୋଡ୍", scenes: "ଦୃଶ୍ୟ", unspecified: "ଅନିର୍ଦ୍ଦିଷ୍ଟ",
            serialNo: "କ୍ର.ନଂ", description: "ଦୃଶ୍ୟ ବର୍ଣ୍ଣନା", dayNight: "D/N", juniorArtists: "ଜୁନିଅର୍ ଆର୍ଟିଷ୍ଟ",
          }
        : lang === "hi"
          ? {
              schedule: "शूटिंग शेड्यूल", day: "दिन", location: "स्थान", cast: "कलाकार", notes: "टिप्पणी", artistSummary: "कलाकार-अनुसार सारांश", totalDays: "कुल दिन", days: "दिन", completed: "पूरा हुआ", costume: "पोशाक", properties: "सामग्री", adRemark: "AD टिप्पणी",
              wrapped: "पूरा", pending: "बाकी", inProgress: "जारी", episode: "एपिसोड", scenes: "दृश्य", unspecified: "अनिर्दिष्ट",
              serialNo: "क्र.सं", description: "दृश्य विवरण", dayNight: "D/N", juniorArtists: "जूनियर आर्टिस्ट",
            }
          : {
              schedule: "Shoot Schedule", day: "Day", location: "Location", cast: "Cast Called", notes: "Notes", artistSummary: "Artist-Wise Summary", totalDays: "Total Days", days: "Days", completed: "COMPLETED", costume: "Costume", properties: "Properties", adRemark: "AD Remark",
              wrapped: "WRAPPED", pending: "PENDING", inProgress: "IN PROGRESS", episode: "Episode", scenes: "scenes", unspecified: "Unspecified",
              serialNo: "S.No", description: "Scene Description", dayNight: "D/N", juniorArtists: "Junior Artists",
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
    doc.registerFont("hindiRegular", FONTS.hindiRegular);
    doc.registerFont("hindiBold", FONTS.hindiBold);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="shoot-schedule${dayFilter ? `-day-${dayFilter}` : ""}-${lang}-${formatExportTimestamp()}.pdf"`
    );
    doc.pipe(res);

    const pageLeft = doc.page.margins.left;
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    const columns = [
      { key: "sno", label: labels.serialNo, width: 34 },
      { key: "scn", label: "SC NO", width: 45 },
      { key: "description", label: labels.description, width: 135 },
      { key: "dn", label: labels.dayNight, width: 36 },
      { key: "location", label: labels.location, width: 95 },
      { key: "artist", label: labels.cast, width: 100 },
      { key: "juniorArtists", label: labels.juniorArtists, width: 80 },
      { key: "costume", label: labels.costume, width: 100 },
      { key: "properties", label: labels.properties, width: 140 },
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
      let serialNumber = 1;
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

            const values = {
              sno: String(serialNumber),
              scn,
              description: adSheetRow?.oneLiner?.[lang] || notAvailableLabel,
              dn: scene.timeOfDay || notAvailableLabel,
              location: `${scene.intExt}. ${scene.location?.[lang] ?? ""}`,
              artist,
              juniorArtists: adSheetRow?.extras?.[lang] || notAvailableLabel,
              costume: ref.costume || notAvailableLabel,
              properties: ref.properties || notAvailableLabel,
            };
            serialNumber += 1;

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
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";
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
            serialNo: "କ୍ର.ନଂ", description: "ଦୃଶ୍ୟ ବର୍ଣ୍ଣନା", dayNight: "D/N", juniorArtists: "ଜୁନିଅର୍ ଆର୍ଟିଷ୍ଟ",
          }
        : lang === "hi"
          ? {
              day: "दिन", location: "स्थान", cast: "कलाकार", notes: "टिप्पणी", artistSummary: "कलाकार-अनुसार सारांश", totalDays: "कुल दिन", days: "दिन", completed: "पूरा हुआ", costume: "पोशाक", properties: "सामग्री", adRemark: "AD टिप्पणी",
              wrapped: "पूरा", pending: "बाकी", inProgress: "जारी", episode: "एपिसोड", scenes: "दृश्य", unspecified: "अनिर्दिष्ट", character: "किरदार", status: "स्थिति",
              serialNo: "क्र.सं", description: "दृश्य विवरण", dayNight: "D/N", juniorArtists: "जूनियर आर्टिस्ट",
            }
          : {
              day: "Day", location: "Location", cast: "Cast Called", notes: "Notes", artistSummary: "Artist-Wise Summary", totalDays: "Total Days", days: "Days", completed: "COMPLETED", costume: "Costume", properties: "Properties", adRemark: "AD Remark",
              wrapped: "WRAPPED", pending: "PENDING", inProgress: "IN PROGRESS", episode: "Episode", scenes: "scenes", unspecified: "Unspecified", character: "Character", status: "Status",
              serialNo: "S.No", description: "Scene Description", dayNight: "D/N", juniorArtists: "Junior Artists",
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
      { header: labels.serialNo, key: "sno", width: 8 },
      { header: "SC NO", key: "scn", width: 14 },
      { header: labels.description, key: "description", width: 45 },
      { header: labels.dayNight, key: "dn", width: 8 },
      { header: labels.location, key: "location", width: 26 },
      { header: labels.cast, key: "artist", width: 30 },
      { header: labels.juniorArtists, key: "juniorArtists", width: 26 },
      { header: labels.costume, key: "costume", width: 28 },
      { header: labels.properties, key: "properties", width: 36 },
      { header: labels.adRemark, key: "adRemark", width: 30 },
    ];

    // Cell styling below mirrors a real physical call-sheet chart (the AD's
    // own reference "Range Master Chart" format) rather than a generic
    // spreadsheet look: centered, bordered, wrap-text cells throughout, a
    // bold Arial header, and a solid-orange banner for each shoot day —
    // just applied to this app's own columns/data, not that chart's.
    const CENTERED_WRAP = { horizontal: "center", vertical: "middle", wrapText: true };
    const THIN_BORDER = { style: "thin", color: { argb: "FF000000" } };
    const FULL_BORDER = { top: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER, bottom: THIN_BORDER };
    const HEADER_FONT = { bold: true, size: 10, name: "Arial", color: { argb: "FF000000" } };
    const DATA_FONT = { size: 15, name: "Arial" };
    const DAY_BANNER_FONT = { bold: true, size: 15, name: "Arial" };
    const DAY_BANNER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF9900" } };
    const GROUP_BANNER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF2F7" } };

    function styleRow(row, { font, fill, border, height } = {}) {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.alignment = CENTERED_WRAP;
        if (font) cell.font = font;
        if (fill) cell.fill = fill;
        if (border) cell.border = border;
      });
      if (height) row.height = height;
    }

    // Excel only keeps the TOP-LEFT cell's value once a row is merged —
    // every other cell's value is discarded. Setting the value straight on
    // cell 1 (rather than adding a row keyed to some other column, like
    // "scn") keeps banner text showing up correctly regardless of which
    // column happens to be first.
    function addMergedBannerRow(sheet, text, columnCount) {
      const row = sheet.addRow([]);
      row.getCell(1).value = text;
      sheet.mergeCells(row.number, 1, row.number, columnCount);
      return row;
    }

    const workbook = new ExcelJS.Workbook();
    const scheduleDaysToRender = dayFilter
      ? schedule.scheduleDays.filter((d) => d.dayNumber === dayFilter)
      : schedule.scheduleDays;

    scheduleDaysToRender.forEach((day) => {
      const sheet = workbook.addWorksheet(`${labels.day} ${day.dayNumber}`.slice(0, 31));
      sheet.columns = columns;
      styleRow(sheet.getRow(1), { font: HEADER_FONT, border: { top: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER } });

      const dayTitle = `${day.date ? `${formatDisplayDate(day.date)} — ` : ""}${labels.day} ${day.dayNumber}${day.completed ? ` — ${labels.completed}` : ""} — ${labels.location}: ${day.location?.[lang] ?? ""}`;
      const titleRow = addMergedBannerRow(sheet, dayTitle, columns.length);
      styleRow(titleRow, { font: DAY_BANNER_FONT, fill: DAY_BANNER_FILL, height: 40 });
      sheet.addRow({});

      let serialNumber = 1;
      groupSceneRefsForPdf(day.sceneRefs ?? [], sceneList, lang).forEach((episodeGroup) => {
        episodeGroup.locationGroups.forEach((locationGroup) => {
          const episodePrefix = episodeGroup.episodeIndex !== null ? `${labels.episode} ${episodeGroup.episodeIndex + 1} — ` : "";
          const bannerText = `${episodePrefix}${locationGroup.location || labels.unspecified} (${locationGroup.items.length} ${labels.scenes})`;
          const bannerRow = addMergedBannerRow(sheet, bannerText, columns.length);
          styleRow(bannerRow, { font: { bold: true, size: 11, name: "Arial" }, fill: GROUP_BANNER_FILL });

          locationGroup.items.forEach(({ ref, scene }) => {
            const identity = isSeries ? `e${ref.episodeIndex}-s${ref.sceneIndex}` : `s${ref.sceneIndex}`;
            const adSheetRow = castByIdentity.get(identity);
            const realSceneNumber = (scene.sceneNumber || String(ref.sceneIndex + 1)).replace(/^\s*(SCENE|SC)\.?\s*/i, "");
            const scn = isSeries ? `Ep${ref.episodeIndex + 1} ${realSceneNumber}` : realSceneNumber;
            const artist = adSheetRow ? (adSheetRow.mainCharacters ?? []).join(", ") || notAvailableLabel : (day.charactersNeeded ?? []).join(", ") || notAvailableLabel;

            const dataRow = sheet.addRow({
              sno: serialNumber,
              scn,
              description: adSheetRow?.oneLiner?.[lang] || notAvailableLabel,
              dn: scene.timeOfDay || notAvailableLabel,
              location: `${scene.intExt}. ${scene.location?.[lang] ?? ""}`,
              artist,
              juniorArtists: adSheetRow?.extras?.[lang] || notAvailableLabel,
              costume: ref.costume || notAvailableLabel,
              properties: ref.properties || notAvailableLabel,
              adRemark: ref.adRemark || "",
            });
            styleRow(dataRow, { font: DATA_FONT, border: FULL_BORDER });
            serialNumber += 1;
          });
        });
      });

      if (day.notes?.[lang]) {
        const notesRow = addMergedBannerRow(sheet, `${labels.notes}: ${day.notes[lang]}`, columns.length);
        styleRow(notesRow, { font: { italic: true, size: 11, name: "Arial" } });
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
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";
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

    const bodyFont = lang === "or" ? "odiaRegular" : lang === "hi" ? "hindiRegular" : "Helvetica";
    const headerFont = lang === "or" ? "odiaBold" : lang === "hi" ? "hindiBold" : "Helvetica-Bold";
    const labels =
      lang === "or"
        ? {
            artists: "କଳାକାର ବିଭାଜନ", locations: "ସ୍ଥାନ ବିଭାଜନ", costumes: "ପୋଷାକ ବିଭାଜନ", properties: "ସାମଗ୍ରୀ ବିଭାଜନ",
            day: "ଦିନ", episode: "ଏପିସୋଡ୍", scene: "ଦୃଶ୍ୟ", scenes: "ଦୃଶ୍ୟ", notCast: "ଏପର୍ଯ୍ୟନ୍ତ କାଷ୍ଟ ହୋଇନାହିଁ", none: "କିଛି ମିଳିଲା ନାହିଁ।",
          }
        : lang === "hi"
          ? {
              artists: "कलाकार विवरण", locations: "स्थान विवरण", costumes: "पोशाक विवरण", properties: "सामग्री विवरण",
              day: "दिन", episode: "एपिसोड", scene: "दृश्य", scenes: "दृश्य", notCast: "अभी तक कास्ट नहीं हुआ", none: "इस दिन के लिए कुछ नहीं मिला।",
            }
          : {
              artists: "Artist Breakdown", locations: "Location Breakdown", costumes: "Costume Breakdown", properties: "Property Breakdown",
              day: "Day", episode: "Episode", scene: "Scene", scenes: "scenes", notCast: "Not yet cast", none: "Nothing found for this day.",
            };

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.registerFont("odiaRegular", FONTS.odiaRegular);
    doc.registerFont("odiaBold", FONTS.odiaBold);
    doc.registerFont("hindiRegular", FONTS.hindiRegular);
    doc.registerFont("hindiBold", FONTS.hindiBold);

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
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";
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
        : lang === "hi"
          ? {
              artists: "कलाकार विवरण", locations: "स्थान विवरण", costumes: "पोशाक विवरण", properties: "सामग्री विवरण",
              character: "किरदार", playedBy: "अभिनेता", contactNumber: "संपर्क नंबर", notCast: "अभी तक कास्ट नहीं हुआ",
              location: "स्थान", intExt: "INT/EXT", sceneCount: "दृश्य संख्या", scene: "दृश्य", notes: "टिप्पणी",
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

// Groups a 'crew'-category member into one of the Call Sheet's Crew-tab
// department sections by keyword-matching their role text — this app has
// no dedicated per-department field, just a free-text role, so this is a
// best-effort classifier rather than an exact lookup. art_department and
// costume_department already have their own category. Direction-team
// members (the ADs) aren't included here — they're covered by the Call
// Sheet header fields (1st AD, 2nd AD, etc.), not the Crew-tab roster.
function classifyCrewDepartment(category, role) {
  const r = (role || "").toUpperCase();
  if (category === "art_department") return "artDepartment";
  if (category === "costume_department") return "costumes";
  if (category === "crew") {
    if (r.includes("PRODUCTION")) return "production";
    if (r.includes("SOUND")) return "sound";
    if (r.includes("DOP") || r.includes("CAMERA")) return "camera";
    if (r.includes("MAKEUP") || r.includes("HAIR")) return "makeupHair";
  }
  return null;
}

const CALL_SHEET_DEPARTMENT_LABELS = {
  production: "PRODUCTION",
  sound: "SOUND",
  camera: "CAMERA",
  artDepartment: "ART DEPARTMENT",
  costumes: "COSTUMES",
  makeupHair: "MAKEUP & HAIR",
};

// SW = Start Work (first day this character is called), WF = Work Finish
// (last day), SWF = both (only appears this one day), W = an ordinary
// day in between — the standard call-sheet cast-status abbreviations.
function computeCastStatus(artistSchedule, character, dayNumber) {
  const entry = (artistSchedule ?? []).find((e) => e.character?.toLowerCase() === character.toLowerCase());
  if (!entry || !entry.days?.length) return "";
  const days = [...entry.days].map((d) => d.dayNumber).sort((a, b) => a - b);
  const isFirst = days[0] === dayNumber;
  const isLast = days[days.length - 1] === dayNumber;
  if (isFirst && isLast) return "SWF";
  if (isFirst) return "SW";
  if (isLast) return "WF";
  return "W";
}

// Shared by the PDF and Excel Call Sheet exports — everything both need to
// render, computed once. dayNumber must already be validated by the caller.
async function buildCallSheetData(sceneListId, schedule, sceneList, adSheet, dayNumber, lang) {
  const isSeries = Boolean(sceneList.episodeScenes);
  const day = schedule.scheduleDays.find((d) => d.dayNumber === dayNumber);
  const scheduleDaysSorted = [...schedule.scheduleDays].sort((a, b) => a.dayNumber - b.dayNumber);
  const nextDay = scheduleDaysSorted.find((d) => d.dayNumber > dayNumber) ?? null;

  const crewResult = await db.query(
    "SELECT category, character_name, name, role, contact_number FROM crew_members WHERE scene_list_id = $1",
    [sceneListId]
  );
  const castByCharacter = new Map();
  const locationAddressByLabel = new Map();
  const departmentRoster = {};
  crewResult.rows.forEach((row) => {
    if (row.category === "artist" && row.character_name) {
      castByCharacter.set(row.character_name.toLowerCase(), row);
    } else if (row.category === "location" && row.character_name) {
      locationAddressByLabel.set(row.character_name.toLowerCase(), row.name);
    } else {
      const dept = classifyCrewDepartment(row.category, row.role);
      if (dept) {
        departmentRoster[dept] = departmentRoster[dept] ?? [];
        departmentRoster[dept].push(row);
      }
    }
  });

  // AD sheet lookup by (episodeIndex, sceneIndex), same flattening every
  // other schedule export already uses.
  const castByIdentity = new Map();
  if (adSheet) {
    let flatIndex = 0;
    if (isSeries) {
      (sceneList.episodeScenes ?? []).forEach((episodeScene, episodeIndex) => {
        episodeScene.scenes.forEach((_, sceneIndex) => {
          castByIdentity.set(`e${episodeIndex}-s${sceneIndex}`, adSheet[flatIndex]);
          flatIndex += 1;
        });
      });
    } else {
      (sceneList.scenes ?? []).forEach((_, sceneIndex) => {
        castByIdentity.set(`s${sceneIndex}`, adSheet[flatIndex]);
        flatIndex += 1;
      });
    }
  }

  function buildSceneRows(refs) {
    const charactersInDay = new Set();
    const rows = groupSceneRefsForPdf(refs ?? [], sceneList, lang).flatMap((episodeGroup) =>
      episodeGroup.locationGroups.flatMap((locationGroup) =>
        locationGroup.items.map(({ ref, scene }) => {
          const identity = isSeries ? `e${ref.episodeIndex}-s${ref.sceneIndex}` : `s${ref.sceneIndex}`;
          const adSheetRow = castByIdentity.get(identity);
          const realSceneNumber = (scene.sceneNumber || String(ref.sceneIndex + 1)).replace(/^\s*(SCENE|SC)\.?\s*/i, "");
          const sceneLabel = isSeries ? `Ep${ref.episodeIndex + 1}, Sc ${realSceneNumber}` : `Sc ${realSceneNumber}`;
          const cast = adSheetRow?.mainCharacters ?? [];
          cast.forEach((c) => charactersInDay.add(c));
          return {
            sceneLabel,
            set: scene.location?.[lang] ?? "",
            cast: cast.join(", "),
            dn: scene.timeOfDay || "",
            location: locationAddressByLabel.get((scene.location?.en ?? "").toLowerCase()) || "",
          };
        })
      )
    );
    // Day scenes shot before night scenes — a stable sort keeps each
    // group's existing location/episode order intact within DAY and
    // within NIGHT, it just moves NIGHT scenes after all the DAY ones.
    const dnWeight = { DAY: 0, NIGHT: 1 };
    const sortedRows = rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => (dnWeight[a.row.dn] ?? 0) - (dnWeight[b.row.dn] ?? 0) || a.index - b.index)
      .map(({ row }) => row);
    return { rows: sortedRows, charactersInDay };
  }

  const { rows: sceneRows, charactersInDay } = buildSceneRows(day?.sceneRefs);
  const { rows: advanceRows } = nextDay ? buildSceneRows(nextDay.sceneRefs) : { rows: [] };

  const juniorsContact = schedule.callSheetConfig?.juniorsContact || "";
  const castRows = [...charactersInDay].map((character) => {
    const cast = castByCharacter.get(character.toLowerCase());
    // A junior/background player with no individually confirmed contact
    // routes to the production's own juniors point-of-contact instead of
    // showing up with a blank number.
    const contact = cast?.contact_number || (!cast?.name || cast.name.toUpperCase().includes("JUNIOR") ? juniorsContact : "");
    return {
      character,
      actor: cast?.name || "",
      contact,
      status: computeCastStatus(schedule.artistSchedule, character, dayNumber),
      reportTime: day?.crewCallTime || "",
      hairMakeupTime: day?.crewCallTime || "",
      readyTime: day?.crewCallTime || "",
    };
  });

  const config = schedule.callSheetConfig ?? {};
  const activeDepartments = config.activeDepartments ?? [];

  return {
    day,
    nextDay,
    sceneRows,
    advanceRows,
    castRows,
    config,
    activeDepartments,
    departmentRoster,
  };
}

async function loadCallSheetInputs(req, res) {
  const idLookup = await db.query("SELECT scene_list_id FROM shoot_schedules WHERE id = $1", [req.params.id]);
  if (idLookup.rows.length === 0) {
    res.status(404).json({ error: "Shoot schedule not found" });
    return null;
  }
  const sceneListId = idLookup.rows[0].scene_list_id;
  const dayNumber = Number(req.query.day);
  if (!Number.isFinite(dayNumber)) {
    res.status(400).json({ error: "A day number is required." });
    return null;
  }

  const result = await db.query(
    "SELECT content FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
    [sceneListId]
  );
  const schedule = result.rows[0].content;
  if (!(schedule.scheduleDays ?? []).some((d) => d.dayNumber === dayNumber)) {
    res.status(404).json({ error: `Day ${dayNumber} was not found in this schedule.` });
    return null;
  }

  const sceneListResult = await db.query("SELECT content FROM scene_lists WHERE id = $1", [sceneListId]);
  const sceneList = sceneListResult.rows[0]?.content ?? {};
  const title = await fetchProjectTitleForSceneList(sceneListId, sceneList, ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en");
  const breakdownResult = await db.query(
    "SELECT content FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1",
    [sceneListId]
  );
  const adSheet = breakdownResult.rows[0]?.content?.adSheet ?? null;

  return { sceneListId, dayNumber, schedule, sceneList, adSheet, title };
}

app.get("/api/shoot-schedule/:id/call-sheet", requireLogin, async (req, res) => {
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";

  try {
    const inputs = await loadCallSheetInputs(req, res);
    if (!inputs) return;
    const { sceneListId, dayNumber, schedule, sceneList, adSheet, title } = inputs;
    const data = await buildCallSheetData(sceneListId, schedule, sceneList, adSheet, dayNumber, lang);
    const { day, nextDay, sceneRows, advanceRows, castRows, config, activeDepartments, departmentRoster } = data;

    const bodyFont = lang === "or" ? "odiaRegular" : lang === "hi" ? "hindiRegular" : "Helvetica";
    const headerFont = lang === "or" ? "odiaBold" : lang === "hi" ? "hindiBold" : "Helvetica-Bold";

    const doc = new PDFDocument({ size: "A4", margin: 24 });
    doc.registerFont("odiaRegular", FONTS.odiaRegular);
    doc.registerFont("odiaBold", FONTS.odiaBold);
    doc.registerFont("hindiRegular", FONTS.hindiRegular);
    doc.registerFont("hindiBold", FONTS.hindiBold);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="call-sheet-day-${dayNumber}-${lang}-${formatExportTimestamp()}.pdf"`);
    doc.pipe(res);

    const left = doc.page.margins.left;
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.font(headerFont).fontSize(20).fillColor("#1a56b0").text(title || "Call Sheet", left, doc.y, { width: pageWidth, align: "center" }).fillColor("#000");
    doc.font(headerFont).fontSize(13).text(`SHOOT DAY ${dayNumber}${day.date ? `  —  ${formatDisplayDate(day.date)}` : ""}`, { align: "center" });
    doc.moveDown(0.8);

    function labeledLine(label, value) {
      doc.font(headerFont).fontSize(9).text(`${label}: `, left, doc.y, { continued: true }).font(bodyFont).text(value || "—");
    }

    labeledLine("Executive Producer", config.executiveProducer);
    labeledLine("UPM", config.upm);
    labeledLine("1st AD / 2nd AD / 2nd 2nd AD", [config.firstAD, config.secondAD, config.secondSecondAD].filter(Boolean).join(" / "));
    doc.moveDown(0.4);
    labeledLine("Crew Call", day.crewCallTime);
    labeledLine("Shoot Call", day.shootCallTime);
    labeledLine("Breakfast / Lunch / Est. Wrap", [day.breakfastTime, day.lunchTime, day.wrapTime].filter(Boolean).join("  /  "));
    labeledLine("Sunrise / Sunset / Weather", [day.sunrise, day.sunset, day.weather].filter(Boolean).join("  /  "));
    doc.moveDown(0.4);
    labeledLine("Shooting Location", day.actualLocation?.[lang] || day.location?.[lang]);
    labeledLine("Basecamp / Crew Parking", [day.basecamp, day.crewParking].filter(Boolean).join("  /  "));
    labeledLine("Nearest Hospital", day.nearestHospital);
    doc.moveDown(0.8);

    const sceneColumns = [
      { key: "sceneLabel", label: "SC#", width: 90 },
      { key: "set", label: "SET", width: 110 },
      { key: "cast", label: "CAST", width: 140 },
      { key: "dn", label: "D/N", width: 40 },
      { key: "location", label: "LOCATION", width: pageWidth - 90 - 110 - 140 - 40 },
    ];
    const cellPad = 4;
    function drawTable(columns, rows, title) {
      doc.font(headerFont).fontSize(11).text(title, left, doc.y);
      doc.moveDown(0.2);
      let y = doc.y;
      const pageBottom = doc.page.height - doc.page.margins.bottom;

      function drawHeader(yStart) {
        doc.font(headerFont).fontSize(8);
        const h = Math.max(16, ...columns.map((c) => doc.heightOfString(c.label, { width: c.width - cellPad * 2 }) + cellPad * 2));
        let x = left;
        columns.forEach((c) => {
          doc.rect(x, yStart, c.width, h).fill("#000");
          doc.fillColor("#fff").text(c.label, x + cellPad, yStart + cellPad, { width: c.width - cellPad * 2 });
          x += c.width;
        });
        doc.fillColor("#000");
        return yStart + h;
      }
      y = drawHeader(y);

      rows.forEach((row) => {
        doc.font(bodyFont).fontSize(8);
        const h = Math.max(14, ...columns.map((c) => doc.heightOfString(String(row[c.key] ?? ""), { width: c.width - cellPad * 2 }) + cellPad * 2));
        if (y + h > pageBottom) {
          doc.addPage({ size: "A4", margin: 24 });
          y = doc.page.margins.top;
          y = drawHeader(y);
        }
        let x = left;
        columns.forEach((c) => {
          doc.rect(x, y, c.width, h).stroke("#cccccc");
          doc.font(bodyFont).fontSize(8).text(String(row[c.key] ?? ""), x + cellPad, y + cellPad, { width: c.width - cellPad * 2 });
          x += c.width;
        });
        y += h;
      });
      doc.y = y + 10;
    }

    drawTable(sceneColumns, sceneRows, "TODAY'S SCENES");

    const castColumns = [
      { key: "actor", label: "ACTOR", width: 110 },
      { key: "character", label: "CHARACTER", width: 110 },
      { key: "status", label: "STATUS", width: 45 },
      { key: "reportTime", label: "RPT", width: 60 },
      { key: "hairMakeupTime", label: "H/MU", width: 60 },
      { key: "readyTime", label: "RDY@", width: 60 },
      { key: "contact", label: "CONTACT", width: pageWidth - 110 - 110 - 45 - 60 - 60 - 60 },
    ];
    drawTable(castColumns, castRows, "CAST");

    if (activeDepartments.length > 0) {
      doc.font(headerFont).fontSize(11).text("CREW", left, doc.y);
      doc.moveDown(0.3);
      activeDepartments.forEach((dept) => {
        const members = departmentRoster[dept] ?? [];
        doc.font(headerFont).fontSize(9).text(CALL_SHEET_DEPARTMENT_LABELS[dept] ?? dept, left);
        if (members.length === 0) {
          doc.font(bodyFont).fontSize(9).fillColor("#999").text("— fill in —", { indent: 10 }).fillColor("#000");
        } else {
          members.forEach((m) => doc.font(bodyFont).fontSize(9).text(`${m.name}${m.role ? ` — ${m.role}` : ""}${m.contact_number ? ` — ${m.contact_number}` : ""}`, { indent: 10 }));
        }
        doc.moveDown(0.2);
      });
      doc.moveDown(0.4);
    }

    if (config.syncSoundNote !== undefined) {
      doc.font(headerFont).fontSize(9).text("SYNC SOUND", left, doc.y);
      doc.font(bodyFont).fontSize(9).text(config.syncSoundNote || "—", { indent: 10 });
      doc.moveDown(0.4);
    }

    if (advanceRows.length > 0) {
      drawTable(sceneColumns, advanceRows, `ADVANCE SCHEDULE — DAY ${nextDay.dayNumber}${nextDay.date ? ` (${formatDisplayDate(nextDay.date)})` : ""}`);
    }

    doc.end();
  } catch (error) {
    console.error("Call sheet PDF export failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
});

app.get("/api/shoot-schedule/:id/call-sheet-excel", requireLogin, async (req, res) => {
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";

  try {
    const inputs = await loadCallSheetInputs(req, res);
    if (!inputs) return;
    const { sceneListId, dayNumber, schedule, sceneList, adSheet, title } = inputs;
    const data = await buildCallSheetData(sceneListId, schedule, sceneList, adSheet, dayNumber, lang);
    const { day, nextDay, sceneRows, advanceRows, castRows, config, activeDepartments, departmentRoster } = data;

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Call Sheet");

    const boldCenter = { font: { bold: true }, alignment: { horizontal: "center", vertical: "middle", wrapText: true } };
    function labelValueRow(label, value) {
      const row = sheet.addRow([label, value ?? "—"]);
      row.getCell(1).font = { bold: true };
      row.getCell(2).alignment = { wrapText: true };
    }

    sheet.mergeCells("A1:E1");
    sheet.getCell("A1").value = `${title || "Call Sheet"} — SHOOT DAY ${dayNumber}${day.date ? `  —  ${formatDisplayDate(day.date)}` : ""}`;
    sheet.getCell("A1").font = { bold: true, size: 14, color: { argb: "FF1A56B0" } };
    sheet.getCell("A1").alignment = { horizontal: "center" };
    sheet.addRow([]);

    labelValueRow("Executive Producer", config.executiveProducer);
    labelValueRow("UPM", config.upm);
    labelValueRow("1st AD / 2nd AD / 2nd 2nd AD", [config.firstAD, config.secondAD, config.secondSecondAD].filter(Boolean).join(" / "));
    labelValueRow("Crew Call", day.crewCallTime);
    labelValueRow("Shoot Call", day.shootCallTime);
    labelValueRow("Breakfast / Lunch / Est. Wrap", [day.breakfastTime, day.lunchTime, day.wrapTime].filter(Boolean).join("  /  "));
    labelValueRow("Sunrise / Sunset / Weather", [day.sunrise, day.sunset, day.weather].filter(Boolean).join("  /  "));
    labelValueRow("Shooting Location", day.actualLocation?.[lang] || day.location?.[lang]);
    labelValueRow("Basecamp / Crew Parking", [day.basecamp, day.crewParking].filter(Boolean).join("  /  "));
    labelValueRow("Nearest Hospital", day.nearestHospital);
    sheet.addRow([]);

    function addTable(title, columns, rows) {
      const titleRow = sheet.addRow([title]);
      sheet.mergeCells(titleRow.number, 1, titleRow.number, columns.length);
      titleRow.font = { bold: true, size: 12 };
      const headerRow = sheet.addRow(columns.map((c) => c.label));
      headerRow.eachCell((cell) => { cell.font = boldCenter.font; cell.alignment = boldCenter.alignment; cell.border = { top: { style: "thin" }, bottom: { style: "thin" } }; });
      rows.forEach((row) => {
        const r = sheet.addRow(columns.map((c) => row[c.key] ?? ""));
        r.eachCell((cell) => { cell.alignment = { wrapText: true, vertical: "middle" }; cell.border = { top: { style: "thin", color: { argb: "FFCCCCCC" } }, bottom: { style: "thin", color: { argb: "FFCCCCCC" } } }; });
      });
      sheet.addRow([]);
    }

    addTable("TODAY'S SCENES", [
      { key: "sceneLabel", label: "SC#" }, { key: "set", label: "SET" }, { key: "cast", label: "CAST" },
      { key: "dn", label: "D/N" }, { key: "location", label: "LOCATION" },
    ], sceneRows);

    addTable("CAST", [
      { key: "actor", label: "ACTOR" }, { key: "character", label: "CHARACTER" }, { key: "status", label: "STATUS" },
      { key: "reportTime", label: "RPT" }, { key: "hairMakeupTime", label: "H/MU" }, { key: "readyTime", label: "RDY@" },
      { key: "contact", label: "CONTACT" },
    ], castRows);

    if (activeDepartments.length > 0) {
      const crewTitleRow = sheet.addRow(["CREW"]);
      crewTitleRow.font = { bold: true, size: 12 };
      activeDepartments.forEach((dept) => {
        const members = departmentRoster[dept] ?? [];
        const deptRow = sheet.addRow([CALL_SHEET_DEPARTMENT_LABELS[dept] ?? dept]);
        deptRow.font = { bold: true };
        if (members.length === 0) {
          sheet.addRow(["— fill in —"]);
        } else {
          members.forEach((m) => sheet.addRow([`${m.name}${m.role ? ` — ${m.role}` : ""}${m.contact_number ? ` — ${m.contact_number}` : ""}`]));
        }
      });
      sheet.addRow([]);
    }

    if (config.syncSoundNote !== undefined) {
      const syncRow = sheet.addRow(["SYNC SOUND", config.syncSoundNote || "—"]);
      syncRow.getCell(1).font = { bold: true };
      sheet.addRow([]);
    }

    if (advanceRows.length > 0) {
      addTable(`ADVANCE SCHEDULE — DAY ${nextDay.dayNumber}${nextDay.date ? ` (${formatDisplayDate(nextDay.date)})` : ""}`, [
        { key: "sceneLabel", label: "SC#" }, { key: "set", label: "SET" }, { key: "cast", label: "CAST" },
        { key: "dn", label: "D/N" }, { key: "location", label: "LOCATION" },
      ], advanceRows);
    }

    sheet.columns.forEach((col, i) => { col.width = i === 0 ? 22 : 24; });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="call-sheet-day-${dayNumber}-${lang}-${formatExportTimestamp()}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Call sheet Excel export failed:", error.message);
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
  // Must match the frontend's JUNIOR_ARTIST_COORDINATOR_KEY (App.jsx) — the
  // same sentinel crew "characterName" standing in for every Extra/Junior
  // character at once.
  const juniorCoordinatorAdded = castFinalized.has("__junior_artist_coordinator__");

  const characters = (breakdownContent?.artistList ?? [])
    // Non-speaking characters (present-but-silent, or off-screen voice-only)
    // aren't part of casting at all — left out of this count/list entirely,
    // not counted as "pending".
    .filter((item) => item.castCategory !== "non_speaking_action" && item.castCategory !== "off_screen")
    .map((item) => ({
      label: item.label,
      age: item.age ?? null,
      gender: item.gender ?? null,
      // Extras/Juniors share ONE coordinator slot instead of individual
      // casting — finalized for ALL of them together the moment that one
      // coordinator crew member exists.
      finalized: item.castTier === "extra" ? juniorCoordinatorAdded : castFinalized.has(item.label.toLowerCase()),
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
  const lang = ["or", "hi"].includes(req.query.lang) ? req.query.lang : "en";

  if (!(await userOwnsSceneList(req.user, req.query.sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const categoryLabels = lang === "or"
    ? { artist: "କଳାକାର", location: "ସ୍ଥାନ", art_department: "ଆର୍ଟ ବିଭାଗ", costume_department: "ପୋଷାକ ବିଭାଗ", direction_team: "ନିର୍ଦ୍ଦେଶନା ଦଳ", production_team: "ପ୍ରଡକ୍ସନ୍ ଦଳ", crew: "ଅନ୍ୟାନ୍ୟ କ୍ରୁ" }
    : lang === "hi"
      ? { artist: "कलाकार", location: "स्थान", art_department: "आर्ट विभाग", costume_department: "पोशाक विभाग", direction_team: "निर्देशन टीम", production_team: "प्रोडक्शन टीम", crew: "अन्य क्रू" }
      : { artist: "Artist", location: "Location", art_department: "Art Department", costume_department: "Costume Department", direction_team: "Direction Team", production_team: "Production Team", crew: "Other / Additional Crew" };
  const columnLabels = lang === "or"
    ? { category: "ବିଭାଗ", linkedTo: "ଚରିତ୍ର/ସ୍ଥାନ", name: "ନାମ", role: "ପଦବୀ", contactNumber: "ଯୋଗାଯୋଗ ନମ୍ବର" }
    : lang === "hi"
      ? { category: "श्रेणी", linkedTo: "किरदार/स्थान", name: "नाम", role: "पद", contactNumber: "संपर्क नंबर" }
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
    const sheet = workbook.addWorksheet(lang === "or" ? "କ୍ରୁ ଓ କାଷ୍ଟ" : lang === "hi" ? "क्रू और कास्ट" : "Cast & Crew");
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

// The digital clapboard's clap log — records scene/shot/take every time
// the AD (or whoever's operating it) taps the clap button on set. A plain
// append-only list, not tied to any particular shoot day, since a clap can
// happen for any scene regardless of which day it's scheduled on.
app.post("/api/clapboard/:sceneListId/log", requireLogin, async (req, res) => {
  const { sceneListId } = req.params;
  const { sceneNumber, shotNumber, takeNumber, dayNight, date } = req.body;

  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }
  if (!Number.isFinite(Number(takeNumber))) {
    res.status(400).json({ error: "A take number is required." });
    return;
  }

  try {
    const result = await db.query(
      "INSERT INTO clapboard_logs (scene_list_id, scene_number, shot_number, take_number, day_night, shoot_date, logged_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
      [sceneListId, sceneNumber?.trim() || null, shotNumber?.trim() || null, Number(takeNumber), dayNight?.trim() || null, date || null, req.user.name]
    );
    const row = result.rows[0];
    res.json({
      id: row.id,
      sceneNumber: row.scene_number,
      shotNumber: row.shot_number,
      takeNumber: row.take_number,
      dayNight: row.day_night,
      date: row.shoot_date,
      loggedBy: row.logged_by,
      createdAt: row.created_at,
    });
  } catch (error) {
    console.error("Clapboard log failed:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/clapboard/:sceneListId/log", requireLogin, async (req, res) => {
  const { sceneListId } = req.params;

  if (!(await userOwnsSceneList(req.user, sceneListId))) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  try {
    const result = await db.query(
      "SELECT * FROM clapboard_logs WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 200",
      [sceneListId]
    );
    res.json(
      result.rows.map((row) => ({
        id: row.id,
        sceneNumber: row.scene_number,
        shotNumber: row.shot_number,
        takeNumber: row.take_number,
        dayNight: row.day_night,
        date: row.shoot_date,
        loggedBy: row.logged_by,
        createdAt: row.created_at,
      }))
    );
  } catch (error) {
    console.error("Clapboard log fetch failed:", error.message);
    res.status(500).json({ error: error.message });
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

// The Digital Clapboard's title-card image is per-project (each show has
// its own banner) — a plain mutable column on concepts, not JSONB, since
// there's exactly one current value with no revision history to keep.
app.post("/api/concept/:conceptId/clapboard-banner", requireRole("admin", "production_manager"), crewPhotoUpload.single("banner"), async (req, res) => {
  const { conceptId } = req.params;

  if (!requireConceptAccess(req, conceptId)) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "An image file is required." });
    return;
  }

  const existing = await db.query("SELECT clapboard_banner_path FROM concepts WHERE id = $1", [conceptId]);
  if (existing.rows.length === 0) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const bannerPath = await savePhotoBuffer(req.file.buffer, req.file.originalname);
  if (existing.rows[0].clapboard_banner_path) {
    deletePhoto(existing.rows[0].clapboard_banner_path);
  }

  await db.query("UPDATE concepts SET clapboard_banner_path = $1 WHERE id = $2", [bannerPath, conceptId]);
  res.json({ clapboardBannerUrl: photoUrlFor(bannerPath) });
});

app.delete("/api/concept/:conceptId/clapboard-banner", requireRole("admin", "production_manager"), async (req, res) => {
  const { conceptId } = req.params;

  if (!requireConceptAccess(req, conceptId)) {
    res.status(403).json({ error: "You don't have access to this project." });
    return;
  }

  const existing = await db.query("SELECT clapboard_banner_path FROM concepts WHERE id = $1", [conceptId]);
  if (existing.rows.length === 0) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (existing.rows[0].clapboard_banner_path) {
    deletePhoto(existing.rows[0].clapboard_banner_path);
  }

  await db.query("UPDATE concepts SET clapboard_banner_path = NULL WHERE id = $1", [conceptId]);
  res.json({ clapboardBannerUrl: null });
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

// ============================================================================
// Floating auto-pipeline agent — runs the whole Story & Screenplay chain
// (storylines -> pitch deck -> characters -> three-act -> bit sheet -> scene
// list -> every scene's screenplay) end to end from a single concept, with a
// handful of specialist reviewer passes checking the draft at key stages and
// triggering one regeneration when they flag a real problem. Each stage still
// writes into the SAME tables the manual click-through flow uses, so a run
// stays fully inspectable in the normal UI afterward — this is automation of
// the existing pipeline, not a separate parallel system.
// ============================================================================

const AUTO_PIPELINE_REVIEW_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    needsRevision: { type: Type.BOOLEAN },
    issues: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["needsRevision", "issues"],
};

// Reviewer 1 (AI): only meaningful for a vertical drama, whose episodes have
// a mandatory hook — flags vague/generic hooks or repetitive twists across
// episodes, the two failure modes actually worth an AI's judgment here
// (unlike location/character counts below, "is this hook actually specific"
// isn't something code can check).
async function reviewPitchDeckHooks(deck) {
  if (!Array.isArray(deck.episodes) || !deck.episodes[0]?.hook) {
    return { needsRevision: false, issues: [] };
  }

  const episodesText = deck.episodes
    .map((ep, i) => `Episode ${i + 1}: ${ep.title.en}\nSynopsis: ${ep.synopsis.en}\nHook: ${ep.hook.en}`)
    .join("\n\n");

  // Up to 60+ episodes can each generate their own flagged issue here — at
  // the previous 2048-token budget, with NO retry-on-parse-failure wrapper
  // (unlike generatePitchDeckContent), a long issues list truncated the
  // JSON mid-string and killed the whole run instantly. This was the real,
  // recurring cause behind repeated "Unterminated string in JSON" failures
  // at the pitch-deck stage — not the core-content call fixed earlier.
  return generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents: `You are reviewing a vertical micro-drama's episode hooks for quality, as a strict story editor. Here are all ${deck.episodes.length} episodes:\n\n${episodesText}\n\nFlag any episode whose hook is VAGUE or GENERIC (e.g. "things get complicated", "a shocking twist is revealed", or anything that doesn't state a concrete, specific moment) rather than a real, concrete beat — a hook can be a line of dialogue or a silent action beat, either is fine, but it must be SPECIFIC. Also flag if hooks feel repetitive across episodes (the same kind of twist reused too many times in a row). Cite the episode number for each real problem found. If everything is genuinely concrete and varied, return no issues.`,
    config: {
      systemInstruction: "You are a meticulous story editor reviewing episode hooks for a vertical micro-drama. Be strict but fair — only flag genuine problems, not stylistic preferences.",
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      responseSchema: AUTO_PIPELINE_REVIEW_SCHEMA,
    },
  });
}

// Reviewer 2 (deterministic, not AI): the "budget-friendly" location/cast
// count constraint is an exact, countable fact, not a judgment call — a code
// check is both free and more reliable here than spending a Gemini call to
// ask an LLM to count things.
function reviewSceneListBudget(deck, sceneList) {
  if (deck.format?.type !== "vertical") return { needsRevision: false, issues: [] };

  const issues = [];
  const locations = new Set();
  (sceneList.episodeScenes ?? []).forEach((episodeScene) =>
    episodeScene.scenes.forEach((scene) => locations.add(scene.location.en))
  );
  if (locations.size > 5) {
    issues.push(
      `The scene list uses ${locations.size} distinct locations (${[...locations].join(", ")}), above the 4-5 location budget for a 2-3 day shoot.`
    );
  }
  if ((deck.majorCharacters?.length ?? 0) > 6) {
    issues.push(`The pitch deck has ${deck.majorCharacters.length} major characters, above the ~5 character budget.`);
  }
  return { needsRevision: issues.length > 0, issues };
}

const AUTO_PIPELINE_SCORE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    score: { type: Type.INTEGER },
    verdict: { type: Type.STRING },
  },
  required: ["score", "verdict"],
};

// Reviewer 4 (AI) — the judge. Every reviewed stage gets scored 1-10 by
// this one after the specialist reviewer's pass. Below 8 triggers another
// revision round (see reviseUntilGood), feeding the judge's own verdict
// back in alongside the specialist's issues — the judge is a second,
// independent opinion, not a rubber stamp on the first reviewer's word.
// It now reads the REAL draft (it used to get a one-line summary, and in a
// real run scored the same pitch deck 7/10 three rounds running with
// near-identical comments), against a checklist for that stage. The story
// stages use the stronger model (STORY_JUDGE_MODEL_NAME).
async function scorePipelineStage(stageLabel, draftText, reviewerIssues, { checklist, model = GEMINI_MODEL_NAME } = {}) {
  const issuesText = reviewerIssues.length > 0 ? reviewerIssues.join(" ") : "none.";
  const checklistText = checklist ? `\n\nJudge it against this checklist:\n${checklist}` : "";

  return generateJsonContent({
    model,
    contents: `You are the final judge for the "${stageLabel}" stage of a screenplay pipeline. Here is the current draft:\n\n${draftText}${checklistText}\n\nA specialist reviewer has just read this same draft and found these problems in it (they are notes on THIS draft, not earlier feedback it was meant to fix): ${issuesText}\n\nRate this draft's quality on a strict scale from 1 to 10 (10 = genuinely excellent; 8 = strong; 7 = good and usable — the pass mark; anything below 7 needs real work before it's acceptable). Be a tough, honest judge — do not hand out high scores generously, and don't just repeat the specialist reviewer's words, form your own independent judgment. Give your verdict as a short, direct sentence, in this exact style: if below 7, "This is not up to the mark. This is only a(n) X-pointer because <specific, concrete reasons>." — if 7 or above, "This is a good X-pointer — <what's genuinely working>; to be even better: <the most important remaining improvement>."`,
    config: {
      systemInstruction: "You are the final quality judge in a multi-agent screenplay pipeline — blunt, specific, and consistent. Never inflate scores just to move things along.",
      responseMimeType: "application/json",
      // 2.5 Flash "thinks" first, and that counts against this ceiling.
      maxOutputTokens: model === GEMINI_MODEL_NAME ? 1024 : 16384,
      responseSchema: AUTO_PIPELINE_SCORE_SCHEMA,
    },
  });
}

// The story stages' judge and Story Editor use the stronger model: this is
// where a story's quality is decided, and the calls are few (a handful
// per run), unlike the per-scene ones.
const STORY_JUDGE_MODEL_NAME = "gemini-2.5-flash";

// What "good" means at each story stage — given to both the Story Editor
// (to find problems) and the judge (to score).
const STAGE_CHECKLISTS = {
  pitchDeck: `- A specific, fresh premise — not a stock "corporation vs. village" or "estranged child returns" set-up told the usual way; what makes THIS story unlike others like it?
- A protagonist with a clear goal, clear stakes (what they lose if they fail) and a strong opposing force.
- Major characters whose wants genuinely clash with each other.
- The setting and culture drive the story, not just decorate it.
- For a series: every episode has its own specific turn and hook; no two episodes do the same job.`,
  threeAct: `- The protagonist's outer goal (want) and inner need are clear, and pull against each other.
- An inciting incident early in Act 1 that forces the story into motion.
- Stakes that keep rising through Act 2, with a real midpoint turn, and a genuine "all is lost" low before Act 3.
- A climax where the protagonist resolves the central conflict through their OWN choice and action — not luck, a rescue or someone else's decision.
- The ending pays off what the setup planted, and proves the controlling idea (theme).
- Each major character's arc lands.
- For a series: the overall arc and every episode's own three acts are complete, and episodes escalate.`,
  bitSheet: `- Every beat CAUSES the next ("therefore" / "but"), never just "and then".
- No sagging stretch where nothing changes; every beat turns something.
- Twists and reveals are set up earlier, so they feel earned, not random.
- No two beats do the same job; nothing important happens off-screen.
- The beats cover all three acts in order, with the climax and resolution given real weight.
- For a series: every episode's beats escalate and end on a hook.`,
  sceneList: `- Every Bit Sheet beat is covered, in order; no scene is filler.
- Every scene has a turn (something changes by its end).
- No two scenes do the same job or repeat the same confrontation.
- Variety of places, time of day and pace; big moments are given enough screen time.
- The estimated running time fits the target.`,
};

// Story Editor (AI): the specialist reviewer for the story stages that had
// no review at all before (Three-Act, Bit Sheet) and for the Scene List.
async function reviewStoryStage(stageLabel, draftText, checklist) {
  return generateJsonContent({
    model: STORY_JUDGE_MODEL_NAME,
    contents: `You are a demanding story editor reviewing the "${stageLabel}" of a screenplay in development. Here is the draft:\n\n${draftText}\n\nCheck it against this checklist:\n${checklist}\n\nList the real problems as "issues": each one specific (name the beat, act, character or scene) and saying what to change. At most 8, most important first. Only genuine problems, never style preferences; if it's genuinely strong, return no issues and needsRevision false.`,
    config: {
      systemInstruction: "You are a meticulous, experienced story editor. Strict but fair, specific and constructive.",
      responseMimeType: "application/json",
      maxOutputTokens: 16384,
      responseSchema: AUTO_PIPELINE_REVIEW_SCHEMA,
    },
  });
}

// The writer -> reviewer -> judge -> revise loop every reviewed stage runs.
// Keeps the BEST-scoring version, not the last one (a revision can come out
// worse than the draft before it). `mustFix(draft)` returns a blocking
// problem code can see (e.g. a wrong episode count) or null — a draft with
// one is never chosen over one without.
//
// Second batch (the user's call, 2026-10-06; story stages only): if no
// version has reached the pass mark after the first 3, version 4 is a FRESH version
// that takes in every note from versions 1-3 at once (each normal revision
// only sees the latest notes), with the best version so far as reference;
// versions 5-6 then revise it as usual. It stops early once a version
// reaches the pass mark, or when two versions in a row don't beat the best — in the
// tests, plain revising flattened out after 2-3 rounds.
const SECOND_BATCH_VERSIONS = 3;

async function reviseUntilGood(runId, stageKey, stageLabel, firstDraft, { draftText, review, revise, mustFix, checklist, judgeModel, secondBatch = false }) {
  const maxVersions = MAX_AUTO_PIPELINE_REVISION_ROUNDS + (secondBatch ? SECOND_BATCH_VERSIONS : 0);
  let draft = firstDraft;
  let best = null;
  const allNotes = [];
  let versionsWithoutGain = 0;
  for (let version = 1; ; version++) {
    const blocking = mustFix ? mustFix(draft) : null;
    const reviewed = review ? await review(draft) : { issues: [] };
    const issues = Array.isArray(reviewed?.issues) ? reviewed.issues : [];
    const judged = await scorePipelineStage(stageLabel, draftText(draft), issues, { checklist, model: judgeModel });
    await appendAutoPipelineNote(runId, stageKey, `Version ${version} — Judge score: ${judged.score}/10 — ${judged.verdict}`);
    if (blocking) await appendAutoPipelineNote(runId, stageKey, blocking);
    const candidate = { draft, score: Number(judged.score) || 0, version, blocking: Boolean(blocking) };
    const beatsBest =
      !best || (best.blocking && !candidate.blocking) || (best.blocking === candidate.blocking && candidate.score > best.score);
    // A tie also takes the newer version (it has had more fixes).
    const keep = beatsBest || (best.blocking === candidate.blocking && candidate.score === best.score);
    if (keep) best = candidate;
    versionsWithoutGain = beatsBest ? 0 : versionsWithoutGain + 1;
    const feedback = [blocking, ...issues, judged.verdict].filter(Boolean).join(" ");
    allNotes.push(`Version ${version} (${candidate.score}/10): ${feedback}`);

    if (candidate.score >= PASS_SCORE && !blocking) break;
    if (version >= maxVersions) break;
    if (version === MAX_AUTO_PIPELINE_REVISION_ROUNDS) {
      if (!secondBatch) break;
      await appendAutoPipelineNote(
        runId,
        stageKey,
        `Still not up to the mark after ${version} versions (best: version ${best.version}, ${best.score}/10) — writing a fresh version that takes in every note so far.`
      );
      draft = await revise(
        best.draft,
        `Earlier reviews of this ${stageLabel} found the problems below. Write a NEW, stronger version that fixes ALL of them at once:\n${allNotes.join("\n")}`,
        { fresh: true }
      );
      versionsWithoutGain = 0;
      continue;
    }
    if (version > MAX_AUTO_PIPELINE_REVISION_ROUNDS && versionsWithoutGain >= 2) {
      await appendAutoPipelineNote(runId, stageKey, "Stopped early: two versions in a row did not beat the best one.");
      break;
    }
    draft = await revise(draft, feedback);
  }
  if (best.draft !== draft) {
    await appendAutoPipelineNote(runId, stageKey, `Kept version ${best.version} (score ${best.score}/10) — the best of all versions.`);
  }
  return best.draft;
}

// The judge's view of each stage: the real content, in English, trimmed
// only if it's enormous (a 60-episode series).
const JUDGE_TEXT_LIMIT = 60000;
function capJudgeText(text) {
  return text.length > JUDGE_TEXT_LIMIT ? `${text.slice(0, JUDGE_TEXT_LIMIT)}\n...(the rest is cut for length)` : text;
}

function pitchDeckJudgeText(deck) {
  const characters = (deck.majorCharacters ?? [])
    .map((c) => `- ${c.name} — ${c.role?.en ?? ""}. Emotional core: ${c.emotionalCore?.en ?? ""}. Conflict: ${c.conflict?.en ?? ""}`)
    .join("\n");
  const episodes = Array.isArray(deck.episodes)
    ? `\n\nEPISODES:\n${deck.episodes.map((ep, i) => `${i + 1}. ${ep.title?.en ?? ""} — ${ep.synopsis?.en ?? ""}${ep.hook?.en ? ` HOOK: ${ep.hook.en}` : ""}`).join("\n")}`
    : "";
  return capJudgeText(
    `TITLE: ${deck.title?.en ?? ""}\nLOGLINE: ${deck.logline?.en ?? ""}\nPREMISE: ${deck.premise?.en ?? ""}\nTONE/GENRE: ${deck.toneGenre?.en ?? ""}\n\nSTORY:\n${(deck.storyPages ?? []).map((page) => page.en).join("\n\n")}\n\nMAJOR CHARACTERS:\n${characters}${episodes}`
  );
}

function threeActJudgeText(threeAct) {
  const acts = `CONTROLLING IDEA (THEME): ${threeAct.controllingIdea?.en ?? ""}\n\nACT 1 — SETUP: ${actText(threeAct.setup)}\n\nACT 2 — CONFRONTATION: ${actText(threeAct.confrontation)}\n\nACT 3 — RESOLUTION: ${actText(threeAct.resolution)}`;
  const episodes = Array.isArray(threeAct.episodeStructures)
    ? `\n\nEPISODES:\n${threeAct.episodeStructures.map((ep, i) => `Episode ${i + 1}: Setup: ${ep.setup?.summary?.en ?? ""} / Confrontation: ${ep.confrontation?.summary?.en ?? ""} / Resolution: ${ep.resolution?.summary?.en ?? ""}`).join("\n")}`
    : "";
  return capJudgeText(acts + episodes);
}

function bitSheetJudgeText(bitSheet) {
  if (Array.isArray(bitSheet.episodeBits)) {
    return capJudgeText(bitSheet.episodeBits.map((ep, i) => `EPISODE ${i + 1}:\n${bitSheetOutlineText(ep.bits ?? [])}`).join("\n\n"));
  }
  return capJudgeText(bitSheetOutlineText(bitSheet.bits ?? []));
}

function sceneListJudgeText(sceneList, bitSheet) {
  const sceneLine = (scene, i) =>
    `${scene.sceneNumber || i + 1}. [Act ${scene.actNumber}] ${scene.intExt}. ${scene.location?.en ?? ""} — ${scene.timeOfDay}: ${scene.oneLiner?.en ?? ""} (${scene.estimatedMinutes ?? "?"} min)`;
  const scenesText = Array.isArray(sceneList.episodeScenes)
    ? sceneList.episodeScenes
        .map((ep, i) => `EPISODE ${i + 1} (${ep.totalEstimatedMinutes ?? "?"} of ${ep.targetMinutes ?? "?"} min):\n${(ep.scenes ?? []).map(sceneLine).join("\n")}`)
        .join("\n\n")
    : `RUNNING TIME: ${sceneList.totalEstimatedMinutes ?? "?"} of ${sceneList.targetMinutes ?? "?"} min\n${(sceneList.scenes ?? []).map(sceneLine).join("\n")}`;
  const beats = Array.isArray(bitSheet?.bits) ? `THE BIT SHEET IT MUST COVER:\n${bitSheetOutlineText(bitSheet.bits)}\n\nTHE SCENE LIST:\n` : "";
  return capJudgeText(beats + scenesText);
}

// Storylines: the run used to always take the first of the 3 directions.
// Now the story judge picks the strongest.
async function pickBestStoryline(storylines, format) {
  if (!Array.isArray(storylines) || storylines.length < 2) return { index: 0, reason: "" };
  const formatLine = format?.type === "vertical" ? "a low-budget vertical micro-drama" : format?.type === "series" ? "a web series" : "a feature film";
  const options = storylines
    .map((s, i) => `OPTION ${i + 1}: ${s.title?.en ?? ""}\nLogline: ${s.logline?.en ?? ""}\nSummary: ${s.summary?.en ?? ""}`)
    .join("\n\n");
  const result = await generateJsonContent({
    model: STORY_JUDGE_MODEL_NAME,
    contents: `Three storyline directions for ${formatLine}:\n\n${options}\n\nPick the ONE with the most potential to become a genuinely great screenplay: the freshest premise, the clearest protagonist goal and stakes, the strongest conflict, and the most room for surprise and emotion. Return "choice" (1, 2 or 3) and "reason" — one short sentence.`,
    config: {
      systemInstruction: "You are an experienced film producer and story editor choosing which story to develop.",
      responseMimeType: "application/json",
      maxOutputTokens: 16384,
      responseSchema: {
        type: Type.OBJECT,
        properties: { choice: { type: Type.INTEGER }, reason: { type: Type.STRING } },
        required: ["choice", "reason"],
      },
    },
  });
  const index = Math.round(Number(result.choice)) - 1;
  return { index: index >= 0 && index < storylines.length ? index : 0, reason: result.reason ?? "" };
}

// Caps the reviewer-judge revision loop so a stubbornly low score can't spin
// forever — after this many rounds, the pipeline proceeds with whatever the
// best attempt was rather than burning unbounded time/API quota on one stage.
const MAX_AUTO_PIPELINE_REVISION_ROUNDS = 3;
// The judge's pass mark: a version scoring this or more is good enough and
// the loop stops (the user's call, 2026-10-06 — it used to be 8, which no
// story stage reached in any real test, so every stage always ran every
// round).
const PASS_SCORE = 7;

// Real bug found in testing: Gemini can silently return a different episode
// count than requested on a pitch-deck REVISION call (60 requested -> 66,
// then 30, then 33 across successive rounds in one real run) — nothing
// enforces "exactly N items" in a Gemini array schema, it's purely a text
// instruction, and a revision call can drift from it even though the
// original call got it right. Returns a loud correction message when wrong,
// null when the count is fine (or there's no fixed count to check).
function pitchDeckEpisodeCountIssue(deck, format) {
  if (!format?.episodeCount || !Array.isArray(deck.episodes)) return null;
  if (deck.episodes.length === format.episodeCount) return null;
  return `CRITICAL: exactly ${format.episodeCount} episodes were required, but this draft has ${deck.episodes.length} — the episode COUNT itself is wrong, not just a quality issue. Regenerate with EXACTLY ${format.episodeCount} episodes, no more and no fewer, keeping every other requirement too.`;
}

// Same idea, for the batched stages downstream of the pitch deck: each
// batch is small enough that the model reliably returns exactly what a
// batch asks for, but this verifies the ASSEMBLED total still matches
// deck.episodes.length rather than trusting that silently — a shortfall in
// even one batch would otherwise produce a scene list, bit sheet, etc. with
// fewer episodes than the deck itself, with nothing catching the mismatch.
function assertEpisodeCount(actualLength, expectedLength, stageName) {
  if (actualLength !== expectedLength) {
    throw new Error(
      `${stageName} produced ${actualLength} episodes but the pitch deck has ${expectedLength} — a batch came back short. Try starting a new run.`
    );
  }
}

const AUTO_PIPELINE_JSONB_FIELDS = new Set(["format", "review_notes"]);

async function updateAutoPipelineRun(runId, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClauses = keys.map((key, i) => `${key} = $${i + 2}`).join(", ");
  const values = keys.map((key) => (AUTO_PIPELINE_JSONB_FIELDS.has(key) ? JSON.stringify(fields[key]) : fields[key]));
  await db.query(`UPDATE auto_pipeline_runs SET ${setClauses}, updated_at = now() WHERE id = $1`, [runId, ...values]);
}

// Atomic append (not read-modify-write) since the screenplay stage runs
// several episodes concurrently, any of which might append a note at once.
async function appendAutoPipelineNote(runId, stage, note) {
  await db.query(
    "UPDATE auto_pipeline_runs SET review_notes = review_notes || $2::jsonb, updated_at = now() WHERE id = $1",
    [runId, JSON.stringify([{ stage, note, at: new Date().toISOString() }])]
  );
}

// A pure heartbeat (no field changes) — called from inside long per-item
// loops (writing/rewriting one screenplay scene at a time) so updated_at
// reflects real, ongoing progress between the sparser stage/judge-note
// updates. This is what the stale-run reaper below relies on to tell a
// merely-slow run from a genuinely dead one.
async function touchAutoPipelineRun(runId) {
  await db.query("UPDATE auto_pipeline_runs SET updated_at = now() WHERE id = $1", [runId]);
}

// A run is a fire-and-forget async function tied to this one process — if
// the host restarts or spins down mid-run (seen in practice: a free/hobby
// tier host going idle once nothing has polled it in a while), that async
// work is just gone, and the row sits at status 'running' forever with no
// error and nothing left to finish it. Rather than requiring someone to
// notice and fix the row by hand, anything left "running" with no update
// in a while is presumed dead and failed out (with a clear reason) so the
// existing Resume feature can pick it back up.
const STALE_AUTO_PIPELINE_RUN_MINUTES = 10;

async function reapStaleAutoPipelineRuns() {
  try {
    const result = await db.query(
      `UPDATE auto_pipeline_runs
       SET status = 'failed',
           error = 'This run stopped receiving updates for over ${STALE_AUTO_PIPELINE_RUN_MINUTES} minutes (most likely the backend restarted or went idle mid-run) — nothing is still running for it. Use Resume to continue from the last completed stage.'
       WHERE status = 'running' AND updated_at < now() - interval '${STALE_AUTO_PIPELINE_RUN_MINUTES} minutes'
       RETURNING id`
    );
    if (result.rows.length > 0) {
      console.log("Reaped stale auto-pipeline run(s):", result.rows.map((row) => row.id).join(", "));
    }
  } catch (error) {
    console.error("Failed to reap stale auto-pipeline runs:", error.message);
  }
}

// How many episodes' screenplay scenes get written concurrently — matches
// the concurrency limit already used elsewhere (mapWithConcurrency) for
// per-item Gemini batches, balancing wall-clock time against the free-tier
// requests/minute cap.
const AUTO_PIPELINE_SCREENPLAY_CONCURRENCY = 4;

// Runs the full pipeline for one auto-pipeline-run row, from concept to
// every scene's screenplay, updating the row's progress as it goes. Never
// awaited by its caller (the /start route responds immediately) — a
// 60-episode vertical drama's screenplay stage alone can take many minutes.
async function runAutoPipeline(runId, conceptText, format, dialogueLanguage, resumeFromConceptId) {
  try {
    let conceptId = null;
    let storyline = null;
    let deck = null;
    let pitchDeckId = null;
    let characterSheet = null;
    let threeAct = null;
    let threeActId = null;
    let bitSheet = null;
    let bitSheetId = null;
    let sceneList = null;
    let sceneListId = null;

    if (resumeFromConceptId) {
      // Walk the same FK chain every stage below already writes to. A row
      // existing there IS the checkpoint — no separate progress-tracking
      // scheme to keep in sync with the actual generation code.
      conceptId = resumeFromConceptId;
      const conceptRow = await db.query("SELECT storylines FROM concepts WHERE id = $1", [conceptId]);
      storyline = conceptRow.rows[0]?.storylines?.[0] ?? null;

      const pdRow = await db.query(
        "SELECT id, content FROM pitch_decks WHERE concept_id = $1 ORDER BY created_at DESC LIMIT 1",
        [conceptId]
      );
      if (pdRow.rows[0]) {
        pitchDeckId = pdRow.rows[0].id;
        deck = pdRow.rows[0].content;
      }

      if (pitchDeckId) {
        const csRow = await db.query(
          "SELECT content FROM character_sheets WHERE pitch_deck_id = $1 ORDER BY created_at DESC LIMIT 1",
          [pitchDeckId]
        );
        characterSheet = csRow.rows[0]?.content ?? null;

        const taRow = await db.query(
          "SELECT id, content FROM three_act_structures WHERE pitch_deck_id = $1 ORDER BY created_at DESC LIMIT 1",
          [pitchDeckId]
        );
        if (taRow.rows[0]) {
          threeActId = taRow.rows[0].id;
          threeAct = taRow.rows[0].content;
        }
      }

      if (threeActId) {
        const bsRow = await db.query(
          "SELECT id, content FROM bit_sheets WHERE three_act_structure_id = $1 ORDER BY created_at DESC LIMIT 1",
          [threeActId]
        );
        if (bsRow.rows[0]) {
          bitSheetId = bsRow.rows[0].id;
          bitSheet = bsRow.rows[0].content;
        }
      }

      if (bitSheetId) {
        const slRow = await db.query(
          "SELECT id, content FROM scene_lists WHERE bit_sheet_id = $1 ORDER BY created_at DESC LIMIT 1",
          [bitSheetId]
        );
        if (slRow.rows[0]) {
          sceneListId = slRow.rows[0].id;
          sceneList = slRow.rows[0].content;
        }
      }

      await appendAutoPipelineNote(
        runId,
        "resume",
        `Resuming: reusing ${[deck && "pitch deck", characterSheet && "character sheet", threeAct && "three-act structure", bitSheet && "bit sheet", sceneList && "scene list"].filter(Boolean).join(", ") || "nothing yet — starting from the pitch deck"}.`
      );
    } else {
      await updateAutoPipelineRun(runId, { progress_stage: "storylines" });
      const { storylines } = await generateStorylinesContent(conceptText, format);
      // The story judge picks the strongest of the 3 (it used to always be
      // the first). A failed pick just falls back to the first.
      const picked = await pickBestStoryline(storylines, format).catch(() => ({ index: 0, reason: "" }));
      storyline = storylines[picked.index];
      if (picked.reason) {
        await appendAutoPipelineNote(runId, "storylines", `Picked option ${picked.index + 1} of ${storylines.length}: "${storyline?.title?.en ?? ""}" — ${picked.reason}`);
      }

      const conceptResult = await db.query(
        "INSERT INTO concepts (concept_text, storylines, title) VALUES ($1, $2, $3) RETURNING id",
        // The picked one first — Resume reads the first.
        [conceptText, JSON.stringify([storyline, ...storylines.filter((s) => s !== storyline)]), storyline?.title?.en ?? null]
      );
      conceptId = conceptResult.rows[0].id;
      await updateAutoPipelineRun(runId, { concept_id: conceptId });
    }

    if (!deck) {
      await updateAutoPipelineRun(runId, { progress_stage: "pitch-deck" });
      deck = await generatePitchDeckContent(storyline, format);
      // A REAL failure caught in testing: on a revision round, Gemini can
      // silently return a DIFFERENT episode count than requested (seen: 60
      // requested, got 66, then 30, then 33 across successive rounds) — the
      // judge only grades quality, so this drifted through undetected and
      // every downstream stage just inherited the wrong count. This is
      // checked every round as a blocking problem (mustFix), independent of
      // the judge's score, and fails the whole run loudly below rather than
      // completing with silently-wrong data if it's still off after all rounds.
      deck = await reviseUntilGood(runId, "pitch-deck", "Pitch Deck", deck, {
        draftText: pitchDeckJudgeText,
        checklist: STAGE_CHECKLISTS.pitchDeck,
        judgeModel: STORY_JUDGE_MODEL_NAME,
        mustFix: (d) => pitchDeckEpisodeCountIssue(d, format),
        review: async (d) => {
          const [story, hooks] = await Promise.all([
            reviewStoryStage("Pitch Deck", pitchDeckJudgeText(d), STAGE_CHECKLISTS.pitchDeck),
            reviewPitchDeckHooks(d),
          ]);
          return { issues: [...(story.issues ?? []), ...(hooks.issues ?? [])] };
        },
        revise: (d, feedback, opts) => generatePitchDeckContent(storyline, format, { feedback, previous: d, fresh: opts?.fresh }),
        secondBatch: true,
      });
      const finalCountIssue = pitchDeckEpisodeCountIssue(deck, format);
      if (finalCountIssue) {
        throw new Error(
          `Pitch deck episode count is still wrong after ${MAX_AUTO_PIPELINE_REVISION_ROUNDS} attempts: requested ${format.episodeCount}, got ${deck.episodes?.length ?? 0}. Try starting a new run.`
        );
      }
      const pitchDeckResult = await db.query(
        "INSERT INTO pitch_decks (concept_id, content, status) VALUES ($1, $2, 'approved') RETURNING id",
        [conceptId, JSON.stringify(deck)]
      );
      pitchDeckId = pitchDeckResult.rows[0].id;
    }

    if (!characterSheet) {
      await updateAutoPipelineRun(runId, { progress_stage: "character-sheet" });
      characterSheet = await generateCharacterSheetContent(deck);
      await db.query("INSERT INTO character_sheets (pitch_deck_id, content, status) VALUES ($1, $2, 'approved')", [
        pitchDeckId,
        JSON.stringify(characterSheet),
      ]);
    }

    if (!threeAct) {
      await updateAutoPipelineRun(runId, { progress_stage: "three-act" });
      threeAct = await generateThreeActContent(deck, characterSheet);
      // New: the Story Editor + story judge (there was no review here at all).
      threeAct = await reviseUntilGood(runId, "three-act", "Three-Act Structure", threeAct, {
        draftText: threeActJudgeText,
        checklist: STAGE_CHECKLISTS.threeAct,
        judgeModel: STORY_JUDGE_MODEL_NAME,
        review: (d) => reviewStoryStage("Three-Act Structure", threeActJudgeText(d), STAGE_CHECKLISTS.threeAct),
        revise: (d, feedback, opts) => generateThreeActContent(deck, characterSheet, { feedback, previous: d, fresh: opts?.fresh }),
        secondBatch: true,
      });
      if (Array.isArray(deck.episodes)) {
        assertEpisodeCount(threeAct.episodeStructures?.length ?? 0, deck.episodes.length, "Three-act structure");
      }
      const threeActResult = await db.query(
        "INSERT INTO three_act_structures (pitch_deck_id, content, status) VALUES ($1, $2, 'locked') RETURNING id",
        [pitchDeckId, JSON.stringify(threeAct)]
      );
      threeActId = threeActResult.rows[0].id;
    }

    if (!bitSheet) {
      await updateAutoPipelineRun(runId, { progress_stage: "bit-sheet" });
      bitSheet = await generateBitSheetContent(threeAct, deck);
      // New: the Story Editor + story judge (there was no review here at all).
      bitSheet = await reviseUntilGood(runId, "bit-sheet", "Bit Sheet", bitSheet, {
        draftText: bitSheetJudgeText,
        checklist: STAGE_CHECKLISTS.bitSheet,
        judgeModel: STORY_JUDGE_MODEL_NAME,
        review: (d) => reviewStoryStage("Bit Sheet", bitSheetJudgeText(d), STAGE_CHECKLISTS.bitSheet),
        revise: (d, feedback, opts) => generateBitSheetContent(threeAct, deck, { feedback, previous: d, fresh: opts?.fresh }),
        secondBatch: true,
      });
      if (Array.isArray(deck.episodes)) {
        assertEpisodeCount(bitSheet.episodeBits?.length ?? 0, deck.episodes.length, "Bit sheet");
      }
      const bitSheetResult = await db.query(
        "INSERT INTO bit_sheets (three_act_structure_id, content, status) VALUES ($1, $2, 'approved') RETURNING id",
        [threeActId, JSON.stringify(bitSheet)]
      );
      bitSheetId = bitSheetResult.rows[0].id;
    }

    if (!sceneList) {
      await updateAutoPipelineRun(runId, { progress_stage: "scene-list" });
      sceneList = await generateSceneListContent(bitSheet, deck);
      // Story Editor + story judge for every format. The budget check (plain
      // code) only applies to a vertical micro-drama (a 2-3 day shoot) —
      // films and series have no budget cap (the user's call).
      const isVertical = deck.format?.type === "vertical";
      const sceneListChecklist = isVertical
        ? `${STAGE_CHECKLISTS.sceneList}\n- Budget: at most 4-5 distinct locations for the whole series and about 5 main characters (a 2-3 day shoot).`
        : STAGE_CHECKLISTS.sceneList;
      sceneList = await reviseUntilGood(runId, "scene-list", "Scene List", sceneList, {
        draftText: (d) => sceneListJudgeText(d, bitSheet),
        checklist: sceneListChecklist,
        judgeModel: STORY_JUDGE_MODEL_NAME,
        review: async (d) => {
          const story = await reviewStoryStage("Scene List", sceneListJudgeText(d, bitSheet), sceneListChecklist);
          const budget = isVertical ? reviewSceneListBudget(deck, d) : { issues: [] };
          return { issues: [...budget.issues, ...(story.issues ?? [])] };
        },
        revise: (d, feedback, opts) => generateSceneListContent(bitSheet, deck, { feedback, previous: d, fresh: opts?.fresh }),
        secondBatch: true,
      });
      if (Array.isArray(deck.episodes)) {
        assertEpisodeCount(sceneList.episodeScenes?.length ?? 0, deck.episodes.length, "Scene list");
      }
      const sceneListResult = await db.query(
        "INSERT INTO scene_lists (bit_sheet_id, content, status) VALUES ($1, $2, 'approved') RETURNING id",
        [bitSheetId, JSON.stringify(sceneList)]
      );
      sceneListId = sceneListResult.rows[0].id;
      await updateAutoPipelineRun(runId, { scene_list_id: sceneListId });
    }

    await updateAutoPipelineRun(runId, { progress_stage: "screenplay" });

    // Resuming mid-screenplay: scenes already written for this scene list
    // are skipped rather than regenerated (see writeEpisodeScenes below).
    const alreadyWrittenResult = await db.query(
      "SELECT DISTINCT ON (episode_index, scene_index) episode_index, scene_index, content FROM screenplay_scenes WHERE scene_list_id = $1 ORDER BY episode_index, scene_index, created_at DESC",
      [sceneListId]
    );
    const alreadyWritten = new Map(
      alreadyWrittenResult.rows.map((row) => [`${row.episode_index}:${row.scene_index}`, row.content])
    );

    await runScreenplayAndQualityPass(runId, deck, sceneList, sceneListId, dialogueLanguage, alreadyWritten);
    await updateAutoPipelineRun(runId, { status: "completed", progress_stage: "done" });
  } catch (error) {
    console.error("Auto-pipeline run failed:", runId, error);
    await updateAutoPipelineRun(runId, { status: "failed", error: friendlyGeminiErrorMessage(error.message) }).catch(() => {});
  }
}

// Step 3 — the Script Editor. Once every scene is written, the screenplay
// is read in sequences (up to 8 scenes together: within one act for a film,
// whole neighbouring episodes for a series). For each, the editor finds the
// weak scenes, the judge scores the sequence, and below the pass mark up to
// 3 flagged scenes are rewritten with their specific fix — the same
// writer -> reviewer -> judge -> revise loop (reviseUntilGood), keeping the
// best version. It replaces the old dialogue spot-check (the first scene of
// every 5th episode only), so every scene is now read by an editor.
const SEQUENCE_MAX_SCENES = 8;
const SEQUENCE_REWRITES_PER_ROUND = 3;

// What the story is — given to every script reviewer. Seen for real: a
// dialogue judge that wasn't told the story called its own sacred dance's
// name an "invented-sounding word".
function screenplayStoryContext(deck) {
  const characters = (deck.majorCharacters ?? []).map((c) => `${c.name} — ${c.role?.en ?? ""}`).join("; ");
  return `STORY: "${deck.title?.en ?? ""}" — ${deck.logline?.en ?? ""}\nMAIN CHARACTERS: ${characters}\nNames, places, rituals, dances and other terms that come from this story (including its title) are the story's own — never call them invented or wrong.`;
}

function buildScreenplaySequences(sceneList, written) {
  const sequences = [];
  const addChunks = (items, describe) => {
    for (let i = 0; i < items.length; i += SEQUENCE_MAX_SCENES) {
      const chunk = items.slice(i, i + SEQUENCE_MAX_SCENES);
      sequences.push({ items: chunk, where: describe(chunk) });
    }
  };
  if (Array.isArray(sceneList.episodeScenes)) {
    const episodesText = (chunk) => {
      const first = chunk[0].episodeIndex + 1;
      const last = chunk[chunk.length - 1].episodeIndex + 1;
      return first === last ? `episode ${first}` : `episodes ${first}-${last}`;
    };
    let current = [];
    sceneList.episodeScenes.forEach((episode, e) => {
      const items = (episode.scenes ?? [])
        .map((scene, s) => ({ episodeIndex: e, sceneIndex: s, scenes: episode.scenes, content: written.get(`${e}:${s}`) }))
        .filter((item) => item.content);
      if (items.length === 0) return;
      if (current.length > 0 && current.length + items.length > SEQUENCE_MAX_SCENES) {
        addChunks(current, episodesText);
        current = [];
      }
      if (items.length > SEQUENCE_MAX_SCENES) addChunks(items, episodesText);
      else current.push(...items);
    });
    if (current.length > 0) addChunks(current, episodesText);
  } else {
    const scenes = sceneList.scenes ?? [];
    let act = null;
    let current = [];
    const actText = (chunk) => `Act ${chunk[0].scenes[chunk[0].sceneIndex].actNumber ?? "?"}`;
    scenes.forEach((scene, s) => {
      const content = written.get(`null:${s}`);
      if (!content) return;
      if (act !== null && scene.actNumber !== act && current.length > 0) {
        addChunks(current, actText);
        current = [];
      }
      act = scene.actNumber;
      current.push({ episodeIndex: null, sceneIndex: s, scenes, content });
    });
    if (current.length > 0) addChunks(current, actText);
  }
  return sequences;
}

function sequenceDraftText(deck, items, contents) {
  const body = items
    .map((item, i) => {
      const scene = item.scenes[item.sceneIndex];
      const lines = (contents[i].elements ?? [])
        .map((el) =>
          el.type === "dialogue"
            ? `${el.character}${el.parenthetical ? ` (${el.parenthetical})` : ""}: ${el.text}`
            : `[${el.type === "transition" ? "TRANSITION" : "ACTION"}] ${el.text}`
        )
        .join("\n");
      return `SCENE ${i + 1}${item.episodeIndex !== null ? ` (episode ${item.episodeIndex + 1})` : ""} — ${scene.intExt}. ${scene.location?.en ?? ""} — ${scene.timeOfDay}\nPlanned: ${scene.oneLiner?.en ?? ""}\n${lines}`;
    })
    .join("\n\n");
  return capJudgeText(`${screenplayStoryContext(deck)}\n\n${body}`);
}

function sequenceChecklist(dialogueLanguage) {
  const language = MOVIE_LANGUAGE_NAMES[dialogueLanguage] ?? "English";
  return `- Every scene has a turn — something changes by its end; no scene just repeats what an earlier one did.
- Dialogue is natural, spoken ${language} — how these people really talk: short, with subtext; never speeches, lectures, or exposition telling the audience what it already knows.
- Each character keeps one consistent voice.
- Continuity from scene to scene: who is where, time of day, what each character already knows.
- Action lines show only what the camera can see and hear.
- Acting notes stay in brackets, never inside the spoken line.
- Each scene does what its plan ("Planned:") says.`;
}

async function reviewScreenplaySequence(draftText, checklist) {
  return generateJsonContent({
    model: STORY_JUDGE_MODEL_NAME,
    contents: `You are a demanding script editor reading a sequence of consecutive scenes from a screenplay in development.\n\n${draftText}\n\nCheck it against this checklist:\n${checklist}\n\nReturn "issues": the real problems, each naming its scene number, most important first (at most 8); and "sceneFixes": for each scene that genuinely needs rewriting (at most ${SEQUENCE_REWRITES_PER_ROUND}, the most important first), its number and exactly what to change. Every issue must belong to a scene in sceneFixes. Only genuine problems, never style preferences; if the sequence is genuinely strong, return both empty.`,
    config: {
      systemInstruction: "You are a meticulous, experienced script editor. Strict but fair, specific and constructive.",
      responseMimeType: "application/json",
      maxOutputTokens: 16384,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          issues: { type: Type.ARRAY, items: { type: Type.STRING } },
          sceneFixes: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { scene: { type: Type.INTEGER }, fix: { type: Type.STRING } },
              required: ["scene", "fix"],
            },
          },
        },
        required: ["issues", "sceneFixes"],
      },
    },
  });
}

async function runSequenceReview(runId, deck, sceneList, sceneListId, dialogueLanguage) {
  await updateAutoPipelineRun(runId, { progress_stage: "sequence-review" });
  const rows = (
    await db.query(
      `SELECT DISTINCT ON (episode_index, scene_index) episode_index, scene_index, content
       FROM screenplay_scenes WHERE scene_list_id = $1 ORDER BY episode_index, scene_index, created_at DESC`,
      [sceneListId]
    )
  ).rows;
  const written = new Map(rows.filter((row) => row.content?.elements?.length).map((row) => [`${row.episode_index}:${row.scene_index}`, row.content]));
  const sequences = buildScreenplaySequences(sceneList, written);
  const checklist = sequenceChecklist(dialogueLanguage);
  let rewritten = 0;

  for (let n = 0; n < sequences.length; n++) {
    const { items, where } = sequences[n];
    const label = `Sequence ${n + 1} of ${sequences.length} (${where}, ${items.length} scenes)`;
    await appendAutoPipelineNote(runId, "sequence-review", `${label}: the script editor is reading it.`);
    try {
      const original = items.map((item) => item.content);
      let latestFixes = [];
      const best = await reviseUntilGood(runId, "sequence-review", `Screenplay ${label}`, original, {
        draftText: (contents) => sequenceDraftText(deck, items, contents),
        checklist,
        judgeModel: STORY_JUDGE_MODEL_NAME,
        review: async (contents) => {
          const reviewed = await reviewScreenplaySequence(sequenceDraftText(deck, items, contents), checklist);
          latestFixes = (reviewed.sceneFixes ?? [])
            .map((f) => ({ index: Math.round(Number(f.scene)) - 1, fix: f.fix }))
            .filter((f) => f.index >= 0 && f.index < items.length && f.fix)
            .slice(0, SEQUENCE_REWRITES_PER_ROUND);
          return { issues: reviewed.issues ?? [] };
        },
        revise: async (contents, feedback) => {
          const next = [...contents];
          for (const { index, fix } of latestFixes) {
            const item = items[index];
            const previousElements = index > 0 ? next[index - 1].elements : null;
            try {
              next[index] = await generateScreenplaySceneContent(
                deck, item.scenes, item.sceneIndex, previousElements, sceneList.controllingIdea,
                { feedback: `${fix} (The script editor's overall note on this sequence: ${feedback})`, previous: contents[index] },
                dialogueLanguage, []
              );
            } catch (error) {
              console.error(`Auto-pipeline ${runId}: sequence rewrite failed:`, error.message);
            }
            await touchAutoPipelineRun(runId);
          }
          return next;
        },
      });
      for (let i = 0; i < items.length; i++) {
        if (best[i] === original[i]) continue;
        await db.query(
          "INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content) VALUES ($1, $2, $3, $4)",
          [sceneListId, items[i].episodeIndex, items[i].sceneIndex, JSON.stringify(best[i])]
        );
        rewritten++;
      }
    } catch (error) {
      // A failed review never stops the run: the scenes stay as written.
      console.error(`Auto-pipeline ${runId}: sequence review failed:`, error.message);
      await appendAutoPipelineNote(runId, "sequence-review", `${label}: the review could not finish — its scenes are kept as written.`);
    }
  }
  await appendAutoPipelineNote(runId, "sequence-review", `Script editor done: ${sequences.length} sequence(s) read, ${rewritten} scene(s) rewritten.`);
}

// Step 3 — the same full language check as the Movie screen's "Check full
// script" (grammar, spelling, natural spoken dialogue in its own script),
// run once over the finished screenplay. It saves each corrected scene as
// a new version, so nothing is lost.
async function runFinalLanguageCheck(runId, sceneListId) {
  await updateAutoPipelineRun(runId, { progress_stage: "language-check" });
  const state = { status: "running", report: [], doneScenes: 0, totalScenes: 0 };
  // The check writes no run updates of its own; without this heartbeat a
  // long script would look dead to the stale-run reaper.
  const heartbeat = setInterval(() => touchAutoPipelineRun(runId).catch(() => {}), 60_000);
  try {
    await runMovieScriptCheck(sceneListId, state);
  } finally {
    clearInterval(heartbeat);
  }
  const corrected = state.report.filter((entry) => entry.changed > 0).length;
  const failed = state.report.filter((entry) => entry.error).length;
  await appendAutoPipelineNote(
    runId,
    "language-check",
    state.status === "error"
      ? "The final language check could not run — the script is kept as written."
      : `Language check: ${corrected} of ${state.report.length} scene(s) corrected${failed ? `; ${failed} could not be checked` : ""}.`
  );
}

// Shared by runAutoPipeline (fresh/resumed run, respects alreadyWritten so a
// resume doesn't rewrite scenes that already succeeded) and
// regenerateScreenplayInLanguage below (a completed run's story/structure is
// reused as-is — only the dialogue language differs — so it's called with
// an empty alreadyWritten map to force every scene to regenerate). Writes
// every episode's screenplay scenes, then runs the whole-script repetition
// quality gate; does NOT itself mark the run completed/failed, since the two
// callers want different final progress_stage values around it.
async function runScreenplayAndQualityPass(runId, deck, sceneList, sceneListId, dialogueLanguage, alreadyWritten) {
    // Shared across every scene/episode of this one run (episodes write
    // concurrently, but JS's single-threaded event loop means plain
    // read-then-append on this Map is safe — an approximate, best-effort
    // avoid-list is all this needs to be useful) so later scenes get warned
    // off phrases already leaned on earlier in the same script.
    const phraseTracker = createPhraseTracker();
    for (const content of alreadyWritten.values()) phraseTracker.recordElements(content.elements);
    const skippedScenes = [];

    async function writeEpisodeScenes(scenes, episodeIndex) {
      let previousElements = null;
      for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex++) {
        const existing = alreadyWritten.get(`${episodeIndex}:${sceneIndex}`);
        if (existing) {
          previousElements = existing.elements;
          continue;
        }
        const avoidPhrases = phraseTracker.topOverused();
        const sceneLabel = episodeIndex === null ? `Scene ${sceneIndex + 1}` : `Episode ${episodeIndex + 1}, scene ${sceneIndex + 1}`;
        let content;
        try {
          content = await generateScreenplaySceneContent(
            deck, scenes, sceneIndex, previousElements, sceneList.controllingIdea, undefined, dialogueLanguage, avoidPhrases
          );
        } catch (error) {
          // One scene that still fails after every retry no longer stops the
          // whole run (seen for real: a cut-off answer killed a run). It's
          // skipped and noted; it shows as "not written" on the Movie screen
          // (one click to write it there). If the run fails later anyway,
          // Resume tries it again.
          console.error(`Auto-pipeline ${runId}: ${sceneLabel} could not be written:`, error.message);
          skippedScenes.push(sceneLabel);
          await appendAutoPipelineNote(runId, "screenplay", `${sceneLabel} could not be written (${friendlyGeminiErrorMessage(error.message)}) — skipped; the rest of the script carries on.`);
          continue;
        }
        // Every scene is now read by the Script Editor after the whole
        // screenplay is written (runSequenceReview) — the old dialogue
        // spot-check of one scene in five is gone.
        phraseTracker.recordElements(content.elements);
        await db.query(
          "INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content) VALUES ($1, $2, $3, $4)",
          [sceneListId, episodeIndex, sceneIndex, JSON.stringify(content)]
        );
        // Judge notes only land every 5th episode, so without this a long
        // screenplay phase could go many minutes between any row update —
        // exactly what the stale-run reaper (below) would otherwise
        // mistake for a dead run and fail out from under a healthy one.
        await touchAutoPipelineRun(runId);
        previousElements = content.elements;
      }
    }

    if (Array.isArray(sceneList.episodeScenes)) {
      const episodeIndexes = deck.episodes.map((_, i) => i);
      await mapWithConcurrency(episodeIndexes, AUTO_PIPELINE_SCREENPLAY_CONCURRENCY, (episodeIndex) =>
        writeEpisodeScenes(sceneList.episodeScenes[episodeIndex].scenes, episodeIndex)
      );
    } else {
      await writeEpisodeScenes(sceneList.scenes, null);
    }

    // Final quality gate (Reviewer 4 / judge, reused): every prior review
    // above only ever looked at a sample of individual scenes, so a stock
    // phrase reused dozens of times across a 50+ episode script — exactly
    // what real editorial passes on this pipeline's output flagged — could
    // never be caught until now. This is the one pass that reads the WHOLE
    // finished screenplay and can trigger a targeted rewrite of just the
    // worst-offending scenes rather than a full regeneration.
    await runSequenceReview(runId, deck, sceneList, sceneListId, dialogueLanguage);

    await updateAutoPipelineRun(runId, { progress_stage: "quality-pass" });
    // A failure in this final polish never throws away the finished script:
    // the scenes already written simply stay as they are.
    try {
      for (let round = 0; round < MAX_AUTO_PIPELINE_REVISION_ROUNDS; round++) {
        const allScenesResult = await db.query(
          `SELECT DISTINCT ON (episode_index, scene_index) id, episode_index, scene_index, content
           FROM screenplay_scenes WHERE scene_list_id = $1
           ORDER BY episode_index, scene_index, created_at DESC`,
          [sceneListId]
        );
        const repetitionReview = reviewScreenplayRepetition(allScenesResult.rows);
        const summary = `${allScenesResult.rows.length} scenes checked across the full finished screenplay for reused stock description.`;
        const judged = await scorePipelineStage("Screenplay prose variety (full script)", summary, repetitionReview.issues);
        await appendAutoPipelineNote(runId, "screenplay", `Judge score: ${judged.score}/10 — ${judged.verdict}`);
        if (judged.score >= PASS_SCORE || repetitionReview.offendingScenes.length === 0 || round === MAX_AUTO_PIPELINE_REVISION_ROUNDS - 1) break;

        // Cap how many scenes get rewritten in one round — a handful of the
        // worst offenders is enough to break the pattern without redoing the
        // whole script every round.
        const scenesToRewrite = repetitionReview.offendingScenes.slice(0, 15);
        for (const row of scenesToRewrite) {
          const scenesForEpisode =
            row.episode_index === null ? sceneList.scenes : sceneList.episodeScenes[row.episode_index].scenes;
          let revised;
          try {
            revised = await generateScreenplaySceneContent(
              deck, scenesForEpisode, row.scene_index, null, sceneList.controllingIdea,
              {
                feedback: `This scene reuses generic description already overused elsewhere in the script: ${repetitionReview.overusedPhrases.join(", ")}. Rewrite the action lines with fresh, specific description grounded in this scene's own moment.`,
                previous: row.content,
              },
              dialogueLanguage,
              repetitionReview.overusedPhrases
            );
          } catch (error) {
            console.error(`Auto-pipeline ${runId}: quality-pass rewrite failed:`, error.message);
            continue; // keep this scene as it was
          }
          await db.query(
            "INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content) VALUES ($1, $2, $3, $4)",
            [sceneListId, row.episode_index, row.scene_index, JSON.stringify(revised)]
          );
          await touchAutoPipelineRun(runId);
        }
      }
    } catch (error) {
      console.error(`Auto-pipeline ${runId}: quality pass failed:`, error.message);
      await appendAutoPipelineNote(runId, "quality-pass", "The final quality pass could not finish — the script is kept as written.");
    }

    try {
      await runFinalLanguageCheck(runId, sceneListId);
    } catch (error) {
      console.error(`Auto-pipeline ${runId}: language check failed:`, error.message);
    }

    if (skippedScenes.length > 0) {
      await appendAutoPipelineNote(
        runId,
        "screenplay",
        `${skippedScenes.length} scene(s) could not be written: ${skippedScenes.join("; ")}. Open this project's Screenplay to write them — they show as "not written", with a Write This Scene button.`
      );
    }
}

app.post("/api/auto-pipeline/start", requireRole("admin"), async (req, res) => {
  const { concept, format: rawFormat, dialogueLanguage: rawDialogueLanguage } = req.body;

  if (!concept?.trim()) {
    res.status(400).json({ error: "A concept is required." });
    return;
  }

  const format =
    rawFormat?.type === "vertical"
      ? { type: "vertical", episodeCount: Number(rawFormat.episodeCount) || 60, episodeMinutes: Number(rawFormat.episodeMinutes) || 1.5 }
      : rawFormat?.type === "series"
        ? { type: "series", episodeCount: Number(rawFormat.episodeCount) || 10, episodeMinutes: Number(rawFormat.episodeMinutes) || 10 }
        : { type: "film", runtimeMinutes: Number(rawFormat?.runtimeMinutes) || 120 };
  const dialogueLanguage = ["en", "hi"].includes(rawDialogueLanguage) ? rawDialogueLanguage : "or";

  try {
    const insertResult = await db.query(
      "INSERT INTO auto_pipeline_runs (concept_text, format, status, progress_stage, created_by, dialogue_language) VALUES ($1, $2, 'running', 'starting', $3, $4) RETURNING id",
      [concept, JSON.stringify(format), req.user.id, dialogueLanguage]
    );
    const runId = insertResult.rows[0].id;

    // Deliberately not awaited — see runAutoPipeline's own comment.
    runAutoPipeline(runId, concept, format, dialogueLanguage);

    res.json({ runId });
  } catch (error) {
    console.error("Failed to start auto-pipeline run:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Picks a failed run back up from the last stage that actually finished,
// instead of regenerating everything from scratch — each stage's own DB
// row only ever gets inserted once that stage fully succeeds, so "does this
// row exist yet" is already an exact, free checkpoint marker; no separate
// progress-tracking scheme needed.
app.post("/api/auto-pipeline/:id/resume", requireRole("admin"), async (req, res) => {
  const runResult = await db.query("SELECT * FROM auto_pipeline_runs WHERE id = $1", [req.params.id]);
  const run = runResult.rows[0];

  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  if (run.status !== "failed") {
    res.status(400).json({ error: "Only a failed run can be resumed." });
    return;
  }
  if (!run.concept_id) {
    res.status(400).json({ error: "This run failed before any progress was saved — start a new run instead." });
    return;
  }

  await db.query("UPDATE auto_pipeline_runs SET status = 'running', error = NULL WHERE id = $1", [run.id]);

  // Deliberately not awaited — see runAutoPipeline's own comment.
  runAutoPipeline(run.id, run.concept_text, run.format, run.dialogue_language, run.concept_id);

  res.json({ runId: run.id });
});

// Odia is the base/canonical dialogue language for the auto-pipeline (see
// buildScreenplaySystemPrompt) — Hindi/English are produced by translating
// that same Odia dialogue on export instead of independently regenerating
// it, so the translated version stays faithful to the original creative
// content rather than potentially drifting from it. Only dialogue and
// parenthetical text are translated; action/transition/flashback text is
// already plain English by convention and character names never change.
const TRANSLATION_LANGUAGE_LABELS = {
  en: "English",
  or: "Odia (Oriya script)",
  hi: "Hindi (Devanagari script)",
};

// Works between ANY two of the app's three dialogue languages — Odia is
// the default for a NEW run, but an older run (or one where a different
// language was picked deliberately) can have any of the three as its real
// source, and this needs to translate correctly starting from whichever
// one that actually is, not just "from Odia".
async function translateScreenplaySceneElements(elements, sourceLanguage, targetLanguage) {
  const dialogueIndexes = elements
    .map((el, i) => (el.type === "dialogue" && el.text ? i : null))
    .filter((i) => i !== null);
  if (dialogueIndexes.length === 0) return elements;

  const sourceLabel = TRANSLATION_LANGUAGE_LABELS[sourceLanguage] ?? "the source language";
  const targetLabel = TRANSLATION_LANGUAGE_LABELS[targetLanguage] ?? "English";
  const lines = dialogueIndexes.map((i, n) => {
    const el = elements[i];
    return `${n + 1}. ${el.text}${el.parenthetical ? ` [parenthetical: ${el.parenthetical}]` : ""}`;
  });

  const parsed = await generateJsonContent({
    model: GEMINI_MODEL_NAME,
    contents: `Translate ONLY these screenplay dialogue lines from ${sourceLabel} into natural, spoken ${targetLabel} — the way a person would actually say the same thing, never a stiff literal translation. Preserve the exact meaning, tone, and emotional register of each line. Return them in the same order, one per input line.\n\n${lines.join("\n")}`,
    config: {
      systemInstruction: `You are an expert screenplay translator producing natural, spoken ${targetLabel} dialogue translated faithfully from ${sourceLabel} — never a robotic word-for-word translation.`,
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          lines: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { text: { type: Type.STRING }, parenthetical: { type: Type.STRING } },
              required: ["text"],
            },
          },
        },
        required: ["lines"],
      },
    },
  });

  const translated = [...elements];
  dialogueIndexes.forEach((i, n) => {
    const line = parsed.lines?.[n];
    if (!line) return;
    translated[i] = { ...translated[i], text: line.text, parenthetical: line.parenthetical || translated[i].parenthetical };
  });
  return translated;
}

app.get("/api/auto-pipeline/runs", requireLogin, async (req, res) => {
  // Scoped to the logged-in user (not every admin's runs) — the frontend
  // uses this to sync "my currently active run" across devices/browsers
  // under the same login, and a different admin's in-progress run showing
  // up here would be adopted just the same way, which isn't what's wanted.
  const result = await db.query(
    "SELECT id, concept_text, status, progress_stage, concept_id, created_at FROM auto_pipeline_runs WHERE created_by = $1 ORDER BY created_at DESC LIMIT 20",
    [req.user.id]
  );
  res.json(
    result.rows.map((row) => ({
      id: row.id,
      conceptText: row.concept_text,
      status: row.status,
      progressStage: row.progress_stage,
      conceptId: row.concept_id,
      createdAt: row.created_at,
    }))
  );
});

app.get("/api/auto-pipeline/:id/status", requireLogin, async (req, res) => {
  const result = await db.query(
    "SELECT id, concept_text, format, status, progress_stage, review_notes, concept_id, scene_list_id, error, created_at, updated_at FROM auto_pipeline_runs WHERE id = $1",
    [req.params.id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  const row = result.rows[0];
  res.json({
    id: row.id,
    conceptText: row.concept_text,
    format: row.format,
    status: row.status,
    progressStage: row.progress_stage,
    reviewNotes: row.review_notes,
    conceptId: row.concept_id,
    sceneListId: row.scene_list_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

// character isn't in SCREENPLAY_ELEMENT_SCHEMA's required list (only type
// and text are) — a real 60-episode run surfaced a dialogue element Gemini
// generated without one, which crashed both full-screenplay exports on
// `.toUpperCase()`. Used everywhere a heading-style field gets uppercased,
// rather than trusting every such field is always present.
function safeUpper(value, fallback) {
  return (value && String(value).trim()) || fallback;
}

// Renders every episode's every scene, in order, as one continuous
// screenplay document — scene heading, action, character/dialogue,
// parenthetical, transition — using standard screenplay column positions.
// Unlike the per-character "Character Script" export, this is the FULL
// script, meant to be read start to finish, not filtered to one actor.
function renderFullScreenplayPdf(res, deck, sceneList, scenesByEpisode) {
  const isSeries = Array.isArray(sceneList.episodeScenes);
  const margin = 72; // 1 inch, standard screenplay margin
  const doc = new PDFDocument({ size: "LETTER", margin });
  doc.registerFont("odiaRegular", FONTS.odiaRegular);
  doc.registerFont("odiaBold", FONTS.odiaBold);
  doc.registerFont("hindiRegular", FONTS.hindiRegular);
  doc.registerFont("hindiBold", FONTS.hindiBold);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${(deck.title?.en ?? "screenplay").replace(/[^a-z0-9]+/gi, "-")}-full-screenplay-${formatExportTimestamp()}.pdf"`
  );
  doc.pipe(res);

  const fontFor = (dialogueLanguage) =>
    dialogueLanguage === "or"
      ? { body: "odiaRegular", bold: "odiaBold" }
      : dialogueLanguage === "hi"
        ? { body: "hindiRegular", bold: "hindiBold" }
        : { body: "Courier", bold: "Courier-Bold" };

  // Title page
  doc.font("Courier-Bold").fontSize(28).text(deck.title?.en ?? "Untitled", { align: "center" });
  doc.moveDown(1);
  doc.font("Courier").fontSize(13).text(deck.logline?.en ?? "", { align: "center" });

  const actionWidth = doc.page.width - margin * 2;
  const dialogueIndent = margin + 108; // ~1.5in in from the action margin
  const dialogueWidth = 260;
  const characterIndent = margin + 155;

  const writeScene = (scene, sceneIndex, elements, dialogueLanguage, charactersPresent) => {
    const fonts = fontFor(dialogueLanguage);
    doc.addPage();
    doc
      .font("Courier-Bold")
      .fontSize(12)
      .text(`${sceneIndex + 1}. ${scene.intExt}. ${safeUpper(scene.location?.en, "LOCATION")} — ${scene.timeOfDay}`, margin, doc.y, {
        width: actionWidth,
      });
    doc.moveDown(0.4);
    if (charactersPresent?.length > 0) {
      doc.font("Courier").fontSize(9).text(`Characters: ${charactersPresent.join(", ")}`, margin, doc.y, { width: actionWidth });
      doc.moveDown(0.4);
    }
    doc.moveDown(0.4);

    elements.forEach((element) => {
      const text = element.text ?? "";
      if (element.type === "dialogue") {
        const modifier = element.characterModifier && element.characterModifier !== "none" ? ` (${element.characterModifier})` : "";
        doc.font("Courier-Bold").fontSize(11).text(`${safeUpper(element.character, "CHARACTER")}${modifier}`, characterIndent, doc.y, {
          width: dialogueWidth,
        });
        if (element.parenthetical) {
          doc.font(fonts.body).fontSize(10).text(`(${element.parenthetical})`, dialogueIndent, doc.y, { width: dialogueWidth });
        }
        doc.font(fonts.body).fontSize(11).text(text, dialogueIndent, doc.y, { width: dialogueWidth });
        doc.moveDown(0.7);
      } else if (element.type === "transition") {
        doc.font("Courier-Bold").fontSize(11).text(text, margin, doc.y, { width: actionWidth, align: "right" });
        doc.moveDown(0.7);
      } else if (element.type === "flashback") {
        doc
          .font("Courier-Bold")
          .fontSize(11)
          .text(`FLASH - ${safeUpper(element.character, "CHARACTER")}'S POV:`, margin, doc.y, { width: actionWidth, continued: true })
          .font("Courier")
          .text(` ${text}`, { width: actionWidth });
        doc.moveDown(0.7);
      } else {
        doc.font("Courier").fontSize(11).text(text, margin, doc.y, { width: actionWidth });
        doc.moveDown(0.7);
      }
    });
  };

  if (isSeries) {
    deck.episodes.forEach((episode, episodeIndex) => {
      doc.addPage();
      doc.font("Courier-Bold").fontSize(18).text(`EPISODE ${episodeIndex + 1}: ${safeUpper(episode.title?.en, "UNTITLED")}`, { align: "center" });
      const scenes = sceneList.episodeScenes[episodeIndex]?.scenes ?? [];
      const episodeScenes = scenesByEpisode.get(episodeIndex) ?? [];
      scenes.forEach((scene, sceneIndex) => {
        const row = episodeScenes.find((r) => r.scene_index === sceneIndex);
        if (!row) return;
        writeScene(scene, sceneIndex, row.content.elements, row.content.dialogueLanguage, row.content.charactersPresent);
      });
    });
  } else {
    const filmScenes = scenesByEpisode.get(null) ?? [];
    sceneList.scenes.forEach((scene, sceneIndex) => {
      const row = filmScenes.find((r) => r.scene_index === sceneIndex);
      if (!row) return;
      writeScene(scene, sceneIndex, row.content.elements, row.content.dialogueLanguage, row.content.charactersPresent);
    });
  }

  doc.end();
}

// Shared by both the PDF and Word full-screenplay exports — fetches the
// completed run's scene list/deck and every screenplay scene actually
// written (latest revision per position), or returns an { error, status }
// pair for the route to relay directly.
// Auto-pipeline's default/canonical export is Odia — Hindi/English are
// available on demand by translating that same Odia dialogue rather than
// generating it independently (see translateScreenplaySceneElements). Only
// runs on the scenes that actually need it (a scene already in the
// requested language is left untouched), and runs with real concurrency
// since a 60-episode script can be 150+ scenes.
const SCREENPLAY_TRANSLATION_CONCURRENCY = 6;

async function translateScreenplayScenesByEpisode(scenesByEpisode, targetLang) {
  // Odia is the default for a NEW run, but an older run (like the very
  // first ones, generated before Odia became the default) can genuinely
  // have English or Hindi as its real dialogueLanguage — this used to
  // assume the source was always Odia and silently no-op for anything
  // else, which is exactly why picking "Odia" to download an English run
  // still came back in English. Each scene is translated FROM its own
  // actual stored language, whatever that is, TO whatever was requested.
  const allRows = [...scenesByEpisode.values()].flat();
  const rowsToTranslate = allRows.filter((row) => (row.content.dialogueLanguage ?? "or") !== targetLang);
  if (rowsToTranslate.length === 0) return;

  await mapWithConcurrency(rowsToTranslate, SCREENPLAY_TRANSLATION_CONCURRENCY, async (row) => {
    const sourceLang = row.content.dialogueLanguage ?? "or";
    row.content = {
      ...row.content,
      elements: await translateScreenplaySceneElements(row.content.elements, sourceLang, targetLang),
      dialogueLanguage: targetLang,
    };
  });
}

async function fetchAutoPipelineScreenplayData(runId, targetLang) {
  const runResult = await db.query("SELECT scene_list_id, status FROM auto_pipeline_runs WHERE id = $1", [runId]);
  if (runResult.rows.length === 0) {
    return { error: "Run not found", status: 404 };
  }
  const { scene_list_id: sceneListId, status } = runResult.rows[0];
  if (status !== "completed" || !sceneListId) {
    return { error: "This run hasn't finished yet.", status: 400 };
  }

  const sceneListResult = await db.query(
    `SELECT sl.content AS scene_list_content, pd.content AS pitch_deck_content
     FROM scene_lists sl
     JOIN bit_sheets bs ON bs.id = sl.bit_sheet_id
     JOIN three_act_structures tas ON tas.id = bs.three_act_structure_id
     JOIN pitch_decks pd ON pd.id = tas.pitch_deck_id
     WHERE sl.id = $1`,
    [sceneListId]
  );
  if (sceneListResult.rows.length === 0) {
    return { error: "Scene list not found", status: 404 };
  }
  const { scene_list_content: sceneList, pitch_deck_content: deck } = sceneListResult.rows[0];

  const scenesResult = await db.query(
    `SELECT DISTINCT ON (episode_index, scene_index) episode_index, scene_index, content, created_at
     FROM screenplay_scenes
     WHERE scene_list_id = $1
     ORDER BY episode_index, scene_index, created_at DESC`,
    [sceneListId]
  );
  const scenesByEpisode = new Map();
  scenesResult.rows.forEach((row) => {
    const key = row.episode_index;
    if (!scenesByEpisode.has(key)) scenesByEpisode.set(key, []);
    scenesByEpisode.get(key).push(row);
  });

  if (targetLang) {
    await translateScreenplayScenesByEpisode(scenesByEpisode, targetLang);
  }

  return { deck, sceneList, scenesByEpisode };
}

app.get("/api/auto-pipeline/:id/screenplay-pdf", requireLogin, async (req, res) => {
  const targetLang = ["en", "hi"].includes(req.query.lang) ? req.query.lang : "or";
  const data = await fetchAutoPipelineScreenplayData(req.params.id, targetLang);
  if (data.error) {
    res.status(data.status).json({ error: data.error });
    return;
  }

  try {
    renderFullScreenplayPdf(res, data.deck, data.sceneList, data.scenesByEpisode);
  } catch (error) {
    console.error("Full screenplay PDF export failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
});

// Same content and scene-by-scene structure as the PDF export, laid out as
// a Word document instead — plain paragraphs styled to read like a
// screenplay (centered/bold character names, an indented dialogue column,
// right-aligned transitions) since Word has no page-layout primitives like
// PDFKit's explicit x/y positioning.
function buildFullScreenplayDocxParagraphs(deck, sceneList, scenesByEpisode) {
  const isSeries = Array.isArray(sceneList.episodeScenes);
  const paragraphs = [];

  paragraphs.push(
    new Paragraph({
      text: deck.title?.en ?? "Untitled",
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({
      children: [new TextRun({ text: deck.logline?.en ?? "", italics: true })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    })
  );

  const writeScene = (scene, sceneIndex, elements, charactersPresent) => {
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `${sceneIndex + 1}. ${scene.intExt}. ${safeUpper(scene.location?.en, "LOCATION")} — ${scene.timeOfDay}`,
            bold: true,
          }),
        ],
        spacing: { before: 300, after: charactersPresent?.length > 0 ? 50 : 200 },
      })
    );

    if (charactersPresent?.length > 0) {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun({ text: `Characters: ${charactersPresent.join(", ")}`, italics: true, size: 18 })],
          spacing: { after: 200 },
        })
      );
    }

    elements.forEach((element) => {
      const text = element.text ?? "";
      if (element.type === "dialogue") {
        const modifier = element.characterModifier && element.characterModifier !== "none" ? ` (${element.characterModifier})` : "";
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text: `${safeUpper(element.character, "CHARACTER")}${modifier}`, bold: true })],
            alignment: AlignmentType.CENTER,
            spacing: { before: 200 },
          })
        );
        if (element.parenthetical) {
          paragraphs.push(
            new Paragraph({
              children: [new TextRun({ text: `(${element.parenthetical})`, italics: true })],
              alignment: AlignmentType.CENTER,
              indent: { left: 1440, right: 1440 },
            })
          );
        }
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text })],
            indent: { left: 1440, right: 1440 },
          })
        );
      } else if (element.type === "transition") {
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text, bold: true })],
            alignment: AlignmentType.RIGHT,
            spacing: { before: 200 },
          })
        );
      } else if (element.type === "flashback") {
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text: `FLASH - ${safeUpper(element.character, "CHARACTER")}'S POV: `, bold: true }), new TextRun({ text })],
          })
        );
      } else {
        paragraphs.push(new Paragraph({ children: [new TextRun({ text })], spacing: { after: 120 } }));
      }
    });
  };

  if (isSeries) {
    deck.episodes.forEach((episode, episodeIndex) => {
      paragraphs.push(
        new Paragraph({
          text: `EPISODE ${episodeIndex + 1}: ${safeUpper(episode.title?.en, "UNTITLED")}`,
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          pageBreakBefore: true,
        })
      );
      const scenes = sceneList.episodeScenes[episodeIndex]?.scenes ?? [];
      const episodeScenes = scenesByEpisode.get(episodeIndex) ?? [];
      scenes.forEach((scene, sceneIndex) => {
        const row = episodeScenes.find((r) => r.scene_index === sceneIndex);
        if (!row) return;
        writeScene(scene, sceneIndex, row.content.elements, row.content.charactersPresent);
      });
    });
  } else {
    const filmScenes = scenesByEpisode.get(null) ?? [];
    sceneList.scenes.forEach((scene, sceneIndex) => {
      const row = filmScenes.find((r) => r.scene_index === sceneIndex);
      if (!row) return;
      writeScene(scene, sceneIndex, row.content.elements, row.content.charactersPresent);
    });
  }

  return paragraphs;
}

app.get("/api/auto-pipeline/:id/screenplay-docx", requireLogin, async (req, res) => {
  const targetLang = ["en", "hi"].includes(req.query.lang) ? req.query.lang : "or";
  const data = await fetchAutoPipelineScreenplayData(req.params.id, targetLang);
  if (data.error) {
    res.status(data.status).json({ error: data.error });
    return;
  }

  try {
    const paragraphs = buildFullScreenplayDocxParagraphs(data.deck, data.sceneList, data.scenesByEpisode);
    const document = new Document({ sections: [{ children: paragraphs }] });
    const buffer = await Packer.toBuffer(document);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${(data.deck.title?.en ?? "screenplay").replace(/[^a-z0-9]+/gi, "-")}-full-screenplay-${formatExportTimestamp()}.docx"`
    );
    res.send(buffer);
  } catch (error) {
    console.error("Full screenplay Word export failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
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

// Schema self-heal runs before the server starts accepting traffic — worst
// case (the database is briefly unreachable) it logs and the server still
// starts, rather than blocking startup entirely.
ensureAiMovieSchema().finally(() => {
  app.listen(PORT, () => {
    console.log(`Backend server running at http://localhost:${PORT}`);
  });
});

// Runs once on every process start (catches anything left stale from a
// previous process lifetime — e.g. right after a host restart) and then
// on a regular interval for the rest of this process's own lifetime.
reapStaleAutoPipelineRuns();
setInterval(reapStaleAutoPipelineRuns, 5 * 60 * 1000);

// Self-keepalive: Render's free/hobby tier spins this service down after
// ~15 minutes with no incoming HTTP traffic — which is exactly what a
// visitor waiting "15 seconds to load" is actually seeing (a cold start),
// and can also silently kill an in-progress auto-pipeline run. A GitHub
// Actions scheduled workflow was tried first as an external keepalive
// ping, but never actually fired even once in several hours — GitHub's
// `schedule` trigger is simply unreliable to depend on here. This has no
// external dependency at all: the app pings its own public URL, which
// Render sees as ordinary incoming traffic (same as any real visitor),
// so the service never has a reason to go idle in the first place.
if (!BACKEND_URL.includes("localhost")) {
  const SELF_PING_INTERVAL_MS = 10 * 60 * 1000; // safely under Render's ~15-minute idle window
  setInterval(() => {
    fetch(`${BACKEND_URL}/api/health`).catch((error) => console.error("Self-ping failed:", error.message));
  }, SELF_PING_INTERVAL_MS);
}
