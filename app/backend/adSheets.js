// "For Assistant Directors": the paper an AD works from, built from what the app already knows — the approved scene list, the written
// screenplay, the Smart Scheduler's plan, the colour tags, and the Script Breakdown (when one exists). Every document is a plain
// "spec" ({ title, subtitle, sections: [{ heading, note, columns: [{ h, w }], rows }] }); adRender.js turns a spec into a PDF or an Excel file.
// The Smart Scheduler's cost categories (costly / normal, free / paid) are the owner's private reference: they never appear on these papers.
// Nothing here is invented: where the app does not know something (call times, dates, contact numbers, make-up looks) the cell is left blank
// for the AD to fill in by hand.

const CROWD = /\b(crowd|villagers?|people|extras?|guests?|devotees|students|passers-?by|audience|mob|gathering|onlookers|neighbou?rs|wedding party|baraat|procession|customers|patients|police(?:men)?|soldiers|workers|tourists|children)\b/gi;

export const DOCUMENTS = [
  { kind: "d-sheet", group: "main", needsPlan: true, title: "D Sheet (day-wise breakdown)", about: "One block per shoot day: scenes, place, day/night, minutes, cast, what happens, and blank boxes for call time, date and notes." },
  { kind: "location-schedule", group: "main", needsPlan: true, title: "Location-wise Schedule", about: "Every place: how many scenes and minutes, which shoot days, and the scenes of each day." },
  { kind: "location-artists", group: "main", needsPlan: false, title: "Location-wise Artist List", about: "Every place: how many scenes, how many artists, and which artist is in which scenes there." },
  { kind: "call-sheet", group: "more", needsPlan: true, title: "Call Sheet (one page per day)", about: "For each day: scenes in shooting order, the cast to call with blank call/make-up times and contact numbers (when known)." },
  { kind: "artist-schedule", group: "more", needsPlan: true, title: "Artist-wise Schedule", about: "Every artist: the days to call, the scenes of each day, total scenes and minutes." },
  { kind: "props-costume", group: "more", needsPlan: false, title: "Props & Costume List", about: "Props and costume by scene, the master prop list and each character's costume (from the Script Breakdown)." },
  { kind: "continuity", group: "more", needsPlan: false, title: "Continuity Sheet", about: "One row per artist per scene: costume, props, and blank boxes for look / make-up / injuries / notes." },
  { kind: "scene-breakdown", group: "more", needsPlan: false, title: "Scene Breakdown Sheet", about: "One row per scene: place, day/night, minutes, cast, extras, props, costume, written or not, colour tag." },
  { kind: "one-liner", group: "more", needsPlan: false, title: "One-liner List", about: "The whole script on a few pages: one line per scene." },
  { kind: "day-night", group: "more", needsPlan: false, title: "Day / Night & INT / EXT Summary", about: "How many scenes and minutes are INT or EXT, DAY or NIGHT — overall and per shoot day." },
  { kind: "changed-scenes", group: "more", needsPlan: false, title: "Changed & Pending Scenes", about: "Scenes with a colour tag and its note, scenes not written yet, and scenes changed after the schedule was made." },
  { kind: "extras", group: "more", needsPlan: false, title: "Extras & Crowd List", about: "Scenes that need extras: from the Script Breakdown and from crowd words found in the scene text; the number needed is left blank." },
];

const NONE = /^(none|nil|n\/a|na|no|nothing|not applicable|no extras?|no props?|-+|—)\.?$/i;
// the AI writes "None" when there is nothing: that is an empty box, not an entry
const adText = (v) => { const t = String(v && typeof v === "object" ? v.en || v.or || v.hi || "" : v ?? "").trim(); return NONE.test(t) ? "" : t; };
const clip = (s, n = 400) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const num = (n) => Math.round(Number(n) * 10) / 10;
const textOf = (v) => (v && typeof v === "object" ? v.en || v.or || v.hi || "" : String(v ?? ""));
const byLabel = (a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true });

