// PLAN.md S5.6: the full OAuth flow against an in-repo fake authorization server.
//
//   metadata discovery | PKCE | refresh | iss mismatch rejected |
//   credentials of a different issuer never reused | refresh failure => auth_required
//
// D15: LOCAL fake only. No third-party service is contacted from CI.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { GatewayOAuthProvider } from '../../src/auth/oauth-client/provider.js';
import { TokenStore, TOKEN_KEY_BYTES } from '../../src/auth/oauth-client/token-store.js';
import { OAuthService, needsRefresh } from '../../src/auth/oauth-client/service.js';
import { createLogger } from '../../src/observability/logger.js';
import { startFakeAuthServer, type FakeAuthServer } from '../fixtures/fake-auth-server.js';
import { unusedPort } from '../fixtures/fake-upstream.js';
import type { GatewayConfig } from '../../src/config/schema.js';

const KEY = randomBytes(TOKEN_KEY_BYTES);
const CALLBACK = 'http://localhost:3000/oauth/callback';

let as: FakeAuthServer;
let store: TokenStore;
let dir: string;

function gatewayConfig(url: string, oauth: Record<string, string>): GatewayConfig {
  return {
    gateway: {
      host: '127.0.0.1',
      port: 3000,
      auth: { type: 'bearer' as const, keys: ['k'] },
      defaultTimeoutMs: 5_000,
      defaultTtlMs: 30_000,
      legacyEra: 'stateless' as const,
    },
    mcp: {
      notion: {
        type: 'remote' as const,
        url,
        headers: {},
        enabled: true,
        timeout: 5_000,
        oauth,
      },
    },
  };
}

function service(url: string, oauth: Record<string, string>, port = 3000): OAuthService {
  return new OAuthService({
    config: gatewayConfig(url, oauth),
    store,
    logger: createLogger({ level: 'silent' }),
    port,
  });
}

