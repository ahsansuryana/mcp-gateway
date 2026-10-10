// PLAN.md Sprint 3 E2E: resources, prompts, subscriptions, MRTR, progress and
// cancellation, plus the acceptance requirement that the capability advertisement from
// `server/discover` matches reality.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { startFakeUpstream, unusedPort, type FakeUpstream } from '../fixtures/fake-upstream.js';
import { startGateway, type RunningGateway } from '../../src/index.js';

const API_KEY = 'S3-CANARY-KEY-0123456789';

let alpha: FakeUpstream;
let beta: FakeUpstream;
let deadUrl: string;
let gateway: RunningGateway;
let configPath: string;
let client: Client;

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const observed: { requestState: unknown; aborted: number } = { requestState: undefined, aborted: 0 };

async function connect(pin = true): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${gateway.port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
  });
  const c = new Client(
    { name: 's3-e2e', version: '0.0.0' },
    {
      versionNegotiation: pin ? { mode: { pin: '2026-07-28' } } : { mode: 'auto' },
      defaultCacheTtlMs: 0,
      // Required before `elicitation/create` may be registered (S3.5's MRTR round trip).
      capabilities: { elicitation: {} },
    },
  );
  await c.connect(transport);
  return c;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-s3-'));

  alpha = await startFakeUpstream({
    port: await unusedPort(),
    kind: 'fast',
    prefix: 'alpha',
    ttlMs: 30_000,
    withResources: true,
    withMrtr: true,
    withProgress: true,
    onMrtrComplete: (s) => {
      observed.requestState = s;
    },
    onAborted: () => {
      observed.aborted += 1;
    },
  });
  beta = await startFakeUpstream({
    port: await unusedPort(),
    kind: 'fast',
    prefix: 'beta',
    ttlMs: 10_000,
    withResources: true,
  });
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
          alpha: { type: 'remote', url: alpha.url, timeout: 3_000 },
          beta: { type: 'remote', url: beta.url, timeout: 3_000 },
          dead: { type: 'remote', url: deadUrl, timeout: 1_000 },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  gateway = await startGateway({ configPath, logLevel: 'silent' });
  client = await connect();
}, 60_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await gateway?.stop();
  await alpha?.close();
  await beta?.close();
}, 30_000);

describe('Sprint 3 acceptance: capability advertisement matches reality', () => {
  it('advertises tools with listChanged, plus resources and prompts, and never templates', () => {
    const caps = client.getServerCapabilities();
    expect(caps?.tools?.listChanged).toBe(true);
    expect(caps?.resources).toBeDefined();
    expect(caps?.prompts).toBeDefined();
    // S3.1: resource templates are a non-goal and MUST NOT be advertised.
    const serialised = JSON.stringify(caps ?? {});
    expect(serialised).not.toContain('templates');
  });

  it('every advertised capability answers without Method not found', async () => {
    await expect(client.listTools({}, { cacheMode: 'bypass' })).resolves.toBeDefined();
    await expect(client.listResources({}, { cacheMode: 'bypass' })).resolves.toBeDefined();
    await expect(client.listPrompts({}, { cacheMode: 'bypass' })).resolves.toBeDefined();
  });
});

