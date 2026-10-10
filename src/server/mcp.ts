// PLAN.md S3.1–S3.6: the downstream MCP server that fronts the aggregate.
//
// The wire format is never hand-rolled: `createMcpHandler` + `toNodeHandler` own it
// (verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts).

import {
  Server,
  createMcpHandler,
  type McpHttpHandler,
  type Prompt,
  type Resource,
} from '@modelcontextprotocol/server';

import { aggregateCallTool, aggregateToolsList, computeTtlMs, forwardMeta } from '../aggregate/tools.js';
import { aggregatePrompts, unknownPrompt } from '../aggregate/prompts.js';
import { decodeResourceUri, encodeResourceUri, resourceNotFound } from '../aggregate/resources.js';
import { parseNamespacedName } from '../aggregate/namespace.js';
import { SubscriptionFanout } from './subscriptions.js';
import type { Logger } from '../observability/logger.js';
import type { UpstreamManager } from '../upstream/manager.js';
import type { GatewayConfig } from '../config/schema.js';

export interface BuildMcpServerOptions {
  config: GatewayConfig;
  aggregator: {
    manager: UpstreamManager;
    logger: Logger;
    defaultTtlMs: number;
  };
  logger: Logger;
  /** PLAN.md S2.5: request body size limit. */
  maxRequestBodySize?: number;
}

export interface BuiltGateway {
  handler: McpHttpHandler;
  fanout: SubscriptionFanout;
  startFanout: () => Promise<void>;
  stopFanout: () => Promise<void>;
}

/**
 * D3: aggregated mode only — one endpoint, `POST /mcp`. The factory runs per request, so
 * the returned handler is stateless (D10).
 *
 * Capability advertisement (Sprint 3 acceptance: "the capability advertisement from
 * `server/discover` matches reality"):
 *   - `tools` — always advertised; an empty list is still a valid answer.
 *   - `resources` — only when at least one upstream is `ready`.
 *   - `prompts` — only when at least one upstream is `ready`.
 *   - `resources/templates` is NEVER advertised: resource templates are a non-goal
 *     (PLAN.md §1, S3.1).
 *   - `tools.listChanged` — true, because S3.4 wires `subscriptions/listen`.
 */
