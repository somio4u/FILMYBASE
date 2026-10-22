// The Smart Scheduler's arithmetic: given the scenes (where, who, how long), the number of shoot days and the owner's categories
// (artists: costly / normal / cheap; locations: free / paid) it finds the day plan with the lowest cost that fits the days.
// No AI and no luck: the same input always gives the same plan (a seeded search). The AI only helps BEFORE this (merging names,
// finding scenes that must stay together or in order); the numbers come from here.
//
// Cost, in "units" (relative until real rupee rates are given):
//   an artist called for a day      costly 5 · normal 2 · cheap 1
//   a paid location used for a day  3 (a free one 0, plus 0.2 so shooting at one place on fewer days still wins)
//   each extra location on one day  1 (a company move; real distances will replace this later)
//   a day mixing day and night      1.5

export const ARTIST_WEIGHT = { costly: 5, normal: 2, cheap: 1 };
export const LOCATION_WEIGHT = { paid: 3, free: 0 };
const MOVE_WEIGHT = 1;
const MIX_WEIGHT = 1.5;
const LOCATION_DAY_TIEBREAK = 0.2;
const OVERLOAD_WEIGHT = 12; // per minute over a day's limit
const BALANCE_WEIGHT = 0.08; // keeps the days about equally full
const RULE_WEIGHT = 50; // a "must be the same day" / "must come before" rule that is broken

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
const artistWeight = (name, cats) => ARTIST_WEIGHT[cats?.[name]] ?? ARTIST_WEIGHT.normal;
const locationWeight = (name, cats) => LOCATION_WEIGHT[cats?.[name]] ?? LOCATION_WEIGHT.free;

// the cost of one assignment (dayOf[i] = the day index of scene i), the parts shown to the owner and the broken rules
export function evaluate(scenes, dayOf, days, ctx) {
  const { artistCategory, locationCategory, cap, sameDay, order } = ctx;
  const minutes = new Array(days).fill(0);
  const locs = Array.from({ length: days }, () => new Set());
  const night = new Array(days).fill(false);
  const day = new Array(days).fill(false);
  const artistDays = new Map();
  const locationDays = new Map();
  scenes.forEach((s, i) => {
    const d = dayOf[i];
    minutes[d] += s.minutes;
    locs[d].add(s.location);
    (s.night ? night : day)[d] = true;
    for (const a of s.artists) { if (!artistDays.has(a)) artistDays.set(a, new Set()); artistDays.get(a).add(d); }
    if (!locationDays.has(s.location)) locationDays.set(s.location, new Set());
    locationDays.get(s.location).add(d);
  });
  let artistCost = 0;
  for (const [a, set] of artistDays) artistCost += artistWeight(a, artistCategory) * set.size;
  let locationCost = 0;
  for (const [l, set] of locationDays) locationCost += (locationWeight(l, locationCategory) + LOCATION_DAY_TIEBREAK) * set.size;
  let moves = 0;
  let mixed = 0;
  let overload = 0;
  const total = minutes.reduce((n, m) => n + m, 0);
  const avg = total / days;
  let balance = 0;
  for (let d = 0; d < days; d++) {
    moves += Math.max(0, locs[d].size - 1);
    if (night[d] && day[d]) mixed++;
    overload += Math.max(0, minutes[d] - cap);
    balance += (minutes[d] - avg) ** 2;
  }
  let broken = 0;
  const index = ctx.indexById;
  for (const group of sameDay) {
    const used = new Set(group.map((id) => dayOf[index.get(id)]).filter((x) => x !== undefined));
    broken += Math.max(0, used.size - 1);
  }
  for (const [a, b] of order) if (dayOf[index.get(a)] > dayOf[index.get(b)]) broken++;
  const energy = artistCost + locationCost + MOVE_WEIGHT * moves + MIX_WEIGHT * mixed + OVERLOAD_WEIGHT * overload + BALANCE_WEIGHT * balance + RULE_WEIGHT * broken;
  let locationDayCount = 0;
  for (const set of locationDays.values()) locationDayCount += set.size;
  return { energy, artistCost, locationCost, locationDayCount, moves, mixed, overload, broken, minutes };
}

