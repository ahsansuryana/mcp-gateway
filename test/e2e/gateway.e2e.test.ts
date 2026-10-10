// PLAN.md S2.6: end-to-end suite. Three fake upstreams (fast, slow > timeout,
// always-failing) plus the official SDK client as the downstream.
//
// verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
//   (Client, StreamableHTTPClientTransport, ClientOptions.versionNegotiation)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { startFakeUpstream, unusedPort, type FakeUpstream } from '../fixtures/fake-upstream.js';
import { startGateway, type RunningGateway } from '../../src/index.js';

const API_KEY = 'E2E-CANARY-KEY-0123456789';
const UPSTREAM_TOKEN = 'E2E-CANARY-UPSTREAM-0123456789';

let fast: FakeUpstream;
let slow: FakeUpstream;
let deadUrl: string;
let gateway: RunningGateway;
let configPath: string;
let client: Client;

async function connect(bearer: string | undefined, pin = true): Promise<Client> {
  // verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
  //   (StreamableHTTPClientTransportOptions.requestInit; ClientOptions.versionNegotiation)
  const url = new URL(`http://127.0.0.1:${gateway.port}/mcp`);
  const transport =
    bearer === undefined
      ? new StreamableHTTPClientTransport(url)
      : new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
        });

  const c = new Client(
    { name: 'e2e-client', version: '0.0.0' },
    {
      versionNegotiation: pin ? { mode: { pin: '2026-07-28' } } : { mode: 'auto' },
      defaultCacheTtlMs: 0,
    },
  );
  await c.connect(transport);
  return c;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-e2e-'));

  fast = await startFakeUpstream({ port: await unusedPort(), kind: 'fast', prefix: 'fast', ttlMs: 25_000 });
  slow = await startFakeUpstream({ port: await unusedPort(), kind: 'slow', prefix: 'slow', ttlMs: 5_000 });
  deadUrl = `http://127.0.0.1:${await unusedPort()}/mcp`;

  configPath = join(dir, 'gateway.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        gateway: {
          host: '127.0.0.1',
          port: await unusedPort(),
          auth: { type: 'bearer', keys: [API_KEY] },
          defaultTimeoutMs: 2_000,
          defaultTtlMs: 30_000,
        },
        mcp: {
          fast: { type: 'remote', url: fast.url, headers: { Authorization: `Bearer ${UPSTREAM_TOKEN}` }, timeout: 2_000 },
          slow: { type: 'remote', url: slow.url, timeout: 1_000 },
          dead: { type: 'remote', url: deadUrl, timeout: 1_000 },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  gateway = await startGateway({ configPath, logLevel: 'silent' });
  client = await connect(API_KEY);
}, 60_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await gateway?.stop();
  await fast?.close();
  await slow?.close();
});

describe('S2.6 aggregated tools/list', () => {
  it('merges the healthy upstreams and excludes the failing one (D8)', async () => {
    const tools = await client.listTools({}, { cacheMode: 'bypass' });
    const names = tools.tools.map((t) => t.name);

    expect(names).toContain('fast_echo');
    expect(names).toContain('slow_echo');
    expect(names.filter((n) => n.startsWith('dead_'))).toEqual([]);
  });

  it('is sorted ascending by namespaced name (PLAN.md §5)', async () => {
    const tools = await client.listTools({}, { cacheMode: 'bypass' });
    const names = tools.tools.map((t) => t.name);
    expect([...names].sort()).toEqual(names);
  });

  it('carries ttlMs and cacheScope "private" (D11)', async () => {
    // D11: the minimum of the contributing upstreams' ttlMs. The dead upstream never
    // contributes; slow advertises 5000 and fast advertises 25000.
    const raw = await rawList(API_KEY);
    expect(raw.ttlMs).toBe(5_000);
    expect(raw.cacheScope).toBe('private');
  });
});

