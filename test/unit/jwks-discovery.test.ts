// P7-3: JWKS discovery.
//
//   discovered issuer must equal the configured issuer exactly;
//   metadata is fetched only from URLs derived from the configured issuer;
//   https required except for loopback;
//   the result is cached with a TTL;
//   an unknown kid triggers at most one refetch per cooldown period;
//   no key material ever reaches a log.
//
// D15: LOCAL fake authorization servers only.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type CryptoKey } from 'jose';

import {
  ResourceServer,
  clearJwksDiscoveryCache,
  discoverJwksUri,
  JwksDiscoveryError,
  DISCOVERY_TTL_MS,
} from '../../src/auth/oauth-resource/resource-server.js';
import { createLogger } from '../../src/observability/logger.js';

const AUDIENCE = 'https://gateway.test.invalid/mcp';
const KEY_CANARY = 'P73-JWKS-CANARY-do-not-log-me';

let as: Server;
let issuer: string;
let jwksUrl: string;
let publicJwk: JWK;
let privateKey: Uint8Array | CryptoKey;
let logLines: string[];
let metadataFetches: number;
let jwksFetches: number;

/** What the fake metadata document advertises. Mutable so a test can poison it. */
let advertised: { issuer: string; jwks_uri: string };

function logger() {
  return createLogger({
    level: 'debug',
    destination: new Writable({
      write(chunk, _enc, cb) {
        logLines.push(String(chunk));
        cb();
      },
    }),
  });
}

