// PLAN.md S7.1: hot reload.
//
//   an invalid new config keeps the old one running and logs the error (key paths only);
//   SIGHUP triggers a reload;
//   upstreams are added, removed and changed;
//   credentials and tokens of UNCHANGED OAuth upstreams survive.
//
// D15: LOCAL fake only.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';

import { ConfigReloader, diffUpstreams } from '../../src/server/reload.js';
import { configDigest } from '../../src/server/config-digest.js';
import { createLogger } from '../../src/observability/logger.js';
import { gatewayConfigSchema, type GatewayConfig } from '../../src/config/schema.js';
import { TokenStore, TOKEN_KEY_BYTES } from '../../src/auth/oauth-client/token-store.js';
import { startGateway, type RunningGateway } from '../../src/index.js';
import { unusedPort } from '../fixtures/fake-upstream.js';
import { startFakeAuthServer, type FakeAuthServer } from '../fixtures/fake-auth-server.js';
import { OAuthService } from '../../src/auth/oauth-client/service.js';

const API_KEY = 'S71-CANARY-KEY-0123456789';
const SECRET_CANARY = 'S71-SECRET-CANARY-must-never-appear';

let dir: string;
let port: number;
let configPath: string;
let logLines: string[];
let applied: GatewayConfig[];

function logger() {
  return createLogger({
    level: 'debug',
    secrets: [SECRET_CANARY],
    destination: new Writable({
      write(chunk, _enc, cb) {
        logLines.push(String(chunk));
        cb();
      },
    }),
  });
}

function write(mcp: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        gateway: {
          host: '127.0.0.1',
          port,
          auth: { type: 'bearer', keys: [API_KEY] },
          defaultTimeoutMs: 5_000,
          defaultTtlMs: 30_000,
          ...extra,
        },
        mcp,
      },
      null,
      2,
    ),
    'utf8',
  );
}

function parse(): GatewayConfig {
  return gatewayConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-s71-'));
  port = await unusedPort();
  configPath = join(dir, 'gateway.json');
  logLines = [];
  applied = [];
  write({ alpha: { type: 'remote', url: 'http://127.0.0.1:1/mcp', timeout: 1_000 } });
});

afterEach(() => {
  for (const line of logLines) {
    if (line.includes(SECRET_CANARY)) throw new Error('a secret reached a log line');
  }
});

