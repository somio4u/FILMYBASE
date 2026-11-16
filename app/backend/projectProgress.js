// Where a project is in the Story & Screenplay chain, in plain words: the furthest step that exists, and whether that step is approved.
// A standalone "production" project (an imported screenplay) is simply "screenplay".
export function projectProgress(row) {
  const n = (v) => Number(v ?? 0);
  if (row.project_type === "production") return { stageKey: n(row.n_list) ? (row.screenplay_ready ? "done" : "screenplay") : "story", stageApproved: !!row.screenplay_ready };
  if (row.screenplay_ready) return { stageKey: "done", stageApproved: true };
  if (n(row.n_list)) return { stageKey: "screenplay", stageApproved: false };
  if (n(row.n_beats)) return { stageKey: "beats", stageApproved: !!row.ok_beats };
  if (n(row.n_act)) return { stageKey: "structure", stageApproved: !!row.ok_act };
  if (n(row.n_chars)) return { stageKey: "characters", stageApproved: !!row.ok_chars };
  if (n(row.n_deck)) return { stageKey: "synopsis", stageApproved: !!row.ok_deck };
  return { stageKey: "story", stageApproved: false };
}

// What kind of work it is: film, short film (a film of 40 minutes or less), web series, or vertical drama — with its length.
export function projectFormat(format) {
  const type = format?.type ?? "film";
  const n = (v) => Math.round(Number(v) * 10) / 10;
  if (type === "series" || type === "vertical") {
    const count = Number(format?.episodeCount) || null, mins = Number(format?.episodeMinutes) || null;
    return { formatKind: type, formatDetail: [count ? `${count} episodes` : null, mins ? `${n(mins)} min each` : null].filter(Boolean).join(" × ") };
  }
  const run = Number(format?.runtimeMinutes) || null;
  return { formatKind: run && run <= 40 ? "short" : "film", formatDetail: run ? `${run} min` : "" };
}
