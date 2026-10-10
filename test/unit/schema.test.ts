import { describe, expect, it } from 'vitest';

import { gatewayConfigSchema, MAX_TOOL_NAME_LENGTH, SERVER_NAME_PATTERN } from '../../src/config/schema.js';
import { parseConfig } from '../../src/config/load.js';

const CANARY = 'SECRET-CANARY-123';

const base = () => ({
  gateway: { auth: { type: 'bearer', keys: [CANARY] } },
  mcp: {} as Record<string, unknown>,
});

/** Parses a document, substituting `{env:...}` from `env` without touching the filesystem. */
function validate(document: unknown, env: Record<string, string> = {}) {
  return parseConfig(JSON.stringify(document), 'test.json', { env, readFile: () => '' });
}

describe('PLAN.md §6 schema', () => {
  it('applies the documented defaults', () => {
    const { config } = validate(base());
    expect(config.gateway.host).toBe('0.0.0.0');
    expect(config.gateway.port).toBe(3000);
    expect(config.gateway.defaultTimeoutMs).toBe(30_000);
    expect(config.gateway.defaultTtlMs).toBe(30_000);
    expect(config.gateway.auth.type).toBe('bearer');
    // ADR 0002, decided at the Sprint 0 gate.
    expect(config.gateway.legacyEra).toBe('stateless');
  });

  it('rejects unknown keys at every level (D7: strict objects)', () => {
    for (const [label, doc] of [
      ['root', { ...base(), nope: 1 }],
      ['gateway', { ...base(), gateway: { ...base().gateway, nope: 1 } }],
      ['auth', { ...base(), gateway: { auth: { type: 'bearer', keys: [CANARY], nope: 1 } } }],
      [
        'upstream',
        { ...base(), mcp: { gh: { type: 'remote', url: 'https://e.com', nope: 1 } } },
      ],
    ] as const) {
      let threw = false;
      try {
        validate(doc);
      } catch {
        threw = true;
      }
      expect(threw, `unknown key at ${label} must be rejected`).toBe(true);
    }
  });

  it('enforces the D4 server-name regex on upstream keys', () => {
    for (const good of ['a', 'github', 'my-server', 's3', 'a'.repeat(24)]) {
      expect(SERVER_NAME_PATTERN.test(good)).toBe(true);
    }
    // `-leading` is permitted: PLAN.md §6's regex is `^[a-z0-9-]{1,24}$` verbatim and it
    // allows a hyphen in first position. Not changed without a human decision.
    expect(SERVER_NAME_PATTERN.test('-leading')).toBe(true);
    for (const bad of ['Bad', 'has_underscore', 'a'.repeat(25), '', 'sp ace', 'dot.name']) {
      expect(SERVER_NAME_PATTERN.test(bad), `${bad} must not match`).toBe(false);
    }
    let threw = false;
    try {
      validate({ ...base(), mcp: { Bad_Name: { type: 'remote', url: 'https://e.com' } } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('keeps D4 at 64 characters for namespaced tool names', () => {
    expect(MAX_TOOL_NAME_LENGTH).toBe(64);
  });

  it('requires https for a non-localhost remote upstream', () => {
    for (const host of ['https://example.com/mcp', 'http://localhost:3000/mcp', 'http://127.0.0.1:3000/mcp', 'http://[::1]:3000/mcp']) {
      expect(() =>
        validate({ ...base(), mcp: { gh: { type: 'remote', url: host } } }),
      ).not.toThrow();
    }
    let threw = false;
    try {
      validate({ ...base(), mcp: { gh: { type: 'remote', url: 'http://example.com/mcp' } } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('validates the local `command` array rules', () => {
    expect(() =>
      validate({ ...base(), mcp: { fs: { type: 'local', command: ['npx', '-y', 'pkg'] } } }),
    ).not.toThrow();

    for (const bad of [[], [''], ['', 'x']]) {
      let threw = false;
      try {
        validate({ ...base(), mcp: { fs: { type: 'local', command: bad } } });
      } catch {
        threw = true;
      }
      expect(threw, `command ${JSON.stringify(bad)} must be rejected`).toBe(true);
    }
  });

  it('validates local lifecycle timeouts and their defaults', () => {
    const { config } = validate({
      ...base(),
      mcp: { fs: { type: 'local', command: ['npx', '-y', 'pkg'] } },
    });
    const fs = config.mcp['fs'];
    expect(fs?.type).toBe('local');
    if (fs?.type === 'local') {
      expect(fs.startupTimeoutMs).toBe(60_000);
      expect(fs.idleTimeoutMs).toBe(300_000);
    }
  });

  it('validates the timeout range (1000..600000)', () => {
    for (const good of [1000, 30_000, 600_000]) {
      expect(() =>
        validate({ ...base(), mcp: { gh: { type: 'remote', url: 'https://e.com', timeout: good } } }),
      ).not.toThrow();
    }
    for (const bad of [0, 999, 600_001, 1.5]) {
      let threw = false;
      try {
        validate({ ...base(), mcp: { gh: { type: 'remote', url: 'https://e.com', timeout: bad } } });
      } catch {
        threw = true;
      }
      expect(threw, `timeout ${bad} must be rejected`).toBe(true);
    }
  });

  it('accepts oauth as false or as an object, and rejects unknown oauth fields', () => {
    expect(() =>
      validate({ ...base(), mcp: { gh: { type: 'remote', url: 'https://e.com', oauth: false } } }),
    ).not.toThrow();
    expect(() =>
      validate({
        ...base(),
        mcp: {
          gh: {
            type: 'remote',
            url: 'https://e.com',
            oauth: { clientId: 'id', clientSecret: 's', scope: 'a b' },
          },
        },
      }),
    ).not.toThrow();
    let threw = false;
    try {
      validate({
        ...base(),
        mcp: { gh: { type: 'remote', url: 'https://e.com', oauth: { nope: 'x' } } },
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('requires at least one inbound bearer key', () => {
    let threw = false;
    try {
      validate({ ...base(), gateway: { auth: { type: 'bearer', keys: [] } } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('never surfaces a secret value in a validation error', () => {
    let text = '';
    try {
      validate({
        gateway: { auth: { type: 'bearer', keys: [CANARY] } },
        mcp: { gh: { type: 'remote', url: 'http://example.com/mcp', headers: { Authorization: CANARY } } },
      });
    } catch (err) {
      text = String(err);
    }
    expect(text).not.toContain(CANARY);
    expect(text).toContain('mcp.gh.url');
  });

  it('exposes the schema as a strict root object', () => {
    expect(gatewayConfigSchema.safeParse({}).success).toBe(false);
    expect(gatewayConfigSchema.safeParse({ ...base(), unknown: 1 }).success).toBe(false);
  });
});

describe('JSONC parsing', () => {
  it('accepts comments and trailing commas (D6)', () => {
    const doc = `{
      // a comment
      "gateway": { "auth": { "type": "bearer", "keys": ["${CANARY}"] }, },
      "mcp": {},
    }`;
    const { config } = parseConfig(doc, 'test.jsonc');
    expect(config.gateway.auth.keys).toEqual([CANARY]);
  });

  it('reports a parse error with a line number', () => {
    let text = '';
    try {
      parseConfig('{ "gateway": }', 'broken.json');
    } catch (err) {
      text = String(err);
    }
    // The file name is printed by the CLI header; the error itself carries the position.
    expect(text).toContain('<file>:1');
    expect(text).toContain('ValueExpected');
  });
});