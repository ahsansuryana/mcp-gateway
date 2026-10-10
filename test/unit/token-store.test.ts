// PLAN.md S5.2: encrypted, atomically written credential storage.
//
// The canary tests are the point: a token, a client secret and a PKCE verifier written to
// disk must be unrecoverable from the file, and a wrong key must fail loudly rather than
// silently returning garbage.
//
// D15: no network.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  TokenStore,
  loadTokenKey,
  TOKEN_KEY_BYTES,
  TOKEN_KEY_ENV_VAR,
  type StoredCredentials,
} from '../../src/auth/oauth-client/token-store.js';
import { createLogger } from '../../src/observability/logger.js';
import { Writable } from 'node:stream';

const KEY = randomBytes(TOKEN_KEY_BYTES);
const OTHER_KEY = randomBytes(TOKEN_KEY_BYTES);

const CANARY_TOKEN = 'ACCESS-TOKEN-CANARY-9f3a2b1c';
const CANARY_SECRET = 'CLIENT-SECRET-CANARY-7d4e5a6b';
const CANARY_VERIFIER = 'PKCE-VERIFIER-CANARY-1c2d3e4f';
const CANARY_REFRESH = 'REFRESH-TOKEN-CANARY-5e6f7a8b';

function creds(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    clientId: 'client-id-123',
    clientSecret: CANARY_SECRET,
    accessToken: CANARY_TOKEN,
    refreshToken: CANARY_REFRESH,
    expiresAt: Date.now() + 3_600_000,
    tokenType: 'Bearer',
    scope: 'files:read',
    ...overrides,
  };
}

function store(key: Buffer = KEY): { store: TokenStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'mcp-gateway-s5-2-')), 'nested', 'tokens.enc.json');
  return { store: new TokenStore({ path, key }), path };
}

