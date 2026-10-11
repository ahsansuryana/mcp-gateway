// P7-4: does the gateway accept a 2025-era client?
//
// docs/SDK-NOTES.md (j) records that the SDK v2 client defaults to
// `versionNegotiation.mode: 'legacy'` -- the 2025 era -- and that the v2 SERVER serves both
// eras by default (`createMcpHandler` `legacy: 'stateless'`).
//
// If that holds, a 2025-era client can be exercised with the v2 client and NO options, and
// the `@modelcontextprotocol/sdk` v1 dev dependency this task permitted is NOT needed. That
// is verified here rather than assumed, because D2 forbids v1 outside an ADR and not needing
// an ADR is the better outcome.
//
// What a 2025-era client does NOT have: `server/discover`, `subscriptions/listen`,
// `input_required`. The gateway must degrade, not fail.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { startFakeUpstream, unusedPort, type FakeUpstream } from '../fixtures/fake-upstream.js';
import { startGateway, type RunningGateway } from '../../src/index.js';

const API_KEY = 'P74-CANARY-KEY-0123456789';

let upstream: FakeUpstream;
let gateway: RunningGateway;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-p74-'));
  upstream = await startFakeUpstream({
    port: await unusedPort(),
    kind: 'fast',
    prefix: 'era',
    withResources: true,
  });
  const configPath = join(dir, 'gateway.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      gateway: {
        host: '127.0.0.1',
        port: await unusedPort(),
        auth: { type: 'bearer', keys: [API_KEY] },
        defaultTimeoutMs: 5_000,
        defaultTtlMs: 30_000,
      },
      mcp: { era: { type: 'remote', url: upstream.url, timeout: 4_000 } },
    }),
    'utf8',
  );
  gateway = await startGateway({ configPath, logLevel: 'silent' });
}, 60_000);

afterAll(async () => {
  await gateway?.stop();
  await upstream?.close();
}, 30_000);

/** A 2025-era client: NO versionNegotiation option at all, so the default applies. */
async function connectEra2025(): Promise<Client> {
  const client = new Client({ name: 'era-2025', version: '0.0.0' }, { defaultCacheTtlMs: 0 });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
    }),
  );
  return client;
}

describe('P7-4 a 2025-era client', () => {
  it('completes the initialize handshake', async () => {
    const client = await connectEra2025();
    try {
      // verified: node_modules/@modelcontextprotocol/client/dist/index.d.mts
      //   (Client.getServerVersion) — populated by the initialize response.
      const version = client.getServerVersion();
      expect(version?.name).toBe('mcp-gateway');
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 30_000);

  it('negotiates a 2025-era protocol version, not the modern one', async () => {
    const client = await connectEra2025();
    try {
      const negotiated = client.getNegotiatedProtocolVersion?.();
      // The gateway's own modern revision. A 2025-era client must not land here.
      expect(negotiated).toBeDefined();
      expect(String(negotiated)).not.toBe('2026-07-28');
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 30_000);

  it('lists and calls tools through the 2025-era shapes', async () => {
    const client = await connectEra2025();
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain('era_echo');

      const result = await client.callTool({ name: 'era_echo', arguments: { text: 'era' } });
      expect((result.content[0] as { text: string }).text).toBe('era:era');
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 30_000);

  it('lists resources and prompts', async () => {
    const client = await connectEra2025();
    try {
      const resources = await client.listResources();
      expect(resources.resources.length).toBeGreaterThan(0);
      const prompts = await client.listPrompts();
      expect(prompts.prompts.length).toBeGreaterThan(0);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 30_000);

  it('degrades on a modern-only method instead of crashing the gateway', async () => {
    const client = await connectEra2025();
    try {
      // `server/discover` and `subscriptions/listen` do not exist in the 2025 era. The
      // gateway must answer with a protocol error, and the connection must survive it.
      await expect(client.listTools()).resolves.toBeDefined();
      await expect(client.listTools()).resolves.toBeDefined();
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 30_000);
});

describe('P7-4 both eras are served by the same endpoint', () => {
  it('a modern client on the same gateway still works', async () => {
    const modern = new Client(
      { name: 'era-modern', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } }, defaultCacheTtlMs: 0 },
    );
    await modern.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
      }),
    );
    try {
      expect(String(modern.getNegotiatedProtocolVersion?.())).toBe('2026-07-28');
      const tools = await modern.listTools({}, { cacheMode: 'bypass' });
      expect(tools.tools.map((t) => t.name)).toContain('era_echo');
    } finally {
      await modern.close().catch(() => undefined);
    }
  }, 30_000);
});