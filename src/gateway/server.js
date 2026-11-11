import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createCatalog } from "./catalog.js";
import { createCompactor } from "./compact.js";
import { createContext } from "./context.js";
import { createHandlers } from "./handlers.js";
import { buildToolDefs } from "./meta-tools.js";
import { errorResult } from "./results.js";

/**
 * Server MCP yang menghadap agen. Dibuat per-request (mode stateless),
 * tetapi pool backend dipakai bersama.
 */
export function makeGatewayFactory(cfg, pool) {
  const ctx = createContext(cfg, pool);
  const { sep, NAME } = ctx;
  const { STATUS_TOOL, META_TOOLS } = buildToolDefs(NAME);
  const compactTool = createCompactor(ctx);
  const catalogApi = createCatalog(ctx);
  const { catalog } = catalogApi;
  const handlers = createHandlers(ctx, catalogApi);

  // scope = Set nama backend (profil) atau null untuk semua.
  return function createGatewayServer(scope = null, label = null) {
    const server = new Server(
      { name: (cfg.server.name ?? "mcp-gateway") + (label ? `/${label}` : ""), version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const cat = await catalog(scope);
      const out = [STATUS_TOOL];
      if (cat.some((c) => c.mode === "lazy")) out.push(...META_TOOLS);
      for (const c of cat) {
        if (c.mode !== "full") continue;
        for (const t of c.tools) out.push(compactTool({ ...t, name: `${c.backend}${sep}${t.name}` }));
      }
      return { tools: out };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const full = req.params.name;
      const args = req.params.arguments ?? {};
      if (full === NAME.status) return handlers.handleStatus(scope);
      if (full === NAME.search) return handlers.handleSearch(scope, args);
      if (full === NAME.describe) return handlers.handleDescribe(scope, args);
      if (full === NAME.call) {
        if (typeof args.name !== "string") return errorResult("parameter 'name' (string) wajib diisi");
        return handlers.callBackendTool(scope, args.name, args.arguments);
      }
      return handlers.callBackendTool(scope, full, args);
    });

    return server;
  };
}
