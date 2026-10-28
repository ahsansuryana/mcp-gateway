#!/usr/bin/env node
/**
 * MCP Gateway (Node.js): banyak MCP server dijadikan satu endpoint /mcp.
 *
 * Jalankan:
 *   npm i @modelcontextprotocol/sdk@^1
 *   node gateway.mjs                    # pakai ./gateway.json
 *   node gateway.mjs -c /path/conf.json
 *
 * Backend bisa bertipe http | sse | stdio. Backend http/sse yang memakai OAuth
 * (misal https://mcp.vercel.com) cukup diberi  "auth": { "type": "oauth" }.
 * Login dilakukan SEKALI lewat browser; token disimpan di file (token_store)
 * dan di-refresh otomatis. Lihat README di bagian "OAuth" di bawah.
 *
 * OAuth (satu pengguna): gateway = OAuth client untuk tiap backend.
 *   1. backend balas 401 -> gateway discovery + registrasi client + buat URL login
 *   2. URL login dicetak di console (juga tool gateway__status & /health ber-token)
 *   3. Anda buka URL, login, klik Allow -> browser diarahkan ke /oauth/callback
 *   4. gateway menukar code jadi token, menyimpannya, lalu menyambung ulang
 * Token agent TIDAK pernah diteruskan ke backend (token passthrough dilarang spec).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

const log = (level, ...a) => console.log(new Date().toISOString(), level, ...a);

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------
function expandEnv(v) {
  if (typeof v === "string") return v.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? "");
  if (Array.isArray(v)) return v.map(expandEnv);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandEnv(x)]));
  return v;
}

function loadConfig(path) {
  let cfg;
  try {
    cfg = expandEnv(JSON.parse(readFileSync(path, "utf-8")));
  } catch (e) {
    console.error(`Gagal membaca ${path}: ${e.message}`);
    process.exit(1);
  }
  cfg.server ??= {};
  cfg.separator ??= "__";
  cfg.servers ??= {};
  cfg.profiles ??= {};
  for (const [n, c] of Object.entries(cfg.servers)) {
    if (c.expose !== undefined && !["full", "lazy", "auto"].includes(c.expose)) {
      console.error(`servers.${n}.expose harus "full", "lazy", atau "auto" (bukan ${JSON.stringify(c.expose)})`);
      process.exit(1);
    }
  }
  for (const [p, list] of Object.entries(cfg.profiles)) {
    if (!/^[\w.-]+$/.test(p) || !Array.isArray(list)) {
      console.error(`profiles.${p}: nama harus [A-Za-z0-9_.-] dan isinya array nama server`);
      process.exit(1);
    }
    for (const n of list) if (!(n in cfg.servers)) log("WARN", `profil '${p}' menyebut server '${n}' yang tidak ada di "servers"`);
  }
  cfg.server.token_store = resolve(dirname(resolve(path)), cfg.server.token_store ?? "tokens.json");
  const o = cfg.server.oauth;
  if (o && o.enabled !== false) {
    o.password ||= cfg.server.auth_token;
    if (!o.password) {
      console.error('server.oauth aktif tetapi tidak ada password: isi server.oauth.password (atau server.auth_token)');
      process.exit(1);
    }
    o.store = resolve(dirname(resolve(path)), o.store ?? "oauth-server.json");
  } else {
    cfg.server.oauth = null;
  }
  return cfg;
}

// glob sederhana: * = sembarang karakter
const globMatch = (pattern, s) =>
  new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(s);

// --------------------------------------------------------------------------
// OAuth: penyimpanan token (file JSON, izin 0600) + provider untuk SDK
// --------------------------------------------------------------------------
class TokenStore {
  constructor(path) {
    this.path = path;
    this.data = {};
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        log("WARN", `token store ${path} rusak, mulai dari kosong`);
      }
    }
  }
  get(name) {
    return this.data[name] ?? {};
  }
  update(name, patch) {
    this.data[name] = { ...this.get(name), ...patch };
    this.flush();
  }
  remove(name, keys) {
    const cur = { ...this.get(name) };
    for (const k of keys) delete cur[k];
    this.data[name] = cur;
    this.flush();
  }
  flush() {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
}

class GatewayOAuthProvider {
  constructor({ name, auth, store, redirectUrl }) {
    this.name = name;
    this.auth = auth;
    this.store = store;
    this._redirectUrl = redirectUrl;
    this.authUrl = null; // URL login terakhir (untuk ditunjukkan ke user)
    this.authRequired = false; // true begitu SDK meminta login
    this.pendingState = null;
    this._verifier = null;
  }
  get redirectUrl() {
    return this._redirectUrl;
  }
  get clientMetadata() {
    return {
      client_name: this.auth.client_name ?? "MCP Gateway",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.auth.client_secret ? "client_secret_post" : "none",
      ...(this.auth.scope ? { scope: this.auth.scope } : {}),
    };
  }
  state() {
    this.pendingState = randomBytes(16).toString("hex");
    return this.pendingState;
  }
  clientInformation() {
    if (this.auth.client_id) {
      return { client_id: this.auth.client_id, ...(this.auth.client_secret ? { client_secret: this.auth.client_secret } : {}) };
    }
    const info = this.store.get(this.name).clientInformation;
    // redirect URL berubah (port/public_url) -> registrasi lama tidak valid, daftar ulang
    if (info?.redirect_uris && !info.redirect_uris.includes(this._redirectUrl)) return undefined;
    return info;
  }
  saveClientInformation(info) {
    this.store.update(this.name, { clientInformation: info });
  }
  tokens() {
    return this.store.get(this.name).tokens;
  }
  saveTokens(tokens) {
    this.store.update(this.name, { tokens });
  }
  redirectToAuthorization(url) {
    this.authRequired = true;
    this.authUrl = url.toString();
  }
  saveCodeVerifier(v) {
    this._verifier = v;
  }
  codeVerifier() {
    if (!this._verifier) throw new Error("code verifier tidak ada (mulai ulang alur login)");
    return this._verifier;
  }
  invalidateCredentials(scope) {
    if (scope === "all") this.store.remove(this.name, ["tokens", "clientInformation"]);
    if (scope === "tokens") this.store.remove(this.name, ["tokens"]);
    if (scope === "client") this.store.remove(this.name, ["clientInformation"]);
    if (scope === "verifier") this._verifier = null;
  }
}

// --------------------------------------------------------------------------
// Backend pool: tiap backend punya Client sendiri, auto-reconnect dengan backoff.
// Status: up | down | needs_auth
// --------------------------------------------------------------------------
class BackendPool {
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

  makeTransport(cfg, provider) {
    const kind = cfg.type ?? "http";
    const headers = cfg.headers ?? {};
    if (kind === "http") {
      return new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers }, authProvider: provider });
    }
    if (kind === "sse") {
      return new SSEClientTransport(new URL(cfg.url), {
        requestInit: { headers },
        eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...init?.headers, ...headers } }) },
        authProvider: provider,
      });
    }
    if (kind === "stdio") {
      const env = Object.fromEntries(
        Object.entries({ ...process.env, ...(cfg.env ?? {}) }).filter(([, v]) => v !== undefined),
      );
      return new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env });
    }
    throw new Error(`type tidak dikenal: ${kind}`);
  }

  async connect(name) {
    if (this.stopped) return;
    const cfg = this.configs[name];
    const wantsOAuth = cfg.auth?.type === "oauth" && cfg.type !== "stdio";
    const provider = wantsOAuth ? this.getProvider(name) : undefined;
    if (provider) provider.authRequired = false;

    const client = new Client({ name: "mcp-gateway", version: "1.0.0" }, { capabilities: {} });
    const transport = this.makeTransport(cfg, provider);
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

// --------------------------------------------------------------------------
// Gateway (MCP server yang menghadap agent)
// --------------------------------------------------------------------------
const isAuthError = (e) => e instanceof UnauthorizedError || e?.code === 401;

function makeGatewayFactory(cfg, pool) {
  const sep = cfg.separator;
  const timeoutMs = (cfg.server.call_timeout ?? 60) * 1000;
  const lazyThreshold = cfg.server.lazy_threshold ?? 40;
  const compactCfg = cfg.compact ?? null; // ada blok "compact" = pemadatan aktif
  const maxDesc = compactCfg?.max_description ?? 0; // 0 = tidak dipotong
  const searchDesc = compactCfg?.max_description ?? 0; // 0 = deskripsi utuh

  const NAME = {
    status: `gateway${sep}status`,
    search: `gateway${sep}search_tools`,
    describe: `gateway${sep}describe_tool`,
    call: `gateway${sep}call_tool`,
  };

  const STATUS_TOOL = {
    name: NAME.status,
    description: "Status backend gateway (jumlah tool, mode) dan URL login OAuth bila perlu.",
    inputSchema: { type: "object", properties: {} },
  };
  // Hanya ditampilkan bila ada backend dalam mode lazy. Sengaja dibuat sesingkat mungkin.
  const META_TOOLS = [
    {
      name: NAME.search,
      description: `Cari tool yang disembunyikan dari daftar utama. Lanjut dengan ${NAME.describe}, lalu ${NAME.call}.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "kata kunci, mis. 'deployment logs'" },
          server: { type: "string", description: "batasi ke satu server" },
          limit: { type: "integer", description: "maks hasil (default 10)" },
        },
      },
    },
    {
      name: NAME.describe,
      description: "Ambil schema lengkap satu tool (nama lengkap dari hasil pencarian).",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    {
      name: NAME.call,
      description: "Jalankan tool tersembunyi: name = nama lengkap, arguments = objek sesuai schema.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, arguments: { type: "object" } },
        required: ["name"],
      },
    },
  ];

  const allowed = (name, tool) => {
    const c = pool.configs[name];
    if (c.allow_tools?.length && !c.allow_tools.some((p) => globMatch(p, tool))) return false;
    return !(c.deny_tools ?? []).some((p) => globMatch(p, tool));
  };

  const errorResult = (msg) => ({ isError: true, content: [{ type: "text", text: msg }] });
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const inScope = (scope, name) => !scope || scope.has(name);

  // ---- pemadatan (compact) ------------------------------------------------
  const shorten = (s, n) => {
    s = String(s ?? "").replace(/\s+/g, " ").trim();
    if (!n || s.length <= n) return s;
    const cut = s.slice(0, n - 1);
    const sp = cut.lastIndexOf(" ");
    return (sp > n * 0.6 ? cut.slice(0, sp) : cut) + "…";
  };

  const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "patternProperties"]);
  const RAW_KEYS = new Set(["default", "enum", "const", "examples", "required"]); // data, jangan disentuh
  function stripSchema(node) {
    if (Array.isArray(node)) return node.map(stripSchema);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "description" || k === "title") continue;
      if (SCHEMA_MAPS.has(k) && v && typeof v === "object") {
        out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, stripSchema(pv)]));
      } else if (RAW_KEYS.has(k)) out[k] = v;
      else out[k] = stripSchema(v);
    }
    return out;
  }

  function compactTool(t) {
    if (!compactCfg) return t;
    const out = { ...t };
    if (maxDesc > 0) out.description = shorten(t.description, maxDesc);
    delete out.title;
    delete out.icons;
    if (compactCfg.strip_param_descriptions) out.inputSchema = stripSchema(t.inputSchema);
    if (compactCfg.strip_output_schema ?? true) delete out.outputSchema;
    return out;
  }

  // ---- katalog tool per backend (di-cache di pool) ------------------------
  /** -> [{ backend, tools (sudah difilter allow/deny), mode: 'full'|'lazy' }] untuk backend yang terhubung */
  async function catalog(scope) {
    const names = [...pool.clients.keys()].filter((n) => inScope(scope, n));
    const results = await Promise.allSettled(names.map((n) => pool.listTools(n, timeoutMs)));
    const out = [];
    results.forEach((r, i) => {
      const backend = names[i];
      if (r.status === "rejected") {
        if (isAuthError(r.reason)) pool.markNeedsAuth(backend);
        log("WARN", `list_tools '${backend}' gagal:`, r.reason?.message ?? r.reason);
        return; // backend bermasalah dilewati, yang lain tetap tampil
      }
      const tools = r.value.filter((t) => allowed(backend, t.name));
      const expose = pool.configs[backend].expose ?? "auto";
      const mode = expose === "auto" ? (tools.length > lazyThreshold ? "lazy" : "full") : expose;
      out.push({ backend, tools, mode });
    });
    return out;
  }

  const authMessage = (name) => {
    const url = pool.authUrl(name);
    return url
      ? `backend '${name}' butuh login OAuth. Minta pengguna membuka URL ini di browser, lalu coba lagi: ${url}`
      : `backend '${name}' butuh login OAuth tetapi URL login belum siap, coba lagi sebentar lagi`;
  };

  // ---- eksekusi tool backend (dipakai panggilan langsung & gateway__call_tool) ----
  async function callBackendTool(scope, full, args) {
    const idx = full.indexOf(sep);
    if (idx < 0) return errorResult(`nama tool harus berformat <server>${sep}<tool>: ${full}`);
    const backend = full.slice(0, idx);
    const tool = full.slice(idx + sep.length);

    if (!(backend in pool.configs) || !inScope(scope, backend)) return errorResult(`server '${backend}' tidak ada`);
    if (!allowed(backend, tool)) return errorResult(`tool '${full}' tidak diizinkan`);
    const client = pool.clients.get(backend);
    if (!client) {
      return errorResult(
        pool.status(backend) === "needs_auth" ? authMessage(backend) : `server '${backend}' sedang tidak terhubung`,
      );
    }
    try {
      // Hasil backend diteruskan utuh (content, structuredContent, isError)
      return await client.callTool({ name: tool, arguments: args ?? {} }, undefined, { timeout: timeoutMs });
    } catch (e) {
      if (isAuthError(e) && pool.providers.has(backend)) {
        pool.markNeedsAuth(backend);
        return errorResult(authMessage(backend));
      }
      return errorResult(e?.message ?? String(e));
    }
  }

  // ---- meta-tool ------------------------------------------------------------
  async function handleSearch(scope, args) {
    // "logs" -> "log": samakan bentuk jamak sederhana agar kueri alami tetap cocok
    const tokens = String(args.query ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
    const server = args.server ? String(args.server) : null;
    const limit = Math.min(Math.max(parseInt(args.limit) || (tokens.length ? 10 : 50), 1), 100);

    const cat = (await catalog(scope)).filter((c) => c.mode === "lazy" && (!server || c.backend === server));
    const rows = [];
    for (const c of cat) {
      for (const t of c.tools) {
        const name = t.name.toLowerCase();
        const desc = (t.description ?? "").toLowerCase();
        const parts = name.split(/[^a-z0-9]+/);
        let score = 0;
        for (const tok of tokens) {
          if (parts.includes(tok)) score += 5;
          else if (name.includes(tok)) score += 3;
          if (desc.includes(tok)) score += 1;
        }
        if (tokens.length === 0 || score > 0) rows.push({ score, full: `${c.backend}${sep}${t.name}`, desc: t.description });
      }
    }
    rows.sort((a, b) => b.score - a.score || a.full.localeCompare(b.full));
    if (rows.length === 0) {
      const lazyNames = [...new Set((await catalog(scope)).filter((c) => c.mode === "lazy").map((c) => c.backend))];
      return text(
        `Tidak ada tool yang cocok. Coba kata kunci lain, atau isi 'server' tanpa 'query' untuk melihat daftar. ` +
          `Server mode lazy: ${lazyNames.join(", ") || "(tidak ada)"}`,
      );
    }
    const shown = rows.slice(0, limit);
    const lines = shown.map((r) => `${r.full} - ${searchDesc > 0 ? shorten(r.desc, searchDesc) : (r.desc ?? "")}`);
    const more = rows.length > shown.length ? `\n(+${rows.length - shown.length} lainnya, persempit query atau naikkan limit)` : "";
    return text(`${rows.length} tool ditemukan:\n${lines.join("\n")}${more}`);
  }

  async function handleDescribe(scope, args) {
    const full = String(args.name ?? "");
    const idx = full.indexOf(sep);
    const backend = idx > 0 ? full.slice(0, idx) : "";
    const tool = idx > 0 ? full.slice(idx + sep.length) : "";
    if (!backend || !(backend in pool.configs) || !inScope(scope, backend) || !allowed(backend, tool)) {
      return errorResult(`tool '${full}' tidak ditemukan. Gunakan ${NAME.search} untuk mencari nama yang benar.`);
    }
    if (!pool.clients.has(backend)) return errorResult(`server '${backend}' sedang tidak terhubung`);
    try {
      const t = (await pool.listTools(backend, timeoutMs)).find((x) => x.name === tool);
      if (!t) return errorResult(`tool '${full}' tidak ditemukan. Gunakan ${NAME.search} untuk mencari nama yang benar.`);
      return text(JSON.stringify({ name: full, description: t.description, inputSchema: t.inputSchema }, null, 2));
    } catch (e) {
      if (isAuthError(e) && pool.providers.has(backend)) {
        pool.markNeedsAuth(backend);
        return errorResult(authMessage(backend));
      }
      return errorResult(e?.message ?? String(e));
    }
  }

  async function handleStatus(scope) {
    const cat = new Map((await catalog(scope)).map((c) => [c.backend, c]));
    const lines = Object.keys(pool.configs)
      .filter((n) => inScope(scope, n))
      .map((n) => {
        const s = pool.status(n);
        const c = cat.get(n);
        const url = pool.authUrl(n);
        const info = c ? ` (${c.mode}, ${c.tools.length} tool)` : "";
        return `${n}: ${s}${info}${url ? `\n  login: ${url}` : ""}`;
      });
    return text(lines.join("\n"));
  }

  // Server per-request (mode stateless), tapi pool backend dipakai bersama.
  // scope = Set nama backend (profil) atau null untuk semua.
  return function createGatewayServer(scope = null, label = null) {
    const server = new Server(
      { name: (cfg.server.name ?? "mcp-gateway") + (label ? `/${label}` : ""), version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const cat = await catalog(scope);
      const out = [STATUS_TOOL];
      if (cat.some((c) => c.mode === "lazy")) out.push(...META_TOOLS);
      for (const c of cat) {
        if (c.mode !== "full") continue;
        for (const t of c.tools) out.push(compactTool({ ...t, name: `${c.backend}${sep}${t.name}` }));
      }
      return { tools: out };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const full = req.params.name;
      const args = req.params.arguments ?? {};
      if (full === NAME.status) return handleStatus(scope);
      if (full === NAME.search) return handleSearch(scope, args);
      if (full === NAME.describe) return handleDescribe(scope, args);
      if (full === NAME.call) {
        if (typeof args.name !== "string") return errorResult("parameter 'name' (string) wajib diisi");
        return callBackendTool(scope, args.name, args.arguments);
      }
      return callBackendTool(scope, full, args);
    });

    return server;
  };
}

