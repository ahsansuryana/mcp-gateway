// PLAN.md S5.4: the two OAuth routes, `auth_required`, hidden tools and the /status URL.
//
// What is asserted here is the gateway's OWN policy, which needs no authorization server:
//   - both routes sit behind the gateway bearer key;
//   - a 401 from an OAuth upstream moves it to `auth_required`;
//   - an `auth_required` upstream's tools disappear from `tools/list`;
//   - `/status` exposes the local start path and never a token;
//   - the request path does NOT hammer an upstream waiting for a human.
//
// D15: LOCAL fakes only.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { startFakeUpstream, unusedPort, type FakeUpstream } from '../fixtures/fake-upstream.js';
import { startGateway, type RunningGateway } from '../../src/index.js';
import { TOKEN_KEY_BYTES } from '../../src/auth/oauth-client/token-store.js';

const API_KEY = 'S54-CANARY-KEY-0123456789';
const CLIENT_SECRET = 'S54-CLIENT-SECRET-CANARY-abcdef';
/** The one bearer token the protected fake accepts; the gateway never holds it in v1. */
const GOOD_TOKEN = 'S54-GOOD-TOKEN-CANARY-xyz789';

let protectedUpstream: FakeUpstream;
let plain: FakeUpstream;
let gateway: RunningGateway;
let client: Client;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-s54-'));
  // A real protected resource: answers 401 with a WWW-Authenticate challenge until it sees
  // the exact bearer token. Deterministic, unlike a fake that just "pretends" to 401.
  protectedUpstream = await startFakeUpstream({
    port: await unusedPort(),
    kind: 'fast',
    prefix: 'protected',
    requireAuth: true,
    requireAuthToken: GOOD_TOKEN,
  });
  plain = await startFakeUpstream({ port: await unusedPort(), kind: 'fast', prefix: 'plain' });

  const configPath = join(dir, 'gateway.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      gateway: {
        host: '127.0.0.1',
        port: await unusedPort(),
        auth: { type: 'bearer', keys: [API_KEY] },
        defaultTimeoutMs: 3_000,
        defaultTtlMs: 30_000,
      },
      mcp: {
        // `oauth` makes the gateway treat a 401 as `auth_required` rather than `error`.
        protected: {
          type: 'remote',
          url: protectedUpstream.url,
          timeout: 2_000,
          oauth: { clientId: 'static-client-id', clientSecret: CLIENT_SECRET },
        },
        plain: { type: 'remote', url: plain.url, timeout: 2_000 },
      },
    }),
    'utf8',
  );

  process.env['GATEWAY_TOKEN_KEY'] = randomBytes(TOKEN_KEY_BYTES).toString('base64');
  // An isolated store path: parallel suites each run with their own GATEWAY_TOKEN_KEY,
  // so sharing one file would make one suite's key fail to decrypt another's store.
  gateway = await startGateway({ configPath, logLevel: 'silent', tokenStorePath: join(dir, 'tokens.enc.json') });

  client = new Client(
    { name: 's54-client', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } }, defaultCacheTtlMs: 0 },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
    }),
  );
});

afterAll(async () => {
  delete process.env['GATEWAY_TOKEN_KEY'];
  await client?.close().catch(() => undefined);
  await gateway?.stop();
  await protectedUpstream?.close();
  await plain?.close();
}, 30_000);

async function getStatus(): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${gateway.port}/status`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  return (await res.json()) as Record<string, unknown>;
}

describe('S5.4 OAuth routes are behind the gateway bearer key', () => {
  it('GET /admin/oauth/:name/start without a key is 401', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/admin/oauth/protected/start`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('GET /admin/oauth/:name/start for an unknown upstream is 404', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/admin/oauth/nope/start`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      redirect: 'manual',
    });
    expect(res.status).toBe(404);
  });
});

describe('S5.4 auth_required', () => {
  it('an OAuth upstream answering 401 becomes auth_required, not error', () => {
    const report = gateway.manager.reports().find((r) => r.name === 'protected');
    expect(report?.status.state).toBe('auth_required');
  });

  it('the upstream really did challenge with WWW-Authenticate', () => {
    // Proves the state came from a genuine 401, not from a forced transition.
    expect(protectedUpstream.challenges.length).toBeGreaterThan(0);
    expect(protectedUpstream.challenges[0]).toContain('resource_metadata=');
  });

  it('/status exposes a local start path and never a hostname or token', async () => {
    const body = JSON.stringify(await getStatus());
    expect(body).toContain('/admin/oauth/protected/start');
    // Q4 is open: no public hostname may be invented.
    expect(body).not.toContain('mcp.example.com');
    expect(body).not.toContain('auth.example.com');
    expect(body).not.toContain(CLIENT_SECRET);
    expect(body).not.toContain('static-client-id');
  });

  it('a plain upstream exposes no OAuth start URL', async () => {
    const reports = (await getStatus())['upstreams'] as { name: string; oauthStartUrl?: string }[];
    expect(reports.find((r) => r.name === 'plain')?.oauthStartUrl).toBeUndefined();
  });

  it('tools of an auth_required upstream are absent from tools/list', async () => {
    const tools = await client.listTools({}, { cacheMode: 'bypass' });
    expect(tools.tools.map((t) => t.name)).not.toContain('protected_echo');
  });

  it('a healthy upstream keeps its tools while another is unusable', async () => {
    const tools = await client.listTools({}, { cacheMode: 'bypass' });
    expect(tools.tools.map((t) => t.name)).toContain('plain_echo');
  });
});

describe('S5.4 the request path does not retry auth_required', () => {
  it('repeated requests against an auth_required upstream do not re-dial it', async () => {
    expect(gateway.manager.get('protected')?.status().state).toBe('auth_required');

    let transitions = 0;
    const off = gateway.manager.onStatusChange(() => {
      transitions += 1;
    });
    for (let i = 0; i < 5; i += 1) {
      await client.listTools({}, { cacheMode: 'bypass' });
    }
    off();
    // The manager must not re-emit a status change on every request: that was the retry
    // storm #ensureStarted's auth_required guard prevents.
    expect(transitions).toBe(0);
  });
});