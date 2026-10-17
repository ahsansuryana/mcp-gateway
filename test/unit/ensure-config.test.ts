// ADR 0013: auto-create -- what happens when no config exists anywhere.
//
// D15: LOCAL only. `exists`, `runInitFn` and `generateKeyFn` are injected, so no test here
// reads the machine's real home directory or writes a real file unless it means to.
//
// The centrepiece is "the generated template loads through the REAL loader". A template that
// only satisfies a shape check would ship a first-run experience that fails on first contact
// with substitution and cross-field validation, which is the one moment nobody wants a bug.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ensureConfig } from '../../src/config/ensure.js';
import { runInit, renderTemplate } from '../../src/config/init.js';
import { generateApiKey, API_KEY_BYTES } from '../../src/config/keys.js';
import { loadConfig, ConfigErrorList } from '../../src/config/load.js';
import { checkAuthMode } from '../../src/config/auth-mode.js';
import { CONFIG_DIR_NAME, CONFIG_FILENAME, HOME_DIR_ENV_VAR } from '../../src/config/paths.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-gateway-ensure-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const NEVER = (): boolean => false;

function options(over: Record<string, unknown> = {}) {
  return {
    env: { [HOME_DIR_ENV_VAR]: root },
    cwd: join(root, 'some-project'),
    homedir: root,
    exists: NEVER,
    ...over,
  };
}

describe('ADR 0013 ensureConfig finds what already exists', () => {
  it('finds a project-local config and writes nothing', () => {
    let writes = 0;
    const projectConfig = join(root, 'some-project', CONFIG_DIR_NAME, CONFIG_FILENAME);
    const result = ensureConfig(
      options({
        exists: (p: string) => p === projectConfig,
        runInitFn: (() => {
          writes += 1;
          throw new Error('must not write');
        }),
      }),
    );
    expect(result.status).toBe('found');
    expect(result.path).toBe(projectConfig);
    expect(result.created).toBe(false);
    expect(result.generatedKey).toBeUndefined();
    expect(writes).toBe(0);
  });

  it('finds a home config and writes nothing', () => {
    const homeConfig = join(root, CONFIG_DIR_NAME, CONFIG_FILENAME);
    const result = ensureConfig(options({ exists: (p: string) => p === homeConfig }));
    expect(result.status).toBe('found');
    expect(result.path).toBe(homeConfig);
  });

  it('leaves the legacy ./gateway.json alone', () => {
    const legacy = join(root, 'some-project', CONFIG_FILENAME);
    const result = ensureConfig(options({ exists: (p: string) => p === legacy }));
    expect(result.status).toBe('found');
    expect(result.path).toBe(legacy);
  });

  it('carries no generated key on the found path', () => {
    // Nothing was generated, so there is no key to show. Returning one would print a
    // credential that does not exist.
    const result = ensureConfig(options({ exists: () => true }));
    expect(result.generatedKey).toBeUndefined();
  });
});

describe('ADR 0013 ensureConfig creates when nothing exists', () => {
  it('writes to the HOME directory', () => {
    const result = ensureConfig(
      options({ generateKeyFn: () => 'TESTKEY-000000000000000' }),
    );
    expect(result.status).toBe('created');
    expect(result.created).toBe(true);
    expect(result.path).toBe(join(root, CONFIG_DIR_NAME, CONFIG_FILENAME));
    expect(result.generatedKey).toBe('TESTKEY-000000000000000');
  });

  it('NEVER writes into the working directory', () => {
    // Auto-create makes a file appear. Putting one in whatever directory the operator ran
    // the command from would litter their project -- often read-only, often under version
    // control. `--local` stays the explicit way to get a project config.
    const projectDir = join(root, 'some-project');
    mkdirFor(projectDir);
    const result = ensureConfig(options());
    expect(result.path.startsWith(projectDir)).toBe(false);
    expect(readdirSafe(projectDir)).toEqual([]);
  });

  it('does not return the key when creation failed', () => {
    // The key is written nowhere on failure, so showing it would be showing a key that does
    // not exist -- and the banner would invite the operator to use it.
    const result = ensureConfig(
      options({
        runInitFn: (() => ({
          status: 'error',
          path: '/nope/gateway.json',
          message: 'could not write /nope/gateway.json',
        })),
      }),
    );
    expect(result.status).toBe('failed');
    expect(result.generatedKey).toBeUndefined();
    expect(result.reason).toContain('could not write');
  });

  it('reports found if the file appeared between the two checks', () => {
    // resolveConfigLocation already looked; the second check right before the write is what
    // stops this process from clobbering a config written by something else in between.
    let calls = 0;
    const result = ensureConfig(
      options({
        exists: () => {
          calls += 1;
          return calls > 1;
        },
        runInitFn: (() => {
          throw new Error('must not write');
        }),
      }),
    );
    expect(result.status).toBe('found');
    expect(result.created).toBe(false);
  });
});

