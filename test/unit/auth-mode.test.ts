// ADR 0013: the auth-mode decision, in one place.
//
// D15: LOCAL only. Nothing here opens a socket or reads a real home directory.

import { describe, expect, it } from 'vitest';

import { checkAuthMode, resolveAuthMode } from '../../src/config/auth-mode.js';
import { alwaysAuthorized, createBearerAuth } from '../../src/server/auth.js';
import type { GatewayConfig } from '../../src/config/schema.js';

function config(host: string, keys: string[], withOAuth = false): GatewayConfig {
  return {
    gateway: {
      host,
      port: 3000,
      auth: { type: 'bearer', keys },
      ...(withOAuth ? { authOAuth: { issuer: 'https://as.test.invalid' } } : {}),
      defaultTimeoutMs: 30_000,
      defaultTtlMs: 30_000,
      legacyEra: 'stateless',
    },
    mcp: {},
  };
}

describe('ADR 0013 resolveAuthMode', () => {
  it('is bearer when a static key exists', () => {
    expect(resolveAuthMode(config('127.0.0.1', ['k']))).toEqual({ mode: 'bearer', keyCount: 1 });
  });

  it('is oauth-only with no static keys, which ADR 0009 already allowed', () => {
    // The request is still checked -- against a token instead of a key -- so this is not the
    // dangerous state.
    expect(resolveAuthMode(config('0.0.0.0', [], true))).toEqual({
      mode: 'oauth-only',
      keyCount: 0,
    });
  });

  it('is open with neither, and says why in a sentence', () => {
    const decision = resolveAuthMode(config('127.0.0.1', []));
    expect(decision.mode).toBe('open');
    expect(decision.keyCount).toBe(0);
    expect(decision.reason).toContain('accepts any caller');
  });

  it('never puts a key value into a decision', () => {
    const secret = 'S3CRET-CANARY-0123456789';
    const decision = resolveAuthMode(config('127.0.0.1', [secret]));
    expect(JSON.stringify(decision)).not.toContain(secret);
  });
});

describe('ADR 0013 checkAuthMode', () => {
  it('allows everything that has a credential', () => {
    expect(checkAuthMode(config('0.0.0.0', ['k']))).toBeUndefined();
    expect(checkAuthMode(config('192.168.1.7', ['k']))).toBeUndefined();
    // OAuth-only is not open, so a wildcard bind is fine with it.
    expect(checkAuthMode(config('0.0.0.0', [], true))).toBeUndefined();
  });

  it('allows a keyless gateway on loopback', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
      expect(checkAuthMode(config(host, [])), host).toBeUndefined();
    }
  });

  it('refuses a keyless gateway on any non-loopback bind', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.7', 'gateway.example.com', '']) {
      expect(checkAuthMode(config(host, [])), host).toBeDefined();
    }
  });

  it('treats the schema default as the dangerous case, which it is', () => {
    // gateway.host defaults to 0.0.0.0. A keyless config that does not say otherwise is
    // therefore refused -- the safe default would have been to default to loopback and let
    // the operator opt in, but the schema default predates this rule and changing it would
    // alter behaviour for existing configs.
    expect(checkAuthMode(config('0.0.0.0', []))).toBeDefined();
  });

  it('names the key path, the host and the flag that fixes it', () => {
    const problem = checkAuthMode(config('0.0.0.0', []));
    expect(problem?.path).toBe('gateway.auth.keys');
    expect(problem?.reason).toContain('0.0.0.0');
    expect(problem?.reason).toContain('--hostname 127.0.0.1');
    expect(problem?.reason).toContain('gateway.auth.keys');
    // Never a value: there is no key in this scenario to leak, and none is invented.
    expect(problem?.reason).not.toMatch(/Bearer\s+\S/);
  });
});

describe('ADR 0013 alwaysAuthorized', () => {
  it('accepts a request with no Authorization header at all', () => {
    expect(alwaysAuthorized().authorize(undefined)).toEqual({ ok: true, keyIndex: -1 });
    expect(alwaysAuthorized().authorize('')).toEqual({ ok: true, keyIndex: -1 });
  });

  it('accepts a well-formed bearer header, discarding the value', () => {
    expect(alwaysAuthorized().authorize('Bearer anything')).toEqual({ ok: true, keyIndex: -1 });
  });

  it('still rejects a MALFORMED header', () => {
    // This is the one behaviour that keeps an open gateway honest. Answering 200 to
    // `Authorization: nonsense` would make "send anything" a path that appears to work, and
    // would hide a client that believes it is authenticating when it is not.
    expect(alwaysAuthorized().authorize('nonsense')).toEqual({ ok: false, reason: 'malformed' });
    expect(alwaysAuthorized().authorize('Basic abc')).toEqual({ ok: false, reason: 'malformed' });
    expect(alwaysAuthorized().authorize('Bearer ')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('uses keyIndex -1, which is not a real key index', () => {
    // The rate limiter buckets on `static:${sha256(key)}` for real keys. Colliding with one
    // of those would merge an anonymous caller into an authenticated tenant's allowance.
    expect(alwaysAuthorized().authorize(undefined).ok).toBe(true);
    expect((alwaysAuthorized().authorize(undefined) as { keyIndex: number }).keyIndex).toBe(-1);
  });

  it('is NOT what createBearerAuth does with an empty list', () => {
    // The distinction the whole design turns on, asserted directly: an empty key list is
    // deny-all. If it ever became open, deleting the old superRefine would have silently
    // produced an unauthenticated gateway instead of a visibly broken one.
    expect(createBearerAuth([]).authorize('Bearer any-value')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    // And a correctly configured key still authenticates through it, which is what proves
    // the difference is the key list and not the harness.
    expect(createBearerAuth(['k']).authorize('Bearer k').ok).toBe(true);
  });
});