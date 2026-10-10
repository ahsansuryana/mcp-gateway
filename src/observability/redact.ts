// D14: redaction list covering `authorization`, `headers`, `environment`, `token`,
// `apiKey`, `secret`, `password`, `cookie`.
//
// PLAN.md rule 9: never log, echo or put in an error message any secret VALUE. Redaction
// is a defence in depth, not the primary control — nothing in src/ ever passes a secret
// to the logger in the first place.

/** The key names D14 requires, plus obvious casing variants. */
export const REDACTED_KEYS = [
  'authorization',
  'headers',
  'environment',
  'token',
  'apiKey',
  'secret',
  'password',
  'cookie',
] as const;

export const REDACT_PLACEHOLDER = '[Redacted]';

/** Paths that address a specific secret-bearing container, at the root or nested. */
const SECRET_CONTAINER_PATHS = [
  'config.gateway.auth.keys',
  'upstream.headers',
  'upstream.environment',
  'req.headers',
  'req.body',
  'err.config',
] as const;

/**
 * pino redact paths. Three shapes are needed because pino anchors each path at the log
 * root and `*` matches exactly one segment:
 *   - `<key>.*` / `*.<key>` / `*.<key>.*`   a redacted key at any depth
 *   - `<path>` / `*.<path>`                  a secret-bearing container, root or nested
 * verified: https://getpino.io/#/docs/redaction (pino `redact.paths`, dot/bracket notation, `*` wildcard)
 */
export const PINO_REDACT_PATHS: readonly string[] = Object.freeze([
  ...REDACTED_KEYS.flatMap((key) => [`*.${key}`, `*.${key}.*`, key, `${key}.*`]),
  ...SECRET_CONTAINER_PATHS.flatMap((p) => [p, `*.${p}`, `${p}.*`, `*.${p}.*`]),
]);

const LOWERCASE = new Set(REDACTED_KEYS.map((k) => k.toLowerCase()));

/**
 * True when a key name should be redacted regardless of depth or casing.
 * `apiKey`, `API_KEY` and `ApiKey` all match; `tokenizer` does not (exact match only).
 */
export function isRedactedKey(key: string): boolean {
  return LOWERCASE.has(key.toLowerCase());
}

/**
 * Deep-copies `value`, replacing every value under a redacted key with
 * `REDACT_PLACEHOLDER`. Used for anything logged outside pino's own redact pipeline
 * (config summaries, error payloads passed to `onerror`, HTTP status dumps).
 *
 * Cycles are broken with the placeholder rather than throwing, because a log call must
 * never be the thing that crashes the process.
 */
export function redactValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return REDACT_PLACEHOLDER;
    seen.add(value);
    return value.map((item) => redactValue(item, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return REDACT_PLACEHOLDER;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isRedactedKey(key) ? REDACT_PLACEHOLDER : redactValue(child, seen);
    }
    return out;
  }
  return value;
}

/**
 * A config-shaped summary safe to log: names only, never values.
 * PLAN.md §8 security checklist: "No secret in logs, errors, /status, ...".
 */
export function configSummary(config: {
  host?: string;
  port?: number;
  auth?: unknown;
  mcp?: Record<string, unknown>;
}): Record<string, unknown> {
  const upstreams = config.mcp ?? {};
  return {
    host: config.host,
    port: config.port,
    upstreamCount: Object.keys(upstreams).length,
    upstreams: Object.fromEntries(
      Object.entries(upstreams).map(([name, entry]) => {
        const kind =
          entry !== null && typeof entry === 'object' && 'type' in entry
            ? String((entry as { type: unknown }).type)
            : 'unknown';
        const enabled =
          entry !== null && typeof entry === 'object' && 'enabled' in entry
            ? Boolean((entry as { enabled: unknown }).enabled)
            : undefined;
        return [name, { type: kind, enabled }];
      }),
    ),
  };
}