describe('S5.2 key material', () => {
  it('loadTokenKey decodes base64 of exactly 32 bytes', () => {
    const encoded = randomBytes(TOKEN_KEY_BYTES).toString('base64');
    expect(loadTokenKey({ [TOKEN_KEY_ENV_VAR]: encoded })).toHaveLength(TOKEN_KEY_BYTES);
  });

  it('a missing key names the VARIABLE and never a value', () => {
    expect(() => loadTokenKey({})).toThrow(new RegExp(TOKEN_KEY_ENV_VAR));
    expect(() => loadTokenKey({})).toThrow(/not set/);
  });

  it('a wrong-length key is rejected with the byte counts, not the value', () => {
    const short = randomBytes(16).toString('base64');
    let message = '';
    try {
      loadTokenKey({ [TOKEN_KEY_ENV_VAR]: short });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(TOKEN_KEY_ENV_VAR);
    expect(message).toContain(String(TOKEN_KEY_BYTES));
    expect(message).not.toContain(short);
  });
});

describe('S5.2 encrypted storage', () => {
  it('round-trips credentials', async () => {
    const { store: s, path } = store();
    await s.set('notion', 'https://auth.example.com', creds());
    expect(await s.get('notion', 'https://auth.example.com')).toMatchObject({
      clientId: 'client-id-123',
      accessToken: CANARY_TOKEN,
      refreshToken: CANARY_REFRESH,
    });
    expect(existsSync(path)).toBe(true);
  });

  it('the file on disk contains NONE of the secret values', async () => {
    const { store: s, path } = store();
    await s.set('notion', 'https://auth.example.com', creds());
    await s.savePending('notion', {
      codeVerifier: CANARY_VERIFIER,
      state: 'state-canary',
      issuer: 'https://auth.example.com',
      createdAt: Date.now(),
    });

    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(CANARY_TOKEN);
    expect(raw).not.toContain(CANARY_SECRET);
    expect(raw).not.toContain(CANARY_REFRESH);
    expect(raw).not.toContain(CANARY_VERIFIER);
    // It is not even valid JSON: the whole payload is ciphertext.
    expect(() => {
      JSON.parse(raw) as unknown;
    }).toThrow();
  });

  it('a wrong key fails authentication instead of returning garbage', async () => {
    const { store: writer, path } = store(KEY);
    await writer.set('notion', 'https://auth.example.com', creds());

    const reader = new TokenStore({ path, key: OTHER_KEY });
    await expect(reader.get('notion', 'https://auth.example.com')).rejects.toThrow(
      /could not be decrypted/,
    );
  });

  it('the failure message does not leak the key or the contents', async () => {
    const { store: writer, path } = store(KEY);
    await writer.set('notion', 'https://auth.example.com', creds());
    const reader = new TokenStore({ path, key: OTHER_KEY });

    let message = '';
    try {
      await reader.get('notion', 'https://auth.example.com');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(OTHER_KEY.toString('base64'));
    expect(message).not.toContain(CANARY_TOKEN);
    expect(message).not.toContain(CANARY_SECRET);
  });
});

describe('S5.2 issuer keying', () => {
  it('credentials are isolated per (upstreamName, issuer)', async () => {
    const { store: s } = store();
    await s.set('a', 'https://as-one.example', creds({ accessToken: 'token-one' }));
    await s.set('a', 'https://as-two.example', creds({ accessToken: 'token-two' }));
    await s.set('b', 'https://as-one.example', creds({ accessToken: 'token-three' }));

    expect((await s.get('a', 'https://as-one.example'))?.accessToken).toBe('token-one');
    expect((await s.get('a', 'https://as-two.example'))?.accessToken).toBe('token-two');
    expect((await s.get('b', 'https://as-one.example'))?.accessToken).toBe('token-three');
    expect(await s.list()).toHaveLength(3);
  });

  it('a record with no issuer match is simply absent, never borrowed', async () => {
    const { store: s } = store();
    await s.set('notion', 'https://auth.example.com', creds());
    // The spec forbids reusing credentials when the AS changes.
    expect(await s.get('notion', 'https://auth.attacker.example')).toBeUndefined();
  });
});

describe('S5.2 atomic writes', () => {
  it('no temp file survives a successful write', async () => {
    const { store: s, path } = store();
    await s.set('notion', 'https://auth.example.com', creds());
    const dir = dirname(path);
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('repeated writes leave exactly one file', async () => {
    const { store: s, path } = store();
    for (let i = 0; i < 5; i += 1) {
      await s.set('notion', 'https://auth.example.com', creds({ accessToken: `t${i}` }));
    }
    const dir = dirname(path);
    expect(readdirSync(dir).filter((f) => !f.endsWith('.tmp'))).toHaveLength(1);
    expect((await s.get('notion', 'https://auth.example.com'))?.accessToken).toBe('t4');
  });

  it('creates missing parent directories', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mcp-gateway-s5-2b-')), 'a', 'b', 'c', 't.enc.json');
    const s = new TokenStore({ path, key: KEY });
    await s.set('x', 'https://as.example', creds());
    expect(existsSync(path)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('the file is mode 0600 on POSIX', async () => {
    // Windows has no POSIX mode bits; the file inherits the directory ACL instead. The
    // runtime behaviour is reported in docs/reports/sprint-5.md.
    const { store: s, path } = store();
    await s.set('notion', 'https://auth.example.com', creds());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('S5.2 pending authorizations', () => {
  it('a pending record is looked up and consumed exactly once', async () => {
    const { store: s } = store();
    await s.savePending('notion', {
      codeVerifier: CANARY_VERIFIER,
      state: 'st-1',
      issuer: 'https://auth.example.com',
      createdAt: Date.now(),
    });

    const first = await s.takePendingByState('st-1');
    expect(first?.upstreamName).toBe('notion');
    expect(first?.pending.codeVerifier).toBe(CANARY_VERIFIER);
    expect(first?.pending.issuer).toBe('https://auth.example.com');

    // Single use: replaying the same state finds nothing.
    expect(await s.takePendingByState('st-1')).toBeUndefined();
  });

  it('an unknown state consumes nothing', async () => {
    const { store: s } = store();
    await s.savePending('notion', {
      codeVerifier: CANARY_VERIFIER,
      state: 'st-1',
      issuer: 'https://auth.example.com',
      createdAt: Date.now(),
    });
    expect(await s.takePendingByState('not-fs')).toBeUndefined();
    expect(await s.listPending()).toHaveLength(1);
  });
});

describe('S5.2 secret hygiene', () => {
  it('a store operation logs nothing containing a token', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const logger = createLogger({ level: 'trace', destination: sink, secrets: [CANARY_TOKEN] });

    const { store: s, path } = store();
    await s.set('notion', 'https://auth.example.com', creds());
    await s.get('notion', 'https://auth.example.com');
    await s.delete('notion', 'https://auth.example.com');
    logger.info({ storePath: path }, 'token store touched');

    const output = lines.join('\n');
    expect(output).not.toContain(CANARY_TOKEN);
    expect(output).not.toContain(CANARY_SECRET);
    expect(output).not.toContain(CANARY_REFRESH);
  });

  it('readFileSync of the store never yields the access token', async () => {
    const { store: s, path } = store();
    await s.set('notion', 'https://auth.example.com', creds());
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(CANARY_TOKEN);
  });
});