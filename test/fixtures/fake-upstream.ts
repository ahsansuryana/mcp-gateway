// Fake upstream MCP servers used by the Sprint 2 E2E suite (PLAN.md D15).
// Three flavours, exactly as S2.6 requires:
//   - `fast`      responds immediately with a few tools
//   - `slow`      sleeps longer than the gateway's per-upstream timeout
//   - `failing`   refuses to start (its endpoint is not listening)
//
// Verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts

import http from 'node:http';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

export type FakeKind = 'fast' | 'slow';

export interface FakeUpstream {
  url: string;
  kind: FakeKind;
  close: () => Promise<void>;
}

export interface FakeOptions {
  port: number;
  kind: FakeKind;
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
        capabilities: { tools: { listChanged: false } },
        cacheHints:
          options.ttlMs === undefined
            ? {}
            : { 'tools/list': { ttlMs: options.ttlMs, cacheScope: 'private' } },
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