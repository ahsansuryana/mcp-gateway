import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import type { BackendPool } from "../backend/pool.js";
import type { GatewayConfig } from "../config/types.js";
import { UI_EXTENSION } from "./apps.js";
import { GatewayService, type Scope } from "./service.js";

export type GatewayServerFactory = (scope?: Scope, label?: string | null) => Server;

/**
 * Server MCP per-request (mode stateless) yang menghadap agen.
 * Pool backend dipakai bersama; `scope` = himpunan backend (profil) atau null untuk semua.
 */
export function createGatewayServerFactory(cfg: GatewayConfig, pool: BackendPool): GatewayServerFactory {
  const service = new GatewayService(cfg, pool);

  return (scope = null, label = null) => {
    // resources/prompts/completions selalu diumumkan; bila tidak ada backend yang punya, hasilnya kosong.
    // subscribe/listChanged tidak diumumkan: gateway stateless dan tidak punya stream ke agen.
    const capabilities: ServerCapabilities = { tools: {}, resources: {}, prompts: {}, completions: {} };
    // Ekstensi MCP Apps diumumkan hanya bila ada backend (dalam scope) yang mengumumkannya.
    if (service.supportsApps(scope)) capabilities.extensions = { [UI_EXTENSION]: {} };

    const server = new Server(
      { name: (cfg.server.name ?? "mcp-gateway") + (label ? `/${label}` : ""), version: "1.0.0" },
      { capabilities },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await service.listTools(scope) }));

    server.setRequestHandler(CallToolRequestSchema, async (req) =>
      service.callTool(scope, req.params.name, req.params.arguments ?? {}),
    );

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: await service.listPrompts(scope) }));

    server.setRequestHandler(GetPromptRequestSchema, async (req) =>
      service.getPrompt(scope, req.params.name, req.params.arguments),
    );

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: await service.listResources(scope),
    }));

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: await service.listResourceTemplates(scope),
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (req) => service.readResource(scope, req.params.uri));

    server.setRequestHandler(CompleteRequestSchema, async (req) => service.complete(scope, req.params));

    return server;
  };
}
