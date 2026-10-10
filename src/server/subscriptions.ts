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
import type { ListChangedKind } from '../upstream/types.js';

/** Bursts inside this window collapse into one notification. */
export const DEBOUNCE_MS = 250;

export interface SubscriptionFanoutDeps {
  manager: UpstreamManager;
  logger: Logger;
  /** Recomputes the current namespaced tool-name set. */
  computeToolNames: () => Promise<string[]>;
  /** Publishes `notifications/tools/list_changed` on the gateway's own bus. */
  notifyToolsChanged: () => void;
  /**
   * Publishes `notifications/prompts/list_changed` and
   * `notifications/resources/list_changed`.
   *
   * B-24(b): these were missing, so the gateway advertised prompts/resources
   * `listChanged` while only ever publishing the tools notification. Either relay the
   * event or stop claiming it; the SDK offers both.
   *
   * verified: node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts
   *   (ServerNotifier.promptsChanged / .resourcesChanged)
   */
  notifyPromptsChanged: () => void;
  notifyResourcesChanged: () => void;
}

/** The notification types a subscription filter can ask for. */
export interface ListChangedTypes {
  toolsListChanged?: true;
  promptsListChanged?: true;
  resourcesListChanged?: true;
}

/**
 * The filter the gateway asks every upstream for.
 * verified: docs/ref/spec-2026-07-28-basic-patterns-subscriptions.md (Notification Filter)
 */
export const REQUESTED_FILTER: ListChangedTypes = {
  toolsListChanged: true,
  promptsListChanged: true,
  resourcesListChanged: true,
};

export class SubscriptionFanout {
  readonly #deps: SubscriptionFanoutDeps;
  readonly #controller = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #lastPublished: string[] | undefined;
  /** Which lists an UPSTREAM pushed in the current debounce window. */
  #upstreamEvents = new Set<ListChangedKind>();
  /**
   * The honoured filter of each OPEN upstream subscription, keyed by upstream name.
   *
   * B-24(a): this was a single flat union that was only ever added to, so a subscription
   * that closed left its contribution behind forever and the gateway kept advertising
   * `listChanged` it could no longer receive. Keeping one entry per upstream makes
   * removal exact when the subscription ends.
   *
   * verified: docs/ref/spec-2026-07-28-basic-patterns-subscriptions.md ("The `notifications`
   *   field in the acknowledgment reflects the subset the server agreed to honor"; and
   *   "Cancellation" — a subscription ends when the client cancels, the server tears it
   *   down, or the transport closes)
   */
  readonly #honoredByUpstream = new Map<string, ListChangedTypes>();
  #started = false;

  /**
   * What the gateway can ACTUALLY relay downstream right now: the union of the honoured
   * filters over the still-OPEN upstream subscriptions. D17 requires the gateway's own
   * advertised `listChanged` bits to be derived from this, so a downstream acknowledgement
   * never claims more than some open upstream really honoured.
   */
  supportedTypes(): ListChangedTypes {
    const union: ListChangedTypes = {};
    for (const honored of this.#honoredByUpstream.values()) {
      for (const key of Object.keys(honored) as (keyof ListChangedTypes)[]) {
        if (honored[key] === true) union[key] = true;
      }
    }
    return union;
  }

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
        upstream.onListChanged?.((kind) => { this.markDirty(kind); });
        const subscription = await upstream.listen(this.#controller.signal);
        this.#recordHonored(upstream.name, subscription.honoredFilter);
        void subscription.closed.then((how: string) => {
          // B-24(a): the subscription is gone, so its honoured filter is no longer
          // something the gateway can receive. Drop the contribution BEFORE recomputing,
          // otherwise the advertisement outlives the subscription.
          this.#forgetHonored(upstream.name);
          if (how === 'local') {
            this.markDirty();
            return;
          }
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
 * Merges an upstream's acknowledged filter into the union, and WARNS when the server
 * honoured strictly less than the gateway asked for.
 *
 * A partial subscription is normal, not an error: the spec says the acknowledgement reflects
 * the subset the server agreed to honour, and a client SHOULD degrade gracefully
 * (verified: docs/ref/spec-2026-07-28-basic-patterns-subscriptions.md, "Acknowledgment").
 * The gateway therefore keeps the union for capability advertisement and treats a narrower
 * answer as a partial subscription rather than silently assuming full coverage.
 */
#recordHonored(upstreamName: string, honored: ListChangedTypes): void {
    const dropped = (Object.keys(REQUESTED_FILTER) as (keyof ListChangedTypes)[]).filter(
      (key) => REQUESTED_FILTER[key] === true && honored[key] !== true,
    );

    if (dropped.length > 0) {
      this.#deps.logger.warn(
        { upstream: upstreamName, dropped, honored },
        'upstream honoured a partial subscriptions/listen filter',
      );
    }

    // Replace, not merge: one open subscription per upstream, and re-listening must not
    // accumulate bits the current subscription did not honour.
    this.#honoredByUpstream.set(upstreamName, { ...honored });
  }

  /**
   * Drops an upstream's contribution when its subscription ends.
   *
   * verified: docs/ref/spec-2026-07-28-basic-patterns-subscriptions.md ("Cancellation": a
   *   subscription ends when the client cancels it, the server tears it down, or the
   *   underlying transport closes — in every case the stream no longer carries events)
   */
  #forgetHonored(upstreamName: string): void {
    if (!this.#honoredByUpstream.delete(upstreamName)) return;
    const remaining = this.supportedTypes();
    this.#deps.logger.info(
      { upstream: upstreamName, supportedTypes: remaining },
      'upstream subscription ended; list-changed advertisement recomputed',
    );
  }

  /**
   * Marks the merged list as potentially changed.
   *
   * `fromUpstream` distinguishes the two sources:
   *   - an UPSTREAM push event is always relayed (debounced), because the upstream may have
   *     changed a description, an input schema or anything else the gateway cannot see;
   *     B-24(b) now relays the SAME kind that arrived instead of always publishing tools;
   *   - a STATUS transition only notifies when the merged name set really changed, so
   *     repeated flapping between `ready` and `error` cannot spam clients. Only the tool
   *     list is recomputed there, so only tools are notified.
   */
  markDirty(fromUpstream?: ListChangedKind): void {
    if (fromUpstream !== undefined) this.#upstreamEvents.add(fromUpstream);
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, DEBOUNCE_MS);
    this.#timer.unref?.();
  }

  /** Recomputes and, when warranted, publishes the matching list-changed notifications. */
  async flush(): Promise<boolean> {
    const upstreamEvents = this.#upstreamEvents;
    this.#upstreamEvents = new Set<ListChangedKind>();

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

    // D17(2): an upstream push is always relayed. D17(3): a status transition only when
    // the merged name set really changed.
    const tools = upstreamEvents.has('tools') || changed;
    if (tools) this.#deps.notifyToolsChanged();
    if (upstreamEvents.has('prompts')) this.#deps.notifyPromptsChanged();
    if (upstreamEvents.has('resources')) this.#deps.notifyResourcesChanged();

    return tools || upstreamEvents.has('prompts') || upstreamEvents.has('resources');
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