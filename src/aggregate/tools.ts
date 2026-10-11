// PLAN.md S2.4: `tools/list` and `tools/call` per §5, implementing D8 (failure
// isolation), D11 (ttlMs / cacheScope) and D12 (upstream failure => isError result,
// protocol problem => JSON-RPC error).

import { INVALID_PARAMS, ProtocolError, type CacheScope, type CallToolResult, type Tool } from '@modelcontextprotocol/server';

import { namespaceBatch, parseNamespacedName } from './namespace.js';
import type { UpstreamManager } from '../upstream/manager.js';
import type { Logger } from '../observability/logger.js';

/**
 * PLAN.md §5: the `_meta` entries forwarded upstream.
 * verified: docs/ref/spec-2026-07-28-changelog.md (minor change 2: trace context
 *   conventions for the `_meta` keys traceparent, tracestate, baggage)
 * verified: docs/ref/spec-2026-07-28/basic/patterns/progress (progressToken rides `_meta`)
 */
export const FORWARDED_META_KEYS = ['progressToken', 'traceparent', 'tracestate', 'baggage'] as const;

export interface AggregatedToolsList {
  tools: Tool[];
  /**
   * D11: `cacheScope` is always `"private"` in v1; `ttlMs` is the MINIMUM `ttlMs` among
   * the contributing upstreams, or `gateway.defaultTtlMs` when none supplied one.
   */
  ttlMs: number;
  cacheScope: CacheScope;
}

export interface ToolsAggregatorDeps {
  manager: UpstreamManager;
  logger: Logger;
  defaultTtlMs: number;
}

/**
 * Fails to no downstream tool that is still routed to a live upstream; `Promise.all`
 * inside the manager already dropped the broken ones (D8).
 */
