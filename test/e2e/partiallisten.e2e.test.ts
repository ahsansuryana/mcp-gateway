// Sprint 3 follow-up (B-24) / D17: a PARTIAL `subscriptions/listen` acknowledgement.
//
// An upstream that does not advertise a `listChanged` capability answers the listen request
// with a narrower honoured filter. The gateway must treat that as a partial subscription,
// warn, and must NOT claim downstream more than it can actually relay.
//
// verified: docs/ref/spec-2026-07-28-basic-patterns-subscriptions.md ("Acknowledgment":
//   "The `notifications` field in the acknowledgment reflects the subset the server agreed
//    to honor"; "The client SHOULD check the acknowledged filter against what it requested")

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { startFakeUpstream, unusedPort, type FakeUpstream } from '../fixtures/fake-upstream.js';
import { startGateway, type RunningGateway } from '../../src/index.js';

const API_KEY = 'B24-CANARY-KEY-0123456789';

let full: FakeUpstream;
let partial: FakeUpstream;
let silent: FakeUpstream;
let gateway: RunningGateway;
let silentGateway: RunningGateway;
let client: Client;
let silentClient: Client;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-b24-'));

  // Honours every requested list-changed type.
  full = await startFakeUpstream({ port: await unusedPort(), kind: 'fast', prefix: 'full', withResources: true });
  // Declares tools.listChanged: false, so the server drops that flag from the ack.
  partial = await startFakeUpstream({
    port: await unusedPort(),
    kind: 'fast',
    prefix: 'partial',
    withResources: true,
    withoutListChanged: true,
  });
  // Declares no listChanged capability and registers no prompts/resources, so it honours
  // NOTHING at all — the strongest form of a partial subscription.
  silent = await startFakeUpstream({
    port: await unusedPort(),
    kind: 'fast',
    prefix: 'silent',
    withoutListChanged: true,
  });

  const configPath = join(dir, 'gateway.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      gateway: {
        host: '127.0.0.1',
        port: await unusedPort(),
        auth: { type: 'bearer', keys: [API_KEY] },
        defaultTimeoutMs: 2_000,
        defaultTtlMs: 30_000,
      },
      mcp: {
        full: { type: 'remote', url: full.url, timeout: 3_000 },
        partial: { type: 'remote', url: partial.url, timeout: 3_000 },
      },
    }),
    'utf8',
  );

  gateway = await startGateway({ configPath, logLevel: 'silent' });
  client = await connectTo(gateway.port, 'b24');

  // A second gateway whose ONLY upstream honours nothing.
  const silentConfigPath = join(dir, 'gateway-silent.json');
  writeFileSync(
    silentConfigPath,
    JSON.stringify({
      gateway: {
        host: '127.0.0.1',
        port: await unusedPort(),
        auth: { type: 'bearer', keys: [API_KEY] },
        defaultTimeoutMs: 2_000,
        defaultTtlMs: 30_000,
      },
      mcp: { silent: { type: 'remote', url: silent.url, timeout: 3_000 } },
    }),
    'utf8',
  );
  silentGateway = await startGateway({ configPath: silentConfigPath, logLevel: 'silent' });
  silentClient = await connectTo(silentGateway.port, 'b24-silent');
}, 60_000);

async function connectTo(port: number, name: string): Promise<Client> {
  const c = new Client(
    { name, version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } }, defaultCacheTtlMs: 0 },
  );
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
    }),
  );
  return c;
}

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await silentClient?.close().catch(() => undefined);
  await gateway?.stop();
  await silentGateway?.stop();
  await full?.close();
  await partial?.close();
  await silent?.close();
}, 30_000);

describe('B-24 partial subscriptions/listen acknowledgement', () => {
  it('a partially-honouring upstream is detected: its ack is narrower than the request', async () => {
    // Proven directly against the fake, independently of the gateway.
    const direct = new Client(
      { name: 'b24-direct', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } }, defaultCacheTtlMs: 0 },
    );
    await direct.connect(new StreamableHTTPClientTransport(new URL(partial.url)));
    try {
      const sub = await direct.listen(
        { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true },
        { timeout: 5_000 },
      );
      // `toolsListChanged` was requested but the server does not advertise it.
      expect(sub.honoredFilter).not.toHaveProperty('toolsListChanged');
      await sub.close();
    } finally {
      await direct.close();
    }
  });

  it('the gateway still advertises listChanged because ONE upstream honours it', () => {
    // The union across open subscriptions is what the gateway advertises, so the presence
    // of a partial upstream must not remove the capability.
    const caps = client.getServerCapabilities();
    expect(caps?.tools?.listChanged).toBe(true);
  });

  it('the downstream ack is the UNION of what the open upstreams honoured', async () => {
    const sub = await client.listen(
      { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true },
      { timeout: 5_000 },
    );
    try {
      // `full` honours all three; `partial` declined only toolsListChanged. The union is all
      // three, so the gateway may advertise all three and the ack carries all three — nothing
      // is claimed that no upstream honoured.
      expect(sub.honoredFilter).toEqual({
        toolsListChanged: true,
        promptsListChanged: true,
        resourcesListChanged: true,
      });
    } finally {
      await sub.close();
    }
  });

  it('when NO upstream honours anything, the gateway advertises nothing and the ack is empty', async () => {
    const caps = silentClient.getServerCapabilities();
    expect(caps?.tools?.listChanged).toBe(false);

    const sub = await silentClient.listen(
      { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true },
      { timeout: 5_000 },
    );
    try {
      // The decisive assertion for B-24: a downstream client is told the truth.
      expect(sub.honoredFilter).toEqual({});
    } finally {
      await sub.close();
    }
  });

  it('a push from the fully-honouring upstream is still relayed', async () => {
    const received: string[] = [];
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      received.push('changed');
    });
    const sub = await client.listen({ toolsListChanged: true }, { timeout: 5_000 });
    try {
      full.publishToolsChanged();
      await waitFor(() => received.length > 0, 8_000);
      expect(received.length).toBeGreaterThan(0);
    } finally {
      await sub.close();
    }
  }, 30_000);

  it('a push from the partially-honouring upstream is NOT delivered downstream', async () => {
    // It cannot be: the server never agreed to send it. Asserting the negative proves the
    // gateway does not manufacture events its upstreams did not promise.
    const received: string[] = [];
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      received.push('changed');
    });
    const sub = await client.listen({ toolsListChanged: true }, { timeout: 5_000 });
    try {
      partial.publishToolsChanged();
      await new Promise((r) => setTimeout(r, 1_500));
      expect(received).toEqual([]);
    } finally {
      await sub.close();
    }
  }, 30_000);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}