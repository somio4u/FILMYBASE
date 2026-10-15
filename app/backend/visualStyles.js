// THE VISUAL STYLE OF THE FILM, chosen once per project and written into EVERY picture command: character, environment and
// property model sheets, shot frames and videos. The default is realistic (a film that looks photographed), never a drawing.
// "custom" lets the director describe any other look in their own words.
export const VISUAL_STYLES = [
  { id: "realistic", label: "Realistic (photorealistic live-action)", text: "Photorealistic live-action film look. Real people with natural skin texture and natural body proportions, real fabrics and materials, real places, as if photographed with a professional cinema camera in natural light. This is a photograph, NOT a drawing, NOT an illustration, NOT a cartoon, NOT anime and NOT a 3D-render or video-game look" },
  { id: "cinematic", label: "Cinematic realistic (dramatic film look)", text: "Cinematic photorealistic film look: dramatic lighting, rich colour grading, shallow depth of field, fine film grain, anamorphic widescreen feel. Real people and real places shot on a high-end cinema camera. NOT a drawing, NOT a cartoon, NOT anime, NOT a 3D-render look" },
  { id: "cartoon", label: "Cartoon (2D)", text: "2D cartoon style: bold clean outlines, flat bright colours, simple shading, slightly exaggerated proportions and expressive faces, hand-drawn animation feel" },
  { id: "anime", label: "Anime", text: "Japanese anime style: cel-shaded colouring, crisp line art, large expressive eyes, stylised hair with sharp highlights, painted anime backgrounds, soft cinematic anime lighting" },
  { id: "animation3d", label: "3D animation", text: "3D animated feature-film style (Pixar-like): smooth sculpted characters, soft global lighting, rich textures, slightly stylised proportions, polished CGI render" },
  { id: "comic", label: "Comic book / graphic novel", text: "Comic-book graphic-novel style: strong black ink outlines, hatching and halftone shading, dramatic panel-style compositions, bold limited colour palette" },
  { id: "painting", label: "Painterly (digital painting / watercolour)", text: "Hand-painted digital painting style: visible brush strokes, soft watercolour-like washes, rich painterly colour and light, an illustrated storybook feel" },
  { id: "indian_art", label: "Indian traditional art (mythological painting)", text: "Traditional Indian mythological painting style in the manner of classic Indian calendar art and Raja Ravi Varma: richly detailed, saturated jewel colours, ornate jewellery and costume, divine glowing halos where fitting, theatrical poses" },
  { id: "noir", label: "Black & white (film noir)", text: "Black-and-white film-noir look: high-contrast monochrome photography, deep shadows, hard directional light, fine film grain, 1940s cinema mood. Real people and real places, photographed" },
];

export const DEFAULT_VISUAL_STYLE = "realistic";
export const isVisualStyle = (id) => id === "custom" || VISUAL_STYLES.some((s) => s.id === id);

// The text that goes into the picture commands. `custom` is the director's own description, used when the style is "custom".
export function resolveStyle(visualStyle, custom = "") {
  if (visualStyle === "custom") return String(custom ?? "").trim();
  return (VISUAL_STYLES.find((s) => s.id === visualStyle) ?? VISUAL_STYLES[0]).text;
}

// True when the look is a real-camera look, so photographic wording in a command fits it.
export const isPhotographic = (styleText) => !styleText || /photoreal|photograph|live-action/i.test(styleText) && !/NOT a photograph/i.test(styleText);
