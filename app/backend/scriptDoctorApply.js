// A SCRIPT DOCTOR'S REPORT → the changes MADE, scene by scene, in the draft that is open (the simple way: upload, see the list, press one button, watch it happen).
//
// What can be done by itself, and what cannot — said plainly to the person:
//   • a change that names SCENE NUMBERS (scene fixes, and risks with scene numbers)  → made in exactly those scenes
//   • a change for the WHOLE SCRIPT (narration, camera directions, one voice per character …) → made in every scene
//   • a change with no scene numbers about the story itself (new villain track, a new ending …) → it needs a person's decision (it adds or moves scenes), so it is
//     listed under "Needs you" with a button that hands it to Adu — never silently skipped, never half-done
// Every scene is rewritten ONCE with ALL the changes that belong to it together (so 200 scenes cost 200 rewrites, not 200 × the number of changes). The lines the
// report says to protect travel with every rewrite as "must keep". Each rewritten scene is its own change set, so it can be undone.
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// screenplay units in the order of the screenplay → scene number N (1-based, counted across all beats, like the numbers on screen) = the Nth one
export function sceneKeysInOrder(units) {
  return (units ?? []).filter((u) => u.section === "screenplay").map((u, i) => ({ number: i + 1, key: u.key, label: u.label }));
}

// "1-5, 12, 20–22" -> [1,2,3,4,5,12,20,21,22]; throws a plain message for anything that is not a scene of the film
export function parseSceneNumbers(text, max) {
  const out = new Set();
  for (const part of String(text ?? "").split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d{1,4})(?:[-–—](\d{1,4}))?$/.exec(part);
    if (!m) throw Object.assign(new Error(`“${part}” is not a scene number. Write numbers like 1-5, 12, 20-22.`), { status: 400 });
    const from = Number(m[1]), to = Number(m[2] ?? m[1]);
    if (from < 1 || to < from || to > max) throw Object.assign(new Error(`Scene ${to < from ? part : to > max ? to : from} does not exist (this film has ${max} scenes).`), { status: 400 });
    for (let n = from; n <= to; n++) out.add(n);
  }
  return [...out];
}

// items (from the report) + the draft's scenes -> { tasks: one per scene to rewrite, manual: items that need a person, perItem: how many scenes each item reaches }
export function planApply(rawItems, units, selectedIds = []) {
  const items = annotateItems(rawItems); // adds, to each change, the scenes it reaches (named, or worked out from its pages) and what it needs
  const scenes = sceneKeysInOrder(units);
  const chosen = new Set((selectedIds ?? []).map(Number));
  const take = (i) => i.kind !== "keep" && (chosen.size === 0 || chosen.has(i.id));
  const keeps = (items ?? []).filter((i) => i.kind === "keep");
  const doable = (items ?? []).filter(take);
  const byNumber = new Map(scenes.map((s) => [s.number, s]));
  const manual = [];
  const perItem = {};
  const perScene = new Map(); // scene number -> [items]
  const add = (scene, item) => { if (!perScene.has(scene.number)) perScene.set(scene.number, []); perScene.get(scene.number).push(item); perItem[item.id] = (perItem[item.id] ?? 0) + 1; };
  for (const item of doable) {
    if (item.kind === "global") { scenes.forEach((s) => add(s, item)); continue; }
    const named = (item.scenesUsed ?? item.scenes ?? []).map((n) => byNumber.get(n)).filter(Boolean);
    if (named.length > 0) { named.forEach((s) => add(s, item)); continue; }
    manual.push({ ...item, why: (item.scenesUsed ?? []).length > 0 ? "The scenes it reaches are not in this draft." : item.impact === "new_draft" ? "It changes the story itself (it adds, removes or moves scenes, or changes cause and effect), so it needs your decision — a new draft is the safe way." : "The report gives no scene number and no page numbers to place it by, so it needs your decision." });
  }
  const mustKeep = keeps.map((k) => clip(k.action, 200)).slice(0, 30);
  const tasks = scenes.filter((s) => perScene.has(s.number)).map((s) => {
    const mine = perScene.get(s.number);
    const lines = mine.map((i, n) => `${n + 1}. ${i.title}: ${clip(i.action, 600)}`);
    return {
      key: s.key, sceneNumber: s.number, label: s.label, itemIds: mine.map((i) => i.id),
      instruction: `Rewrite this ONE scene so that ALL of these changes from a script doctor's report are made in it (change only what they ask; keep the story, the names, the language and the formatting):\n${lines.join("\n")}`.slice(0, 5000),
    };
  });
  return { tasks, manual, mustKeep, perItem };
}

