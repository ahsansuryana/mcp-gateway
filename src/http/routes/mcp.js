import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { log } from "../../utils/logger.js";
import { readBody, sendJson } from "../io.js";

export async function handleMcp(req, res, url, { cfg, oauth, access, createGatewayServer }) {
  const path = url.pathname;
  const m = path.replace(/\/+$/, "").match(/^\/mcp(?:\/([\w.-]+))?$/);
  if (!m) return sendJson(res, 404, { error: "not found" });

  if (!access.authorized(req)) {
    const params = [];
    if (oauth) params.push(`resource_metadata="${access.baseOf(req)}/.well-known/oauth-protected-resource${path.replace(/\/+$/, "")}"`);
    if (access.bearerOf(req)) params.push('error="invalid_token"');
    return sendJson(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": params.length ? `Bearer ${params.join(", ")}` : "Bearer" });
  }

  // /mcp = semua server; /mcp/<profil> = hanya server yang terdaftar di profil itu
  const profile = m[1] ?? null;
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

  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }

  const server = createGatewayServer(scope, profile);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    log("ERROR", "handle /mcp gagal:", e?.message ?? e);
    if (!res.headersSent) {
      sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
}
