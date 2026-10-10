// PLAN.md S2.1: one Upstream per enabled config entry, a status machine, and lazy
// reconnect with exponential backoff 1s..30s (cap).
//
// D8: one broken upstream never breaks the others. Failures are contained per upstream
// and surfaced through `/status`, never by failing the whole gateway.

import type { GatewayConfig, UpstreamConfig } from '../config/schema.js';
import { RemoteUpstream, type RemoteUpstreamOptions } from './remote.js';
import { StdioUpstream } from './stdio.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import type { Logger } from '../observability/logger.js';
import type { ToolListResult, Upstream, UpstreamStatusInfo } from './types.js';

// PLAN.md S2.1: exponential backoff from 1s, capped at 30s.
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** After this many consecutive failures the upstream is parked in `failed`. */
export const MAX_CONSECUTIVE_FAILURES = 5;
/** A `failed` upstream is retried at most this often, on incoming traffic (S4.3 rule). */
export const FAILED_RETRY_INTERVAL_MS = 30_000;

export interface UpstreamManagerOptions {
  secrets?: readonly string[];
  now?: () => number;
  /** Injectable so tests can drive the backoff without waiting. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Build a custom Upstream for one entry (used by tests). */
  factory?: (name: string, config: UpstreamConfig, defaultTimeoutMs: number) => Upstream;
  /** Required to build a stdio upstream: S4.4 logs its stderr. */
  logger?: Logger;
  /**
   * PLAN.md S5.4: the OAuth provider for an upstream, or `undefined` when it does not use
   * OAuth. Returning `undefined` leaves the upstream unauthenticated.
   */
  authProviderFor?: (name: string) => OAuthClientProvider | undefined;
}

export interface UpstreamReport {
  name: string;
  kind: 'remote' | 'local';
  status: UpstreamStatusInfo;
  /** PLAN.md S5.4: present for OAuth upstreams; the local route that starts authorization. */
  oauthStartUrl?: string;
}

interface Entry {
  upstream: Upstream;
  /** True while `#startEntry` is awaiting `upstream.start()`. */
  starting: boolean;
  /** Detaches the upstream's own status subscription. */
  unsubscribe: () => void;
  failures: number;
  /** Set while a backoff timer is pending. */
  retryHandle: unknown;
  lastFailureAt: number;
  /** Last state handed to the status listeners, so repeats are suppressed. */
  lastEmittedState: string | undefined;
}

export class UpstreamManager {
  readonly #config: GatewayConfig;
  readonly #entries = new Map<string, Entry>();
  readonly #options: UpstreamManagerOptions;
  readonly #statusListeners = new Set<(name: string, state: string) => void>();

  constructor(config: GatewayConfig, options: UpstreamManagerOptions = {}) {
    this.#config = config;
    this.#options = options;

    for (const [name, upstreamConfig] of Object.entries(config.mcp)) {
      if (!upstreamConfig.enabled) continue;
      const upstream = this.#create(name, upstreamConfig);
      const entry: Entry = {
        upstream,
        failures: 0,
        retryHandle: undefined,
        lastFailureAt: 0,
        lastEmittedState: undefined,
        starting: false,
        unsubscribe: () => undefined,
      };

      // A child process can die at any time, not only when the manager tries to start it.
      // Without this subscription a mid-session crash left the upstream reporting `error`
      // internally while the manager never counted it: no status event, no backoff, and no
      // escalation to `failed` (PLAN.md S4.3).
      entry.unsubscribe = upstream.onStatusChange((state: string) => {
        this.#onUpstreamStatus(entry, state);
      });

      this.#entries.set(name, entry);
    }
  }

  /**
   * Reacts to a state change the upstream made on its own, e.g. a stdio child exiting.
   *
   * `entry.starting` suppresses accounting for the transition caused by our own
   * `#startEntry` call, which already counts that failure exactly once.
   */
  #onUpstreamStatus(entry: Entry, state: string): void {
    if (entry.starting) return;

