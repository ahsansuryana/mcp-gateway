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
  /**
   * Publishes `notifications/prompts/list_changed` and
   * `notifications/resources/list_changed` (B-24(b)).
   */
  publishPromptsChanged: () => void;
  publishResourcesChanged: () => void;
  /** Every `WWW-Authenticate` challenge emitted; S5.6 asserts against it. */
  challenges: string[];
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
  /**
   * Declares `tools.listChanged: false` so the server answers `subscriptions/listen` with a
   * PARTIAL honoured filter (Sprint 3 B-24 / D17).
   */
  withoutListChanged?: boolean;
  /** Sent on every tool result, so a test can prove provenance. */
  prefix: string;
  /** Emitted as the server's own `tools/list` cache hint. */
  ttlMs?: number;
  /**
   * S5.4/S5.6: makes the fake answer 401 with a `WWW-Authenticate` challenge unless the
   * request carries `Authorization: Bearer <requireAuthToken>`.
   */
  requireAuth?: boolean;
  /** The one bearer token this protected fake accepts. */
  requireAuthToken?: string;
  /**
   * Registers a tool whose handler answers with JSON-RPC -32601 Method not found, the way a
   * strict upstream refuses a capability it does not accept. Sprint 7 ADR 0003 (E).
   */
  methodNotFoundTool?: string;
  /** Every `WWW-Authenticate` challenge the fake has emitted; lets a test assert discovery. */
  challenges?: string[];
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
        //
        // verified: node_modules/@modelcontextprotocol/server/dist/mcp-DIH4cS6P.mjs
        //   (honoredSubset: a requested flag is dropped unless the server advertises it)
        capabilities: {
          tools: { listChanged: options.withoutListChanged !== true },
          // B-24(b): the gateway relays these two, so the fake must be able to honour AND
          // to emit them. `withResources` gates them, matching what the gateway itself
          // advertises (resources/prompts capabilities are only declared when it has a
          // ready upstream).
          ...(options.withResources === true
            ? {
                prompts: { listChanged: true },
                resources: { listChanged: true },
              }
            : {}),
        },
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

    if (options.methodNotFoundTool !== undefined) {
      const name = options.methodNotFoundTool;
      // verified: docs/ref/spec-2026-07-28-basic-index.md (JSON-RPC 2.0; -32601 is
      //   METHOD_NOT_FOUND, the code S4.7 observed from the vendor reference server).
      server.registerTool(
        name,
        { description: 'Always answers JSON-RPC -32601.', inputSchema: z.object({}).passthrough() },
        () => {
          // Deliberately returns the CANONICAL upstream shape rather than throwing.
          //
          // Measured in S4.7 against @modelcontextprotocol/server-everything@2026.8.31:
          //   {"content":[{"type":"text","text":"MCP error -32601: Method not found"}],
          //    "isError":true}
          // The SDK server converts a thrown ProtocolError from a handler into an isError
          // result but DROPS the numeric code, so a thrown error would not exercise the
          // real-world shape the gateway has to recognise.
          return {
            content: [{ type: 'text' as const, text: 'MCP error -32601: Method not found' }],
            isError: true,
          };
        },
      );
    }

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
  const challenges: string[] = [];
  const mcpUrl = `http://127.0.0.1:${options.port}/mcp`;
  const httpServer = http.createServer((req, res) => {
    // S5.4/S5.6: a real 401 with a WWW-Authenticate challenge, which is what the MCP
    // authorization spec requires a protected resource to answer.
    // verified: docs/ref/spec-2026-07-28-basic-authorization-index.md lines 101-124 — the
    //   server SHOULD include `resource_metadata` and may include `scope` in the challenge.
    if (options.requireAuth === true) {
      const header = req.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
      if (presented !== options.requireAuthToken) {
        const challenge =
          `Bearer resource_metadata="${mcpUrl.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource/mcp"`;
        challenges.push(challenge);
        res.writeHead(401, {
          'WWW-Authenticate': challenge,
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }

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
    // verified: node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts
    //   (ServerNotifier.promptsChanged / .resourcesChanged)
    publishPromptsChanged: () => handler.notify.promptsChanged(),
    publishResourcesChanged: () => handler.notify.resourcesChanged(),
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
    challenges,
  };
}

/**
 * Returns a port that was bound and immediately released, so a server that refuses to
 * start cannot accidentally collide with a real listener.
 * verified: https://nodejs.org/api/net.html#netserverlistenport-host-backlog-callback
 */
/**
 * Hands out a port that was free at the moment it was probed.
 *
 * This is inherently racy: the probe is closed before the caller binds, so a parallel
 * test file can take the port in between. Across a full `vitest run` with many suites
 * that window was hit often enough to fail a `beforeAll` and skip whole files.
 *
 * At minimum, never hand the SAME port to two callers in this process: when the OS is
 * free to re-assign a recently released port, that reuse is what turns an unrelated
 * flake into a confusing EADDRINUSE somewhere else.
 */
const handedOut = new Set<number>();

export async function unusedPort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const address = probe.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    if (!handedOut.has(port)) {
      handedOut.add(port);
      return port;
    }
  }
  // The OS kept re-assigning a port this process already owns; take the last one anyway
  // rather than failing the caller outright.
  return handedOut.size;
}