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

// items (from the report) + the draft's scenes -> { tasks: one per scene to rewrite, manual: items that need a person, perItem: how many scenes each item reaches }
export function planApply(items, units, selectedIds = []) {
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
    const named = (item.scenes ?? []).map((n) => byNumber.get(n)).filter(Boolean);
    if (named.length > 0) { named.forEach((s) => add(s, item)); continue; }
    manual.push({ ...item, why: (item.scenes ?? []).length > 0 ? "The scene numbers it names are not in this draft." : "It changes the story itself (it adds or moves scenes), so it needs your decision." });
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
export const MAX_DIRECTIONS = 20;

export const CONDENSE_SYSTEM = `You merge the many change requests of a script doctor's report into a short list of distinct STORY DIRECTIONS for a rewrite of the whole screenplay.
Rules:
- Merge duplicates and overlaps into one direction (the same villain change asked for six times is ONE direction). Keep unrelated changes apart.
- Each direction is self-contained: what to change and how, with the names, the places and the report's own sample lines or ideas. Never invent a change the requests do not ask for.
- Put the most important directions first (the ones the requests call critical or that many requests point to).
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
    const action = clip(d?.action, 900);
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
