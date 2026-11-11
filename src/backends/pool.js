import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../utils/logger.js";
import { GatewayOAuthProvider } from "./oauth-provider.js";
import { createTransport } from "./transports.js";

/**
 * Backend pool: tiap backend punya Client sendiri, auto-reconnect dengan backoff.
 * Status: up | down | needs_auth
 */
export class BackendPool {
  constructor(servers, { store, redirectUrl, cacheTtlMs = 60000 }) {
    this.configs = Object.fromEntries(Object.entries(servers).filter(([, c]) => c.enabled !== false));
    this.store = store;
    this.redirectUrl = redirectUrl;
    this.cacheTtlMs = cacheTtlMs;
    this.catalog = new Map(); // name -> { at, tools } (cache daftar tool)
    this.clients = new Map(); // name -> Client (hanya yang sedang terhubung)
    this.transports = new Map(); // name -> transport aktif
    this.providers = new Map(); // name -> GatewayOAuthProvider
    this.pending = new Map(); // name -> transport yang menunggu finishAuth
    this.timers = new Map();
    this.delays = new Map();
    this.stopped = false;
  }

  start() {
    for (const name of Object.keys(this.configs)) this.connect(name);
  }

  async stop() {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
  }

  status(name) {
    if (this.clients.has(name)) return "up";
    if (this.pending.has(name)) return "needs_auth";
    return "down";
  }

  invalidate(name) {
    this.catalog.delete(name);
  }

  /** Daftar tool backend (semua halaman), di-cache; dibatalkan saat putus atau list_changed. */
  async listTools(name, timeoutMs) {
    const hit = this.catalog.get(name);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) return hit.tools;
    const client = this.clients.get(name);
    if (!client) throw new Error(`server '${name}' tidak terhubung`);
    const tools = [];
    let cursor;
    do {
      const res = await client.listTools({ cursor }, { timeout: timeoutMs });
      tools.push(...res.tools);
      cursor = res.nextCursor;
    } while (cursor);
    this.catalog.set(name, { at: Date.now(), tools });
    return tools;
  }

  authUrl(name) {
    return this.status(name) === "needs_auth" ? this.providers.get(name)?.authUrl ?? null : null;
  }

  getProvider(name) {
    let p = this.providers.get(name);
    if (!p) {
      p = new GatewayOAuthProvider({
        name,
        auth: this.configs[name].auth,
        store: this.store,
        redirectUrl: this.redirectUrl,
      });
      this.providers.set(name, p);
    }
    return p;
  }

  async connect(name) {
    if (this.stopped) return;
    const cfg = this.configs[name];
    const wantsOAuth = cfg.auth?.type === "oauth" && cfg.type !== "stdio";
    const provider = wantsOAuth ? this.getProvider(name) : undefined;
    if (provider) provider.authRequired = false;

    const client = new Client({ name: "mcp-gateway", version: "1.0.0" }, { capabilities: {} });
    const transport = createTransport(cfg, provider);
    let handled = false;
    const onDown = (why) => {
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
        this.pending.set(name, transport);
        log("WARN", `backend '${name}' butuh login OAuth. Buka URL ini di browser:\n  ${provider.authUrl}`);
        return;
      }
      client.close().catch(() => {});
      onDown(e?.message ?? String(e));
    }
  }

  /** Dipanggil saat tool call/list gagal karena token ditolak dan tidak bisa di-refresh. */
  markNeedsAuth(name) {
    const provider = this.providers.get(name);
    if (!provider) return;
    const client = this.clients.get(name);
    this.clients.delete(name);
    this.invalidate(name);
    if (provider.authRequired) {
      this.pending.set(name, this.transports.get(name));
      log("WARN", `backend '${name}' butuh login ulang. Buka URL ini di browser:\n  ${provider.authUrl}`);
    }
    client?.close().catch(() => {});
  }

  findByState(state) {
    if (!state) return null;
    for (const [name, p] of this.providers) if (p.pendingState && p.pendingState === state) return name;
    return null;
  }

  async completeAuth(name, code) {
    const transport = this.pending.get(name);
    const provider = this.providers.get(name);
    if (!transport) throw new Error(`backend '${name}' tidak sedang menunggu login`);
    await transport.finishAuth(code); // tukar code -> token (PKCE), disimpan lewat provider
    provider.pendingState = null;
    provider.authUrl = null;
    this.pending.delete(name);
    await this.connect(name);
    if (!this.clients.has(name)) throw new Error("token tersimpan tapi koneksi ke backend masih gagal, lihat log gateway");
  }

  scheduleReconnect(name, why) {
    if (this.stopped) return;
    const delay = this.delays.get(name) ?? 1;
    log("WARN", `backend '${name}' putus/gagal: ${why} (retry ${delay}s)`);
    this.delays.set(name, Math.min(delay * 2, 30));
    this.timers.set(name, setTimeout(() => this.connect(name), delay * 1000));
  }
}