function prepare(ctx) {
  const dayOf = new Map();
  for (const d of ctx.plan?.days ?? []) for (const id of d.sceneIds) dayOf.set(id, d.day);
  const tagOf = new Map((ctx.tags ?? []).map((t) => [`${t[0] ?? "film"}-${t[1]}`, { tag: t[2], note: t[3], by: t[4], doneBy: t[5] }]));
  const useAd = Array.isArray(ctx.adSheet) && ctx.adSheet.length === ctx.rows.length;
  const rows = ctx.rows.map((r, i) => ({
    ...r,
    day: dayOf.get(r.id) ?? null,
    tag: tagOf.get(r.id) ?? null,
    ad: useAd ? ctx.adSheet[i] : null,
    ref: ctx.refs?.get(r.id) ?? null,
    gist: (useAd && adText(ctx.adSheet[i]?.sceneSummary)) || r.gist, // the AI's clear sentence, not the script's raw first line
    place: r.rawLocation && r.rawLocation !== r.location ? `${r.location} (${r.rawLocation})` : r.location,
    cast: r.artists.join(", "),
    epLabel: r.episode === null ? "" : `Ep ${r.episode + 1}`,
  }));
  const costume = new Map((ctx.breakdown?.costumes ?? []).map((c) => [String(c.character).toUpperCase(), textOf(c.description)]));
  return { rows, costume, useAd };
}

const joinUnique = (...parts) => [...new Set(parts.map((x) => clip(x, 400)).filter(Boolean))].join("; ");
const propsOf = (r) => joinUnique(adText(r.ad?.property), r.ref?.properties);
const costumeNotesOf = (r) => joinUnique(adText(r.ad?.costumeRemarks), r.ref?.costume);
const dayText = (r) => (r.day ? `Day ${r.day}` : "Not in plan");
const sceneCols = [{ h: "Sc", w: 5 }, { h: "INT/EXT", w: 7 }, { h: "Place", w: 20 }, { h: "D/N", w: 7 }, { h: "Min", w: 5 }, { h: "Cast", w: 22 }, { h: "What happens", w: 34 }];
const sceneRow = (r) => [r.label, r.intExt, r.place, r.timeOfDay, num(r.minutes), r.cast, clip(r.gist, 220)];
const inShootOrder = (list) => [...list].sort((a, b) => (a.episode ?? -1) - (b.episode ?? -1) || byLabel(a, b));
const needPlan = (ctx) => { if (!ctx.plan) throw Object.assign(new Error("Make the shoot schedule first (Production Management → Shoot Schedule) — this paper follows its shoot days."), { status: 409 }); };
const warnings = (ctx, rows) => {
  const out = [];
  if (ctx.stale) out.push("The screenplay changed after this plan was made — run the Smart Scheduler again for an up-to-date sheet.");
  if (ctx.plan && rows.some((r) => !r.day)) out.push(`${rows.filter((r) => !r.day).length} scene(s) were added after the plan and are not in any day yet.`);
  if (rows.some((r) => !r.written)) out.push(`${rows.filter((r) => !r.written).length} scene(s) are not written yet, so their cast is unknown.`);
  return out;
};
const sub = (ctx, extra = []) => [ctx.title, ...extra, `Made ${ctx.madeOn}`].filter(Boolean).join("  ·  ");

function dSheet(ctx, P) {
  needPlan(ctx);
  const days = ctx.plan.days.filter((d) => d.sceneIds.length > 0);
  const byId = new Map(P.rows.map((r) => [r.id, r]));
  const sections = [{
    heading: "Shoot overview",
    note: warnings(ctx, P.rows).join(" "),
    columns: [{ h: "Day", w: 6 }, { h: "Scenes", w: 8 }, { h: "Minutes", w: 8 }, { h: "Places", w: 32 }, { h: "Cast", w: 40 }, { h: "Day/Night", w: 10 }],
    rows: days.map((d) => [`Day ${d.day}${d.date ? ` (${d.date})` : ""}`, d.sceneIds.length, num(d.minutes), d.locations.join(", "), d.artists.join(", "), d.night ? "NIGHT" : d.mixed ? "DAY + NIGHT" : "DAY"]),
  }];
  for (const d of days) {
    const list = d.sceneIds.map((id) => byId.get(id)).filter(Boolean);
    sections.push({
      heading: `Day ${d.day}   ·   Date: ${d.date || "____________"}   ·   Call time: ________   ·   Wrap: ________`,
      note: `${list.length} scene(s) · ${num(d.minutes)} min · ${d.locations.join("  >  ")}`,
      columns: [...sceneCols, { h: "Notes", w: 16 }],
      rows: [...list.map((r) => [...sceneRow(r), ""]), ["", "", "", "TOTAL", num(list.reduce((n, r) => n + r.minutes, 0)), "", "", ""]],
    });
  }
  return { title: "D Sheet", subtitle: sub(ctx), sections };
}

