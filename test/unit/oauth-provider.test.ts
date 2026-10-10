// PLAN.md S5.3: the OAuthClientProvider the gateway hands to the SDK.
//
// Scope of these tests is the policy the gateway owns — which credential wins, what is
// persisted under which key, what `invalidateCredentials` removes — not the protocol steps,
// which are the SDK's. The end-to-end flow against an authorization server is S5.6.
//
// D15: no network.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { GatewayOAuthProvider } from '../../src/auth/oauth-client/provider.js';
import { REFRESH_SKEW_MS, needsRefresh } from '../../src/auth/oauth-client/service.js';
import { TokenStore, TOKEN_KEY_BYTES } from '../../src/auth/oauth-client/token-store.js';
import { createLogger } from '../../src/observability/logger.js';

const KEY = randomBytes(TOKEN_KEY_BYTES);
const ISSUER = 'https://auth.example.com';

function makeStore(): TokenStore {
  return new TokenStore({
    path: join(mkdtempSync(join(tmpdir(), 'mcp-gateway-s5-3-')), 'tokens.enc.json'),
    key: KEY,
  });
}

function makeProvider(
  store: TokenStore,
  overrides: Partial<{
    clientId: string;
    clientSecret: string;
    scope: string;
    clientMetadataUrl: string;
  }> = {},
): GatewayOAuthProvider {
  return new GatewayOAuthProvider({
    upstreamName: 'notion',
    serverUrl: 'https://mcp.example.com/mcp',
    redirectUrl: 'http://localhost:3000/oauth/callback',
    store,
    logger: createLogger({ level: 'silent' }),
    ...overrides,
  });
}

describe('S5.3 client metadata', () => {
  it('declares a localhost callback and the native application type', () => {
    const provider = makeProvider(makeStore());
    const metadata = provider.clientMetadata;
    expect(metadata.redirect_uris).toEqual(['http://localhost:3000/oauth/callback']);
    // verified: docs/ref/spec-2026-07-28-basic-authorization-client-registration.md
    //   lines 167-169 — a locally-hosted web application accessed via localhost is native.
    expect(metadata.application_type).toBe('native');
    expect(metadata.grant_types).toContain('refresh_token');
  });

  it('omits scope when the config does not set one', () => {
    expect(makeProvider(makeStore()).clientMetadata.scope).toBeUndefined();
    expect(makeProvider(makeStore(), { scope: 'files:read' }).clientMetadata.scope).toBe('files:read');
  });
});

describe('S5.3 registration order', () => {
  it('a config clientId is pre-registration and wins over the store', async () => {
    const store = makeStore();
    await store.set('notion', ISSUER, { clientId: 'stored-id', accessToken: 't' });

    const provider = makeProvider(store, { clientId: 'config-id', clientSecret: 'config-secret' });
    expect(provider.hasPreRegisteredClientId).toBe(true);
    expect(await provider.clientInformation({ issuer: ISSUER })).toEqual({
      client_id: 'config-id',
      client_secret: 'config-secret',
    });
  });

  it('without a config clientId the stored issuer-specific record is used', async () => {
    const store = makeStore();
    await store.set('notion', ISSUER, { clientId: 'stored-id', clientSecret: 'stored-secret', accessToken: 'stored-token' });

    const provider = makeProvider(store);
    expect(provider.hasPreRegisteredClientId).toBe(false);
    expect(await provider.clientInformation({ issuer: ISSUER })).toEqual({
      client_id: 'stored-id',
      client_secret: 'stored-secret',
    });
  });

  it('a credential issued by a DIFFERENT issuer is never returned', async () => {
    const store = makeStore();
    await store.set('notion', ISSUER, { clientId: 'stored-id', accessToken: 't' });

    const provider = makeProvider(store);
    // verified: docs/ref/spec-2026-07-28-basic-authorization-client-registration.md
    //   lines 187-193 — clients MUST NOT reuse credentials from a different AS.
    expect(await provider.clientInformation({ issuer: 'https://auth.attacker.example' })).toBeUndefined();
  });
});

describe('S5.3 token persistence', () => {
  it('saveTokens persists under the issuer and tokens() reads it back', async () => {
    const store = makeStore();
    const provider = makeProvider(store);
    provider.setIssuer(ISSUER);

    await provider.saveTokens(
      { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 3600 },
      { issuer: ISSUER },
    );

    const stored = await store.get('notion', ISSUER);
    expect(stored?.accessToken).toBe('access-1');
    expect(stored?.refreshToken).toBe('refresh-1');
    expect(stored?.expiresAt).toBeGreaterThan(Date.now());

    expect(await provider.tokens({ issuer: ISSUER })).toMatchObject({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
    });
  });

  it('the per-request bearer read returns the most recent set, never undefined', async () => {
    const store = makeStore();
    const provider = makeProvider(store);
    provider.setIssuer(ISSUER);
    await provider.saveTokens({ access_token: 'access-1', token_type: 'Bearer' }, { issuer: ISSUER });

    // verified: node_modules/@modelcontextprotocol/client/dist/index.d.mts
    //   (OAuthClientProvider.tokens — with ctx === undefined, do not return undefined)
    expect(await provider.tokens()).toMatchObject({ access_token: 'access-1' });
  });

  it('tokens are scoped per issuer', async () => {
    const store = makeStore();
    const provider = makeProvider(store);
    await provider.saveTokens({ access_token: 'one', token_type: 'Bearer' }, { issuer: 'https://a.example' });
    await provider.saveTokens({ access_token: 'two', token_type: 'Bearer' }, { issuer: 'https://b.example' });

    expect((await provider.tokens({ issuer: 'https://a.example' }))?.access_token).toBe('one');
    expect((await provider.tokens({ issuer: 'https://b.example' }))?.access_token).toBe('two');
    expect(await provider.tokens({ issuer: 'https://c.example' })).toBeUndefined();
  });

  it('expires_in is converted into an absolute expiry', async () => {
    const store = makeStore();
    const now = 1_700_000_000_000;
    const fixed = new GatewayOAuthProvider({
      upstreamName: 'notion',
      serverUrl: 'https://mcp.example.com/mcp',
      redirectUrl: 'http://localhost:3000/oauth/callback',
      store,
      logger: createLogger({ level: 'silent' }),
      now: () => now,
    });
    fixed.setIssuer(ISSUER);
    await fixed.saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 60 }, { issuer: ISSUER });
    expect((await store.get('notion', ISSUER))?.expiresAt).toBe(now + 60_000);
  });
});

