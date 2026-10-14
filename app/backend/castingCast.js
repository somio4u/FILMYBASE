// THE CASTING LIST. The director pastes their list of major characters
// ("1  Soumya (ସୌମ୍ୟ)  Very High  10/10") — more than the character sheet holds.
// This module
//   1. reads that list (parseCastList — plain rules, no AI),
//   2. asks the AI to fill what a casting slide needs for EVERY name — which of
//      the four groups they belong to, age, look, importance in the series,
//      relation to the protagonist/antagonist, a short arc — using the story and,
//      where the character sheet already has the person, that sheet as the truth,
//   3. gives the PPT builder a plain list. The model is passed in as `ask`.
// Five sections; a section can hold several people (e.g. three female leads).
export const GROUPS = ["protagonist", "heroine", "villain", "sidekick", "supporting"];

// "1  Soumya (ସୌମ୍ୟ)  Very High  10/10"  — tabs or spaces; Odia/Hindi name in brackets optional
export function parseCastList(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/ /g, " ").trim();
    if (!line || /^rank\b/i.test(line)) continue;
    // split on tabs first (pasted tables), else on 2+ spaces
    let cells = line.split(/\t+/).map((c) => c.trim()).filter(Boolean);
    if (cells.length < 3) cells = line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    const glued = cells[0]?.match(/^(\d{1,3})[.)]\s+(.+)$/); // "2. Ratan"
    if (glued) cells.splice(0, 1, glued[1], glued[2]);
    let rank = null;
    if (cells.length && /^\d{1,3}$/.test(cells[0])) rank = Number(cells.shift());
    if (!cells.length) continue;
    const nameCell = cells.shift();
    const score = cells.length && /^\d+(?:\.\d+)?\s*\/\s*10$/.test(cells[cells.length - 1]) ? cells.pop().replace(/\s+/g, "") : "";
    const bracket = nameCell.match(/^(.*?)\s*[(（]([^)）]+)[)）]\s*$/);
    const name = (bracket ? bracket[1] : nameCell).trim();
    if (!name || /^\d+$/.test(name)) continue;
    out.push({ rank: rank ?? out.length + 1, name, odiaName: bracket ? bracket[2].trim() : "", screenTime: cells.join(" ").trim(), score });
  }
  return out;
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z\p{L}\p{M}]+/gu, " ").trim();
function matchSheet(item, sheetCharacters) {
  const names = [norm(item.name), norm(item.odiaName)].filter(Boolean);
  return (sheetCharacters ?? []).find((c) => {
    const n = norm(c.name);
    const first = n.split(" ")[0];
    return names.some((m) => m === n || m.split(" ")[0] === first);
  });
}

const BI = { type: "OBJECT", properties: { en: { type: "STRING" }, or: { type: "STRING" } }, required: ["en", "or"] };
const CAST_SCHEMA = {
  type: "OBJECT",
  properties: {
    cast: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "Exactly as given in the list." },
          group: { type: "STRING", enum: GROUPS },
          age: { type: "STRING", description: "Age or age range, e.g. '24' or '45-50'." },
          look: BI,
          about: BI,
          importance: BI,
          relation: BI,
          arc: BI,
        },
        required: ["name", "group", "age", "look", "about", "importance", "relation", "arc"],
      },
    },
  },
  required: ["cast"],
};

const CAST_SYSTEM = `You are the casting-department writer for an Odia (Odisha) film/series. You get the story, the director's list of major characters, and, for some of them, the full character sheet already written. For EVERY name in the list write a short casting-slide entry in English ("en") and Odia ("or", in Odia script; character names stay as in the list).
Rules:
- group: exactly one of protagonist (the main hero), heroine (the female leads — there can be several), villain (the main antagonist and people clearly on the antagonist's side), sidekick (the hero's or heroine's friends, allies and helpers), supporting (any other important role: police, elders, family, flashback figures). If a character's sheet gives an archetype, use it as a hint. Several characters may share a group.
- Where a character sheet exists, keep the age, look and facts exactly as the sheet has them; shorten, do not change.
- Where there is no sheet, infer from the story, and keep it plausible and consistent with the other characters. Never contradict the story.
- about: 2 short sentences — who this person is.
- importance: 1 short sentence — why the character matters in the series.
- relation: 1 short sentence — the relation to the main protagonist or the main antagonist.
- arc: 1 short sentence — how the character changes (or stays) from the first episode to the last.
- look: a casting description (build, face, age feel, style) in 1 sentence.`;