// --------------------------------------------------------------------------
// OAuth 2.1 authorization server milik gateway (arah: agen -> gateway)
// Discovery (RFC 9728 + 8414), Dynamic Client Registration (RFC 7591),
// Authorization Code + PKCE S256, refresh token berputar, revoke (RFC 7009).
// Login pemilik: satu password (server.oauth.password).
// --------------------------------------------------------------------------
const sha256hex = (s) => createHash("sha256").update(String(s)).digest("hex");
const rand = (n = 32) => randomBytes(n).toString("base64url");
const safeEq = (a, b) =>
  timingSafeEqual(createHash("sha256").update(String(a)).digest(), createHash("sha256").update(String(b)).digest());

function validRedirect(u) {
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === "https:") return true;
    if (x.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname);
    return !["javascript:", "data:", "file:", "vbscript:", "blob:"].includes(x.protocol); // skema kustom app native
  } catch {
    return false;
  }
}

function redirectWith(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.toString();
}

class OAuthServer {
  constructor({ issuer, password, storePath, accessTtl, refreshTtl }) {
    this.issuer = issuer;
    this.password = password;
    this.path = storePath;
    this.accessTtl = accessTtl;
    this.refreshTtl = refreshTtl;
    this.data = { clients: {}, access: {}, refresh: {} };
    if (existsSync(storePath)) {
      try {
        Object.assign(this.data, JSON.parse(readFileSync(storePath, "utf-8")));
      } catch {
        log("WARN", `oauth store ${storePath} rusak, mulai dari kosong`);
      }
    }
    for (const k of ["clients", "access", "refresh"]) this.data[k] ??= {};
    this.codes = new Map(); // hash(code) -> data (hanya di memori, 5 menit)
    this.txns = new Map(); //  id login -> data (hanya di memori, 10 menit)
    this.fails = new Map(); // ip -> { n, until }
    this.prune();
  }

