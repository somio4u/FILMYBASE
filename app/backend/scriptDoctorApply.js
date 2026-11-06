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