function locationSchedule(ctx, P) {
  needPlan(ctx);
  const places = [...new Set(P.rows.map((r) => r.location))];
  const stat = (name) => { const list = P.rows.filter((r) => r.location === name); return { name, list, minutes: list.reduce((n, r) => n + r.minutes, 0), days: [...new Set(list.map((r) => r.day).filter(Boolean))].sort((a, b) => a - b), artists: new Set(list.flatMap((r) => r.artists)) }; };
  const stats = places.map(stat).sort((a, b) => b.list.length - a.list.length || a.name.localeCompare(b.name));
  const sections = [{
    heading: "All locations",
    note: warnings(ctx, P.rows).join(" "),
    columns: [{ h: "Location", w: 28 }, { h: "Scenes", w: 8 }, { h: "Minutes", w: 8 }, { h: "Artists", w: 8 }, { h: "Shoot days", w: 22 }],
    rows: stats.map((s) => [s.name, s.list.length, num(s.minutes), s.artists.size, s.days.length ? s.days.map((d) => `Day ${d}`).join(", ") : "—"]),
  }];
  for (const s of stats) {
    sections.push({
      heading: `${s.name}  —  ${s.list.length} scene(s), ${num(s.minutes)} min, ${s.days.length} day(s)`,
      columns: [{ h: "Day", w: 8 }, ...sceneCols],
      rows: [...s.list].sort((a, b) => (a.day ?? 999) - (b.day ?? 999) || byLabel(a, b)).map((r) => [dayText(r), ...sceneRow(r)]),
    });
  }
  return { title: "Location-wise Schedule", subtitle: sub(ctx), sections };
}

function locationArtists(ctx, P) {
  const places = [...new Set(P.rows.map((r) => r.location))];
  const stat = (name) => {
    const list = P.rows.filter((r) => r.location === name);
    const artists = new Map();
    for (const r of list) for (const a of r.artists) { const x = artists.get(a) ?? { name: a, scenes: [], days: new Set() }; x.scenes.push(r.label); if (r.day) x.days.add(r.day); artists.set(a, x); }
    return { name, list, artists: [...artists.values()].sort((a, b) => b.scenes.length - a.scenes.length || a.name.localeCompare(b.name)) };
  };
  const stats = places.map(stat).sort((a, b) => b.list.length - a.list.length || a.name.localeCompare(b.name));
  const sections = [{
    heading: "All locations — scenes and artists",
    note: warnings(ctx, P.rows).filter((w) => w.includes("not written")).join(" "),
    columns: [{ h: "Location", w: 22 }, { h: "Scenes", w: 7 }, { h: "Artists", w: 7 }, { h: "Who is there", w: 56 }],
    rows: stats.map((s) => [s.name, s.list.length, s.artists.length, s.artists.map((a) => `${a.name} (${a.scenes.length})`).join(", ")]),
  }];
  for (const s of stats) {
    sections.push({
      heading: `${s.name}  —  ${s.list.length} scene(s), ${s.artists.length} artist(s)`,
      note: `Scenes here: ${s.list.map((r) => r.label).join(", ")}`,
      columns: [{ h: "Artist", w: 24 }, { h: "Scenes here", w: 9 }, { h: "Scene numbers", w: 30 }, { h: "Days at this place", w: 18 }],
      rows: s.artists.length ? s.artists.map((a) => [a.name, a.scenes.length, a.scenes.join(", "), a.days.size ? [...a.days].sort((x, y) => x - y).map((d) => `Day ${d}`).join(", ") : "—"]) : [["(no artist known yet)", "", "", ""]],
    });
  }
  return { title: "Location-wise Artist List", subtitle: sub(ctx), sections };
}

function callSheet(ctx, P) {
  needPlan(ctx);
  const byId = new Map(P.rows.map((r) => [r.id, r]));
  const sections = [];
  for (const d of ctx.plan.days.filter((x) => x.sceneIds.length > 0)) {
    const list = d.sceneIds.map((id) => byId.get(id)).filter(Boolean);
    sections.push({
      heading: `CALL SHEET — Day ${d.day}   ·   Date: ${d.date || "____________"}   ·   General call: ________   ·   Sunrise/Sunset: ________`,
      note: `${ctx.title} · ${list.length} scene(s) · ${num(d.minutes)} min · ${d.locations.join("  >  ")}${d.night ? " · NIGHT shoot" : d.mixed ? " · day and night" : ""}`,
      columns: [...sceneCols, { h: "Time", w: 9 }],
      rows: list.map((r) => [...sceneRow(r), ""]),
    });
    sections.push({
      heading: `Cast to call — Day ${d.day}`,
      columns: [{ h: "Artist", w: 24 }, { h: "Scenes today", w: 16 }, { h: "Contact", w: 16 }, { h: "Pick-up", w: 11 }, { h: "Make-up", w: 11 }, { h: "On set", w: 11 }, { h: "Costume", w: 28 }],
      rows: d.artists.map((a) => [a, list.filter((r) => r.artists.includes(a)).map((r) => r.label).join(", "), ctx.contacts?.get(a)?.contact_number ?? "", "", "", "", clip(P.costume.get(a) ?? "", 90)]),
    });
  }
  return { title: "Call Sheets", subtitle: sub(ctx), sections };
}