function storyContext(deck) {
  const en = (v) => (v && typeof v === "object" ? v.en || "" : v || "");
  const episodes = (deck?.episodes ?? []).map((e, i) => `Ep ${i + 1} ${en(e.title)}: ${en(e.synopsis)}`).join("\n").slice(0, 9000);
  return `Title: ${en(deck?.title)}\nLogline: ${en(deck?.logline)}\nPremise: ${en(deck?.premise)}\nTone/Genre: ${en(deck?.toneGenre)}\n${episodes ? `Episodes:\n${episodes}` : ""}`;
}

export async function buildCast({ listText, sheetCharacters = [], deck = null, ask }) {
  const items = parseCastList(listText);
  if (items.length === 0) throw Object.assign(new Error("I could not find any characters in your list. Paste it like: 1  Soumya (ସୌମ୍ୟ)  Very High  10/10 — one character per line."), { status: 400 });
  if (items.length > 30) throw Object.assign(new Error("That is more than 30 characters. Paste only the major ones."), { status: 400 });

  const lines = items.map((item) => {
    const sheet = matchSheet(item, sheetCharacters);
    const sheetText = sheet ? `\n   CHARACTER SHEET (truth): ${JSON.stringify({ name: sheet.name, age: sheet.age, look: sheet.look, relationToHero: sheet.relationToHero, archetype: sheet.archetype, role: sheet.role?.en, archetypeNote: sheet.archetypeNote?.en, arc: sheet.arc?.en })}` : "\n   (no character sheet yet — infer from the story)";
    return `${item.rank}. ${item.name}${item.odiaName ? ` (${item.odiaName})` : ""} — screen time: ${item.screenTime || "?"}; story importance score: ${item.score || "?"}${sheetText}`;
  });
  const result = await ask(`THE STORY\n${storyContext(deck)}\n\nTHE DIRECTOR'S LIST OF MAJOR CHARACTERS (write an entry for every one, same names, same order):\n${lines.join("\n")}`, CAST_SCHEMA, CAST_SYSTEM);

  const byName = new Map((result.cast ?? []).map((c) => [norm(c.name), c]));
  const cast = items.map((item) => {
    const made = byName.get(norm(item.name)) ?? (result.cast ?? []).find((c) => norm(c.name).split(" ")[0] === norm(item.name).split(" ")[0]);
    const sheet = matchSheet(item, sheetCharacters);
    return {
      ...item,
      group: GROUPS.includes(made?.group) ? made.group : "supporting",
      age: sheet?.age || made?.age || "",
      look: made?.look ?? { en: sheet?.look ?? "", or: "" },
      about: made?.about ?? { en: "", or: "" },
      importance: made?.importance ?? { en: "", or: "" },
      relation: made?.relation ?? { en: "", or: "" },
      arc: made?.arc ?? { en: "", or: "" },
      fromSheet: Boolean(sheet),
    };
  });
  return cast;
}

// When no casting list was pasted yet, the PPT still works from the character sheet alone.
const SHEET_GROUP = { hero: "protagonist", shadow: "villain", ally: "sidekick", trickster: "sidekick" };
export function castFromSheet(characters = []) {
  return characters.map((c, i) => ({
    rank: i + 1, name: c.name, odiaName: "", screenTime: "", score: "",
    group: SHEET_GROUP[c.archetype] ?? "supporting",
    age: c.age || "",
    look: { en: c.look || "", or: "" },
    about: c.archetypeNote ?? c.role ?? { en: "", or: "" },
    importance: c.role ?? { en: "", or: "" },
    relation: { en: c.relationToHero || "", or: "" },
    arc: c.arc ?? { en: "", or: "" },
    fromSheet: true,
  }));
}

// ---------------------------------------------------------------------------
// FINDING CHARACTERS FROM THE SCRIPT. One click: the AI reads the story (pitch
// deck, story bible, scene one-liners) and lists the characters that matter,
// highest priority first, skipping those already in the PPT. The director adds
// them one by one.
// ---------------------------------------------------------------------------
const SCREEN_TIMES = ["Very High", "High", "Medium–High", "Medium", "Limited", "Limited / Flashbacks"];

