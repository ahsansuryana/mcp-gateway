// PLAN.md S2.5: builds the downstream MCP server that fronts the aggregate.
//
// The wire format is never hand-rolled: `createMcpHandler` + `toNodeHandler` own it
// (verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts).

import { Server, createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';

import { aggregateCallTool, aggregateToolsList, type ToolsAggregatorDeps } from '../aggregate/tools.js';
import type { Logger } from '../observability/logger.js';
import { configSummary } from '../observability/redact.js';
import type { GatewayConfig } from '../config/schema.js';
import { FORWARDED_META_KEYS } from '../aggregate/tools.js';

export interface BuildMcpServerOptions {
  config: GatewayConfig;
  aggregator: ToolsAggregatorDeps;
  logger: Logger;
  /** PLAN.md S2.5: request body size limit. */
  maxRequestBodySize?: number;
}

/**
 * D3: aggregated mode only — one endpoint, `POST /mcp`. The factory runs per request, so
 * the returned handler is stateless (D10).
 */
export function createGatewayHandler(options: BuildMcpServerOptions): McpHttpHandler {
  const { config, aggregator, logger } = options;
  const maxBody = options.maxRequestBodySize ?? 1_048_576;

  const factory = () => {
    // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts
    //   (class Server, ServerOptions.capabilities/cacheHints)
    const server = new Server(
      { name: 'mcp-gateway', version: '0.0.0' },
      {
        capabilities: { tools: { listChanged: false } },
        instructions: 'Aggregated MCP gateway. Tools are namespaced as <server>_<tool>.',
      },
    );

    // Dynamic list handler: the tool list is computed per request (PLAN.md S2.3/S2.4).
    // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts
    //   (Protocol.setRequestHandler)
    server.setRequestHandler('tools/list', async (_request, ctx) => {
      const aggregated = await aggregateToolsList(aggregator, ctx.mcpReq.signal);
      // Returning ttlMs/cacheScope on the result itself wins over any configured hint
      // (verified: node_modules/@modelcontextprotocol/server/dist/src-Cqbh3MYc.mjs,
      //   fillCacheFields reads a valid handler-returned value first), which is what D11's
      // dynamic minimum needs.
      return { tools: aggregated.tools, ttlMs: aggregated.ttlMs, cacheScope: aggregated.cacheScope };
    });

    server.setRequestHandler('tools/call', async (request, ctx) => {
      const params = request.params;
      const result = await aggregateCallTool(
        aggregator,
        params.name,
        params.arguments,
        pickForwardableMeta(ctx.mcpReq._meta),
        ctx.mcpReq.signal,
      );
      return result;
    });

    return server;
  };

  // `legacy` comes from the config field decided at the Sprint 0 gate
  // (docs/adr/0002-protocol-compatibility.md).
  const legacy = config.gateway.legacyEra;

  return createMcpHandler(factory, {
    legacy,
    maxRequestBodySize: maxBody,
    onerror: (err) => {
      logger.error({ err: err.message }, 'mcp handler error');
    },
  });
}

/** Keeps only the `_meta` entries PLAN.md §5 lists, and drops the reserved envelope keys. */
export function pickForwardableMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (meta === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of FORWARDED_META_KEYS) {
    const value = meta[key];
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export { configSummary };