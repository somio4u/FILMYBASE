// Which session token belongs to a request? The cookie first. A browser that refuses cross-site cookies (iPhone Safari, Chrome with third-party
// cookies blocked, some app WebViews) sends the same token in an "Authorization: Bearer <64 hex letters>" header instead (the login hands it out
// when asked with returnToken). Anything that is not exactly a session token is ignored.
export function sessionTokenOf(req, cookieName) {
  const fromCookie = req.cookies?.[cookieName];
  if (fromCookie) return fromCookie;
  const header = typeof req.get === "function" ? req.get("authorization") : req.headers?.authorization;
  return /^Bearer ([0-9a-f]{64})$/i.exec(header ?? "")?.[1] ?? null;
}
