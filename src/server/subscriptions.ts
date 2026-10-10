// PLAN.md S3.4: the gateway subscribes to upstream `subscriptions/listen` streams and
// fans change events out to the opted-in downstream listeners, and emits
// `toolsListChanged` itself when an upstream's status transition changes the merged list.
//
// Verified facilities (Sprint 0 S0.3h):
//   - upstream: `Client.listen(filter, options) -> McpSubscription`
//     (spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts)
//   - downstream: `McpHttpHandler.notify.toolsChanged()` and friends
//     (spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts)
//
// Q-SUBSFWD: PLAN.md does not define the fan-out policy. The policy implemented here, and
// offered for ratification, is:
//   1. an upstream event only *marks* the merged list dirty;
//   2. the gateway then RECOMPUTES the namespaced tool-name set and emits
//      `toolsListChanged` only when that set actually differs from the last published one;
//   3. bursts inside `DEBOUNCE_MS` are coalesced into one notification;
//   4. an upstream's status transition (ready <-> error/failed/disabled) marks the list
//      dirty too, which is how PLAN.md's "changes the merged list" is realised.
// This makes the notification count equal the number of real list changes, which is what a
// client can actually use.

import type { Logger } from '../observability/logger.js';
import type { UpstreamManager } from '../upstream/manager.js';
import type { ToolsAggregatorDeps } from '../aggregate/tools.js';

/** Bursts inside this window collapse into one notification. */
export const DEBOUNCE_MS = 250;

export interface SubscriptionFanoutDeps {
  manager: UpstreamManager;
  logger: Logger;
  /** Recomputes the current namespaced tool-name set. */
  computeToolNames: () => Promise<string[]>;
  /** Publishes `notifications/tools/list_changed` on the gateway's own bus. */
  notifyToolsChanged: () => void;
}

export class SubscriptionFanout {
  readonly #deps: SubscriptionFanoutDeps;
  readonly #controller = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #lastPublished: string[] | undefined;
  #started = false;

  constructor(deps: SubscriptionFanoutDeps) {
    this.#deps = deps;
  }

  get started(): boolean {
    return this.#started;
  }

  /**
   * Opens one upstream listen stream per healthy upstream and starts watching status
   * transitions. Safe to call once; a second call is a no-op.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    // Seed with the current set so the first real change is detected correctly.
    this.#lastPublished = await this.#deps.computeToolNames().catch(() => undefined);

    for (const upstream of this.#deps.manager.all()) {
      if (upstream.status().state !== 'ready' || upstream.listen === undefined) continue;
      try {
        const subscription = await upstream.listen(this.#controller.signal);
        void subscription.closed.then((how: string) => {
          if (how === 'local') return;
          this.#deps.logger.warn({ upstream: upstream.name, how }, 'upstream subscription closed');
          this.markDirty();
        });
      } catch (err) {
        // Sprint 0 proved this must not be fatal: an upstream without the modern era has
        // no subscriptions/listen, and the gateway still serves tools.
        this.#deps.logger.debug(
          { upstream: upstream.name, reason: err instanceof Error ? err.message : String(err) },
          'upstream does not support subscriptions/listen',
        );
      }
    }

    // PLAN.md S3.4: the gateway ALSO emits when an upstream status transition changes the
    // merged list. Status transitions are what add or remove whole upstreams.
    this.#deps.manager.onStatusChange((name, state) => {
      this.#deps.logger.info({ upstream: name, state }, 'upstream status changed');
      this.markDirty();
    });
  }

  /** Marks the merged list as potentially changed; the recompute decides whether to notify. */
  markDirty(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, DEBOUNCE_MS);
    this.#timer.unref?.();
  }

  /** Forces an immediate recompute+notify, bypassing the debounce. Used by tests. */
  async flush(): Promise<boolean> {
    let next: string[];
    try {
      next = await this.#deps.computeToolNames();
    } catch (err) {
      this.#deps.logger.warn(
        { reason: err instanceof Error ? err.message : String(err) },
        'could not recompute the merged tool list',
      );
      return false;
    }

    const previous = this.#lastPublished;
    this.#lastPublished = next;
    if (previous !== undefined && sameSet(previous, next)) return false;

    this.#deps.notifyToolsChanged();
    return true;
  }

  stop(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#controller.abort();
    this.#started = false;
    return Promise.resolve();
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((v) => setA.has(v));
}

export type { ToolsAggregatorDeps };