function artistSchedule(ctx, P) {
  needPlan(ctx);
  const names = [...new Set(P.rows.flatMap((r) => r.artists))];
  const stat = (name) => { const list = P.rows.filter((r) => r.artists.includes(name)); return { name, list, minutes: list.reduce((n, r) => n + r.minutes, 0), days: [...new Set(list.map((r) => r.day).filter(Boolean))].sort((a, b) => a - b) }; };
  const stats = names.map(stat).sort((a, b) => b.days.length - a.days.length || b.list.length - a.list.length || a.name.localeCompare(b.name));
  const sections = [{
    heading: "All artists",
    note: warnings(ctx, P.rows).join(" "),
    columns: [{ h: "Artist", w: 26 }, { h: "Days called", w: 9 }, { h: "Scenes", w: 8 }, { h: "Minutes", w: 8 }, { h: "Which days", w: 36 }],
    rows: stats.map((s) => [s.name, s.days.length, s.list.length, num(s.minutes), s.days.map((d) => `Day ${d}`).join(", ") || "—"]),
  }];
  for (const s of stats) {
    sections.push({
      heading: `${s.name}  —  ${s.days.length} day(s), ${s.list.length} scene(s), ${num(s.minutes)} min`,
      columns: [{ h: "Day", w: 8 }, ...sceneCols],
      rows: [...s.list].sort((a, b) => (a.day ?? 999) - (b.day ?? 999) || byLabel(a, b)).map((r) => [dayText(r), ...sceneRow(r)]),
    });
  }
  return { title: "Artist-wise Schedule", subtitle: sub(ctx), sections };
}

const findIn = (name, r) => { const n = String(name).toLowerCase().trim(); return n.length >= 3 && `${r.gist} ${r.body ?? ""}`.toLowerCase().includes(n); };

function propsCostume(ctx, P) {
  const notes = [];
  if (!P.useAd) notes.push("Per-scene props and costume remarks come from the Script Breakdown's scene sheet, which does not exist (or no longer matches the scene count) for this project — run the Script Breakdown to fill them.");
  const sections = [{
    heading: "Props and costume by scene",
    note: notes.join(" "),
    columns: [{ h: "Sc", w: 5 }, { h: "Day", w: 7 }, { h: "Place", w: 18 }, { h: "Cast", w: 18 }, { h: "Props", w: 30 }, { h: "Costume remarks", w: 30 }, { h: "Done", w: 6 }],
    rows: inShootOrder(P.rows).map((r) => [r.label, r.day ? `Day ${r.day}` : "", r.place, r.cast, clip(propsOf(r), 160), clip(costumeNotesOf(r), 160), ""]),
  }];
  const props = ctx.breakdown?.props ?? [];
  sections.push({
    heading: "Master prop list",
    note: props.length ? "" : "No prop list yet — run the Script Breakdown.",
    columns: [{ h: "Prop", w: 22 }, { h: "Notes", w: 36 }, { h: "Scenes (found in the text)", w: 28 }, { h: "Ready", w: 7 }],
    rows: props.map((p) => [p.label, clip(textOf(p.notes), 200), P.rows.filter((r) => findIn(p.label, r)).map((r) => r.label).join(", ") || "—", ""]),
  });
  const costumes = ctx.breakdown?.costumes ?? [];
  sections.push({
    heading: "Costume by character",
    note: costumes.length ? "" : "No costume list yet — run the Script Breakdown.",
    columns: [{ h: "Character", w: 18 }, { h: "Costume", w: 44 }, { h: "Scenes", w: 8 }, { h: "Days", w: 18 }, { h: "Ready", w: 7 }],
    rows: costumes.map((c) => { const list = P.rows.filter((r) => r.artists.includes(String(c.character).toUpperCase())); return [c.character, clip(textOf(c.description), 300), list.length, [...new Set(list.map((r) => r.day).filter(Boolean))].sort((a, b) => a - b).map((d) => `Day ${d}`).join(", ") || "—", ""]; }),
  });
  return { title: "Props & Costume List", subtitle: sub(ctx), sections };
}

