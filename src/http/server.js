import { createServer } from "node:http";
import { makeGatewayFactory } from "../gateway/server.js";
import { handleOAuthRoute } from "../oauth-server/routes.js";
import { createAccess } from "./access.js";
import { handleBackendCallback } from "./routes/backend-callback.js";
import { handleHealth } from "./routes/health.js";
import { handleMcp } from "./routes/mcp.js";

/** HTTP layer: endpoint OAuth gateway, /health, /oauth/callback, dan /mcp[/<profil>]. */
export function buildHttpServer(cfg, pool, oauth, publicUrl, bases) {
  const createGatewayServer = makeGatewayFactory(cfg, pool);
  const access = createAccess({ cfg, oauth, publicUrl, bases });
  const deps = { cfg, pool, oauth, access, createGatewayServer };

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");

    if (oauth && (await handleOAuthRoute(oauth, req, res, url, access.baseOf, access.ipOf))) return;
    if (url.pathname === "/health") return handleHealth(req, res, deps);
    if (url.pathname === "/oauth/callback") return handleBackendCallback(req, res, url, deps);
    return handleMcp(req, res, url, deps);
  });
}
