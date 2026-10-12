// Live updates. An in-process publish/subscribe bus plus a Server-Sent-Events route, so the Timeline and the studios can
// update the one slot that changed without a page reload. The page also refetches on its own if the connection drops
// (EventSource reconnects by itself), so a missed event only costs a moment, never correctness: the database is the truth.

let counter = 0;
const subscribers = new Map(); // projectId -> Set<(event) => void>

export function publish(projectId, event) {
  const full = { id: ++counter, at: new Date().toISOString(), projectId: Number(projectId), ...event };
  for (const send of subscribers.get(Number(projectId)) ?? []) {
    try { send(full); } catch { /* a closed connection is removed by its own close handler */ }
  }
  return full;
}

export function subscribe(projectId, send) {
  const key = Number(projectId);
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key).add(send);
  return () => { subscribers.get(key)?.delete(send); if (subscribers.get(key)?.size === 0) subscribers.delete(key); };
}

export const subscriberCount = (projectId) => subscribers.get(Number(projectId))?.size ?? 0;

export function registerEventRoutes(app, db, requireRole, { heartbeatMs = 25000 } = {}) {
  // Any successful change made through a production route (shots, dossier, settings, approvals...) tells watchers of that
  // project to refetch. Must be registered BEFORE the production routes so it sees their responses.
  app.use("/api/production/:projectId", (req, res, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      res.on("finish", () => {
        const projectId = Number(req.params.projectId);
        if (res.statusCode < 400 && Number.isInteger(projectId) && projectId > 0) publish(projectId, { type: "changed", method: req.method, path: req.path.slice(0, 80) });
      });
    }
    next();
  });

  app.get("/api/production/:projectId/events", requireRole("admin"), (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) { res.status(400).json({ error: "Not a valid project." }); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    res.write(`data: ${JSON.stringify({ type: "hello", projectId })}\n\n`);
    const unsubscribe = subscribe(projectId, (event) => res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`));
    const beat = setInterval(() => res.write(": keep-alive\n\n"), heartbeatMs);
    req.on("close", () => { clearInterval(beat); unsubscribe(); });
  });
}
