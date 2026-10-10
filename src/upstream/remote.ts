// PLAN.md S2.2: RemoteUpstream — an SDK v2 `Client` over Streamable HTTP with static
// headers, a per-request timeout and an AbortSignal wired all the way through.

import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type McpSubscription,
} from '@modelcontextprotocol/client';
import type { CallToolResult, Tool } from '@modelcontextprotocol/server';

import { scrubSecrets } from '../observability/logger.js';
import type { RemoteUpstreamConfig } from '../config/schema.js';
import type { ToolListResult, Upstream, UpstreamStatus, UpstreamStatusInfo } from './types.js';

export interface RemoteUpstreamOptions {
  /** Literal secret values, so an upstream error can never echo one back. */
  secrets?: readonly string[];
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
}

const READY: UpstreamStatusInfo = { state: 'starting', since: 0 };

export class RemoteUpstream implements Upstream {
  readonly name: string;
  readonly kind = 'remote' as const;
  readonly timeoutMs: number;

  readonly #config: RemoteUpstreamConfig;
  readonly #secrets: readonly string[];
  readonly #now: () => number;

  #transport: StreamableHTTPClientTransport | undefined;
  #client: Client | undefined;
  #status: UpstreamStatusInfo = READY;

  constructor(name: string, config: RemoteUpstreamConfig, defaultTimeoutMs: number, options: RemoteUpstreamOptions = {}) {
    this.name = name;
    this.#config = config;
    this.timeoutMs = config.timeout ?? defaultTimeoutMs;
    this.#secrets = options.secrets ?? [];
    this.#now = options.now ?? Date.now;
  }

  status(): UpstreamStatusInfo {
    return this.#status;
  }

  async start(): Promise<void> {
    if (this.#status.state === 'ready') return;
    this.#transition('starting');
    try {
      // verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
      //   (StreamableHTTPClientTransportOptions.requestInit; transport-managed headers win)
      this.#transport = new StreamableHTTPClientTransport(new URL(this.#config.url), {
        requestInit: { headers: { ...this.#config.headers } },
      });

      // verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
      //   (ClientOptions.versionNegotiation; mode 'auto' probes server/discover and falls
      //    back to initialize, so a 2025-era upstream still works)
      // The upstream client MUST declare `elicitation` even though the gateway never fulfils an
      // elicitation itself. On an `input_required` result the SDK server seam checks the
      // REQUEST's declared client capabilities and answers `-32021` for anything undeclared,
      // which would break MRTR passthrough (S3.5) before the gateway ever sees the result.
      // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts
      //   (Server._invokeInputRequiredCapableHandler: "every embedded request must be covered
      //    by the capabilities declared on the request's envelope ... -32021")
      this.#client = new Client(
        { name: 'mcp-gateway', version: '0.0.0' },
        {
          versionNegotiation: { mode: 'auto' },
          defaultCacheTtlMs: 0,
          capabilities: { elicitation: {} },
        },
      );

      await this.#client.connect(this.#transport, { timeout: this.timeoutMs });
      this.#transition('ready');
    } catch (err) {
      await this.#teardown();
      this.#transition(this.#classify(err), this.#describe(err));
    }
  }

  async stop(): Promise<void> {
    await this.#teardown();
    this.#transition('disabled');
  }

  async listTools(signal: AbortSignal): Promise<ToolListResult> {
    const client = this.#requireClient();
    // verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
    //   (Client.listTools(params, options: CacheableRequestOptions); cacheMode 'bypass'
    //    because the gateway, not the SDK cache, owns freshness — D11)
    const result = await client.listTools({}, { cacheMode: 'bypass', signal, timeout: this.timeoutMs });
    const tools: Tool[] = [...result.tools];
    const out: ToolListResult = { tools };
    // The SDK types the cache hints as nullable: a 2025-era upstream has no such field.
    if (typeof result.ttlMs === 'number') out.ttlMs = result.ttlMs;
    if (result.cacheScope === 'public' || result.cacheScope === 'private') {
      out.cacheScope = result.cacheScope;
    }
    return out;
  }

  async callTool(
    name: string,
    args: unknown,
    meta: unknown,
    signal: AbortSignal,
    extra: { requestState?: unknown; inputResponses?: Record<string, unknown> } = {},
    options: { onprogress?: (progress: unknown) => void | Promise<void> } = {},
  ): Promise<CallToolResult> {
    const client = this.#requireClient();

    // Q-MRTRPROXY: `inputResponses` and `requestState` are SIBLINGS of `arguments` in the
    // request params, not `_meta` entries
    // (verified: docs/ref/spec-2026-07-28-server-tools.md, "Retry with Input Responses"),
    // and the server seam lifts them into `ctx.mcpReq` before the handler runs
    // (verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts,
    // ServerContext.mcpReq). A proxy must therefore re-attach them explicitly.
    const params = {
      name,
      arguments: (args ?? {}) as Record<string, unknown>,
      _meta: asMeta(meta),
      ...(extra.inputResponses === undefined ? {} : { inputResponses: extra.inputResponses }),
      ...(typeof extra.requestState === 'string' ? { requestState: extra.requestState } : {}),
    };

    const requestOptions = {
      signal,
      timeout: this.timeoutMs,
      // Sprint 3 S3.5: surface an `input_required` result unchanged instead of raising.
      // verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
      //   (RequestOptions.allowInputRequired)
      allowInputRequired: true,
      ...(options.onprogress === undefined ? {} : { onprogress: options.onprogress }),
    };

    // verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
    //   (Client.callTool(params, options))
    return client.callTool(params, requestOptions);
  }

