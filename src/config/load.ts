// D6: config is JSONC in `gateway.json`, path from `--config <path>` or env
// `GATEWAY_CONFIG`, default `./gateway.json`.
// D7: parse -> substitute -> validate, in that order.
//
// PLAN.md rule 9: every message names the config key path, never a value.

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

import {
  gatewayConfigSchema,
  validateCrossFieldConfig,
  type GatewayConfig,
} from './schema.js';
import { substitute, SubstitutionError, type SubstituteOptions } from './substitute.js';

export const DEFAULT_CONFIG_FILENAME = 'gateway.json';
export const CONFIG_PATH_ENV_VAR = 'GATEWAY_CONFIG';

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
}

export interface LoadedConfig {
  config: GatewayConfig;
  /** Absolute path the config was read from. */
  path: string;
}

export function resolveConfigPath(explicit?: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (explicit !== undefined && explicit.length > 0) return resolvePath(process.cwd(), explicit);
  const fromEnv = env[CONFIG_PATH_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.length > 0) return resolvePath(process.cwd(), fromEnv);
  return resolvePath(process.cwd(), DEFAULT_CONFIG_FILENAME);
}

/** Reads the file named by `options.path` / `GATEWAY_CONFIG` / `./gateway.json`. */
export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const path = resolveConfigPath(options.path, env);

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
 * `sourcePath` is only used to label errors and to resolve relative `{file:...}` paths.
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