// "Rename a character in the whole script": every scene's latest written version, plus the scene list's outline lines.
// A name is replaced only as a WHOLE name: "SULA" in "SULA walks in" or "SULAଙ୍କୁ" (an Odia ending stuck to the name) changes,
// "SULATA" and "ASULA" do not. The case style is kept (SULA -> SULAGNA, Sula -> Sulagna, sula -> sulagna).

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function nameRegex(from) {
  // only Latin letters / digits count as "part of the name"; Odia or Hindi letters next to it do not
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(String(from).trim())}(?![A-Za-z0-9])`, "gi");
}

function matchCase(found, to) {
  if (found.length > 1 && found === found.toUpperCase()) return to.toUpperCase();
  if (found[0] === found[0].toUpperCase() && found[0] !== found[0].toLowerCase()) return to.charAt(0).toUpperCase() + to.slice(1);
  return to.charAt(0).toLowerCase() + to.slice(1);
}

export function renameInText(text, from, to) {
  if (typeof text !== "string" || !text) return { text, count: 0 };
  let count = 0;
  const out = text.replace(nameRegex(from), (found) => { count++; return matchCase(found, String(to).trim()); });
  return { text: out, count };
}

// elements of one scene -> { elements, speakers (dialogue lines whose speaker changed), mentions (inside the words) }
export function renameInElements(elements, from, to) {
  let speakers = 0;
  let mentions = 0;
  const next = (elements ?? []).map((e) => {
    const out = { ...e };
    if (e.type === "dialogue" && typeof e.character === "string") {
      const r = renameInText(e.character, from, to);
      if (r.count > 0) { out.character = r.text.toUpperCase(); speakers++; }
    } else if (e.type === "flashback" && typeof e.character === "string") {
      const r = renameInText(e.character, from, to);
      if (r.count > 0) { out.character = r.text.toUpperCase(); mentions += r.count; }
    }
    for (const key of ["text", "parenthetical"]) {
      if (typeof e[key] === "string") {
        const r = renameInText(e[key], from, to);
        if (r.count > 0) { out[key] = r.text; mentions += r.count; }
      }
    }
    return out;
  });
  return { elements: next, speakers, mentions };
}

export function renameInScreenplay(content, from, to) {
  const r = renameInElements(content?.elements, from, to);
  const present = Array.isArray(content?.charactersPresent) ? content.charactersPresent.map((c) => { const x = renameInText(String(c), from, to); return x.count ? x.text.toUpperCase() : c; }) : content?.charactersPresent;
  const changed = r.speakers + r.mentions > 0 || (Array.isArray(present) && present.some((c, i) => c !== content.charactersPresent[i]));
  return { content: { ...content, elements: r.elements, ...(present ? { charactersPresent: [...new Set(present)] } : {}) }, changed, speakers: r.speakers, mentions: r.mentions };
}

// the scene list's own text: the outline lines ({en, or, hi}) and the character names
export function renameInSceneList(sceneListContent, from, to) {
  let count = 0;
  const fix = (value) => {
    if (typeof value === "string") { const r = renameInText(value, from, to); count += r.count; return r.text; }
    if (value && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === "string" ? fix(v) : v]));
    return value;
  };
  const fixScene = (s) => ({ ...s, oneLiner: fix(s.oneLiner) });
  const next = { ...sceneListContent };
  if (Array.isArray(next.scenes)) next.scenes = next.scenes.map(fixScene);
  if (Array.isArray(next.episodeScenes)) next.episodeScenes = next.episodeScenes.map((ep) => ({ ...ep, scenes: (ep.scenes ?? []).map(fixScene) }));
  if (Array.isArray(next.characterNames)) next.characterNames = [...new Set(next.characterNames.map((n) => { const r = renameInText(String(n), from, to); return r.count ? r.text.toUpperCase() : n; }))];
  return { content: next, count };
}

export function validRename(from, to) {
  const a = String(from ?? "").trim();
  const b = String(to ?? "").trim();
  if (!a || !b) return "Give the old name and the new name.";
  if (a.length > 60 || b.length > 60) return "The names are too long.";
  if (a.toUpperCase() === b.toUpperCase()) return "The new name is the same as the old one.";
  if (/[\n\r]/.test(a + b)) return "A name is one line.";
  return null;
}