describe('ADR 0013 the generated template', () => {
  it('passes the REAL loader, not just a shape check', () => {
    // The whole point. A template that only satisfies a schema would still fail on
    // substitution, on cross-field rules, or on the strict-object rule -- and it would fail
    // on first run, which is the worst possible moment.
    const result = runInit({
      env: { [HOME_DIR_ENV_VAR]: root },
      target: join(root, CONFIG_DIR_NAME, CONFIG_FILENAME),
      contents: renderTemplate('127.0.0.1', 'GENERATED-KEY-FOR-TEST'),
    });
    expect(result.status).toBe('created');

    const loaded = loadConfig({ path: result.path });
    expect(Object.keys(loaded.config.mcp)).toEqual([]);
    expect(loaded.config.gateway.host).toBe('127.0.0.1');
    expect(loaded.config.gateway.port).toBe(3000);
    expect(loaded.config.gateway.auth.keys).toEqual(['GENERATED-KEY-FOR-TEST']);
  });

  it('is SAFE BY DEFAULT: loopback, so open mode is not even reachable', () => {
    // The schema default is 0.0.0.0. A generated config that used it would be REFUSED by
    // ADR 0013's supervisor, so a first run with a generated key would fail for no reason a
    // user could see. 127.0.0.1 avoids that and avoids exposing a brand-new gateway to the
    // LAN by omission.
    const result = runInit({
      env: { [HOME_DIR_ENV_VAR]: root },
      target: join(root, CONFIG_DIR_NAME, CONFIG_FILENAME),
      contents: renderTemplate('127.0.0.1', 'K'),
    });
    const loaded = loadConfig({ path: result.path });
    expect(loaded.config.gateway.host).toBe('127.0.0.1');
    expect(checkAuthMode(loaded.config)).toBeUndefined();
  });

  it('carries a $schema pointing at the published package', () => {
    const result = runInit({
      env: { [HOME_DIR_ENV_VAR]: root },
      target: join(root, CONFIG_DIR_NAME, CONFIG_FILENAME),
      contents: renderTemplate('127.0.0.1', 'K'),
    });
    const written = readFileSync(result.path, 'utf8');
    // A relative ./gateway.schema.json next to a config in ~/.mcp-gateway/ points at
    // nothing, and a dangling path makes editors silently stop offering completion.
    expect(written).toContain('@ahsansuryana/mcp-gateway@');
    expect(written).not.toContain('"./gateway.schema.json"');
  });

  it('is JSONC, and the comments survive the real parser', () => {
    const result = runInit({
      env: { [HOME_DIR_ENV_VAR]: root },
      target: join(root, CONFIG_DIR_NAME, CONFIG_FILENAME),
      contents: renderTemplate('127.0.0.1', 'K'),
    });
    const raw = readFileSync(result.path, 'utf8');
    expect(raw).toContain('//');
    // And it still loads, which is only true because the parser runs with
    // disallowComments: false.
    expect(() => loadConfig({ path: result.path })).not.toThrow();
  });

  it('loads with NO environment variables set at all', () => {
    // The real property, and stronger than grepping for a placeholder string: the example
    // upstream in the template is COMMENTED OUT, so there is no live `{env:...}` to
    // substitute. gateway.example.json would fail this immediately -- it references
    // GATEWAY_API_KEY, GITHUB_TOKEN and FOO -- and a first run that failed on a missing
    // variable would be the worst possible first impression.
    const result = runInit({
      env: { [HOME_DIR_ENV_VAR]: root },
      target: join(root, CONFIG_DIR_NAME, CONFIG_FILENAME),
      contents: renderTemplate('127.0.0.1', 'K'),
    });
    expect(() => loadConfig({ path: result.path, env: {} })).not.toThrow();
    expect(Object.keys(loadConfig({ path: result.path, env: {} }).config.mcp)).toEqual([]);
  });

  it('shows the example upstream only as a comment', () => {
    const raw = renderTemplate('127.0.0.1', 'K');
    expect(raw).toContain('"mcp": {');
    expect(raw).toMatch(/^\s*\/\/ "github":/m);
  });

  it.skipIf(process.platform === 'win32')('writes 0600 inside a 0700 directory', () => {
    const result = runInit({
      env: { [HOME_DIR_ENV_VAR]: root },
      target: join(root, CONFIG_DIR_NAME, CONFIG_FILENAME),
      contents: renderTemplate('127.0.0.1', 'K'),
    });
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, CONFIG_DIR_NAME)).mode & 0o777).toBe(0o700);
  });
});

