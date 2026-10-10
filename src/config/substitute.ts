// D7: after parsing, substitute `{env:NAME}` and `{file:path}` inside every string
// value, THEN validate with zod. Typos must fail loudly; secrets stay out of the JSON.
//
// PLAN.md rule 9: an error may name the config key path, never the value.

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/** Matches `{env:NAME}` or `{file:path}` anywhere inside a string. */
const PLACEHOLDER = /\{(env|file):([^}]*)\}/g;

export class SubstitutionError extends Error {
  readonly path: string;
  readonly kind: 'env' | 'file';
  /**
   * Reason only. For `{env:...}` it names the variable (a name is not a secret, and D7
   * requires typos to fail loudly). For `{file:...}` it never contains the path, which
   * may itself be sensitive. Neither ever contains a substituted VALUE.
   */
  readonly reason: string;

  constructor(path: string, kind: 'env' | 'file', reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'SubstitutionError';
    this.path = path;
    this.kind = kind;
    this.reason = reason;
  }
}

type Env = Readonly<Record<string, string | undefined>>;
type ReadFile = (absolutePath: string) => string;

export interface SubstituteOptions {
  env?: Env;
  readFile?: ReadFile;
}

// verified: https://nodejs.org/api/fs.html#fsreadfilesyncpath-options (node:fs readFileSync)
const defaultReadFile: ReadFile = (absolutePath) => readFileSync(absolutePath, 'utf8');

function toPath(pathParts: readonly (string | number)[]): string {
  return pathParts.length === 0 ? '<root>' : pathParts.join('.');
}

/**
 * Walks the parsed JSONC value and replaces every placeholder found in a string.
 * Arrays and plain objects are traversed; every other value is returned unchanged.
 *
 * A string may contain more than one placeholder; the whole string is resolved.
 * A string that contains no placeholder is returned as the same primitive (no copy),
 * so non-string values keep their identity and types survive untouched.
 */
export function substitute<T>(value: T, options: SubstituteOptions = {}): T {
  const env: Env = options.env ?? process.env;
  const readFile: ReadFile = options.readFile ?? defaultReadFile;

  const walk = (node: unknown, pathParts: (string | number)[]): unknown => {
    if (typeof node === 'string') return resolveString(node, pathParts, env, readFile);
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, [...pathParts, index]));
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        out[key] = walk(child, [...pathParts, key]);
      }
      return out;
    }
    return node;
  };

  return walk(value, []) as T;
}

function resolveString(input: string, pathParts: (string | number)[], env: Env, readFile: ReadFile): string {
  // `replace` with a function is safe against `$&`-style replacement patterns in the value.
  return input.replace(PLACEHOLDER, (_match, kind: string, arg: string) => {
    const path = toPath(pathParts);
    if (kind === 'env') {
      const found = env[arg];
      if (found === undefined) {
        throw new SubstitutionError(path, 'env', `environment variable ${describeName(arg)} is not set`);
      }
      return found;
    }
    // kind === 'file'
    if (arg.length === 0) {
      throw new SubstitutionError(path, 'file', 'placeholder is missing a path');
    }
    const trimmed = arg.trim();
    // verified: https://nodejs.org/api/path.html#pathresolvepaths (node:path resolve)
    const absolute = resolvePath(process.cwd(), trimmed);
    try {
      return readFile(absolute);
    } catch {
      // Never surface the underlying error: it can contain the file path.
      throw new SubstitutionError(path, 'file', 'could not read the referenced file');
    }
  });
}

/**
 * An env var NAME is not a secret, but echoing an arbitrary attacker-controlled string
 * into an error message is still avoidable; keep it to the characters a real var name has.
 */
function describeName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '"(malformed variable name)"';
}