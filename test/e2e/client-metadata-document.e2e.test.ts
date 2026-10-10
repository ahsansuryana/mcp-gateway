// P6-1: the gateway's Client ID Metadata Document.
//
// Two states must be distinguishable:
//   - `publicUrl` set   -> the document is served, and `client_id` equals the URL it was
//                          fetched from (a spec MUST);
//   - `publicUrl` unset -> the route does not exist, and choosing the CIMD registration
//                          path fails with an error naming `gateway.publicUrl`.
//
// D15: LOCAL only.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { startGateway, type RunningGateway } from '../../src/index.js';
import { OAuthService } from '../../src/auth/oauth-client/service.js';
import {
  GatewayOAuthProvider,
  MissingPublicUrlError,
  UnsupportedRegistrationError,
} from '../../src/auth/oauth-client/provider.js';
import { TokenStore, TOKEN_KEY_BYTES } from '../../src/auth/oauth-client/token-store.js';
import { createLogger } from '../../src/observability/logger.js';
import { unusedPort } from '../fixtures/fake-upstream.js';
import { startFakeAuthServer, type FakeAuthServer } from '../fixtures/fake-auth-server.js';

const API_KEY = 'P61-CANARY-KEY-0123456789';
/** A hostname that only exists in test configuration; never a production hostname. */
const TEST_PUBLIC_URL_HOST = 'gateway.test.invalid';

let withPublic: RunningGateway;
let withoutPublic: RunningGateway;

async function boot(publicUrl?: string): Promise<RunningGateway> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-p61-'));
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
        // Only present when this boot was asked for one.
        ...(publicUrl === undefined ? {} : { publicUrl }),
      },
      // An OAuth upstream is what makes the CIMD branch reachable at all.
      mcp: {
        remote: {
          type: 'remote',
          url: 'http://127.0.0.1:1/mcp',
          timeout: 1_000,
          oauth: {},
        },
      },
    }),
    'utf8',
  );
  process.env['GATEWAY_TOKEN_KEY'] = randomBytes(TOKEN_KEY_BYTES).toString('base64');
  return startGateway({ configPath, logLevel: 'silent', tokenStorePath: join(dir, 'tokens.enc.json') });
}

beforeAll(async () => {
  withPublic = await boot(`https://${TEST_PUBLIC_URL_HOST}`);
  withoutPublic = await boot(undefined);
}, 60_000);

afterAll(async () => {
  delete process.env['GATEWAY_TOKEN_KEY'];
  await withPublic?.stop();
  await withoutPublic?.stop();
});

describe('P6-1 the document exists only when publicUrl is set', () => {
  it('is served when publicUrl is configured', async () => {
    const res = await fetch(
      `http://127.0.0.1:${withPublic.port}${OAuthService.CLIENT_METADATA_PATH}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('does NOT exist when publicUrl is unset', async () => {
    const res = await fetch(
      `http://127.0.0.1:${withoutPublic.port}${OAuthService.CLIENT_METADATA_PATH}`,
    );
    expect(res.status).toBe(404);
  });

  it('is served WITHOUT the gateway bearer key', async () => {
    // An authorization server fetches it before any user credential exists.
    // verified: docs/ref/spec-2026-07-28-basic-authorization-client-registration.md
    //   lines 96-97 — "Server->>Metadata: GET https://app.example.com/oauth/metadata.json"
    const res = await fetch(
      `http://127.0.0.1:${withPublic.port}${OAuthService.CLIENT_METADATA_PATH}`,
    );
    expect(res.status).toBe(200);
  });
});

