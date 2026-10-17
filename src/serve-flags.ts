// ADR 0013: runtime overrides for the bind address, port and public URL.
//
// These are PER-PROCESS overrides. They are deliberately never written back to the config
// file, following the precedent `-c` already sets: an explicit flag on the command line is
// an instruction about this run, not an edit to the installation. Writing `--public-url`
// into gateway.json would mean a tunnel's ephemeral URL silently becomes the
// installation's permanent identity, and the next run without the flag would start
// advertising the wrong `aud`.
//
// Ordering matters and is easy to get wrong: the overrides are applied to the parsed
// config BEFORE `buildHttpApp`, because `resolveAllowedOrigins`, the RFC 9728 audience and
// the CIMD client_id are all derived from `config.gateway.publicUrl` at the moment the app
// is built. Applying them afterwards would change the banner while leaving the OAuth
// metadata pointing at the old host -- which fails as an `audience mismatch`, far from the
// flag that caused it.

import type { GatewayConfig } from './config/schema.js';

/** Exit code 2: a usage error. Kept in step with src/cli.ts. */
const EXIT_USAGE = 2;

export interface ServeFlags {
  /** `-c` / `--config`. Undefined means "resolve it". */
  configPath?: string;
  /** `--hostname`. Overrides gateway.host for this process. */
  hostname?: string;
  /** `--port`. Overrides gateway.port for this process. */
  port?: number;
  /** `--public-url`. Overrides gateway.publicUrl for this process. */
  publicUrl?: string;
}

export interface FlagParseError {
  code: typeof EXIT_USAGE;
  stderr: string;
}

export type FlagResult = { flags: ServeFlags } | FlagParseError;

interface FlagSpec {
  /** Long name as written on the command line, for error messages. */
  label: string;
  /** The argv spelling that takes the value as the NEXT argument. */
  spaced: string;
  /** The argv spelling that takes the value after `=`. */
  equals: string;
  parse: (raw: string) => { ok: true; value: string | number } | { ok: false; reason: string };
}

function portSpec(): FlagSpec {
  return {
    label: '--port',
    spaced: '--port',
    equals: '--port=',
    parse: (raw) => {
      // Number(), not parseInt: parseInt('3000abc') is 3000, which would silently bind a
      // different port than the operator typed.
      if (!/^\d+$/.test(raw)) return { ok: false, reason: 'must be a number' };
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > 65_535) {
        return { ok: false, reason: 'must be between 1 and 65535' };
      }
      return { ok: true, value };
    },
  };
}

function stringSpec(label: string): FlagSpec {
  return {
    label,
    spaced: label,
    equals: `${label}=`,
    parse: (raw) => {
      if (raw.length === 0) return { ok: false, reason: 'requires a value' };
      return { ok: true, value: raw };
    },
  };
}

/**
 * Command words `run()` accepts. A leading one is skipped rather than reported as an
 * unknown option: `mcp-gate serve --port 3001` and `mcp-gate --port 3001` are the
 * same command, and the CLI documents `serve` as spell-out-able.
 *
 * Only `serve` can actually reach here -- `run()` returns `serve !== true` for the others --
 * but the set is spelled out rather than reduced to `['serve']` so that adding a command
 * later cannot silently turn it into "unknown option: <command>" on the serve path.
 */
const COMMAND_WORDS = new Set(['serve', 'validate', 'init', 'help']);

/**
 * Parses every serve flag in one pass.
 *
 * `--` stops parsing, so a value that looks like a flag (a password beginning with `-`,
 * say) can still be passed through after it. Everything after `--` is ignored rather than
 * rejected: the gateway takes no positional arguments, so there is nothing there to act on
 * and failing would break tooling that appends its own.
 */
export function parseServeFlags(argv: readonly string[]): FlagResult {
  const specs: FlagSpec[] = [
    stringSpec('--hostname'),
    portSpec(),
    stringSpec('--public-url'),
  ];

  const flags: ServeFlags = {};
  let configPath: string | undefined;

  const first = argv[0];
  const start = first !== undefined && !first.startsWith('-') && COMMAND_WORDS.has(first) ? 1 : 0;

  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--') break;

    if (arg === '-c' || arg === '--config') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return { code: EXIT_USAGE, stderr: `${arg} requires a path argument\n` };
      }
      configPath = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (value.length === 0) {
        return { code: EXIT_USAGE, stderr: '--config requires a path argument\n' };
      }
      configPath = value;
      continue;
    }

    const spec = specs.find((s) => arg === s.spaced || arg.startsWith(s.equals));
    if (spec === undefined) {
      return { code: EXIT_USAGE, stderr: `unknown option: ${arg}\n` };
    }

    const raw = arg === spec.spaced ? argv[i + 1] : arg.slice(spec.equals.length);
    if (arg === spec.spaced) i += 1;
    if (raw === undefined) {
      return { code: EXIT_USAGE, stderr: `${spec.label} requires a value\n` };
    }

    const parsed = spec.parse(raw);
    if (!parsed.ok) {
      return { code: EXIT_USAGE, stderr: `${spec.label} ${parsed.reason}\n` };
    }
    if (spec === specs[0]) flags.hostname = String(parsed.value);
    else if (spec === specs[1]) flags.port = Number(parsed.value);
    else flags.publicUrl = String(parsed.value);
  }

  if (configPath !== undefined) flags.configPath = configPath;
  return { flags };
}

/**
 * Returns a config with the overrides applied. The input is never mutated.
 *
 * Not mutating is not stylistic: `ConfigReloader` holds the same config object and computes
 * a digest over it, so an in-place write would make the reloader see a change that was
 * never made on disk and restart upstreams for it.
 *
 * `publicUrl` must be an absolute http/https URL when given, and the check is here rather
 * than in the schema because a bad value here would otherwise reach the RFC 9728 document
 * and fail much later, as an unparseable metadata fetch rather than as a flag error.
 */
export function applyOverrides(config: GatewayConfig, flags: ServeFlags): GatewayConfig {
  const gateway = { ...config.gateway };

  if (flags.hostname !== undefined) gateway.host = flags.hostname;
  if (flags.port !== undefined) gateway.port = flags.port;
  if (flags.publicUrl !== undefined) {
    if (!isHttpUrl(flags.publicUrl)) {
      throw new UsageError('--public-url must be an absolute http: or https: URL');
    }
    gateway.publicUrl = flags.publicUrl;
  }

  return { ...config, gateway };
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}