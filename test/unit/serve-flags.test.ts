// ADR 0013: the runtime override flags.
//
// Pure argv handling, like src/cli.ts's `run()`: no process, no filesystem, no config. That
// is what makes every branch here reachable without spawning a gateway.

import { describe, expect, it } from 'vitest';

import { applyOverrides, parseServeFlags, UsageError, type ServeFlags } from '../../src/serve-flags.js';
import type { GatewayConfig } from '../../src/config/schema.js';

function flags(argv: readonly string[]): ServeFlags {
  const result = parseServeFlags(argv);
  if ('stderr' in result) throw new Error(`expected success, got: ${result.stderr}`);
  return result.flags;
}

function error(argv: readonly string[]): string {
  const result = parseServeFlags(argv);
  if (!('stderr' in result)) throw new Error(`expected a usage error, got ${JSON.stringify(result.flags)}`);
  return result.stderr;
}

function baseConfig(): GatewayConfig {
  return {
    gateway: {
      host: '127.0.0.1',
      port: 3000,
      auth: { type: 'bearer', keys: ['k'] },
      defaultTimeoutMs: 30_000,
      defaultTtlMs: 30_000,
      legacyEra: 'stateless',
    },
    mcp: {},
  };
}

describe('ADR 0013 flag forms', () => {
  it('accepts the spaced and the equals form of every flag', () => {
    expect(flags(['--hostname', '0.0.0.0'])).toEqual({ hostname: '0.0.0.0' });
    expect(flags(['--hostname=0.0.0.0'])).toEqual({ hostname: '0.0.0.0' });
    expect(flags(['--port', '3111'])).toEqual({ port: 3111 });
    expect(flags(['--port=3111'])).toEqual({ port: 3111 });
    expect(flags(['--public-url', 'https://x.example.com'])).toEqual({
      publicUrl: 'https://x.example.com',
    });
    expect(flags(['--public-url=https://x.example.com'])).toEqual({
      publicUrl: 'https://x.example.com',
    });
  });

  it('accepts them all at once, in any order', () => {
    expect(
      flags(['--hostname', '0.0.0.0', '--port=3111', '--public-url=https://y.example.com']),
    ).toEqual({ hostname: '0.0.0.0', port: 3111, publicUrl: 'https://y.example.com' });

    // Order must not matter, or `--port` would sometimes be read as --hostname's value.
    expect(
      flags(['--public-url=https://y.example.com', '--port', '3111', '--hostname=0.0.0.0']),
    ).toEqual({ hostname: '0.0.0.0', port: 3111, publicUrl: 'https://y.example.com' });
  });

  it('still parses -c and --config', () => {
    // These two forms must keep working: runValidate still calls parseConfigFlag, and the
    // serve path needs the same file.
    expect(flags(['-c', 'a.json'])).toEqual({ configPath: 'a.json' });
    expect(flags(['--config', 'a.json'])).toEqual({ configPath: 'a.json' });
    expect(flags(['--config=a.json'])).toEqual({ configPath: 'a.json' });
    expect(flags(['-c', 'a.json', '--hostname', '0.0.0.0'])).toEqual({
      configPath: 'a.json',
      hostname: '0.0.0.0',
    });
  });

  it('skips a leading `serve` command word', () => {
    // REGRESSION, caught by running the built CLI: `serve --port 0` answered
    // "unknown option: serve" and exited 2, because the command word reached the flag
    // parser. `serve` is documented as the spell-out-able default, so both spellings must
    // reach exactly the same parse result.
    expect(flags(['serve', '--port', '3001'])).toEqual({ port: 3001 });
    expect(flags(['serve', '--hostname=0.0.0.0', '-c', 'a.json'])).toEqual({
      configPath: 'a.json',
      hostname: '0.0.0.0',
    });
    expect(flags(['serve'])).toEqual({});
    // And the rejection path is still reachable with the command word present, which is
    // what the regression made impossible to observe.
    expect(error(['serve', '--port', '0'])).toContain('--port');
  });

  it('does not treat a flag value as a command word', () => {
    // `-c serve` is a path named "serve". Only a LEADING non-flag token is skipped.
    expect(flags(['-c', 'serve'])).toEqual({ configPath: 'serve' });
  });

  it('returns no keys at all for an empty argv', () => {
    // `{}` rather than `{hostname: undefined}`: applyOverrides must be able to tell
    // "not given" from "given as undefined", and an explicit undefined key would make
    // `'hostname' in flags` true.
    expect(flags([])).toEqual({});
    expect(Object.keys(flags([]))).toHaveLength(0);
  });
});