describe('P6-1 the document satisfies the spec MUSTs', () => {
  it('includes client_id, client_name and redirect_uris at minimum', async () => {
    // verified: docs/ref/spec-2026-07-28-basic-authorization-client-registration.md
    //   line 42 — "The metadata document MUST include at least the following properties:
    //   client_id, client_name, redirect_uris"
    const res = await fetch(
      `http://127.0.0.1:${withPublic.port}${OAuthService.CLIENT_METADATA_PATH}`,
    );
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc['client_id']).toBeTruthy();
    expect(doc['client_name']).toBeTruthy();
    expect(Array.isArray(doc['redirect_uris'])).toBe(true);
    expect((doc['redirect_uris'] as string[]).length).toBeGreaterThan(0);
  });

  it('client_id is https even though the test transport is plain http', async () => {
    // The document must be fetched at publicUrl over https in production; deriving
    // client_id from the live request would make it `http://127.0.0.1:<port>/...` here.
    const res = await fetch(
      `http://127.0.0.1:${withPublic.port}${OAuthService.CLIENT_METADATA_PATH}`,
    );
    const doc = (await res.json()) as { client_id: string };
    expect(doc.client_id.startsWith('https://')).toBe(true);
  });

  it('client_id is NOT derived from the request Host header', async () => {
    // A caller must not be able to rewrite the identity the AS is about to trust.
    const res = await fetch(
      `http://127.0.0.1:${withPublic.port}${OAuthService.CLIENT_METADATA_PATH}`,
      { headers: { host: 'attacker.example' } },
    );
    const doc = (await res.json()) as { client_id: string };
    expect(doc.client_id).not.toContain('attacker.example');
    expect(doc.client_id).toBe(`https://${TEST_PUBLIC_URL_HOST}${OAuthService.CLIENT_METADATA_PATH}`);
  });

  it('client_id is an https URL containing a path component', async () => {
    // verified: same page line 41 — "The client_id URL MUST use the 'https' scheme and
    //   contain a path component, e.g. https://example.com/client.json"
    const res = await fetch(
      `http://127.0.0.1:${withPublic.port}${OAuthService.CLIENT_METADATA_PATH}`,
    );
    const doc = (await res.json()) as { client_id: string };
    const url = new URL(doc.client_id);
    expect(url.protocol).toBe('https:');
    expect(url.pathname).not.toBe('/');
    expect(url.pathname).toBe(OAuthService.CLIENT_METADATA_PATH);
  });

  it('client_id equals the URL the document is PUBLISHED at', async () => {
    // verified: same page line 43 — "Clients MUST ensure the client_id value in the metadata
    //   matches the document URL exactly". In a real deployment the AS fetches
    //   `${publicUrl}${CLIENT_METADATA_PATH}`, so the two are the same string.
    const res = await fetch(
      `http://127.0.0.1:${withPublic.port}${OAuthService.CLIENT_METADATA_PATH}`,
    );
    const doc = (await res.json()) as { client_id: string };
    expect(doc.client_id).toBe(`https://${TEST_PUBLIC_URL_HOST}${OAuthService.CLIENT_METADATA_PATH}`);
  });

  it('redirect_uris is the gateway callback on localhost', async () => {
    const res = await fetch(
      `http://127.0.0.1:${withPublic.port}${OAuthService.CLIENT_METADATA_PATH}`,
    );
    const doc = (await res.json()) as { redirect_uris: string[] };
    expect(doc.redirect_uris[0]).toBe(
      `http://127.0.0.1:${withPublic.port}/oauth/callback`,
    );
  });

  it('the document leaks nothing', async () => {
    const body = await (
      await fetch(`http://127.0.0.1:${withPublic.port}${OAuthService.CLIENT_METADATA_PATH}`)
    ).text();
    expect(body).not.toContain(API_KEY);
    expect(body).not.toContain('secret');
  });
});

