// "Who did it": every screenplay version made by a logged-in person's request (writing a scene with the AI, editing by hand, a draft,
// importing, renaming a character …) is marked with that person (content.madeBy = { id, name, role }). The admin's Review changes then
// says "Edited by hand by Kumar" / "Created by AI by admin". Versions made before this was added carry no name.

// how a person is shown: a writer by name; the admin as "admin (name)"
export function byLabel(madeBy) {
  if (!madeBy?.name && !madeBy?.role) return null;
  if (madeBy.role === "admin") return madeBy.name ? `admin (${madeBy.name})` : "admin";
  return madeBy.name || madeBy.role;
}

export function actorOf(user) {
  return user ? { id: user.id, name: user.name, role: user.role } : null;
}

const TRACKED = /^\/api\/(screenplay\/|scene-lists\/\d+\/)/;

// Express middleware. A request that changes the screenplay writes its new versions before it answers; just before the answer goes out,
// the versions created since the request began are marked with the person who asked.
export function trackSceneAuthors(db) {
  return async (req, res, next) => {
    if (!req.user || req.method === "GET" || !TRACKED.test(req.path)) { next(); return; }
    let before;
    try {
      before = (await db.query("SELECT COALESCE(max(id), 0)::int AS id, now() AS at FROM screenplay_scenes")).rows[0];
    } catch { next(); return; }
    const mark = JSON.stringify({ madeBy: actorOf(req.user) });
    const end = res.end.bind(res);
    res.end = (...args) => {
      if (res.statusCode >= 400) return end(...args);
      db.query("UPDATE screenplay_scenes SET content = content || $1::jsonb WHERE id > $2 AND created_at >= $3", [mark, before.id, before.at])
        .catch((error) => console.error("Could not note who made the scene versions:", error.message))
        .finally(() => end(...args));
      return res;
    };
    next();
  };
}