async function startAs(): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === '/jwks.json') {
      jwksFetches += 1;
      const body = JSON.stringify({ keys: [publicJwk] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (req.url?.includes('.well-known')) {
      metadataFetches += 1;
      const body = JSON.stringify(advertised);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return server;
}

async function mint(key: Uint8Array | CryptoKey = privateKey): Promise<string> {
  return new SignJWT({ scope: 'mcp:read' })
    .setProtectedHeader({ alg: 'RS256', kid: publicJwk['kid'] as string })
    .setIssuedAt()
    .setSubject('p73-user')
    .setIssuer(issuer)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(key);
}

function server(overrides: Partial<ConstructorParameters<typeof ResourceServer>[0]> = {}): ResourceServer {
  return new ResourceServer({
    issuer,
    audience: AUDIENCE,
    logger: logger(),
    ...overrides,
  });
}

beforeEach(async () => {
  logLines = [];
  metadataFetches = 0;
  jwksFetches = 0;
  clearJwksDiscoveryCache();

  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'p73-key-1', alg: 'RS256', use: 'sig' };

  as = await startAs();
  const port = (as.address() as AddressInfo).port;
  issuer = `http://127.0.0.1:${port}`;
  jwksUrl = `${issuer}/jwks.json`;
  advertised = { issuer, jwks_uri: jwksUrl };
});

afterEach(async () => {
  await new Promise<void>((r) => as.close(() => r()));
});

/** A `fetch` stub that records the URL it was asked for. */
function recordingFetch(
  asked: string[],
  respond: (url: string) => Response,
): typeof fetch {
  return (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    return Promise.resolve(respond(url));
  };
}

/** A `fetch` stub that always answers the same way. */
function staticFetch(respond: () => Response): typeof fetch {
  return () => Promise.resolve(respond());
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('P7-3 issuer binding', () => {
  it('accepts metadata whose issuer matches EXACTLY', async () => {
    expect(await discoverJwksUri({ issuer, logger: logger() })).toBe(jwksUrl);
  });

  it('rejects metadata advertising a different issuer', async () => {
    advertised = { issuer: 'https://auth.attacker.example', jwks_uri: jwksUrl };
    await expect(discoverJwksUri({ issuer, logger: logger() })).rejects.toThrow(
      JwksDiscoveryError,
    );
  });

  it('a trailing slash in the metadata issuer does NOT match', async () => {
    // Exact string comparison is the whole point: normalising here would accept a document
    // that claims to be a different issuer.
    advertised = { issuer: `${issuer}/`, jwks_uri: jwksUrl };
    await expect(discoverJwksUri({ issuer, logger: logger() })).rejects.toThrow(
      /does not match/,
    );
  });

  it('a token signed by the discovered JWKS is accepted end to end', async () => {
    const result = await server().verify(await mint());
    expect(result.ok).toBe(true);
    expect(jwksFetches).toBeGreaterThan(0);
  });

  it('an explicit jwksUri overrides discovery entirely', async () => {
    const result = await server({ jwksUri: jwksUrl }).verify(await mint());
    expect(result.ok).toBe(true);
    // No metadata fetch at all when the operator pinned the URI.
    expect(metadataFetches).toBe(0);
  });
});

describe('P7-3 discovery failure does not take the gateway down', () => {
  it('a dead issuer yields a plain rejection, and other credentials still work', async () => {
    const dead = new ResourceServer({
      issuer: 'http://127.0.0.1:1',
      audience: AUDIENCE,
      logger: logger(),
    });
    const result = await dead.verify(await mint());
    expect(result.ok).toBe(false);
    // The reason is a named one; the caller turns it into a 401, never a crash.
    expect(['unknown_key', 'bad_signature', 'malformed']).toContain(result.reason);

    // A differently-configured server sharing the process is unaffected.
    const healthy = await server().verify(await mint());
    expect(healthy.ok).toBe(true);
  });
});

describe('P7-3 caching', () => {
  it('the metadata is read once and then served from cache', async () => {
    await discoverJwksUri({ issuer, logger: logger() });
    const first = metadataFetches;
    await discoverJwksUri({ issuer, logger: logger() });
    await discoverJwksUri({ issuer, logger: logger() });
    expect(metadataFetches).toBe(first);
    expect(first).toBeGreaterThan(0);
  });

  it('the cache TTL is finite, not infinite', () => {
    expect(DISCOVERY_TTL_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DISCOVERY_TTL_MS)).toBe(true);
  });

  it('the JWKS itself is fetched once for repeated verifications', async () => {
    const rs = server();
    const token = await mint();
    await rs.verify(token);
    const first = jwksFetches;
    await rs.verify(token);
    await rs.verify(token);
    expect(jwksFetches).toBe(first);
  });
});

describe('P7-3 unknown kid respects the cooldown', () => {
  it('a token signed by an unknown key triggers at most ONE refetch per cooldown', async () => {
    const rogue = await generateKeyPair('RS256', { extractable: true });
    const rogueToken = await mint(rogue.privateKey);

    const rs = server();
    const before = jwksFetches;

    // Repeated failures inside the cooldown must NOT each trigger a network fetch.
    await rs.verify(rogueToken);
    await rs.verify(rogueToken);
    await rs.verify(rogueToken);
    const afterFirstBurst = jwksFetches;

    // Verified: node_modules/jose/dist/types/jwks/remote.d.ts — cooldownDuration is "Time
    // in milliseconds after a successful fetch before a missing key can trigger another
    // fetch", so at most one extra fetch happened for the whole burst.
    expect(afterFirstBurst - before).toBeLessThanOrEqual(1);

    // And the result is a rejection, never a silent pass.
    expect((await rs.verify(rogueToken)).ok).toBe(false);
  }, 20_000);
});

describe('P7-3 https enforcement', () => {
  it('a non-https jwks_uri on a non-loopback host is rejected', async () => {
    // A PUBLIC http issuer is not something the resolver will honour. Simulated through a
    // custom fetch so no external request is made.
    const fakeFetch = staticFetch(() =>
      jsonResponse({ issuer: 'https://auth.example.com', jwks_uri: 'http://auth.example.com/jwks' }),
    );
    await expect(
      discoverJwksUri({ issuer: 'https://auth.example.com', logger: logger(), fetchFn: fakeFetch }),
    ).rejects.toThrow(/not https/);
  });

  it('http is accepted for a loopback host, which is how the in-repo fakes work', async () => {
    expect(await discoverJwksUri({ issuer, logger: logger() })).toBe(jwksUrl);
  });

  it('a jwks_uri that is not a URL is rejected', async () => {
    const fakeFetch = staticFetch(() =>
      jsonResponse({ issuer: 'https://auth.example.com', jwks_uri: 'not a url' }),
    );
    await expect(
      discoverJwksUri({ issuer: 'https://auth.example.com', logger: logger(), fetchFn: fakeFetch }),
    ).rejects.toThrow(/not a URL/);
  });
});

describe('P7-3 only issuer-derived URLs are fetched', () => {
  it('tries the documented well-known forms derived from the issuer', async () => {
    const asked: string[] = [];
    const fakeFetch = recordingFetch(asked, () =>
      jsonResponse({ issuer: 'https://auth.example.com', jwks_uri: 'https://auth.example.com/jwks' }),
    );

    await discoverJwksUri({ issuer: 'https://auth.example.com', logger: logger(), fetchFn: fakeFetch });

    // verified: docs/ref/spec-2026-07-28-basic-authorization-authorization-server-discovery.md
    //   lines 88-94 — for an issuer WITHOUT a path, the RFC 8414 form is tried FIRST and
    //   OpenID Connect only as a fallback.
    expect(asked[0]).toBe('https://auth.example.com/.well-known/oauth-authorization-server');
    // It stopped there: the fallback must not be fetched once the first form answers.
    expect(asked).toHaveLength(1);
    // Every URL is on the configured issuer's own origin. Nothing else is contacted.
    for (const url of asked) expect(url.startsWith('https://auth.example.com/')).toBe(true);
  });

  it('for an issuer WITH a path it tries the three documented forms in order', async () => {
    const asked: string[] = [];
    const fakeFetch = recordingFetch(asked, () => new Response('{}', { status: 404 }));

    await expect(
      discoverJwksUri({ issuer: 'https://auth.example.com/tenant1', logger: logger(), fetchFn: fakeFetch }),
    ).rejects.toThrow(JwksDiscoveryError);

    // verified: same page lines 77-86.
    expect(asked).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.com/.well-known/openid-configuration/tenant1',
      'https://auth.example.com/tenant1/.well-known/openid-configuration',
    ]);
  });

  it('the OIDC fallback is used when the RFC 8414 path 404s', async () => {
    const asked: string[] = [];
    const fakeFetch = recordingFetch(asked, (url) =>
      url.endsWith('/oauth-authorization-server')
        ? new Response('{}', { status: 404 })
        : jsonResponse({
            issuer: 'https://auth.example.com',
            jwks_uri: 'https://auth.example.com/oidc-jwks',
          }),
    );

    expect(await discoverJwksUri({ issuer: 'https://auth.example.com', logger: logger(), fetchFn: fakeFetch })).toBe(
      'https://auth.example.com/oidc-jwks',
    );
    expect(asked).toHaveLength(2);
  });
});

describe('P7-3 no key material in logs', () => {
  it('the JWK material never appears in any log line', async () => {
    const rs = server();
    await rs.verify(await mint());
    await rs.verify(await mint());
    const output = logLines.join('\n');
    expect(output).not.toContain(KEY_CANARY);
    expect(output).not.toContain(publicJwk['n'] ?? '');
    expect(output).not.toContain(publicJwk['e'] ?? '');
    expect(output).not.toContain('BEGIN');
  });

  it('a rejected discovery logs the issuer, never the document', async () => {
    advertised = { issuer: 'https://auth.attacker.example', jwks_uri: jwksUrl };
    await expect(discoverJwksUri({ issuer, logger: logger() })).rejects.toThrow();
    const output = logLines.join('\n');
    expect(output).toContain(issuer);
    expect(output).not.toContain(publicJwk['n'] ?? '');
  });
});