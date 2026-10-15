// AUTO PRODUCTION, in three phases. Adu NEVER divides the screenplay into shots by himself and NEVER approves the shot
// division: shots are made only when the director presses "Create shot division from screenplay" in the Storyboard
// Designer, and everything that is made from shots waits for the director's approval there.
//
//   prepare   (starts by itself when the screenplay is locked)
//             reads the locked screenplay into production: scenes, and the characters, environments and properties.
//             Then waits for the director to create the shot division.
//   shots     (the director presses "Create shot division from screenplay")
//             the Cinematic Director writes directions for every scene (after approval it only gives directions, it never
//             rewrites the screenplay) which are approved and sent to the shot cutter; then every scene is cut into shots.
//             Then waits for the director to approve every scene's shots.
//   finish    (starts by itself when the director approves the LAST scene's shots)
//             plans the prompts, checks the Production Blueprint and approves it, which creates the Timeline.
//
// The money limit applies to every paid step (it stops cleanly). The phases talk to the app only through
// `api(method, path, body)` and `listScenes`, so each can be tested with a scripted `api`.

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const PHASE_STEPS = {
  prepare: ["Reading the locked screenplay: scenes, characters, environments, properties"],
  shots: ["Reading the locked screenplay", "Analyzing the screenplay: characters, environments, properties and how they look", "Cinematic Director: directions for every scene", "Approving the directions", "Cutting scenes into shots"],
  finish: ["Planning the prompts", "Checking and approving the Production Blueprint"],
};

function helpers({ phase, setJob, isCancelled = async () => false }) {
  const steps = PHASE_STEPS[phase];
  const warnings = [];
  const step = (n, detail = "") => setJob({ phase, status: "running", step: n + 1, steps: steps.length, label: steps[n], detail, warnings });
  const stop = async (status, message, extra = {}) => { await setJob({ phase, status, message, label: null, warnings, ...extra }); return { status, message, warnings, ...extra }; };
  const moneyStop = (r) => r.status === 402 || r.data?.code === "budget";
  // Cancel pressed by the director: work stops at the next safe point; what is already made is kept.
  const cancelled = async (what = "") => (await isCancelled()) ? stop("cancelled", `Stopped as you asked${what ? ` (${what})` : ""}. Whatever was already made is kept. Press “Create shot division from screenplay” again to carry on — scenes that already have shots are left alone.`) : null;
  return { warnings, step, stop, moneyStop, cancelled };
}

// PHASE 1
export async function runPrepare({ projectId, api, setJob }) {
  const { step, stop } = helpers({ phase: "prepare", setJob });
  await step(0);
  const sync = await api("POST", `/api/production/${projectId}/blueprint/sync`, {});
  if (!sync.ok || sync.data?.analyzed === false) return stop("failed", `Adu could not read the screenplay into production: ${sync.data?.reason ?? sync.data?.error ?? "unknown problem"}`);
  return stop("waiting_for_you", "The characters, environments and properties are ready. Next, open the Storyboard Designer and press “Create shot division from screenplay”.", { next: "create_shots" });
}

