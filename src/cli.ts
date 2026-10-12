#!/usr/bin/env node
// PLAN.md S1.4: `validate -c <file>` exits 0 on a valid config and 1 with a
// human-readable list of errors (key path + reason, never values).
//
// PLAN.md rule 9: no secret value ever reaches stdout/stderr or an exit message.
//
// argv handling is pure so the behaviour is unit-testable; only `main()` touches process.
//
// THIS SHEBANG IS LOAD-BEARING. `dist/cli.js` is the `bin` target for `npm i -g`, so the
// kernel execs it directly and line 1 must be exactly `#!/usr/bin/env node`. A shebang
// that is not the first line is not a shebang; one with a CRLF carries an invisible \r into
// the interpreter path. `.gitattributes` pins this file to LF because development happens on
// Windows, which would otherwise check it out with CRLF and break every Linux install.

import { pathToFileURL } from 'node:url';
import { main } from './index.js';

import { runInit } from './config/init.js';
import { packageName, packageVersion } from './package-info.js';
import { CONFIG_PATH_ENV_VAR,
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
  /** True when the command is `serve`: the caller must start the gateway. */
  serve?: boolean;
}

export const USAGE = `mcp-gateway — aggregated MCP gateway

Usage:
  mcp-gateway serve [-c <path>]     run the gateway (default)
  mcp-gateway init [--local]        create a starter config in .mcp-gateway/
  mcp-gateway validate [-c <path>]   validate a gateway config and exit
  mcp-gateway help                   show this message

Options:
  -c, --config <path>   config file path
                        (default: $${CONFIG_PATH_ENV_VAR}, or ./.mcp-gateway/gateway.json,
                         or <home>/.mcp-gateway/gateway.json)

Config is searched in this order, first hit wins:
  1. -c / --config <path>
  2. $${CONFIG_PATH_ENV_VAR}
  3. ./.mcp-gateway/gateway.json
  4. $GATEWAY_HOME (or your home directory) + /.mcp-gateway/gateway.json
  5. ./gateway.json                    deprecated, warns

Exit codes:
  0  config is valid
  1  config is invalid
  2  usage error
`;



/** Pure argv handling (PLAN.md S1.4). */
export function run(argv: readonly string[]): CliOutcome {
  const [command, ...rest] = argv;

  // No command at all means SERVE, which is what USAGE has always claimed ("serve
  // [-c <path>] run the gateway (default)"). It did not: `run([])` fell into the same
  // branch as `help` and printed usage, so `npm start` and `npm run dev` exited without
  // starting anything while the help text said otherwise. With no arguments there is no
  // other command the user could have meant, so serving is the only sensible reading.
  if (command === undefined) return { code: EXIT_OK, stdout: '', stderr: '', serve: true };

  if (command === 'help' || command === '--help' || command === '-h') {
    return { code: EXIT_OK, stdout: USAGE, stderr: '' };
  }
  if (command === '--version' || command === '-v') {
    // Read from package.json rather than hardcoding it. The previous hardcoded
    // 'mcp-gateway 0.0.0' was already wrong the moment the version changed, and `0.0.0`
    // is not the version this package would ever be published under.
    return { code: EXIT_OK, stdout: `${packageName()} ${packageVersion()}\n`, stderr: '' };
  }
  // PLAN.md §5 lists `serve` as a command. It was MISSING: `run()` only knew `help` and
  // `validate`, so the container image's `CMD ["serve"]` exited with a usage error and the
  // gateway could only be started by passing no arguments at all.
  if (command === 'init') return runInitCommand(rest);
  if (command === 'serve') return { code: EXIT_OK, stdout: '', stderr: '', serve: true };
  if (command !== 'validate') {
    // A bare flag with no command word (`mcp-gateway -c ./gateway.json`) is the default
    // serve with a config flag, not an unknown command. Without this, the moment `serve`
    // became the default the only way to pass a path was to also type `serve`, which is
    // exactly the redundancy the default exists to remove.
    if (command.startsWith('-')) return { code: EXIT_OK, stdout: '', stderr: '', serve: true };
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
      // When nothing was found, saying "INVALID <the default path>" is wrong: there is no
      // file at that path to be invalid. The reason already lists every path that was
      // checked, so the header only has to stop claiming a file exists.
      const notFound = err.errors.some((e) => e.reason.startsWith('no gateway config found'));
      const lines: string[] = [
        notFound ? `NOT FOUND  ${displayPath}` : `INVALID  ${displayPath}`,
        '',
        `${err.errors.length} problem(s):`,
      ];
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

/**
 * `mcp-gateway init [--local]`
 *
 * Writes the shipped example config to `<GATEWAY_HOME or home>/.mcp-gateway/gateway.json`,
 * or to `./.mcp-gateway/gateway.json` with `--local`.
 */
export function runInitCommand(argv: readonly string[]): CliOutcome {
  let local = false;
  for (const arg of argv) {
    if (arg === '--local') {
      local = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      return { code: EXIT_OK, stdout: INIT_USAGE, stderr: '' };
    }
    return {
      code: EXIT_USAGE,
      stdout: '',
      stderr: `unknown option for init: ${arg}\n\n${INIT_USAGE}`,
    };
  }

  const result = runInit({ local });
  if (result.status === 'exists') {
    // Not an error: the user's config already exists and rewriting it could destroy real
    // credentials. A non-zero code still signals "init did not do what you asked".
    return { code: EXIT_INVALID, stdout: '', stderr: `${result.message ?? ''}
` };
  }
  return {
    code: EXIT_OK,
    stdout: `created ${result.path}\n` + 'edit it, then run: mcp-gateway\n',
    stderr: '',
  };
}

export const INIT_USAGE = `mcp-gateway init — create a starter config

Usage:
  mcp-gateway init            write <GATEWAY_HOME or home>/.mcp-gateway/gateway.json
  mcp-gateway init --local    write ./.mcp-gateway/gateway.json instead

Never overwrites an existing file. Written with mode 0600.
`;

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

  if (outcome.serve === true) {
    // PLAN.md section 5 lists `serve` as a CLI command, and the container image runs
    // `node dist/cli.js serve`. Without this the command exited with a usage error, which is
    // how the missing command was found: the smoke container refused to start.
    //
    // The flags start one position later when a command word was given (`serve -c path`,
    // slice(3)) and at the beginning when it was not (`-c path`, slice(2)), because a bare
    // `-c` is now the default serve. Reading slice(3) unconditionally would silently drop
    // the path and start the gateway on the wrong config.
    const rest = process.argv.slice(2);
    const restOffset = rest[0] === 'serve' ? 3 : 2;
    const flag = parseConfigFlag(process.argv.slice(restOffset));
    if (flag.error !== undefined) {
      process.stderr.write(`${flag.error}
`);
      process.exitCode = EXIT_USAGE;
    } else {
      // The path goes to `main()` as an argument. It used to be rewritten into
      // `process.argv` instead, and `main()` never read it -- so `-c` was silently ignored
      // and the gateway fell back to $GATEWAY_CONFIG or ./gateway.json. Whenever
      // GATEWAY_CONFIG held the same value this looked like it worked.
      //
      // Deliberately NOT awaited at top level. `main()` returns once the server is
      // listening and the open listener is what keeps the process alive; awaiting it made
      // Node report "unsettled top-level await" and exit.
      void main(flag.path === undefined ? {} : { configPath: flag.path }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${message}
`);
        process.exitCode = 1;
      });
    }
  } else {
    process.exitCode = outcome.code;
  }
}