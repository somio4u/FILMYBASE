// REFERENCE IMAGES: real artwork the film must show exactly as it is — a channel logo ("Tarang Plus"), a brand, an on-screen
// title. The image model cannot draw a real logo from a name (it invents one), so the director adds the real picture ONCE and
// the app attaches it, with an instruction to copy it faithfully, to every picture whose text mentions it (by its name or any
// "also called" word). Adu also reads the screenplay and suggests which brands and titles need one.
export const REF_KINDS = ["logo", "title", "brand", "other"];
export const MAX_REFERENCES_PER_PICTURE = 2;

export async function ensureReferenceSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS production_reference_images (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    label TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'logo',
    keywords JSONB NOT NULL DEFAULT '[]',
    media_id INTEGER REFERENCES production_media_files(id) ON DELETE SET NULL,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, code)
  )`);
}

export const slugName = (text) => String(text ?? "").normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "reference";

export async function listReferenceImages(db, projectId) {
  try {
    const rows = (await db.query("SELECT * FROM production_reference_images WHERE project_id = $1 AND media_id IS NOT NULL ORDER BY id", [projectId])).rows;
    return rows.map((r) => ({ id: r.id, code: r.code, label: r.label, kind: r.kind, keywords: r.keywords ?? [], mediaId: r.media_id, mediaUrl: `/api/production/media/${r.media_id}`, fileName: `${r.code}_${slugName(r.label)}` }));
  } catch (error) {
    if (error.code === "42P01") return []; // table not created yet (older setups)
    throw error;
  }
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Pure: the references a piece of text mentions (the label or any "also called" word), at most MAX_REFERENCES_PER_PICTURE.
export function matchReferences(text, refs) {
  const hay = norm(text);
  if (!hay || !refs?.length) return [];
  const found = refs.filter((r) => [r.label, ...(r.keywords ?? [])].map(norm).filter((w) => w.length >= 2).some((word) => {
    // words made of letters/digits only match as whole words ("tv" must not match "ac*tv*ity"); other scripts match as text
    return /^[a-z0-9 ]+$/.test(word) ? new RegExp(`(^|[^a-z0-9])${escapeRegex(word)}($|[^a-z0-9])`).test(hay) : hay.includes(word);
  }));
  return found.slice(0, MAX_REFERENCES_PER_PICTURE);
}

// The sentence added to a command. The attached reference images come AFTER any model sheets, in this order.
export function referenceSentence(matched) {
  if (!matched?.length) return "";
  const list = matched.map((r, i) => `${i + 1}) ${r.label} (${r.kind})`).join("; ");
  return ` REAL REFERENCE IMAGE${matched.length === 1 ? "" : "S"} — attached after any model sheets, in this order: ${list}. This is the real artwork: show it exactly as given (same shape, colours and lettering). Do not redraw it, restyle it, translate it or invent a different one.`;
}

export const referenceSignature = (matched) => (matched ?? []).map((r) => `${r.code}:${r.label}:${r.mediaId}`);

export function parseKeywords(input) {
  const list = Array.isArray(input) ? input : String(input ?? "").split(/[,;\n]/);
  return [...new Set(list.map((k) => String(k).trim()).filter((k) => k.length >= 2 && k.length <= 60))].slice(0, 12);
}

// Brands and titles worth a reference image, found by reading the screenplay (one cheap text call).
export async function detectReferenceNeeds({ textJson, screenplay, have = [] }) {
  const prompt = `You read a film screenplay and list the REAL brands, channel or company names, product names, logos and on-screen titles or captions that would need the real artwork as a reference image to be drawn correctly (an image model cannot invent a real logo). Examples: a TV channel logo ("Tarang Plus"), a drink brand on a bottle, a newspaper masthead, the film's own title card. Ignore generic objects (a mug, a camera) and character names.

Return JSON only: {"items":[{"name":"exact name as written","kind":"logo|title|brand|other","keywords":["other ways it is written"],"where":"one short phrase: where it appears"}]}. At most 12 items, most important first. If there are none, return {"items":[]}.

Already added (do not list again): ${have.join(", ") || "none"}.

SCREENPLAY:
${String(screenplay ?? "").slice(0, 40000)}`;
  const result = await textJson(prompt);
  const haveKeys = new Set(have.map(norm));
  const seen = new Set();
  return (Array.isArray(result?.items) ? result.items : []).map((i) => ({
    name: String(i?.name ?? "").trim().slice(0, 80),
    kind: REF_KINDS.includes(i?.kind) ? i.kind : "brand",
    keywords: parseKeywords(i?.keywords),
    where: String(i?.where ?? "").trim().slice(0, 160),
  })).filter((i) => i.name && !haveKeys.has(norm(i.name)) && !seen.has(norm(i.name)) && seen.add(norm(i.name))).slice(0, 12);
}
