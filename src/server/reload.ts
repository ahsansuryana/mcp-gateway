// PLAN.md S7.1: hot reload — watch the config file and handle SIGHUP.
//
// Three rules the implementation is built around:
//
//   1. An INVALID new config keeps the old one running and logs the error. A gateway that
//      dies because someone saved a file with a typo is worse than one that keeps serving.
//   2. The error names the config KEY PATH only, never a value (PLAN.md rule 9). A
//      substitution failure in a secret must not print the secret.
//   3. Credentials and tokens of upstreams that did not change must survive. A reload is
//      not a reason to make every user re-consent.
//
// verified: nodejs.org/api/fs.html#fswatchfilename-options-listener (fs.watch 'change')
// verified: nodejs.org/api/process.html#signal-events (process.on('SIGHUP'))

import { watch, type FSWatcher } from 'node:fs';
import { loadConfig, ConfigErrorList } from '../config/load.js';
import type { GatewayConfig } from '../config/schema.js';
import type { Logger } from '../observability/logger.js';
import { configDigest } from './config-digest.js';

export type ReloadOutcome = 'applied' | 'unchanged' | 'rejected';

export interface ReloadResult {
  outcome: ReloadOutcome;
  config?: GatewayConfig;
  /** For `rejected`: the reason, safe to log. */
  reason?: string;
  added: string[];
  removed: string[];
  changed: string[];
}

export interface ReloaderOptions {
  path: string;
  logger: Logger;
  /** Applies a validated config. Called only on success. */
  apply: (config: GatewayConfig) => Promise<void> | void;
  /** Settles while a reload is in flight, so a burst of writes applies once. */
  debounceMs?: number;
  /** Injectable for tests. */
  load?: (path: string) => GatewayConfig;
}

export class ConfigReloader {
  readonly #options: ReloaderOptions;
  #current: GatewayConfig;
  #digest: string;
  #timer: NodeJS.Timeout | undefined;
  #watcher: FSWatcher | undefined;
  #closed = false;

  constructor(options: ReloaderOptions, current: GatewayConfig) {
    this.#options = options;
    this.#current = current;
    this.#digest = configDigest(current);
  }

  get config(): GatewayConfig {
    return this.#current;
  }

  /**
   * Validates the file and applies it ONLY if it parses and differs.
   *
   * Never throws: a rejected reload is a logged outcome, not an exception that could take
   * the process down.
   */
  async reload(): Promise<ReloadResult> {
    if (this.#closed) {
      return { outcome: 'rejected', reason: 'reloader is closed', added: [], removed: [], changed: [] };
    }

    let next: GatewayConfig;
    try {
      const load = this.#options.load ?? ((p: string) => loadConfig({ path: p }).config);
      next = load(this.#options.path);
    } catch (err) {
      // The reason names the config key path only. ConfigErrorList already does this;
      // anything else is reduced to its name so a value can never leak.
      const reason =
        err instanceof ConfigErrorList
          ? err.message
          : `config could not be read (${err instanceof Error ? err.name : 'unknown error'})`;
      this.#options.logger.error({ reason }, 'config reload rejected; keeping the running configuration');
      return { outcome: 'rejected', reason, added: [], removed: [], changed: [] };
    }

    const nextDigest = configDigest(next);
    if (nextDigest === this.#digest) {
      return { outcome: 'unchanged', added: [], removed: [], changed: [] };
    }

    const { added, removed, changed } = diffUpstreams(this.#current, next);

    try {
      await this.#options.apply(next);
    } catch (err) {
      const reason = err instanceof Error ? err.name : 'unknown error';
      this.#options.logger.error({ reason }, 'applying the new configuration failed; keeping the running one');
      return { outcome: 'rejected', reason, added: [], removed: [], changed: [] };
    }

    this.#current = next;
    this.#digest = nextDigest;
    this.#options.logger.info(
      { added, removed, changed },
      'configuration reloaded',
    );
    return { outcome: 'applied', config: next, added, removed, changed };
  }

  /**
   * Watches the file and registers SIGHUP.
   *
   * `fs.watch` reports `'change'` for editors that write in place and `'rename'` for those
   * that replace the file, so both are handled. The debounce collapses the several events a
   * single save produces into one reload.
   */
  start(): void {
    if (this.#watcher !== undefined || this.#closed) return;
    const debounce = this.#options.debounceMs ?? 150;

    const schedule = (): void => {
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        void this.reload();
      }, debounce);
      this.#timer.unref?.();
    };

    // verified: nodejs.org/api/fs.html#fswatchfilename-options-listener — the listener
    //   receives (eventType, filename); eventType is 'rename' or 'change'.
    this.#watcher = watch(this.#options.path, { persistent: false }, (_event, _name) => {
      this.#options.logger.debug('config file changed on disk');
      schedule();
    });
    this.#watcher.on('error', (err: Error) => {
      this.#options.logger.warn({ reason: err.name }, 'config watch failed; SIGHUP still works');
    });

    this.#scheduleRef = schedule;
    process.on('SIGHUP', this.#scheduleRef);
  }

  stop(): void {
    this.#closed = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#watcher?.close();
    this.#watcher = undefined;
    if (this.#scheduleRef !== undefined) {
      process.removeListener('SIGHUP', this.#scheduleRef);
      this.#scheduleRef = undefined;
    }
  }

  /**
   * The SIGHUP handler, stored so `stop()` can detach the exact function it registered.
   * A separate function reference is required: `process.removeListener` matches identity.
   */
  #scheduleRef: (() => void) | undefined;
}

/**
 * Which upstreams were added, removed or changed.
 *
 * "Changed" compares a DIGEST, not object identity: the same config re-serialised parses
 * to a different object, and treating that as a change would restart everything on every
 * reload.
 */
export function diffUpstreams(
  before: GatewayConfig,
  after: GatewayConfig,
): { added: string[]; removed: string[]; changed: string[] } {
  const beforeNames = Object.keys(before.mcp);
  const afterNames = Object.keys(after.mcp);
  const added = afterNames.filter((n) => !beforeNames.includes(n));
  const removed = beforeNames.filter((n) => !afterNames.includes(n));
  const changed = afterNames.filter(
    (n) => beforeNames.includes(n) && configDigest(before.mcp[n]) !== configDigest(after.mcp[n]),
  );
  return { added, removed, changed };
}