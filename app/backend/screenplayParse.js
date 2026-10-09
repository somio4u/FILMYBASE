// Reads a screenplay into scenes — no AI, no database, easy to test.
//
// Two sources:
//   scenesFromBeats(backfill)   the app's own saved screenplay (beats -> scenes -> blocks)
//   parseScreenplayText(text)   plain screenplay text: "SCENE 2 — INT. PLACE — MORNING",
//                               Fountain-style "INT. PLACE - DAY", bold/ALL-CAPS speaker
//                               lines, "SHOT 2.1 — ..." notes, italic action lines.
//
// Each scene: { number, heading, intExt, location, time, qualifier, beatIndex?, elements[] }
// Each element: { kind: action | dialogue | shot_hint | transition | note,
//                 text, speaker?, extension?, parenthetical?, label? }

const TIME_WORDS = /\b(MORNING|DAY|NIGHT|EVENING|AFTERNOON|DAWN|DUSK|SUNSET|SUNRISE|NOON|MIDNIGHT|CONTINUOUS|LATER|SAME TIME|SURREAL|MOMENTS LATER|DAYTIME|NIGHTTIME)\b/i;
const INT_EXT = /^(INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|I\s*\/\s*E|INT|EXT)\b\.?\s*(.*)$/i;
const TRANSITIONS = /^(FADE IN:?|FADE OUT\.?|CUT TO:|SMASH CUT TO:|SHARP CUT TO:|MATCH CUT TO:|JUMP CUT TO:|DISSOLVE TO:|INTERCUT WITH:|FREEZE FRAME:?|THE END\.?)$/i;
const DEVANAGARI = /[ऀ-ॿ]/;

export function guessLanguage(text) {
  return DEVANAGARI.test(text ?? "") ? "hi" : "en";
}

// Removes markdown decoration around a line (headings, **bold**, _italic_, *italic*).
function plain(line) {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*|__/g, "")
    .trim()
    .replace(/^\*\s*|\s*\*$/g, "")
    .trim();
}

function unquote(text) {
  return text.replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
}

// "INT./EXT. APARTMENT ENTRANCE — MORNING" -> parts. Anything before the
// INT/EXT part (e.g. "DREAM") is the qualifier; the last part is the time of
// day when it looks like one; the rest is the location.
export function parseHeading(raw) {
  const heading = raw.replace(/\s+/g, " ").trim();
  const parts = heading.split(/\s+[—–-]\s+/).map((p) => p.trim()).filter(Boolean);
  let idx = parts.findIndex((p) => INT_EXT.test(p));
  let intExt = null;
  let qualifier = null;
  let locationParts = parts;
  if (idx >= 0) {
    const m = INT_EXT.exec(parts[idx]);
    const tag = m[1].toUpperCase().replace(/\s+/g, "");
    intExt = tag.includes("/") ? "INT/EXT" : tag.startsWith("I") && tag.length === 1 ? "INT" : tag.replace(/\./g, "");
    qualifier = idx > 0 ? parts.slice(0, idx).join(" — ") : null;
    locationParts = [m[2].trim(), ...parts.slice(idx + 1)].filter(Boolean);
  }
  let time = null;
  if (locationParts.length > 1 && TIME_WORDS.test(locationParts[locationParts.length - 1])) {
    time = locationParts[locationParts.length - 1];
    locationParts = locationParts.slice(0, -1);
  }
  const location = locationParts.join(" — ").replace(/[.,;:]+$/, "").trim() || null;
  return { heading, intExt, location, time, qualifier };
}