  flush() {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  prune() {
    const now = Date.now();
    for (const k of ["access", "refresh"]) for (const [h, v] of Object.entries(this.data[k])) if (v.exp <= now) delete this.data[k][h];
    for (const m of [this.codes, this.txns]) for (const [k, v] of m) if (v.exp <= now) m.delete(k);
    for (const [k, v] of this.fails) if ((v.until ?? 0) <= now && v.n === 0) this.fails.delete(k);
  }

  authServerMetadata(i = this.issuer) {
    return {
      issuer: i,
      authorization_endpoint: `${i}/authorize`,
      token_endpoint: `${i}/token`,
      registration_endpoint: `${i}/register`,
      revocation_endpoint: `${i}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ["mcp"],
    };
  }

  register(body) {
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && validRedirect(u))) {
      return { error: "invalid_redirect_uri", error_description: "redirect_uris wajib (1-10 URI; https, atau http://localhost)" };
    }
    const method = body.token_endpoint_auth_method ?? "none";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
      return { error: "invalid_client_metadata", error_description: "token_endpoint_auth_method tidak didukung" };
    }
    const client = {
      client_id: rand(16),
      client_name: String(body.client_name ?? "").slice(0, 100) || "MCP client",
      redirect_uris: uris,
      token_endpoint_auth_method: method,
    };
    const issuedAt = Math.floor(Date.now() / 1000);
    let secret;
    if (method !== "none") {
      secret = rand(32);
      client.secret_hash = sha256hex(secret);
    }
    this.data.clients[client.client_id] = client;
    const ids = Object.keys(this.data.clients);
    if (ids.length > 200) for (const id of ids.slice(0, ids.length - 200)) delete this.data.clients[id]; // batasi spam registrasi
    this.flush();
    return {
      ok: {
        client_id: client.client_id,
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: issuedAt,
        client_name: client.client_name,
        redirect_uris: uris,
        token_endpoint_auth_method: method,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
    };
  }

  // Validasi request /authorize. fatal = jangan redirect (client/redirect_uri tidak tepercaya).
  beginAuthorize(q) {
    const client = this.data.clients[q.get("client_id") ?? ""];
    if (!client) return { fatal: "client_id tidak dikenal. Hubungkan ulang dari agen (registrasi mungkin hilang)." };
    const given = q.get("redirect_uri");
    const ru = given ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
    if (!ru || !client.redirect_uris.includes(ru)) return { fatal: "redirect_uri tidak cocok dengan yang didaftarkan." };
    const state = q.get("state") ?? undefined;
    const fail = (error, desc) => ({ redirect: redirectWith(ru, { error, error_description: desc, state }) });
    if (q.get("response_type") !== "code") return fail("unsupported_response_type", "hanya response_type=code");
    const challenge = q.get("code_challenge");
    if (!challenge || q.get("code_challenge_method") !== "S256" || !/^[\w-]{43}$/.test(challenge)) {
      return fail("invalid_request", "PKCE dengan code_challenge_method=S256 wajib");
    }
    this.prune();
    const txn = rand();
    this.txns.set(txn, { client_id: client.client_id, redirect_uri: ru, state, challenge, resource: q.get("resource") ?? undefined, exp: Date.now() + 10 * 60e3 });
    return { txn, client, redirectHost: new URL(ru).host || new URL(ru).protocol };
  }

  txnInfo(id) {
    const t = this.txns.get(id ?? "");
    if (!t || t.exp <= Date.now()) return null;
    const client = this.data.clients[t.client_id];
    return client ? { txn: id, client, redirectHost: new URL(t.redirect_uri).host || new URL(t.redirect_uri).protocol } : null;
  }

  approve(txnId, password, ip) {
    const t = this.txns.get(txnId ?? "");
    if (!t || t.exp <= Date.now()) return { kind: "expired" };
    const f = this.fails.get(ip) ?? { n: 0, until: 0 };
    if (f.until > Date.now()) return { kind: "locked" };
    if (!safeEq(password ?? "", this.password)) {
      f.n += 1;
      if (f.n >= 5) {
        f.n = 0;
        f.until = Date.now() + 15 * 60e3;
        log("WARN", `login OAuth gateway: 5 password salah dari ${ip}, dikunci 15 menit`);
      }
      this.fails.set(ip, f);
      return { kind: "wrong" };
    }
    this.fails.delete(ip);
    this.txns.delete(txnId);
    const code = rand();
    this.codes.set(sha256hex(code), { ...t, exp: Date.now() + 5 * 60e3 });
    return { kind: "ok", location: redirectWith(t.redirect_uri, { code, state: t.state }) };
  }

  issue(clientId) {
    const access = rand();
    const refresh = rand();
    const now = Date.now();
    this.data.access[sha256hex(access)] = { client_id: clientId, exp: now + this.accessTtl * 1000 };
    this.data.refresh[sha256hex(refresh)] = { client_id: clientId, exp: now + this.refreshTtl * 1000 };
    this.prune();
    this.flush();
    return { access_token: access, token_type: "Bearer", expires_in: this.accessTtl, refresh_token: refresh, scope: "mcp" };
  }

  token(p, basic) {
    const err = (error, error_description, status = 400) => ({ status, body: { error, error_description } });
    const cid = basic?.id ?? p.client_id;
    const secret = basic?.secret ?? p.client_secret;
    const client = this.data.clients[cid ?? ""];
    if (!client) return err("invalid_client", "client tidak dikenal", 401);
    if (client.token_endpoint_auth_method !== "none" && !(secret && safeEq(sha256hex(secret), client.secret_hash))) {
      return err("invalid_client", "client_secret salah", 401);
    }

    if (p.grant_type === "authorization_code") {
      const key = sha256hex(p.code ?? "");
      const c = this.codes.get(key);
      this.codes.delete(key); // sekali pakai
      if (!c || c.exp <= Date.now() || c.client_id !== client.client_id) return err("invalid_grant", "code tidak valid atau kedaluwarsa");
      if (p.redirect_uri !== undefined && p.redirect_uri !== c.redirect_uri) return err("invalid_grant", "redirect_uri tidak cocok");
      const v = String(p.code_verifier ?? "");
      if (!/^[\w.~-]{43,128}$/.test(v) || !safeEq(createHash("sha256").update(v).digest("base64url"), c.challenge)) {
        return err("invalid_grant", "code_verifier (PKCE) tidak cocok");
      }
      return { status: 200, body: this.issue(client.client_id) };
    }

    if (p.grant_type === "refresh_token") {
      const key = sha256hex(p.refresh_token ?? "");
      const r = this.data.refresh[key];
      if (!r || r.exp <= Date.now() || r.client_id !== client.client_id) return err("invalid_grant", "refresh_token tidak valid atau kedaluwarsa");
      delete this.data.refresh[key]; // rotasi
      return { status: 200, body: this.issue(client.client_id) };
    }
    return err("unsupported_grant_type", "gunakan authorization_code atau refresh_token");
  }

  revoke(tok) {
    const h = sha256hex(tok ?? "");
    if (this.data.access[h] || this.data.refresh[h]) {
      delete this.data.access[h];
      delete this.data.refresh[h];
      this.flush();
    }
  }

  verify(tok) {
    if (!tok) return false;
    const h = sha256hex(tok);
    const a = this.data.access[h];
    if (!a) return false;
    if (a.exp <= Date.now()) {
      delete this.data.access[h];
      return false;
    }
    return true;
  }
}

async function readRaw(req, limit = 65536) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error("body terlalu besar");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

const parseBody = (req, raw) =>
  (req.headers["content-type"] ?? "").includes("json") ? (raw ? JSON.parse(raw) : {}) : Object.fromEntries(new URLSearchParams(raw));

const loginPage = ({ client, redirectHost, txn }, msg) =>
  `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Izinkan akses</title>` +
  `<body style="font-family:sans-serif;max-width:420px;margin:4rem auto;padding:0 1rem"><h2>Izinkan akses ke gateway</h2>` +
  `<p><b>${esc(client.client_name)}</b> (${esc(redirectHost)}) meminta akses ke semua tool MCP di gateway ini.</p>` +
  (msg ? `<p style="color:#b00">${esc(msg)}</p>` : "") +
  `<form method="post" action="/authorize"><input type="hidden" name="txn" value="${esc(txn)}">` +
  `<label>Password gateway<br><input type="password" name="password" autofocus required style="width:100%;padding:.5rem;margin:.5rem 0"></label>` +
  `<button style="padding:.5rem 1rem">Izinkan</button></form></body></html>`;

const pageHeaders = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" };

// true = request sudah ditangani
async function handleOAuthRoute(oauth, req, res, url, baseOf, ipOf) {
  const path = url.pathname;
  const base = baseOf(req); // issuer yang cocok dengan host yang dipakai klien
  const known = ["/register", "/token", "/revoke", "/authorize"].includes(path) || path.startsWith("/.well-known/");
  if (!known) return false;
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
    "Cache-Control": "no-store",
  };
  if (req.method === "OPTIONS" && path !== "/authorize") {
    res.writeHead(204, cors);
    res.end();
    return true;
  }
  const json = (status, body) => sendJson(res, status, body, cors);
  const wantMethod = (...ms) => (ms.includes(req.method) ? true : (json(405, { error: "method not allowed" }), false));

  try {
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      if (wantMethod("GET")) json(200, oauth.authServerMetadata(base));
      return true;
    }
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      const suffix = path.slice("/.well-known/oauth-protected-resource".length).replace(/\/+$/, "") || "/mcp";
      if (!/^\/mcp(\/[\w.-]+)?$/.test(suffix)) return false;
      if (wantMethod("GET")) json(200, { resource: base + suffix, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: ["mcp"] });
      return true;
    }
    if (path === "/register") {
      if (!wantMethod("POST")) return true;
      const r = oauth.register(parseBody(req, await readRaw(req)));
      return json(r.ok ? 201 : 400, r.ok ?? r), true;
    }
    if (path === "/token") {
      if (!wantMethod("POST")) return true;
      let basic;
      const ah = req.headers.authorization ?? "";
      if (/^Basic /i.test(ah)) {
        const [id, ...rest] = Buffer.from(ah.slice(6), "base64").toString("utf-8").split(":");
        basic = { id: decodeURIComponent(id), secret: decodeURIComponent(rest.join(":")) };
      }
      const r = oauth.token(parseBody(req, await readRaw(req)), basic);
      return json(r.status, r.body), true;
    }
    if (path === "/revoke") {
      if (!wantMethod("POST")) return true;
      oauth.revoke(parseBody(req, await readRaw(req)).token);
      res.writeHead(200, cors);
      res.end();
      return true;
    }
    // /authorize
    if (req.method === "GET") {
      const r = oauth.beginAuthorize(url.searchParams);
      if (r.fatal) return sendHtml(res, 400, "Permintaan tidak valid", r.fatal), true;
      if (r.redirect) return res.writeHead(302, { Location: r.redirect, "Cache-Control": "no-store" }), res.end(), true;
      res.writeHead(200, pageHeaders);
      res.end(loginPage(r));
      return true;
    }
    if (req.method === "POST") {
      const f = parseBody(req, await readRaw(req));
      const r = oauth.approve(f.txn, f.password, ipOf(req));
      if (r.kind === "ok") return res.writeHead(302, { Location: r.location, "Cache-Control": "no-store" }), res.end(), true;
      if (r.kind === "expired") return sendHtml(res, 400, "Sesi kedaluwarsa", "Mulai ulang proses hubungkan dari agen."), true;
      if (r.kind === "locked") return sendHtml(res, 429, "Terlalu banyak percobaan", "Coba lagi dalam 15 menit."), true;
      const info = oauth.txnInfo(f.txn);
      res.writeHead(401, pageHeaders);
      res.end(info ? loginPage(info, "Password salah.") : "");
      return true;
    }
    json(405, { error: "method not allowed" });
    return true;
  } catch (e) {
    if (!res.headersSent) json(400, { error: "invalid_request", error_description: e?.message ?? "bad request" });
    return true;
  }
}

// --------------------------------------------------------------------------
// HTTP layer: /mcp, /health, /oauth/callback, endpoint OAuth gateway; bearer auth
// --------------------------------------------------------------------------
const sendJson = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sendHtml = (res, status, title, msg) => {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
      `<body style="font-family:sans-serif;max-width:480px;margin:4rem auto"><h2>${esc(title)}</h2><p>${esc(msg)}</p></body>`,
  );
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : undefined;
}

function buildHttpServer(cfg, pool, oauth, publicUrl, bases) {
  const createGatewayServer = makeGatewayFactory(cfg, pool);
  const token = cfg.server.auth_token || null;
  const bearerOf = (req) => (/^Bearer (.+)$/i.exec(req.headers.authorization ?? "") ?? [])[1] ?? null;
  const authRequired = !!(token || oauth);
  const authorized = (req) => {
    if (!authRequired) return true;
    const b = bearerOf(req);
    return !!b && ((token && safeEq(b, token)) || (oauth && oauth.verify(b)));
  };
  const trustProxy = !!cfg.server.trust_proxy;
  // Basis URL per request: harus sama dengan alamat yang dipakai klien (RFC 8414 §3.3).
  // Hanya host yang ada di `bases` yang diterima; selain itu jatuh ke public_url (anti Host-header spoofing).
  const hostOf = (b) => new URL(b).host.toLowerCase();
  const baseOf = (req) => {
    const h = String((trustProxy && req.headers["x-forwarded-host"]) || req.headers.host || "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    return bases.find((b) => hostOf(b) === h) ?? publicUrl;
  };
  const ipOf = (req) =>
    trustProxy && req.headers["x-forwarded-for"]
      ? String(req.headers["x-forwarded-for"]).split(",").pop().trim()
      : req.socket.remoteAddress ?? "?";

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;

    if (oauth && (await handleOAuthRoute(oauth, req, res, url, baseOf, ipOf))) return;

    if (path === "/health") {
      const names = Object.keys(pool.configs);
      const body = { backends: Object.fromEntries(names.map((n) => [n, pool.status(n)])) };
      // URL login hanya ditampilkan ke pemegang token gateway
      if (authorized(req)) {
        const urls = Object.fromEntries(names.map((n) => [n, pool.authUrl(n)]).filter(([, u]) => u));
        if (Object.keys(urls).length) body.auth_urls = urls;
      }
      return sendJson(res, 200, body);
    }

    // Tujuan redirect browser setelah login di authorization server backend.
    // Tidak bisa memakai bearer token; dilindungi oleh parameter `state` acak.
    if (path === "/oauth/callback") {
      const name = pool.findByState(url.searchParams.get("state"));
      if (!name) return sendHtml(res, 400, "Login gagal", "State tidak valid atau sudah kedaluwarsa. Mulai ulang dari URL login terbaru.");
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (err || !code) return sendHtml(res, 400, "Login ditolak", `Authorization server membalas: ${err ?? "tanpa code"}`);
      try {
        await pool.completeAuth(name, code);
        log("INFO", `login OAuth '${name}' berhasil`);
        return sendHtml(res, 200, "Login berhasil", `Backend '${name}' sudah terhubung. Tab ini boleh ditutup.`);
      } catch (e) {
        log("ERROR", `login OAuth '${name}' gagal:`, e?.message ?? e);
        return sendHtml(res, 500, "Login gagal", e?.message ?? String(e));
      }
    }

    const m = path.replace(/\/+$/, "").match(/^\/mcp(?:\/([\w.-]+))?$/);
    if (!m) return sendJson(res, 404, { error: "not found" });

    if (!authorized(req)) {
      const params = [];
      if (oauth) params.push(`resource_metadata="${baseOf(req)}/.well-known/oauth-protected-resource${path.replace(/\/+$/, "")}"`);
      if (bearerOf(req)) params.push('error="invalid_token"');
      return sendJson(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": params.length ? `Bearer ${params.join(", ")}` : "Bearer" });
    }

    // /mcp = semua server; /mcp/<profil> = hanya server yang terdaftar di profil itu
    const profile = m[1] ?? null;
    if (profile && !Object.hasOwn(cfg.profiles, profile)) {
      return sendJson(res, 404, { error: `profil '${profile}' tidak ada` });
    }
    const scope = profile ? new Set(cfg.profiles[profile]) : null;

    // Mode stateless: hanya POST. GET (stream) & DELETE (session) tidak dipakai.
    if (req.method !== "POST") {
      return sendJson(res, 405, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed (gateway stateless)" },
        id: null,
      });
    }

    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }

    const server = createGatewayServer(scope, profile);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log("ERROR", "handle /mcp gagal:", e?.message ?? e);
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  });
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
function main() {
  const i = process.argv.findIndex((a) => a === "-c" || a === "--config");
  const configPath = i > -1 ? process.argv[i + 1] : "gateway.json";
  const cfg = loadConfig(configPath);

  const host = cfg.server.host ?? "0.0.0.0";
  const port = cfg.server.port ?? 8000;
  // Harus sama persis dengan redirect URI yang didaftarkan ke authorization server.
  // Jika gateway di server remote, isi server.public_url (HTTPS), mis. https://gw.example.com
  const publicUrl = (cfg.server.public_url ?? `http://localhost:${port}`).replace(/\/$/, "");
  // Redirect URI untuk login ke backend OAuth (mis. Vercel). Terpisah dari public_url (issuer agen -> gateway):
  // sebagian provider hanya menyetujui redirect localhost. Default tetap <public_url>/oauth/callback.
  const redirectUrl = String(cfg.server.backend_redirect_url ?? `${publicUrl}/oauth/callback`);
  if (!/\/oauth\/callback$/.test(redirectUrl)) {
    console.error("server.backend_redirect_url harus berakhiran /oauth/callback (route callback gateway)");
    process.exit(1);
  }

  const store = new TokenStore(cfg.server.token_store);
  const pool = new BackendPool(cfg.servers, {
    store,
    redirectUrl,
    cacheTtlMs: (cfg.server.tools_cache_ttl ?? 60) * 1000,
  });
  const oc = cfg.server.oauth;
  const oauth = oc
    ? new OAuthServer({
        issuer: publicUrl,
        password: oc.password,
        storePath: oc.store,
        accessTtl: oc.access_ttl ?? 3600,
        refreshTtl: oc.refresh_ttl ?? 30 * 86400,
      })
    : null;
  if (oauth && !/^https:\/\//.test(publicUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
    log("WARN", `server.public_url (${publicUrl}) bukan HTTPS; kebanyakan agen remote menolak OAuth tanpa HTTPS`);
  }
  // Alamat yang boleh jadi issuer: public_url, loopback otomatis, dan server.extra_public_urls
  const norm = (u) => String(u).replace(/\/+$/, "");
  const bases = [
    ...new Set([
      publicUrl,
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      ...(cfg.server.extra_public_urls ?? []).map(norm),
    ]),
  ];
  const http = buildHttpServer(cfg, pool, oauth, publicUrl, bases);

  pool.start();
  http.listen(port, host, () => {
    log("INFO", `gateway di http://${host}:${port}/mcp`);
    for (const p of Object.keys(cfg.profiles)) log("INFO", `profil: http://${host}:${port}/mcp/${p} -> ${cfg.profiles[p].join(", ")}`);
    if (oauth) log("INFO", `OAuth gateway aktif. Issuer diterima untuk: ${bases.join(", ")}`);
    if (Object.values(cfg.servers).some((s) => s.auth?.type === "oauth" && s.enabled !== false)) {
      log("INFO", `OAuth redirect URI: ${redirectUrl}  (token disimpan di ${cfg.server.token_store})`);
    }
  });

  const shutdown = async () => {
    log("INFO", "shutdown...");
    http.close();
    await pool.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
