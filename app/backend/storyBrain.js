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
- CULTURE AS ENGINE: real local festivals, rituals, beliefs, places and social structures DRIVE the plot and the set pieces — they are never just background.`;

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
  }),
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
  const usage = { calls: 0, promptTokens: 0, outputTokens: 0, thinkingTokens: 0, models: new Set() };
  const ask = async (label, contents, responseSchema) => {
    onProgress(label);
    const result = await generateBrainJson({ systemInstruction: STORY_BRAIN_SYSTEM, contents, responseSchema, label: `Story Brain — ${label}` });
    usage.calls++;
    usage.promptTokens += result.usage.promptTokenCount ?? 0;
    usage.outputTokens += result.usage.candidatesTokenCount ?? 0;
    usage.thinkingTokens += result.usage.thoughtsTokenCount ?? 0;
    usage.models.add(result.model);
    return result.data;
  };
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
    `${ideaBlock}\n\nTHE CHOSEN DIRECTION:\n${chosenText}\n\nDesign the foundation before any episode is planned:\n- The HIDDEN TRUTH: what really happened before the story starts, as a timeline, and who knows what at the start.\n- The MAIN CAST as real people (every name different; ages and relationships fixed for the whole story).\n- The VILLAIN'S PLAN.\n- The FACTS SHEET: jobs and money, health, belongings and vehicles, places, and the rules of this world (including exactly what any supernatural force can and cannot do).`,
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
  return { bible, usage: { ...usage, models: [...usage.models] } };
}

// The Story Bible as a readable document (Markdown).
export function storyBibleToMarkdown(bible, usage) {
  const lines = [];
  const p = bible.promise;
  lines.push(`# ${p.title} — Story Bible`, "", `*${bible.units.label}*`, "");
  lines.push("## 1. The promise", "", `**Logline:** ${p.logline}`, "", `**The question that keeps people watching:** ${p.centralQuestion}`, "", `**What the audience is paying for:** ${p.genrePromise}`, "", `**Why "wow":** ${p.whyWow}`, "");
  lines.push("## 2. The hidden truth", "", bible.hiddenTruth.summary, "");
  bible.hiddenTruth.timeline.forEach((t) => lines.push(`- **${t.when}:** ${t.event}`));
  lines.push("", "**Who knows what at the start:**");
  bible.hiddenTruth.whoKnowsWhat.forEach((k) => lines.push(`- **${k.character}:** ${k.knows}`));
  lines.push("", "## 3. Characters", "");
  bible.characters.forEach((c) => {
    lines.push(`### ${c.name} (${c.age}) — ${c.relationToHero}`, `*${c.role}. ${c.look}*`, "");
    lines.push(`- **Wants:** ${c.want}`, `- **Needs:** ${c.need}`, `- **Secret:** ${c.secret}`, `- **Lie they believe:** ${c.lie}`, `- **Changes the plot when:** ${c.plotMove}`, `- **Arc:** ${c.arc}`, "");
  });
  lines.push(`**The villain's plan:** ${bible.villainPlan}`, "");
  lines.push("## 4. Facts sheet", "");
  const factGroups = { jobsAndMoney: "Jobs and money", healthAndBodies: "Health", belongingsAndVehicles: "Belongings and vehicles", places: "Places", worldRules: "Rules of this world" };
  Object.entries(factGroups).forEach(([key, label]) => {
    lines.push(`**${label}:**`);
    (bible.facts[key] ?? []).forEach((f) => lines.push(`- ${f}`));
    lines.push("");
  });
  const c = bible.climax;
  lines.push("## 5. The climax (designed first)", "", `**Where/when:** ${c.setting}`, "", `**The reversal:** ${c.reversal}`, "", `**The hero's choice:** ${c.heroChoice}`, "", `**The cost:** ${c.cost}`, "", "**Payoffs that fire:**");
  c.payoffs.forEach((x) => lines.push(`- ${x}`));
  lines.push("", `**Final image:** ${c.finalImage}`, "", `**Why "wow":** ${c.whyWow}`, "", `**After:** ${c.resolution}`, "");
  lines.push("## 6. Setups and payoffs", "", "| Setup | Planted | Payoff | Paid off |", "|---|---|---|---|");
  bible.setupsPayoffs.forEach((s) => lines.push(`| ${s.setup} | ${s.plantedIn} | ${s.payoff} | ${s.paidOffIn} |`));
  lines.push("", `## 7. ${bible.units.kind === "episode" ? "Episode" : "Sequence"} blueprints`, "");
  bible.blueprint.forEach((u) => {
    lines.push(`### ${bible.units.kind === "episode" ? "Episode" : "Sequence"} ${u.number}: ${u.title}`, "");
    lines.push(`- **Cold open:** ${u.coldOpen}`, `- **Question:** ${u.question}`, `- **Hero's move:** ${u.heroMove}`, `- **Villain's move:** ${u.villainMove}`, `- **Clue (earned):** ${u.clue}`, `- **False lead:** ${u.falseLead}`, `- **Hero learns:** ${u.heroLearns}`, `- **Audience learns:** ${u.audienceLearns}`, `- **Set piece:** ${u.setPiece}`, `- **Side story:** ${u.sideStory}`, `- **Turn:** ${u.turn}`, `- **Ending hook:** ${u.endingHook}`);
    if (u.plants?.length) lines.push(`- **Plants:** ${u.plants.join("; ")}`);
    if (u.payoffs?.length) lines.push(`- **Pays off:** ${u.payoffs.join("; ")}`);
    lines.push("");
  });
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
