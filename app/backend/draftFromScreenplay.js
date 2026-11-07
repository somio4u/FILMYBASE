// A new draft made from the owner's OWN final screenplay: the draft chosen is copied (story, synopsis, characters, three acts, beat sheet — all the same), and the
// copy's screenplay is replaced by the uploaded one. The draft it was copied from, and every other draft, stay exactly as they are.
import { branchDraft, getDraft, httpError } from "./drafts.js";
import { assignScenesToBeats } from "./screenplayTextParser.js";

// scenes: AI Movie scenes WITH estimatedMinutes. Returns { draft, scenes, beats }.
export async function createDraftFromScreenplay(db, { parentDraftId, scenes, filename, label = null, actorUserId = null }) {
  const parent = await getDraft(db, parentDraftId);
  if (parent.module !== "ai_movie") throw httpError("Making a draft from an uploaded screenplay works for AI Movie projects.", 400, "module");
  if (!Array.isArray(scenes) || scenes.length === 0) throw httpError("There are no scenes to make a draft from.", 400, "empty");
  const source = (await db.query("SELECT backfill FROM ai_movie_projects WHERE id = $1", [parent.project_ref])).rows[0];
  const plot = Array.isArray(source?.backfill?.plot) ? source.backfill.plot : [];
  // checked BEFORE anything is created: a screenplay that cannot be placed must not leave an empty draft behind
  const groups = assignScenesToBeats(scenes.map((s) => s.estimatedMinutes), plot.map((b) => b?.runtimeMinutes));
  const draft = await branchDraft(db, parentDraftId, { label, kind: "numbered", actorUserId, note: `Made from the uploaded final screenplay: ${String(filename ?? "").slice(0, 120)}` });
  try {
    const clone = (await db.query("SELECT backfill, stage_status FROM ai_movie_projects WHERE id = $1", [draft.project_ref])).rows[0];
    const backfill = { ...(clone.backfill ?? {}), screenplayBeats: groups.map((g) => ({ status: "approved", feedback: null, scenes: g.map((i) => scenes[i]) })) };
    delete backfill.removedScenes; // the copied draft's removed-scene list belongs to the old screenplay
    const stageStatus = { ...(clone.stage_status ?? {}), screenplay: { status: "approved", feedback: null } };
    await db.query("UPDATE ai_movie_projects SET backfill = $1, stage_status = $2, updated_at = now() WHERE id = $3", [JSON.stringify(backfill), JSON.stringify(stageStatus), draft.project_ref]);
    // "Continue Draft" opens at the screenplay: that is the part the owner brought
    await db.query("UPDATE project_drafts SET current_stage = 'screenplay', updated_at = now() WHERE id = $1", [draft.id]);
  } catch (error) {
    // never leave a half-made draft: it still has the OLD screenplay
    await db.query("DELETE FROM project_drafts WHERE id = $1", [draft.id]).catch(() => {});
    await db.query("DELETE FROM ai_movie_projects WHERE id = $1", [draft.project_ref]).catch(() => {});
    throw error;
  }
  return { draft: await getDraft(db, draft.id), scenes: scenes.length, beats: groups.length };
}
