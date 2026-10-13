// What is Adu (the Auto Screenplay Agent) working on right now? He works on ONE project at a time.
// "Working" means: a story run that is writing or waiting for the user's approval, or a draft request that is being analysed / written.
// Anything untouched for 24 hours is ignored, so an abandoned run can never block new work forever.

const RUN_STAGE_TITLE = (row) => String(row.title ?? row.concept_text ?? "Untitled story").replace(/\s+/g, " ").trim().slice(0, 80);

export async function getAduWork(db, userId) {
  if (!userId) return null;
  const run = (await db.query(
    `SELECT r.id, r.concept_text, r.status, r.progress_stage, r.concept_id, r.placeholder_concept_id, r.created_at, r.updated_at, c.title
     FROM auto_pipeline_runs r LEFT JOIN concepts c ON c.id = COALESCE(r.concept_id, r.placeholder_concept_id)
     WHERE r.created_by = $1 AND r.status IN ('running', 'awaiting_approval') AND r.updated_at > now() - interval '24 hours'
     ORDER BY r.id DESC LIMIT 1`, [userId]).catch(() => ({ rows: [] }))).rows[0];
  if (run) {
    const ref = run.concept_id ?? run.placeholder_concept_id ?? null;
    return {
      kind: "story_run", runId: run.id, title: RUN_STAGE_TITLE(run), status: run.status, stage: run.progress_stage,
      waitingForYou: run.status === "awaiting_approval", module: "film", projectRef: ref, startedAt: run.created_at, updatedAt: run.updated_at,
    };
  }
  // draft requests that are not driven through a story run (AI Movie copies)
  const req = (await db.query(
    `SELECT q.id, q.status, q.module, q.instruction, q.draft_id, q.created_at, q.updated_at, d.project_ref, d.label, d.draft_number
     FROM draft_revision_requests q LEFT JOIN project_drafts d ON d.id = q.draft_id
     WHERE q.created_by = $1 AND q.intent = 'NEW_DRAFT' AND q.status IN ('analyzing', 'awaiting_synopsis_approval', 'synopsis_approved', 'rewriting')
       AND q.proposal->>'pipelineRunId' IS NULL AND q.updated_at > now() - interval '24 hours'
     ORDER BY q.id DESC LIMIT 1`, [userId]).catch(() => ({ rows: [] }))).rows[0];
  if (req) {
    return {
      kind: "draft_request", requestId: req.id, title: String(req.label ?? (req.draft_number ? `Draft ${req.draft_number}` : req.instruction) ?? "New draft").slice(0, 80),
      status: req.status, stage: req.status, waitingForYou: req.status === "awaiting_synopsis_approval", module: req.module, projectRef: req.project_ref ?? null, draftId: req.draft_id, startedAt: req.created_at, updatedAt: req.updated_at,
    };
  }
  return null;
}

export function busyMessage(work) {
  return `Adu is already working on “${work.title}”. He works on one project at a time, so finish that one first${work.waitingForYou ? " (it is waiting for your approval)" : ""}. Use the “Adu is working on…” bar to go to it.`;
}