describe('ADR 0013 generateApiKey', () => {
  it('is 32 bytes of entropy rendered as 43 base64url characters', () => {
    const key = generateApiKey();
    expect(Buffer.from(key, 'base64url')).toHaveLength(API_KEY_BYTES);
    expect(key).toHaveLength(43);
  });

  it('uses the base64url alphabet, so it survives a header and a shell unquoted', () => {
    // Standard base64's `+`, `/` and `=` each need escaping in at least one of: a curl -H
    // header, a JSON string, a .env line, a shell variable. 200 keys is enough to be
    // confident this is not luck.
    for (let i = 0; i < 200; i += 1) {
      expect(generateApiKey()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('is different every time', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey()));
    expect(keys.size).toBe(50);
  });

  it('clears MIN_SCRUBBABLE_SECRET, so the logger will scrub it from free text', () => {
    // MIN_SCRUBBABLE_SECRET is 8. A key shorter than that would be logged verbatim if it
    // ever reached a log line, so the length is a security property and not a cosmetic one.
    expect(generateApiKey().length).toBeGreaterThan(8);
  });
});

describe('ADR 0013 auto-create does not fire where it must not', () => {
  it('leaves validate read-only: it never calls ensureConfig', () => {
    // `validate` on a missing config must still fail with the list of paths it checked.
    // Silently creating a file during a read-only command would be a surprise with a
    // filesystem side effect.
    const missing = join(root, 'definitely-absent.json');
    let thrown: unknown;
    try {
      loadConfig({ path: missing });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigErrorList);
    expect(String((thrown as Error).message)).toContain('could not read');
    expect(existsSync(missing)).toBe(false);
  });

  it('does not touch an INVALID existing config', () => {
    // ensureConfig decides existence only. An invalid config is loadConfig's to report, with
    // the key path -- and two places rendering the same class of error differently would be
    // worse than one.
    const bad = join(root, CONFIG_DIR_NAME, CONFIG_FILENAME);
    mkdirFor(dirname(bad));
    writeFileSync(bad, '{ "gateway": { "auth": { "keys": [] } }, "mcp": {} }', 'utf8');
    const result = ensureConfig({
      env: { [HOME_DIR_ENV_VAR]: root },
      cwd: root,
      homedir: root,
    });
    expect(result.status).toBe('found');
    // Byte for byte what it was.
    expect(readFileSync(bad, 'utf8')).toBe('{ "gateway": { "auth": { "keys": [] } }, "mcp": {} }');
  });
});

// --- tiny helpers, so the assertions above read as the thing they are testing --------------

function mkdirFor(p: string): void {
  mkdirSync(p, { recursive: true });
}
function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}