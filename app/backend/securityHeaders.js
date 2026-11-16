// Security headers for every answer of the server (from the owner's pre-launch security checklist, point 10.1). Only headers that cannot break the app:
//   * X-Content-Type-Options: nosniff — a browser must not guess a file's type (a picture or a download is never run as a script);
//   * Referrer-Policy — the address of the page a person came from is not sent to other sites;
//   * Strict-Transport-Security (production only) — the browser talks to the server over HTTPS only;
//   * X-Powered-By is removed — the server does not announce what it is built with.
// Not added on purpose: a strict Content-Security-Policy or frame blocking on the server, because pictures, videos and PDFs from the server are shown inside the app's own page.
export function securityHeaders({ production = false } = {}) {
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (production) res.setHeader("Strict-Transport-Security", "max-age=15552000");
    res.removeHeader("X-Powered-By");
    next();
  };
}