export function buildGatewayMcp(options: BuildMcpServerOptions): BuiltGateway {
  const { config, aggregator, logger } = options;
  const maxBody = options.maxRequestBodySize ?? 1_048_576;

  const hasReadyUpstream = (): boolean =>
    aggregator.manager.all().some((u) => u.status().state === 'ready');

  const factory = () => {
    const ready = hasReadyUpstream();

    // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts
    //   (class Server, ServerOptions.capabilities/cacheHints)
    const server = new Server(
      { name: 'mcp-gateway', version: '0.0.0' },
      {
        capabilities: {
          tools: { listChanged: true },
          ...(ready ? { resources: {} } : {}),
          ...(ready ? { prompts: {} } : {}),
        },
        instructions: 'Aggregated MCP gateway. Tools and prompts are namespaced as <server>_<name>; resource URIs are rewritten to gw://<server>/<encoded original>.',
      },
    );

    // --- tools ------------------------------------------------------------
    server.setRequestHandler('tools/list', async (_request, ctx) => {
      const aggregated = await aggregateToolsList(aggregator, ctx.mcpReq.signal);
      // Returning ttlMs/cacheScope on the result itself wins over any configured hint
      // (verified: node_modules/@modelcontextprotocol/server/dist/src-Cqbh3MYc.mjs,
      //   fillCacheFields reads a valid handler-returned value first), which is what D11's
      //   dynamic minimum needs.
      return { tools: aggregated.tools, ttlMs: aggregated.ttlMs, cacheScope: aggregated.cacheScope };
    });

    server.setRequestHandler('tools/call', async (request, ctx) => {
      const params = request.params;

      // S3.6: re-emit the upstream's progress notifications on THIS request's response
      // stream, tagged with the downstream caller's own progressToken.
      const downstreamToken = ctx.mcpReq._meta?.['progressToken'];

      const result = await aggregateCallTool(
        aggregator,
        params.name,
        params.arguments,
        forwardMeta(ctx.mcpReq._meta),
        ctx.mcpReq.signal,
        // Q-MRTRPROXY: re-attach the fields the SDK seam lifted out of `params`.
        {
          ...(ctx.mcpReq.inputResponses === undefined ? {} : { inputResponses: ctx.mcpReq.inputResponses }),
          ...(ctx.mcpReq.requestState() === undefined ? {} : { requestState: ctx.mcpReq.requestState() }),
        },
        downstreamToken === undefined
          ? {}
          : {
              onUpstreamProgress: async (progress: unknown): Promise<void> => {
                const p = progress as { progress?: unknown; total?: unknown; message?: unknown };
                await ctx.mcpReq.notify({
                  method: 'notifications/progress',
                  params: {
                    progressToken: downstreamToken,
                    ...(p.progress === undefined ? {} : { progress: p.progress }),
                    ...(p.total === undefined ? {} : { total: p.total }),
                    ...(typeof p.message === 'string' ? { message: `[gateway] ${p.message}` } : {}),
                  },
                });
              },
            },
      );
      return result;
    });

    // --- resources (S3.1) -------------------------------------------------
    if (ready) {
      server.setRequestHandler('resources/list', async (_request, ctx) => {
        const aggregated = await aggregateResourceList(aggregator, ctx.mcpReq.signal);
        return { resources: aggregated.resources, ttlMs: aggregated.ttlMs, cacheScope: 'private' as const };
      });

      server.setRequestHandler('resources/read', async (request, ctx) => {
        const decoded = decodeResourceUri(request.params.uri);
        if (decoded === null) throw resourceNotFound(request.params.uri);

        const upstream = aggregator.manager.get(decoded.server);
        if (upstream === undefined || upstream.status().state !== 'ready') {
          throw resourceNotFound(request.params.uri);
        }

        try {
          const result = await upstream.readResource(decoded.originalUri, ctx.mcpReq.signal);
          // S3.3: D11 applies to `resources/read` too. A single-upstream read has exactly
          // one contributor, so the minimum is that upstream's own hint (or the gateway
          // default when it gave none).
          return {
            ...result,
            ttlMs: typeof result.ttlMs === 'number' ? result.ttlMs : config.gateway.defaultTtlMs,
            cacheScope: 'private' as const,
          };
        } catch (err) {
          if (err instanceof Error && err.name === 'ProtocolError') throw err;
          logger.warn(
            { upstream: decoded.server, reason: err instanceof Error ? err.message : String(err) },
            'upstream resources/read failed',
          );
          // S3.1: a read that cannot be served is "not found" from the gateway's view.
          throw resourceNotFound(request.params.uri);
        }
      });
    }

    // --- prompts (S3.2) ---------------------------------------------------
    if (ready) {
      server.setRequestHandler('prompts/list', async (_request, ctx) => {
        const aggregated = await aggregatePromptList(aggregator, ctx.mcpReq.signal);
        return { prompts: aggregated.prompts, ttlMs: aggregated.ttlMs, cacheScope: 'private' as const };
      });

      server.setRequestHandler('prompts/get', async (request, ctx) => {
        const parsed = parseNamespacedName(request.params.name);
        if (parsed === null) throw unknownPrompt(request.params.name);
        const upstream = aggregator.manager.get(parsed.server);
        if (upstream === undefined || upstream.status().state !== 'ready') {
          throw unknownPrompt(request.params.name);
        }
        try {
          return await upstream.getPrompt(parsed.name, request.params.arguments, ctx.mcpReq.signal);
        } catch (err) {
          if (err instanceof Error && err.name === 'ProtocolError') throw err;
          logger.warn(
            { upstream: parsed.server, prompt: parsed.name, reason: err instanceof Error ? err.message : String(err) },
            'upstream prompts/get failed',
          );
          throw unknownPrompt(request.params.name);
        }
      });
    }

    return server;
  };

  // `legacy` comes from the config field decided at the Sprint 0 gate
  // (docs/adr/0002-protocol-compatibility.md).
  const handler = createMcpHandler(factory, {
    legacy: config.gateway.legacyEra,
    maxRequestBodySize: maxBody,
    onerror: (err) => {
      logger.error({ err: err.message }, 'mcp handler error');
    },
  });

  const fanout = new SubscriptionFanout({
    manager: aggregator.manager,
    logger,
    computeToolNames: async () => (await aggregateToolsList(aggregator, AbortSignal.timeout(10_000))).tools.map((t) => t.name),
    notifyToolsChanged: () => handler.notify.toolsChanged(),
  });

  return {
    handler,
    fanout,
    startFanout: () => fanout.start(),
    stopFanout: () => fanout.stop(),
  };
}

/** D5 rewrite for the aggregated resource list. */
async function aggregateResourceList(
  aggregator: BuildMcpServerOptions['aggregator'],
  signal: AbortSignal,
): Promise<{ resources: Resource[]; ttlMs: number }> {
  const resources: Resource[] = [];
  const ttls: number[] = [];

  await Promise.all(
    aggregator.manager.all().map(async (upstream) => {
      if (upstream.status().state !== 'ready') return;
      try {
        const result = await upstream.listResources(signal);
        for (const resource of result.resources ?? []) {
          resources.push({
            ...resource,
            uri: encodeResourceUri(upstream.name, resource.uri),
            name: `${upstream.name}_${resource.name}`,
          });
        }
        if (typeof result.ttlMs === 'number') ttls.push(result.ttlMs);
      } catch {
        // D8: this upstream simply contributes nothing.
      }
    }),
  );

  resources.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  return { resources, ttlMs: computeTtlMs(ttls.map((ttlMs) => ({ ttlMs })), aggregator.defaultTtlMs) };
}

/** D4 namespacing for the aggregated prompt list. */
async function aggregatePromptList(
  aggregator: BuildMcpServerOptions['aggregator'],
  signal: AbortSignal,
): Promise<{ prompts: Prompt[]; ttlMs: number }> {
  const entries: { server: string; name: string; prompt: Prompt }[] = [];
  const ttls: number[] = [];

  await Promise.all(
    aggregator.manager.all().map(async (upstream) => {
      if (upstream.status().state !== 'ready') return;
      try {
        const result = await upstream.listPrompts(signal);
        for (const prompt of result.prompts ?? []) {
          entries.push({ server: upstream.name, name: prompt.name, prompt });
        }
        if (typeof result.ttlMs === 'number') ttls.push(result.ttlMs);
      } catch {
        // D8.
      }
    }),
  );

  const { prompts } = aggregatePrompts(entries);
  return { prompts, ttlMs: computeTtlMs(ttls.map((ttlMs) => ({ ttlMs })), aggregator.defaultTtlMs) };
}

