import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BackendConfig } from "../config/types.js";
import { log } from "../utils/logger.js";
import { GatewayOAuthProvider } from "./oauth-provider.js";
import type { TokenStore } from "./token-store.js";

export type BackendStatus = "up" | "down" | "needs_auth";

/** Transport yang mendukung alur OAuth (punya finishAuth). */
type AuthTransport = StreamableHTTPClientTransport | SSEClientTransport;

export interface BackendPoolOptions {
  store: TokenStore;
  redirectUrl: string;
  cacheTtlMs?: number;
}

/**
 * Pool backend: tiap backend punya Client sendiri, auto-reconnect dengan backoff.
 * Status: up | down | needs_auth
 */
export class BackendPool {
  readonly configs: Record<string, BackendConfig>;
  /** name -> Client (hanya yang sedang terhubung) */
  readonly clients = new Map<string, Client>();
  /** name -> GatewayOAuthProvider */
  readonly providers = new Map<string, GatewayOAuthProvider>();

  private readonly store: TokenStore;
  private readonly redirectUrl: string;
  private readonly cacheTtlMs: number;
  /** name -> { at, tools } (cache daftar tool) */
  private readonly catalog = new Map<string, { at: number; tools: Tool[] }>();
  private readonly transports = new Map<string, Transport>();
  /** name -> transport yang menunggu finishAuth */
  private readonly pending = new Map<string, AuthTransport>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly delays = new Map<string, number>();
  private stopped = false;

  constructor(servers: Record<string, BackendConfig>, { store, redirectUrl, cacheTtlMs = 60000 }: BackendPoolOptions) {
    this.configs = Object.fromEntries(Object.entries(servers).filter(([, c]) => c.enabled !== false));
    this.store = store;
    this.redirectUrl = redirectUrl;
    this.cacheTtlMs = cacheTtlMs;
  }

  start(): void {
    for (const name of Object.keys(this.configs)) void this.connect(name);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
  }

  status(name: string): BackendStatus {
    if (this.clients.has(name)) return "up";
    if (this.pending.has(name)) return "needs_auth";
    return "down";
  }

  invalidate(name: string): void {
    this.catalog.delete(name);
  }

  /** Daftar tool backend (semua halaman), di-cache; dibatalkan saat putus atau list_changed. */
  async listTools(name: string, timeoutMs: number): Promise<Tool[]> {
    const hit = this.catalog.get(name);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) return hit.tools;
    const client = this.clients.get(name);
    if (!client) throw new Error(`server '${name}' tidak terhubung`);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const res = await client.listTools({ cursor }, { timeout: timeoutMs });
      tools.push(...res.tools);
      cursor = res.nextCursor;
    } while (cursor);
    this.catalog.set(name, { at: Date.now(), tools });
    return tools;
  }

  authUrl(name: string): string | null {
    return this.status(name) === "needs_auth" ? (this.providers.get(name)?.authUrl ?? null) : null;
  }

  private getProvider(name: string): GatewayOAuthProvider {
    let p = this.providers.get(name);
    if (!p) {
      p = new GatewayOAuthProvider({
        name,
        auth: this.configs[name].auth!,
        store: this.store,
        redirectUrl: this.redirectUrl,
      });
      this.providers.set(name, p);
    }
    return p;
  }

  private makeTransport(cfg: BackendConfig, provider?: GatewayOAuthProvider): Transport {
    const kind = cfg.type ?? "http";
    const headers = cfg.headers ?? {};
    if (kind === "http") {
      return new StreamableHTTPClientTransport(new URL(cfg.url!), { requestInit: { headers }, authProvider: provider });
    }
    if (kind === "sse") {
      return new SSEClientTransport(new URL(cfg.url!), {
        requestInit: { headers },
        eventSourceInit: {
          fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }),
        },
        authProvider: provider,
      });
    }
    if (kind === "stdio") {
      const env = Object.fromEntries(
        Object.entries({ ...process.env, ...(cfg.env ?? {}) }).filter((e): e is [string, string] => e[1] !== undefined),
      );
      return new StdioClientTransport({ command: cfg.command!, args: cfg.args ?? [], env });
    }
    throw new Error(`type tidak dikenal: ${kind}`);
  }

  async connect(name: string): Promise<void> {
    if (this.stopped) return;
    const cfg = this.configs[name];
    const wantsOAuth = cfg.auth?.type === "oauth" && cfg.type !== "stdio";
    const provider = wantsOAuth ? this.getProvider(name) : undefined;
    if (provider) provider.authRequired = false;

    const client = new Client({ name: "mcp-gateway", version: "1.0.0" }, { capabilities: {} });
    const transport = this.makeTransport(cfg, provider);
    let handled = false;

    const onDown = (why: string): void => {
      if (handled) return;
      handled = true;
      if (this.clients.get(name) === client) this.clients.delete(name);
      this.invalidate(name);
      if (provider?.authRequired) return; // menunggu login, bukan masalah koneksi biasa
      this.scheduleReconnect(name, why);
    };
    client.onclose = () => onDown("koneksi ditutup");
    client.onerror = (e) => log("WARN", `backend '${name}' error:`, e?.message ?? e);
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.invalidate(name));

    try {
      this.transports.set(name, transport);
      await client.connect(transport);
      this.invalidate(name);
      this.clients.set(name, client);
      this.pending.delete(name);
      this.delays.set(name, 1);
      log("INFO", `backend '${name}' terhubung`);
    } catch (e) {
      if (provider?.authRequired) {
        handled = true;
        client.close().catch(() => {});
        this.pending.set(name, transport as AuthTransport);
        log("WARN", `backend '${name}' butuh login OAuth. Buka URL ini di browser:\n  ${provider.authUrl}`);
        return;
      }
      client.close().catch(() => {});
      onDown((e as Error)?.message ?? String(e));
    }
  }

  /** Dipanggil saat tool call/list gagal karena token ditolak dan tidak bisa di-refresh. */
  markNeedsAuth(name: string): void {
    const provider = this.providers.get(name);
    if (!provider) return;
    const client = this.clients.get(name);
    this.clients.delete(name);
    this.invalidate(name);
    if (provider.authRequired) {
      this.pending.set(name, this.transports.get(name) as AuthTransport);
      log("WARN", `backend '${name}' butuh login ulang. Buka URL ini di browser:\n  ${provider.authUrl}`);
    }
    client?.close().catch(() => {});
  }

  findByState(state: string | null): string | null {
    if (!state) return null;
    for (const [name, p] of this.providers) if (p.pendingState && p.pendingState === state) return name;
    return null;
  }

  async completeAuth(name: string, code: string): Promise<void> {
    const transport = this.pending.get(name);
    const provider = this.providers.get(name);
    if (!transport || !provider) throw new Error(`backend '${name}' tidak sedang menunggu login`);
    await transport.finishAuth(code); // tukar code -> token (PKCE), disimpan lewat provider
    provider.pendingState = null;
    provider.authUrl = null;
    this.pending.delete(name);
    await this.connect(name);
    if (!this.clients.has(name)) throw new Error("token tersimpan tapi koneksi ke backend masih gagal, lihat log gateway");
  }

  private scheduleReconnect(name: string, why: string): void {
    if (this.stopped) return;
    const delay = this.delays.get(name) ?? 1;
    log("WARN", `backend '${name}' putus/gagal: ${why} (retry ${delay}s)`);
    this.delays.set(name, Math.min(delay * 2, 30));
    this.timers.set(name, setTimeout(() => void this.connect(name), delay * 1000));
  }
}
