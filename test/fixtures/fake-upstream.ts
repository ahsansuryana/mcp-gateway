// Fake upstream MCP servers used by the Sprint 2 E2E suite (PLAN.md D15).
// Three flavours, exactly as S2.6 requires:
//   - `fast`      responds immediately with a few tools
//   - `slow`      sleeps longer than the gateway's per-upstream timeout
//   - `failing`   refuses to start (its endpoint is not listening)
//
// Verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts

import http from 'node:http';
import { McpServer, createMcpHandler, inputRequired } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

export type FakeKind = 'fast' | 'slow';

export interface FakeUpstream {
  url: string;
  kind: FakeKind;
  /** Publishes `notifications/tools/list_changed` on the fake's own bus (S3.4). */
  publishToolsChanged: () => void;
  close: () => Promise<void>;
}

export interface FakeOptions {
  port: number;
  kind: FakeKind;
  /** Adds resources + prompts to the fake (Sprint 3). */
  withResources?: boolean;
  /** Adds the MRTR tool: input_required, then complete on the retry (S3.5). */
  withMrtr?: boolean;
  /** Adds a tool that emits progress notifications and records the traceparent (S3.6). */
  withProgress?: boolean;
  /** Called when the MRTR tool sees `requestState` echoed back. */
  onMrtrComplete?: (requestState: unknown) => void;
  /** Called when the progress tool observes an abort (S3.6). */
  onAborted?: () => void;
  /** Called by the fake's own change publisher, so a test can drive list_changed. */
  getPublishToolsChanged?: (() => void) | undefined;
  /** Sent on every tool result, so a test can prove provenance. */
  prefix: string;
  /** Emitted as the server's own `tools/list` cache hint. */
  ttlMs?: number;
  /** Reported by the fake for its bearer requirement; used for the 401 scenario. */
  requireAuth?: boolean;
}

