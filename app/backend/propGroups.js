// SMALL PROPS SHARE ONE PICTURE. A bamboo, a mug, a camera and a TV do not each need their own paid picture: they are
// combined into one "Props sheet" image (a grid, numbered by position). The sheet is an ordinary item of the film
// (code PGRP01, PGRP02, ...), so making, reviewing, approving, the money estimate and the shots' references all work the
// same way. The single props it replaces are hidden (grouped_into points at the sheet) and are named by POSITION in every
// shot that uses them ("position 2 of the props sheet: the mug").
// Only props that have no picture yet are combined: a prop that was already made or approved is left as it is.

export const DEFAULT_PROPS_PER_PICTURE = 6;
export const MAX_PROPS_PER_PICTURE = 9;

// Pure: splits props (in order) into balanced groups of at most `perImage`; a single leftover prop stays alone.
export function planPropGroups(props, perImage = DEFAULT_PROPS_PER_PICTURE) {
  const size = Math.max(2, Math.min(MAX_PROPS_PER_PICTURE, Math.round(Number(perImage) || DEFAULT_PROPS_PER_PICTURE)));
  if (props.length < 2) return [];
  const groupCount = Math.ceil(props.length / size);
  const base = Math.floor(props.length / groupCount);
  const extra = props.length % groupCount;
  const groups = [];
  let at = 0;
  for (let g = 0; g < groupCount; g++) {
    const take = base + (g < extra ? 1 : 0);
    groups.push(props.slice(at, at + take));
    at += take;
  }
  return groups.filter((group) => group.length >= 2);
}

const nameKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9\p{L}\p{M}]+/gu, " ").trim();

export async function ensurePropGroupSchema(db) {
  await db.query("ALTER TABLE production_assets ADD COLUMN IF NOT EXISTS grouped_into INTEGER");
  await db.query("ALTER TABLE production_assets ADD COLUMN IF NOT EXISTS group_members JSONB");
}

// What combining WOULD do, without changing anything (used for the "saves about $x" line).
export async function previewPropGroups(db, projectId, perImage, { pricePerPicture = 0.04 } = {}) {
  const props = await combinableProps(db, projectId);
  const groups = planPropGroups(props, perImage);
  const combined = groups.reduce((n, g) => n + g.length, 0);
  return { props: props.length, groups: groups.length, combined, picturesSaved: combined - groups.length, savedUsd: Math.round((combined - groups.length) * pricePerPicture * 100) / 100, existing: await existingGroups(db, projectId) };
}

async function combinableProps(db, projectId) {
  const rows = (await db.query(
    `SELECT a.id, a.code, a.name, a.agent_details, a.human_edits FROM production_assets a
     WHERE a.project_id = $1 AND a.kind = 'prop' AND a.in_latest_import AND a.grouped_into IS NULL AND a.group_members IS NULL
       AND NOT EXISTS (SELECT 1 FROM production_generations g WHERE g.asset_id = a.id)
     ORDER BY a.code`, [projectId]
  )).rows;
  return rows;
}

async function existingGroups(db, projectId) {
  return (await db.query("SELECT id, code, name, group_members FROM production_assets WHERE project_id = $1 AND group_members IS NOT NULL ORDER BY code", [projectId])).rows
    .map((r) => ({ id: r.id, code: r.code, name: r.name, members: r.group_members }));
}

const oneLine = (details) => {
  const d = { ...(details?.agent ?? {}), ...(details?.human ?? {}) };
  return String(d.description ?? d.notes ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
};

export async function combineProps(db, projectId, { perImage = DEFAULT_PROPS_PER_PICTURE } = {}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const props = (await client.query(
      `SELECT a.id, a.code, a.name, a.agent_details, a.human_edits FROM production_assets a
       WHERE a.project_id = $1 AND a.kind = 'prop' AND a.in_latest_import AND a.grouped_into IS NULL AND a.group_members IS NULL
         AND NOT EXISTS (SELECT 1 FROM production_generations g WHERE g.asset_id = a.id)
       ORDER BY a.code FOR UPDATE OF a`, [projectId]
    )).rows;
    const groups = planPropGroups(props, perImage);
    const used = (await client.query("SELECT code FROM production_assets WHERE project_id = $1 AND code LIKE 'PGRP%'", [projectId])).rows.map((r) => Number(r.code.replace(/\D/g, "")) || 0);
    let counter = used.reduce((m, n) => Math.max(m, n), 0);
    const created = [];
    for (const members of groups) {
      counter += 1;
      const code = `PGRP${String(counter).padStart(2, "0")}`;
      const name = `Props sheet ${counter}`;
      const listed = members.map((m, i) => ({ position: i + 1, assetId: m.id, code: m.code, name: m.name, description: oneLine({ agent: m.agent_details, human: m.human_edits }) }));
      const inserted = (await client.query(
        `INSERT INTO production_assets (project_id, kind, code, name, name_key, aliases, agent_details, group_members)
         VALUES ($1,'prop',$2,$3,$4,'[]',$5,$6) RETURNING id`,
        [projectId, code, name, nameKey(name), JSON.stringify({ description: `One picture holding ${members.length} small props: ${listed.map((m) => `${m.position} ${m.name}`).join(", ")}.` }), JSON.stringify(listed)]
      )).rows[0];
      await client.query("UPDATE production_assets SET grouped_into = $1 WHERE id = ANY($2)", [inserted.id, members.map((m) => m.id)]);
      created.push({ id: inserted.id, code, name, members: listed });
    }
    await client.query("COMMIT");
    return { groups: created, combined: created.reduce((n, g) => n + g.members.length, 0), picturesSaved: created.reduce((n, g) => n + g.members.length - 1, 0) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Back to one picture per prop. Only for sheets nothing was made for yet (a made sheet is kept: it holds real work).
export async function splitProps(db, projectId) {
  const groups = (await db.query(
    `SELECT a.id FROM production_assets a WHERE a.project_id = $1 AND a.group_members IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM production_generations g WHERE g.asset_id = a.id)`, [projectId]
  )).rows;
  const kept = (await db.query(
    `SELECT a.code FROM production_assets a WHERE a.project_id = $1 AND a.group_members IS NOT NULL
       AND EXISTS (SELECT 1 FROM production_generations g WHERE g.asset_id = a.id)`, [projectId]
  )).rows.map((r) => r.code);
  for (const g of groups) {
    await db.query("UPDATE production_assets SET grouped_into = NULL WHERE grouped_into = $1", [g.id]);
    await db.query("DELETE FROM production_assets WHERE id = $1", [g.id]);
  }
  return { split: groups.length, keptBecauseMade: kept };
}

// "position 2 Mug" labels for the members that matter to one shot (those named in its text; all of them if none is).
export function memberLabel(group, shotText = "") {
  const text = String(shotText).toLowerCase();
  const all = group.members ?? [];
  const named = all.filter((m) => text.includes(String(m.name).toLowerCase()));
  const shown = named.length > 0 ? named : all;
  return `${group.name} (${shown.map((m) => `position ${m.position}: ${m.name}`).join(", ")})`;
}
