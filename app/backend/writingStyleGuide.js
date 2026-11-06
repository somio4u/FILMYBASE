// The "easy to understand" writing style for every screenplay writer (scene action, dialogue, dialogue polish, scene revise, Hindi/Odia conversion).
// Made by reading the owner's sample scripts (Hindi: Lage Raho Munna Bhai, PK, Stree; South Indian: Temper; English: The Avengers, Inception, Avatar).
// It teaches HOW those scripts write — the rhythm, the word level, the way they explain things — and never copies a line, a scene or a name from them.
// Switch it off without a new release by setting the environment value WRITING_STYLE_GUIDE=off.

export const DIALOGUE_STYLE_GUIDE = `EASY-TO-UNDERSTAND DIALOGUE (the audience is ordinary people, not critics): every line must be understood the first time it is heard.
- Plain spoken words. No technical, scientific, legal or "pure/shuddh" words in anybody's mouth. If the story needs a hard idea, a character says it with an everyday comparison (cricket, chai, bus, family, money, school) — or another character asks "matlab?" / "what does that mean?" and gets a simple answer. A hard word is never just stated.
- Short lines. Most lines are 2–10 words. One thought per line. Fragments are fine. A speech is at most 3–4 short lines; one big speech per film at most, and even that is built from simple examples, not big words.
- Hindi (Devanagari): the Hindi of a Mumbai/Delhi street, not a textbook. Everyday English words that people really say stay English in Devanagari (फ़ोन, केस, प्लान, सॉरी, टाइम, पुलिस). Never "हृदय परिवर्तन"-style words — say "दिल बदल गया". Use आप / तुम / तू by who is talking to whom.
- Emotion first, information second (the way Hindi and South Indian cinema write): a character shows feeling by what they do not say, by repeating one word, by a joke that hides pain, by a small object or a gesture. Sad scenes get QUIETER and shorter, not more eloquent.
- Heroic and mass moments (South Indian style): the hero's line is calm, short and confident, and the other side's reaction does the rest — a one-line warning, a one-line comeback, then silence. Comedy comes from the character's nature (innocent questions, wrong-but-logical answers, a friend teasing), never from a joke told for its own sake.
- Every character has their own way of talking: word choice, line length, formality, a favourite phrase. Two characters must never sound alike.
- Never explain the plot in dialogue ("As you know, ..."). Never let two people state facts to each other in turns.`;

export const ACTION_STYLE_GUIDE = `EASY-TO-READ ACTION AND DESCRIPTION (English action lines, plain words, nothing "dictionary"):
- Present tense. One image or one action per short paragraph; 1–2 short sentences. Say what we SEE and HEAR — not what a character thinks or the story "means".
- Everyday words only. Choose the simple verb ("walks", "grabs", "looks away") over the fancy one. No decoration, no poetry, no long chains of adjectives.
- Fights and heroic moments (the Avengers way): quick readable beats — who moves, who hits, what happens to the other, what changes. ONE move per line, in order, so the reader can follow it like a film. CAPITALS only for the loudest sound or hit (a CRASH, a BLAST). Give the hero's big moment its own line, with a pause before it.
- Clever or complicated ideas (the Inception way): show the RULE of the situation once, in a clear small scene, usually through a newcomer who asks questions; after that, only the effects. Set it up, then reveal it — do not describe the trick before the audience has seen it.
- New worlds and places (the Avatar way): see the world through one character's eyes, with sound, light and touch. One striking, easy-to-picture thing per scene. A new name is first SHOWN in action, then named.
- A scene opens on a clear picture and ends on a clear picture or a line. No scene explains itself.`;

const off = () => String(process.env.WRITING_STYLE_GUIDE ?? "").toLowerCase() === "off";

// the full guide, appended to a system prompt
export function withWritingStyle(prompt) {
  return off() ? prompt : `${prompt}\n\n${DIALOGUE_STYLE_GUIDE}\n\n${ACTION_STYLE_GUIDE}`;
}

// just the dialogue part (the Hindi/Odia "sound like real speech" pass), or just the action part
export const dialogueStyleText = () => (off() ? "" : DIALOGUE_STYLE_GUIDE);
export const actionStyleText = () => (off() ? "" : ACTION_STYLE_GUIDE);