  // -------------------------------------------------------------------------
  // Resources and prompts (Sprint 3, PLAN.md §5)
  // -------------------------------------------------------------------------

  async listResources(signal: AbortSignal) {
    const client = this.#requireClient();
    // verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
    //   (Client.listResources(params?, options?: CacheableRequestOptions))
    return client.listResources({}, { cacheMode: 'bypass', signal, timeout: this.timeoutMs });
  }

  async readResource(uri: string, signal: AbortSignal) {
    const client = this.#requireClient();
    // verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
    //   (Client.readResource(params, options))
    return client.readResource({ uri }, { cacheMode: 'bypass', signal, timeout: this.timeoutMs });
  }

  async listPrompts(signal: AbortSignal) {
    const client = this.#requireClient();
    // verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
    //   (Client.listPrompts(params?, options?: CacheableRequestOptions))
    return client.listPrompts({}, { cacheMode: 'bypass', signal, timeout: this.timeoutMs });
  }

  async getPrompt(name: string, args: Record<string, string> | undefined, signal: AbortSignal) {
    const client = this.#requireClient();
    // verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
    //   (Client.getPrompt(params, options?: RequestOptions))
    return client.getPrompt({ name, arguments: args }, { signal, timeout: this.timeoutMs });
  }

  /**
   * Opens the upstream `subscriptions/listen` stream (Sprint 3 S3.4). The returned handle
   * is used to fan upstream list-changed events out to the gateway's own listeners.
   *
   * verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
   *   (Client.listen(filter, options): Promise<McpSubscription>)
   */
  async listen(signal: AbortSignal): Promise<McpSubscription> {
    const client = this.#requireClient();
    return client.listen(
      { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true },
      { signal, timeout: this.timeoutMs },
    );
  }

  /**
   * Registers the change-notification handlers. `listen()` only opens the stream; these are
   * what actually dispatch the notifications onto it (Sprint 3 S3.4).
   *
   * verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts
   *   (Client.setNotificationHandler(method, handler))
   */
  onListChanged(handler: () => void): () => void {
    const client = this.#requireClient();
    const methods = [
      'notifications/tools/list_changed',
      'notifications/prompts/list_changed',
      'notifications/resources/list_changed',
    ] as const;

    for (const method of methods) {
      client.setNotificationHandler(method, () => {
        handler();
      });
    }
    return () => {
      // `removeNotificationHandler` is not part of the public surface used here; the client
      // is torn down with the upstream, so no explicit teardown is required.
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #requireClient(): Client {
    const client = this.#client;
    if (client === undefined || this.#status.state !== 'ready') {
      throw new Error(`upstream '${this.name}' is not ready`);
    }
    return client;
  }

  async #teardown(): Promise<void> {
    try {
      await this.#client?.close();
    } catch {
      // A close failure must not mask the original error.
    }
    this.#client = undefined;
    this.#transport = undefined;
  }

  /**
   * A 401 means the credentials need attention (Sprint 5's `auth_required`); everything
   * else is a plain `error`.
   */
  #classify(err: unknown): UpstreamStatus {
    if (err instanceof UnauthorizedError) return 'auth_required';
    if (err instanceof Error && err.name === 'UnauthorizedError') return 'auth_required';
    const statusCode = (err as { status?: unknown } | null)?.status;
    if (statusCode === 401) return 'auth_required';
    if (err instanceof Error && /\b401\b/.test(err.message)) return 'auth_required';
    return 'error';
  }

  /** PLAN.md rule 9: the message may name the upstream, never a secret. */
  #describe(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return scrubSecrets(raw, this.#secrets).slice(0, 500);
  }

  #transition(state: UpstreamStatus, lastError?: string): void {
    this.#status = lastError === undefined
      ? { state, since: this.#now() }
      : { state, since: this.#now(), lastError };
  }
}

/** Only forwards `_meta` when there is something to forward. */
function asMeta(meta: unknown): Record<string, unknown> | undefined {
  if (meta === null || typeof meta !== 'object') return undefined;
  const entries = Object.entries(meta as Record<string, unknown>);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}