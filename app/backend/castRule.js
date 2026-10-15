// THE CAST RULE: every CHARACTER is INDIAN unless the director says otherwise. Without this rule the image model falls back to a
// Hollywood look (European-looking actors). The rule is on by default for every project.
//   - a character is Indian unless its details name another origin (director edits "Origin" on the character: e.g. "British")
//   - every person in a shot is Indian (extras and crowd included), except characters named as foreign
//   - objects (a camera, a mug, a TV) and environments are NOT touched: a camera is a normal, universal camera, and a place is
//     whatever the story says
export const CAST_ORIGINS = ["indian", "none"];
export const DEFAULT_CAST_ORIGIN = "indian";

export const INDIAN_PERSON = "INDIAN CAST (strict): this person is Indian — from India — with the facial features, skin tone, hair and bone structure of an Indian person. They must NOT look European, American, British, Hollywood, East-Asian, African or Middle-Eastern, and must not resemble any Western film actor";

const INDIAN_WORDS = /\b(indian|india|odia|oriya|odisha|hindi|bengali|punjabi|tamil|telugu|kannada|malayali|malayalam|marathi|gujarati|assamese|rajasthani|bhojpuri|desi|south asian)\b/i;

// What the director wrote as the character's origin (only a non-Indian origin matters), or null.
export function foreignOrigin(details) {
  const raw = [details?.origin, details?.nationality, details?.ethnicity].find((v) => typeof v === "string" && v.trim());
  const value = raw?.trim();
  if (!value || INDIAN_WORDS.test(value)) return null;
  return value.slice(0, 80);
}

// style may be a plain text (older callers) or { text, castOrigin }
export function normalizeStyle(style) {
  if (style && typeof style === "object") return { text: String(style.text ?? ""), castOrigin: CAST_ORIGINS.includes(style.castOrigin) ? style.castOrigin : DEFAULT_CAST_ORIGIN };
  return { text: String(style ?? ""), castOrigin: DEFAULT_CAST_ORIGIN };
}

// for one character sheet
export function personRule(details, castOrigin) {
  if (castOrigin === "none") return "";
  const foreign = foreignOrigin(details);
  return foreign
    ? `This character is ${foreign} (NOT Indian): draw their features, skin tone and look as a ${foreign} person would have.`
    : `${INDIAN_PERSON}.`;
}

// for a shot: the PEOPLE in the frame (named characters, extras, crowd) — never the objects. `assets` are the shot's assets; those
// with an `origin` are the foreign characters.
export function shotRule(assets, castOrigin) {
  if (castOrigin === "none") return "";
  const foreign = (assets ?? []).filter((a) => a.kind === "character" && a.origin);
  const exception = foreign.length ? ` Exception: ${foreign.map((a) => `${a.name} is ${a.origin}, not Indian`).join("; ")}.` : "";
  return `Every person in this frame is Indian — from India — with Indian facial features, skin tone and hair, extras and crowd included; nobody looks European, American or Hollywood.${exception}`;
}
