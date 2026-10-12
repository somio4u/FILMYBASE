// Small lookups for generation units (kept apart so planning, timeline and the Shot Optimizer can all use them without importing each other).
export async function activeUnits(db, projectId) {
  return (await db.query("SELECT * FROM production_generation_units WHERE project_id = $1 AND status = 'active' ORDER BY id", [projectId])).rows;
}

// shot id -> { unit, leadId, index, offsetMs, isLead, members }  for every shot that belongs to an active unit.
export async function unitIndex(db, projectId) {
  const units = await activeUnits(db, projectId);
  const out = new Map();
  for (const u of units) {
    const durations = new Map((await db.query("SELECT id, duration_sec FROM production_shots WHERE id = ANY($1)", [u.shot_ids])).rows.map((r) => [r.id, Math.round(Number(r.duration_sec) * 1000)]));
    let offset = 0;
    u.shot_ids.forEach((id, index) => {
      out.set(id, { unit: u, leadId: u.lead_shot_id, index, offsetMs: offset, isLead: id === u.lead_shot_id, members: u.shot_ids });
      offset += durations.get(id) ?? 0;
    });
  }
  return out;
}

// What the video maker should see for a shot: its own shot, or — when it leads a multi-shot generation unit — the whole unit.
// A shot that only rides along inside another shot's unit has no video of its own.
export async function unitShotView(db, projectId, shot) {
  const idx = await unitIndex(db, projectId);
  const u = idx.get(shot.id);
  if (!u || u.members.length < 2) return { shot, unit: u ?? null };
  if (!u.isLead) {
    const lead = (await db.query("SELECT code FROM production_shots WHERE id = $1", [u.leadId])).rows[0];
    throw Object.assign(new Error(`Shot ${shot.code} is covered by the combined video of ${lead?.code ?? "another shot"}. Make that one instead, or split the combined generation unit.`), { status: 409, code: "covered_by_unit" });
  }
  const rows = (await db.query("SELECT id, description FROM production_shots WHERE id = ANY($1)", [u.members])).rows;
  const text = u.members.map((id) => rows.find((r) => r.id === id)?.description).filter(Boolean).join(" Then ");
  return { shot: { ...shot, description: text, durationSec: u.unit.duration_ms / 1000 }, unit: u };
}
