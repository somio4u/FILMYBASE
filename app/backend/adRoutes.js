// "For Assistant Directors" routes (admin only): the list of documents, and each one as PDF or Excel.
import { buildDocument, DOCUMENTS } from "./adSheets.js";
import { fileBase, renderPdf, renderXlsx } from "./adRender.js";
import { changedSince } from "./smartScheduler.js";

export function registerAdRoutes(app, db, { requireRole, loadRows }) {
  const admin = requireRole("admin");

  async function context(sceneListId) {
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
    const changedIds = run ? changedSince(run.fingerprints, data.rows) : [];
    return {
      title: head?.title || `Project ${sceneListId}`,
      rows: data.rows,
      plan: run?.result ?? null,
      stale: changedIds.length > 0,
      changedIds,
      adSheet: breakdown?.adSheet ?? null,
      breakdown,
      tags: tagRows.map((t) => [t.episode_index, t.scene_index, t.tag, t.note, t.set_by_name, t.done_by]),
      contacts,
    };
  }

  app.get("/api/ad/:id/documents", admin, async (req, res) => {
    const ctx = await context(Number(req.params.id));
    if (!ctx) { res.status(404).json({ error: "Project not found" }); return; }
    res.json({
      title: ctx.title,
      hasPlan: Boolean(ctx.plan),
      stale: ctx.stale && Boolean(ctx.plan),
      hasBreakdown: Boolean(ctx.breakdown),
      sceneBreakdownMatches: Array.isArray(ctx.adSheet) && ctx.adSheet.length === ctx.rows.length,
      documents: DOCUMENTS,
    });
  });

  app.get("/api/ad/:id/:kind/:format", admin, async (req, res) => {
    const { kind, format } = req.params;
    if (!["pdf", "xlsx"].includes(format)) { res.status(404).json({ error: "Choose pdf or xlsx." }); return; }
    try {
      const ctx = await context(Number(req.params.id));
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
