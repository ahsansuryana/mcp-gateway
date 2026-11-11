import { parseBody, readRaw, sendHtml, sendJson } from "../http/io.js";
import { loginPage, pageHeaders } from "./pages.js";

/**
 * Menangani /register, /token, /revoke, /authorize dan /.well-known/*.
 * Mengembalikan true bila request sudah ditangani.
 */
export async function handleOAuthRoute(oauth, req, res, url, baseOf, ipOf) {
  const path = url.pathname;
  const base = baseOf(req); // issuer yang cocok dengan host yang dipakai klien
  const known = ["/register", "/token", "/revoke", "/authorize"].includes(path) || path.startsWith("/.well-known/");
  if (!known) return false;
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
    "Cache-Control": "no-store",
  };
  if (req.method === "OPTIONS" && path !== "/authorize") {
    res.writeHead(204, cors);
    res.end();
    return true;
  }
  const json = (status, body) => sendJson(res, status, body, cors);
  const wantMethod = (...ms) => (ms.includes(req.method) ? true : (json(405, { error: "method not allowed" }), false));

  try {
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      if (wantMethod("GET")) json(200, oauth.authServerMetadata(base));
      return true;
    }
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      const suffix = path.slice("/.well-known/oauth-protected-resource".length).replace(/\/+$/, "") || "/mcp";
      if (!/^\/mcp(\/[\w.-]+)?$/.test(suffix)) return false;
      if (wantMethod("GET")) json(200, { resource: base + suffix, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: ["mcp"] });
      return true;
    }
    if (path === "/register") {
      if (!wantMethod("POST")) return true;
      const r = oauth.register(parseBody(req, await readRaw(req)));
      return json(r.ok ? 201 : 400, r.ok ?? r), true;
    }
    if (path === "/token") {
      if (!wantMethod("POST")) return true;
      let basic;
      const ah = req.headers.authorization ?? "";
      if (/^Basic /i.test(ah)) {
        const [id, ...rest] = Buffer.from(ah.slice(6), "base64").toString("utf-8").split(":");
        basic = { id: decodeURIComponent(id), secret: decodeURIComponent(rest.join(":")) };
      }
      const r = oauth.token(parseBody(req, await readRaw(req)), basic);
      return json(r.status, r.body), true;
    }
    if (path === "/revoke") {
      if (!wantMethod("POST")) return true;
      oauth.revoke(parseBody(req, await readRaw(req)).token);
      res.writeHead(200, cors);
      res.end();
      return true;
    }
    // /authorize
    if (req.method === "GET") {
      const r = oauth.beginAuthorize(url.searchParams);
      if (r.fatal) return sendHtml(res, 400, "Permintaan tidak valid", r.fatal), true;
      if (r.redirect) return res.writeHead(302, { Location: r.redirect, "Cache-Control": "no-store" }), res.end(), true;
      res.writeHead(200, pageHeaders);
      res.end(loginPage(r));
      return true;
    }
    if (req.method === "POST") {
      const f = parseBody(req, await readRaw(req));
      const r = oauth.approve(f.txn, f.password, ipOf(req));
      if (r.kind === "ok") return res.writeHead(302, { Location: r.location, "Cache-Control": "no-store" }), res.end(), true;
      if (r.kind === "expired") return sendHtml(res, 400, "Sesi kedaluwarsa", "Mulai ulang proses hubungkan dari agen."), true;
      if (r.kind === "locked") return sendHtml(res, 429, "Terlalu banyak percobaan", "Coba lagi dalam 15 menit."), true;
      const info = oauth.txnInfo(f.txn);
      res.writeHead(401, pageHeaders);
      res.end(info ? loginPage(info, "Password salah.") : "");
      return true;
    }
    json(405, { error: "method not allowed" });
    return true;
  } catch (e) {
    if (!res.headersSent) json(400, { error: "invalid_request", error_description: e?.message ?? "bad request" });
    return true;
  }
}