/** Port allocation is sequential and explicit so transcripts stay reproducible. */
export async function startFakeUpstream(options: FakeOptions): Promise<FakeUpstream> {
  const factory = () => {
    const server = new McpServer(
      { name: `fake-${options.kind}`, version: '0.0.1' },
      {
        // `listChanged: true` is REQUIRED for the fake to honour a `toolsListChanged`
        // subscription: with `false` the server drops the filter and answers the ack with
        // an empty honoured set (verified in spikes/debug-fake.mjs).
        capabilities: { tools: { listChanged: true } },
        // Every cacheable operation advertises the same hint, so D11's minimum can be
        // exercised on resources/list and prompts/list as well as tools/list.
        cacheHints:
          options.ttlMs === undefined
            ? {}
            : {
                'tools/list': { ttlMs: options.ttlMs, cacheScope: 'private' },
                'resources/list': { ttlMs: options.ttlMs, cacheScope: 'private' },
                'prompts/list': { ttlMs: options.ttlMs, cacheScope: 'private' },
              },
      },
    );

    server.registerTool(
      'echo',
      {
        description: 'Echoes the input, tagged with the upstream prefix.',
        inputSchema: { text: z.string(), meta: z.unknown().optional() },
      },
      ({ text, meta }) => ({
        content: [{ type: 'text', text: `${options.prefix}:${text}` }],
        structuredContent: { prefix: options.prefix, text, meta: meta ?? null },
      }),
    );

    server.registerTool(
      'deep',
      {
        description: 'Echoes deeply nested JSON, for byte-for-byte round-trip checks.',
        inputSchema: { payload: z.unknown() },
      },
      ({ payload }) => ({ content: [{ type: 'text', text: `${options.prefix}:deep` }], structuredContent: payload }),
    );

    if (options.kind === 'slow') {
      server.registerTool(
        'sleep',
        { description: 'Sleeps for ms, then replies.', inputSchema: { ms: z.number() } },
        async ({ ms }) => {
          // verified: https://nodejs.org/api/timers.html#settimeoutcallback-delay-args (node:timers)
          await new Promise((resolve) => setTimeout(resolve, ms));
          return { content: [{ type: 'text', text: `${options.prefix}:slept` }] };
        },
      );
    }

    if (options.kind === 'fast') {
      server.registerTool(
        'always_fails',
        { description: 'Reports a tool-level failure.', inputSchema: z.object({}) },
        () => ({
          content: [{ type: 'text', text: `${options.prefix}:tool-level failure` }],
          isError: true,
        }),
      );
    }

    if (options.withResources === true) {
      // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (McpServer.registerResource)
      server.registerResource(
        'config',
        'file:///shared/config.json',
        { description: 'A resource two upstreams can both publish.' },
        (uri) => ({
          contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ owner: options.prefix, uri: uri.href }) }],
        }),
      );
      server.registerResource(
        'readme',
        'custom:readme',
        { description: 'A custom-scheme resource.' },
        (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: `${options.prefix} readme` }] }),
      );

      // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (McpServer.registerPrompt)
      server.registerPrompt(
        'review',
        { description: 'Review a change.', argsSchema: { target: z.string() } },
        ({ target }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `${options.prefix}: review ${target}` } }] }),
      );
    }

    if (options.withMrtr === true) {
      server.registerTool(
        'needs_input',
        { description: 'Returns input_required once, then completes.', inputSchema: z.object({}) },
        (_args, ctx) => {
          const responses = ctx.mcpReq.inputResponses;
          if (responses !== undefined && Object.keys(responses).length > 0) {
            options.onMrtrComplete?.(ctx.mcpReq.requestState());
            return {
              content: [{ type: 'text', text: `${options.prefix}:mrtr-complete state=${String(ctx.mcpReq.requestState())}` }],
            };
          }
          // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (const inputRequired)
          return inputRequired({
            inputRequests: {
              proceed: inputRequired.elicit({
                message: `${options.prefix}: proceed?`,
                requestedSchema: z.object({ proceed: z.boolean() }),
              }),
            },
            requestState: `${options.prefix}-minted-state`,
          });
        },
      );
    }

    if (options.withProgress === true) {
      server.registerTool(
        'counted',
        { description: 'Emits progress notifications then completes.', inputSchema: z.object({ steps: z.number() }) },
        async ({ steps }, ctx) => {
          const token = ctx.mcpReq._meta?.['progressToken'];
          for (let i = 1; i <= steps; i += 1) {
            if (token !== undefined) {
              await ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: { progressToken: token, progress: i, total: steps, message: `step ${i}` },
              });
            }
            await new Promise((r) => setTimeout(r, 20));
          }
          return { content: [{ type: 'text', text: `${options.prefix}:counted traceparent=${String(ctx.mcpReq._meta?.['traceparent'])}` }] };
        },
      );

      server.registerTool(
        'hang',
        { description: 'Never completes; aborts on cancellation.', inputSchema: z.object({}) },
        async (_args, ctx) =>
          new Promise((_resolve, reject) => {
            ctx.mcpReq.signal.addEventListener('abort', () => {
              options.onAborted?.();
              reject(new Error('aborted by test'));
            });
          }),
      );
    }

    return server;
  };

  const handler = createMcpHandler(factory, { legacy: 'reject' });
  const nodeHandler = toNodeHandler(handler);
  const httpServer = http.createServer((req, res) => {
    // The SDK's duck-typed request shape declares `method?: string`, while Node types it
    // `string | undefined`. Under `exactOptionalPropertyTypes` the two are incompatible even
    // though the runtime shape is identical, and eslint's no-unnecessary-type-assertion
    // cannot see that (the rule does not model exactOptionalPropertyTypes). One documented
    // cast rather than weakening the compiler setting for the whole project.
    void nodeHandler(req as Parameters<typeof nodeHandler>[0], res);
  });
  await new Promise<void>((resolve) => httpServer.listen(options.port, '127.0.0.1', () => resolve()));

  return {
    url: `http://127.0.0.1:${options.port}/mcp`,
    kind: options.kind,
    // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (McpHttpHandler.notify.toolsChanged)
    publishToolsChanged: () => handler.notify.toolsChanged(),
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

/**
 * Returns a port that was bound and immediately released, so a server that refuses to
 * start cannot accidentally collide with a real listener.
 * verified: https://nodejs.org/api/net.html#netserverlistenport-host-backlog-callback
 */
export async function unusedPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}