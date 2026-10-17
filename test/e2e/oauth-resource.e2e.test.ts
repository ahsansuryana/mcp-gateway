// PLAN.md S6.3: an in-repo fake authorization server that MINTS real RS256 JWTs, so the
// resource server is tested against actual signature verification rather than a stub.
//
//   valid token passes; expired, wrong issuer, wrong audience, bad signature, alg=none and a
//   token signed with a DIFFERENT key are all rejected with 401 + the correct challenge;
//   static bearer keys still work; /healthz stays unauthenticated; /status requires auth.
//
// D15: LOCAL only. No third-party service is contacted.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type CryptoKey } from 'jose';


import { startGateway, type RunningGateway } from '../../src/index.js';
import { unusedPort } from '../fixtures/fake-upstream.js';

const API_KEY = 'S63-CANARY-KEY-0123456789';
/** A public hostname that exists only in test configuration. */
const TEST_PUBLIC_URL = 'https://gateway.test.invalid';

let signingKey: Uint8Array | CryptoKey;
let otherKey: Uint8Array | CryptoKey;
let publicJwk: JWK;
let as: Server;
let issuer: string;
let jwksUrl: string;
let gateway: RunningGateway;

async function startFakeAs(): Promise<Server> {
  const port = await unusedPort();
  issuer = `http://127.0.0.1:${port}`;
  jwksUrl = `${issuer}/jwks.json`;

  const server = createServer((req, res) => {
    if (req.url === '/jwks.json') {
      const body = JSON.stringify({ keys: [publicJwk] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (req.url === '/.well-known/oauth-authorization-server') {
      const body = JSON.stringify({ issuer, jwks_uri: jwksUrl });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return server;
}

interface MintOptions {
  key?: Uint8Array | CryptoKey;
  iss?: string;
  aud?: string;
  expiresIn?: string;
  notBefore?: string;
  alg?: string;
}

async function mint(opts: MintOptions = {}): Promise<string> {
  const alg = opts.alg ?? 'RS256';
  let key: Uint8Array | CryptoKey = opts.key ?? signingKey;
  let use = alg;
  if (alg === 'none') {
    // jose REFUSES to sign alg=none, which is the correct behaviour. An attacker does not
    // use jose, so the unsecured JWT is assembled by hand here exactly as it would arrive:
    // header.payload. with an EMPTY signature.
    // verified: RFC 7519 §6 (Unsecured JWT) and RFC 7515 Appendix A.5.
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    return [
      b64({ alg: 'none', typ: 'JWT' }),
      b64({
        iss: opts.iss ?? issuer,
        aud: opts.aud ?? `${TEST_PUBLIC_URL}/mcp`,
        sub: 'attacker',
        iat: now,
        exp: now + 3600,
      }),
      '',
    ].join('.');
  }
  if (alg === 'HS256') {
    key = new TextEncoder().encode('a-shared-secret-nobody-should-accept');
    use = alg;
  }
  const builder = new SignJWT({ scope: 'mcp:read' })
    .setProtectedHeader({ alg: use })
    .setIssuedAt()
    .setSubject('user-canary-1234')
    .setExpirationTime(opts.expiresIn ?? '5m');
  if (opts.iss !== undefined) builder.setIssuer(opts.iss);
  else builder.setIssuer(issuer);
  if (opts.aud !== undefined) builder.setAudience(opts.aud);
  else builder.setAudience(`${TEST_PUBLIC_URL}/mcp`);
  return builder.sign(key);
}

async function post(token: string | undefined, path = '/mcp'): Promise<Response> {
  return fetch(`http://127.0.0.1:${gateway.port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key-1', alg: 'RS256', use: 'sig' };

  const other = await generateKeyPair('RS256', { extractable: true });
  otherKey = other.privateKey;

  as = await startFakeAs();

  const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-s63-'));
  const configPath = join(dir, 'gateway.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      gateway: {
        host: '127.0.0.1',
        port: await unusedPort(),
        publicUrl: TEST_PUBLIC_URL,
        auth: { type: 'bearer', keys: [API_KEY] },
        authOAuth: { issuer, jwksUri: jwksUrl, scope: 'mcp:read' },
        defaultTimeoutMs: 5_000,
        defaultTtlMs: 30_000,
      },
      mcp: {},
    }),
    'utf8',
  );
  gateway = await startGateway({ configPath, logLevel: 'silent' });
}, 60_000);

afterAll(async () => {
  await gateway?.stop();
  await new Promise<void>((r) => as.close(() => r()));
});

describe('S6.3 the discovery flow', () => {
  it('serves protected-resource metadata at the path and at the root', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const res = await fetch(`http://127.0.0.1:${gateway.port}${path}`);
      expect(res.status, path).toBe(200);
      const doc = (await res.json()) as {
        resource: string;
        authorization_servers: string[];
        bearer_methods_supported: string[];
      };
      // verified: docs/ref/claude-connector-requirements.md — resource MUST match the MCP
      //   URL exactly, including the path component.
      expect(doc.resource).toBe(`${TEST_PUBLIC_URL}/mcp`);
      // ...and only the FIRST entry is read, so exactly one is published.
      expect(doc.authorization_servers).toEqual([issuer]);
      expect(doc.bearer_methods_supported).toEqual(['header']);
    }
  });

  it('the JWKS is not proxied through the gateway', async () => {
    // The gateway publishes metadata; the signing keys live on the AS, not here.
    const res = await fetch(`http://127.0.0.1:${gateway.port}/jwks.json`);
    expect(res.status).toBe(404);
  });
});

describe('S6.3 a valid token is accepted', () => {
  it('passes with a correct RS256 token', async () => {
    const res = await post(await mint());
    expect(res.status).toBe(200);
  });

  it('a static bearer key still works side by side', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('S6.3 every bad token is rejected with the correct challenge', () => {
  const cases: { label: string; token: () => Promise<string> }[] = [
    { label: 'expired', token: () => mint({ expiresIn: '-10m' }) },
    { label: 'wrong issuer', token: () => mint({ iss: 'https://auth.attacker.example' }) },
    { label: 'wrong audience', token: () => mint({ aud: 'https://someone-else.example/mcp' }) },
    { label: 'signed with a different key', token: () => mint({ key: otherKey }) },
    { label: 'tampered payload', token: async () => {
      const t = await mint();
      const [h, p, s] = t.split('.');
      // Flip one character of the payload; the signature must no longer verify.
      const flipped = `${p!.slice(0, -2)}${p!.slice(-2, -1) === 'A' ? 'B' : 'A'}${p!.slice(-1)}`;
      return `${h}.${flipped}.${s}`;
    } },
    { label: 'alg none', token: () => mint({ alg: 'none' }) },
    { label: 'HS256 with a shared secret', token: () => mint({ alg: 'HS256' }) },
  ];

  for (const testCase of cases) {
    it(`rejects ${testCase.label} with 401 and a resource_metadata challenge`, async () => {
      const res = await post(await testCase.token());
      expect(res.status).toBe(401);

      const challenge = res.headers.get('www-authenticate') ?? '';
      // verified: docs/ref/claude-connector-requirements.md — a 401 carrying
      //   WWW-Authenticate is REQUIRED; Claude ignores the header on a 200.
      expect(challenge).toContain('Bearer');
      expect(challenge).toContain('resource_metadata=');
      expect(challenge).toContain(`${TEST_PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`);
      // The scope hint steers what the client asks for.
      expect(challenge).toContain('scope="mcp:read"');
      // Never echo the token or any part of it back.
      expect(JSON.stringify(await res.json())).not.toContain('eyJ');
    }, 20_000);
  }

  it('rejects a request with no Authorization header at all', async () => {
    const res = await post(undefined);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate') ?? '').toContain('resource_metadata=');
  });

  it('rejects a non-bearer scheme', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Basic dXNlcjpwYXNz',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('S6.3 the other routes keep their posture', () => {
  it('/healthz stays unauthenticated', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('/status requires auth', async () => {
    expect((await fetch(`http://127.0.0.1:${gateway.port}/status`)).status).toBe(401);
  });

  it('/status reports the issuer but never a token, key or JWKS content', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/status`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    const parsed = JSON.parse(body) as { gateway: Record<string, unknown> };
    expect(parsed.gateway['oauthIssuer']).toBe(issuer);
    expect(parsed.gateway['oauthAudience']).toBe(`${TEST_PUBLIC_URL}/mcp`);
    expect(body).not.toContain(API_KEY);
    expect(body).not.toContain(publicJwk.n ?? '');
    expect(body).not.toContain('eyJ');
  });

  it('the protected-resource metadata document leaks nothing', async () => {
    const body = await (
      await fetch(`http://127.0.0.1:${gateway.port}/.well-known/oauth-protected-resource/mcp`)
    ).text();
    expect(body).not.toContain(API_KEY);
    expect(body).not.toContain('private');
  });
});
// --- Sprint 6 security review ---------------------------------------------------
// A token, a JWKS document and a signing key must never reach a log line, an error body or
// /status. These use canary values that are recognisable if they ever leak.
describe('Sprint 6 security review: no token, JWKS or key material leaks', () => {
  const TOKEN_CANARY = 'S66-ACCESS-TOKEN-CANARY-aaa111';
  const JWKS_CANARY = 'S66-JWKS-CANARY-bbb222';
  const KEY_CANARY = 'S66-SIGNING-KEY-CANARY-ccc333';

  it('a rejected token value never appears in the response body or the challenge', async () => {
    const response = await post(TOKEN_CANARY);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).not.toContain(TOKEN_CANARY);
    expect(body).not.toContain('eyJ');
    // The challenge names the REASON, never the credential.
    expect(response.headers.get('www-authenticate') ?? '').not.toContain(TOKEN_CANARY);
  });

  it('the gateway never proxies or echoes the JWKS', async () => {
    for (const path of ['/jwks.json', '/.well-known/jwks.json', '/oauth/jwks']) {
      const res = await fetch(`http://127.0.0.1:${gateway.port}${path}`);
      const body = await res.text();
      expect(res.status, path).toBe(404);
      expect(body).not.toContain('BEGIN PUBLIC KEY');
      expect(body).not.toContain(JWKS_CANARY);
      expect(body).not.toContain(KEY_CANARY);
    }
  });

  it('an authorization-server outage does not leak the issuer key material', async () => {
    // The JWKS URI is pointed at a closed port; the failure must be a plain 401.
    const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-s63-as-'));
    const configPath = join(dir, 'gateway.json');
    const deadIssuer = `http://127.0.0.1:${await unusedPort()}`;
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          host: '127.0.0.1',
          port: await unusedPort(),
          publicUrl: TEST_PUBLIC_URL,
          auth: { type: 'bearer', keys: [API_KEY] },
          authOAuth: { issuer: deadIssuer, jwksUri: `${deadIssuer}/jwks.json` },
          defaultTimeoutMs: 5_000,
          defaultTtlMs: 30_000,
        },
        mcp: {},
      }),
      'utf8',
    );
    const deadGateway = await startGateway({ configPath, logLevel: 'silent' });
    try {
      const res = await fetch(`http://127.0.0.1:${deadGateway.port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN_CANARY}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
      const body = await res.text();
      expect(body).not.toContain(TOKEN_CANARY);
      expect(body).not.toContain('ECONNREFUSED');
      expect(body).not.toContain(KEY_CANARY);
    } finally {
      await deadGateway.stop();
    }
  }, 30_000);

  it('an authOAuth config without publicUrl is a startup error, not a silent downgrade', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-s63-nou-'));
    const configPath = join(dir, 'gateway.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          host: '127.0.0.1',
          port: await unusedPort(),
          auth: { type: 'bearer', keys: [API_KEY] },
          authOAuth: { issuer },
          defaultTimeoutMs: 5_000,
          defaultTtlMs: 30_000,
        },
        mcp: {},
      }),
      'utf8',
    );
    // The audience and the metadata URL are both derived from publicUrl; without it the
    // gateway has no canonical resource identifier, so it must refuse to start.
    await expect(startGateway({ configPath, logLevel: 'silent' })).rejects.toThrow(
      /gateway\.publicUrl/,
    );
  }, 30_000);

  // ADR 0013 INVERTED THIS TEST, rather than deleting it. It used to assert that a config
  // with neither a static key nor authOAuth is rejected outright. The human decision was to
  // allow an unauthenticated gateway and warn loudly -- so the rule moved from "always
  // reject" to "reject unless the bind is loopback". Deleting the assertion would have lost
  // the record that the posture changed on purpose; inverting it keeps it.
  //
  // The old assertion is worth restating because the reason it is now conditional is not
  // obvious from the new code: createBearerAuth([]) is DENY-ALL, not open. An empty key list
  // alone would have produced a gateway that 401s everything and looks broken rather than
  // dangerous, so `open` is a named state and not an inferred one.
  it('accepts a keyless config on a loopback bind and reports it as open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-open-'));
    const configPath = join(dir, 'gateway.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          host: '127.0.0.1',
          port: await unusedPort(),
          auth: { type: 'bearer', keys: [] },
          defaultTimeoutMs: 5_000,
          defaultTtlMs: 30_000,
        },
        mcp: {},
      }),
      'utf8',
    );

    const open = await startGateway({ configPath, logLevel: 'silent' });
    try {
      // /status is the discoverable answer to "is this gateway open?" long after the banner
      // has scrolled away, and it is authenticated in every OTHER mode -- so this response
      // is itself proof that /mcp and /status stopped requiring a credential.
      const response = await fetch(`http://127.0.0.1:${open.port}/status`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { gateway: Record<string, unknown> };
      expect(body.gateway['authMode']).toBe('open');
      expect(body.gateway['inboundAuthKeys']).toBe(0);
      expect(String(body.gateway['authWarning'])).toContain('accepts any caller');
    } finally {
      await open.stop();
    }
  }, 30_000);

  it('REFUSES a keyless config on any non-loopback bind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-open-wild-'));
    const configPath = join(dir, 'gateway.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          host: '0.0.0.0',
          port: await unusedPort(),
          auth: { type: 'bearer', keys: [] },
          defaultTimeoutMs: 5_000,
          defaultTtlMs: 30_000,
        },
        mcp: {},
      }),
      'utf8',
    );
    // The message names the key path AND the flag that fixes it, because a message that only
    // said "invalid" sends the operator to the schema instead of to their own config.
    await expect(startGateway({ configPath, logLevel: 'silent' })).rejects.toThrow(
      /gateway\.auth\.keys[\s\S]*0\.0\.0\.0[\s\S]*--hostname 127\.0\.0\.1/,
    );
  }, 30_000);

  it('REFUSES a keyless config promoted to 0.0.0.0 BY A FLAG, not just in the file', async () => {
    // The second half of ADR 0013's supervisor. loadConfig validated the FILE, and it ran
    // before --hostname was applied -- so without the re-check in startGateway this case
    // would pass validation and then listen on the LAN with POST /mcp open. That is the
    // whole reason the rule is a function called twice instead of a superRefine.
    const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-open-flag-'));
    const configPath = join(dir, 'gateway.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          host: '127.0.0.1', // safe on its own
          port: await unusedPort(),
          auth: { type: 'bearer', keys: [] },
          defaultTimeoutMs: 5_000,
          defaultTtlMs: 30_000,
        },
        mcp: {},
      }),
      'utf8',
    );

    await expect(
      startGateway({ configPath, logLevel: 'silent', flags: { hostname: '0.0.0.0' } }),
    ).rejects.toThrow(/0\.0\.0\.0/);
  }, 30_000);
});