    if (state === 'ready') {
      this.#recordSuccess(entry);
    } else if (state === 'error' || state === 'failed') {
      this.#recordFailure(entry);
    }
    this.#emitStatusOnChange(entry, state);
  }

  get names(): string[] {
    return [...this.#entries.keys()];
  }

  /** Every constructed upstream, in config order. */
  all(): Upstream[] {
    return [...this.#entries.values()].map((e) => e.upstream);
  }

  /**
   * S3.4: observes status transitions so the gateway can emit `toolsListChanged` when an
   * upstream coming up or going down changes the merged list. Returns an unsubscribe fn.
   */
  onStatusChange(listener: (name: string, state: string) => void): () => void {
    this.#statusListeners.add(listener);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  #emitStatus(name: string, state: string): void {
    for (const listener of this.#statusListeners) {
      try {
        listener(name, state);
      } catch {
        // A misbehaving listener must not break a status transition.
      }
    }
  }

  /**
   * Emits only on a REAL state change.
   *
   * Without this guard a failing upstream re-emitted `error` on every retry, and each
   * emission made the subscription fan-out recompute the tool list, which in turn forced
   * another start attempt: a self-sustaining loop that never backed off.
   */
  #emitStatusOnChange(entry: Entry, state: string): void {
    if (entry.lastEmittedState === state) return;
    entry.lastEmittedState = state;
    this.#emitStatus(entry.upstream.name, state);
  }

  get(name: string): Upstream | undefined {
    return this.#entries.get(name)?.upstream;
  }

  status(name: string): UpstreamStatusInfo | undefined {
    return this.#entries.get(name)?.upstream.status();
  }

  /** The payload behind `GET /status` (D9: auth-protected, never contains secrets). */
  reports(): UpstreamReport[] {
    return [...this.#entries.entries()].map(([name, entry]) => ({
      name,
      kind: entry.upstream.kind,
      status: entry.upstream.status(),
      // S5.4: /status shows the start URL so an operator can act on auth_required.
      // A route path, never a token.
      ...(entry.upstream.oauthStartUrl === undefined ? {} : { oauthStartUrl: entry.upstream.oauthStartUrl }),
    }));
  }

  /** Starts every NON-LAZY upstream concurrently; a failure in one never rejects the
   * others (D8). Lazy upstreams (S4.3 stdio) are started on first use instead.
   */
  async start(): Promise<void> {
    await Promise.all(
      [...this.#entries.values()]
        .filter((e) => e.upstream.lazy !== true)
        .map((e) => this.#startEntry(e)),
    );
  }

  async stop(): Promise<void> {
    for (const entry of this.#entries.values()) {
      entry.unsubscribe();
      this.#clearRetry(entry);
      await entry.upstream.stop().catch(() => undefined);
      // Stopping is a real state change and must reach the listeners, otherwise a stop()
      // would not be observable as a change to the merged list.
      this.#emitStatusOnChange(entry, entry.upstream.status().state);
    }
  }

  /**
   * PLAN.md S4.5: force-kills every upstream that owns a process tree. Called only after
   * a graceful `stop()` has overrun its deadline, so a child that ignored the SDK's
   * close sequence cannot outlive the gateway.
   */
  async forceStopAll(): Promise<void> {
    await Promise.all(
      [...this.#entries.values()].map(async (entry) => {
        await entry.upstream.forceStop?.().catch(() => undefined);
      }),
    );
  }

  /**
   * Fans out to every ready upstream and returns the results of the healthy ones (D8).
   * Broken upstreams are recorded and simply absent from `results`.
   */
  async listAllTools(signal: AbortSignal): Promise<Map<string, ToolListResult>> {
    const results = new Map<string, ToolListResult>();

    await Promise.all(
      [...this.#entries.values()].map(async (entry) => {
        if (entry.upstream.status().state !== 'ready') {
          await this.#ensureStarted(entry);
          if (entry.upstream.status().state !== 'ready') return;
        }
        try {
          results.set(entry.upstream.name, await entry.upstream.listTools(signal));
          this.#recordSuccess(entry);
        } catch {
          // D8: this upstream is dropped; `reports()` already shows why.
          this.#recordFailure(entry);
        }
      }),
    );

    return results;
  }

  /**
   * Makes sure a not-ready upstream has had its chance (lazy reconnect, PLAN.md S2.1).
   * Called from the request path so a `failed` upstream gets at most one retry per 30s.
   */
  async #ensureStarted(entry: Entry): Promise<void> {
    const state = entry.upstream.status().state;
    if (state === 'starting' || state === 'ready') return;
    // `disabled` means "not started yet" for a LAZY upstream (PLAN.md S4.3) and must not
    // short-circuit: the whole point is that the first request starts the child process.
    // For a non-lazy upstream `disabled` still means "do not touch".
    if (state === 'disabled' && !entry.upstream.lazy) return;

    // `auth_required` cannot be fixed by retrying: it needs a human to visit the start URL.
    // Without this, every incoming request re-attempted the connection and hammered the
    // upstream (and its 401 endpoint) instead of waiting for consent.
    if (state === 'auth_required') return;

    if (state === 'failed') {
      const elapsed = this.#now() - entry.lastFailureAt;
      if (elapsed < FAILED_RETRY_INTERVAL_MS) return;
    }
    // While a backoff timer is armed, incoming traffic must NOT force an early attempt.
    // Without this the retry timer and the request path raced each other and the upstream
    // was hammered every few hundred milliseconds regardless of the backoff.
    if (entry.retryHandle !== undefined) return;
    await this.#startEntry(entry);
  }

  async #startEntry(entry: Entry): Promise<void> {
    this.#clearRetry(entry);
    entry.starting = true;
    try {
      await entry.upstream.start().catch(() => undefined);
    } finally {
      entry.starting = false;
    }
    const state = entry.upstream.status().state;
    this.#emitStatusOnChange(entry, state);
    if (state === 'ready') {
      entry.failures = 0;
      return;
    }
    if (state === 'disabled') return;
    // A failed start counts as a failure, otherwise the backoff never grows.
    entry.failures += 1;
    entry.lastFailureAt = this.#now();
    this.#scheduleRetry(entry);
  }

  #recordSuccess(entry: Entry): void {
    entry.failures = 0;
    this.#clearRetry(entry);
  }

  /**
   * Counts a failure, parks the upstream in `failed` after
   * `MAX_CONSECUTIVE_FAILURES`, and otherwise arms the exponential backoff.
   */
  #recordFailure(entry: Entry): void {
    entry.failures += 1;
    entry.lastFailureAt = this.#now();
    if (entry.failures >= MAX_CONSECUTIVE_FAILURES) {
      entry.upstream.stop().catch(() => undefined);
      this.#clearRetry(entry);
      return;
    }
    this.#scheduleRetry(entry);
  }

  #scheduleRetry(entry: Entry): void {
    if (entry.retryHandle !== undefined) return;
    const delay = backoffFor(entry.failures);
    const setTimer = this.#options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    entry.retryHandle = setTimer(() => {
      entry.retryHandle = undefined;
      void this.#startEntry(entry);
    }, delay);
  }

  #clearRetry(entry: Entry): void {
    if (entry.retryHandle === undefined) return;
    const clear = this.#options.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
    clear(entry.retryHandle);
    entry.retryHandle = undefined;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #create(name: string, upstreamConfig: UpstreamConfig): Upstream {
    if (this.#options.factory !== undefined) {
      return this.#options.factory(name, upstreamConfig, this.#config.gateway.defaultTimeoutMs);
    }
    const base = { secrets: this.#options.secrets ?? [], logger: this.#loggerFor(name) };
    if (upstreamConfig.type === 'local') {
      // PLAN.md S4.1/S4.3.
      return new StdioUpstream(name, upstreamConfig, this.#config.gateway.defaultTimeoutMs, {
        ...base,
        ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
        ...(this.#options.setTimeoutFn === undefined ? {} : { setTimeoutFn: this.#options.setTimeoutFn }),
        ...(this.#options.clearTimeoutFn === undefined ? {} : { clearTimeoutFn: this.#options.clearTimeoutFn }),
      });
    }
    const remoteOptions: RemoteUpstreamOptions = {};
    if (this.#options.secrets !== undefined) remoteOptions.secrets = this.#options.secrets;
    if (this.#options.now !== undefined) remoteOptions.now = this.#options.now;
    // S5.4: an upstream with `oauth` gets a provider; one without is left unauthenticated.
    const authProvider = this.#options.authProviderFor?.(name);
    if (authProvider !== undefined) remoteOptions.authProvider = authProvider;
    return new RemoteUpstream(name, upstreamConfig, this.#config.gateway.defaultTimeoutMs, remoteOptions);
  }

  #loggerFor(name: string): Logger {
    const parent = this.#options.logger;
    if (parent === undefined) {
      throw new Error('UpstreamManager needs a logger to build a stdio upstream');
    }
    // S4.4: stderr lines are logged with the upstream name.
    return parent.child({ upstream: name });
  }
}

/** 1s, 2s, 4s, 8s, 16s, 30s, 30s, ... */
export function backoffFor(failures: number): number {
  const exponent = Math.max(0, failures - 1);
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
}