describe('S3.1 resources', () => {
  it('rewrites every URI as gw://<server>/<encoded original>', async () => {
    const list = await client.listResources({}, { cacheMode: 'bypass' });
    const uris = list.resources.map((r) => r.uri);
    expect(uris.length).toBeGreaterThan(0);
    for (const uri of uris) expect(uri.startsWith('gw://')).toBe(true);
    expect(uris).toContain('gw://alpha/custom%3Areadme');
  });

  it('keeps two upstreams publishing the SAME original URI apart', async () => {
    const list = await client.listResources({}, { cacheMode: 'bypass' });
    const uris = list.resources.map((r) => r.uri);
    expect(uris).toContain('gw://alpha/file%3A%2F%2F%2Fshared%2Fconfig.json');
    expect(uris).toContain('gw://beta/file%3A%2F%2F%2Fshared%2Fconfig.json');
  });

  it('routes resources/read back to the right upstream and returns its body', async () => {
    const read = await client.readResource({ uri: 'gw://beta/custom%3Areadme' });
    const contents = read.contents as { text?: string }[];
    expect(contents[0]?.text).toContain('beta');
  });

  it('returns -32602 for an unknown server in the URI (S3.1)', async () => {
    await expect(client.readResource({ uri: 'gw://nosuch/custom%3Areadme' })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('returns -32602 for a URI that was never rewritten', async () => {
    await expect(client.readResource({ uri: 'file:///shared/config.json' })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('returns -32602 for a malformed gw:// URI', async () => {
    await expect(client.readResource({ uri: 'gw://onlyserver' })).rejects.toMatchObject({ code: -32602 });
  });
});

describe('S3.3 cache fields on resources and prompts', () => {
  it('resources/list carries ttlMs (the minimum) and cacheScope "private"', async () => {
    const raw = await rawMethod('resources/list', {});
    expect(raw.ttlMs).toBe(10_000); // min(alpha 30000, beta 10000)
    expect(raw.cacheScope).toBe('private');
  });

  it('resources/read carries ttlMs and cacheScope "private"', async () => {
    const raw = await rawMethod('resources/read', { uri: 'gw://alpha/custom%3Areadme' });
    expect(typeof raw.ttlMs).toBe('number');
    expect(raw.cacheScope).toBe('private');
  });

  it('prompts/list carries ttlMs and cacheScope "private"', async () => {
    const raw = await rawMethod('prompts/list', {});
    expect(raw.ttlMs).toBe(10_000);
    expect(raw.cacheScope).toBe('private');
  });
});

describe('S3.2 prompts', () => {
  it('namespaces prompt names with D4', async () => {
    const list = await client.listPrompts({}, { cacheMode: 'bypass' });
    const names = list.prompts.map((p) => p.name);
    expect(names).toContain('alpha_review');
    expect(names).toContain('beta_review');
  });

  it('routes prompts/get back to the right upstream', async () => {
    const got = await client.getPrompt({ name: 'beta_review', arguments: { target: 'PR-1' } });
    const message = got.messages[0]?.content as { text?: string };
    expect(message?.text).toContain('beta');
    expect(message?.text).toContain('PR-1');
  });

  it('returns -32602 for an unknown namespaced prompt', async () => {
    await expect(client.getPrompt({ name: 'nosuch_prompt' })).rejects.toMatchObject({ code: -32602 });
  });
});

describe('S3.4 subscriptions/listen', () => {
  it('emits toolsListChanged downstream when an upstream publishes it', async () => {
    // verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
    //   (Client.listen(filter, options) -> McpSubscription with an `honoredFilter`)
    const received: string[] = [];
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      received.push('tools/list_changed');
    });

    const sub = await client.listen({ toolsListChanged: true }, { timeout: 5_000 });
    expect(sub.honoredFilter).toEqual({ toolsListChanged: true });

    // The upstream publishes on ITS own bus; the gateway must relay it.
    alpha.publishToolsChanged();
    await waitFor(() => received.length > 0, 8_000);

    expect(received.length).toBeGreaterThan(0);
    await sub.close();
    expect(await sub.closed).toBe('local');
  }, 30_000);

  it('emits toolsListChanged when an upstream status transition changes the merged list', async () => {
    const received: string[] = [];
    const listener = new Client(
      { name: 's3-listener', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } }, defaultCacheTtlMs: 0 },
    );
    await listener.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
      }),
    );
    listener.setNotificationHandler('notifications/tools/list_changed', () => {
      received.push('changed');
    });
    const sub = await listener.listen({ toolsListChanged: true }, { timeout: 5_000 });
    try {
      // Stopping every upstream empties the merged list: a real, observable change.
      // The stop is held until the notification arrives; restarting immediately would let
      // the 250 ms debounce window close over an unchanged list, which by the implemented
      // policy is deliberately NOT a notification.
      await gateway.manager.stop();
      await waitFor(() => received.length > 0, 15_000);
      expect(received.length).toBeGreaterThan(0);

      // The list really did empty out.
      const whileStopped = await listener.listTools({}, { cacheMode: 'bypass' });
      expect(whileStopped.tools).toEqual([]);

      // ...and comes back, which is a second notification.
      const before = received.length;
      await gateway.manager.start();
      await waitFor(() => received.length > before, 15_000);
      expect(received.length).toBeGreaterThan(before);

      const afterRestart = await listener.listTools({}, { cacheMode: 'bypass' });
      expect(afterRestart.tools.length).toBeGreaterThan(0);
    } finally {
      await sub.close();
      await listener.close();
    }
  }, 45_000);
});