// where each change stands, from the plan and what has been done so far: [{ id, title, kind, severity, total, done, state }]
export function itemProgress(items, plan, results) {
  const done = new Map();
  for (const t of plan?.tasks ?? []) {
    const r = results?.[t.key];
    if (!r) continue;
    for (const id of t.itemIds) done.set(id, (done.get(id) ?? 0) + 1);
  }
  const manualIds = new Set((plan?.manual ?? []).map((m) => m.id));
  return (items ?? []).filter((i) => i.kind !== "keep" && ((plan?.perItem?.[i.id] ?? 0) > 0 || manualIds.has(i.id))).map((i) => {
    const total = plan?.perItem?.[i.id] ?? 0;
    const d = done.get(i.id) ?? 0;
    return { id: i.id, title: i.title, kind: i.kind, severity: i.severity, total, done: d, state: manualIds.has(i.id) ? "manual" : d >= total ? "done" : d > 0 ? "working" : "waiting" };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// THE SHORTCUT FOR THE STORY CHANGES: the changes that need a person (the story itself, new scenes, a new ending …) are merged into a handful of clear
// DIRECTIONS (a long report repeats itself: 128 changes are about 15 real ones) and given, as ONE request, to the "new draft" process: a NEW draft is made
// (the open one stays as it is), the revised story is designed and — because the person asked for the shortcut — approved by itself, and the screenplay is
// written again from it. Only the final "approve" is left to the person.
// ---------------------------------------------------------------------------------------------------------------------------------------------
export const MAX_DIRECTIONS = 24;

export const CONDENSE_SYSTEM = `You merge the many change requests of a script doctor's report into a short list of distinct STORY DIRECTIONS for a rewrite of the whole screenplay.
Rules:
- Merge duplicates and overlaps into one direction (the same villain change asked for six times is ONE direction). Keep unrelated changes apart.
- Each direction is self-contained: what to change and how, with the names, the places and the report's own sample lines or ideas. Never invent a change the requests do not ask for.
- Put the most important directions first (the ones the requests call critical or that many requests point to).
- A request that names an OLD scene ("Scene 12: shorten the speech") describes a moment of the old script. Restate it as a direction about that story moment itself (who says or does what, and what should change) so it still makes sense in a script that is written again from scratch, where scene numbers differ; the old scene number may stay in brackets as a pointer.
- Keep the report's spelling for names and quoted lines. Write the title and the action in English.
- At most ${MAX_DIRECTIONS} directions. "fromIds" lists the request numbers each direction covers; every request should be covered by some direction.`;

export const CONDENSE_SCHEMA = {
  type: "OBJECT", required: ["directions"],
  properties: { directions: { type: "ARRAY", items: { type: "OBJECT", required: ["title", "action", "fromIds"], properties: {
    title: { type: "STRING", description: "Five to ten words naming the direction." },
    action: { type: "STRING", description: "What to change and how, concrete, self-contained." },
    fromIds: { type: "ARRAY", items: { type: "INTEGER" }, description: "The numbers of the requests this direction covers." },
  } } } },
};

export function condensePrompt(items) {
  return `Here are ${items.length} change requests from the report. Merge them into at most ${MAX_DIRECTIONS} directions.\n\n${items.map((i) => `#${i.id} (${i.severity}, ${i.kind}) ${clip(i.title, 100)}: ${clip(i.action, 420)}`).join("\n")}`;
}

// the AI's answer -> clean directions (a direction with no title or action is dropped; the ids must be real; at most MAX_DIRECTIONS)
export function normalizeDirections(raw, items) {
  const valid = new Set((items ?? []).map((i) => i.id));
  const out = [];
  for (const d of Array.isArray(raw) ? raw : []) {
    const title = clip(d?.title, 120);
    const action = clip(d?.action, 600);
    if (!title || !action) continue;
    out.push({ title, action, fromIds: [...new Set((Array.isArray(d.fromIds) ? d.fromIds : []).map(Number).filter((id) => valid.has(id)))] });
    if (out.length >= MAX_DIRECTIONS) break;
  }
  return out;
}

// without the AI (it failed): the requests themselves, most serious first, as many as fit — and the count of those left out is said, never hidden
const RANK = { critical: 0, major: 1, minor: 2, note: 3 };
export function fallbackDirections(items, maxChars = 9000) {
  const ordered = [...(items ?? [])].sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3) || a.id - b.id);
  const out = [];
  let size = 0;
  for (const i of ordered) {
    const d = { title: clip(i.title, 120), action: clip(i.action, 700), fromIds: [i.id] };
    if (size + d.title.length + d.action.length + 8 > maxChars) break;
    out.push(d); size += d.title.length + d.action.length + 8;
  }
  return { directions: out, left: ordered.length - out.length };
}

export function directionsInstruction(directions) {
  const lines = directions.map((d, i) => `${i + 1}. ${d.title}: ${d.action}`);
  return `Rewrite the story to make ALL of these changes from a script doctor's report. Do not skip any; where two conflict, the earlier one wins. Keep what the report praises.\n${lines.join("\n")}`;
}

// every request that is covered by NO direction (the AI forgot it): they are added to the end so nothing is lost silently
export function uncovered(directions, items) {
  const covered = new Set(directions.flatMap((d) => d.fromIds));
  return (items ?? []).filter((i) => !covered.has(i.id));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// WHAT EACH CHANGE NEEDS — shown before anything is made, so the person can plan:
//   in_place  — a fix INSIDE existing scenes (trim, cut to silence, rewrite a line, voices, camera directions …): no new draft, no story change
//   careful   — also inside existing scenes, but it touches a story fact, a sensitive moment or adds a line / callback: made in place, but read it
//   new_draft — it adds, removes or moves scenes, changes cause and effect or the ending: the safe way is a NEW draft
// This is an ESTIMATE made from the words of the change (it is said so on the screen); the person can tick anything.
// A report often cites PAGES, not scene numbers; its own scene table gives page ↔ scene pairs (p7–9 = scenes 15–17), so pages are turned into scenes by
// interpolating between those pairs. Such scenes are marked "estimated from the pages".
// ---------------------------------------------------------------------------------------------------------------------------------------------
const NEW_SCENES = /\b(add(?:ing)?|write|create|insert|introduce)\b[^.]{0,60}\b(scenes?|songs?|montage|ending|resolution|epilogue|sequence)\b|\b(new scenes?|new song|new ending|resolution|epilogue)\b|\bcut\b[^.]{0,50}\b(scenes?|beats|sequence|arrival|training)\b|\b(move|reorder|swap|reverse)\b[^.]{0,60}\b(before|after|earlier|later|order)\b|\b(restructure|rebuild|merge|combine)\b|\bbackstor/i;
const LINE_CHANGE = /\b(one line|a line|the line|last line|sample line|callback|one beat|one sentence|a short|short exchange|a few lines|one short|add .{0,25} lines?)\b/i;
const LINE_LEVEL = /\b(trim|shorten|tighten|cut|remove|delete|replace|rewrite|polish|re-?type|strip|simplify|reduce)\b[^.]{0,60}\b(narration|narrator|dialogues?|lines?|cues?|speech|camera|jargon|paragraphs?|action lines?|sluglines?|tags?)\b/i;
const SENSITIVE = /\b(sensitiv|certification|protest|communal|brahma|idol|deity|khokhli)\b/i;

export function impactOf(item) {
  const text = `${item?.title ?? ""} ${item?.action ?? ""}`;
  if (item?.kind === "global") return "in_place";
  if (item?.kind === "scene") return NEW_SCENES.test(text) && !(item.scenes?.length) ? "new_draft" : "in_place";
  if (item?.kind === "risk") return NEW_SCENES.test(text) && !(item.scenes?.length) ? "new_draft" : "careful";
  if (item?.kind === "structure") {
    if (NEW_SCENES.test(text) && !LINE_CHANGE.test(text)) return "new_draft";
    if (LINE_LEVEL.test(text)) return "in_place"; // trimming narration, cutting jargon lines … is a fix inside scenes, whatever kind the AI gave it
    return LINE_CHANGE.test(text) || SENSITIVE.test(text) ? "careful" : "new_draft";
  }
  return "in_place";
}

// page -> scene number (a fraction), from the pairs the report gives itself; null when it gives too few
export function buildPageMap(items) {
  const raw = [];
  const pairs = (items ?? []).filter((i) => i.pages?.length && i.scenes?.length);
  if (pairs.length < 3) return null; // too few pairs to trust a map
  for (const i of pairs) {
    raw.push([Math.min(...i.pages), Math.min(...i.scenes)], [Math.max(...i.pages) + 1, Math.max(...i.scenes) + 1]);
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const anchors = [];
  for (const [page, scene] of raw) { // keep the pairs that only go forward (a pair that goes back is a misread: dropped)
    const last = anchors.at(-1);
    if (last && page === last[0]) continue;
    if (last && scene < last[1]) continue;
    anchors.push([page, scene]);
  }
  if (anchors.length < 2) return null;
  const slope = (anchors.at(-1)[1] - anchors[0][1]) / Math.max(1, anchors.at(-1)[0] - anchors[0][0]);
  return (page) => {
    if (page <= anchors[0][0]) return Math.max(1, anchors[0][1] - (anchors[0][0] - page) * slope);
    if (page >= anchors.at(-1)[0]) return anchors.at(-1)[1] + (page - anchors.at(-1)[0]) * slope;
    const k = anchors.findIndex((a) => a[0] > page);
    const [p0, s0] = anchors[k - 1];
    const [p1, s1] = anchors[k];
    return s0 + ((page - p0) / (p1 - p0)) * (s1 - s0);
  };
}

const MAX_DERIVED_SPAN = 40; // a change that would reach more than this many scenes by its pages is too broad to place: a person decides

// every item with { impact, scenesUsed, estimated }: the scenes it is made in (named by the report, or worked out from its pages), or none
export function annotateItems(items) {
  const toScene = buildPageMap(items);
  return (items ?? []).map((item) => {
    const impact = impactOf(item);
    let scenesUsed = item.scenes ?? [];
    let estimated = false;
    if (item.kind !== "keep" && item.kind !== "global" && scenesUsed.length === 0 && item.pages?.length && toScene && impact !== "new_draft") {
      const from = Math.max(1, Math.floor(toScene(Math.min(...item.pages))));
      const to = Math.max(from, Math.ceil(toScene(Math.max(...item.pages) + 1)) - 1);
      if (to - from + 1 <= MAX_DERIVED_SPAN) { scenesUsed = Array.from({ length: to - from + 1 }, (_, n) => from + n); estimated = true; }
    }
    return { ...item, impact, scenesUsed, estimated };
  });
}

// the counts for the person: how many changes are in place / careful / new draft, and which scene numbers the in-place ones reach
export function impactSummary(annotated) {
  const doable = (annotated ?? []).filter((i) => i.kind !== "keep");
  const count = (k) => doable.filter((i) => i.impact === k).length;
  const scenes = new Set();
  let everyScene = false;
  for (const i of doable) { if (i.impact === "new_draft" && !(i.scenes?.length)) continue; if (i.kind === "global") everyScene = true; else i.scenesUsed.forEach((n) => scenes.add(n)); }
  return { inPlace: count("in_place"), careful: count("careful"), newDraft: count("new_draft"), namedScenes: scenes.size, everyScene, forNewStory: itemsForNewStory(annotated).length, allChanges: annotated.filter((i) => i.kind !== "keep").length };
}

// THE NEW-STORY WAY writes everything again, so nothing made scene by scene first would survive. It must therefore be given, in ONE go, everything that is not tied to
// particular OLD scenes: the changes to the story itself (🔴), the whole-script rules (narration, camera directions, voices, one register …), and any change the report
// gave no scene or page to place it by. Changes tied to old scene numbers (or pages that were turned into scenes) refer to the OLD screenplay and are left out — a
// rewritten screenplay has different scenes. The protected lines travel with it as "must keep".
export function itemsForNewStory(annotated) {
  return (annotated ?? []).filter((i) => i.kind !== "keep" && (i.kind === "global" || i.impact === "new_draft" || !(i.scenesUsed?.length)));
}