// PHASE 2
export async function runShotDivision({ projectId, api, listScenes, setJob, isCancelled, screenplayOnly = false, sleep = sleepReal, pollMs = 5000, maxWaitMs = 40 * 60 * 1000 }) {
  const production = `/api/production/${projectId}`;
  const cinematic = `/api/ai-movie/projects/${projectId}/cinematic`;
  const { warnings, step, stop, moneyStop, cancelled } = helpers({ phase: "shots", setJob, isCancelled });

  await step(0);
  const sync = await api("POST", `${production}/blueprint/sync`, {});
  if (!sync.ok || sync.data?.analyzed === false) return stop("failed", `Adu could not read the screenplay into production: ${sync.data?.reason ?? sync.data?.error ?? "unknown problem"}`);

  let stopped = await cancelled("before analyzing the screenplay");
  if (stopped) return stopped;

  // The screenplay is final: Adu only READS it for what the Image Studio needs (characters and how they look, environments,
  // properties). Nothing is rewritten, judged or rebuilt. Skipped when the project already has these.
  await step(1);
  const assets = await api("POST", `/api/ai-movie/projects/${projectId}/analyze-screenplay-assets`, {});
  if (moneyStop(assets)) return stop("needs_attention", "The money limit was reached before Adu could analyze the screenplay. Raise the limit and press “Create shot division from screenplay” again.");
  if (!assets.ok) return stop("failed", `Adu could not analyze the screenplay for characters, environments and properties: ${assets.data?.error ?? assets.status}`);
  stopped = await cancelled("after analyzing the screenplay");
  if (stopped) return stopped;

  // cinematic directions (not for an imported/sent screenplay, which Adu must not reinterpret; optional otherwise:
  // a failure here is noted, the shots are still made)
  const started = screenplayOnly ? { ok: false, status: 0, data: {}, skipped: true } : (await step(2), await api("POST", `${cinematic}/analyze`, {}));
  if (moneyStop(started)) return stop("needs_attention", "The money limit was reached before the Cinematic Director could start. Raise the limit and press “Create shot division from screenplay” again.");
  if (!started.skipped && !started.ok && started.status !== 409) warnings.push(`The Cinematic Director could not start (${started.data?.error ?? started.status}); the shots are made without cinematic directions.`);
  let waited = 0;
  while (started.ok || started.status === 409) {
    const view = await api("GET", cinematic);
    const job = view.data?.job;
    if (!job || job.status !== "running") {
      if (job?.stoppedBy === "user") return (await cancelled("the Cinematic Director") ) ?? stop("cancelled", "Stopped as you asked. Whatever was already made is kept.");
      if (job?.stoppedBy === "money_limit") return stop("needs_attention", "The money limit was reached while the Cinematic Director was working. Raise the limit and press “Create shot division from screenplay” again.");
      if (job?.status === "failed") warnings.push(job.error ?? "The Cinematic Director stopped early.");
      break;
    }
    await step(2, `${job.done ?? 0} of ${job.total ?? "?"} scenes`);
    if (await isCancelled?.()) { await api("POST", `${cinematic}/stop`, {}); }
    if ((waited += pollMs) > maxWaitMs) { warnings.push("The Cinematic Director took too long; continuing without the rest of its directions."); break; }
    await sleep(pollMs);
  }

  stopped = await cancelled("before approving the directions");
  if (stopped) return stopped;
  // approve every current direction, then send them to the shot cutter
  if (!screenplayOnly) {
    await step(3);
    const view = (await api("GET", cinematic)).data;
    for (const item of view?.items ?? []) {
      if (item.kind === "cinematic_direction" && item.status === "pending" && !item.stale && !item.waitingForChange) await api("POST", `${cinematic}/items/${item.id}/approve`, {});
    }
    const sent = await api("POST", `${cinematic}/send-to-production`, {});
    if (!sent.ok) warnings.push(`The directions could not be sent to production (${sent.data?.error ?? sent.status}).`);
  }

  // the shots, scene by scene (a scene that already has shots is left as it is)
  const scenes = await listScenes();
  if (scenes.length === 0) return stop("failed", "The screenplay has no scenes to cut into shots.");
  for (let i = 0; i < scenes.length; i++) {
    stopped = await cancelled(`${i} of ${scenes.length} scenes were cut`);
    if (stopped) return stopped;
    await step(4, `scene ${i + 1} of ${scenes.length}`);
    const divided = await api("POST", `${production}/scenes/${scenes[i]}/divide`, { mode: "auto" });
    if (moneyStop(divided)) return stop("needs_attention", `The money limit was reached while cutting shots (scene ${i + 1} of ${scenes.length}). Raise the limit and press “Create shot division from screenplay” again.`);
    if (!divided.ok && divided.data?.code !== "exists") return stop("failed", `Adu could not cut scene ${i + 1} into shots: ${divided.data?.error ?? divided.status}`);
  }
  // NEVER approved here: that is the director's decision
  const list = await api("GET", `${production}/shots`);
  const pending = (list.data?.shots ?? []).filter((s) => s.shotStatus !== "approved").length;
  return stop("waiting_for_you", `The shot division is ready — ${pending || "all the"} shot${pending === 1 ? "" : "s"} to check. Review them in the Storyboard Designer (add, remove, combine or edit shots) and approve each scene. When the last scene is approved, Adu finishes the rest by himself.`, { next: "approve_shots" });
}

// PHASE 3
export async function runFinish({ projectId, api, setJob }) {
  const production = `/api/production/${projectId}`;
  const { step, stop, moneyStop } = helpers({ phase: "finish", setJob });
  const list = await api("GET", `${production}/shots`);
  const pending = (list.data?.shots ?? []).filter((s) => s.shotStatus !== "approved").length;
  if (!list.ok || pending > 0 || (list.data?.shots ?? []).length === 0) return stop("waiting_for_you", `${pending || "Some"} shot${pending === 1 ? " is" : "s are"} not approved yet. Approve every scene in the Storyboard Designer first.`, { next: "approve_shots" });

  await step(0);
  const planned = await api("POST", `${production}/blueprint/prompts/plan`, {});
  if (!planned.ok) return stop(moneyStop(planned) ? "needs_attention" : "failed", `Adu could not plan the prompts: ${planned.data?.error ?? planned.status}`);

  await step(1);
  const check = await api("POST", `${production}/blueprint/validate`, {});
  if (!check.ok || check.data?.ok === false) {
    const problems = (check.data?.errors ?? []).map((e) => e.message).slice(0, 5);
    return stop("needs_attention", `The Blueprint has ${problems.length || "a"} problem${problems.length === 1 ? "" : "s"} Adu could not fix by himself: ${problems.join(" ") || check.data?.error || "unknown"}`);
  }
  const approved = await api("POST", `${production}/blueprint/approve`, {});
  if (!approved.ok) return stop("needs_attention", `The Blueprint could not be approved: ${approved.data?.error ?? approved.status}`);
  return stop("done", "The production plan is ready and the Timeline is created.");
}

export const RUNNERS = { prepare: runPrepare, shots: runShotDivision, finish: runFinish };
