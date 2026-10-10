// D14: pino JSON logs with a redaction list.
//
// PLAN.md rule 9: never log, echo or put in an error message any secret VALUE.

import pino, { type Logger, type LoggerOptions } from 'pino';

import { PINO_REDACT_PATHS, REDACT_PLACEHOLDER, isRedactedKey, redactValue } from './redact.js';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

const LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

export function isLogLevel(value: string): value is LogLevel {
  return (LEVELS as readonly string[]).includes(value);
}

export interface LoggerOptionsExtra {
  level?: LogLevel;
  /**
   * When true the logger writes newline-delimited JSON to stdout. Tests pass a sink
   * instead and never touch the real stream.
   */
  destination?: NodeJS.WritableStream;
  /** Structured context merged into every line (e.g. `{ upstream: 'github' }`). */
  base?: Record<string, unknown>;
  /**
   * Literal secret VALUES known to the process (inbound bearer keys, upstream header
   * values, ...). Every occurrence of one of these is replaced in EVERY string argument,
   * which closes the two paths pino's key-based redaction cannot reach: the message
   * string and `err.message`.
   *
   * Values shorter than MIN_SCRUBBABLE_SECRET are ignored: replacing a one- or two-
   * character value everywhere would corrupt unrelated log text.
   */
  secrets?: readonly string[];
}

/** Shorter secrets are not scrubbed from free text; see `LoggerOptionsExtra.secrets`. */
export const MIN_SCRUBBABLE_SECRET = 8;

/** Replaces every occurrence of every known secret in a string. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < MIN_SCRUBBABLE_SECRET) continue;
    out = out.split(secret).join(REDACT_PLACEHOLDER);
  }
  return out;
}

/**
 * Applies BOTH controls to a value: key-based redaction (D14) and value-based scrubbing
 * of every string it contains, at any depth. The second pass is what catches
 * `err.message`, which pino's error serializer renders AFTER this hook runs.
 */
function harden(value: unknown, secrets: readonly string[], seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return scrubSecrets(value, secrets);
  if (Array.isArray(value)) {
    if (seen.has(value)) return REDACT_PLACEHOLDER;
    seen.add(value);
    return value.map((item) => harden(item, secrets, seen));
  }
  if (value !== null && typeof value === 'object') {
    // Errors are objects, but their `message`/`stack` are non-enumerable, so a plain
    // Object.entries walk would miss them. Rebuild them as plain objects so pino's
    // serializer sees scrubbed text.
    if (value instanceof Error) {
      return {
        name: value.name,
        message: scrubSecrets(value.message, secrets),
        stack: value.stack === undefined ? undefined : scrubSecrets(value.stack, secrets),
      };
    }
    if (seen.has(value)) return REDACT_PLACEHOLDER;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isRedactedKey(key) ? REDACT_PLACEHOLDER : harden(child, secrets, seen);
    }
    return out;
  }
  return value;
}

export function createLogger(options: LoggerOptionsExtra = {}): Logger {
  const secrets = (options.secrets ?? []).filter((s) => s.length >= MIN_SCRUBBABLE_SECRET);

  const pinoOptions: LoggerOptions = {
    level: options.level ?? 'info',
    // verified: https://getpino.io/#/docs/redaction (pino redact option: { paths, censor, remove })
    redact: {
      paths: [...PINO_REDACT_PATHS],
      censor: REDACT_PLACEHOLDER,
    },
    // verified: https://getpino.io/#/docs/api (pino base option)
    base: options.base ?? {},
    formatters: {
      // Keeps the level field a plain string rather than the default numeric object.
      // verified: https://getpino.io/#/docs/formatters (formatters.level signature)
      level(label) {
        return { level: label };
      },
    },
    ...(secrets.length > 0
      ? {
          hooks: {
            // verified: https://getpino.io/#/docs/api#logmethod (hooks.logMethod(args, method, level))
            logMethod(args, method) {
              const scrubbed = args.map((arg) => harden(arg, secrets)) as Parameters<typeof method>;
              method.apply(this, scrubbed);
            },
          },
        }
      : {}),
  };

  const stream = options.destination ?? process.stdout;
  return pino(pinoOptions, stream);
}

/**
 * Builds the secret list from a loaded config. Only LITERAL values are registered:
 * `{env:NAME}` was already substituted, so what lands here is the real secret.
 */
/**
 * Builds the secret list from a loaded config. Only LITERAL values are registered:
 * `{env:NAME}` was already substituted, so what lands here is the real secret.
 *
 * Typed loosely on purpose: a `local` upstream has no `headers` at all, so the precise
 * union would make the parameter unusable. The read is therefore guarded.
 */
export function secretsFromConfig(config: {
  gateway?: { auth?: { keys?: readonly string[] } };
  mcp?: Readonly<Record<string, unknown>>;
}): string[] {
  const values: string[] = [...(config.gateway?.auth?.keys ?? [])];
  for (const entry of Object.values(config.mcp ?? {})) {
    if (entry === null || typeof entry !== 'object') continue;
    const headers = (entry as { headers?: unknown }).headers;
    if (headers === null || typeof headers !== 'object') continue;
    for (const value of Object.values(headers as Record<string, unknown>)) {
      if (typeof value === 'string') values.push(value);
    }
  }
  return values;
}

/**
 * A child logger tagged with an upstream name, for S4.4's line-buffered stderr capture.
 */
export function childForUpstream(logger: Logger, upstream: string): Logger {
  return logger.child({ upstream });
}

/**
 * Wraps an arbitrary value for logging. Everything goes through `redactValue` first so
 * a caller cannot accidentally bypass the redaction list by passing a pre-built object.
 */
export function safe(value: unknown): unknown {
  return redactValue(value);
}

export { pino };
export type { Logger };