describe('ADR 0013 flag rejection', () => {
  it('rejects --port 0, which is how an ephemeral port would be asked for', () => {
    // Port 0 means "any free port" to the OS. Accepting it here would produce a banner full
    // of URLs nobody can call, since the caller cannot know the port in advance.
    expect(error(['--port', '0'])).toContain('--port');
    expect(error(['--port', '0'])).toContain('between 1 and 65535');
  });

  it('rejects a non-numeric or out-of-range --port', () => {
    expect(error(['--port', 'abc'])).toContain('--port');
    expect(error(['--port', '70000'])).toContain('65535');
    expect(error(['--port', '-1'])).toContain('--port');
  });

  it('rejects --port 3000abc rather than binding 3000', () => {
    // parseInt('3000abc') is 3000. Using it here would silently listen on a different port
    // than the operator typed, and the banner would show the typed one.
    expect(error(['--port', '3000abc'])).toContain('--port');
  });

  it('rejects a flag with no value', () => {
    expect(error(['--hostname'])).toContain('--hostname');
    expect(error(['--hostname='])).toContain('requires a value');
    expect(error(['--public-url='])).toContain('requires a value');
    expect(error(['-c'])).toContain('requires a path argument');
  });

  it('rejects an unknown flag instead of silently ignoring it', () => {
    // The old parseConfigFlag rejected unknown args, and that must not regress: a typo'd
    // --host would otherwise be ignored and the operator would think it applied.
    expect(error(['--host', '0.0.0.0'])).toContain('unknown option');
  });

  it('stops parsing at -- and ignores the rest', () => {
    expect(flags(['--hostname=0.0.0.0', '--', '--not-a-flag'])).toEqual({ hostname: '0.0.0.0' });
  });
});

describe('ADR 0013 applyOverrides', () => {
  it('overrides host, port and publicUrl', () => {
    const config = baseConfig();
    const next = applyOverrides(config, { hostname: '0.0.0.0', port: 3111, publicUrl: 'https://p.example' });
    expect(next.gateway.host).toBe('0.0.0.0');
    expect(next.gateway.port).toBe(3111);
    expect(next.gateway.publicUrl).toBe('https://p.example');
  });

  it('does NOT mutate the input', () => {
    // ConfigReloader digests the same object it holds. An in-place write would make it
    // observe a change that was never made on disk, and restart upstreams for it.
    const config = baseConfig();
    Object.freeze(config.gateway);
    applyOverrides(config, { hostname: '0.0.0.0', port: 9999, publicUrl: 'https://p.example' });
    expect(config.gateway.host).toBe('127.0.0.1');
    expect(config.gateway.port).toBe(3000);
    expect(config.gateway.publicUrl).toBeUndefined();
  });

  it('leaves publicUrl alone when the flag was not given', () => {
    const config = baseConfig();
    config.gateway.publicUrl = 'https://configured.example';
    const next = applyOverrides(config, { hostname: '127.0.0.1' });
    expect(next.gateway.publicUrl).toBe('https://configured.example');
  });

  it('returns an equivalent config for empty flags', () => {
    expect(applyOverrides(baseConfig(), {})).toEqual(baseConfig());
  });

  it('preserves auth keys and upstreams', () => {
    const config = baseConfig();
    const next = applyOverrides(config, { hostname: '0.0.0.0' });
    expect(next.gateway.auth.keys).toEqual(['k']);
    expect(next.mcp).toEqual({});
  });

  it('rejects a --public-url that is not an absolute http(s) URL', () => {
    // Caught here rather than in the schema: a bad value would otherwise reach the RFC 9728
    // document and fail much later, as an unparseable metadata fetch instead of a flag error.
    expect(() => applyOverrides(baseConfig(), { publicUrl: 'not-a-url' })).toThrow(UsageError);
    expect(() => applyOverrides(baseConfig(), { publicUrl: 'ftp://x.example' })).toThrow(UsageError);
    expect(() => applyOverrides(baseConfig(), { publicUrl: '/relative' })).toThrow(UsageError);
  });

  it('accepts both http and https', () => {
    // http is legitimate for a local tunnel target and for a LAN deployment behind the
    // operator's own TLS terminator.
    expect(applyOverrides(baseConfig(), { publicUrl: 'http://x.example' }).gateway.publicUrl).toBe(
      'http://x.example',
    );
    expect(applyOverrides(baseConfig(), { publicUrl: 'https://x.example' }).gateway.publicUrl).toBe(
      'https://x.example',
    );
  });
});