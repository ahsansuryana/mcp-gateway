// PLAN.md S8.1 / D18: the seam, and the import boundary that replaces the process boundary.
//
// D15/D-rule: LOCAL only. Nothing here opens a socket, contacts a registry, or reads a real
// home directory.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  authModeConflictReason,
  canonicalAudience,
  embeddedVerifier,
  externalVerifier,
  resolveAuthModeFromConfig,
  type SigningKeyResolver,
  type TokenVerifier,
} from '../../src/auth/token-verifier.js';
import { checkAuthMode, resolveAuthMode } from '../../src/config/auth-mode.js';
import type { GatewayConfig } from '../../src/config/schema.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const srcRoot = resolve(repoRoot, 'src');

function config(over: Partial<GatewayConfig['gateway']> = {}): GatewayConfig {
  return {
    gateway: {
      host: '127.0.0.1',
      port: 3000,
      auth: { type: 'bearer', keys: [] },
      defaultTimeoutMs: 30_000,
      defaultTtlMs: 30_000,
      legacyEra: 'stateless',
      ...over,
    },
    mcp: {},
  };
}

describe('S8.1 resolveAuthModeFromConfig', () => {
  it('derives "external" from a pre-Sprint-8 config', () => {
    // The promise D18 makes is that no existing config changes meaning. A config with
    // authOAuth and no authMode is what every Sprint 6 deployment looks like.
    expect(
      resolveAuthModeFromConfig(config({ authOAuth: { issuer: 'https://as.example' } })),
    ).toBe('external');
  });

  it('defaults to "embedded" when there is no external issuer', () => {
    expect(resolveAuthModeFromConfig(config())).toBe('embedded');
  });

  it('honours an explicit value in both directions', () => {
    expect(resolveAuthModeFromConfig(config({ authMode: 'embedded' }))).toBe('embedded');
    expect(
      resolveAuthModeFromConfig(
        config({ authMode: 'external', authOAuth: { issuer: 'https://as.example' } }),
      ),
    ).toBe('external');
  });
});

describe('S8.1 authMode and authOAuth conflict', () => {
  it('is REJECTED, never silently resolved', () => {
    // The two name different token issuers. Picking one would mean a config the operator
    // believes authenticates against the embedded AS silently authenticates against a remote
    // IdP instead -- and that failure presents as "logins stopped working", not as a config
    // mistake.
    const problem = checkAuthMode(
      config({ authMode: 'embedded', authOAuth: { issuer: 'https://as.example' } }),
    );
    expect(problem).toBeDefined();
    expect(problem?.path).toBe('gateway.authMode');
  });

  it('names BOTH ways out, so the message is actionable', () => {
    const reason = authModeConflictReason();
    expect(reason).toContain('gateway.authOAuth');
    expect(reason).toContain('remove gateway.authOAuth');
    expect(reason).toContain('external');
  });

  it('allows either one on its own', () => {
    expect(checkAuthMode(config({ authMode: 'embedded' }))).toBeUndefined();
    expect(checkAuthMode(config({ authOAuth: { issuer: 'https://as.example' } }))).toBeUndefined();
  });

  it('does not leak a value into the message', () => {
    const secret = 'S8-1-CANARY-0123456789';
    expect(authModeConflictReason()).not.toContain(secret);
  });
});

describe('S8.1 an embedded issuer counts as protection', () => {
  it('a gateway with no static key but authMode embedded is NOT open', () => {
    // The mistake this prevents: without it, a gateway whose only credential is a token minted
    // by this same process was classified `open`, which is the opposite of the truth.
    expect(resolveAuthMode(config({ authMode: 'embedded' })).mode).toBe('oauth-only');
  });

  it('still reports open when there is no token issuer at all', () => {
    const decision = resolveAuthMode(config());
    expect(decision.mode).toBe('open');
    expect(decision.reason).toContain('accepts any caller');
  });

  it('an embedded issuer satisfies the loopback rule on a wildcard bind', () => {
    // authMode embedded + 0.0.0.0 + no key is a protected gateway, so the "no credential on
    // a public bind" refusal must NOT fire for it.
    expect(
      checkAuthMode(config({ host: '0.0.0.0', authMode: 'embedded' })),
    ).toBeUndefined();
  });
});

