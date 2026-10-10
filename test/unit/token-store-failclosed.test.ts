// P6-2: the token store must FAIL CLOSED.
//
// A store that cannot be decrypted must never degrade into something that looks like
// success. The concrete failure this guards against is a real bug found in Sprint 5:
// the reader sliced the base64 TEXT by byte offsets, so it cut at character boundaries
// and produced `Invalid authentication tag length: 24` on a wrong key instead of an
// authentication failure. That is the dangerous shape — a raw Node error rather than the
// store's own "cannot be decrypted" rejection.
//
// Assertions here: a clear error, no partial plaintext, no crash that echoes key material.
//
// D15: no network.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  TokenStore,
  loadTokenKey,
  NONCE_BYTES,
  TAG_BYTES,
} from '../../src/auth/oauth-client/token-store.js';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const CANARY = 'FAILCLOSED-CANARY-a1b2c3d4e5';

function path(): string {
  return join(mkdtempSync(join(tmpdir(), 'mcp-gateway-p62-')), 'tokens.enc.json');
}

async function seeded(file: string): Promise<string> {
  const store = new TokenStore({ path: file, key: KEY });
  await store.set('notion', 'https://auth.example.com', {
    clientId: 'cid',
    clientSecret: CANARY,
    accessToken: CANARY,
    refreshToken: CANARY,
  });
  return readFileSync(file, 'utf8');
}

describe('P6-2 the store fails closed', () => {
  it('a wrong key rejects with the store\'s own error, not a raw crypto error', async () => {
    // Regression guard for the Sprint 5 bug. The per-character slice produced
    // "Invalid authentication tag length: 24", which is a Node error leaking through
    // instead of an authentication failure.
    const file = path();
    await seeded(file);
    const reader = new TokenStore({ path: file, key: OTHER_KEY });

    const message = await reader
      .get('notion', 'https://auth.example.com')
      .then(() => {
        throw new Error('expected the read to reject');
      })
      .catch((err: unknown) => (err instanceof Error ? err.message : String(err)));

    expect(message).toContain('could not be decrypted');
    expect(message).not.toContain('Invalid authentication tag length');
    expect(message).not.toContain('Unsupported state or unable to authenticate data');
  });

  it('a truncated file rejects rather than returning a partial record', async () => {
    const file = path();
    const encoded = await seeded(file);
    // Chop the tail: the ciphertext is short and the GCM tag must not verify.
    writeFileSync(file, encoded.slice(0, Math.floor(encoded.length / 2)), 'utf8');

    const reader = new TokenStore({ path: file, key: KEY });
    await expect(reader.get('notion', 'https://auth.example.com')).rejects.toThrow(
      /could not be decrypted|truncated/,
    );
  });

  it('a file shorter than the nonce+tag is rejected as truncated, not mis-parsed', async () => {
    // The exact off-by-one the Sprint 5 bug came from: 24 characters of base64 is not
    // 12 bytes, and a short buffer must not be sliced into arbitrary fields.
    const file = path();
    writeFileSync(file, randomBytes(4).toString('base64'), 'utf8');
    const reader = new TokenStore({ path: file, key: KEY });
    await expect(reader.get('notion', 'https://auth.example.com')).rejects.toThrow(
      /truncated|could not be decrypted/,
    );
  });

  it('non-base64 garbage is rejected', async () => {
    const file = path();
    writeFileSync(file, 'this is not base64 at all !!!', 'utf8');
    const reader = new TokenStore({ path: file, key: KEY });
    await expect(reader.get('notion', 'https://auth.example.com')).rejects.toBeDefined();
  });

  it('a malformed key never appears in the error', async () => {
    const file = path();
    await seeded(file);
    const reader = new TokenStore({ path: file, key: randomBytes(31) });
    const keyB64 = randomBytes(31).toString('base64');
    const reader2 = new TokenStore({ path: file, key: Buffer.from(keyB64, 'base64') });

    let message = '';
    try {
      await reader.get('notion', 'https://auth.example.com');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(KEY.toString('base64'));
    expect(message).not.toContain(CANARY);

    // And a store constructed directly with a short key simply cannot decrypt.
    await expect(reader2.get('notion', 'https://auth.example.com')).rejects.toBeDefined();
  });

  it('no plaintext is returned on ANY failure path', async () => {
    const cases: Array<{ label: string; make: (file: string) => void }> = [
      { label: 'wrong key', make: () => undefined },
      { label: 'truncated', make: (file) => { const e = readFileSync(file, 'utf8'); writeFileSync(file, e.slice(0, 20), 'utf8'); } },
      { label: 'flipped ciphertext byte', make: (file) => {
        const all = Buffer.from(readFileSync(file, 'utf8'), 'base64');
        const last = all.length - 1;
        all[last] = (all[last] ?? 0) ^ 0xff;
        writeFileSync(file, all.toString('base64'), 'utf8');
      } },
    ];

    for (const testCase of cases) {
      const file = path();
      await seeded(file);
      testCase.make(file);
      const reader = new TokenStore({ path: file, key: testCase.label === 'wrong key' ? OTHER_KEY : KEY });
      await expect(
        reader.get('notion', 'https://auth.example.com'),
        `${testCase.label} must not resolve`,
      ).rejects.toBeDefined();
      // The on-disk file still holds no plaintext either.
      expect(readFileSync(file, 'utf8')).not.toContain(CANARY);
    }
  });

  it('a missing file is an empty store, not an error', async () => {
    // The one case that is NOT a failure: a deployment that has never authorized anything.
    const file = path();
    expect(existsSync(file)).toBe(false);
    const store = new TokenStore({ path: file, key: KEY });
    expect(await store.get('notion', 'https://auth.example.com')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('an unsupported format version is rejected', async () => {
    const file = path();
    await seeded(file);
    // Re-encrypt a payload that claims version 999, using the correct key.
    const { createCipheriv } = await import('node:crypto');
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', KEY, nonce);
    const body = Buffer.concat([cipher.update(JSON.stringify({ version: 999, records: {}, pending: {} }), 'utf8'), cipher.final()]);
    const encoded = Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
    writeFileSync(file, encoded, 'utf8');

    const reader = new TokenStore({ path: file, key: KEY });
    await expect(reader.get('notion', 'https://auth.example.com')).rejects.toThrow(/unsupported version/);
  });

  it('loadTokenKey rejects a malformed key before any file is touched', () => {
    expect(() => loadTokenKey({ GATEWAY_TOKEN_KEY: 'not base64 !!!' })).toThrow(/32 bytes/);
    expect(() => loadTokenKey({})).toThrow(/GATEWAY_TOKEN_KEY/);
    expect(TAG_BYTES).toBe(16);
  });
});