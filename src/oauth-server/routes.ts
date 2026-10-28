import type { IncomingMessage, ServerResponse } from "node:http";
import { parseBody, readRaw } from "../http/body.js";
import type { RequestHelpers } from "../http/request-helpers.js";
import { sendHtml, sendJson } from "../http/responses.js";
import { loginPage, pageHeaders } from "./pages.js";
import type { OAuthServer } from "./server.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Cache-Control": "no-store",
};

const PROTECTED_RESOURCE_PREFIX = "/.well-known/oauth-protected-resource";

/**
 * Endpoint OAuth gateway: discovery, /register, /authorize, /token, /revoke.
 * @returns true bila request sudah ditangani.
 */
export async function handleOAuthRoute(
  oauth: OAuthServer,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { baseOf, ipOf }: RequestHelpers,
): Promise<boolean> {
  const path = url.pathname;
  const known = ["/register", "/token", "/revoke", "/authorize"].includes(path) || path.startsWith("/.well-known/");
  if (!known) return false;

  const base = baseOf(req); // issuer yang cocok dengan host yang dipakai klien
  if (req.method === "OPTIONS" && path !== "/authorize") {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }
  const json = (status: number, body: unknown): void => sendJson(res, status, body, CORS);
  /** true bila method diizinkan; selain itu balas 405. */
  const wantMethod = (...ms: string[]): boolean => {
    if (ms.includes(req.method ?? "")) return true;
    json(405, { error: "method not allowed" });
    return false;
  };
  const redirect = (location: string): void => {
    res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
    res.end();
  };

  try {
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      if (wantMethod("GET")) json(200, oauth.authServerMetadata(base));
      return true;
    }

    if (path.startsWith(PROTECTED_RESOURCE_PREFIX)) {
      const suffix = path.slice(PROTECTED_RESOURCE_PREFIX.length).replace(/\/+$/, "") || "/mcp";
      if (!/^\/mcp(\/[\w.-]+)?$/.test(suffix)) return false;
      if (wantMethod("GET")) {
        json(200, {
          resource: base + suffix,
          authorization_servers: [base],
          bearer_methods_supported: ["header"],
          scopes_supported: ["mcp"],
        });
      }
      return true;
    }

    if (path === "/register") {
      if (!wantMethod("POST")) return true;
      const r = oauth.register(parseBody(req, await readRaw(req)));
      if ("ok" in r) json(201, r.ok);
      else json(400, r);
      return true;
    }

    if (path === "/token") {
      if (!wantMethod("POST")) return true;
      let basic: { id: string; secret: string } | undefined;
      const ah = req.headers.authorization ?? "";
      if (/^Basic /i.test(ah)) {
        const [id, ...rest] = Buffer.from(ah.slice(6), "base64").toString("utf-8").split(":");
        basic = { id: decodeURIComponent(id), secret: decodeURIComponent(rest.join(":")) };
      }
      const r = oauth.token(parseBody(req, await readRaw(req)), basic);
      json(r.status, r.body);
      return true;
    }

    if (path === "/revoke") {
      if (!wantMethod("POST")) return true;
      oauth.revoke(parseBody(req, await readRaw(req)).token);
      res.writeHead(200, CORS);
      res.end();
      return true;
    }

    // /authorize
    if (req.method === "GET") {
      const r = oauth.beginAuthorize(url.searchParams);
      if ("fatal" in r) sendHtml(res, 400, "Permintaan tidak valid", r.fatal);
      else if ("redirect" in r) redirect(r.redirect);
      else {
        res.writeHead(200, pageHeaders);
        res.end(loginPage(r));
      }
      return true;
    }

    if (req.method === "POST") {
      const f = parseBody(req, await readRaw(req));
      const r = oauth.approve(f.txn, f.password, ipOf(req));
      if (r.kind === "ok") redirect(r.location);
      else if (r.kind === "expired") sendHtml(res, 400, "Sesi kedaluwarsa", "Mulai ulang proses hubungkan dari agen.");
      else if (r.kind === "locked") sendHtml(res, 429, "Terlalu banyak percobaan", "Coba lagi dalam 15 menit.");
      else {
        const info = oauth.txnInfo(f.txn);
        res.writeHead(401, pageHeaders);
        res.end(info ? loginPage(info, "Password salah.") : "");
      }
      return true;
    }

    json(405, { error: "method not allowed" });
    return true;
  } catch (e) {
    if (!res.headersSent) json(400, { error: "invalid_request", error_description: (e as Error)?.message ?? "bad request" });
    return true;
  }
}
