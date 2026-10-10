// The internal Upstream contract (PLAN.md §5). Types are adapted to the SDK v2 real
// types, verified in Sprint 0 — see docs/SDK-NOTES.md.

import type { CacheScope, CallToolResult, Tool } from '@modelcontextprotocol/server';

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
   */
  callTool(name: string, args: unknown, meta: unknown, signal: AbortSignal): Promise<CallToolResult>;
}

/** Narrowing helper so callers can skip the `undefined` branch of `noUncheckedIndexedAccess`. */
export function isReady(upstream: Upstream): boolean {
  return upstream.status().state === 'ready';
}