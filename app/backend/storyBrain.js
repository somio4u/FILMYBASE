// The Story Brain — the app's "writers' room". It designs the whole story
// (the Story Bible) before anything is written; see STORY_BRAIN_DESIGN.md.
//
// This file starts with the Brain's own access to the strongest Gemini model.
// The rest of the app still uses the @google/genai library (version 0.3),
// which can't reach Google's "global" endpoint where Gemini 3.1 Pro lives, so
// the Brain calls the Gemini REST API directly instead of upgrading that
// library under 17,000 lines of working code.

import { GoogleAuth } from "google-auth-library";

// Best model first. Checked on the project on 2026-10-07: gemini-3.1-pro-preview
// works on the "global" endpoint; gemini-2.5-pro is the fallback if the
// preview is unavailable or overloaded.
export const STORY_BRAIN_MODELS = [
  { model: "gemini-3.1-pro-preview", location: "global" },
  { model: "gemini-2.5-pro", location: "us-central1" },
];

// A Pro model thinks before it answers; a big design request can take minutes.
const BRAIN_CALL_TIMEOUT_MS = 10 * 60 * 1000;
const BRAIN_MAX_OUTPUT_TOKENS = 65536;
const RETRIES_PER_MODEL = 3;

const serviceAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  : null;
let googleAuth = null;

async function accessToken() {
  googleAuth ??= new GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await googleAuth.getClient();
  return (await client.getAccessToken()).token;
}

// Vertex AI (the service account) when it's set up, like the rest of the
// app; otherwise the AI Studio key.
async function endpointFor(model, location) {
  if (!serviceAccount) {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
    };
  }
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return {
    url: `https://${host}/v1/projects/${serviceAccount.project_id}/locations/${location}/publishers/google/models/${model}:generateContent`,
    headers: { Authorization: `Bearer ${await accessToken()}` },
  };
}

class BrainCallError extends Error {
  constructor(message, { status, retryable }) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

async function callModelOnce({ model, location }, { systemInstruction, contents, responseSchema, maxOutputTokens }) {
  const { url, headers } = await endpointFor(model, location);
  const body = {
    contents: [{ role: "user", parts: [{ text: contents }] }],
    generationConfig: {
      maxOutputTokens,
      responseMimeType: "application/json",
      ...(responseSchema ? { responseSchema } : {}),
    },
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BRAIN_CALL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new BrainCallError(`${model}: ${error.message}`, { status: 0, retryable: true });
  }

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = `${model}: ${response.status} ${json.error?.message ?? response.statusText}`.slice(0, 300);
    // 429 busy, 500/503 server trouble: try again. 404 (model not on this
    // project) or 400/403: no point retrying this model.
    throw new BrainCallError(message, { status: response.status, retryable: [429, 500, 502, 503, 504].includes(response.status) });
  }

  const candidate = json.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("");
  return { text, finishReason: candidate?.finishReason, usage: json.usageMetadata ?? {}, modelVersion: json.modelVersion ?? model };
}