function continuity(ctx, P) {
  const rows = [];
  for (const r of inShootOrder(P.rows)) {
    for (const a of r.artists) rows.push([r.label, r.day ? `Day ${r.day}` : "", r.place, r.timeOfDay, a, clip(P.costume.get(a) ?? "", 120), clip(costumeNotesOf(r), 120), "", clip(propsOf(r), 120), ""]);
  }
  return {
    title: "Continuity Sheet", subtitle: sub(ctx),
    sections: [{
      heading: "Artist by scene",
      note: "Look / make-up / injuries / hair and the continuity notes are for the AD or script supervisor to fill in on set." + (P.useAd ? "" : " Costume remarks and props need the Script Breakdown."),
      columns: [{ h: "Sc", w: 5 }, { h: "Day", w: 7 }, { h: "Place", w: 16 }, { h: "D/N", w: 6 }, { h: "Artist", w: 14 }, { h: "Costume", w: 22 }, { h: "Costume remarks", w: 20 }, { h: "Look / make-up", w: 16 }, { h: "Props", w: 18 }, { h: "Continuity notes", w: 22 }],
      rows,
    }],
  };
}

function sceneBreakdown(ctx, P) {
  return {
    title: "Scene Breakdown Sheet", subtitle: sub(ctx),
    sections: [{
      heading: "All scenes",
      note: warnings(ctx, P.rows).join(" "),
      columns: [{ h: "Sc", w: 5 }, { h: "Day", w: 7 }, { h: "INT/EXT", w: 6 }, { h: "Place", w: 16 }, { h: "D/N", w: 6 }, { h: "Min", w: 5 }, { h: "Cast", w: 16 }, { h: "Extras", w: 14 }, { h: "Props", w: 16 }, { h: "Costume", w: 16 }, { h: "Written", w: 7 }, { h: "Tag", w: 8 }],
      rows: P.rows.map((r) => [r.label, r.day ? `Day ${r.day}` : "", r.intExt, r.place, r.timeOfDay, num(r.minutes), r.cast, clip(adText(r.ad?.extras), 80), clip(propsOf(r), 80), clip(costumeNotesOf(r), 80), r.written ? "yes" : "NO", r.tag?.tag ?? ""]),
    }],
  };
}

function oneLiner(ctx, P) {
  const eps = [...new Set(P.rows.map((r) => r.episode))];
  const sections = eps.map((e) => ({
    heading: e === null ? "One-liner list" : `Episode ${e + 1}`,
    columns: [{ h: "Sc", w: 6 }, { h: "INT/EXT", w: 7 }, { h: "Place", w: 22 }, { h: "D/N", w: 7 }, { h: "Min", w: 5 }, { h: "Cast", w: 22 }, { h: "One line", w: 44 }],
    rows: P.rows.filter((r) => r.episode === e).map((r) => [r.label, r.intExt, r.place, r.timeOfDay, num(r.minutes), r.cast, clip(r.gist, 220)]),
  }));
  return { title: "One-liner List", subtitle: sub(ctx), sections };
}

function dayNight(ctx, P) {
  const cell = (list) => `${list.length} sc · ${num(list.reduce((n, r) => n + r.minutes, 0))} min`;
  const isExt = (r) => r.intExt === "EXT";
  const matrix = { columns: [{ h: "", w: 14 }, { h: "DAY", w: 18 }, { h: "NIGHT", w: 18 }, { h: "Total", w: 18 }], rows: [] };
  for (const [label, test] of [["INT", (r) => !isExt(r)], ["EXT", isExt]]) {
    const l = P.rows.filter(test);
    matrix.rows.push([label, cell(l.filter((r) => !r.night)), cell(l.filter((r) => r.night)), cell(l)]);
  }
  matrix.rows.push(["Total", cell(P.rows.filter((r) => !r.night)), cell(P.rows.filter((r) => r.night)), cell(P.rows)]);
  const sections = [{ heading: "Whole script", ...matrix }];
  if (ctx.plan) {
    sections.push({
      heading: "Per shoot day",
      columns: [{ h: "Day", w: 8 }, { h: "INT", w: 14 }, { h: "EXT", w: 14 }, { h: "DAY", w: 14 }, { h: "NIGHT", w: 14 }, { h: "Total", w: 16 }],
      rows: ctx.plan.days.filter((d) => d.sceneIds.length).map((d) => { const l = P.rows.filter((r) => r.day === d.day); return [`Day ${d.day}`, cell(l.filter((r) => !isExt(r))), cell(l.filter(isExt)), cell(l.filter((r) => !r.night)), cell(l.filter((r) => r.night)), cell(l)]; }),
    });
  }
  return { title: "Day-Night & INT-EXT Summary", subtitle: sub(ctx), sections };
}

