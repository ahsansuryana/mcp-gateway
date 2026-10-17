// ADR 0013: what happens when no config exists anywhere.
//
// `mcp-gateway` with nothing installed should start, not print a list of five paths it
// checked. The resolution ORDER is unchanged from ADR 0012 -- project, then home, then
// legacy -- because that order is already locked by test/unit/config-paths.test.ts and
// changing it would break every existing installation. This file adds exactly one branch at
// the end of it.
//
// THE SCOPE OF WHAT THIS FILE DECIDES: existence only.
//
// `ensureConfig` answers "is there a config here?" and nothing else. It does not parse,
// does not substitute and does not validate, and it never touches a file that exists. An
// INVALID config is not this file's business: `loadConfig` reports that, with the key path,
// and doing it here too would mean two places rendering the same class of error differently.
//
// IT WRITES TO THE HOME DIRECTORY ONLY, never to the working directory.
//
// Auto-create makes a file appear. Making one appear inside whatever directory someone
// happened to run `mcp-gateway` from would put a file in their project -- often read-only,
// often under version control, often surprising. `--local` stays the way to get a
// project-local config, and it stays explicit.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { runInit, renderTemplate } from './init.js';
import { CONFIG_DIR_NAME, CONFIG_FILENAME, homeRoot, resolveConfigLocation } from './paths.js';
import { generateApiKey } from './keys.js';

export type EnsureStatus = 'found' | 'created' | 'failed';

export interface EnsureResult {
  status: EnsureStatus;
  /** Absolute path, for every status. For 'failed' this is where the write was attempted. */
  path: string;
  /** True only when THIS call created the file. */
  created: boolean;
  /**
   * The generated key, present only when this call generated it.
   *
   * Returned rather than written to a log because it is shown ONCE, to the owner, in the
   * startup banner. It is never logged, never sent to /status, and never appears in an error
   * message (PLAN.md rule 9).
   */
  generatedKey?: string;
  /** For 'failed': a sentence, never a stack trace. */
  reason?: string;
}

export interface EnsureOptions {
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  homedir?: string;
  /** Injected so tests never depend on the real machine's home directory. */
  exists?: (absolutePath: string) => boolean;
  /** Injected so tests never write to a real filesystem unless they mean to. */
  runInitFn?: typeof runInit;
  generateKeyFn?: () => string;
  /** The bind host written into a generated config. Loopback; see renderTemplate. */
  host?: string;
}

export function ensureConfig(options: EnsureOptions = {}): EnsureResult {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? ((p: string) => existsSync(p));

  const located = resolveConfigLocation({
    env,
    cwd,
    homedir: options.homedir ?? homedir(),
    exists,
  });

  if ('path' in located) {
    // Found: the file exists and is not this function's business. Anything wrong with it is
    // loadConfig's to report, with the key path that is wrong.
    return { status: 'found', path: located.path, created: false };
  }

  // Nothing anywhere. Write the home one -- and only the home one.
  const target = join(homeRoot(env), CONFIG_DIR_NAME, CONFIG_FILENAME);
  const generate = options.generateKeyFn ?? generateApiKey;
  const key = generate();

  // Re-check immediately before writing. resolveConfigLocation already looked, but this
  // process may have been slow to reach here, and the whole point of `init` not
  // overwriting is that a real config can hold real credentials.
  if (exists(target)) {
    return { status: 'found', path: target, created: false };
  }

  const run = options.runInitFn ?? runInit;
  const result = run({
    env,
    cwd,
    target,
    contents: renderTemplate(options.host ?? '127.0.0.1', key),
    exists,
  });

  if (result.status === 'error') {
    // The generated key is deliberately NOT returned on failure: it is written nowhere, so
    // showing it would be showing a key that does not exist.
    const reason =
      result.message ?? `could not write a config to ${target}; check that the directory is writable`;
    return { status: 'failed', path: target, created: false, reason };
  }
  if (result.status === 'exists') {
    // Raced with another process, or created between the two checks above.
    return { status: 'found', path: result.path, created: false };
  }

  return { status: 'created', path: result.path, created: true, generatedKey: key };
}