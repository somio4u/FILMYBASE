// "For Assistant Directors" routes (admin only): the list of documents, and each one as PDF or Excel.
import { buildDocument, DOCUMENTS } from "./adSheets.js";
import { fileBase, renderPdf, renderXlsx } from "./adRender.js";
import { changedSince } from "./smartScheduler.js";

export function registerAdRoutes(app, db, { requireRole, loadRows }) {
  const admin = requireRole("admin", "production_manager");

  // the Production Management shoot schedule, shaped like the Smart Scheduler's plan (days of scene ids) so every paper can use either
  function planFromShootSchedule(content, rows) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const refs = new Map();
    const days = [];
    for (const day of content?.scheduleDays ?? []) {
      const list = [];
      for (const ref of day.sceneRefs ?? []) {
        const id = `${ref.episodeIndex ?? "film"}-${ref.sceneIndex}`;
        const row = byId.get(id);
        if (!row) continue;
        list.push(row);
        refs.set(id, { costume: ref.costume || "", properties: ref.properties || "", adRemark: ref.adRemark || "" });
      }
      const nights = list.filter((r) => r.night).length;
      days.push({
        day: Number(day.dayNumber) || days.length + 1, date: day.date || "", sceneIds: list.map((r) => r.id),
        minutes: Math.round(list.reduce((n, r) => n + r.minutes, 0) * 10) / 10,
        locations: [...new Set(list.map((r) => r.location))], artists: [...new Set(list.flatMap((r) => r.artists))].sort(),
        night: nights > 0 && nights === list.length, mixed: nights > 0 && nights < list.length,
      });
    }
    return { plan: days.length ? { days } : null, refs };
  }

  async function context(sceneListId, wanted) {
    const data = await loadRows(sceneListId);
    if (!data) return null;
    const head = (await db.query(
      `SELECT c.title FROM scene_lists sl
       LEFT JOIN bit_sheets bs ON bs.id = sl.bit_sheet_id
       LEFT JOIN three_act_structures tas ON tas.id = bs.three_act_structure_id
       LEFT JOIN pitch_decks pd ON pd.id = tas.pitch_deck_id
       LEFT JOIN concepts c ON c.id = COALESCE(sl.concept_id, pd.concept_id)
       WHERE sl.id = $1`, [sceneListId])).rows[0];
    const run = (await db.query("SELECT result, fingerprints FROM scheduler_runs WHERE scene_list_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [sceneListId])).rows[0];
    const breakdown = (await db.query("SELECT content FROM script_breakdowns WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1", [sceneListId])).rows[0]?.content ?? null;
    const tagRows = (await db.query("SELECT episode_index, scene_index, tag, note, set_by_name, done_by FROM scene_tags WHERE scene_list_id = $1 ORDER BY episode_index, scene_index", [sceneListId])).rows;
    const contacts = new Map((await db.query("SELECT character_name, name, contact_number FROM crew_members WHERE scene_list_id = $1 AND category = 'artist'", [sceneListId])).rows
      .filter((r) => r.character_name).map((r) => [String(r.character_name).trim().toUpperCase(), r]));
    const shoot = (await db.query("SELECT content FROM shoot_schedules WHERE scene_list_id = $1 ORDER BY created_at DESC LIMIT 1", [sceneListId])).rows[0]?.content;
    const fromShoot = planFromShootSchedule(shoot, data.rows);
    const changedIds = run ? changedSince(run.fingerprints, data.rows) : [];
    // the days come from Production Management's shoot schedule when it has one, else from the Smart Scheduler's plan (or the one asked for)
    const planSource = wanted === "smart" ? (run ? "smart" : null) : wanted === "production" ? (fromShoot.plan ? "production" : null) : fromShoot.plan ? "production" : run ? "smart" : null;
    return {
      title: head?.title || `Project ${sceneListId}`,
      rows: data.rows,
      planSource,
      hasProductionSchedule: Boolean(fromShoot.plan),
      hasSmartPlan: Boolean(run),
      plan: planSource === "production" ? fromShoot.plan : planSource === "smart" ? run.result : null,
      refs: planSource === "production" ? fromShoot.refs : new Map(),
      stale: planSource === "smart" && changedIds.length > 0,
      changedIds: planSource === "smart" ? changedIds : [],
      adSheet: breakdown?.adSheet ?? null,
      breakdown,
      tags: tagRows.map((t) => [t.episode_index, t.scene_index, t.tag, t.note, t.set_by_name, t.done_by]),
      contacts,
    };
  }

  app.get("/api/ad/:id/documents", admin, async (req, res) => {
    const ctx = await context(Number(req.params.id), req.query.source);
    if (!ctx) { res.status(404).json({ error: "Project not found" }); return; }
    res.json({
      planSource: ctx.planSource, hasProductionSchedule: ctx.hasProductionSchedule, hasSmartPlan: ctx.hasSmartPlan,
      title: ctx.title,
      hasPlan: Boolean(ctx.plan),
      stale: ctx.stale,
      hasBreakdown: Boolean(ctx.breakdown),
      sceneBreakdownMatches: Array.isArray(ctx.adSheet) && ctx.adSheet.length === ctx.rows.length,
      documents: DOCUMENTS,
    });
  });

  app.get("/api/ad/:id/:kind/:format", admin, async (req, res) => {
    const { kind, format } = req.params;
    if (!["pdf", "xlsx"].includes(format)) { res.status(404).json({ error: "Choose pdf or xlsx." }); return; }
    try {
      const ctx = await context(Number(req.params.id), req.query.source);
      if (!ctx) { res.status(404).json({ error: "Project not found" }); return; }
      const spec = buildDocument(kind, ctx);
      const buffer = format === "pdf" ? await renderPdf(spec) : await renderXlsx(spec);
      res.setHeader("Content-Type", format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
      res.setHeader("Content-Disposition", `attachment; filename="${fileBase(ctx.title, spec)}.${format}"`);
      res.send(buffer);
    } catch (error) {
      if (error.status) { res.status(error.status).json({ error: error.message }); return; }
      console.error("AD document failed:", error.message);
      res.status(500).json({ error: "The document could not be made." });
    }
  });
}
