import { safeEq } from "../utils/crypto.js";

/**
 * Autentikasi bearer (token statis dan/atau OAuth gateway) + resolusi alamat per-request.
 */
export function createAccess({ cfg, oauth, publicUrl, bases }) {
  const token = cfg.server.auth_token || null;
  const bearerOf = (req) => (/^Bearer (.+)$/i.exec(req.headers.authorization ?? "") ?? [])[1] ?? null;
  const authRequired = !!(token || oauth);
  const authorized = (req) => {
    if (!authRequired) return true;
    const b = bearerOf(req);
    return !!b && ((token && safeEq(b, token)) || (oauth && oauth.verify(b)));
  };
  const trustProxy = !!cfg.server.trust_proxy;

  // Basis URL per request: harus sama dengan alamat yang dipakai klien (RFC 8414 §3.3).
  // Hanya host yang ada di `bases` yang diterima; selain itu jatuh ke public_url (anti Host-header spoofing).
  const hostOf = (b) => new URL(b).host.toLowerCase();
  const baseOf = (req) => {
    const h = String((trustProxy && req.headers["x-forwarded-host"]) || req.headers.host || "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    return bases.find((b) => hostOf(b) === h) ?? publicUrl;
  };
  const ipOf = (req) =>
    trustProxy && req.headers["x-forwarded-for"]
      ? String(req.headers["x-forwarded-for"]).split(",").pop().trim()
      : req.socket.remoteAddress ?? "?";

  return { bearerOf, authorized, baseOf, ipOf };
}
