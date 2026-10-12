// ADR 0012 D3: state files live beside the config, and an existing store is never orphaned.
//
// The migration case is the one that matters operationally. A config that used to be
// ./gateway.json kept its store at ./data/tokens.enc.json. With the config now at
// ./.mcp-gateway/gateway.json the default moved to ./.mcp-gateway/data/tokens.enc.json. If
// the gateway silently started on an empty store it would look like a working gateway that
// had forgotten every credential, and every upstream would silently need re-consent.
//
// D15: LOCAL only.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';

import { TokenStore } from '../../src/auth/oauth-client/token-store.js';
import { createLogger } from '../../src/observability/logger.js';
import { startGateway, type RunningGateway } from '../../src/index.js';
import { unusedPort } from '../fixtures/fake-upstream.js';
import { CONFIG_PATH_ENV_VAR, CONFIG_DIR_NAME, CONFIG_FILENAME } from '../../src/config/paths.js';

const API_KEY = 'S12-CANARY-KEY-0123456789';
const TOKEN_KEY = randomBytes(32).toString('base64');

function upstreamWithOAuth(): { url: string } {
  return { url: 'https://oauth.example.invalid/mcp' };
}

describe('ADR 0012 token store directory permissions', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'creates the store directory 0700, not 0755 under the default umask',
    async () => {
      // `mkdir`'s mode is masked by the umask, so passing 0o700 alone would still yield
      // 0755 under umask 022. A world-readable directory defeats the 0600 on the file,
      // because it can be listed.
      const path = join(dir, 'nested', 'data', 'tokens.enc.json');
      const store = new TokenStore({ path, key: Buffer.from(TOKEN_KEY, 'base64') });
      await store.set('u', 'https://as.example.invalid', { accessToken: 'x', clientId: 'c' });

      expect(statSync(join(dir, 'nested', 'data')).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
    30_000,
  );
});

describe('ADR 0012 token store keeps an existing store at the old location', () => {
  let root: string;
  let gateway: RunningGateway;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-gateway-migrate-'));
  });
  afterEach(async () => {
    await gateway?.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  function writeConfig(configDir: string): string {
    const path = join(configDir, CONFIG_FILENAME);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        gateway: {
          host: '127.0.0.1',
          port,
          auth: { type: 'bearer', keys: [API_KEY] },
          // authOAuth derives its audience from publicUrl, and the gateway refuses to
          // start without it.
          publicUrl: 'https://gateway.example.invalid',
          authOAuth: {
            issuer: 'https://as.example.invalid',
            audience: 'https://gateway.example.invalid/mcp',
          },
          defaultTimeoutMs: 5_000,
          defaultTtlMs: 30_000,
        },
        mcp: { remote: { type: 'remote', url: upstreamWithOAuth().url, oauth: {} } },
      }),
      'utf8',
    );
    return path;
  }

  let port: number;

  it('reads the legacy store and warns, rather than starting empty', async () => {
    port = await unusedPort();
    const lines: string[] = [];

    // Pre-create a store at the OLD location: <configDir>/../data/tokens.enc.json
    const legacyDir = join(root, 'data');
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, 'tokens.enc.json');
    const seeded = new TokenStore({ path: legacyPath, key: Buffer.from(TOKEN_KEY, 'base64') });
    await seeded.set('remote', 'https://as.example.invalid', { accessToken: 'seeded-token', clientId: 'c' });

    const configDir = join(root, CONFIG_DIR_NAME);
    const configPath = writeConfig(configDir);

    process.env[TOKEN_KEY_ENV] = TOKEN_KEY;
    gateway = await startGateway({
      configPath,
      logger: createLogger({
        level: 'debug',
        destination: new Writable({
          write(chunk, _e, cb) {
            lines.push(String(chunk));
            cb();
          },
        }),
      }),
    });

    const output = lines.join('\n');
    // Still using the old file, and saying so.
    expect(output).toContain(legacyPath.replace(/\\/g, '\\\\'));
    expect(output).toContain('pre-.mcp-gateway location');
    // And it did NOT silently create an empty one at the new location.
    expect(existsSync(join(configDir, 'data', 'tokens.enc.json'))).toBe(false);

    // The credential is genuinely readable from the old file.
    const reader = new TokenStore({ path: legacyPath, key: Buffer.from(TOKEN_KEY, 'base64') });
    const value = await reader.get('remote', 'https://as.example.invalid');
    expect(value?.accessToken).toBe('seeded-token');

    expect(configPath).toContain(CONFIG_DIR_NAME);
    expect(CONFIG_PATH_ENV_VAR).toBe('GATEWAY_CONFIG');
  }, 60_000);

  it('uses the new location when no legacy store exists', async () => {
    port = await unusedPort();
    const configDir = join(root, CONFIG_DIR_NAME);
    const configPath = writeConfig(configDir);

    process.env[TOKEN_KEY_ENV] = TOKEN_KEY;
    gateway = await startGateway({ configPath, logger: createLogger({ level: 'silent' }) });

    // Nothing pre-existing, so the new default is used and no migration warning fires.
    expect(existsSync(join(configDir, 'data'))).toBe(false);
  }, 60_000);
});

const TOKEN_KEY_ENV = 'GATEWAY_TOKEN_KEY';