function changedScenes(ctx, P) {
  const TAGS = { change: "RED — change", check: "YELLOW — check", new: "BLUE — new", done: "GREEN — done" };
  const tagged = P.rows.filter((r) => r.tag);
  const changed = P.rows.filter((r) => ctx.changedIds?.includes(r.id));
  return {
    title: "Changed & Pending Scenes", subtitle: sub(ctx),
    sections: [
      { heading: "Scenes with a colour tag", note: tagged.length ? "" : "No scene is tagged.", columns: [{ h: "Sc", w: 6 }, { h: "Place", w: 20 }, { h: "Tag", w: 14 }, { h: "Note", w: 44 }, { h: "Set by", w: 14 }, { h: "Done by", w: 14 }], rows: tagged.map((r) => [r.label, r.place, TAGS[r.tag.tag] ?? r.tag.tag, clip(r.tag.note, 300), r.tag.by ?? "", r.tag.doneBy ?? ""]) },
      { heading: "Scenes not written yet", note: "Their cast is not known until they are written.", columns: [{ h: "Sc", w: 6 }, { h: "Place", w: 22 }, { h: "Min", w: 6 }, { h: "One line", w: 56 }], rows: P.rows.filter((r) => !r.written).map((r) => [r.label, r.place, num(r.minutes), clip(r.gist, 200)]) },
      ...(ctx.plan ? [{ heading: "Changed after the schedule was made", note: changed.length ? "Run the Smart Scheduler again to include these." : "Nothing changed since the plan.", columns: [{ h: "Sc", w: 6 }, { h: "Day", w: 8 }, { h: "Place", w: 22 }, { h: "Cast now", w: 30 }], rows: changed.map((r) => [r.label, r.day ? `Day ${r.day}` : "—", r.place, r.cast]) }] : []),
    ],
  };
}

function extras(ctx, P) {
  const rows = [];
  for (const r of inShootOrder(P.rows)) {
    const fromBreakdown = clip(adText(r.ad?.extras), 160);
    const found = [...new Set([...`${r.gist} ${r.body ?? ""}`.matchAll(CROWD)].map((m) => m[0].toLowerCase()))].join(", ");
    if (fromBreakdown || found) rows.push([r.label, r.day ? `Day ${r.day}` : "", r.place, r.timeOfDay, fromBreakdown, found, "", ""]);
  }
  return {
    title: "Extras & Crowd List", subtitle: sub(ctx),
    sections: [{
      heading: "Scenes that need extras",
      note: `${rows.length ? "Words found in the text are only hints — the AD decides how many people each scene needs." : "No extras or crowd words found."}${P.useAd ? "" : " (The Script Breakdown's extras column is empty: it has not been run for this project.)"}`,
      columns: [{ h: "Sc", w: 5 }, { h: "Day", w: 7 }, { h: "Place", w: 18 }, { h: "D/N", w: 6 }, { h: "Extras (Script Breakdown)", w: 28 }, { h: "Found in the text", w: 22 }, { h: "How many", w: 9 }, { h: "Notes", w: 18 }],
      rows,
    }],
  };
}

const BUILDERS = { "d-sheet": dSheet, "location-schedule": locationSchedule, "location-artists": locationArtists, "call-sheet": callSheet, "artist-schedule": artistSchedule, "props-costume": propsCostume, continuity, "scene-breakdown": sceneBreakdown, "one-liner": oneLiner, "day-night": dayNight, "changed-scenes": changedScenes, extras };

export function buildDocument(kind, ctx) {
  const build = BUILDERS[kind];
  if (!build) throw Object.assign(new Error("Unknown document."), { status: 404 });
  return build({ madeOn: new Date().toISOString().slice(0, 10), ...ctx }, prepare(ctx));
}
