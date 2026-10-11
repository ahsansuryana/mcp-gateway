// PLAN.md S7.2: per-subject rate limiting, 429 + Retry-After.
//
// D15: LOCAL fake only.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { RateLimiter, MAX_BUCKETS } from '../../src/server/rate-limit.js';
import { createLogger } from '../../src/observability/logger.js';
import { startGateway, type RunningGateway } from '../../src/index.js';
import { unusedPort } from '../fixtures/fake-upstream.js';

const API_KEY = 'S72-CANARY-KEY-0123456789';
const OTHER_KEY = 'S72-OTHER-KEY-9876543210';
const KEY_CANARY = 'S72-KEY-CANARY-must-not-be-an-identifier';

describe('S7.2 the token bucket', () => {
  it('allows up to the limit then rejects', () => {
    const now = 1_000_000;
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    const denied = limiter.check('a');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('refills proportionally as time passes', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ limit: 10, windowMs: 60_000, now: () => now });
    for (let i = 0; i < 10; i += 1) limiter.check('a');
    expect(limiter.check('a').allowed).toBe(false);

    // A sixth of the window refills one token.
    now += 6_000;
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('buckets are independent per subject', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true);
  });

  it('a limit of 0 disables limiting entirely', () => {
    const limiter = new RateLimiter({ limit: 0, windowMs: 60_000 });
    expect(limiter.enabled).toBe(false);
    for (let i = 0; i < 1000; i += 1) expect(limiter.check('a').allowed).toBe(true);
  });

  it('the subject is HASHED, so a bearer key is never a map key', () => {
    // A plain-key map would put a secret in a heap dump and in any operator printing the
    // limiter's state.
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000 });
    limiter.check(KEY_CANARY);
    const rendered = JSON.stringify([...limiter.keys()]);
    expect(rendered).not.toContain(KEY_CANARY);
  });

  it('memory stays bounded when distinct subjects arrive faster than the window', () => {
    // A burst of DISTINCT subjects all created at the same instant is the case an
    // age-only sweep cannot catch: at sweep time none of them is old enough to drop.
    const now = 0;
    const limiter = new RateLimiter({ limit: 5, windowMs: 60_000, now: () => now });
    for (let i = 0; i < MAX_BUCKETS + 500; i += 1) limiter.check(`subject-${i}`);
    expect(limiter.size).toBeLessThanOrEqual(MAX_BUCKETS);
  });

  it('idle buckets are eventually dropped', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 5, windowMs: 1_000, now: () => now });
    // 100 subjects over 100s with a 1s window: the oldest is far past its window by the
    // time the last one is created, so the age sweep has something to remove.
    for (let i = 0; i < 100; i += 1) {
      limiter.check(`subject-${i}`);
      now += 1_000;
    }
    expect(limiter.size).toBeLessThan(100);
  });
});

describe('S7.2 over HTTP', () => {
  let gateway: RunningGateway;
  let logLines: string[];
  let port: number;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-s72-'));
    const configPath = join(dir, 'gateway.json');
    port = await unusedPort();
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          host: '127.0.0.1',
          port,
          auth: { type: 'bearer', keys: [API_KEY, OTHER_KEY] },
          rateLimit: { requests: 3, windowMs: 60_000 },
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
  }, 30_000);

  it('answers 429 with Retry-After once the bucket is empty', async () => {
    const call = (): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });

    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 6; i += 1) {
      const res = await call();
      statuses.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get('retry-after');
    }

    expect(statuses.slice(0, 3).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(3).every((s) => s === 429)).toBe(true);
    // RFC 9110 §10.2.3 delay-seconds.
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('an unauthenticated request is 401, not 429: auth runs first', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  }, 20_000);

  it('/healthz is never rate limited', async () => {
    for (let i = 0; i < 20; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
    }
  }, 30_000);

  it('no key value ever appears in a log line', () => {
    const output = logLines.join('\n');
    expect(output).not.toContain(API_KEY);
    expect(output).not.toContain(OTHER_KEY);
  });
});