describe('P6-1 the CIMD registration path fails clearly without publicUrl', () => {
  function provider(publicUrl?: string): GatewayOAuthProvider {
    const store = new TokenStore({
      path: join(mkdtempSync(join(tmpdir(), 'mcp-gateway-p61b-')), 't.enc.json'),
      key: randomBytes(TOKEN_KEY_BYTES),
    });
    return new GatewayOAuthProvider({
      upstreamName: 'remote',
      serverUrl: 'http://127.0.0.1:1/mcp',
      redirectUrl: 'http://localhost:3000/oauth/callback',
      store,
      logger: createLogger({ level: 'silent' }),
      ...(publicUrl === undefined ? {} : { clientMetadataUrl: `${publicUrl}/.well-known/oauth-client.json` }),
    });
  }

  let cimdAS: FakeAuthServer;
  let plainAS: FakeAuthServer;

  beforeAll(async () => {
    cimdAS = await startFakeAuthServer({ port: await unusedPort(), cimd: true });
    plainAS = await startFakeAuthServer({ port: await unusedPort(), noDynamicRegistration: true });
  }, 30_000);

  afterAll(async () => {
    await cimdAS?.close();
    await plainAS?.close();
  });

  /** The fake AS serves its own PRM pointing at itself, so its base URL is the serverUrl. */
  function providerFor(as: FakeAuthServer, publicUrl?: string): GatewayOAuthProvider {
    const store = new TokenStore({
      path: join(mkdtempSync(join(tmpdir(), 'mcp-gateway-p61c-')), 't.enc.json'),
      key: randomBytes(TOKEN_KEY_BYTES),
    });
    return new GatewayOAuthProvider({
      upstreamName: 'remote',
      serverUrl: as.url,
      redirectUrl: 'http://localhost:3000/oauth/callback',
      store,
      logger: createLogger({ level: 'silent' }),
      ...(publicUrl === undefined ? {} : { clientMetadataUrl: `${publicUrl}/.well-known/oauth-client.json` }),
    });
  }

  it('an AS advertising CIMD fails naming gateway.publicUrl', async () => {
    const { runAuthorization } = await import('../../src/auth/oauth-client/provider.js');
    await expect(runAuthorization(providerFor(cimdAS, undefined), {})).rejects.toThrow(
      /gateway\.publicUrl/,
    );
  });

  it('the error names the config key and the missing path, and no value', async () => {
    const { runAuthorization } = await import('../../src/auth/oauth-client/provider.js');
    let message = '';
    try {
      await runAuthorization(providerFor(cimdAS, undefined), {});
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('gateway.publicUrl');
    expect(message).toContain('/.well-known/oauth-client.json');
    expect(message).toContain('Client ID Metadata Documents');
  });

  it('the same AS succeeds once publicUrl is set', async () => {
    const { runAuthorization } = await import('../../src/auth/oauth-client/provider.js');
    const p = providerFor(cimdAS, `https://${TEST_PUBLIC_URL_HOST}`);
    const outcome = await runAuthorization(p, {});
    expect(outcome.method).toBe('cimd');
    // The provider now publishes its identity to the AS.
    expect(p.clientMetadataUrl).toBe(
      `https://${TEST_PUBLIC_URL_HOST}${OAuthService.CLIENT_METADATA_PATH}`,
    );
  });

  it('an AS offering neither CIMD nor DCR fails with an actionable message', async () => {
    const { runAuthorization } = await import('../../src/auth/oauth-client/provider.js');
    await expect(
      runAuthorization(providerFor(plainAS, `https://${TEST_PUBLIC_URL_HOST}`), {}),
    ).rejects.toThrow(/oauth\.clientId/);
  });

  it('with publicUrl set the resolvable CIMD URL is the published one', () => {
    const withUrl = provider(`https://${TEST_PUBLIC_URL_HOST}`);
    expect(withUrl.resolvableClientMetadataUrl).toBe(
      `https://${TEST_PUBLIC_URL_HOST}/.well-known/oauth-client.json`,
    );
  });

  it('the error classes are distinguishable by name for the route layer', () => {
    expect(new UnsupportedRegistrationError('x').name).toBe('UnsupportedRegistrationError');
    expect(new MissingPublicUrlError('x').name).toBe('MissingPublicUrlError');
  });
});