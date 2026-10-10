// PLAN.md S4.1-S4.4: a LOCAL upstream — a child process speaking MCP over stdio.
//
// Everything about the child process is the SDK's job, not ours:
// verified: node_modules/@modelcontextprotocol/client/dist/stdio.mjs
//   (StdioClientTransport.start:
//      spawn(command, args ?? [], {
//        env: { ...getDefaultEnvironment(), ...serverParams.env },   <-- D13
//        stdio: ['pipe','pipe', serverParams.stderr ?? 'inherit'],
//        shell: false,
//        windowsHide: process.platform === 'win32',
//        cwd: serverParams.cwd
//      }))
// verified: node_modules/cross-spawn/lib/parse.js (parseNonShell: on Windows a
//   non-executable command such as `npx` is routed through
//   `cmd.exe /d /s /c "<escaped>"` with `windowsVerbatimArguments`; `command` and `args`
//   are escaped, so `command[0]` needs no shell quoting from us)

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type {
  CallToolResult,
  GetPromptResult,
  ListPromptsResult,
  ListResourcesResult,
  ReadResourceResult,
  Tool,
} from '@modelcontextprotocol/server';

import type { LocalUpstreamConfig } from '../config/schema.js';
import { scrubSecrets } from '../observability/logger.js';
import type { Logger } from '../observability/logger.js';
import type { ToolListResult, Upstream, UpstreamStatus, UpstreamStatusInfo } from './types.js';
import { killProcessTree } from './process-tree.js';

/** S4.4: stderr lines are truncated to this many characters before logging. */
export const STDERR_LINE_LIMIT = 2048;

export interface StdioUpstreamOptions {
  secrets?: readonly string[];
  logger: Logger;
  now?: () => number;
  /** Injectable so tests can drive idle shutdown without waiting. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export class StdioUpstream implements Upstream {
  readonly name: string;
  readonly kind = 'local' as const;
  readonly timeoutMs: number;
  /** PLAN.md S4.3: started on first use, not at gateway start. */
  readonly lazy = true;

  readonly #config: LocalUpstreamConfig;
  readonly #options: StdioUpstreamOptions;
  readonly #now: () => number;

  #transport: StdioClientTransport | undefined;
  #client: Client | undefined;
  // `since` is filled in by the constructor: class field initializers run BEFORE the
  // constructor body, so a field initializer cannot read `this.#options`.
  #statusListeners = new Set<(state: string) => void>();
  #status: UpstreamStatusInfo = { state: 'disabled', since: 0 };
  #idleHandle: unknown;
  #startPromise: Promise<void> | undefined;

  constructor(name: string, config: LocalUpstreamConfig, defaultTimeoutMs: number, options: StdioUpstreamOptions) {
    this.name = name;
    this.#config = config;
    this.timeoutMs = config.timeout ?? defaultTimeoutMs;
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#status = { state: 'disabled', since: this.#now() };
  }

  onStatusChange(listener: (state: string) => void): () => void {
    this.#statusListeners.add(listener);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  status(): UpstreamStatusInfo {
    return this.#status;
  }

