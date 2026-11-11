import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { BackendPool } from "../backend/pool.js";
import type { GatewayConfig } from "../config/types.js";
import type { GatewayServerFactory } from "../gateway/server.js";
import { handleOAuthRoute } from "../oauth-server/routes.js";
import type { OAuthServer } from "../oauth-server/server.js";
import { safeEq } from "../utils/crypto.js";
import { log } from "../utils/logger.js";
import { readJsonBody } from "./body.js";
import { createRequestHelpers } from "./request-helpers.js";
import { sendHtml, sendJson } from "./responses.js";

export interface HttpServerDeps {
  cfg: GatewayConfig;
  pool: BackendPool;
  oauth: OAuthServer | null;
  createGatewayServer: GatewayServerFactory;
  publicUrl: string;
  /** Alamat yang boleh jadi issuer OAuth. */
  bases: string[];
}

/**
 * HTTP layer: /mcp, /mcp/<profil>, /health, /oauth/callback, endpoint OAuth gateway; bearer auth.
 */
export function buildHttpServer({ cfg, pool, oauth, createGatewayServer, publicUrl, bases }: HttpServerDeps): HttpServer {
  const token = cfg.server.auth_token || null;
  const authRequired = !!(token || oauth);
  const helpers = createRequestHelpers({ publicUrl, bases, trustProxy: !!cfg.server.trust_proxy });
  const { baseOf } = helpers;

  const bearerOf = (req: IncomingMessage): string | null =>
    (/^Bearer (.+)$/i.exec(req.headers.authorization ?? "") ?? [])[1] ?? null;

  const authorized = (req: IncomingMessage): boolean => {
    if (!authRequired) return true;
    const b = bearerOf(req);
    return !!b && ((!!token && safeEq(b, token)) || (!!oauth && oauth.verify(b)));
  };

  // ---- /health -----------------------------------------------------------------
  const handleHealth = (req: IncomingMessage, res: ServerResponse): void => {
    const names = Object.keys(pool.configs);
    const body: { backends: Record<string, string>; auth_urls?: Record<string, string> } = {
      backends: Object.fromEntries(names.map((n) => [n, pool.status(n)])),
    };
    // URL login hanya ditampilkan ke pemegang token gateway
    if (authorized(req)) {
      const urls = Object.fromEntries(
        names.map((n) => [n, pool.authUrl(n)] as const).filter((e): e is [string, string] => !!e[1]),
      );
      if (Object.keys(urls).length) body.auth_urls = urls;
    }
    sendJson(res, 200, body);
  };

  // ---- /oauth/callback -----------------------------------------------------------
  // Tujuan redirect browser setelah login di authorization server backend.
  // Tidak bisa memakai bearer token; dilindungi oleh parameter `state` acak.
  const handleBackendCallback = async (res: ServerResponse, url: URL): Promise<void> => {
    const name = pool.findByState(url.searchParams.get("state"));
    if (!name) {
      return sendHtml(res, 400, "Login gagal", "State tidak valid atau sudah kedaluwarsa. Mulai ulang dari URL login terbaru.");
    }
    const err = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (err || !code) return sendHtml(res, 400, "Login ditolak", `Authorization server membalas: ${err ?? "tanpa code"}`);
    try {
      await pool.completeAuth(name, code);
      log("INFO", `login OAuth '${name}' berhasil`);
      sendHtml(res, 200, "Login berhasil", `Backend '${name}' sudah terhubung. Tab ini boleh ditutup.`);
    } catch (e) {
      log("ERROR", `login OAuth '${name}' gagal:`, (e as Error)?.message ?? e);
      sendHtml(res, 500, "Login gagal", (e as Error)?.message ?? String(e));
    }
  };

  // ---- /mcp ------------------------------------------------------------------------
  const handleMcp = async (
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    profile: string | null,
  ): Promise<void> => {
    if (!authorized(req)) {
      const params: string[] = [];
      if (oauth) {
        params.push(`resource_metadata="${baseOf(req)}/.well-known/oauth-protected-resource${path.replace(/\/+$/, "")}"`);
      }
      if (bearerOf(req)) params.push('error="invalid_token"');
      return sendJson(
        res,
        401,
        { error: "unauthorized" },
        { "WWW-Authenticate": params.length ? `Bearer ${params.join(", ")}` : "Bearer" },
      );
    }

    // /mcp = semua server; /mcp/<profil> = hanya server yang terdaftar di profil itu
    if (profile && !Object.hasOwn(cfg.profiles, profile)) {
      return sendJson(res, 404, { error: `profil '${profile}' tidak ada` });
    }
    const scope = profile ? new Set(cfg.profiles[profile]) : null;

    // Mode stateless: hanya POST. GET (stream) & DELETE (session) tidak dipakai.
    if (req.method !== "POST") {
      return sendJson(res, 405, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed (gateway stateless)" },
        id: null,
      });
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }

    const server = createGatewayServer(scope, profile);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log("ERROR", "handle /mcp gagal:", (e as Error)?.message ?? e);
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  };

  /** GATEWAY_DEBUG=1/true/on mengaktifkan log request; 0/false/kosong = mati. */
  const debug = /^(1|true|on|yes)$/i.test(process.env.GATEWAY_DEBUG ?? "");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;

    if (debug && path !== "/health") {
      res.on("finish", () =>
        log("INFO", `req ${req.method} ${req.url} host=${req.headers.host ?? "-"} -> ${res.statusCode}`),
      );
    }

    if (oauth && (await handleOAuthRoute(oauth, req, res, url, helpers))) return;

    if (path === "/health") return handleHealth(req, res);
    if (path === "/oauth/callback") return handleBackendCallback(res, url);

    const m = path.replace(/\/+$/, "").match(/^\/mcp(?:\/([\w.-]+))?$/);
    if (!m) return sendJson(res, 404, { error: "not found" });
    return handleMcp(req, res, path, m[1] ?? null);
  });
}