describe('S7.1 diffing', () => {
  it('detects added, removed and changed upstreams', () => {
    const base = { ...parse().mcp['alpha']! };
    const before: GatewayConfig = {
      mcp: {
        alpha: base,
        delta: base,
        doomed: base,
      },
    } as unknown as GatewayConfig;
    const after: GatewayConfig = {
      mcp: {
        // unchanged
        alpha: base,
        // changed: same name, different timeout
        delta: { ...base, timeout: 9_000 },
        // added
        fresh: base,
      },
    } as unknown as GatewayConfig;

    const diff = diffUpstreams(before, after);
    // An upstream cannot be both added and changed: it did not exist before.
    expect(diff.added).toEqual(['fresh']);
    expect(diff.removed).toEqual(['doomed']);
    expect(diff.changed).toEqual(['delta']);
  });

  it('a byte-identical reparse is not a change', () => {
    const base = parse();
    expect(diffUpstreams(base, JSON.parse(JSON.stringify(base)) as GatewayConfig)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it('an identical config digests identically regardless of key order', () => {
    expect(configDigest({ a: 1, b: 2 })).toBe(configDigest({ b: 2, a: 1 }));
  });

  it('a real change digests differently', () => {
    expect(configDigest({ a: 1 })).not.toBe(configDigest({ a: 2 }));
  });
});

describe('S7.1 the reloader', () => {
  function reloader(): ConfigReloader {
    return new ConfigReloader(
      { path: configPath, logger: logger(), apply: (c) => { applied.push(c); }, debounceMs: 5 },
      parse(),
    );
  }

  it('applies a valid change', async () => {
    const r = reloader();
    write({
      alpha: { type: 'remote', url: 'http://127.0.0.1:1/mcp', timeout: 1_000 },
      beta: { type: 'remote', url: 'http://127.0.0.1:2/mcp', timeout: 1_000 },
    });
    const result = await r.reload();
    expect(result.outcome).toBe('applied');
    expect(result.added).toEqual(['beta']);
    expect(applied).toHaveLength(1);
  });

  it('reports "unchanged" when the file is rewritten with the same content', async () => {
    const r = reloader();
    write({
      alpha: { type: 'remote', url: 'http://127.0.0.1:1/mcp', timeout: 1_000 },
    });
    // Same values, different formatting and key order.
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(/\s+/g, ' '), 'utf8');
    expect((await r.reload()).outcome).toBe('unchanged');
    expect(applied).toHaveLength(0);
  });

  it('an INVALID config keeps the old one running', async () => {
    const r = reloader();
    writeFileSync(configPath, '{ this is not json', 'utf8');
    const result = await r.reload();
    expect(result.outcome).toBe('rejected');
    // Nothing was applied: the running config is untouched.
    expect(applied).toHaveLength(0);
    expect(r.config.mcp['alpha']).toBeDefined();
  });

  it('a schema violation is rejected and names the KEY PATH only', async () => {
    const r = reloader();
    write({ alpha: { type: 'remote', url: 'not-a-url', timeout: 1_000 } });
    const result = await r.reload();
    expect(result.outcome).toBe('rejected');
    expect(applied).toHaveLength(0);

    const output = logLines.join('\n');
    expect(output).toContain('rejected');
    // The reason may name the key path...
    expect(output).toMatch(/mcp\.alpha\.url|gateway\./);
    // ...and must never carry a value.
    expect(output).not.toContain(SECRET_CANARY);
  });

  it('an apply() failure is also rejected and does not corrupt the running config', async () => {
    const r = new ConfigReloader(
      {
        path: configPath,
        logger: logger(),
        apply: () => {
          throw new TypeError('boom');
        },
        debounceMs: 5,
      },
      parse(),
    );
    write({ alpha: { type: 'remote', url: 'http://127.0.0.1:9/mcp', timeout: 1_000 } });
    const result = await r.reload();
    expect(result.outcome).toBe('rejected');
    expect((r.config.mcp['alpha'] as { url: string }).url).toBe('http://127.0.0.1:1/mcp');
  });
});

describe('S7.1 unchanged OAuth upstreams keep their credentials', () => {
  let as: FakeAuthServer;
  let store: TokenStore;
  let service: OAuthService;
  let gateway: RunningGateway;

  beforeEach(async () => {
    store = new TokenStore({
      path: join(dir, 'tokens.enc.json'),
      key: randomBytes(TOKEN_KEY_BYTES),
    });
    as = await startFakeAuthServer({ port: await unusedPort() });

    // Seed a credential as a real consent flow would.
    service = new OAuthService({
      config: {
        gateway: {
          host: '127.0.0.1',
          port: 4000,
          auth: { type: 'bearer', keys: [API_KEY] },
          defaultTimeoutMs: 5_000,
          defaultTtlMs: 30_000,
          legacyEra: 'stateless',
        },
        mcp: { notion: { type: 'remote', url: as.url, headers: {}, enabled: true, oauth: {} } },
      },
      store,
      logger: logger(),
      port: 3000,
    });
    const start = await service.start('notion');
    const authorizeUrl = new URL(start.url!);
    const authRes = await fetch(authorizeUrl.href);
    const { code } = (await authRes.json()) as { code: string };
    await service.callback({
      code,
      state: authorizeUrl.searchParams.get('state')!,
      iss: as.issuer,
    });
  }, 60_000);

  afterEach(async () => {
    await gateway?.stop();
    await as?.close();
  }, 30_000);

  it('a reload that does not touch the oauth entry keeps the stored token', async () => {
    expect(await store.get('notion', as.issuer)).toBeDefined();
    const tokenBefore = (await store.get('notion', as.issuer))?.accessToken;

    const configFile = join(dir, 'live.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        gateway: {
          host: '127.0.0.1',
          port: await unusedPort(),
          auth: { type: 'bearer', keys: [API_KEY] },
          defaultTimeoutMs: 5_000,
          defaultTtlMs: 30_000,
        },
        mcp: { notion: { type: 'remote', url: as.url, timeout: 4_000, oauth: {} } },
      }),
      'utf8',
    );
    process.env['GATEWAY_TOKEN_KEY'] = randomBytes(TOKEN_KEY_BYTES).toString('base64');
    gateway = await startGateway({
      configPath: configFile,
      logLevel: 'silent',
      tokenStorePath: store.path,
    });
    delete process.env['GATEWAY_TOKEN_KEY'];

    // Add an UNRELATED upstream. The oauth entry is byte-identical and must not be
    // restarted, which is what preserves the token.
    writeFileSync(
      configFile,
      JSON.stringify({
        gateway: {
          host: '127.0.0.1',
          port: JSON.parse(readFileSync(configFile, 'utf8')).gateway.port,
          auth: { type: 'bearer', keys: [API_KEY] },
          defaultTimeoutMs: 5_000,
          defaultTtlMs: 30_000,
        },
        mcp: {
          notion: { type: 'remote', url: as.url, timeout: 4_000, oauth: {} },
          other: { type: 'remote', url: 'http://127.0.0.1:1/mcp', timeout: 1_000 },
        },
      }),
      'utf8',
    );

    const result = await gateway.reloader.reload();
    expect(result.outcome).toBe('applied');
    expect(result.added).toEqual(['other']);
    // Crucially: `notion` is in neither list, so it was never restarted.
    expect(result.changed).toEqual([]);
    expect(result.removed).toEqual([]);

    // The credential is still there, and still usable.
    const after = await store.get('notion', as.issuer);
    expect(after?.accessToken).toBe(tokenBefore);
  }, 60_000);

  it('a reload that CHANGES the oauth entry is reported as changed', async () => {
    const configFile = join(dir, 'live2.json');
    const base = {
      gateway: {
        host: '127.0.0.1',
        port: 4000,
        auth: { type: 'bearer', keys: [API_KEY] },
        defaultTimeoutMs: 5_000,
        defaultTtlMs: 30_000,
      },
      mcp: { notion: { type: 'remote', url: as.url, headers: {}, enabled: true, oauth: {} } },
    };
    writeFileSync(configFile, JSON.stringify(base), 'utf8');
    const r = new ConfigReloader(
      { path: configFile, logger: logger(), apply: () => undefined, debounceMs: 5 },
      gatewayConfigSchema.parse(base),
    );
    writeFileSync(
      configFile,
      JSON.stringify({
        ...base,
        mcp: {
          notion: { ...base.mcp.notion, timeout: 30_000 },
        },
      }),
      'utf8',
    );
    const result = await r.reload();
    expect(result.outcome).toBe('applied');
    expect(result.changed).toEqual(['notion']);
  }, 30_000);
});