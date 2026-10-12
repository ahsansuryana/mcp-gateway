// D6: config is JSONC in `gateway.json`, path from `--config <path>` or env
// `GATEWAY_CONFIG`, default `./gateway.json`.
// D7: parse -> substitute -> validate, in that order.
//
// PLAN.md rule 9: every message names the config key path, never a value.

import { existsSync, readFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

import {
  gatewayConfigSchema,
  validateCrossFieldConfig,
  type GatewayConfig,
} from './schema.js';
import { substitute, SubstitutionError, type SubstituteOptions } from './substitute.js';
import {
  CONFIG_DIR_NAME,
  CONFIG_FILENAME,
  CONFIG_PATH_ENV_VAR,
  DEFAULT_CONFIG_FILENAME,
  resolveConfigLocation,
} from './paths.js';

export { CONFIG_PATH_ENV_VAR, DEFAULT_CONFIG_FILENAME };

export interface ConfigError {
  /** Dotted key path, e.g. `mcp.github.url`. Never a value. */
  path: string;
  /** Reason, always free of secret material. */
  reason: string;
}

export class ConfigErrorList extends Error {
  readonly errors: readonly ConfigError[];

  constructor(errors: readonly ConfigError[]) {
    super(
      `configuration is invalid (${errors.length} error${errors.length === 1 ? '' : 's'}):\n` +
        errors.map((e) => `  - ${e.path}: ${e.reason}`).join('\n'),
    );
    this.name = 'ConfigErrorList';
    this.errors = errors;
  }
}

export interface LoadOptions extends SubstituteOptions {
  /** Overrides `GATEWAY_CONFIG` and the default path. */
  path?: string;
  /** Environment used for BOTH `GATEWAY_CONFIG` lookup and `{env:...}` substitution. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Injected so the search order is testable without depending on the real cwd. */
  cwd?: string;
  /** Injected so the home candidate is testable on any machine. */
  homedir?: string;
  /** Injected existence predicate. */
  exists?: (absolutePath: string) => boolean;
}

export interface LoadedConfig {
  config: GatewayConfig;
  /** Absolute path the config was read from. */
  path: string;
}

export function resolveConfigPath(
  explicit?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const found = resolveConfigLocation({
    flag: explicit,
    env,
    cwd: process.cwd(),
    homedir: osHomedir(),
    exists: (p) => existsSync(p),
  });
  return 'path' in found ? found.path : join(process.cwd(), DEFAULT_CONFIG_FILENAME);
}

/** Reads the file named by `options.path` / `GATEWAY_CONFIG` / the `.mcp-gateway` search. */
export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const located = resolveConfigLocation({
    flag: options.path,
    env,
    cwd: options.cwd ?? process.cwd(),
    homedir: options.homedir ?? osHomedir(),
    exists: options.exists ?? ((p) => existsSync(p)),
  });

  if (!('path' in located)) {
    // Every candidate, so the operator can see exactly where it looked. No stack trace: this
    // is a configuration mistake, not a crash.
    throw new ConfigErrorList([
      {
        path: '<file>',
        reason:
          'no gateway config found. Checked:\n' +
          located.checked.map((p) => `        - ${p}`).join('\n') +
          `\n        Create one with: mcp-gateway init   (or --local for ${join(process.cwd(), CONFIG_DIR_NAME, CONFIG_FILENAME)})`,
      },
    ]);
  }
  const path = located.path;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // The message names the path only; the file's contents are never echoed.
    throw new ConfigErrorList([{ path: '<file>', reason: `could not read the config file at ${path}` }]);
  }

  const substituteOptions: SubstituteOptions =
    options.env === undefined
      ? options.readFile === undefined
        ? {}
        : { readFile: options.readFile }
      : options.readFile === undefined
        ? { env: options.env }
        : { env: options.env, readFile: options.readFile };

  return parseConfig(raw, path, substituteOptions);
}

/**
 * Parses, substitutes and validates an in-memory config document.
 *
 * `sourcePath` is used ONLY to label errors. It does NOT resolve `{file:...}` paths:
 * substitute.ts resolves those against `process.cwd()`, and sourcePath is never passed to
 * it. That comment used to claim otherwise and was wrong (Q-CLI-2 in OPEN-QUESTIONS).
 * Moving the config file therefore does not move `{file:}` paths with it -- ADR 0012 D4
 * keeps the behaviour and fixes the documentation.
 */
export function parseConfig(raw: string, sourcePath: string, options: SubstituteOptions = {}): LoadedConfig {
  const parseErrors: ParseError[] = [];
  // verified: https://github.com/microsoft/node-jsonc-parser#parse (jsonc-parser parse; allowTrailingComma/disallowComments are jsonc-only)
  const parsed: unknown = parse(raw, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });

  if (parseErrors.length > 0) {
    throw new ConfigErrorList(
      parseErrors.map((e) => ({
        path: `<file>:${lineOf(raw, e.offset)}`,
        reason: printParseErrorCode(e.error),
      })),
    );
  }

  // D7: substitution runs BEFORE validation so a missing env var is reported against the
  // exact key that referenced it, rather than as a downstream schema complaint.
  let substituted: unknown;
  try {
    substituted = substitute(parsed, options);
  } catch (err) {
    if (err instanceof SubstitutionError) {
      throw new ConfigErrorList([{ path: err.path, reason: err.reason }]);
    }
    throw err;
  }

  const result = gatewayConfigSchema.safeParse(substituted);
  if (!result.success) {
    // verified: https://zod.dev/error-formatting (zod v4 issue shape: path array + message)
    throw new ConfigErrorList(result.error.issues.map(issueToConfigError));
  }

  // The one rule zod's per-field schema cannot express: plain `http:` for a
  // non-localhost remote upstream (PLAN.md §6).
  const urlErrors = validateCrossFieldConfig(result.data);
  if (urlErrors.length > 0) {
    throw new ConfigErrorList(urlErrors.map(splitReason));
  }

  return { config: result.data, path: sourcePath };
}

/**
 * Converts one zod issue to a `ConfigError`.
 *
 * A record-key failure carries the real reason on `issue.issues[0].message` and a generic
 * "Invalid key in record" on the outer message, so the inner one is preferred when present.
 */
function issueToConfigError(issue: { path: PropertyKey[]; message: string; issues?: { message: string }[] }): ConfigError {
  const inner = issue.issues?.[0]?.message;
  return {
    path: issue.path.length === 0 ? '<root>' : issue.path.map(String).join('.'),
    reason: inner ?? issue.message,
  };
}

/** `"mcp.Bad_Name: reason"` -> `{ path: 'mcp.Bad_Name', reason: 'reason' }`. */
function splitReason(reason: string): ConfigError {
  const idx = reason.indexOf(':');
  if (idx < 0) return { path: '<root>', reason };
  return { path: reason.slice(0, idx), reason: reason.slice(idx + 2) };
}

// verified: https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String/split
function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}