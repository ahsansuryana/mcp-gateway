import { describe, expect, it } from 'vitest';
import { isAbsolute } from 'node:path';

import { substitute, SubstitutionError } from '../../src/config/substitute.js';

const CANARY = 'SECRET-CANARY-123';

describe('D7 {env:NAME} substitution', () => {
  it('substitutes a top-level string', () => {
    const out = substitute({ key: '{env:TOKEN}' }, { env: { TOKEN: 'abc' } });
    expect(out).toEqual({ key: 'abc' });
  });

  it('substitutes nested objects and arrays, keeping non-strings untouched', () => {
    const input = {
      a: { b: ['{env:X}', 5, true, null] },
      n: 7,
    };
    const out = substitute<{ a: { b: (string | number | boolean | null)[] }; n: number }>(input, {
      env: { X: 'v' },
    });
    expect(out).toEqual({ a: { b: ['v', 5, true, null] }, n: 7 });
    expect(out.n).toBe(7);
  });

  it('substitutes several placeholders inside one string', () => {
    const out = substitute({ k: 'Bearer {env:A}; id={env:B}' }, { env: { A: '1', B: '2' } });
    expect(out).toEqual({ k: 'Bearer 1; id=2' });
  });

  it('leaves strings without placeholders unchanged', () => {
    const out = substitute({ k: 'plain' }, { env: {} });
    expect(out).toEqual({ k: 'plain' });
  });

  it('treats a set-but-empty variable as an empty string, not as missing', () => {
    expect(substitute({ k: '[{env:E}]' }, { env: { E: '' } })).toEqual({ k: '[]' });
  });

  it('does not re-scan a substituted value for further placeholders', () => {
    const out = substitute({ k: '{env:A}' }, { env: { A: '{env:B}', B: 'nope' } });
    expect(out).toEqual({ k: '{env:B}' });
  });

  it('throws a path-naming error when the variable is missing', () => {
    let caught: unknown;
    try {
      substitute({ gateway: { auth: { keys: ['{env:MISSING}'] } } }, { env: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SubstitutionError);
    const err = caught as SubstitutionError;
    expect(err.path).toBe('gateway.auth.keys.0');
    expect(err.kind).toBe('env');
    expect(err.reason).toContain('MISSING');
  });

  it('names array indexes in the error path', () => {
    let caught: unknown;
    try {
      substitute({ mcp: { fs: { environment: { A: '{env:NOPE}' } } } }, { env: {} });
    } catch (err) {
      caught = err;
    }
    expect((caught as SubstitutionError).path).toBe('mcp.fs.environment.A');
  });

  it('never puts the substituted VALUE into the error message', () => {
    let caught: unknown;
    try {
      substitute({ a: { b: '{env:MISSING}' } }, { env: {} });
    } catch (err) {
      caught = err;
    }
    expect(JSON.stringify(String(caught))).not.toContain(CANARY);
  });

  it('does not interpret replacement patterns inside the value', () => {
    const out = substitute({ k: '{env:V}' }, { env: { V: '$& $1 $$' } });
    expect(out).toEqual({ k: '$& $1 $$' });
  });
});

describe('D7 {file:path} substitution', () => {
  const readFile = (p: string): string => {
    if (p.endsWith('token.txt')) return CANARY;
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  };

  it('reads the file and substitutes its contents', () => {
    const out = substitute({ k: '{file:./secrets/token.txt}' }, { readFile });
    expect(out).toEqual({ k: CANARY });
  });

  it('trims the placeholder argument and resolves it against cwd', () => {
    let seen: string | undefined;
    substitute(
      { k: '{file:  ./secrets/token.txt  }' },
      {
        readFile: (p) => {
          seen = p;
          return 'x';
        },
      },
    );
    expect(seen).not.toBeUndefined();
    // Compared with separators normalised, because path.resolve emits the platform's own
    // separator and D15 requires the suite to pass on Windows and Linux alike.
    const normalised = seen?.split(/[\\/]/).join('/');
    expect(normalised?.endsWith('secrets/token.txt')).toBe(true);
    expect(isAbsolute(seen ?? '')).toBe(true);
  });

  it('throws a path-naming error when the file is unreadable, without leaking the path', () => {
    let caught: unknown;
    try {
      substitute({ mcp: { gh: { headers: { Authorization: '{file:./nope.txt}' } } } }, { readFile });
    } catch (err) {
      caught = err;
    }
    const err = caught as SubstitutionError;
    expect(err).toBeInstanceOf(SubstitutionError);
    expect(err.path).toBe('mcp.gh.headers.Authorization');
    expect(err.kind).toBe('file');
    expect(err.reason).not.toContain('nope.txt');
    expect(String(err)).not.toContain(CANARY);
  });

  it('rejects an empty file path', () => {
    let caught: unknown;
    try {
      substitute({ k: '{file:}' }, { readFile });
    } catch (err) {
      caught = err;
    }
    expect((caught as SubstitutionError).kind).toBe('file');
    expect((caught as SubstitutionError).path).toBe('k');
  });
});

describe('substitute edge cases', () => {
  it('returns non-object input unchanged', () => {
    expect(substitute(5, { env: {} })).toBe(5);
    expect(substitute(null, { env: {} })).toBeNull();
  });

  it('leaves an unrelated malformed placeholder alone', () => {
    expect(substitute({ k: '{env}' }, { env: {} })).toEqual({ k: '{env}' });
    expect(substitute({ k: '{foo:bar}' }, { env: {} })).toEqual({ k: '{foo:bar}' });
  });
});