function greedyStart(scenes, days, cap) {
  const dayOf = new Array(scenes.length).fill(0);
  const load = new Array(days).fill(0);
  const clusters = new Map();
  scenes.forEach((s, i) => { if (!clusters.has(s.location)) clusters.set(s.location, []); clusters.get(s.location).push(i); });
  const list = [...clusters.values()].sort((a, b) => b.reduce((n, i) => n + scenes[i].minutes, 0) - a.reduce((n, i) => n + scenes[i].minutes, 0));
  for (const members of list) {
    const minutes = members.reduce((n, i) => n + scenes[i].minutes, 0);
    let best = 0;
    for (let d = 1; d < days; d++) if (load[d] < load[best]) best = d;
    if (load[best] + minutes <= cap) {
      members.forEach((i) => { dayOf[i] = best; });
      load[best] += minutes;
    } else {
      for (const i of members) {
        let d0 = 0;
        for (let d = 1; d < days; d++) if (load[d] < load[d0]) d0 = d;
        dayOf[i] = d0;
        load[d0] += scenes[i].minutes;
      }
    }
  }
  return dayOf;
}

function anneal(scenes, days, ctx, startDayOf, seed, iterations) {
  const random = mulberry32(seed);
  let current = startDayOf.slice();
  let currentE = evaluate(scenes, current, days, ctx).energy;
  let best = current.slice();
  let bestE = currentE;
  const n = scenes.length;
  if (n < 2 || days < 2) return { dayOf: best, energy: bestE };
  const t0 = 3;
  const t1 = 0.01;
  for (let step = 0; step < iterations; step++) {
    const temperature = t0 * (t1 / t0) ** (step / iterations);
    const next = current.slice();
    if (random() < 0.7) {
      const i = Math.floor(random() * n);
      let d = Math.floor(random() * (days - 1));
      if (d >= next[i]) d++;
      next[i] = d;
    } else {
      const i = Math.floor(random() * n);
      const j = Math.floor(random() * n);
      if (next[i] === next[j]) continue;
      [next[i], next[j]] = [next[j], next[i]];
    }
    const e = evaluate(scenes, next, days, ctx).energy;
    if (e <= currentE || random() < Math.exp((currentE - e) / temperature)) {
      current = next;
      currentE = e;
      if (e < bestE - 1e-9) { best = next.slice(); bestE = e; }
    }
  }
  return { dayOf: best, energy: bestE };
}

// the plan to compare with: the scenes in story order, cut into days of about equal length (how a first draft is often made)
function storyOrderBaseline(scenes, days, ctx) {
  const total = scenes.reduce((n, s) => n + s.minutes, 0);
  const per = total / days;
  const dayOf = [];
  let day = 0;
  let load = 0;
  for (const s of scenes) {
    if (load >= per - 1e-9 && day < days - 1) { day++; load = 0; }
    dayOf.push(day);
    load += s.minutes;
  }
  return evaluate(scenes, dayOf, days, ctx);
}

