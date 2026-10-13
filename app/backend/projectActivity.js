// "Last worked on" for each project, so the project lists can show the most recently used project first.
// A project counts as worked on when: it was created, you opened it (any of its drafts), a draft changed, Adu wrote into it
// (a story run), or a pitch deck was written. Every lookup is best-effort: if one fails, the others still decide the order.

const asMs = (v) => (v ? new Date(v).getTime() : 0);

async function safe(db, sql, params) {
  try { return (await db.query(sql, params)).rows; } catch { return []; }
}

// Map: project id -> the latest time (ms) it was worked on
export async function lastWorkedMap(db, module, ids, fallback = new Map()) {
  const map = new Map(ids.map((id) => [id, asMs(fallback.get(id))]));
  if (ids.length === 0) return map;
  const bump = (id, t) => { const ms = asMs(t); if (ms > (map.get(id) ?? 0)) map.set(id, ms); };
  // you opened / changed any draft of the project
  for (const r of await safe(db,
    `SELECT x.project_ref::int AS id, max(GREATEST(g.updated_at, COALESCE(g.last_opened_at, g.updated_at))) AS t
     FROM project_drafts x JOIN project_drafts g ON g.group_id = x.group_id AND g.module = x.module
     WHERE x.module = $1 AND x.project_ref = ANY($2::int[]) GROUP BY x.project_ref`, [module, ids])) bump(r.id, r.t);
  if (module === "film") {
    for (const r of await safe(db, "SELECT concept_id AS id, max(created_at) AS t FROM pitch_decks WHERE concept_id = ANY($1::int[]) GROUP BY concept_id", [ids])) bump(r.id, r.t);
    // Adu wrote into the project (a story run), directly or through one of its drafts
    for (const r of await safe(db,
      `SELECT x.project_ref::int AS id, max(r.updated_at) AS t
       FROM project_drafts x JOIN project_drafts g ON g.group_id = x.group_id AND g.module = x.module
       JOIN auto_pipeline_runs r ON r.concept_id = g.project_ref OR r.placeholder_concept_id = g.project_ref
       WHERE x.module = 'film' AND x.project_ref = ANY($1::int[]) GROUP BY x.project_ref`, [ids])) bump(r.id, r.t);
    for (const r of await safe(db,
      `SELECT COALESCE(concept_id, placeholder_concept_id) AS id, max(updated_at) AS t FROM auto_pipeline_runs
       WHERE concept_id = ANY($1::int[]) OR placeholder_concept_id = ANY($1::int[]) GROUP BY 1`, [ids])) bump(r.id, r.t);
  }
  return map;
}

// rows: [{ id, pinned?, created? }]; returns the rows ordered: pinned first, then most recently worked on
export async function orderByLastWorked(db, module, rows, { idOf = (r) => r.id, pinnedOf = (r) => r.pinned, createdOf = (r) => r.created_at } = {}) {
  const ids = rows.map(idOf).map(Number);
  const created = new Map(rows.map((r) => [Number(idOf(r)), createdOf(r)]));
  const worked = await lastWorkedMap(db, module, ids, created);
  const out = [...rows].sort((a, b) => {
    const pa = pinnedOf(a) ? 1 : 0, pb = pinnedOf(b) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (worked.get(Number(idOf(b))) ?? 0) - (worked.get(Number(idOf(a))) ?? 0);
  });
  return { rows: out, worked };
}