function detectSceneStart(trimmed) {
  const text = plain(trimmed);
  let m = /^SCENE\s+([0-9A-Za-z.]+)\s*[—–:-]\s*(.+)$/i.exec(text);
  if (m) return { number: m[1].replace(/\.$/, ""), rest: m[2] };
  // Fountain-style heading: an INT./EXT. line written in capitals.
  m = /^(INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|I\s*\/\s*E|INT|EXT)[. ]\s*\S/i.exec(text);
  if (m && /^[A-Z0-9 .,'’\/()\-—–:&]+$/.test(text)) return { number: null, rest: text };
  return null;
}

// A speaker line: **NAME** *(how)*  or  NAME (V.O.)  followed by their words.
function detectCue(trimmed, nextLine) {
  if (/^\*\*SHOT\b/i.test(trimmed)) return null;
  const bold = /^\*\*([^*]+?)\*\*\s*(?:\*\(([^)]*)\)\*|\(([^)]*)\))?\s*$/.exec(trimmed);
  if (bold) {
    const name = bold[1].trim();
    if (TRANSITIONS.test(name) || /^END\.?$/i.test(name)) return null;
    if (name.length > 40) return null;
    return finishCue(name, bold[2] ?? bold[3] ?? null);
  }
  // plain ALL-CAPS cue on its own line, with words after it
  const caps = /^([A-Z][A-Z0-9 .'’\-]{0,40}?)\s*(?:\(([^)]*)\))?$/.exec(trimmed);
  if (caps && nextLine && nextLine.trim() && !TRANSITIONS.test(trimmed) && !INT_EXT.test(trimmed) && trimmed === trimmed.toUpperCase() && !/[.:]$/.test(trimmed)) {
    return finishCue(caps[1].trim(), caps[2] ?? null);
  }
  return null;
}

function finishCue(name, bracket) {
  // "(V.O.)", "(O.S.)", "(CONT'D)" are extensions; anything else is a direction.
  let speaker = name;
  let extension = null;
  const ext = /\s*\((V\.O\.|O\.S\.|CONT'D|O\.C\.)\)\s*$/i.exec(name);
  if (ext) {
    extension = ext[1].toUpperCase();
    speaker = name.slice(0, ext.index).trim();
  }
  let parenthetical = bracket ? bracket.trim() : null;
  if (parenthetical && /^(V\.O\.|O\.S\.|CONT'D|O\.C\.)$/i.test(parenthetical)) {
    extension = parenthetical.toUpperCase();
    parenthetical = null;
  }
  return { speaker, extension, parenthetical };
}

export function parseScreenplayText(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const scenes = [];
  const warnings = [];
  let current = null;
  let auto = 0;

  const push = (element) => { if (current && element.text !== "") current.elements.push(element); };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || /^[-_*]{3,}$/.test(trimmed)) continue;

    const start = detectSceneStart(trimmed);
    if (start) {
      auto += 1;
      const parsed = parseHeading(start.rest);
      current = { number: start.number ?? String(auto), ...parsed, elements: [] };
      scenes.push(current);
      continue;
    }
    if (!current) continue;
    // a heading that is not a scene (e.g. "## 5. NOTES") ends the screenplay part
    if (/^#{1,6}\s/.test(trimmed)) { current = null; continue; }

    const shot = /^\*\*SHOT\s+([0-9A-Za-z.]+)\*\*\s*[—–:-]?\s*(.*)$/i.exec(trimmed);
    if (shot) { push({ kind: "shot_hint", label: shot[1], text: plain(shot[2]) }); continue; }

    const bare = plain(trimmed);
    if (/^(THE END|END)\.?$/i.test(bare)) continue;
    if (TRANSITIONS.test(bare)) { push({ kind: "transition", text: bare.toUpperCase() }); continue; }

    const cue = detectCue(trimmed, lines[i + 1]);
    if (cue) {
      const spoken = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        if (!next || detectSceneStart(next) || /^#{1,6}\s/.test(next) || /^\*\*SHOT\b/i.test(next)) break;
        if (detectCue(next, lines[i + 2]) && spoken.length > 0) break;
        spoken.push(next);
        i++;
      }
      // a "(tired)" line right under the speaker is a direction, not spoken words
      let parenthetical = cue.parenthetical;
      if (!parenthetical && spoken.length > 1 && /^\(.*\)$/.test(plain(spoken[0]))) parenthetical = plain(spoken.shift()).slice(1, -1).trim();
      push({ kind: "dialogue", speaker: cue.speaker, extension: cue.extension, parenthetical, text: unquote(spoken.map(plain).join(" ")) });
      continue;
    }

    // action: gather the lines of this paragraph
    const para = [bare];
    while (i + 1 < lines.length) {
      const next = lines[i + 1].trim();
      if (!next || /^[-_*]{3,}$/.test(next) || detectSceneStart(next) || /^#{1,6}\s/.test(next) || /^\*\*SHOT\b/i.test(next) || detectCue(next, lines[i + 2])) break;
      para.push(plain(next));
      i++;
    }
    const paragraph = para.join(" ").trim();
    if (/^\((?:no dialogue|note)[^)]*\)\.?$/i.test(paragraph)) push({ kind: "note", text: paragraph.replace(/^\(|\)\.?$/g, "") });
    else push({ kind: "action", text: paragraph });
  }

  if (scenes.length === 0) warnings.push("No scene headings were found (look for lines like \"SCENE 1 — INT. PLACE — DAY\" or \"INT. PLACE - DAY\").");
  for (const s of scenes) if (s.elements.length === 0) warnings.push(`Scene ${s.number} has no content.`);
  return { scenes, warnings };
}

// ---------------------------------------------------------------------------
// The app's own saved screenplay: backfill.screenplayBeats[].scenes[]
// ---------------------------------------------------------------------------

function en(value) { return typeof value === "string" ? value : value?.en ?? ""; }
function both(value) { return { en: en(value), hi: typeof value === "object" && value ? value.hi ?? "" : "" }; }

export function scenesFromBeats(backfill) {
  const scenes = [];
  const beats = Array.isArray(backfill?.screenplayBeats) ? backfill.screenplayBeats : [];
  beats.forEach((beat, beatIndex) => {
    (beat?.scenes ?? []).forEach((scene, sceneIndex) => {
      const parsed = parseHeading(en(scene.sceneHeading));
      const elements = [];
      if (Array.isArray(scene.content) && scene.content.length > 0) {
        for (const block of scene.content) {
          if (block.type === "dialogue") {
            elements.push({
              kind: "dialogue", speaker: block.character ?? "", extension: block.extension ?? null,
              parenthetical: block.parenthetical ? en(block.parenthetical) : null, text: en(block.line), textBoth: both(block.line),
            });
          } else if (block.type === "transition") {
            elements.push({ kind: "transition", text: block.transition ?? "" });
          } else {
            elements.push({ kind: "action", text: en(block.text), textBoth: both(block.text) });
          }
        }
      } else {
        if (scene.action) elements.push({ kind: "action", text: en(scene.action), textBoth: both(scene.action) });
        for (const d of scene.dialogue ?? []) {
          elements.push({ kind: "dialogue", speaker: d.character ?? "", extension: null, parenthetical: null, text: en(d.line), textBoth: both(d.line) });
        }
      }
      scenes.push({
        number: `${beatIndex + 1}.${sceneIndex + 1}`, beatIndex, sceneIndex, ...parsed,
        estimatedMinutes: typeof scene.estimatedMinutes === "number" ? scene.estimatedMinutes : null,
        elements: elements.filter((e) => e.text !== ""),
      });
    });
  });
  return scenes;
}