describe('S2.6 tools/call routing', () => {
  it('routes a call to the right upstream', async () => {
    const result = await client.callTool({ name: 'fast_echo', arguments: { text: 'hi' } });
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toBe('fast:hi');
  });

  it('routes the same tool name on a different upstream independently', async () => {
    const result = await client.callTool({ name: 'slow_echo', arguments: { text: 'yo' } });
    expect((result.content[0] as { text: string }).text).toBe('slow:yo');
  });

  it('round-trips deeply nested JSON byte-for-byte', async () => {
    const payload = { a: 1, b: [1, 2, { c: 'ünïcødé 🎉', d: null }], e: { f: { g: true } } };
    const result = await client.callTool({ name: 'fast_deep', arguments: { payload } });
    expect(result.structuredContent).toEqual(payload);
  });

  it('forwards an upstream tool-level failure unchanged (D12)', async () => {
    const result = await client.callTool({ name: 'fast_always_fails', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('tool-level failure');
  });

  it('returns an isError tool result when the upstream times out (D12)', async () => {
    // `slow` is configured with timeout 1000ms (PLAN.md §6 minimum); sleeping 4000ms must
    // not block the caller.
    const result = await client.callTool({ name: 'slow_sleep', arguments: { ms: 4_000 } });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Upstream 'slow'");
  });

  it('returns an isError tool result for an upstream that never started (D12)', async () => {
    const result = await client.callTool({ name: 'dead_echo', arguments: { text: 'x' } });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Upstream 'dead'");
  });

  it('answers an unknown namespaced tool with a JSON-RPC error, not a tool result', async () => {
    await expect(client.callTool({ name: 'nope_missing', arguments: {} })).rejects.toThrow();
    await expect(client.callTool({ name: 'nosuchserver_tool', arguments: {} })).rejects.toThrow();
    await expect(client.callTool({ name: 'no_underscore', arguments: {} })).rejects.toThrow();
  });

  it('does not let one slow upstream delay the merged list', async () => {
    const started = Date.now();
    await client.listTools({}, { cacheMode: 'bypass' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('S2.6 inbound auth (D9)', () => {
  it('rejects an unauthenticated POST /mcp with 401 and WWW-Authenticate', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('rejects a wrong key', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer WRONG-KEY-0123456789',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('serves GET /healthz unauthenticated with only {ok:true}', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('requires auth on GET /status and reports the failing upstream (D8)', async () => {
    const unauth = await fetch(`http://127.0.0.1:${gateway.port}/status`);
    expect(unauth.status).toBe(401);

    const res = await fetch(`http://127.0.0.1:${gateway.port}/status`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gateway: Record<string, unknown>;
      upstreams: { name: string; status: { state: string; lastError?: string } }[];
    };
    expect(body.gateway['configuredUpstreams']).toBe(3);
    expect(body.gateway['inboundAuthKeys']).toBe(1);
    expect(body.gateway['legacyEra']).toBe('stateless');
    const dead = body.upstreams.find((u) => u.name === 'dead');
    expect(dead).toBeDefined();
    expect(['error', 'failed', 'starting']).toContain(dead?.status.state);
    expect(dead?.status.state).not.toBe('ready');
  });

  it('never leaks a secret through /status', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/status`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const text = await res.text();
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(UPSTREAM_TOKEN);
  });

  it('rejects a disallowed Origin with 403', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${API_KEY}`,
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(403);
  });

  it('answers 413 for a body over 1 MiB (PLAN.md S2.5)', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(2 * 1024 * 1024) } }),
    });
    expect(res.status).toBe(413);
  });
});

describe('S2.6 protocol era', () => {
  it('is reachable by a default (2025-era) client because legacyEra is stateless', async () => {
    const legacy = await connect(API_KEY, false);
    try {
      const tools = await legacy.listTools({}, { cacheMode: 'bypass' });
      expect(tools.tools.map((t) => t.name)).toContain('fast_echo');
    } finally {
      await legacy.close();
    }
  });

  it('answers server/discover on the modern era', () => {
    // verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
    //   (Client.getDiscoverResult() is synchronous)
    const discover = client.getDiscoverResult();
    expect(discover?.supportedVersions).toContain('2026-07-28');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'e2e-raw', version: '0.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** Raw POST so the cache fields on the wire can be asserted directly (D11). */
async function rawList(bearer: string): Promise<{ ttlMs: number; cacheScope: string; tools: unknown[] }> {
  const res = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/list',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: ENVELOPE } }),
  });
  const body = (await res.json()) as { result: { ttlMs: number; cacheScope: string; tools: unknown[] } };
  return body.result;
}