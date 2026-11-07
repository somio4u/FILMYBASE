// AI Movie → the screenplay laid out like a normal film's: ACT 1, ACT 2, INTERVAL, ACT 3, every scene numbered in one running sequence. The AI still writes in small
// groups (beats) behind the scenes; this only decides what the PERSON sees: which act each scene is in, and where the interval falls.
//   * an act is a share of the film's RUNNING TIME (Act 1 = the first 25%, Act 2 = the middle 50%, Act 3 = the last 25%), by where each scene starts;
//   * the interval is where the film already has it (set after a beat), or else the middle of the film (50% of the running time), which is the middle of Act 2.

export const ACT_SHARES = [25, 75]; // the end of Act 1 and of Act 2, as a share of the running time

// beats: the written beats ([{ scenes: [scene] }]); minutesOf(scene) -> minutes; intervalAfterBeat: index of the beat the interval comes after (or not a number)
export function buildActs(beats, minutesOf, intervalAfterBeat = null) {
  const flat = [];
  (beats ?? []).forEach((beat, beatIndex) => (Array.isArray(beat?.scenes) ? beat.scenes : []).forEach((scene, sceneIndex) => flat.push({ beatIndex, sceneIndex, scene })));
  const minutes = flat.map((f) => { const m = Number(minutesOf(f.scene)); return Number.isFinite(m) && m > 0 ? m : 1; });
  const total = minutes.reduce((n, m) => n + m, 0) || 1;
  let before = 0;
  flat.forEach((f, i) => {
    f.number = i + 1;
    f.startPct = (before / total) * 100;
    f.act = f.startPct < ACT_SHARES[0] ? 1 : f.startPct < ACT_SHARES[1] ? 2 : 3;
    before += minutes[i];
    f.endPct = (before / total) * 100;
  });
  // the interval comes AFTER this scene (index into flat), or -1 for none
  let intervalAfter = -1;
  if (flat.length > 1) {
    if (Number.isInteger(intervalAfterBeat) && intervalAfterBeat >= 0) {
      for (let i = flat.length - 1; i >= 0; i--) if (flat[i].beatIndex === intervalAfterBeat) { intervalAfter = i; break; }
    }
    if (intervalAfter < 0) intervalAfter = Math.max(0, flat.findIndex((f) => f.endPct >= 50));
    if (intervalAfter >= flat.length - 1) intervalAfter = flat.length - 2; // an interval at the very end is not an interval
  }
  const sections = [];
  let current = null;
  flat.forEach((f, i) => {
    const label = f.act === 2 && sections.some((s) => s.kind === "interval") ? "ACT 2 (continued)" : `ACT ${f.act}`;
    if (!current || current.act !== f.act || current.label !== label) { current = { kind: "act", act: f.act, label, scenes: [] }; sections.push(current); }
    current.scenes.push(f);
    if (i === intervalAfter) { sections.push({ kind: "interval", label: "INTERVAL", afterScene: f.number }); current = null; }
  });
  return { sections, flat, total: Math.round(total * 10) / 10, intervalAfter: intervalAfter >= 0 ? flat[intervalAfter].number : null };
}

// a short label for a group of scenes ("ACT 2 · scenes 14–17 of 126")
export function groupLabel(acts, beatIndex) {
  const mine = acts.flat.filter((f) => f.beatIndex === beatIndex);
  if (mine.length === 0) return null;
  const first = mine[0], last = mine[mine.length - 1];
  const act = acts.sections.find((s) => s.kind === "act" && s.scenes.includes(first));
  return { act: act?.label ?? `ACT ${first.act}`, from: first.number, to: last.number, of: acts.flat.length, range: first.number === last.number ? `scene ${first.number}` : `scenes ${first.number}–${last.number}` };
}