// every scene one-liner in the scene list, wherever it sits in the structure
function collectOneLiners(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectOneLiners(n, out));
  else if (node && typeof node === "object") {
    if (node.oneLiner?.en) out.push(`${node.location?.en ? `${node.location.en}: ` : ""}${node.oneLiner.en}`);
    else Object.values(node).forEach((n) => collectOneLiners(n, out));
  }
  return out;
}

export function gatherScriptEvidence({ deck, bible = null, sceneListContent = null }) {
  const parts = [storyContext(deck)];
  if (bible?.characters) parts.push(`STORY BIBLE — characters:\n${JSON.stringify(bible.characters).slice(0, 9000)}`);
  const scenes = sceneListContent ? collectOneLiners(sceneListContent) : [];
  if (scenes.length) parts.push(`SCENES (in order):\n${scenes.map((s, i) => `${i + 1}. ${s}`).join("\n").slice(0, 16000)}`);
  return parts.join("\n\n");
}

const FIND_SCHEMA = {
  type: "OBJECT",
  properties: {
    characters: {
      type: "ARRAY",
      items: {
        ...CAST_SCHEMA.properties.cast.items,
        properties: {
          ...CAST_SCHEMA.properties.cast.items.properties,
          odiaName: { type: "STRING", description: "The name written in Odia script." },
          screenTime: { type: "STRING", enum: SCREEN_TIMES },
          score: { type: "NUMBER", description: "Story importance 0-10." },
        },
        required: [...CAST_SCHEMA.properties.cast.items.required, "odiaName", "screenTime", "score"],
      },
    },
  },
  required: ["characters"],
};

const FIND_SYSTEM = `${CAST_SYSTEM}

YOUR TASK NOW: read the whole story material and list every character that matters to casting, in ORDER OF PRIORITY (highest story importance and screen time first). Use each character's name exactly as the script spells it (English letters) and also give it in Odia script. Include flashback figures and short but pivotal roles; leave out unnamed extras and crowd. Do NOT list anyone from the "already in the PPT" list. Give at most 15.`;

export async function findCharacters({ evidence, sheetCharacters = [], existing = [], ask }) {
  const known = new Set(existing.map(norm));
  const sheetLines = sheetCharacters.map((c) => `- ${c.name} (${c.archetype}), age ${c.age}: ${c.role?.en ?? ""}`).join("\n");
  const result = await ask(
    `${evidence}\n\nCHARACTER SHEET ENTRIES THAT ALREADY EXIST (keep facts consistent):\n${sheetLines || "(none)"}\n\nALREADY IN THE PPT (do not list these): ${existing.join(", ") || "(none)"}`,
    FIND_SCHEMA,
    FIND_SYSTEM,
  );
  const seen = new Set();
  return (result.characters ?? [])
    .filter((c) => c?.name && !known.has(norm(c.name)) && !seen.has(norm(c.name)) && seen.add(norm(c.name)))
    .map((c, i) => {
      const sheet = matchSheet({ name: c.name, odiaName: c.odiaName }, sheetCharacters);
      return sanitizeCastEntry({ ...c, rank: i + 1, score: c.score != null ? `${c.score}/10` : "", age: sheet?.age || c.age, fromSheet: Boolean(sheet) });
    });
}

// Whatever comes from the browser or the AI is cut down to the fields a slide uses.
const str = (v, max = 400) => String(v ?? "").slice(0, max);
const bi = (v) => ({ en: str(v?.en), or: str(v?.or) });
export function sanitizeCastEntry(c) {
  return {
    rank: Number.isFinite(Number(c.rank)) ? Number(c.rank) : 0,
    name: str(c.name, 80).trim(),
    odiaName: str(c.odiaName, 80),
    screenTime: str(c.screenTime, 40),
    score: str(c.score, 10),
    group: GROUPS.includes(c.group) ? c.group : "supporting",
    age: str(c.age, 20),
    look: bi(c.look), about: bi(c.about), importance: bi(c.importance), relation: bi(c.relation), arc: bi(c.arc),
    fromSheet: Boolean(c.fromSheet),
  };
}

// The PPT list after adding one person (no duplicates by name).
export function addToCast(cast, entry) {
  const clean = sanitizeCastEntry(entry);
  if (!clean.name) return cast;
  return cast.some((c) => norm(c.name) === norm(clean.name)) ? cast : [...cast, clean];
}
