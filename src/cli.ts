// PLAN.md S1.4: `validate -c <file>` exits 0 on a valid config and 1 with a
// human-readable list of errors (key path + reason, never values).
//
// PLAN.md rule 9: no secret value ever reaches stdout/stderr or an exit message.
//
// argv handling is pure so the behaviour is unit-testable; only `main()` touches process.

import { pathToFileURL } from 'node:url';

import {
  CONFIG_PATH_ENV_VAR,
  ConfigErrorList,
  loadConfig,
  resolveConfigPath,
} from './config/load.js';
import { MAX_TOOL_NAME_LENGTH, SERVER_NAME_PATTERN } from './config/schema.js';

/** Exit codes: 0 success, 1 validation failure, 2 usage error. */
export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_USAGE = 2;

export interface CliOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export const USAGE = `mcp-gateway — aggregated MCP gateway

Usage:
  mcp-gateway validate [-c <path>]   validate a gateway config and exit
  mcp-gateway help                   show this message

Options:
  -c, --config <path>   config file path
                        (default: $${CONFIG_PATH_ENV_VAR} or ./gateway.json)

Exit codes:
  0  config is valid
  1  config is invalid
  2  usage error
`;

/** Pure argv handling (PLAN.md S1.4). */
export function run(argv: readonly string[]): CliOutcome {
  const [command, ...rest] = argv;

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { code: EXIT_OK, stdout: USAGE, stderr: '' };
  }
  if (command === '--version' || command === '-v') {
    return { code: EXIT_OK, stdout: 'mcp-gateway 0.0.0\n', stderr: '' };
  }
  if (command !== 'validate') {
    return { code: EXIT_USAGE, stdout: '', stderr: `unknown command: ${command}\n\n${USAGE}` };
  }
  return runValidate(rest);
}

/** Parses `-c <path>` / `--config <path>` / `--config=<path>`. */
export function parseConfigFlag(argv: readonly string[]): { path?: string; error?: string } {
  let path: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '-c' || arg === '--config') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return { error: `${arg} requires a path argument` };
      }
      path = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (value.length === 0) return { error: '--config requires a path argument' };
      path = value;
      continue;
    }
    return { error: `unexpected argument: ${arg}` };
  }
  return path === undefined ? {} : { path };
}

/** Extra guidance for a validation failure; names rules, never values. */
export function hintsFor(errors: readonly { path: string; reason: string }[]): string[] {
  const hints = new Set<string>();
  for (const e of errors) {
    if (e.path === '<file>') {
      hints.add(`could not read the file; pass -c <path> or set $${CONFIG_PATH_ENV_VAR}`);
    }
    if (e.path.startsWith('mcp.') && e.reason.includes('upstream name')) {
      hints.add(
        `upstream names must match ${String(SERVER_NAME_PATTERN)} so <server>_<tool> splits unambiguously`,
      );
    }
    if (e.path.endsWith('.url') && e.reason.includes('https:')) {
      hints.add('remote upstreams must use https: unless the host is localhost, 127.0.0.1 or ::1');
    }
    if (e.reason.includes('Unrecognized key')) {
      hints.add('objects are strict: remove the unknown key (comments and trailing commas are allowed)');
    }
    if (e.reason.includes('environment variable')) {
      hints.add('set the variable in the environment before validating, or remove the {env:NAME} placeholder');
    }
  }
  if (errors.length > 0) {
    hints.add(`namespaced tool names longer than ${MAX_TOOL_NAME_LENGTH} characters are skipped at runtime (D4)`);
  }
  return [...hints];
}

export function runValidate(argv: readonly string[]): CliOutcome {
  const flag = parseConfigFlag(argv);
  if (flag.error !== undefined) {
    return { code: EXIT_USAGE, stdout: '', stderr: `${flag.error}\n\n${USAGE}` };
  }

  const displayPath = resolveConfigPath(flag.path);
  try {
    const { config } = loadConfig(flag.path === undefined ? {} : { path: flag.path });

    const lines: string[] = [`OK  ${displayPath}`];
    lines.push(
      `    gateway: ${config.gateway.host}:${config.gateway.port}  legacyEra=${config.gateway.legacyEra}  defaultTtlMs=${config.gateway.defaultTtlMs}`,
    );
    lines.push(`    upstreams: ${Object.keys(config.mcp).length}`);
    for (const [name, entry] of Object.entries(config.mcp)) {
      const enabled = entry.enabled ? 'enabled' : 'disabled';
      const target = entry.type === 'remote' ? new URL(entry.url).host : (entry.command[0] ?? '');
      lines.push(`      - ${name}  ${entry.type}  ${enabled}  ${target}`);
    }
    lines.push(`    inbound auth: bearer, ${config.gateway.auth.keys.length} key(s)`);
    return { code: EXIT_OK, stdout: lines.join('\n') + '\n', stderr: '' };
  } catch (err) {
    if (err instanceof ConfigErrorList) {
      const lines: string[] = [`INVALID  ${displayPath}`, '', `${err.errors.length} problem(s):`];
      for (const e of err.errors) lines.push(`  - ${e.path}: ${e.reason}`);
      const hints = hintsFor(err.errors);
      if (hints.length > 0) {
        lines.push('', 'Hints:');
        for (const h of hints) lines.push(`  - ${h}`);
      }
      return { code: EXIT_INVALID, stdout: '', stderr: lines.join('\n') + '\n' };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Process entry point
// ---------------------------------------------------------------------------

// verified: https://nodejs.org/api/url.html#urlpathtofileurlpath-options (node:url pathToFileURL)
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

// Guarded so importing this module from a test never touches the real process.
if (invokedDirectly) {
  const outcome = run(process.argv.slice(2));
  if (outcome.stdout.length > 0) process.stdout.write(outcome.stdout);
  if (outcome.stderr.length > 0) process.stderr.write(outcome.stderr);
  process.exitCode = outcome.code;
}