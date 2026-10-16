// "Add multiple scenes": for each piece of context the writer typed, work out the scene's heading (INT/EXT, place, time of day) —
// the writer does not have to — and a length. The CONTEXT ITSELF is never changed: it becomes the scene's outline word for word, and
// the scene writer is told to stage only that (see strictContext in generateScreenplaySceneContent).

export function defaultMinutes(context) {
  const words = String(context ?? "").trim().split(/\s+/).filter(Boolean).length;
  return words < 20 ? 1 : words < 50 ? 2 : words < 100 ? 3 : 4;
}

const INT_EXT = new Set(["INT", "EXT"]);

// the plan is only a heading: anything missing or odd falls back to a plain, editable default
export function cleanPlan(raw, contexts) {
  const list = Array.isArray(raw?.scenes) ? raw.scenes : [];
  return contexts.map((context, i) => {
    const p = list[i] ?? {};
    const location = String(p.location ?? "").replace(/\s+/g, " ").trim().slice(0, 80).toUpperCase();
    const time = String(p.timeOfDay ?? "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 30);
    return {
      intExt: INT_EXT.has(String(p.intExt).toUpperCase()) ? String(p.intExt).toUpperCase() : "INT",
      location: location || "LOCATION",
      timeOfDay: time || "DAY",
      estimatedMinutes: defaultMinutes(context),
    };
  });
}

export function planPrompt(contexts) {
  return `A screenwriter wrote a short description of each scene they want. For EACH numbered description give only the scene HEADING facts that the description states or clearly implies:
- intExt: "INT" (indoors) or "EXT" (outdoors).
- location: the place in English capital letters, short (e.g. "PALACE GATE", "JEEP ON THE ROAD"). Scene headings are always English, even if the description is in Odia or Hindi. If no place is given, use the simplest place that the events imply, never an invented story detail.
- timeOfDay: "DAY", "NIGHT", "MORNING", "EVENING" ... only if the description says or implies it, otherwise "DAY".
Do NOT rewrite, extend or comment on the descriptions, and do not add story. Return JSON {"scenes":[{"intExt":"","location":"","timeOfDay":""}]} with exactly ${contexts.length} entries, in the same order.

${contexts.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;
}
