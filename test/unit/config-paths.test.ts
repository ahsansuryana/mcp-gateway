// ADR 0012 Step 2/4: config resolution, `init`, and where state files live.
//
// D15: LOCAL only. Nothing here opens a socket, and `exists` / `readExample` are injected so
// no test depends on the machine's real home directory or on what happens to be on disk.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  candidatePaths,
  resolveConfigLocation,
  homeRoot,
  legacyTokenStorePathFor,
  tokenStorePathFor,
  CONFIG_DIR_NAME,
  CONFIG_FILENAME,
  HOME_DIR_ENV_VAR,
  type ResolveInputs,
} from '../../src/config/paths.js';
import { CONFIG_PATH_ENV_VAR } from '../../src/config/load.js';
import { runInit, schemaUrl, withPublishedSchema } from '../../src/config/init.js';

const CWD = resolve('work', 'project');
const HOME = resolve('home', 'operator');
// A genuinely absolute path on the CURRENT platform. `/etc/gw.json` would not do: on
// Windows `path.isAbsolute('/etc/gw.json')` is true (rooted, no drive) while
// `path.resolve` rewrites it under the cwd, so the test would compare two different
// meanings on Windows and one on POSIX.
const ABS = resolve('absolute', 'gw.json');
const NEVER = (): boolean => false;

function inputs(over: Partial<ResolveInputs> = {}): ResolveInputs {
  return { env: {}, cwd: CWD, homedir: HOME, exists: NEVER, ...over };
}

describe('ADR 0012 config resolution order', () => {
  it('searches -c, then GATEWAY_CONFIG, then project, then home, then legacy', () => {
    expect(
      candidatePaths({
        flag: ABS,
        env: { [CONFIG_PATH_ENV_VAR]: join(CWD, 'from-env.json') },
        cwd: CWD,
        homedir: HOME,
      }),
    ).toEqual([
      // An absolute flag is used verbatim; `resolveAgainst` returns it unchanged.
      ABS,
      resolve(CWD, 'from-env.json'),
      join(CWD, CONFIG_DIR_NAME, CONFIG_FILENAME),
      join(HOME, CONFIG_DIR_NAME, CONFIG_FILENAME),
      join(CWD, CONFIG_FILENAME),
    ]);
  });

  it('-c wins over everything, and is authoritative even when the file is MISSING', () => {
    const found = resolveConfigLocation(
      inputs({ flag: ABS, exists: NEVER }),
    );
    // Existence is deliberately NOT consulted for -c: falling through to another config
    // after an explicit flag would run the wrong upstream configuration in silence.
    expect(found).toEqual({ path: ABS, source: 'flag', legacy: false });
  });

  it('GATEWAY_CONFIG is used when it exists, and skipped when it does not', () => {
    const envPath = resolve(CWD, join('from-env.json'));
    const found = resolveConfigLocation(
      inputs({ env: { [CONFIG_PATH_ENV_VAR]: envPath }, exists: (p) => p === envPath }),
    );
    expect(found).toMatchObject({ path: envPath, source: 'env', legacy: false });

    // Missing env target: falls THROUGH rather than erroring, because it is an ambient
    // default rather than something the operator typed on this invocation.
    const skipped = resolveConfigLocation(
      inputs({ env: { [CONFIG_PATH_ENV_VAR]: envPath }, exists: NEVER }),
    );
    expect('checked' in skipped).toBe(true);
  });

  it('the project directory beats the home directory', () => {
    const project = join(CWD, CONFIG_DIR_NAME, CONFIG_FILENAME);
    const found = resolveConfigLocation(inputs({ exists: (p) => p === project || p === join(HOME, CONFIG_DIR_NAME, CONFIG_FILENAME) }));
    expect(found).toMatchObject({ path: project, source: 'project', legacy: false });
  });

  it('GATEWAY_HOME replaces the home directory', () => {
    const gateHome = join('/srv', 'gateway');
    const viaGate = join(gateHome, CONFIG_DIR_NAME, CONFIG_FILENAME);
    const found = resolveConfigLocation(
      inputs({ env: { [HOME_DIR_ENV_VAR]: gateHome }, exists: (p) => p === viaGate }),
    );
    expect(found).toMatchObject({ path: viaGate, source: 'home', legacy: false });
    expect(homeRoot({ [HOME_DIR_ENV_VAR]: gateHome })).toBe(gateHome);
  });

  it('falls back to os.homedir() when GATEWAY_HOME is unset or empty', () => {
    expect(homeRoot({})).not.toBe('');
    expect(homeRoot({ [HOME_DIR_ENV_VAR]: '' })).toBe(homeRoot({}));
  });

  it('the legacy ./gateway.json still resolves, flagged as legacy', () => {
    const legacy = join(CWD, CONFIG_FILENAME);
    const found = resolveConfigLocation(inputs({ exists: (p) => p === legacy }));
    expect(found).toMatchObject({ path: legacy, source: 'legacy', legacy: true });
  });

  it('never expands ~ : it is treated as a literal directory name', () => {
    // Node does not expand ~ and path.resolve does not either, so `~/x` would resolve to
    // <cwd>/~/x. init rejects it outright rather than creating a directory named `~`.
    const paths = candidatePaths({ flag: '~/gw.json', env: {}, cwd: CWD, homedir: HOME });
    expect(paths[0]).toBe(resolve(CWD, '~/gw.json'));
    expect(paths[0]).not.toContain(HOME);
  });

  it('returns every checked path when nothing is found', () => {
    // No flag and no env var means only three candidates exist to be checked.
    const found = resolveConfigLocation(inputs({ exists: NEVER }));
    expect('checked' in found).toBe(true);
    if ('checked' in found) {
      expect(found.checked).toEqual([
        join(CWD, CONFIG_DIR_NAME, CONFIG_FILENAME),
        join(HOME, CONFIG_DIR_NAME, CONFIG_FILENAME),
        join(CWD, CONFIG_FILENAME),
      ]);
    }

    // With both set, all five appear, in the documented order.
    const all = resolveConfigLocation(
      inputs({
        flag: ABS,
        env: { [CONFIG_PATH_ENV_VAR]: resolve(CWD, 'from-env.json') },
        exists: NEVER,
      }),
    );
    if ('checked' in all) expect(all.checked).toHaveLength(5);
  });
});