// One JSON answer from the best available model. Returns
// { data, model, usage } — usage is the token count, so a run's cost can be
// shown. Tries each model in STORY_BRAIN_MODELS in turn.
export async function generateBrainJson({ systemInstruction, contents, responseSchema, maxOutputTokens = BRAIN_MAX_OUTPUT_TOKENS, label = "Story Brain" }) {
  let lastError;
  for (const target of STORY_BRAIN_MODELS) {
    for (let attempt = 0; attempt < RETRIES_PER_MODEL; attempt++) {
      try {
        const result = await callModelOnce(target, { systemInstruction, contents, responseSchema, maxOutputTokens });
        if (result.finishReason === "MAX_TOKENS") {
          throw new BrainCallError(`${target.model}: answer was cut off (MAX_TOKENS)`, { status: 0, retryable: true });
        }
        const data = JSON.parse(result.text);
        console.log(
          `${label}: ${result.modelVersion} — ${result.usage.promptTokenCount ?? 0} in, ${result.usage.candidatesTokenCount ?? 0} out, ${result.usage.thoughtsTokenCount ?? 0} thinking tokens`
        );
        return { data, model: result.modelVersion, usage: result.usage };
      } catch (error) {
        lastError = error;
        // A bad JSON answer is worth one more try; so is a busy server.
        const retryable = error instanceof SyntaxError || error.retryable;
        console.error(`${label}: ${error.message.slice(0, 200)}${retryable ? " — retrying" : " — trying the next model"}`);
        if (!retryable) break;
        await new Promise((resolve) => setTimeout(resolve, 3000 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// The writers' room: designing the Story Bible.
// ---------------------------------------------------------------------------

const S = (description) => ({ type: "STRING", description });
const LIST = (items, description) => ({ type: "ARRAY", items, description });
const OBJ = (properties, required = Object.keys(properties)) => ({ type: "OBJECT", properties, required });

// The craft every Brain step works by — what three script reviews of a
// weak draft (Bishpan) said was missing: a pilot hook, a designed mystery,
// an active hero, real-world logic, and a climax built to make people say "wow".
const STORY_CRAFT = `HOW GREAT SCREEN STORIES WORK — follow every rule:
- THE PROMISE: decide what thrill or feeling the audience is paying for, and deliver it from the very first minutes. The story is built around ONE burning question the audience needs answered.
- PILOT / OPENING: a gripping cold open in the first 2 minutes that shows the genre promise (a death, a threat, a mystery — not travel, not an office meeting). The hero's normal life is shown WITH A CRACK ALREADY IN IT. The incident that sets the story going lands by about minute 8 of a 20-minute episode (by about minute 12 of a film). Episode 1 ends on a shock or a question nobody can resist. Never spend the opening on logistics (packing, hospitals, driving, paperwork).
- HERO AGENCY: the hero CAUSES events. Every episode he makes a choice or takes an action that changes things. He finds clues through his own effort and skills — never by luck, overhearing, or someone explaining the plot to him.
- ESCALATION: every episode raises the stakes (personal → family → whole community) and ends on a hook into the next.
- DESIGNED MYSTERY: the hidden truth is decided first. Clues are planted fairly so a re-watch makes sense. A false suspect has a real motive AND a secret of his own, and is cleared by a twist or hard evidence. Reveals are timed for maximum impact.
- SETUPS AND PAYOFFS: anything important in the climax was planted earlier. Nothing that matters appears out of nowhere.
- CLIMAX = REVERSAL + CHOICE + COST + PAYOFF + IMAGE: a turn the audience didn't see coming but that feels inevitable afterwards; the hero's hardest choice; what it costs him; planted setups firing; one final image people will talk about. Mirroring the opening (history repeating, then broken) is powerful.
- CHARACTERS ARE PEOPLE, NOT SLOTS: each main character has a want, a need, a secret, a lie they believe, and at least one moment where THEY change the plot. The villain has a plan and makes a move in every episode, believing he is right.
- REAL-WORLD LOGIC: money, jobs, health, belongings, distances and who-knows-what stay consistent. A well-paid professional doesn't suddenly go broke; a bedridden patient doesn't walk; nobody turns up somewhere without a reason the audience knows.
- FRESHNESS: avoid stock tropes (blackouts, staring into mirrors, glowing eyes, throbbing marks, a villain confessing in public, a convenient diary explaining everything) unless given a genuinely new twist.
- CULTURE AS ENGINE: real local festivals, rituals, beliefs, places and social structures DRIVE the plot and the set pieces — they are never just background.
- NOTHING DANGLES: every object, document, clue and named character the story introduces either pays off later or is cut. A clue the hero finds must DO something.
- THE PAST HAS NAMES: everyone involved in the backstory crime is a named person with a fate in the story; when the story punishes or exposes people, the audience knows exactly who they are and why they are next.
- TURNING POINTS ARE SCENES: a character's big decision, and the cost of a big event (grief, guilt, fear), each get a moment on screen — never happen between scenes.
- DISCOVERIES OPEN QUESTIONS: in a mystery each answer the investigation finds opens a new, bigger question or impossibility; it never just confirms what we knew.
- EVERY WITNESS REACTS: in a big public scene (a climax in front of a crowd, guards, police), everyone present reacts in a believable way — explain why no one intervenes, and let a crowd turn when the truth comes out.
- VISUAL VARIETY: vary places and day/night across each episode; no episode stays in one room or one time of day.`;

const STORY_BRAIN_SYSTEM = `You are the head writer of a top writers' room, designing a story for Odia (Odisha) cinema and web series — a master of hooks, mysteries, character and unforgettable climaxes, rooted in authentic Odisha culture (Ollywood sensibility, not generic Hollywood).

You design BEFORE anyone writes: your output is a design, written in clear, plain English.

THE USER'S IDEA IS SACRED: keep every fixed point the user gives (names, places, relationships, twists they asked for). Everything else is yours to invent and improve.

${STORY_CRAFT}

CULTURAL ACCURACY: every festival, season, ritual, dance, dress, food and custom must be right for the region and the time of year — never mix a festival from one part of Odisha (or one season) with a tradition from another.`;

function formatUnits(format) {
  if (format?.type === "series") {
    return { kind: "episode", count: Number(format.episodeCount) || 8, minutes: Number(format.episodeMinutes) || 20, label: `a web series of ${Number(format.episodeCount) || 8} episodes, ${Number(format.episodeMinutes) || 20} minutes each` };
  }
  const runtime = Number(format?.runtimeMinutes) || 120;
  const count = Math.max(4, Math.round(runtime / 15));
  return { kind: "sequence", count, minutes: Math.round(runtime / count), label: `a feature film of ${runtime} minutes, designed as ${count} sequences of about ${Math.round(runtime / count)} minutes` };
}

const DIRECTION_SCHEMA = OBJ({
  title: S("Working title."),
  logline: S("One sentence: hero, goal, obstacle, stakes."),
  centralQuestion: S("The one question that keeps the audience watching."),
  genrePromise: S("The thrill or feeling the audience is paying for."),
  coldOpen: S("The first 2 minutes, concretely: what we SEE."),
  openingEnding: S("How episode 1 (or the first act) ends — the shock or question."),
  climaxTwist: S("The climax: the reversal, the hero's choice, the cost, the final image."),
  whyWow: S("In one line, why an audience would say 'wow' about this story."),
  freshness: S("What makes this different from the obvious version of this idea."),
});

const PITCH_SCORE_SCHEMA = OBJ({
  scores: LIST(
    OBJ({
      direction: { type: "INTEGER", description: "1, 2 or 3" },
      hook: { type: "INTEGER", description: "0-10: would people keep watching after the opening?" },
      freshness: { type: "INTEGER", description: "0-10" },
      climax: { type: "INTEGER", description: "0-10: would people say 'wow'?" },
      faithfulness: { type: "INTEGER", description: "0-10: true to every fixed point of the user's idea?" },
      note: S("The single biggest strength and weakness."),
    })
  ),
  best: { type: "INTEGER", description: "The number of the strongest direction." },
  reason: S("Why it wins."),
  improve: S("What the winner should borrow from the others or fix while designing."),
});

const TRUTH_SCHEMA = OBJ({
  hiddenTruth: OBJ({
    summary: S("What REALLY happened before the story starts, and why — the truth the story slowly reveals."),
    timeline: LIST(OBJ({ when: S("When."), event: S("What happened.") }), "The backstory events in order."),
    whoKnowsWhat: LIST(OBJ({ character: S("Name."), knows: S("What they know or hide at the start.") })),
    participants: LIST(
      OBJ({ name: S("Name."), part: S("What they did in the backstory crime."), fate: S("What happens to them in the story, and in which episode / sequence.") }),
      "EVERY person involved in the backstory crime, by name."
    ),
  }),
  namesInOdia: LIST(
    OBJ({ name: S("The name as written in English."), odia: S("The one fixed spelling in Odia script.") }),
    "Every character and place name, with its single fixed Odia spelling."
  ),
  characters: LIST(
    OBJ({
      name: S("Name — every character has a different name."),
      age: S("Age in years."),
      relationToHero: S("Exactly who they are to the hero (e.g. 'his wife', 'his father's mother', 'no relation — the village headman')."),
      look: S("Short look and dress."),
      role: S("Their function: hero, antagonist, mentor, ally/foil, skeptic, henchman, false suspect, community..."),
      want: S("What they consciously want."),
      need: S("What they really need."),
      secret: S("What they hide."),
      lie: S("The false belief they hold."),
      plotMove: S("The moment where THEY change the plot."),
      arc: S("How they change from start to end."),
    }),
    "The main cast (usually 6-9 people)."
  ),
  villainPlan: S("The antagonist's goal, his plan, and why he believes he is right."),
  facts: OBJ({
    jobsAndMoney: LIST(S("A fact")),
    healthAndBodies: LIST(S("A fact")),
    belongingsAndVehicles: LIST(S("A fact")),
    places: LIST(S("A place and what it is like")),
    worldRules: LIST(S("A rule of this world — e.g. what the supernatural can and cannot do, and why.")),
  }),
});

const CLIMAX_SCHEMA = OBJ({
  climax: OBJ({
    setting: S("Where and when the climax happens (a real occasion if possible)."),
    reversal: S("The turn the audience doesn't see coming."),
    heroChoice: S("The hardest choice the hero makes."),
    cost: S("What it costs him."),
    payoffs: LIST(S("A planted setup that fires in the climax.")),
    finalImage: S("The last image of the story."),
    whyWow: S("Why the audience will say 'wow'."),
    resolution: S("What changes for every main character after the climax."),
  }),
  setupsPayoffs: LIST(
    OBJ({
      setup: S("The thing planted (object, line, habit, place, rule)."),
      plantedIn: S("Where it is planted (episode / sequence number and moment)."),
      payoff: S("How it pays off."),
      paidOffIn: S("Where it pays off."),
    })
  ),
});

const BLUEPRINT_SCHEMA = OBJ({
  units: LIST(
    OBJ({
      number: { type: "INTEGER" },
      title: S("Title."),
      coldOpen: S("The opening hook, concretely."),
      question: S("The question this episode / sequence asks."),
      heroMove: S("The active choice or action the hero takes."),
      villainMove: S("What the antagonist does."),
      clue: S("The clue found, and HOW the hero earns it."),
      falseLead: S("Misdirection in play (or 'none')."),
      heroLearns: S("What the hero learns."),
      audienceLearns: S("What the audience learns (may be more or less than the hero)."),
      setPiece: S("The memorable sequence, rooted in real local culture."),
      sideStory: S("What another main character is pursuing."),
      turn: S("The midpoint turn."),
      decisionMoment: S("The on-screen moment where a character makes this episode's key choice."),
      emotionalBeat: S("The moment a character feels the cost of what happened (grief, guilt, fear) — given room on screen."),
      endingHook: S("How it ends — the hook into the next."),
      plants: LIST(S("Setups planted here.")),
      payoffs: LIST(S("Setups paid off here.")),
    })
  ),
});

function directionText(d) {
  return `TITLE: ${d.title}\nLOGLINE: ${d.logline}\nCENTRAL QUESTION: ${d.centralQuestion}\nGENRE PROMISE: ${d.genrePromise}\nCOLD OPEN: ${d.coldOpen}\nEND OF OPENING: ${d.openingEnding}\nCLIMAX: ${d.climaxTwist}\nWHY WOW: ${d.whyWow}\nFRESHNESS: ${d.freshness}`;
}

function characterLine(c) {
  return `${c.name} (${c.age}, ${c.relationToHero}; ${c.role}) — wants: ${c.want}; secret: ${c.secret}; changes the plot: ${c.plotMove}`;
}

// Designs the whole Story Bible for an idea. onProgress(stepLabel) is called
// as each writers'-room step starts. Returns { bible, usage } where usage
// adds up the tokens of every call (for the cost of the run).
export async function designStoryBible(idea, format, { onProgress = () => {} } = {}) {
  const units = formatUnits(format);
  const usage = newUsage();
  const ask = brainAsker(usage, onProgress);
  const ideaBlock = `THE USER'S IDEA (keep every fixed point):\n${idea}\n\nFORMAT: ${units.label}.`;

  // 1. Pitch room: three genuinely different directions, judged by an audience critic.
  const { directions } = await ask(
    "Pitch room",
    `${ideaBlock}\n\nPitch THREE genuinely different directions for this story — different hooks, different hidden truths, different climaxes (not three variations of one plot). Each must keep every fixed point of the user's idea.`,
    OBJ({ directions: LIST(DIRECTION_SCHEMA, "Exactly 3 directions.") })
  );
  const pitched = directions.slice(0, 3);
  const verdict = await ask(
    "Audience critic picks a direction",
    `${ideaBlock}\n\nYou are now a tough AUDIENCE CRITIC who has seen every OTT thriller. Score these three directions honestly and pick the one that would grip an audience most while staying true to the user's idea.\n\n${pitched.map((d, i) => `DIRECTION ${i + 1}\n${directionText(d)}`).join("\n\n")}`,
    PITCH_SCORE_SCHEMA
  );
  const chosenIndex = Math.min(Math.max((verdict.best ?? 1) - 1, 0), pitched.length - 1);
  const chosen = pitched[chosenIndex];
  const chosenText = `${directionText(chosen)}\n\nCRITIC'S NOTE TO TAKE ON BOARD: ${verdict.improve ?? ""}`;

  // 2. Truth first: what really happened, who these people are, and the facts.
  const truth = await ask(
    "Hidden truth, characters and facts",
    `${ideaBlock}\n\nTHE CHOSEN DIRECTION:\n${chosenText}\n\nDesign the foundation before any episode is planned:\n- The HIDDEN TRUTH: what really happened before the story starts, as a timeline, and who knows what at the start.\n- The MAIN CAST as real people (every name different; ages and relationships fixed for the whole story).\n- EVERY PARTICIPANT in the backstory crime, by name, with their fate in the story.\n- The ONE fixed Odia spelling of every character and place name.\n- The VILLAIN'S PLAN.\n- The FACTS SHEET: jobs and money, health, belongings and vehicles, places, and the rules of this world (including exactly what any supernatural force can and cannot do).`,
    TRUTH_SCHEMA
  );
  const foundation = `HIDDEN TRUTH: ${truth.hiddenTruth.summary}\nTIMELINE:\n${truth.hiddenTruth.timeline.map((t) => `- ${t.when}: ${t.event}`).join("\n")}\nCAST:\n${truth.characters.map((c) => `- ${characterLine(c)}`).join("\n")}\nVILLAIN'S PLAN: ${truth.villainPlan}\nFACTS:\n${Object.values(truth.facts).flat().map((f) => `- ${f}`).join("\n")}`;

  // 3. Backwards: the climax first, then everything it needs planted.
  const ending = await ask(
    "Climax, setups and payoffs",
    `${ideaBlock}\n\nTHE CHOSEN DIRECTION:\n${chosenText}\n\nTHE FOUNDATION:\n${foundation}\n\nDesign the CLIMAX FIRST — reversal, choice, cost, payoffs, final image — so strong the audience says "wow". Then list every SETUP the climax and the big reveals need, with where it is planted (in which of the ${units.count} ${units.kind}s) and where it pays off. Plant early and fairly.`,
    CLIMAX_SCHEMA
  );
  const endingText = `CLIMAX: ${ending.climax.setting} — ${ending.climax.reversal} Hero's choice: ${ending.climax.heroChoice} Cost: ${ending.climax.cost} Final image: ${ending.climax.finalImage}\nSETUPS AND PAYOFFS:\n${ending.setupsPayoffs.map((s) => `- ${s.setup} (planted ${s.plantedIn}) → ${s.payoff} (${s.paidOffIn})`).join("\n")}`;

  // 4. The blueprint, unit by unit, with the whole design in view.
  const blueprint = await ask(
    `${units.kind === "episode" ? "Episode" : "Sequence"} blueprints`,
    `${ideaBlock}\n\nTHE CHOSEN DIRECTION:\n${chosenText}\n\nTHE FOUNDATION:\n${foundation}\n\nTHE ENDING (already designed — build towards it):\n${endingText}\n\nNow plan all ${units.count} ${units.kind}s (about ${units.minutes} minutes each), in order, so that every setup is planted where the list says and every clue is EARNED by the hero's own action. ${units.kind === "episode" ? "Episode 1 follows the pilot rules exactly. Every episode ends on a hook; the last one ends the story with the designed climax." : "The first sequence opens with the hook; the last delivers the designed climax."} Return exactly ${units.count} units.`,
    BLUEPRINT_SCHEMA
  );

  const bible = {
    idea,
    format,
    units,
    pitchRoom: { directions: pitched, verdict, chosen: chosenIndex + 1 },
    promise: {
      title: chosen.title,
      logline: chosen.logline,
      centralQuestion: chosen.centralQuestion,
      genrePromise: chosen.genrePromise,
      whyWow: chosen.whyWow,
    },
    ...truth,
    ...ending,
    blueprint: blueprint.units,
  };

  // 5. The critics read it; the head writer revises until it passes.
  const reviewed = await reviewAndImproveBible(bible, { ask, onProgress });
  return { bible: reviewed, usage: usageSummary(usage) };
}

function newUsage() {
  return { calls: 0, promptTokens: 0, outputTokens: 0, thinkingTokens: 0, models: new Set() };
}

function usageSummary(usage) {
  return { ...usage, models: [...usage.models] };
}

// One Brain call that also adds its tokens to the run's usage.
function brainAsker(usage, onProgress = () => {}) {
  return async (label, contents, responseSchema, systemInstruction = STORY_BRAIN_SYSTEM) => {
    onProgress(label);
    const result = await generateBrainJson({ systemInstruction, contents, responseSchema, label: `Story Brain — ${label}` });
    usage.calls++;
    usage.promptTokens += result.usage.promptTokenCount ?? 0;
    usage.outputTokens += result.usage.candidatesTokenCount ?? 0;
    usage.thinkingTokens += result.usage.thoughtsTokenCount ?? 0;
    usage.models.add(result.model);
    return result.data;
  };
}

// ---------------------------------------------------------------------------
// The critics: three independent readers, and the revision loop.
// ---------------------------------------------------------------------------

export const BIBLE_PASS_SCORE = 8;
const MAX_BIBLE_REVISIONS = 3;

const SCORE_SCALE = `SCORE HONESTLY on this scale: 10 = a masterpiece; 9 = exceptional; 8 = strong — a demanding producer would greenlight it as it stands; 7 = good but with clear flaws; 6 = average; 5 or below = weak. Never inflate: the writers improve only when you are strict and specific.
SEVERITY: BLOCKER = it breaks the premise, the user's idea, the central mystery or the climax, and can't be fixed without redesigning a big part of the story (any blocker means the score is at most 6). MAJOR = a real hole or weakness that a focused change can fix (e.g. a contradiction one detail resolves, an unearned clue, a weak hook). MINOR = polish.`;

const CRITIC_SCHEMA = OBJ({
  score: { type: "INTEGER", description: "0-10 on the given scale." },
  verdict: S("Your overall verdict in two or three sentences."),
  strengths: LIST(S("Something that works and must be kept.")),
  problems: LIST(
    OBJ({
      where: S("Where — e.g. 'Episode 3, clue' or 'Facts: world rules' or 'Climax'."),
      severity: { type: "STRING", enum: ["blocker", "major", "minor"] },
      problem: S("What is wrong, concretely."),
      fix: S("A concrete fix."),
    }),
    "Every real problem, most serious first."
  ),
});

const CRITICS = [
  {
    key: "storyDoctor",
    label: "Story doctor",
    system: `You are a veteran script doctor who has fixed hundreds of films and web series. You read a Story Bible (a story design) and find every weakness before a single page is written. You are strict, specific and constructive.\n\n${SCORE_SCALE}`,
    brief: `Check, and report every problem:
1. LOGIC AND CAUSE-EFFECT: does every event follow from what came before? Is anyone somewhere without a reason the audience knows?
2. THE BIBLE'S OWN FACTS AND RULES: any event that the facts sheet or the rules of this world make impossible is a BLOCKER (e.g. the supernatural doing something the rules say it cannot; a sold vehicle returning; a bedridden person walking). Any contradiction between two parts of the Bible is at least MAJOR.
3. HERO AGENCY: does the hero earn every clue through his own action and skills? A clue found by luck, overhearing, or someone explaining the plot is MAJOR.
4. THE MYSTERY: would an attentive viewer guess the hidden truth (or the big reveal) earlier than the Bible intends? Name the exact giveaway (MAJOR). Are red herrings convincing and cleared by evidence?
5. SETUPS AND PAYOFFS: is every payoff set up earlier, and every setup paid off?
6. THE VILLAIN: is his plan coherent, and does he act every episode?
7. REAL-WORLD PLAUSIBILITY: police and legal procedure, medicine, technology, money, distances, time.
8. THE USER'S IDEA: every fixed point kept? Dropping or changing one is a BLOCKER.
9. NOTHING DANGLES: list every object, document, clue and named character that is introduced and never pays off (MAJOR each).
10. THE PAST HAS NAMES: are the people punished or exposed clearly the named participants of the backstory crime, so the audience knows who is next? Anonymous victims are MAJOR.
11. TURNING POINTS ON SCREEN: is every big decision and every big loss given its own on-screen moment? A decision or grief that happens between scenes is MAJOR.
12. THE CLIMAX'S WITNESSES: in the climax, does everyone present (crowd, guards, police, allies) react believably — why does no one stop it, and what changes in them? Missing reactions are MAJOR.
13. TIME AND AGES: do the dates, ages and timeline add up (e.g. how old each character was at the time of the backstory)?
14. DISCOVERIES: does each discovery open a new question, or does it merely confirm what we knew (MINOR/MAJOR)?`,
  },
  {
    key: "audienceCritic",
    label: "Audience critic",
    system: `You are a sharp OTT commissioning editor and a passionate viewer who has watched every major Indian and international thriller and drama. You decide whether real audiences will stay. You are honest to the point of being harsh.\n\n${SCORE_SCALE}`,
    brief: `Judge it as an audience would, and report every problem:
1. THE OPENING: after the first 2 minutes, would you keep watching? After episode 1 (or the first act), would you IMMEDIATELY click the next? If not, that is a BLOCKER.
2. EVERY ENDING HOOK: does each episode / sequence end on something you must see resolved?
3. BOREDOM: where would you reach for your phone? Anything repeated, slow, or explained instead of shown.
4. FRESHNESS: stock tropes (blackouts, mirror-staring, glowing eyes, blood from taps, public confessions, convenient diaries) without a new twist are MAJOR.
5. THE CLIMAX: is it surprising yet inevitable — would people say "wow" and talk about it? A predictable or merely loud climax is MAJOR.
6. EMOTION: do you care about the hero and his relationships? Does anyone feel like a plot device?
7. THE FINAL IMAGE: will people remember it?
8. ROOM TO FEEL: after the biggest shocks (a death, the reveal), does the story give a moment for grief or guilt, or does it rush on?
9. VARIETY: does any stretch stay in one place or one time of day so long that it looks monotonous?`,
  },
  {
    key: "cultureExpert",
    label: "Odisha culture expert",
    system: `You are an expert on Odisha — its festivals, temple rituals and their exact order and timing, seasons and months, regions and their distinct traditions, communities, village life, food, dress, language, and how police, courts and local government actually work there. Odia audiences will instantly notice any mistake, and some mistakes would offend devotees. You are precise.\n\n${SCORE_SCALE}`,
    brief: `Check every cultural and local detail, and report every problem:
1. FESTIVALS AND RITUALS: is each one real, in the right month/season, in the right region, and are its events in the right ORDER (e.g. what happens before or after the chariots move at Rath Yatra)? A wrong order or season for a central event is MAJOR (BLOCKER if the climax depends on it).
2. TEMPLES AND DEITIES: are temple practices, servitor roles and worship shown correctly? Anything that would offend devotees is MAJOR.
3. PLACES AND REGIONS: do places exist and fit the region? Are traditions from different parts of Odisha mixed up?
4. PEOPLE AND LIFE: names, communities, dress, food, daily life, speech — right for the place and class?
5. INSTITUTIONS: police, courts, panchayat, hospitals — would it really work this way in Odisha?
Only report real errors; praise what is authentic.`,
  },
];

function userNotesText(bible) {
  return bible.userNotes?.length
    ? `\n\nTHE USER'S OWN NOTES (they outrank every critic — each one must be followed; ignoring one is a BLOCKER):\n${bible.userNotes.map((note, i) => `${i + 1}. ${note}`).join("\n")}`
    : "";
}

function criticInput(bible) {
  return `THE USER'S IDEA (its fixed points must be kept):\n${bible.idea}${userNotesText(bible)}\n\nTHE STORY BIBLE:\n${storyBibleToMarkdown({ ...bible, pitchRoom: null, review: null })}`;
}

async function runCritics(bible, ask, round) {
  const reports = await Promise.all(
    CRITICS.map((critic) =>
      ask(`${critic.label} (round ${round})`, `${criticInput(bible)}\n\n${critic.brief}`, CRITIC_SCHEMA, critic.system)
    )
  );
  const byKey = Object.fromEntries(CRITICS.map((critic, i) => [critic.key, reports[i]]));
  const scores = Object.fromEntries(CRITICS.map((critic) => [critic.key, byKey[critic.key].score]));
  const blockers = CRITICS.flatMap((critic) => byKey[critic.key].problems.filter((p) => p.severity === "blocker"));
  const passed = Object.values(scores).every((score) => score >= BIBLE_PASS_SCORE) && blockers.length === 0;
  return { reports: byKey, scores, lowest: Math.min(...Object.values(scores)), total: Object.values(scores).reduce((a, b) => a + b, 0), passed };
}

const REVISED_BIBLE_SCHEMA = OBJ({
  changes: LIST(S("What you changed and which critic's problem it fixes.")),
  promise: OBJ({ title: S("Title."), logline: S("Logline."), centralQuestion: S("Central question."), genrePromise: S("Genre promise."), whyWow: S("Why wow.") }),
  hiddenTruth: TRUTH_SCHEMA.properties.hiddenTruth,
  namesInOdia: TRUTH_SCHEMA.properties.namesInOdia,
  characters: TRUTH_SCHEMA.properties.characters,
  villainPlan: TRUTH_SCHEMA.properties.villainPlan,
  facts: TRUTH_SCHEMA.properties.facts,
  climax: CLIMAX_SCHEMA.properties.climax,
  setupsPayoffs: CLIMAX_SCHEMA.properties.setupsPayoffs,
  units: BLUEPRINT_SCHEMA.properties.units,
});

function criticNotesText(check) {
  return CRITICS.map((critic) => {
    const report = check.reports[critic.key];
    const problems = report.problems.map((p) => `  - [${p.severity.toUpperCase()}] ${p.where}: ${p.problem} → FIX: ${p.fix}`).join("\n");
    return `${critic.label.toUpperCase()} — score ${report.score}/10. ${report.verdict}\nKEEP: ${report.strengths.join("; ")}\nPROBLEMS:\n${problems || "  (none)"}`;
  }).join("\n\n");
}

// Critics read the Bible; if any scores under 8 (or finds a blocker), the
// head writer revises the whole Bible and the critics read it again — up to
// MAX_BIBLE_REVISIONS times. The best version is kept, with its review.
export async function reviewAndImproveBible(bible, { ask, onProgress = () => {}, usage } = {}) {
  ask ??= brainAsker(usage ?? newUsage(), onProgress);
  const history = [];
  const earlierNotes = [];
  let current = bible;
  let best = null;

  for (let round = 1; ; round++) {
    const check = await runCritics(current, ask, round);
    history.push({ version: round, scores: check.scores, passed: check.passed });
    if (!best || check.lowest > best.check.lowest || (check.lowest === best.check.lowest && check.total > best.check.total)) {
      best = { bible: current, check, version: round };
    }
    if (check.passed || round > MAX_BIBLE_REVISIONS) break;

    const revised = await ask(
      `Head writer revises (version ${round + 1})`,
      `THE USER'S IDEA (keep every fixed point):\n${current.idea}${userNotesText(current)}\n\nFORMAT: ${current.units.label}.\n\nYOUR CURRENT STORY BIBLE:\n${storyBibleToMarkdown({ ...current, pitchRoom: null, review: null })}\n\nTHREE CRITICS HAVE READ IT:\n${criticNotesText(check)}\n\n${earlierNotes.length ? `PROBLEMS FROM EARLIER ROUNDS (already fixed — never bring any of them back):\n${earlierNotes.join("\n")}\n\n` : ""}Revise the Story Bible like a careful head writer:
- Fix EVERY blocker and major problem, and the minor ones where you can. For a blocker, redesign the part of the story it breaks; for anything else, make the smallest change that truly fixes it.
- CHANGE NOTHING ELSE: every part the critics didn't flag stays as it is, word for word where possible. Every rewrite risks new holes.
- Before you finish, check every new or changed detail against the facts sheet, the rules of this world, the hidden truth, the timeline and every other ${current.units.kind}: who has which object, who knows what and when, what is physically, legally and technically possible, and what is culturally right. If a fix needs a new fact, add it to the facts sheet.
- Keep everything the critics praised and every fixed point of the user's idea.
Return the complete revised Bible with exactly ${current.units.count} ${current.units.kind}s.`,
      REVISED_BIBLE_SCHEMA
    );
    earlierNotes.push(
      ...CRITICS.flatMap((critic) => check.reports[critic.key].problems.filter((p) => p.severity !== "minor").map((p) => `- (round ${round}) ${p.where}: ${p.problem}`))
    );
    current = {
      ...current,
      promise: revised.promise,
      hiddenTruth: revised.hiddenTruth,
      namesInOdia: revised.namesInOdia,
      characters: revised.characters,
      villainPlan: revised.villainPlan,
      facts: revised.facts,
      climax: revised.climax,
      setupsPayoffs: revised.setupsPayoffs,
      blueprint: revised.units,
      revisionNotes: [...(current.revisionNotes ?? []), { version: round + 1, changes: revised.changes }],
    };
  }

  return {
    ...best.bible,
    review: {
      passed: best.check.passed,
      keptVersion: best.version,
      scores: best.check.scores,
      reports: best.check.reports,
      history,
    },
  };
}

// The user read the Bible and gave a note: the head writer revises with the
// note as the top priority, then the critics check it again (and check the
// note was followed). Returns { bible, usage } like designStoryBible.
export async function reviseBibleWithNote(bible, note, { onProgress = () => {} } = {}) {
  const usage = newUsage();
  const ask = brainAsker(usage, onProgress);
  const withNote = { ...bible, userNotes: [...(bible.userNotes ?? []), note] };
  const revised = await ask(
    "Head writer follows your note",
    `THE USER'S IDEA (keep every fixed point):\n${withNote.idea}${userNotesText(withNote)}\n\nFORMAT: ${withNote.units.label}.\n\nYOUR CURRENT STORY BIBLE:\n${storyBibleToMarkdown({ ...withNote, pitchRoom: null, review: null })}\n\nTHE USER HAS READ THIS BIBLE AND GIVES THIS NOTE (the most important instruction you have — follow it fully, however much of the story it changes):\n"${note}"\n\nRevise the Story Bible to follow the note. Change whatever the note needs; keep everything else. Then check every changed detail against the facts sheet, the rules of this world, the hidden truth and every other ${withNote.units.kind}, so the design stays one coherent whole. Return the complete revised Bible with exactly ${withNote.units.count} ${withNote.units.kind}s.`,
    REVISED_BIBLE_SCHEMA
  );
  const updated = {
    ...withNote,
    promise: revised.promise,
    hiddenTruth: revised.hiddenTruth,
    namesInOdia: revised.namesInOdia,
    characters: revised.characters,
    villainPlan: revised.villainPlan,
    facts: revised.facts,
    climax: revised.climax,
    setupsPayoffs: revised.setupsPayoffs,
    blueprint: revised.units,
    revisionNotes: [...(withNote.revisionNotes ?? []), { version: `your note ${withNote.userNotes.length}`, changes: revised.changes }],
  };
  const reviewed = await reviewAndImproveBible(updated, { ask, onProgress });
  return { bible: reviewed, usage: usageSummary(usage) };
}

// The Story Bible as a readable document (Markdown).
export function storyBibleToMarkdown(bible, usage) {
  const lines = [];
  const p = bible.promise;
  lines.push(`# ${p.title} — Story Bible`, "", `*${bible.units.label}*`, "");
  if (bible.review) {
    const r = bible.review;
    const labels = Object.fromEntries(CRITICS.map((critic) => [critic.key, critic.label]));
    lines.push("## The critics' verdict", "");
    lines.push(r.passed ? `**PASSED** — every critic scored ${BIBLE_PASS_SCORE} or more (version ${r.keptVersion}).` : `**NEEDS YOUR INPUT** — it didn't reach ${BIBLE_PASS_SCORE} from every critic; this is the best version (${r.keptVersion}).`, "");
    lines.push("| Critic | Score | Verdict |", "|---|---|---|");
    Object.entries(r.reports).forEach(([key, report]) => lines.push(`| ${labels[key]} | ${report.score}/10 | ${report.verdict} |`));
    lines.push("", `Rounds: ${r.history.map((h) => `v${h.version} (${Object.values(h.scores).join("/")})`).join(" → ")}`, "");
    const open = Object.entries(r.reports).flatMap(([key, report]) => report.problems.filter((x) => x.severity !== "minor").map((x) => `- **[${x.severity}] ${labels[key]} — ${x.where}:** ${x.problem} *Fix:* ${x.fix}`));
    if (open.length) lines.push("**Problems still open:**", "", ...open, "");
  }
  if (bible.userNotes?.length) {
    lines.push("## Your notes", "", ...bible.userNotes.map((note, i) => `${i + 1}. ${note}`), "");
  }
  lines.push("## 1. The promise", "", `**Logline:** ${p.logline}`, "", `**The question that keeps people watching:** ${p.centralQuestion}`, "", `**What the audience is paying for:** ${p.genrePromise}`, "", `**Why "wow":** ${p.whyWow}`, "");
  lines.push("## 2. The hidden truth", "", bible.hiddenTruth.summary, "");
  bible.hiddenTruth.timeline.forEach((t) => lines.push(`- **${t.when}:** ${t.event}`));
  if (bible.hiddenTruth.participants?.length) {
    lines.push("", "**Everyone involved in the backstory crime:**", "");
    bible.hiddenTruth.participants.forEach((x) => lines.push(`- **${x.name}:** ${x.part} → *${x.fate}*`));
  }
  lines.push("", "**Who knows what at the start:**", "");
  bible.hiddenTruth.whoKnowsWhat.forEach((k) => lines.push(`- **${k.character}:** ${k.knows}`));
  lines.push("", "## 3. Characters", "");
  bible.characters.forEach((c) => {
    lines.push(`### ${c.name} (${c.age}) — ${c.relationToHero}`, `*${c.role}. ${c.look}*`, "");
    lines.push(`- **Wants:** ${c.want}`, `- **Needs:** ${c.need}`, `- **Secret:** ${c.secret}`, `- **Lie they believe:** ${c.lie}`, `- **Changes the plot when:** ${c.plotMove}`, `- **Arc:** ${c.arc}`, "");
  });
  lines.push(`**The villain's plan:** ${bible.villainPlan}`, "");
  if (bible.namesInOdia?.length) {
    lines.push("**Names in Odia (fixed spellings):**", "", ...bible.namesInOdia.map((n) => `- ${n.name} — ${n.odia}`), "");
  }
  lines.push("## 4. Facts sheet", "");
  const factGroups = { jobsAndMoney: "Jobs and money", healthAndBodies: "Health", belongingsAndVehicles: "Belongings and vehicles", places: "Places", worldRules: "Rules of this world" };
  Object.entries(factGroups).forEach(([key, label]) => {
    lines.push(`**${label}:**`, "");
    (bible.facts[key] ?? []).forEach((f) => lines.push(`- ${f}`));
    lines.push("");
  });
  const c = bible.climax;
  lines.push("## 5. The climax (designed first)", "", `**Where/when:** ${c.setting}`, "", `**The reversal:** ${c.reversal}`, "", `**The hero's choice:** ${c.heroChoice}`, "", `**The cost:** ${c.cost}`, "", "**Payoffs that fire:**", "");
  c.payoffs.forEach((x) => lines.push(`- ${x}`));
  lines.push("", `**Final image:** ${c.finalImage}`, "", `**Why "wow":** ${c.whyWow}`, "", `**After:** ${c.resolution}`, "");
  lines.push("## 6. Setups and payoffs", "", "| Setup | Planted | Payoff | Paid off |", "|---|---|---|---|");
  bible.setupsPayoffs.forEach((s) => lines.push(`| ${s.setup} | ${s.plantedIn} | ${s.payoff} | ${s.paidOffIn} |`));
  lines.push("", `## 7. ${bible.units.kind === "episode" ? "Episode" : "Sequence"} blueprints`, "");
  bible.blueprint.forEach((u) => {
    lines.push(`### ${bible.units.kind === "episode" ? "Episode" : "Sequence"} ${u.number}: ${u.title}`, "");
    lines.push(`- **Cold open:** ${u.coldOpen}`, `- **Question:** ${u.question}`, `- **Hero's move:** ${u.heroMove}`, `- **Villain's move:** ${u.villainMove}`, `- **Clue (earned):** ${u.clue}`, `- **False lead:** ${u.falseLead}`, `- **Hero learns:** ${u.heroLearns}`, `- **Audience learns:** ${u.audienceLearns}`, `- **Set piece:** ${u.setPiece}`, `- **Side story:** ${u.sideStory}`, `- **Turn:** ${u.turn}`, ...(u.decisionMoment ? [`- **Decision moment:** ${u.decisionMoment}`] : []), ...(u.emotionalBeat ? [`- **Emotional beat:** ${u.emotionalBeat}`] : []), `- **Ending hook:** ${u.endingHook}`);
    if (u.plants?.length) lines.push(`- **Plants:** ${u.plants.join("; ")}`);
    if (u.payoffs?.length) lines.push(`- **Pays off:** ${u.payoffs.join("; ")}`);
    lines.push("");
  });
  if (!bible.pitchRoom) return lines.join("\n");
  lines.push("## Appendix: the pitch room", "");
  bible.pitchRoom.directions.forEach((d, i) => {
    const score = bible.pitchRoom.verdict.scores?.find((s) => s.direction === i + 1);
    lines.push(`**Direction ${i + 1}${i + 1 === bible.pitchRoom.chosen ? " (chosen)" : ""}: ${d.title}** — ${d.logline}`);
    if (score) lines.push(`Scores — hook ${score.hook}, freshness ${score.freshness}, climax ${score.climax}, faithful ${score.faithfulness}. ${score.note}`);
    lines.push("");
  });
  lines.push(`**Why the critic chose it:** ${bible.pitchRoom.verdict.reason}`, "");
  if (usage) lines.push(`*Made with ${usage.models.join(", ")} — ${usage.calls} calls, ${usage.promptTokens} input / ${usage.outputTokens} output / ${usage.thinkingTokens} thinking tokens.*`);
  return lines.join("\n");
}
