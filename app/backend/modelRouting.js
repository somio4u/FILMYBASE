// One place that decides WHICH Gemini model each AI Movie agent uses, for each
// of the three quality modes. Nothing else should hard-code "pro" or "flash"
// for an AI Movie agent — ask modelFor(agentId, qualityMode) instead.
//
// Tiers (the actual model ids are in MODEL_TIERS; the Pro chain itself — which
// preview model first, which fallback — lives in storyBrain.js STORY_BRAIN_MODELS
// so there is still only one list to maintain):
//   pro        Gemini 3.1 Pro (fallback chain in storyBrain.js). Creative work + judgment.
//   flash      Gemini 2.5 Flash. Routine, high-volume writing and checking.
//   flashLite  Gemini 2.5 Flash-Lite. Small utility calls.
//
// Creative mode (Balanced Cinematic / Mass Spectacle) is a different setting
// and is NOT looked at here.

export const QUALITY_MODES = ["economy", "professional", "maximum"];
export const DEFAULT_QUALITY_MODE = "professional";

export const QUALITY_MODE_INFO = {
  economy: { label: "Economy", blurb: "Flash writes most things; Pro only reviews the finished work. Fewest expensive revisions." },
  professional: { label: "Professional (default)", blurb: "Pro for the Story Brain, judges, Script Editor, final story work and the Cinematic Director; Flash for routine work; Pro plans complex action shots." },
  maximum: { label: "Maximum quality", blurb: "Pro for all major writing, dialogue polish, judging, cinematic direction and detailed shot planning. Pictures, voices and video keep their own specialised models." },
};

export const MODEL_TIERS = {
  pro: { tier: "pro", label: "Gemini 3.1 Pro" },
  flash: { tier: "flash", label: "Gemini 2.5 Flash", model: "gemini-2.5-flash" },
  flashLite: { tier: "flashLite", label: "Gemini 2.5 Flash-Lite", model: "gemini-2.5-flash-lite" },
};

// Models that are NOT text models and are never routed here (kept for the report).
export const SPECIALISED_MODELS = {
  pictureMaker: "gemini-2.5-flash-image",
  voiceMaker: "gemini-2.5-flash-preview-tts",
  videoMaker: "veo-3.1-fast-generate-preview",
  assembler: "ffmpeg",
};

const same = (tier) => ({ economy: tier, professional: tier, maximum: tier });

// agentId -> tier per quality mode.
export const AGENT_ROUTES = {
  // Story
  "story-brain-head-writer": same("pro"),
  "story-brain-critics": same("pro"),
  "story-writer": { economy: "flash", professional: "pro", maximum: "pro" }, // storyline/pitch/cast/three-act/beat sheet
  "story-judge": same("pro"),
  "audience-judge": same("pro"),
  "cinematic-judge": same("pro"),
  // Screenplay
  "scene-writer-key": { economy: "flash", professional: "pro", maximum: "pro" }, // key scenes + final passes
  "scene-writer": { economy: "flash", professional: "flash", maximum: "pro" },
  "dialogue-draft": { economy: "flash", professional: "flash", maximum: "pro" },
  "dialogue-polish": { economy: "flash", professional: "pro", maximum: "pro" },
  "script-editor": same("pro"),
  "language-checker": same("flash"),
  // Cinematic
  "ai-cinematic-spectacle-director": same("pro"),
  // Production
  "silent-agent": same("flash"),
  "writing-assistant": same("flash"), // Pen Buddy / Adu (an optional "Pro mode" is the caller passing pro:true)
  "production-assistant": same("flashLite"),
  "shot-cutter": { economy: "flash", professional: "flash", maximum: "pro" }, // plus Pro for complex action, see shotCutterTier
  "shot-cutter-complex": { economy: "flash", professional: "pro", maximum: "pro" },
  "storyboard-writer": same("flash"),
  "voice-writer": same("flash"),
};

export function normalizeQualityMode(mode) {
  return QUALITY_MODES.includes(mode) ? mode : DEFAULT_QUALITY_MODE;
}

// Returns { tier, label, model? } for an agent. Throws for an unknown agent so a
// typo never silently falls back to some other model.
export function modelFor(agentId, qualityMode = DEFAULT_QUALITY_MODE, { forcePro = false } = {}) {
  const route = AGENT_ROUTES[agentId];
  if (!route) throw new Error(`Unknown AI agent "${agentId}" — add it to AGENT_ROUTES in modelRouting.js.`);
  const tier = forcePro ? "pro" : route[normalizeQualityMode(qualityMode)];
  return MODEL_TIERS[tier];
}

// A scene is "complex" for shot planning when it is action-heavy: a fight, a chase,
// a battle, many characters, or an approved cinematic direction with a fight/mass moment.
const ACTION_WORDS = /\b(fight|fights|fighting|chase|chases|battle|duel|combat|explosion|explodes|attack|attacks|sword|swords|clash|stampede|collapse|crash|crashes|leap|leaps|storm|army|war|transform|transforms|transformation|flying|flies)\b/gi;

export function isComplexActionScene({ text = "", characterCount = 0, direction = null } = {}) {
  if (direction && (direction.fight || (direction.massMoments?.length ?? 0) > 0 || ["major", "signature"].includes(direction.spectacleLevel))) return true;
  const hits = (String(text).match(ACTION_WORDS) ?? []).length;
  return hits >= 3 || (hits >= 2 && characterCount >= 4);
}

export function shotCutterRoute(qualityMode, scene) {
  return modelFor(isComplexActionScene(scene) ? "shot-cutter-complex" : "shot-cutter", qualityMode);
}

// Rough prices (US dollars) used ONLY to stop runaway spending, like the picture/voice/video
// prices in pipelineSettings.js. Estimates, not bills; change with environment settings.
export function textPrices(env = process.env) {
  return {
    proCall: Number(env.COST_PRO_CALL ?? 0.12),
    flashCall: Number(env.COST_FLASH_CALL ?? 0.01),
    flashLiteCall: Number(env.COST_FLASH_LITE_CALL ?? 0.003),
  };
}

export function estimateCost(tier, calls = 1, env = process.env) {
  const p = textPrices(env);
  const each = tier === "pro" ? p.proCall : tier === "flashLite" ? p.flashLiteCall : p.flashCall;
  return Math.round(each * calls * 10000) / 10000;
}

// The whole table, for the report and the settings screen.
export function routingTable() {
  return Object.entries(AGENT_ROUTES).map(([agent, route]) => ({ agent, ...route }));
}

// Beats where the screenplay's quality is decided: the opening, the last three (the climax run), the beat before/after the
// interval, any beat with a long target time, and song beats. Scene Writers use Pro for these in Professional mode.
export function isKeyBeat(beats, index, intervalAfterBeat = null) {
  if (!Array.isArray(beats) || !beats[index]) return false;
  const beat = beats[index];
  if (index === 0 || index >= beats.length - 3) return true;
  if (Number.isInteger(intervalAfterBeat) && (index === intervalAfterBeat || index === intervalAfterBeat + 1)) return true;
  if (Number(beat.runtimeMinutes) >= 4) return true;
  return /\b(song|climax|interval|finale|showdown)\b/i.test(`${beat.title?.en ?? ""} ${beat.description?.en ?? ""}`);
}