describe('S3.5 MRTR passthrough', () => {
  it('forwards input_required unchanged and completes on the retry, keeping no state', async () => {
    const seen: string[] = [];
    const sub = client;

    // The client auto-fulfils the embedded elicitation; the gateway must relay the
    // input_required result AND re-attach inputResponses + requestState on the retry.
    sub.setRequestHandler('elicitation/create', (request) => {
      const message = (request.params as { message?: unknown }).message;
      seen.push(typeof message === 'string' ? message : '');
      return Promise.resolve({ action: 'accept', content: { proceed: true } });
    });

    const result = await sub.callTool({ name: 'alpha_needs_input', arguments: {} }, { timeout: 15_000 });
    const text = (result.content[0] as { text: string }).text;

    expect(seen).toEqual(['alpha: proceed?']);
    expect(text).toContain('mrtr-complete');
    // Q-MRTRPROXY: the upstream-minted requestState must arrive byte-exact.
    expect(text).toContain('state=alpha-minted-state');
    expect(observed.requestState).toBe('alpha-minted-state');

    // The gateway holds no MRTR state: a fresh call starts a fresh round.
    seen.length = 0;
    await sub.callTool({ name: 'alpha_needs_input', arguments: {} }, { timeout: 15_000 });
    expect(seen).toEqual(['alpha: proceed?']);
  });
});

describe('S3.6 progress, trace context and cancellation', () => {
  it('re-emits upstream progress on the downstream response stream', async () => {
    const progress: unknown[] = [];
    await client.callTool(
      { name: 'alpha_counted', arguments: { steps: 3 } },
      { timeout: 15_000, onprogress: (p) => progress.push(p) },
    );
    expect(progress.length).toBe(3);
    const last = progress[2] as { progress: number; total: number };
    expect(last.progress).toBe(3);
    expect(last.total).toBe(3);
  });

  it('passes traceparent through to the upstream', async () => {
    const result = await client.callTool(
      { name: 'alpha_counted', arguments: { steps: 1 }, _meta: { traceparent: TRACEPARENT } },
      { timeout: 15_000 },
    );
    expect((result.content[0] as { text: string }).text).toContain(TRACEPARENT);
  });

  it('aborts the upstream call when the downstream request is cancelled', async () => {
    const before = observed.aborted;
    const controller = new AbortController();
    const pending = client.callTool({ name: 'alpha_hang', arguments: {} }, { signal: controller.signal, timeout: 20_000 });
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toBeDefined();
    await waitFor(() => observed.aborted > before, 8_000);
    expect(observed.aborted).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 's3-raw', version: '0.0.0' },
  'io.modelcontextprotocol/clientCapabilities': { elicitation: {} },
};

/** Raw POST so the cache fields on the wire can be asserted directly (S3.3 / D11). */
async function rawMethod(
  method: string,
  params: Record<string, unknown>,
): Promise<{ ttlMs: number; cacheScope: string } & Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${API_KEY}`,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(typeof params['uri'] === 'string' ? { 'mcp-name': params['uri'] } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: ENVELOPE } }),
  });
  const body = (await res.json()) as { result: { ttlMs: number; cacheScope: string } & Record<string, unknown> };
  return body.result;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}