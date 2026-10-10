// The internal Upstream contract (PLAN.md §5). Types are adapted to the SDK v2 real
// types, verified in Sprint 0 — see docs/SDK-NOTES.md.

import type {
  CallToolResult,
  CacheScope,
  GetPromptResult,
  ListPromptsResult,
  ListResourcesResult,
  ReadResourceResult,
  Tool,
} from '@modelcontextprotocol/server';

/** PLAN.md §5 status machine. */
export type UpstreamStatus =
  | 'disabled'
  | 'starting'
  | 'ready'
  | 'auth_required'
  | 'error'
  | 'failed';

export type UpstreamKind = 'remote' | 'local';

export interface UpstreamStatusInfo {
  state: UpstreamStatus;
  /** Epoch millis when the state was last entered (PLAN.md §5 `since`). */
  since: number;
  /** MUST already be redacted: PLAN.md rule 9 forbids secret values in error text. */
  lastError?: string;
}

/**
 * What one upstream contributes to `tools/list`.
 *
 * `ttlMs`/`cacheScope` are the upstream's OWN cache hints, forwarded verbatim so the
 * aggregate can compute D11's minimum. They are optional because a pre-2026-07-28
 * upstream omits them and the spec says to assume `ttlMs: 0` / treat as immediately stale.
 */
export interface ToolListResult {
  tools: Tool[];
  ttlMs?: number;
  cacheScope?: CacheScope;
}

export interface Upstream {
  readonly name: string;
  readonly kind: UpstreamKind;
  /** Per-upstream request timeout in ms (PLAN.md §6 `timeout`, or the gateway default). */
  readonly timeoutMs: number;

  /**
   * PLAN.md S4.3: a lazy upstream is started on FIRST USE, not at gateway start. stdio
   * upstreams are lazy because spawning `npx` is expensive and may download a package.
   */
  readonly lazy?: boolean;

  status(): UpstreamStatusInfo;

  /**
   * Establishes the connection. Idempotent. A failure moves the status to `error`
   * (or `auth_required` on a 401) rather than throwing — D8: one broken upstream never
   * breaks the others.
   */
  start(): Promise<void>;

  stop(): Promise<void>;

  /**
   * D8: rejects when this upstream is unusable, so the caller can drop it from the
   * aggregate and report it in `/status`.
   */
  listTools(signal: AbortSignal): Promise<ToolListResult>;

  /**
   * D12: rejects when the failure is upstream-caused (down / timeout / needs auth), so
   * the caller can turn it into an `isError` tool result instead of a JSON-RPC error.
   *
   * `extra` carries the multi-round-trip fields. PLAN.md §5 does not mention them, but the
   * SDK seam LIFTS `inputResponses` / `requestState` out of `params` before the handler
   * runs, so a proxy MUST re-attach them or MRTR silently fails (S3.5, docs/adr pending —
   // see docs/OPEN-QUESTIONS.md Q-MRTRPROXY). Verified in spikes/spike-1.mjs: without this
   * the upstream is polled for 10 rounds and the call fails.
   *
   * `options.onprogress` re-emits the upstream's progress notifications downstream (S3.6).
   */
  callTool(
    name: string,
    args: unknown,
    meta: unknown,
    signal: AbortSignal,
    extra?: { requestState?: unknown; inputResponses?: Record<string, unknown> },
    options?: { onprogress?: (progress: unknown) => void | Promise<void> },
  ): Promise<CallToolResult>;

  // --- added in Sprint 3 (PLAN.md §5) -------------------------------------

  listResources(signal: AbortSignal): Promise<ListResourcesResult>;

  readResource(uri: string, signal: AbortSignal): Promise<ReadResourceResult>;

  listPrompts(signal: AbortSignal): Promise<ListPromptsResult>;

  getPrompt(name: string, args: Record<string, string> | undefined, signal: AbortSignal): Promise<GetPromptResult>;

  /**
   * Opens the upstream `subscriptions/listen` stream (S3.4). Optional on the interface: an
   * upstream that does not implement the modern era rejects it, which the fan-out treats as
   * "this upstream cannot push changes" rather than as an error.
   *
   * IMPORTANT: `listen()` alone only opens the stream. Change notifications are dispatched
   * to the handlers registered with `setNotificationHandler`, so a consumer MUST also call
   * `onListChanged` — `onListChanged` is what actually delivers the events.
   *
   * verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
   *   (Client.listen(filter, options): Promise<McpSubscription>)
   */
  listen?(signal: AbortSignal): Promise<{
    /** The subset of the requested filter the server agreed to honour. */
    readonly honoredFilter: Record<string, unknown>;
    close: () => Promise<void>;
    readonly closed: Promise<string>;
  }>;

  /**
   * Registers the handlers that deliver `notifications/tools/list_changed`,
   * `notifications/prompts/list_changed` and `notifications/resources/list_changed`, and
   * returns an unsubscribe function.
   *
   * verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
   *   (Client.setNotificationHandler(method, handler))
   */
  onListChanged?(handler: () => void): () => void;
}

/**
 * S3.1: resource templates are a NON-GOAL (PLAN.md §1), so the gateway never advertises
 * them and never asks an upstream for them.
 */
export const RESOURCE_TEMPLATES_ARE_NOT_AGGREGATED = true;

/** Narrowing helper so callers can skip the `undefined` branch of `noUncheckedIndexedAccess`. */
export function isReady(upstream: Upstream): boolean {
  return upstream.status().state === 'ready';
}