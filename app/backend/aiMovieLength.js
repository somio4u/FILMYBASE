// The length category of an AI Movie as one plain rule for every writer (beat sheet, screenplay, story bible).
//   short film : 1 to 10 minutes in total, never longer: a tiny story, very few beats and scenes
//   film       : its own length (11 minutes or more); the beats' times add up to it
export function lengthRule(kind, minutes) {
  const m = Number(minutes);
  if (!m) return "";
  if (kind === "short_film") {
    const beatsMax = Math.max(2, Math.min(6, Math.ceil(m / 1.5)));
    const scenesMax = Math.max(2, Math.round(m * 1.5));
    return `THIS IS A SHORT FILM OF EXACTLY ${m} MINUTE${m === 1 ? "" : "S"} IN TOTAL — a hard limit, never longer. Keep it tiny: one simple story, two or three characters, very few locations. The Beat Sheet has at most ${beatsMax} beats and the runtimeMinutes of all beats add up to ${m}. The whole screenplay has at most ${scenesMax} scenes (about one scene per minute) — a beat may be a single scene.`;
  }
  return `The film is ${m} minutes long in total: the runtimeMinutes of all beats must add up to about ${m}, and the scenes follow those times.`;
}
