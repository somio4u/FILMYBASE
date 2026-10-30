// Putting new scenes into a scene list: the pure part (no database). Used by the "Add a scene" route and by the Buddy's "add scene one-liners" job.
//   makeInsertedScenes  one new scene at one position: its fields, and the scene numbers kept in order (12, 13 … or 12A when the numbers are not simple)
//   planInsertions      many new scenes, each saying "after scene 7": where each goes in the CURRENT list and in which order to apply them so that
//                       nothing moves under the next one (highest position first; scenes for the same spot in reverse, so the final order is the order given)
import { numberKey } from "./pdfFill.js";

export function renumberSimpleScenes(scenes) {
  const shapes = scenes.map((scene) => String(scene.sceneNumber ?? "").match(/^(.*?)(\d+)$/));
  if (shapes.length === 0 || shapes.some((shape) => !shape)) return scenes;
  return scenes.map((scene, i) => ({ ...scene, sceneNumber: `${shapes[0][1]}${i + 1}` }));
}

const bilingual = (value) => {
  if (value && typeof value === "object") return { en: String(value.en ?? value.or ?? value.hi ?? "").trim(), or: String(value.or ?? value.en ?? value.hi ?? "").trim(), hi: String(value.hi ?? value.en ?? value.or ?? "").trim() };
  const t = String(value ?? "").trim();
  return { en: t, or: t, hi: t };
};

// fields: { intExt, location, timeOfDay, oneLiner, estimatedMinutes, purpose?, turn?, strictContext?, addedBy? } — location / oneLiner / turn as text or { en, or, hi }
export function makeInsertedScenes(scenes, position, fields) {
  const at = Math.max(0, Math.min(Number(position) || 0, scenes.length));
  const neighbour = scenes[at - 1] ?? scenes[at] ?? {};
  const newScene = {
    actNumber: neighbour.actNumber ?? 1,
    intExt: fields.intExt === "EXT" ? "EXT" : "INT",
    location: bilingual(fields.location),
    timeOfDay: String(fields.timeOfDay || "DAY").toUpperCase(),
    oneLiner: bilingual(fields.oneLiner),
    estimatedMinutes: Math.max(0.5, Math.min(15, Number(fields.estimatedMinutes) || 2)),
    purpose: fields.purpose ?? neighbour.purpose ?? "plot_advancing",
    ...(fields.turn ? { turn: bilingual(fields.turn) } : {}),
    ...(fields.addedBy === "ai" ? { addedByAI: true } : { addedByUser: true }),
    // the writer's own description is the only story this scene may have (see generateScreenplaySceneContent)
    ...(fields.strictContext === true ? { strictContext: true } : {}),
  };
  // Scene numbers ("12", "E3S4") stay sequential when they are simple; otherwise the new scene gets the film-industry style "12A".
  const everyNumbered = scenes.length > 0 && scenes.every((s) => s.sceneNumber);
  const simpleNumbers = everyNumbered && scenes.every((s) => /^(.*?)(\d+)$/.test(String(s.sceneNumber)));
  if (simpleNumbers) newScene.sceneNumber = String(scenes[0].sceneNumber); // renumbered just below
  else if (everyNumbered) newScene.sceneNumber = `${(scenes[at - 1] ?? scenes[0]).sceneNumber}A`;
  let nextScenes = [...scenes.slice(0, at), newScene, ...scenes.slice(at)];
  if (simpleNumbers) nextScenes = renumberSimpleScenes(nextScenes);
  return { at, newScene, nextScenes };
}

// generated: [{ afterScene: "7" | "0" | "start" | "end", ...fields }] in the order the story needs them
// returns [{ position, fields }] in the order to apply them (see the top of the file)
export function planInsertions(scenes, generated) {
  const positionOf = (after) => {
    const t = String(after ?? "").trim().toLowerCase();
    if (t === "0" || t === "start" || t === "beginning") return 0;
    if (!t || t === "end" || t === "last") return scenes.length;
    const index = scenes.findIndex((s, i) => numberKey(s.sceneNumber ?? i + 1) === numberKey(t));
    return index < 0 ? scenes.length : index + 1; // an unknown scene number: at the end, never lost
  };
  const planned = generated.map((fields, order) => ({ position: positionOf(fields.afterScene), fields, order }));
  planned.sort((a, b) => b.position - a.position || b.order - a.order);
  return planned.map(({ position, fields }) => ({ position, fields }));
}
