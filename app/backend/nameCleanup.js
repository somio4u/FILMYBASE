// "Names & places": the same artist or place is often written in several ways ("Soumya" / "Saumia", "Temple Sanctum" / "Temple Kutiyar" /
// "Temple Interior"). This file finds likely duplicates to SUGGEST (the owner decides), and applies the owner's decisions (a map
// "this name = that name") to the scenes. Pure functions, no database.

const IN_OUT = /\b(INT|EXT|INTERIOR|EXTERIOR|INSIDE|OUTSIDE)\b\.?/g;

// "Temple Interior" and "Temple Exterior" are one place: the in/out word is not part of the place's name
export function normalizeLocation(name) {
  const upper = String(name ?? "").toUpperCase().replace(/\s+/g, " ").trim();
  const cleaned = upper.replace(IN_OUT, " ").replace(/[\s/,-]+$/g, "").replace(/^[\s/,-]+/g, "").replace(/\s{2,}/g, " ").trim();
  return cleaned || upper;
}

// consonant skeleton: SOUMYA and SAUMIA are both "SM"
export function skeleton(name) {
  return String(name ?? "").toUpperCase().replace(/[^A-Z]/g, "").replace(/[AEIOUY]/g, "").replace(/(.)\1+/g, "$1");
}

export function levenshtein(a, b) {
  const m = a.length; const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}

const digitsOnlyDiffer = (a, b) => /\d/.test(a + b) && a.replace(/\d+/g, "#") === b.replace(/\d+/g, "#");

function groupsFromPairs(names, linked) {
  const parent = new Map(names.map((n) => [n, n]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) if (linked(names[i], names[j])) parent.set(find(names[i]), find(names[j]));
  const groups = new Map();
  for (const n of names) { const r = find(n); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n); }
  return [...groups.values()].filter((g) => g.length > 1);
}

// artists whose names look like the same person written two ways
export function suggestArtistGroups(names) {
  return groupsFromPairs(names, (a, b) => {
    if (digitsOnlyDiffer(a, b)) return false; // VILLAGER 1 / VILLAGER 2 are different people
    const la = a.replace(/[^A-Z]/g, "").length; const lb = b.replace(/[^A-Z]/g, "").length;
    if (skeleton(a).length >= 2 && skeleton(a) === skeleton(b) && Math.abs(la - lb) <= 2) return true;
    return Math.min(la, lb) >= 5 && 1 - levenshtein(a, b) / Math.max(a.length, b.length) >= 0.8;
  });
}

const STOP = new Set(["THE", "OF", "AND", "NEAR", "OLD", "NEW", "MAIN", "BIG", "SMALL", "HOUSE", "ROAD", "ROOM"]);

// places that share a first word ("TEMPLE KUTIYAR", "TEMPLE SANCTUM", "TEMPLE"), or one name inside another, or a typo apart.
// A first word that is an artist's name ("MALATI HOUSE", "MALATI CLINIC") is NOT a hint: different places of one person.
export function suggestLocationGroups(names, artistNames = []) {
  const people = new Set(artistNames.flatMap((n) => String(n).toUpperCase().split(/\s+/)));
  const tokens = (n) => n.split(/\s+/).filter(Boolean);
  const first = (n) => tokens(n)[0] ?? "";
  return groupsFromPairs(names, (a, b) => {
    const ta = tokens(a); const tb = tokens(b);
    const f = first(a);
    if (f && f === first(b) && f.length >= 4 && !STOP.has(f) && !people.has(f)) return true;
    const small = ta.length <= tb.length ? ta : tb; const big = ta.length <= tb.length ? tb : ta;
    if (small.length < big.length && small.every((t) => big.includes(t)) && !small.every((t) => STOP.has(t) || people.has(t))) return true;
    return Math.min(a.length, b.length) >= 5 && 1 - levenshtein(a, b) / Math.max(a.length, b.length) >= 0.85;
  });
}

// the owner's decisions: map { ALIAS: CANONICAL }. Following a name to its final form (never loops)
export function resolveName(map, name) {
  let n = name; let guard = 0;
  while (map && map[n] && map[n] !== n && guard++ < 6) n = map[n];
  return n;
}

// "these names are one: CANONICAL" — keeps the map flat (names that pointed to a now-merged name follow to the new one)
export function mergeIntoMap(map, names, canonical) {
  const target = resolveName(map, String(canonical).toUpperCase().trim());
  const next = { ...map };
  delete next[target];
  const merged = new Set(names.map((n) => String(n).toUpperCase().trim()).filter(Boolean));
  merged.delete(target);
  for (const [alias, canon] of Object.entries(next)) if (merged.has(canon)) next[alias] = target;
  for (const n of merged) next[n] = target;
  return next;
}

// the scenes with the owner's names: place and artists replaced by their final names (the original place name is kept in rawLocation)
export function applyNameMap(rows, maps) {
  return rows.map((r) => ({
    ...r,
    rawLocation: r.rawLocation ?? r.location,
    rawArtists: r.rawArtists ?? r.artists,
    location: resolveName(maps?.location, r.location),
    artists: [...new Set((r.rawArtists ?? r.artists).map((a) => resolveName(maps?.artist, a)))].sort(),
  }));
}

export const dismissKey = (names) => [...names].map((n) => String(n).toUpperCase()).sort().join("|");