describe('S5.3 invalidation', () => {
  it('"tokens" removes the stored credential so a fresh authorization is forced', async () => {
    const store = makeStore();
    const provider = makeProvider(store);
    provider.setIssuer(ISSUER);
    await provider.saveTokens({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer' }, { issuer: ISSUER });

    await provider.invalidateCredentials('tokens');
    expect(await store.get('notion', ISSUER)).toBeUndefined();
    expect(await provider.tokens()).toBeUndefined();
  });

  it('"client" clears the client id but KEEPS a still-valid access token', async () => {
    const store = makeStore();
    const provider = makeProvider(store);
    provider.setIssuer(ISSUER);
    await provider.saveTokens({ access_token: 'a', token_type: 'Bearer' }, { issuer: ISSUER });

    await provider.invalidateCredentials('client');
    expect((await store.get('notion', ISSUER))?.clientId).toBe('');
    expect(await provider.tokens({ issuer: ISSUER })).toMatchObject({ access_token: 'a' });
  });

  it('"verifier" only drops the in-flight PKCE verifier', async () => {
    const store = makeStore();
    const provider = makeProvider(store);
    provider.setIssuer(ISSUER);
    provider.saveCodeVerifier('verifier-value');
    await provider.saveTokens({ access_token: 'a', token_type: 'Bearer' }, { issuer: ISSUER });

    await provider.invalidateCredentials('verifier');
    expect(provider.pendingVerifier).toBeUndefined();
    expect(() => provider.codeVerifier()).toThrow();
    expect(await store.get('notion', ISSUER)).toBeDefined();
  });
});

describe('S5.3 PKCE and state seams', () => {
  it('the verifier must be saved before it can be read', () => {
    const provider = makeProvider(makeStore());
    expect(() => provider.codeVerifier()).toThrow(/code verifier/);
    provider.saveCodeVerifier('v-123');
    expect(provider.codeVerifier()).toBe('v-123');
  });

  it('state is stable within one flow and unpredictable across flows', () => {
    const store = makeStore();
    const first = makeProvider(store).state();
    expect(makeProvider(store).state()).not.toBe(first);
    const p = makeProvider(store);
    expect(p.state()).toBe(p.state());
  });
});

describe('S5.3 redirect capture', () => {
  it('redirectToAuthorization captures the URL instead of navigating', () => {
    const provider = makeProvider(makeStore());
    expect(provider.authorizationUrl).toBeUndefined();
    provider.redirectToAuthorization(new URL('https://auth.example.com/authorize?x=1'));
    expect(provider.authorizationUrl?.href).toBe('https://auth.example.com/authorize?x=1');
  });
});
describe('S5.5 refresh window', () => {
  it('needsRefresh is true inside the 60s skew and false outside it', () => {
    const now = 1_700_000_000_000;
    // PLAN.md S5.5: refresh BEFORE expiry with a 60s skew.
    expect(needsRefresh(now + 30_000, now)).toBe(true);
    expect(needsRefresh(now + 59_000, now)).toBe(true);
    expect(needsRefresh(now + 60_001, now)).toBe(false);
    expect(needsRefresh(now + 3_600_000, now)).toBe(false);
  });

  it('a token with no reported expiry is never proactively refreshed', () => {
    // An AS that omits expires_in gives us no basis for a refresh decision; refreshing
    // anyway would burn the refresh token on every request.
    expect(needsRefresh(undefined, Date.now())).toBe(false);
  });

  it('REFRESH_SKEW_MS is the 60 seconds PLAN.md specifies', () => {
    expect(REFRESH_SKEW_MS).toBe(60_000);
  });
});

describe('S5.5 restoreTokens', () => {
  it('seeds the token set the SDK refresh branch needs', () => {
    const store = makeStore();
    const provider = makeProvider(store);
    provider.restoreTokens({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      tokenType: 'Bearer',
      scope: 'files:read',
      expiresAt: Date.now() + 10_000,
    });
    // The transport's per-request bearer read must see it without a store round trip.
    return expect(provider.tokens()).resolves.toMatchObject({
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      scope: 'files:read',
    });
  });

  it('a remaining lifetime of zero or less yields expires_in 0, never a negative value', () => {
    const provider = makeProvider(makeStore());
    provider.restoreTokens({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() - 60_000,
    });
    return expect(provider.tokens()).resolves.toMatchObject({ expires_in: 0 });
  });
});