  // -------------------------------------------------------------------------
  // Lifecycle (S4.3)
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.#status.state === 'ready' || this.#startPromise !== undefined) {
      await this.#startPromise;
      return;
    }
    this.#startPromise = this.#doStart().finally(() => {
      this.#startPromise = undefined;
    });
    await this.#startPromise;
  }

  async stop(): Promise<void> {
    this.#clearIdleTimer();
    await this.#teardown();
    this.#transition('disabled');
  }

  /**
   * PLAN.md S4.5: pid of the running child, or undefined when not started.
   *
   * Read BEFORE `stop()`, because stopping clears the transport.
   */
  get pid(): number | undefined {
    // verified: node_modules/@modelcontextprotocol/client/dist/stdio.d.mts
    //   (get pid(): number | null — "the child process pid spawned by this transport")
    return this.#transport?.pid ?? undefined;
  }

  /**
   * Kills the child AND its descendants. Used only when a graceful `stop()` has already
   * exceeded its deadline: the SDK's own close() signals the direct child, which orphans
   * the grandchildren of `npx`/`uvx`-style wrappers.
   */
  async forceStop(): Promise<void> {
    const pid = this.pid;
    this.#clearIdleTimer();
    await this.#teardown().catch(() => undefined);
    if (pid === undefined) return;
    const result = await killProcessTree(pid);
    if (result.treeOnly) {
      // `ps` is unavailable, so grandchildren of a wrapper survive. Logged rather than
      // swallowed: silently claiming a tree kill would be a lie.
      this.#options.logger.warn(
        { upstream: this.name, pid },
        'process tree kill degraded to direct child: ps (procps) is not installed',
      );
    }
    if (!result.killed) {
      this.#options.logger.debug(
        { upstream: this.name, pid, reason: result.error },
        'process tree kill did not complete',
      );
    }
    this.#transition('disabled');
  }

  async #doStart(): Promise<void> {
    this.#transition('starting');
    try {
      // verified: node_modules/@modelcontextprotocol/client/dist/stdio.d.mts
      //   (StdioServerParameters: command, args, env, stderr, cwd)
      this.#transport = new StdioClientTransport({
        command: this.#executable(),
        args: this.#args(),
        env: this.#childEnv(),
        // S4.4: capture stderr instead of inheriting it.
        stderr: 'pipe',
      });

      // S4.4: crash detection. The transport fires `onclose` when the child exits.
      this.#transport.onclose = () => {
        const wasReady = this.#status.state === 'ready';
        void this.#teardown();
        // A crash is an error, not a clean stop; a deliberate `stop()` already moved the
        // state to `disabled`, so this branch only runs on an unexpected exit.
        if (wasReady) this.#transition('error', 'process exited unexpectedly');
        else if (this.#status.state !== 'disabled') this.#transition('error', 'process exited');
        this.#options.logger.warn({ upstream: this.name }, 'stdio upstream process exited');
      };

      // The transport types `stderr` as the base `node:stream.Stream`; at runtime it is
      // always the PassThrough it creates when `stderr: 'pipe'`.
      // verified: spikes/node_modules/@modelcontextprotocol/client/dist/stdio.d.mts
      //   (get stderr(): Stream | null — "a PassThrough stream is returned _immediately_")
      const stderrStream = this.#transport.stderr as NodeJS.ReadableStream | null;
      if (stderrStream !== null) {
        this.#pipeStderr(stderrStream);
      }

      this.#client = new Client(
        { name: 'mcp-gateway', version: '0.0.0' },
        {
          versionNegotiation: { mode: 'auto' },
          defaultCacheTtlMs: 0,
          // Same reason as RemoteUpstream: MRTR passthrough requires the declaration.
          // verified: docs/adr/0003-mrtr-elicitation-capability.md
          capabilities: { elicitation: {} },
        },
      );

      // S4.3: the first `npx` download is slow, hence `startupTimeoutMs`.
      await this.#client.connect(this.#transport, { timeout: this.#config.startupTimeoutMs });
      this.#transition('ready');
      this.#armIdleTimer();
    } catch (err) {
      await this.#teardown();
      // A spawn failure and a crash both surface as the SDK's
      // `SdkError(CONNECTION_CLOSED)`, so the message cannot tell them apart. Verified on
      // Windows for a missing binary. Both are `error` here; PLAN.md S4.3 parks the
      // upstream in `failed` after MAX_CONSECUTIVE_FAILURES, and the manager owns that
      // escalation. No message sniffing.
      this.#transition('error', this.#describe(err));
    }
  }

  /** `command[0]`, guaranteed non-empty by the config schema (PLAN.md §6). */
  #executable(): string {
    return this.#config.command[0] ?? '';
  }

  #args(): string[] {
    return this.#config.command.slice(1);
  }

  /**
   * D13: the config `environment` is merged ON TOP of the SDK's own allowlist, which the
   * transport always applies. Nothing else is inherited, so a gateway secret in
   * `process.env` can never reach the child.
   * verified: node_modules/@modelcontextprotocol/client/dist/stdio.mjs
   *   (env: { ...getDefaultEnvironment(), ...serverParams.env })
   */
  #childEnv(): Record<string, string> {
    return { ...this.#config.environment };
  }

  // -------------------------------------------------------------------------
  // Idle shutdown (S4.3)
  // -------------------------------------------------------------------------

  #armIdleTimer(): void {
    this.#clearIdleTimer();
    const idleMs = this.#config.idleTimeoutMs;
    if (idleMs <= 0) return; // 0 disables idle shutdown (PLAN.md §6)

    const setTimer = this.#options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.#idleHandle = setTimer(() => {
      this.#idleHandle = undefined;
      this.#options.logger.debug({ upstream: this.name, idleMs }, 'stdio upstream idle: shutting down');
      this.stop().catch(() => undefined);
    }, idleMs);
  }

  #clearIdleTimer(): void {
    if (this.#idleHandle === undefined) return;
    const clear = this.#options.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
    clear(this.#idleHandle);
    this.#idleHandle = undefined;
  }

  /** Every successful call resets the idle window. */
  #markActive(): void {
    if (this.#status.state === 'ready') this.#armIdleTimer();
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  async listTools(signal: AbortSignal): Promise<ToolListResult> {
    const client = await this.#requireClient();
    const result = await client.listTools({}, { cacheMode: 'bypass', signal, timeout: this.timeoutMs });
    this.#markActive();
    const tools: Tool[] = [...result.tools];
    const out: ToolListResult = { tools };
    if (typeof result.ttlMs === 'number') out.ttlMs = result.ttlMs;
    if (result.cacheScope === 'public' || result.cacheScope === 'private') out.cacheScope = result.cacheScope;
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
    const client = await this.#requireClient();
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
      allowInputRequired: true,
      ...(options.onprogress === undefined ? {} : { onprogress: options.onprogress }),
    };
    const result = await client.callTool(params, requestOptions);
    this.#markActive();
    return result;
  }

  async listResources(signal: AbortSignal): Promise<ListResourcesResult> {
    const client = await this.#requireClient();
    const result = await client.listResources({}, { cacheMode: 'bypass', signal, timeout: this.timeoutMs });
    this.#markActive();
    return result;
  }

  async readResource(uri: string, signal: AbortSignal): Promise<ReadResourceResult> {
    const client = await this.#requireClient();
    const result = await client.readResource({ uri }, { cacheMode: 'bypass', signal, timeout: this.timeoutMs });
    this.#markActive();
    return result;
  }

  async listPrompts(signal: AbortSignal): Promise<ListPromptsResult> {
    const client = await this.#requireClient();
    const result = await client.listPrompts({}, { cacheMode: 'bypass', signal, timeout: this.timeoutMs });
    this.#markActive();
    return result;
  }

  async getPrompt(name: string, args: Record<string, string> | undefined, signal: AbortSignal): Promise<GetPromptResult> {
    const client = await this.#requireClient();
    const result = await client.getPrompt({ name, arguments: args }, { signal, timeout: this.timeoutMs });
    this.#markActive();
    return result;
  }

  async listen(signal: AbortSignal) {
    const client = await this.#requireClient();
    return client.listen({ toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true }, {
      signal,
      timeout: this.timeoutMs,
    });
  }

  onListChanged(handler: () => void): () => void {
    const client = this.#client;
    if (client === undefined) return () => undefined;
    for (const method of [
      'notifications/tools/list_changed',
      'notifications/prompts/list_changed',
      'notifications/resources/list_changed',
    ] as const) {
      client.setNotificationHandler(method, () => handler());
    }
    return () => undefined;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #requireClient(): Promise<Client> {
    // Lazy start: the first use starts the process (PLAN.md S4.3).
    if (this.#status.state !== 'ready') await this.start();
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
      // Closing a dead process must not mask the original error.
    }
    this.#client = undefined;
    this.#transport = undefined;
  }

  #transition(state: UpstreamStatus, lastError?: string): void {
    this.#status = lastError === undefined
      ? { state, since: this.#now() }
      : { state, since: this.#now(), lastError };
    for (const listener of this.#statusListeners) {
      try {
        listener(state);
      } catch {
        // A misbehaving listener must not break a status transition.
      }
    }
  }

  #describe(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return scrubSecrets(raw, this.#options.secrets ?? []).slice(0, 500);
  }

  /**
   * S4.4: line-buffered, truncated to 2 KiB per line, redacted, and logged with the
   * upstream name.
   */
  #pipeStderr(stream: NodeJS.ReadableStream): void {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string | Buffer) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        this.#logStderrLine(line);
        index = buffer.indexOf('\n');
      }
      // Guard against a child that never emits a newline.
      if (buffer.length > STDERR_LINE_LIMIT * 2) {
        this.#logStderrLine(buffer);
        buffer = '';
      }
    });
    stream.on('end', () => {
      if (buffer.length > 0) this.#logStderrLine(buffer);
    });
  }

  #logStderrLine(line: string): void {
    const truncated = line.length > STDERR_LINE_LIMIT ? `${line.slice(0, STDERR_LINE_LIMIT)}...[truncated]` : line;
    const safe = scrubSecrets(truncated, this.#options.secrets ?? []);
    this.#options.logger.info({ upstream: this.name, stderr: safe }, 'upstream stderr');
  }
}

function asMeta(meta: unknown): Record<string, unknown> | undefined {
  if (meta === null || typeof meta !== 'object') return undefined;
  const entries = Object.entries(meta as Record<string, unknown>);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}