export async function aggregateToolsList(
  deps: ToolsAggregatorDeps,
  signal: AbortSignal,
): Promise<AggregatedToolsList> {
  const perUpstream = await deps.manager.listAllTools(signal);

  const candidates: { server: string; name: string; tool: Tool }[] = [];
  const originalByKey = new Map<string, Tool>();
  for (const [server, result] of perUpstream) {
    for (const tool of result.tools) {
      candidates.push({ server, name: tool.name, tool });
      originalByKey.set(`${server}\u0000${tool.name}`, tool);
    }
  }

  const { tools: namespaced, report } = namespaceBatch(candidates);

  for (const skip of report.skipped) {
    // D4: warn, naming the server and the tool.
    deps.logger.warn(
      { upstream: skip.server, tool: skip.tool, reason: skip.reason },
      'skipping tool: namespaced name violates the D4 rules',
    );
  }

  // PLAN.md §5: sort ascending by namespaced name, so the list is deterministic.
  const tools = namespaced
    .map((entry) => {
      const original = originalByKey.get(`${entry.server}\u0000${entry.name}`);
      if (original === undefined) {
        // Unreachable: every kept entry came from `candidates`.
        throw new Error(`internal: lost the tool definition for ${entry.namespaced}`);
      }
      return { ...original, name: entry.namespaced };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { tools, ttlMs: computeTtlMs([...perUpstream.values()], deps.defaultTtlMs), cacheScope: 'private' };
}

/** D11: minimum upstream `ttlMs` among contributors, else the gateway default. */
export function computeTtlMs(
  results: readonly { ttlMs?: number }[],
  defaultTtlMs: number,
): number {
  const values: number[] = [];
  for (const result of results) {
    if (typeof result.ttlMs === 'number') values.push(result.ttlMs);
  }
  if (values.length === 0) return defaultTtlMs;
  return Math.min(...values);
}

/**
 * PLAN.md S3.6: a handler for progress must both receive the upstream's progress and emit
 * it downstream on the SAME request's response stream.
 */
export interface CallToolHooks {
  /** Re-emits a progress notification the upstream sent (S3.6). */
  onUpstreamProgress?: (progress: unknown) => void | Promise<void>;
}

export interface CallToolOutcome {
  result: CallToolResult;
}

/**
 * D12, both halves:
 *   - unknown server / tool  -> a JSON-RPC protocol error (`-32602`), because the client
 *     asked for something that does not exist;
 *   - upstream down/timeout/needs auth -> a tool result with `isError: true` and a short
 *     text, so the model can see and react to it.
 *
 * The upstream's OWN `isError` result is forwarded unchanged: a tool that ran and reported
 * a failure is not an upstream outage.
 */
export async function aggregateCallTool(
  deps: ToolsAggregatorDeps,
  namespacedName: string,
  args: unknown,
  meta: unknown,
  signal: AbortSignal,
  extra: { requestState?: unknown; inputResponses?: Record<string, unknown> } = {},
  hooks: CallToolHooks = {},
): Promise<CallToolResult> {
  const parsed = parseNamespacedName(namespacedName);
  if (parsed === null) {
    throw new ProtocolError(INVALID_PARAMS, `Unknown tool: ${namespacedName}`);
  }

  const upstream = deps.manager.get(parsed.server);
  if (upstream === undefined) {
    throw new ProtocolError(INVALID_PARAMS, `Unknown tool: ${namespacedName}`);
  }

  const state = upstream.status().state;
  if (state !== 'ready') {
    return unavailable(parsed.server, state);
  }

  try {
    const result = await upstream.callTool(
      parsed.name,
      args,
      meta,
      signal,
      extra,
      hooks.onUpstreamProgress === undefined ? undefined : { onprogress: hooks.onUpstreamProgress },
    );
    // ADR 0003 option (E). Measured, not assumed: an upstream answering -32601 arrives as
    // an `isError` TOOL RESULT carrying the message, not as a thrown error. S4.7 saw exactly
    // that shape from @modelcontextprotocol/server-everything:
    //   {"content":[{"type":"text","text":"MCP error -32601: Method not found"}],"isError":true}
    // and the SDK server converts a thrown ProtocolError from a tool handler into the same
    // shape. Detecting it in the catch block alone would never have fired.
    if (isMethodNotFoundResult(result)) {
      // The log names the UPSTREAM ONLY: no tool name, no arguments, no headers, no token.
      deps.logger.warn(
        { upstream: parsed.server, code: JSON_RPC_METHOD_NOT_FOUND },
        "upstream answered method-not-found; if this tool needs elicitation the upstream " +
          "does not accept this gateway's declared elicitation capability (ADR 0003)",
      );
    }
    return result;
  } catch (err) {
    deps.logger.warn(
      { upstream: parsed.server, tool: parsed.name, reason: err instanceof Error ? err.message : String(err) },
      'upstream call failed',
    );
    return unavailable(parsed.server, 'error');
  }
}

/**
 * JSON-RPC `Method not found`.
 * verified: docs/ref/spec-2026-07-28-basic-index.md (JSON-RPC 2.0 error codes; -32601)
 */
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * True when a tool result is an `isError` whose text reports JSON-RPC `-32601`.
 *
 * Both spellings are matched because upstream servers differ: some embed the numeric code
 * (`MCP error -32601: Method not found`), others only the description.
 */
function isMethodNotFoundResult(result: { isError?: boolean | undefined; content?: unknown }): boolean {
  if (result.isError !== true) return false;
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .map((block: unknown) => (block as { text?: unknown } | null)?.text)
    .filter((v: unknown): v is string => typeof v === 'string')
    .join(' ');
  return text.includes(String(JSON_RPC_METHOD_NOT_FOUND)) || /method not found/i.test(text);
}

/** PLAN.md §8 wording for D12's tool result text. */
function unavailable(server: string, state: string): CallToolResult {
  const reason =
    state === 'auth_required'
      ? 'requires authentication'
      : state === 'starting'
        ? 'is starting'
        : state === 'failed'
          ? 'is unavailable'
          : state === 'disabled'
            ? 'is disabled'
            : 'is unavailable';
  return {
    content: [{ type: 'text', text: `Upstream '${server}' ${reason}` }],
    isError: true,
  };
}

/** Keeps only the whitelisted `_meta` entries (PLAN.md §5). */
export function forwardMeta(meta: unknown): Record<string, unknown> | undefined {
  if (meta === null || typeof meta !== 'object') return undefined;
  const source = meta as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of FORWARDED_META_KEYS) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}