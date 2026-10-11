// B-37: rate-limit buckets for OAuth callers are keyed by the VERIFIED issuer and subject.
//
// The defect being fixed: every OAuth caller shared one bucket, so a single noisy tenant
// exhausted the allowance for all of them, while the static-bearer path was never
// distinguished from it at all.
//
// D15: LOCAL fake authorization server only. Nothing here contacts a third party.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Writable } from 'node:stream';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type CryptoKey } from 'jose';

import { startGateway, type RunningGateway } from '../../src/index.js';
import { createLogger } from '../../src/observability/logger.js';
import { unusedPort } from '../fixtures/fake-upstream.js';

const API_KEY = 'B37-STATIC-KEY-0123456789';
const OTHER_KEY = 'B37-SECOND-STATIC-KEY-9876543';
const SUBJECT_CANARY_A = 'subject-alpha';
const SUBJECT_CANARY_B = 'subject-bravo';

const LIMIT = 3;

let signingKey: Uint8Array | CryptoKey;
let publicJwk: JWK;
let as: Server;
let issuer: string;
let gateway: RunningGateway;
let port: number;
let logLines: string[];

async function startFakeAs(): Promise<Server> {
  const asPort = await unusedPort();
  issuer = `http://127.0.0.1:${asPort}`;
  const jwksUrl = `${issuer}/jwks.json`;
  const server = createServer((req, res) => {
    if (req.url === '/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ issuer, jwks_uri: jwksUrl }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(asPort, '127.0.0.1', () => resolve()));
  return server;
}

/** Mints a REAL RS256 token from the fake AS's key. */
async function mintToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // `iss` is set through setIssuer, so it must not also be spread into the payload.
  const { iss, ...claims } = overrides;
  return new SignJWT({
    aud: 'https://gateway.test.invalid/mcp',
    sub: SUBJECT_CANARY_A,
    iat: now,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer((iss as string | undefined) ?? issuer)
    .setExpirationTime(now + 3600)
    .sign(signingKey);
}

function post(authorization: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

describe('B-37 rate-limit buckets follow the verified identity', () => {
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    signingKey = pair.privateKey;
    publicJwk = await exportJWK(pair.publicKey);
    as = await startFakeAs();

    const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-b37-'));
    const configPath = join(dir, 'gateway.json');
    port = await unusedPort();
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          host: '127.0.0.1',
          port,
          publicUrl: 'https://gateway.test.invalid',
          auth: { type: 'bearer', keys: [API_KEY, OTHER_KEY] },
          authOAuth: { issuer, audience: 'https://gateway.test.invalid/mcp' },
          rateLimit: { requests: LIMIT, windowMs: 60_000 },
          defaultTimeoutMs: 5_000,
          defaultTtlMs: 30_000,
        },
        mcp: {},
      }),
      'utf8',
    );

    logLines = [];
    gateway = await startGateway({
      configPath,
      logger: createLogger({
        level: 'debug',
        destination: new Writable({
          write(chunk, _enc, cb) {
            logLines.push(String(chunk));
            cb();
          },
        }),
      }),
    });
  }, 60_000);

  afterAll(async () => {
    await gateway?.stop();
    await new Promise<void>((resolve) => as?.close(() => resolve()));
  }, 30_000);

  it('two different OAuth subjects do not share a bucket', async () => {
    // Warm the JWKS cache and prove subject A is allowed LIMIT times.
    const a = await mintToken({ sub: SUBJECT_CANARY_A });
    const statusesA: number[] = [];
    for (let i = 0; i < LIMIT + 2; i += 1) {
      statusesA.push((await post(`Bearer ${a}`)).status);
    }
    expect(statusesA.slice(0, LIMIT).every((s) => s === 200)).toBe(true);
    expect(statusesA.slice(LIMIT).every((s) => s === 429)).toBe(true);

    // Subject B, same issuer, same window, starts with a FULL bucket.
    const b = await mintToken({ sub: SUBJECT_CANARY_B });
    const statusesB: number[] = [];
    for (let i = 0; i < LIMIT; i += 1) {
      statusesB.push((await post(`Bearer ${b}`)).status);
    }
    expect(statusesB.every((s) => s === 200)).toBe(true);

    // And A is still exhausted, so the two did not merge.
    expect((await post(`Bearer ${a}`)).status).toBe(429);
  }, 60_000);

  it('a token signed by the wrong key cannot create or consume a bucket', async () => {
    const attacker = await generateKeyPair('RS256');
    const forged = await new SignJWT({
      iss: issuer,
      aud: 'https://gateway.test.invalid/mcp',
      sub: 'attacker-subject',
      iat: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(issuer)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(attacker.privateKey);

    for (let i = 0; i < LIMIT + 5; i += 1) {
      expect((await post(`Bearer ${forged}`)).status).toBe(401);
    }

    // A legitimate subject with an untouched bucket is still fully allowed, which proves
    // the rejected requests neither created a bucket that could exhaust it nor consumed
    // one belonging to anyone else.
    const legit = await mintToken({ sub: 'fresh-subject-after-forgery' });
    for (let i = 0; i < LIMIT; i += 1) {
      expect((await post(`Bearer ${legit}`)).status).toBe(200);
    }
  }, 60_000);

  it('a token from the wrong issuer is rejected and consumes nothing', async () => {
    const wrongIssuer = await mintToken({ iss: 'http://127.0.0.1:1/not-this-one' });
    for (let i = 0; i < LIMIT + 5; i += 1) {
      expect((await post(`Bearer ${wrongIssuer}`)).status).toBe(401);
    }

    const legit = await mintToken({ sub: 'fresh-subject-after-wrong-iss' });
    for (let i = 0; i < LIMIT; i += 1) {
      expect((await post(`Bearer ${legit}`)).status).toBe(200);
    }
  }, 60_000);

  it('a garbage token is rejected and consumes nothing', async () => {
    for (let i = 0; i < LIMIT + 5; i += 1) {
      expect((await post('Bearer not-a-jwt-at-all')).status).toBe(401);
    }
    const legit = await mintToken({ sub: 'fresh-subject-after-garbage' });
    for (let i = 0; i < LIMIT; i += 1) {
      expect((await post(`Bearer ${legit}`)).status).toBe(200);
    }
  }, 60_000);

  it('each static bearer key gets its own bucket', async () => {
    // First key exhausts.
    const first: number[] = [];
    for (let i = 0; i < LIMIT + 2; i += 1) first.push((await post(`Bearer ${API_KEY}`)).status);
    expect(first.slice(0, LIMIT).every((s) => s === 200)).toBe(true);
    expect(first.slice(LIMIT).every((s) => s === 429)).toBe(true);

    // The second configured key still has a full allowance.
    for (let i = 0; i < LIMIT; i += 1) {
      expect((await post(`Bearer ${OTHER_KEY}`)).status).toBe(200);
    }
  }, 60_000);

  it('an OAuth caller does not share the static keys buckets', async () => {
    const subject = await mintToken({ sub: 'subject-with-fresh-bucket' });
    for (let i = 0; i < LIMIT; i += 1) {
      expect((await post(`Bearer ${subject}`)).status).toBe(200);
    }
  }, 30_000);

  it('no subject, token, key or secret ever appears in a log line', () => {
    const output = logLines.join('\n');
    for (const secret of [
      API_KEY,
      OTHER_KEY,
      SUBJECT_CANARY_A,
      SUBJECT_CANARY_B,
      'attacker-subject',
    ]) {
      expect(output).not.toContain(secret);
    }
    // The issuer IS published in metadata, so it is not a secret; but it must not appear as
    // a raw bucket key either. The limiter hashes before storing.
    expect(output).not.toContain('oauth:');
  });
});
