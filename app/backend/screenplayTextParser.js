// A finished screenplay (the plain text of a PDF / Word / Fountain / text file) -> scenes in the shape AI Movie uses, so it can become a draft of its own.
// No AI here: scene headings (INT. / EXT.), speaker names, brackets, dialogue, action lines and transitions are told apart by the usual screenplay layout.
// Dialogue keeps whatever language it is written in (Hindi in Devanagari, Hinglish, English); action keeps its own. Both language slots of a line hold the written text.

const HEADING = /^\s*(?:\d{1,4}[A-Z]?\s*[.):-]?\s+)?((?:INT|EXT|EST|INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|I\s*\/\s*E)\b\.?\s*[-–—:]?\s*.+?)\s*(?:\d{1,4}[A-Z]?)?\s*$/i;
const TRANSITION = /^\s*((?:SMASH |MATCH |JUMP |HARD )?CUT TO|DISSOLVE TO|FADE (?:IN|OUT|TO BLACK|TO WHITE)|WIPE TO|IRIS (?:IN|OUT)|FREEZE FRAME|SHARP CUT TO|BACK TO)\b[^a-z\n]*$/;
const EXTENSION = /\s*\((?:V\.?\s?O\.?|O\.?\s?S\.?|O\.?\s?C\.?|CONT'?D\.?|CONTINUED|FILTER|ON PHONE|PRE-?LAP)\)\s*/gi;

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const isBlank = (s) => !String(s ?? "").trim();
// a speaker's name on its own line: capital letters (or Devanagari/other scripts with no letter case) and a few marks, short
const looksLikeCue = (line) => {
  const t = squash(line.replace(EXTENSION, " "));
  if (!t || t.length > 36 || /[a-z]/.test(t) || /[.!?,;:]$/.test(t)) return false;
  if (!/\p{L}/u.test(t)) return false;
  return /^[\p{L}\p{M}0-9 .'’()\-&/]+$/u.test(t) && !HEADING.test(line) && !TRANSITION.test(line);
};

// removes what a PDF or a word processor adds around the script: page numbers, "(CONTINUED)", form feeds, a title page's page break
function clean(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(/\f/g, "\n").replace(/\u0000/g, "").split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => !/^\s*\d{1,4}\.?\s*$/.test(l) && !/^\s*\(?(?:CONTINUED|CONT'?D\.?)\)?:?\s*$/i.test(l) && !/^\s*(?:--\s*\d+\s*of\s*\d+\s*--)\s*$/i.test(l));
}

export function parseScreenplayText(text, { knownCharacters = [] } = {}) {
  const lines = clean(text);
  const known = [...new Set((knownCharacters ?? []).map((n) => squash(n).toUpperCase()).filter((n) => n.length >= 2))].sort((a, b) => b.length - a.length);
  const scenes = [];
  let scene = null;
  let action = [];
  const flushAction = () => { const t = squash(action.join(" ")); if (t && scene) scene.blocks.push({ type: "action", text: t }); action = []; };
  const startScene = (heading) => { flushAction(); scene = { heading: squash(heading).replace(/\s*[-–—]\s*$/, ""), blocks: [] }; scenes.push(scene); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) { flushAction(); continue; }
    const head = HEADING.exec(line);
    if (head) { startScene(head[1]); continue; }
    if (!scene) continue; // the title page and anything before the first scene heading
    if (TRANSITION.test(line)) { flushAction(); scene.blocks.push({ type: "transition", text: squash(line).toUpperCase().replace(/:$/, "") }); continue; }

    // a speaker's name on its own line, then (optionally) a bracket, then the lines they say
    const next = lines[i + 1];
    if (action.length === 0 && next !== undefined && !isBlank(next) && looksLikeCue(line) && !HEADING.test(next)) {
      const character = squash(line.replace(EXTENSION, " ")).toUpperCase();
      let j = i + 1, parenthetical = "";
      if (/^\s*\(.*\)\s*$/.test(lines[j])) { parenthetical = squash(lines[j]).replace(/^\(|\)$/g, ""); j++; }
      const said = [];
      while (j < lines.length && !isBlank(lines[j]) && !HEADING.test(lines[j]) && !TRANSITION.test(lines[j])) {
        const inline = /^\s*\(([^)]*)\)\s*(.*)$/.exec(lines[j]);
        if (inline && said.length === 0 && !parenthetical) { parenthetical = squash(inline[1]); if (inline[2]) said.push(inline[2]); } else said.push(lines[j]);
        j++;
      }
      const spoken = squash(said.join(" "));
      if (spoken) { flushAction(); scene.blocks.push({ type: "dialogue", character, parenthetical, text: spoken }); i = j - 1; continue; }
    }
    // an inline cue: "MIRA Step back!" — only for names the story file knows, so ordinary capital words are never mistaken for speakers
    const hit = action.length === 0 ? known.find((n) => line.toUpperCase().startsWith(`${n} `) && line.slice(0, n.length) === line.slice(0, n.length).toUpperCase()) : null;
    if (hit) {
      let rest = line.slice(hit.length).trim(), parenthetical = "";
      const p = /^\(([^)]*)\)\s*(.*)$/.exec(rest);
      if (p) { parenthetical = squash(p[1]); rest = p[2]; }
      const said = [rest];
      let j = i + 1;
      while (j < lines.length && !isBlank(lines[j]) && !HEADING.test(lines[j]) && !TRANSITION.test(lines[j]) && !known.some((n) => lines[j].toUpperCase().startsWith(`${n} `))) { said.push(lines[j]); j++; }
      const spoken = squash(said.join(" "));
      if (spoken) { flushAction(); scene.blocks.push({ type: "dialogue", character: hit, parenthetical, text: spoken }); i = j - 1; continue; }
    }
    action.push(line);
  }
  flushAction();
  return scenes.filter((s) => s.blocks.length > 0 || s.heading);
}

// the parsed scenes in the shape AI Movie keeps (both language slots hold the written text)
export function toAiMovieScenes(parsed) {
  const both = (t) => ({ en: t, hi: t });
  return parsed.map((s) => ({
    sceneHeading: both(s.heading),
    content: s.blocks.map((b) => (b.type === "dialogue"
      ? { type: "dialogue", character: b.character, line: both(b.text), ...(b.parenthetical ? { parenthetical: both(b.parenthetical) } : {}) }
      : b.type === "transition" ? { type: "transition", transition: b.text }
      : { type: "action", text: both(b.text) })),
    addedByUser: true,
  }));
}

// Place the scenes, in order, into the beats of the beat sheet: each beat gets a share of the scenes by its running time, every beat gets at least one scene.
// (This groups by running time, not by meaning — the order of the scenes is never changed.)
export function assignScenesToBeats(sceneMinutes, beatMinutes) {
  const s = sceneMinutes.length, b = beatMinutes.length;
  if (b === 0) throw Object.assign(new Error("This draft has no beat sheet to place the scenes in."), { status: 409 });
  if (s < b) throw Object.assign(new Error(`The screenplay has ${s} scene${s === 1 ? "" : "s"} but the beat sheet has ${b} beats — every beat needs at least one scene. Check that the scene headings (INT. / EXT.) were read, or use a draft with a shorter beat sheet.`), { status: 422 });
  const w = beatMinutes.map((m) => (Number(m) > 0 ? Number(m) : 1));
  const wTotal = w.reduce((n, x) => n + x, 0);
  const t = sceneMinutes.map((m) => (Number(m) > 0 ? Number(m) : 1));
  const tTotal = t.reduce((n, x) => n + x, 0);
  const groups = Array.from({ length: b }, () => []);
  let beat = 0, wBefore = 0, tBefore = 0;
  for (let i = 0; i < s; i++) {
    // keep enough scenes for the beats still to come
    const left = s - i, beatsLeft = b - beat;
    if (beat < b - 1 && groups[beat].length > 0 && (left <= beatsLeft - 1 || tBefore >= ((wBefore + w[beat]) / wTotal) * tTotal - 1e-9)) { wBefore += w[beat]; beat++; }
    groups[beat].push(i);
    tBefore += t[i];
  }
  return groups;
}
