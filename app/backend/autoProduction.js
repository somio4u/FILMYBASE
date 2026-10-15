// AUTO PRODUCTION. Once an AI Movie's screenplay is locked (approved), the production planning that used to need
// three screens and many "Approve" clicks happens by itself:
//   1. read the locked screenplay into production,
//   2. the Cinematic Director writes directions for every scene (after approval it only gives directions; it
//      never rewrites the screenplay) and they are approved and sent to the shot cutter,
//   3. every scene is cut into shots (the director approves them in the Storyboard Designer),
//   4. the prompts are planned,
//   5. the Production Blueprint is checked and approved, which creates the Timeline.
// The money limit still applies (any paid step stops cleanly when it is reached). If the Blueprint check finds
// a problem it cannot fix itself, the job stops and says exactly what.
// The SHOT DIVISION is the one thing Adu never approves himself: after cutting, he waits ("waiting_for_you") until the
// director has approved every scene in the Storyboard Designer; approving the last scene starts him again.
// The steps talk to the app only through `api(method, path, body)` and `listScenes`, so the whole sequence can be
// tested with a scripted `api`.

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const AUTO_STEPS = [
  "Reading the locked screenplay",
  "Cinematic Director: directions for every scene",
  "Approving the directions",
  "Cutting scenes into shots (then waiting for your approval)",
  "Planning the prompts",
  "Checking and approving the Production Blueprint",
];

export async function runAutoProduction({ projectId, api, listScenes, setJob, sleep = sleepReal, pollMs = 5000, maxWaitMs = 40 * 60 * 1000 }) {
  const production = `/api/production/${projectId}`;
  const cinematic = `/api/ai-movie/projects/${projectId}/cinematic`;
  const warnings = [];
  const step = (n, detail = "") => setJob({ status: "running", step: n + 1, steps: AUTO_STEPS.length, label: AUTO_STEPS[n], detail, warnings });
  const stop = async (status, message) => { await setJob({ status, message, label: null, warnings }); return { status, message, warnings }; };
  const moneyStop = (r) => r.status === 402 || r.data?.code === "budget";

  // 1. screenplay into production
  await step(0);
  const sync = await api("POST", `${production}/blueprint/sync`, {});
  if (!sync.ok || sync.data?.analyzed === false) return stop("failed", `Adu could not read the screenplay into production: ${sync.data?.reason ?? sync.data?.error ?? "unknown problem"}`);

  // 2. cinematic directions (optional: a failure here is noted, the film is still planned)
  await step(1);
  const started = await api("POST", `${cinematic}/analyze`, {});
  if (moneyStop(started)) return stop("needs_attention", "The money limit was reached before the Cinematic Director could start. Raise the limit and press “Run again”.");
  if (!started.ok && started.status !== 409) warnings.push(`The Cinematic Director could not start (${started.data?.error ?? started.status}); the shots are planned without cinematic directions.`);
  let waited = 0;
  while (started.ok || started.status === 409) {
    const view = await api("GET", cinematic);
    const job = view.data?.job;
    if (!job || job.status !== "running") {
      if (job?.stoppedBy === "money_limit") return stop("needs_attention", "The money limit was reached while the Cinematic Director was working. Raise the limit and press “Run again”.");
      if (job?.status === "failed") warnings.push(job.error ?? "The Cinematic Director stopped early.");
      break;
    }
    await step(1, `${job.done ?? 0} of ${job.total ?? "?"} scenes`);
    if ((waited += pollMs) > maxWaitMs) { warnings.push("The Cinematic Director took too long; continuing without the rest of its directions."); break; }
    await sleep(pollMs);
  }

  // 3. approve every current direction, then send them to the shot cutter
  await step(2);
  const view = (await api("GET", cinematic)).data;
  for (const item of view?.items ?? []) {
    if (item.kind === "cinematic_direction" && item.status === "pending" && !item.stale && !item.waitingForChange) {
      await api("POST", `${cinematic}/items/${item.id}/approve`, {});
    }
  }
  const sent = await api("POST", `${cinematic}/send-to-production`, {});
  if (!sent.ok) warnings.push(`The directions could not be sent to production (${sent.data?.error ?? sent.status}).`);

  // 4. shots, scene by scene
  const scenes = await listScenes();
  if (scenes.length === 0) return stop("failed", "The screenplay has no scenes to cut into shots.");
  for (let i = 0; i < scenes.length; i++) {
    await step(3, `scene ${i + 1} of ${scenes.length}`);
    const divided = await api("POST", `${production}/scenes/${scenes[i]}/divide`, { mode: "auto" });
    if (moneyStop(divided)) return stop("needs_attention", `The money limit was reached while cutting shots (scene ${i + 1} of ${scenes.length}). Raise the limit and press “Run again”.`);
    if (!divided.ok && divided.data?.code !== "exists") return stop("failed", `Adu could not cut scene ${i + 1} into shots: ${divided.data?.error ?? divided.status}`);
  }
  const shotList = await api("GET", `${production}/shots`);
  const pending = (shotList.data?.shots ?? []).filter((s) => s.shotStatus !== "approved");
  if (!shotList.ok || pending.length > 0) {
    return stop("waiting_for_you", `Adu has cut every scene into shots. Please check them in the Storyboard Designer and approve each scene${pending.length ? ` (${pending.length} shot${pending.length === 1 ? "" : "s"} still waiting)` : ""}. When the last scene is approved, Adu finishes the rest by himself.`);
  }

  // 5. prompts
  await step(4);
  const planned = await api("POST", `${production}/blueprint/prompts/plan`, {});
  if (!planned.ok) return stop(moneyStop(planned) ? "needs_attention" : "failed", `Adu could not plan the prompts: ${planned.data?.error ?? planned.status}`);

  // 6. validate and approve the Blueprint
  await step(5);
  const check = await api("POST", `${production}/blueprint/validate`, {});
  if (!check.ok || check.data?.ok === false) {
    const problems = (check.data?.errors ?? []).map((e) => e.message).slice(0, 5);
    return stop("needs_attention", `The Blueprint has ${problems.length || "a"} problem${problems.length === 1 ? "" : "s"} Adu could not fix by himself: ${problems.join(" ") || check.data?.error || "unknown"}`);
  }
  const approved = await api("POST", `${production}/blueprint/approve`, {});
  if (!approved.ok) return stop("needs_attention", `The Blueprint could not be approved: ${approved.data?.error ?? approved.status}`);
  await setJob({ status: "done", label: null, message: "The production plan is ready and the Timeline is created.", warnings });
  return { status: "done", warnings };
}