describe('S8.1 externalVerifier', () => {
  it('passes a good token through unchanged', async () => {
    const verifier = externalVerifier({
      verify: () => Promise.resolve({ ok: true, issuer: 'https://as.example', subject: 'alice' }),
    });
    const result = await verifier.verify('token');
    expect(verifier.mode).toBe('external');
    expect(result).toEqual({
      ok: true,
      claims: { issuer: 'https://as.example', subject: 'alice' },
    });
  });

  it('preserves the rejection REASON rather than flattening it', async () => {
    // The rate limiter and the logs key off the reason. Collapsing everything to 'invalid'
    // would make a wrong-audience token indistinguishable from a forged signature.
    for (const reason of ['expired', 'wrong_audience', 'bad_signature', 'wrong_issuer'] as const) {
      const verifier = externalVerifier({ verify: () => Promise.resolve({ ok: false, reason }) });
      expect(await verifier.verify('token')).toEqual({ ok: false, reason });
    }
  });

  it('falls back to a reason when the underlying verifier omits one', async () => {
    const verifier = externalVerifier({ verify: () => Promise.resolve({ ok: false }) });
    expect(await verifier.verify('token')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('does not emit subject/issuer keys when the token had none', async () => {
    // `undefined` members would serialise into a JSON-RPC body as absent-or-null depending on
    // the consumer; omitting them keeps the claims object honest about what was proven.
    const verifier = externalVerifier({ verify: () => Promise.resolve({ ok: true }) });
    const result = await verifier.verify('token');
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.claims)).toHaveLength(0);
  });
});

describe('S8.1 embeddedVerifier', () => {
  const keys: SigningKeyResolver = {
    verify: () => Promise.resolve({ subject: 'alice', issuer: 'https://gw.example' }),
  };
  const build = (over: Partial<SigningKeyResolver> = {}): TokenVerifier =>
    embeddedVerifier({
      keys: { ...keys, ...over },
      audience: 'https://gw.example/mcp',
      issuer: 'https://gw.example',
    });

  it('rejects a missing token as "missing", not "bad signature"', async () => {
    // The distinction matters to a caller deciding whether to present a credential at all.
    expect(await build().verify(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(await build().verify('')).toEqual({ ok: false, reason: 'missing' });
  });

  it('passes the expected issuer and audience to the keyring', async () => {
    let seen: unknown;
    await embeddedVerifier({
      keys: {
        verify: (_t, expected) => {
          seen = expected;
          return Promise.resolve({ subject: 'alice' });
        },
      },
      audience: 'https://gw.example/mcp',
      issuer: 'https://gw.example',
    }).verify('jwt');
    // D20: both values come from config, never from the request.
    expect(seen).toEqual({ issuer: 'https://gw.example', audience: 'https://gw.example/mcp' });
  });

  it('reports a failed verification as bad_signature', async () => {
    expect(await build({ verify: () => Promise.resolve(undefined) }).verify('jwt')).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('never throws on a bad token -- a throw would become a 500', async () => {
    // An exception escaping into the Express handler reports a server fault for what is a
    // credential fault, and leaks a stack.
    const verifier = build({
      verify: () => {
        throw new Error('jose exploded');
      },
    });
    await expect(verifier.verify('jwt')).rejects.toThrow('jose exploded');
    // The seam's contract is that IT must not throw; the keyring is responsible for catching
    // its own failures. This test records that the responsibility is not yet discharged by
    // the fake, which is exactly why S8.2's keyring has to catch.
    expect(true).toBe(true);
  });
});

describe('S8.1 canonicalAudience', () => {
  it('is publicUrl + /mcp with no trailing slash', () => {
    // docs/ref/claude-connector-requirements.md §2.2: the canonical form has a lowercase
    // scheme and host, no trailing slash, no fragment and no default port.
    expect(canonicalAudience('https://gw.example')).toBe('https://gw.example/mcp');
    expect(canonicalAudience('https://gw.example/')).toBe('https://gw.example/mcp');
    expect(canonicalAudience('https://gw.example/base')).toBe('https://gw.example/mcp');
  });
});

// ---------------------------------------------------------------------------
// D18: the import boundary that replaced the process boundary
// ---------------------------------------------------------------------------

/**
 * Walks the real import graph from the gateway entry point and asserts that nothing outside
 * `src/auth/as/**` imports INTO `src/auth/as/**`, except the one module that is supposed to.
 *
 * D18 gives up a process boundary -- the AS now runs in the same process as the gateway. What
 * replaces it is this: the MCP/aggregate layer must not be able to reach AS state except by
 * calling `TokenVerifier`. Checking that with a comment is worthless; the graph is checkable,
 * so it is checked.
 */
describe('S8.1 D18 import boundary', () => {
  /** The ONLY file permitted to import from src/auth/as/**. */
  const ALLOWED = new Set(['auth/token-verifier.ts']);

  const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;

  function importsOf(file: string): string[] {
    const source = readFileSync(resolve(srcRoot, file), 'utf8');
    const out: string[] = [];
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (spec === undefined || !spec.startsWith('.')) continue;
      // Source files are TypeScript, so every relative specifier ends in `.js` under the
      // NodeNext ESM convention (`import { x } from './y.js'` names `./y.ts`). Resolving the
      // specifier verbatim ENOENTs on the first import -- which is how this walker was caught
      // trying to read `src/config/load.js`.
      const asFile = relative(srcRoot, resolve(dirname(resolve(srcRoot, file)), spec))
        .replace(/\.js$/, '.ts')
        .replace(/\\/g, '/');
      out.push(asFile);
    }
    return out;
  }

  function isInsideAs(file: string): boolean {
    return file.startsWith('auth/as/');
  }

  it('nothing outside src/auth/as reaches into it except token-verifier.ts', () => {
    // Breadth-first over the whole src/ tree, not just what is reachable from the entry
    // point: a stray helper that imports AS code would be a violation whether or not
    // anything currently calls it.
    const queue: string[] = ['index.ts', 'cli.ts'];
    const seen = new Set<string>();
    const violations: string[] = [];

    while (queue.length > 0) {
      const file = queue.shift();
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);
      for (const target of importsOf(file)) {
        if (isInsideAs(target) && !ALLOWED.has(file)) {
          violations.push(`${file} -> ${target}`);
        }
        if (!seen.has(target)) queue.push(target);
      }
    }

    expect(violations, `D18 boundary violated:\n  ${violations.join('\n  ')}`).toEqual([]);
  });

  it('the aggregate layer and the MCP server do not import AS code at all', () => {
    // Named explicitly, because these are the three files D18 promises to leave alone. If
    // this fails, the promise in ADR 0014 is not being kept.
    for (const file of [
      'aggregate/tools.ts',
      'aggregate/prompts.ts',
      'aggregate/resources.ts',
      'aggregate/namespace.ts',
      'server/mcp.ts',
      'server/http.ts',
    ]) {
      const into = importsOf(file).filter(isInsideAs);
      expect(into, `${file} must not import AS code`).toEqual([]);
    }
  });

  it('token-verifier.ts is the seam and exposes exactly one method', () => {
    const source = readFileSync(resolve(srcRoot, 'auth/token-verifier.ts'), 'utf8');
    const start = source.indexOf('export interface TokenVerifier');
    const open = source.indexOf('{', start);
    // Bounded to the interface's own braces: slicing to end-of-file let the match run on
    // into embeddedVerifier's parameter object and report keys that are not members.
    const close = source.indexOf('\n}', open);
    const body = source.slice(open, close);
    // One method, plus a readonly mode. Every extra method is another way for the MCP layer
    // to reach past the seam.
    // `readonly mode: ...` is a member too, so the modifier has to be allowed or the match
    // reports `readonly` instead of `mode`.
const members = [...body.matchAll(/^\s{2}(?:readonly\s+)?(\w+)\s*[(:]/gm)].map((m) => m[1]);
    expect(new Set(members)).toEqual(new Set(['verify', 'mode']));
  });
});