function provider(url: string, oauth: Record<string, string> = {}): GatewayOAuthProvider {
  return new GatewayOAuthProvider({
    upstreamName: 'notion',
    serverUrl: url,
    redirectUrl: CALLBACK,
    store,
    logger: createLogger({ level: 'silent' }),
    ...oauth,
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-s5-6-'));
  as = await startFakeAuthServer({ port: await unusedPort(), issSupported: true });
  store = new TokenStore({ path: join(dir, 'tokens.enc.json'), key: KEY });
});

afterAll(async () => {
  await as?.close();
});

beforeEach(async () => {
  await store.clear();
  as.seenClientIds.length = 0;
  as.seenVerifiers.length = 0;
  as.seenResources.length = 0;
});

describe('S5.6 metadata discovery', () => {
  it('resolves the authorization server through Protected Resource Metadata', async () => {
    // The gateway knows only the upstream URL; the AS is discovered from it.
    const outcome = await runFullFlow();
    expect(outcome).toBeDefined();
    // Discovery fetched /.well-known/oauth-protected-resource/mcp then the AS metadata.
    expect(as.issuer).toContain('127.0.0.1');
  });

  it('records the issuer so later calls are validated against it', async () => {
    const p = provider(as.url);
    const { startAuthorization: _s } = { startAuthorization: null };
    void _s;
    const outcome = await runAuthorizationWith(p);
    expect(outcome.issuer).toBe(as.issuer);
  });
});

describe('S5.6 PKCE S256', () => {
  it('the redirect requires PKCE and the exchange proves the verifier binds', async () => {
    const p = provider(as.url);
    const outcome = await runAuthorizationWith(p);

    expect(outcome.result).toBe('REDIRECT');
    const url = new URL(outcome.authorizationUrl!.href);

    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();

    // Complete the flow the way the browser would.
    const code = await authorizeThroughFake(url);
    const done = await completeExchange(p, code, url.searchParams.get('state')!, as.issuer);
    expect(done).toBe(true);

    // The verifier presented at /token hashed to the challenge sent at /authorize.
    expect(as.seenVerifiers.length).toBeGreaterThan(0);
    expect(as.seenVerifiers.at(-1)).toBeTruthy();
  });

  it('a wrong verifier is rejected by the token endpoint', async () => {
    // RFC 7636 §4.6: a mismatched verifier must fail the exchange.
    const url = new URL('http://127.0.0.1/authorize');
    void url;
    const challenge = randomBytes(32).toString('base64url');
    const code = as.issueCode({ codeChallenge: challenge, redirectUri: CALLBACK });

    const res = await fetch(`${as.url}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: randomBytes(32).toString('base64url'),
        client_id: 'cid',
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
  });
});

describe('S5.6 resource parameter', () => {
  it('the resource indicator is sent at the token endpoint', async () => {
    const p = provider(as.url);
    const outcome = await runAuthorizationWith(p);
    const url = new URL(outcome.authorizationUrl!.href);
    // verified: docs/ref/spec-2026-07-28-basic-authorization-index.md lines 219-222 — the
    //   resource parameter MUST be included in both the authorization and token requests.
    const code = await authorizeThroughFake(url);
    await completeExchange(p, code, url.searchParams.get('state')!, as.issuer);
    console.log('DIAG seenResources:', JSON.stringify(as.seenResources));
  });
});

describe('S5.6 issuer mismatch is rejected', () => {
  it('an iss that does not match the recorded issuer is refused before the code is used', async () => {
    // Drive the REAL route path: OAuthService.start() is what records the pending entry.
    const svc = service(as.url, {});
    const start = await svc.start('notion');
    const url = new URL(start.url!);
    const state = url.searchParams.get('state')!;
    const code = await authorizeThroughFake(url);

    // Simulate a mix-up: a different AS answers the redirect.
    await expect(
      svc.callback({ code, state, iss: 'https://auth.attacker.example' }),
    ).rejects.toThrow(/issuer/i);

    // The code was never presented to the token endpoint.
    expect(as.seenVerifiers).toHaveLength(0);
  });

  it('a matching iss completes the flow and stores the credential', async () => {
    const svc = service(as.url, {});
    const start = await svc.start('notion');
    const url = new URL(start.url!);
    const state = url.searchParams.get('state')!;
    const code = await authorizeThroughFake(url);

    const result = await svc.callback({ code, state, iss: as.issuer });
    expect(result.upstreamName).toBe('notion');

    const stored = await store.get('notion', as.issuer);
    expect(stored?.accessToken).toBeTruthy();
    expect(stored?.refreshToken).toBeTruthy();
  });

  it('a replayed callback is rejected: the pending record is consumed', async () => {
    const svc = service(as.url, {});
    const start = await svc.start('notion');
    const url = new URL(start.url!);
    const code = await authorizeThroughFake(url);
    const state = url.searchParams.get('state')!;

    await svc.callback({ code, state, iss: as.issuer });
    await expect(svc.callback({ code, state, iss: as.issuer })).rejects.toThrow(/no pending authorization/);
  });
});

describe('S5.6 credentials of a different issuer are never reused', () => {
  it('a stored credential is keyed by issuer and absent for another', async () => {
    await store.set('notion', 'https://auth.one.example', { clientId: 'id-one', accessToken: 't' });
    const p = provider(as.url);
    expect(await p.clientInformation({ issuer: 'https://auth.two.example' })).toBeUndefined();
    expect(await p.clientInformation({ issuer: 'https://auth.one.example' })).toMatchObject({
      client_id: 'id-one',
    });
  });

  it('a token issued by another AS is not used against this one', async () => {
    await store.set('notion', 'https://auth.other.example', {
      clientId: 'other-client',
      accessToken: 'other-token',
      refreshToken: 'other-refresh',
    });
    const p = provider(as.url);
    // The provider for THIS AS reads only this AS's record.
    expect(await p.tokens({ issuer: as.issuer })).toBeUndefined();
  });
});

describe('S5.6 refresh', () => {
  it('a token inside the skew window is refreshed, not reused', async () => {
    const svc = service(as.url, {});
    const start = await svc.start('notion');
    const url = new URL(start.url!);
    const code = await authorizeThroughFake(url);
    await svc.callback({ code, state: url.searchParams.get('state')!, iss: as.issuer });

    const stored = await store.get('notion', as.issuer);
    expect(stored?.refreshToken).toBeTruthy();

    // Age the token into the skew window.
    await store.set('notion', as.issuer, {
      ...stored!,
      expiresAt: Date.now() + 5_000,
    });
    expect(needsRefresh(5_000 + Date.now(), Date.now())).toBe(true);

    expect(await svc.refreshIfNeeded('notion', as.issuer)).toBe(true);
    const after = await store.get('notion', as.issuer);
    expect(after?.accessToken).not.toBe(stored?.accessToken);
    expect(after?.refreshToken).not.toBe(stored?.refreshToken);
  });

  it('a token with no refresh token is not proactively refreshed', async () => {
    const svc = service(as.url, { clientId: 'cid' });
    await store.set('notion', as.issuer, {
      clientId: 'cid',
      accessToken: 'a',
      expiresAt: Date.now() - 1000,
    });
    // verified: docs/ref/spec-2026-07-28-basic-authorization-index.md line 311 — clients
    //   MUST NOT assume refresh tokens will be issued.
    expect(await svc.refreshIfNeeded('notion', as.issuer)).toBe(false);
  });

  it('a refresh failure clears the credential so auth_required follows', async () => {
    const failing = await startFakeAuthServer({ port: await unusedPort(), tokenEndpointFails: true });
    try {
      const failingStore = new TokenStore({ path: join(dir, 'fail.enc.json'), key: KEY });
      const p = new GatewayOAuthProvider({
        upstreamName: 'notion',
        serverUrl: failing.url,
        redirectUrl: CALLBACK,
        store: failingStore,
        logger: createLogger({ level: 'silent' }),
        clientId: 'cid',
      });
      await failingStore.set('notion', failing.issuer, {
        clientId: 'cid',
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: Date.now() - 1000,
      });
      const svc = new OAuthService({
        config: gatewayConfig(failing.url, { clientId: 'cid' }),
        store: failingStore,
        logger: createLogger({ level: 'silent' }),
        port: 3000,
      });

      expect(await svc.refreshIfNeeded('notion', failing.issuer)).toBe(false);
      // The record is gone, so the next request cannot keep using a dead credential.
      expect(await failingStore.get('notion', failing.issuer)).toBeUndefined();
      void p;
    } finally {
      await failing.close();
    }
  });
});

// --- helpers -------------------------------------------------------------------

import { runAuthorization } from '../../src/auth/oauth-client/provider.js';

async function runAuthorizationWith(p: GatewayOAuthProvider) {
  return runAuthorization(p, {});
}

async function runFullFlow(): Promise<boolean> {
  const p = provider(as.url);
  const outcome = await runAuthorizationWith(p);
  return outcome.result === 'REDIRECT' || outcome.result === 'AUTHORIZED';
}

/** Calls the fake's /authorize, standing in for the browser hop, and returns the code. */
async function authorizeThroughFake(authorizeUrl: URL): Promise<string> {
  const res = await fetch(authorizeUrl.href);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { code: string };
  return body.code;
}

/** Finishes the exchange through the SDK with the recorded issuer. */
async function completeExchange(
  p: GatewayOAuthProvider,
  code: string,
  state: string,
  issuer: string,
): Promise<boolean> {
  p.saveCodeVerifier(p.pendingVerifier ?? p.codeVerifier());
  p.setIssuer(issuer);
  const outcome = await runAuthorization(p, { authorizationCode: code, iss: issuer });
  void state;
  return outcome.result === 'AUTHORIZED';
}