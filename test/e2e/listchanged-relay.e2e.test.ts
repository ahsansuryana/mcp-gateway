// B-24 integrity pass (mandatory before Sprint 5).
//
// Two defects from the Sprint 3 follow-up, both about the gateway claiming more than it
// can actually deliver:
//
//   (a) `#honored` was a flat union that was only ever ADDED to. When a downstream
//       subscription's upstream stream closed, the contribution stayed forever, so the
//       gateway kept advertising `listChanged` for events it would never receive.
//   (b) Only `notifications/tools/list_changed` was ever published, while the advertised
//       capabilities derived from the union also claimed prompts and resources. A
//       downstream client was told `prompts.listChanged: true` and then never told when a
//       prompt changed.
//
// verified: docs/ref/spec-2026-07-28-basic-patterns-subscriptions.md
//   - "Acknowledgment": "The `notifications` field in the acknowledgment reflects the
//      subset the server agreed to honor."
//   - "Cancellation": a subscription ends when the client cancels it, the server tears it
//      down, or the underlying transport closes.
//   - "Opening a Stream": "The server MUST NOT send notification types the client has not
//      explicitly requested."

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { startFakeUpstream, unusedPort, type FakeUpstream } from '../fixtures/fake-upstream.js';
import { startGateway, type RunningGateway } from '../../src/index.js';
import { DEBOUNCE_MS } from '../../src/server/subscriptions.js';

const API_KEY = 'B24B-CANARY-KEY-0123456789';

let alpha: FakeUpstream;
let beta: FakeUpstream;
let gateway: RunningGateway;
let client: Client;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-b24b-'));

  // Honours ALL THREE requested list-changed types.
  alpha = await startFakeUpstream({
    port: await unusedPort(),
    kind: 'fast',
    prefix: 'alpha',
    withResources: true,
  });
  // Declares `tools.listChanged: false`, so the server drops that flag from the ack and
  // `alpha` is the ONLY contributor of toolsListChanged in the union.
  beta = await startFakeUpstream({
    port: await unusedPort(),
    kind: 'fast',
    prefix: 'beta',
    withResources: true,
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
        defaultTimeoutMs: 5_000,
        defaultTtlMs: 30_000,
      },
      mcp: {
        alpha: { type: 'remote', url: alpha.url, timeout: 5_000 },
        beta: { type: 'remote', url: beta.url, timeout: 5_000 },
      },
    }),
    'utf8',
  );

  gateway = await startGateway({ configPath, logLevel: 'silent' });

  client = new Client(
    { name: 'b24b-client', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } }, defaultCacheTtlMs: 0 },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
    }),
  );
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await gateway?.stop();
  await alpha?.close();
  await beta?.close();
}, 30_000);

/** Capabilities are per-connection; a fresh client sees the CURRENT advertisement. */
async function advertisedCapabilities(): Promise<Record<string, unknown>> {
  const fresh = new Client(
    { name: 'b24b-probe', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } }, defaultCacheTtlMs: 0 },
  );
  try {
    await fresh.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
      }),
    );
    return fresh.getServerCapabilities() ?? {};
  } finally {
    await fresh.close().catch(() => undefined);
  }
}

describe('B-24(b): prompts and resources are actually relayed', () => {
  it('an upstream prompts/list_changed reaches the downstream as prompts/list_changed', async () => {
    const received: string[] = [];
    // verified: node_modules/@modelcontextprotocol/client/dist/index.d.mts
    //   (Client.setNotificationHandler(method, handler))
    client.setNotificationHandler('notifications/prompts/list_changed', () => {
      received.push('prompts');
    });
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      received.push('tools');
    });
    client.setNotificationHandler('notifications/resources/list_changed', () => {
      received.push('resources');
    });

    const sub = await client.listen({ promptsListChanged: true }, { timeout: 5_000 });
    try {
      expect(sub.honoredFilter).toHaveProperty('promptsListChanged');
      alpha.publishPromptsChanged();
      await waitFor(() => received.length > 0, 15_000);
    } finally {
      await sub.close();
    }

    // The decisive assertion: a PROMPT change must be relayed as a prompt notification.
    // The old code routed every upstream push through notifyToolsChanged(), so this
    // received ['tools'] instead.
    expect(received).toEqual(['prompts']);
  }, 30_000);

  it('an upstream resources/list_changed reaches the downstream as resources/list_changed', async () => {
    const received: string[] = [];
    client.setNotificationHandler('notifications/resources/list_changed', () => {
      received.push('resources');
    });
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      received.push('tools');
    });

    const sub = await client.listen({ resourcesListChanged: true }, { timeout: 5_000 });
    try {
      expect(sub.honoredFilter).toHaveProperty('resourcesListChanged');
      alpha.publishResourcesChanged();
      await waitFor(() => received.length > 0, 15_000);
    } finally {
      await sub.close();
    }
    expect(received).toEqual(['resources']);
  }, 30_000);

  it('a tools change is still relayed as a tools notification', async () => {
    const received: string[] = [];
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      received.push('tools');
    });

    const sub = await client.listen({ toolsListChanged: true }, { timeout: 5_000 });
    try {
      alpha.publishToolsChanged();
      await waitFor(() => received.length > 0, 15_000);
    } finally {
      await sub.close();
    }
    expect(received).toEqual(['tools']);
  }, 30_000);
});

describe('B-24(a): a closed subscription stops contributing', () => {
  it('before: both upstreams are open, so the union advertises all three', async () => {
    const caps = await advertisedCapabilities();
    expect((caps['tools'] as { listChanged?: boolean } | undefined)?.listChanged).toBe(true);
    expect((caps['prompts'] as { listChanged?: boolean } | undefined)?.listChanged).toBe(true);
    expect((caps['resources'] as { listChanged?: boolean } | undefined)?.listChanged).toBe(true);
  });

  it('after alpha\'s subscription ends, toolsListChanged is withdrawn', async () => {
    // `beta` is the only upstream that honoured toolsListChanged. Closing alpha's stream
    // must not leave alpha's toolsListChanged behind, which is exactly what the old
    // add-only union did.
    await gateway.manager.get('alpha')?.stop();

    // Give the fanout's debounce window time to observe the close and recompute.
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 8));

    const caps = await advertisedCapabilities();
    // alpha is gone; beta still honours prompts and resources.
    expect((caps['prompts'] as { listChanged?: boolean } | undefined)?.listChanged).toBe(true);
    expect((caps['resources'] as { listChanged?: boolean } | undefined)?.listChanged).toBe(true);
    // ...but tools is now unsupportable and must be advertised as such.
    expect((caps['tools'] as { listChanged?: boolean } | undefined)?.listChanged).toBe(false);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition was not met in time');
}