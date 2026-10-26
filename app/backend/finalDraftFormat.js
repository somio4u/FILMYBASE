// "Final Draft" conventions for a saved scene, applied after the AI check. It never changes a writer's WORDS — only capitals, brackets,
// colons and spacing the way Final Draft shows them:
//   CHARACTER names in capitals, with V.O. / O.S. / O.C. / CONT'D written one way
//   (parentheticals) without their own brackets (the page draws them), in lower case when they are English
//   TRANSITIONS in capitals, "CUT TO:" with a colon, "FADE OUT." with a full stop
//   a character who speaks again after an action line, with no one else speaking in between, gets (CONT'D) — Final Draft does this by itself
//   action and dialogue: no double spaces or spaces at the ends of lines

const tidy = (text) => String(text ?? "").split("\n").map((line) => line.replace(/[ \t ]{2,}/g, " ").trim()).join("\n").trim();

function formatTransition(text) {
  let t = tidy(text).toUpperCase();
  if (!t) return t;
  if (/^(FADE IN|IRIS IN)[.:]?$/.test(t)) return t.replace(/[.:]?$/, ":");
  if (/^(FADE OUT|FADE TO BLACK|IRIS OUT)[.:]?$/.test(t)) return t.replace(/[.:]?$/, ".");
  if (/^(CUT|DISSOLVE|WIPE|MATCH CUT|SMASH CUT|JUMP CUT|CROSS CUT|FADE|IRIS) TO$/.test(t)) return `${t}:`;
  return t;
}

function formatParenthetical(text) {
  const t = tidy(text).replace(/^\(\s*|\s*\)$/g, "").trim();
  return /^[A-Za-z]/.test(t) && !/^[A-Z]{2,}\b/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

export function formatFinalDraft(elements) {
  const out = (elements ?? []).map((element) => {
    if (!element || typeof element !== "object") return element;
    if (element.type === "transition") return { ...element, text: formatTransition(element.text) };
    if (element.type === "dialogue") {
      const formatted = { ...element, character: tidy(element.character).toUpperCase(), text: tidy(element.text) };
      if (typeof element.parenthetical === "string") formatted.parenthetical = formatParenthetical(element.parenthetical);
      return formatted;
    }
    return { ...element, text: tidy(element.text) };
  });
  // (CONT'D): the same character speaks again after action, nobody else spoke in between
  let lastSpeaker = null;
  let actionSince = false;
  out.forEach((element, i) => {
    if (element?.type === "dialogue") {
      const none = !element.characterModifier || element.characterModifier === "none";
      if (none && actionSince && lastSpeaker && element.character === lastSpeaker) out[i] = { ...element, characterModifier: "CONT'D" };
      lastSpeaker = element.character;
      actionSince = false;
    } else if (element?.type === "action" || element?.type === "flashback") actionSince = true;
    else if (element?.type === "transition") { lastSpeaker = null; actionSince = false; }
  });
  return out;
}
