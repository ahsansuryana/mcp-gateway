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
//   1. bursts inside `DEBOUNCE_MS` are coalesced into one notification;
//   2. an UPSTREAM push event is always relayed after the recompute, because the upstream may
//      have changed a description or a schema that the gateway cannot see in the name set;
//   3. an upstream STATUS transition notifies only when the merged name set really changed,
//      so repeated flapping between `ready` and `error` cannot spam clients;
//   4. that is how PLAN.md's "the gateway also emits toolsListChanged when an upstream's
//      status transitions change the merged list" is realised.

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
  /** Set when an UPSTREAM pushed a change event in the current debounce window. */
  #upstreamEvent = false;
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
        // Register the notification handlers FIRST: `listen()` only opens the stream, and a
        // notification arriving before a handler exists would be dropped
        // (verified in spikes/out-probe-subscriptions.txt).
        upstream.onListChanged?.(() => { this.markDirty(true); });
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

  /**
   * Marks the merged list as potentially changed.
   *
   * `fromUpstream` distinguishes the two sources:
   *   - an UPSTREAM push event is always relayed (debounced), because the upstream may have
   *     changed a description, an input schema or anything else the gateway cannot see;
   *   - a STATUS transition only notifies when the merged name set really changed, so
   *     repeated flapping between `ready` and `error` cannot spam clients.
   */
  markDirty(fromUpstream = false): void {
    if (fromUpstream) this.#upstreamEvent = true;
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, DEBOUNCE_MS);
    this.#timer.unref?.();
  }

  /** Recomputes and, when warranted, publishes `notifications/tools/list_changed`. */
  async flush(): Promise<boolean> {
    const upstreamEvent = this.#upstreamEvent;
    this.#upstreamEvent = false;

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
    const changed = previous === undefined || !sameSet(previous, next);

    if (changed || upstreamEvent) {
      this.#deps.notifyToolsChanged();
      return true;
    }
    return false;
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