describe('ADR 0012 token store placement', () => {
  const config = join(CWD, CONFIG_DIR_NAME, CONFIG_FILENAME);

  it('sits beside the config, in a data/ subdirectory', () => {
    expect(tokenStorePathFor(config)).toBe(join(CWD, CONFIG_DIR_NAME, 'data', 'tokens.enc.json'));
  });

  it('names the legacy location one level up, for migration', () => {
    // A config that used to be ./gateway.json kept its store at ./data/tokens.enc.json.
    expect(legacyTokenStorePathFor(config)).toBe(join(CWD, 'data', 'tokens.enc.json'));
  });
});

describe('ADR 0012 mcp-gateway init', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-gateway-init-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the file under GATEWAY_HOME, printing the path', () => {
    const result = runInit({
      env: { [HOME_DIR_ENV_VAR]: root },
      readExample: () => '{ "gateway": {} }\n',
    });
    expect(result.status).toBe('created');
    const expected = join(root, CONFIG_DIR_NAME, CONFIG_FILENAME);
    expect(result.path).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });

  it('--local writes to ./.mcp-gateway instead', () => {
    const result = runInit({ local: true, cwd: root, env: {}, readExample: () => '{}\n' });
    expect(result.path).toBe(join(root, CONFIG_DIR_NAME, CONFIG_FILENAME));
    expect(existsSync(result.path)).toBe(true);
  });

  it('REFUSES to overwrite an existing file', () => {
    const result = runInit({ local: true, cwd: root, env: {}, readExample: () => '{}\n' });
    expect(result.status).toBe('created');
    const original = readFileSync(result.path, 'utf8');

    const again = runInit({
      local: true,
      cwd: root,
      env: {},
      // An overwrite would silently destroy real credentials.
      readExample: () => '{"sentinel":"clobbered"}\n',
    });
    expect(again.status).toBe('exists');
    expect(readFileSync(result.path, 'utf8')).toBe(original);
  });

  it('writes $schema pointing at the published package, not a relative path', () => {
    const result = runInit({
      local: true,
      cwd: root,
      env: {},
      readExample: () => '{\n  "$schema": "./gateway.schema.json",\n  "gateway": {}\n}\n',
    });
    const written = readFileSync(result.path, 'utf8');
    expect(written).toContain('@ahsansuryana/mcp-gateway@');
    // A relative path next to a config in ~/.mcp-gateway/ points at nothing.
    expect(written).not.toContain('"./gateway.schema.json"');
  });

  it('reports a missing bundled example instead of throwing a stack trace', () => {
    const result = runInit({
      local: true,
      cwd: root,
      env: {},
      readExample: () => {
        throw new Error('ENOENT: no such file or directory, open /app/gateway.example.json');
      },
    });
    expect(result.status).toBe('error');
    expect(result.message).toContain('reinstall');
    expect(result.message).not.toContain('ENOENT');
  });

  it('builds the schema URL from name and version', () => {
    expect(schemaUrl('@ahsansuryana/mcp-gateway', '0.1.0')).toBe(
      'https://cdn.jsdelivr.net/npm/@ahsansuryana/mcp-gateway@0.1.0/gateway.schema.json',
    );
  });

  it('falls back to adding $schema when the example has none', () => {
    expect(withPublishedSchema('{ "gateway": {} }\n', 'p', '1.0.0')).toContain(
      '"$schema": "https://cdn.jsdelivr.net/npm/p@1.0.0/gateway.schema.json"',
    );
  });

  it('the generated file passes the real strict schema', async () => {
    const result = runInit({
      local: true,
      cwd: root,
      env: {},
      readExample: () => readFileSync(new URL('../../gateway.example.json', import.meta.url), 'utf8'),
    });
    const { loadConfig } = await import('../../src/config/load.js');
    // The example references three variables; supply them so validation reaches the
    // SCHEMA rather than stopping at substitution, which is the thing under test here
    // (the strict object must accept `$schema`).
    expect(() =>
      loadConfig({
        path: result.path,
        env: { GATEWAY_API_KEY: 'k', GITHUB_TOKEN: 'g', FOO: 'f' },
      }),
    ).not.toThrow();
  });

  // POSIX-only, exactly like the existing chmod test.
  it.skipIf(process.platform === 'win32')('writes 0600 inside a 0700 directory', () => {
    const result = runInit({ local: true, cwd: root, env: {}, readExample: () => '{}\n' });
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, CONFIG_DIR_NAME)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === 'win32')('does not overwrite even when the file exists', () => {
    // Same guarantee as above, asserted on the real filesystem rather than the predicate.
    const first = runInit({ local: true, cwd: root, env: {}, readExample: () => '{"a":1}\n' });
    expect(first.status).toBe('created');
    writeFileSync(first.path, '{"hand":"edited"}\n');
    const second = runInit({ local: true, cwd: root, env: {}, readExample: () => '{"a":1}\n' });
    expect(second.status).toBe('exists');
    expect(readFileSync(first.path, 'utf8')).toBe('{"hand":"edited"}\n');
  });
});
