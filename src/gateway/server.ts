import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BackendPool } from "../backend/pool.js";
import type { GatewayConfig } from "../config/types.js";
import { GatewayService, type Scope } from "./service.js";

export type GatewayServerFactory = (scope?: Scope, label?: string | null) => Server;

/**
 * Server MCP per-request (mode stateless) yang menghadap agen.
 * Pool backend dipakai bersama; `scope` = himpunan backend (profil) atau null untuk semua.
 */
export function createGatewayServerFactory(cfg: GatewayConfig, pool: BackendPool): GatewayServerFactory {
  const service = new GatewayService(cfg, pool);

  return (scope = null, label = null) => {
    const server = new Server(
      { name: (cfg.server.name ?? "mcp-gateway") + (label ? `/${label}` : ""), version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await service.listTools(scope) }));

    server.setRequestHandler(CallToolRequestSchema, async (req) =>
      service.callTool(scope, req.params.name, req.params.arguments ?? {}),
    );

    return server;
  };
}