// scenes: [{ id, label, minutes, location, night, artists: [names] }]
export function solveSchedule({ scenes, days, artistCategory = {}, locationCategory = {}, maxMinutesPerDay = null, sameDay = [], order = [], seed = 7, iterations = 30000 }) {
  days = Math.max(1, Math.floor(days));
  const total = scenes.reduce((n, s) => n + s.minutes, 0);
  const cap = maxMinutesPerDay && maxMinutesPerDay > 0 ? maxMinutesPerDay : Math.max(1, round1((total / days) * 1.25));
  const indexById = new Map(scenes.map((s, i) => [s.id, i]));
  const ids = new Set(indexById.keys());
  const rules = {
    sameDay: sameDay.map((g) => g.filter((id) => ids.has(id))).filter((g) => g.length > 1),
    order: order.filter(([a, b]) => ids.has(a) && ids.has(b)),
  };
  const ctx = { artistCategory, locationCategory, cap, sameDay: rules.sameDay, order: rules.order, indexById };

  let best = null;
  for (let r = 0; r < 3; r++) {
    const start = r === 0 ? greedyStart(scenes, days, cap) : scenes.map((_, i) => (i * 7 + r * 3) % days);
    const result = anneal(scenes, days, ctx, start, seed + r * 101, iterations);
    if (!best || result.energy < best.energy - 1e-9) best = result;
  }
  const dayOf = best.dayOf;
  const final = evaluate(scenes, dayOf, days, ctx);
  const baseline = storyOrderBaseline(scenes, days, ctx);

  // the days, with scenes grouped by place (day scenes before night ones), and the per-artist / per-location tables
  const dayList = Array.from({ length: days }, (_, d) => ({ day: d + 1, sceneIds: [], minutes: 0, locations: [], artists: [], night: false, mixed: false }));
  scenes.forEach((s, i) => dayList[dayOf[i]].sceneIds.push(s.id));
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  for (const d of dayList) {
    const first = new Map();
    d.sceneIds.forEach((id, k) => { const loc = sceneById.get(id).location; if (!first.has(loc)) first.set(loc, k); });
    d.sceneIds.sort((a, b) => {
      const sa = sceneById.get(a); const sb = sceneById.get(b);
      return (sa.night - sb.night) || (first.get(sa.location) - first.get(sb.location)) || (indexById.get(a) - indexById.get(b));
    });
    d.minutes = round1(d.sceneIds.reduce((n, id) => n + sceneById.get(id).minutes, 0));
    d.locations = [...new Set(d.sceneIds.map((id) => sceneById.get(id).location))];
    d.artists = [...new Set(d.sceneIds.flatMap((id) => sceneById.get(id).artists))].sort();
    const nights = d.sceneIds.filter((id) => sceneById.get(id).night).length;
    d.night = nights > 0 && nights === d.sceneIds.length;
    d.mixed = nights > 0 && nights < d.sceneIds.length;
  }

  const artistNames = [...new Set(scenes.flatMap((s) => s.artists))].sort();
  const artists = artistNames.map((name) => {
    const dl = dayList.filter((d) => d.artists.includes(name)).map((d) => d.day);
    const mins = scenes.filter((s) => s.artists.includes(name)).reduce((n, s) => n + s.minutes, 0);
    const category = ARTIST_WEIGHT[artistCategory[name]] ? artistCategory[name] : "normal";
    return {
      name, category, callDays: dl.length, days: dl, minutes: round1(mins),
      lowerBound: Math.max(1, Math.ceil(mins / cap - 1e-9)),
      span: dl.length ? dl[dl.length - 1] - dl[0] + 1 : 0,
      costUnits: ARTIST_WEIGHT[category] * dl.length,
    };
  }).sort((a, b) => b.costUnits - a.costUnits || a.name.localeCompare(b.name));
  const locationNames = [...new Set(scenes.map((s) => s.location))].sort();
  const locations = locationNames.map((name) => {
    const dl = dayList.filter((d) => d.locations.includes(name)).map((d) => d.day);
    const category = LOCATION_WEIGHT[locationCategory[name]] !== undefined ? locationCategory[name] : "free";
    return { name, category, dayCount: dl.length, days: dl, minutes: round1(scenes.filter((s) => s.location === name).reduce((n, s) => n + s.minutes, 0)), costUnits: LOCATION_WEIGHT[category] * dl.length };
  }).sort((a, b) => b.costUnits - a.costUnits || a.name.localeCompare(b.name));

  const dayMinutes = dayList.map((d) => d.minutes);
  const costUnits = round1(final.artistCost + final.locationCost - LOCATION_DAY_TIEBREAK * final.locationDayCount + final.moves * MOVE_WEIGHT + final.mixed * MIX_WEIGHT);
  const baseUnits = round1(baseline.artistCost + baseline.locationCost - LOCATION_DAY_TIEBREAK * baseline.locationDayCount + baseline.moves * MOVE_WEIGHT + baseline.mixed * MIX_WEIGHT);
  const daysNeeded = Math.max(1, Math.ceil(total / cap - 1e-9));
  const warnings = [];
  const feasible = total <= days * cap + 1e-9 && final.overload < 1e-9;
  if (!feasible) warnings.push(`This much film (${round1(total)} min) does not fit ${days} days at ${cap} min a day: at least ${daysNeeded} days are needed, or raise the minutes allowed per day.`);
  if (!maxMinutesPerDay && total / days > 12) warnings.push(`That is ${round1(total / days)} minutes of finished film every day — far above the usual 8 to 10 minutes. Expect overtime or cut scenes.`);
  if (final.broken > 0) warnings.push("Some \"keep together / keep in order\" rules could not all be met with this number of days.");

  return {
    days: dayList,
    artists,
    locations,
    totals: {
      costUnits, baselineUnits: baseUnits, savedPercent: baseUnits > 0 ? Math.max(0, Math.round(((baseUnits - costUnits) / baseUnits) * 100)) : 0,
      artistUnits: artists.reduce((n, a) => n + a.costUnits, 0), locationUnits: locations.reduce((n, l) => n + l.costUnits, 0),
      artistDays: artists.reduce((n, a) => n + a.callDays, 0), moves: final.moves, mixedDays: final.mixed,
      minutes: round1(total), maxDayMinutes: Math.max(...dayMinutes), minDayMinutes: Math.min(...dayMinutes), avgDayMinutes: round1(total / days),
    },
    capacity: cap, feasible, daysNeeded, warnings,
  };
}
