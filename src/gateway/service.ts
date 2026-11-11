import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type CompleteRequest,
  type CompleteResult,
  type GetPromptResult,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { BackendPool } from "../backend/pool.js";
import type { ExposeMode, GatewayConfig } from "../config/types.js";
import { globMatch } from "../utils/glob.js";
import { log } from "../utils/logger.js";
import { createCompactor, shorten, type Compactor } from "./compact.js";
import { buildMetaTools, buildStatusTool, buildToolNames, type ToolNames } from "./tools.js";
import { hasUiMeta } from "./apps.js";
import { rewriteBlockUris, rewriteToolMeta, unwrapUri, wrapUri } from "./uri.js";

/** Himpunan nama backend yang boleh dilihat (profil), atau null = semua. */
export type Scope = Set<string> | null;

interface CatalogEntry {
  backend: string;
  tools: Tool[];
  mode: Exclude<ExposeMode, "auto">;
}

const isAuthError = (e: unknown): boolean =>
  e instanceof UnauthorizedError || (e as { code?: number } | null)?.code === 401;

const errorResult = (msg: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: msg }] });
const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const inScope = (scope: Scope, name: string): boolean => !scope || scope.has(name);

/** Logika gateway: katalog tool, filter allow/deny, meta-tool, dan penerusan panggilan ke backend. */
export class GatewayService {
  readonly names: ToolNames;
  private readonly sep: string;
  private readonly timeoutMs: number;
  private readonly lazyThreshold: number;
  private readonly compactor: Compactor;
  private readonly statusTool: Tool;
  private readonly metaTools: Tool[];

  constructor(
    private readonly cfg: GatewayConfig,
    private readonly pool: BackendPool,
  ) {
    this.sep = cfg.separator;
    this.timeoutMs = (cfg.server.call_timeout ?? 60) * 1000;
    this.lazyThreshold = cfg.server.lazy_threshold ?? 40;
    this.compactor = createCompactor(cfg.compact);
    this.names = buildToolNames(this.sep);
    this.statusTool = buildStatusTool(this.names);
    this.metaTools = buildMetaTools(this.names);
  }

  private allowed(name: string, tool: string): boolean {
    return this.allowedBy(name, "tools", tool);
  }

  /** Filter allow/deny (glob) per jenis: tools, prompts, atau resources. */
  private allowedBy(name: string, kind: "tools" | "prompts" | "resources", item: string): boolean {
    const c = this.pool.configs[name];
    const allow = c[`allow_${kind}` as const];
    const deny = c[`deny_${kind}` as const];
    if (allow?.length && !allow.some((p) => globMatch(p, item))) return false;
    return !(deny ?? []).some((p) => globMatch(p, item));
  }

  /** Backend terhubung + tool yang lolos filter + mode tampilan (full/lazy). */
  private async catalog(scope: Scope): Promise<CatalogEntry[]> {
    const names = [...this.pool.clients.keys()].filter((n) => inScope(scope, n));
    const results = await Promise.allSettled(names.map((n) => this.pool.listTools(n, this.timeoutMs)));
    const out: CatalogEntry[] = [];
    results.forEach((r, i) => {
      const backend = names[i];
      if (r.status === "rejected") {
        if (isAuthError(r.reason)) this.pool.markNeedsAuth(backend);
        log("WARN", `list_tools '${backend}' gagal:`, r.reason?.message ?? r.reason);
        return; // backend bermasalah dilewati, yang lain tetap tampil
      }
      const tools = r.value.filter((t) => this.allowed(backend, t.name));
      const expose = this.pool.configs[backend].expose ?? "auto";
      const mode = expose === "auto" ? (tools.length > this.lazyThreshold ? "lazy" : "full") : expose;
      out.push({ backend, tools, mode });
    });
    return out;
  }

  private authMessage(name: string): string {
    const url = this.pool.authUrl(name);
    return url
      ? `backend '${name}' butuh login OAuth. Minta pengguna membuka URL ini di browser, lalu coba lagi: ${url}`
      : `backend '${name}' butuh login OAuth tetapi URL login belum siap, coba lagi sebentar lagi`;
  }

  /** Pecah `<server><sep><tool>`; null bila formatnya salah. */
  private split(full: string): { backend: string; tool: string } | null {
    const idx = full.indexOf(this.sep);
    if (idx <= 0) return null;
    return { backend: full.slice(0, idx), tool: full.slice(idx + this.sep.length) };
  }

  // ---- daftar tool untuk agen ----------------------------------------------
  async listTools(scope: Scope): Promise<Tool[]> {
    const cat = await this.catalog(scope);
    const out: Tool[] = [this.statusTool];
    if (cat.some((c) => c.mode === "lazy")) out.push(...this.metaTools);
    for (const c of cat) {
      for (const t of c.tools) {
        // Mode lazy menyembunyikan tool, kecuali yang membawa UI (MCP Apps): host membaca _meta.ui dari tools/list,
        // dan tool khusus-aplikasi (visibility: ["app"]) harus ada di daftar agar bisa dipanggil dari UI.
        if (c.mode !== "full" && !hasUiMeta(t)) continue;
        // _meta.ui.resourceUri ikut ditulis ulang agar tetap menunjuk ke resource lewat gateway (MCP Apps)
        const named = rewriteToolMeta(c.backend, { ...t, name: `${c.backend}${this.sep}${t.name}` });
        out.push(this.compactor.compactTool(named));
      }
    }
    return out;
  }

  // ---- dispatcher panggilan tool -------------------------------------------
  async callTool(scope: Scope, full: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (full === this.names.status) return this.handleStatus(scope);
    if (full === this.names.search) return this.handleSearch(scope, args);
    if (full === this.names.describe) return this.handleDescribe(scope, args);
    if (full === this.names.call) {
      if (typeof args.name !== "string") return errorResult("parameter 'name' (string) wajib diisi");
      return this.callBackendTool(scope, args.name, args.arguments as Record<string, unknown> | undefined);
    }
    // Nama tanpa awalan server (mis. dari UI MCP Apps yang memanggil tool dengan nama aslinya): arahkan bila tak ambigu.
    const parts = this.split(full);
    if (parts && parts.backend in this.pool.configs) return this.callBackendTool(scope, full, args);
    const routed = await this.routeBareTool(scope, full);
    if (typeof routed !== "string") return routed;
    return this.callBackendTool(scope, routed, args);
  }

  /** Dipakai panggilan langsung dan gateway__call_tool. Hasil backend diteruskan utuh. */
  private async callBackendTool(scope: Scope, full: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    const parts = this.split(full);
    if (!parts) return errorResult(`nama tool harus berformat <server>${this.sep}<tool>: ${full}`);
    const { backend, tool } = parts;

    if (!(backend in this.pool.configs) || !inScope(scope, backend)) return errorResult(`server '${backend}' tidak ada`);
    if (!this.allowed(backend, tool)) return errorResult(`tool '${full}' tidak diizinkan`);
    const client = this.pool.clients.get(backend);
    if (!client) {
      return errorResult(
        this.pool.status(backend) === "needs_auth" ? this.authMessage(backend) : `server '${backend}' sedang tidak terhubung`,
      );
    }
    try {
      const res = (await client.callTool({ name: tool, arguments: args ?? {} }, undefined, {
        timeout: this.timeoutMs,
      })) as CallToolResult;
      // resource_link / resource tertanam ikut ditulis ulang agar bisa dibaca lewat resources/read gateway
      return Array.isArray(res.content) ? { ...res, content: res.content.map((b) => rewriteBlockUris(backend, b)) } : res;
    } catch (e) {
      if (isAuthError(e) && this.pool.providers.has(backend)) {
        this.pool.markNeedsAuth(backend);
        return errorResult(this.authMessage(backend));
      }
      return errorResult((e as Error)?.message ?? String(e));
    }
  }

  // ---- prompts -----------------------------------------------------------------
  async listPrompts(scope: Scope): Promise<Prompt[]> {
    const parts = await this.collect(scope, "prompts", (n) => this.pool.listPrompts(n, this.timeoutMs));
    return parts.flatMap(({ backend, items }) =>
      items
        .filter((p) => this.allowedBy(backend, "prompts", p.name))
        .map((p) => ({ ...p, name: `${backend}${this.sep}${p.name}` })),
    );
  }

  async getPrompt(scope: Scope, full: string, args?: Record<string, string>): Promise<GetPromptResult> {
    const parts = this.split(full);
    if (!parts || !(parts.backend in this.pool.configs) || !inScope(scope, parts.backend)) {
      throw new McpError(ErrorCode.InvalidParams, `prompt '${full}' tidak ditemukan`);
    }
    const { backend, tool: prompt } = parts;
    if (!this.allowedBy(backend, "prompts", prompt)) {
      throw new McpError(ErrorCode.InvalidParams, `prompt '${full}' tidak diizinkan`);
    }
    const client = this.connected(backend);
    const res = await this.guard(backend, () =>
      client.getPrompt({ name: prompt, arguments: args }, { timeout: this.timeoutMs }),
    );
    return { ...res, messages: res.messages.map((m) => ({ ...m, content: rewriteBlockUris(backend, m.content) })) };
  }

  // ---- resources ---------------------------------------------------------------
  async listResources(scope: Scope): Promise<Resource[]> {
    const parts = await this.collect(scope, "resources", (n) => this.pool.listResources(n, this.timeoutMs));
    const out: Resource[] = [];
    for (const { backend, items } of parts) {
      for (const r of items) {
        if (!this.allowedBy(backend, "resources", r.uri)) continue;
        const uri = wrapUri(backend, r.uri);
        if (uri) out.push({ ...r, uri });
        else log("WARN", `resource '${r.uri}' dari '${backend}' dilewati: bukan URI bersyarat skema`);
      }
    }
    return out;
  }

  async listResourceTemplates(scope: Scope): Promise<ResourceTemplate[]> {
    const parts = await this.collect(scope, "resources", (n) => this.pool.listResourceTemplates(n, this.timeoutMs));
    const out: ResourceTemplate[] = [];
    for (const { backend, items } of parts) {
      for (const t of items) {
        if (!this.allowedBy(backend, "resources", t.uriTemplate)) continue;
        const uriTemplate = wrapUri(backend, t.uriTemplate);
        if (uriTemplate) out.push({ ...t, uriTemplate });
        else log("WARN", `template '${t.uriTemplate}' dari '${backend}' dilewati: tidak diawali skema konkret`);
      }
    }
    return out;
  }

  async readResource(scope: Scope, wrapped: string): Promise<ReadResourceResult> {
    const target = this.locateResource(scope, wrapped) ?? (await this.locateBareResource(scope, wrapped));
    if (!target) throw new McpError(ErrorCode.InvalidParams, `resource '${wrapped}' tidak ditemukan`);
    const { backend, uri } = target;
    if (!this.allowedBy(backend, "resources", uri)) {
      throw new McpError(ErrorCode.InvalidParams, `resource '${wrapped}' tidak diizinkan`);
    }
    const client = this.connected(backend);
    const res = await this.guard(backend, () => client.readResource({ uri }, { timeout: this.timeoutMs }));
    return { ...res, contents: res.contents.map((c) => ({ ...c, uri: wrapUri(backend, c.uri) ?? c.uri })) };
  }

  // ---- bantuan prompts/resources -------------------------------------------------
  /** Kumpulkan daftar dari backend terhubung yang mendeklarasikan kemampuannya; backend bermasalah dilewati. */
  private async collect<T>(
    scope: Scope,
    cap: "prompts" | "resources",
    fetch: (backend: string) => Promise<T[]>,
  ): Promise<{ backend: string; items: T[] }[]> {
    const names = [...this.pool.clients.keys()].filter((n) => inScope(scope, n) && this.pool.supports(n, cap));
    const results = await Promise.allSettled(names.map((n) => fetch(n)));
    const out: { backend: string; items: T[] }[] = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        if (isAuthError(r.reason)) this.pool.markNeedsAuth(names[i]);
        log("WARN", `list ${cap} '${names[i]}' gagal:`, r.reason?.message ?? r.reason);
        return;
      }
      out.push({ backend: names[i], items: r.value });
    });
    return out;
  }

  /** Cocokkan nama backend dari URI: persis, lalu hasil decode, lalu tanpa beda huruf besar/kecil. */
  private resolveBackend(name: string): string | null {
    const names = Object.keys(this.pool.configs);
    if (names.includes(name)) return name;
    let decoded = name;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      /* biarkan apa adanya */
    }
    return names.find((n) => n === decoded) ?? names.find((n) => n.toLowerCase() === decoded.toLowerCase()) ?? null;
  }

  private connected(backend: string): Client {
    const client = this.pool.clients.get(backend);
    if (client) return client;
    throw new McpError(
      ErrorCode.InternalError,
      this.pool.status(backend) === "needs_auth" ? this.authMessage(backend) : `server '${backend}' sedang tidak terhubung`,
    );
  }

  /** Jalankan panggilan ke backend; kegagalan auth diubah menjadi pesan login yang bisa ditindaklanjuti. */
  private async guard<T>(backend: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isAuthError(e) && this.pool.providers.has(backend)) {
        this.pool.markNeedsAuth(backend);
        throw new McpError(ErrorCode.InternalError, this.authMessage(backend));
      }
      throw e;
    }
  }

  // ---- completion (autocomplete argumen prompt / variabel template resource) -------
  async complete(scope: Scope, p: CompleteRequest["params"]): Promise<CompleteResult> {
    let backend: string;
    let ref: CompleteRequest["params"]["ref"];
    if (p.ref.type === "ref/prompt") {
      const parts = this.split(p.ref.name);
      if (!parts || !(parts.backend in this.pool.configs) || !inScope(scope, parts.backend)) {
        throw new McpError(ErrorCode.InvalidParams, `prompt '${p.ref.name}' tidak ditemukan`);
      }
      if (!this.allowedBy(parts.backend, "prompts", parts.tool)) {
        throw new McpError(ErrorCode.InvalidParams, `prompt '${p.ref.name}' tidak diizinkan`);
      }
      backend = parts.backend;
      ref = { type: "ref/prompt", name: parts.tool };
    } else {
      const target = this.locateResource(scope, p.ref.uri);
      if (!target) throw new McpError(ErrorCode.InvalidParams, `resource '${p.ref.uri}' tidak ditemukan`);
      if (!this.allowedBy(target.backend, "resources", target.uri)) {
        throw new McpError(ErrorCode.InvalidParams, `resource '${p.ref.uri}' tidak diizinkan`);
      }
      backend = target.backend;
      ref = { type: "ref/resource", uri: target.uri };
    }
    // Backend tanpa kemampuan completions: tidak ada saran (bukan error).
    if (!this.pool.supports(backend, "completions")) return { completion: { values: [] } };
    const client = this.connected(backend);
    const res = await this.guard(backend, () => client.complete({ ...p, ref }, { timeout: this.timeoutMs }));
    return res as CompleteResult;
  }

  // ---- MCP Apps ------------------------------------------------------------------
  /** Apakah ada backend (dalam scope) yang mengumumkan ekstensi MCP Apps. */
  supportsApps(scope: Scope): boolean {
    return [...this.pool.clients.keys()].some((n) => inScope(scope, n) && this.pool.supportsApps(n));
  }

  /**
   * UI aplikasi biasanya memanggil tool dengan nama aslinya (tanpa awalan gateway). Cari backend yang punya
   * tool bernama persis itu: satu -> nama lengkap; beberapa -> error dengan petunjuk; nol -> apa adanya.
   */
  private async routeBareTool(scope: Scope, name: string): Promise<string | CallToolResult> {
    const hits = (await this.catalog(scope)).filter((c) => c.tools.some((t) => t.name === name)).map((c) => c.backend);
    if (hits.length === 1) return `${hits[0]}${this.sep}${name}`;
    if (hits.length > 1) {
      return errorResult(`tool '${name}' ada di beberapa server (${hits.join(", ")}); gunakan <server>${this.sep}${name}`);
    }
    return name;
  }

  /** URI gateway -> (backend, URI asli), bila backend-nya ada dan berada dalam scope. */
  private locateResource(scope: Scope, wrapped: string): { backend: string; uri: string } | null {
    const u = unwrapUri(wrapped);
    const backend = u ? this.resolveBackend(u.backend) : null;
    return u && backend && inScope(scope, backend) ? { backend, uri: u.uri } : null;
  }

  /** URI asli (mis. dari UI Apps): cari backend yang mendaftarkannya persis; harus tak ambigu. */
  private async locateBareResource(scope: Scope, uri: string): Promise<{ backend: string; uri: string } | null> {
    const parts = await this.collect(scope, "resources", (n) => this.pool.listResources(n, this.timeoutMs));
    const hits = parts.filter(({ items }) => items.some((r) => r.uri === uri)).map((p) => p.backend);
    return hits.length === 1 ? { backend: hits[0], uri } : null;
  }

  // ---- meta-tool -------------------------------------------------------------
  private async handleSearch(scope: Scope, args: Record<string, unknown>): Promise<CallToolResult> {
    // "logs" -> "log": samakan bentuk jamak sederhana agar kueri alami tetap cocok
    const tokens = String(args.query ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
    const server = args.server ? String(args.server) : null;
    const limit = Math.min(Math.max(parseInt(String(args.limit)) || (tokens.length ? 10 : 50), 1), 100);

    const lazy = (await this.catalog(scope)).filter((c) => c.mode === "lazy");
    const rows: { score: number; full: string; desc?: string }[] = [];
    for (const c of lazy.filter((c) => !server || c.backend === server)) {
      for (const t of c.tools) {
        if (hasUiMeta(t)) continue; // sudah tampil langsung di tools/list
        const name = t.name.toLowerCase();
        const desc = (t.description ?? "").toLowerCase();
        const parts = name.split(/[^a-z0-9]+/);
        let score = 0;
        for (const tok of tokens) {
          if (parts.includes(tok)) score += 5;
          else if (name.includes(tok)) score += 3;
          if (desc.includes(tok)) score += 1;
        }
        if (tokens.length === 0 || score > 0) {
          rows.push({ score, full: `${c.backend}${this.sep}${t.name}`, desc: t.description });
        }
      }
    }
    rows.sort((a, b) => b.score - a.score || a.full.localeCompare(b.full));

    if (rows.length === 0) {
      const lazyNames = [...new Set(lazy.map((c) => c.backend))];
      return text(
        `Tidak ada tool yang cocok. Coba kata kunci lain, atau isi 'server' tanpa 'query' untuk melihat daftar. ` +
          `Server mode lazy: ${lazyNames.join(", ") || "(tidak ada)"}`,
      );
    }
    const max = this.compactor.maxDescription;
    const shown = rows.slice(0, limit);
    const lines = shown.map((r) => `${r.full} - ${max > 0 ? shorten(r.desc, max) : (r.desc ?? "")}`);
    const more = rows.length > shown.length ? `\n(+${rows.length - shown.length} lainnya, persempit query atau naikkan limit)` : "";
    return text(`${rows.length} tool ditemukan:\n${lines.join("\n")}${more}`);
  }

  private async handleDescribe(scope: Scope, args: Record<string, unknown>): Promise<CallToolResult> {
    const full = String(args.name ?? "");
    const notFound = () => errorResult(`tool '${full}' tidak ditemukan. Gunakan ${this.names.search} untuk mencari nama yang benar.`);
    const parts = this.split(full);
    if (!parts) return notFound();
    const { backend, tool } = parts;
    if (!(backend in this.pool.configs) || !inScope(scope, backend) || !this.allowed(backend, tool)) return notFound();
    if (!this.pool.clients.has(backend)) return errorResult(`server '${backend}' sedang tidak terhubung`);
    try {
      const t = (await this.pool.listTools(backend, this.timeoutMs)).find((x) => x.name === tool);
      if (!t) return notFound();
      return text(JSON.stringify({ name: full, description: t.description, inputSchema: t.inputSchema }, null, 2));
    } catch (e) {
      if (isAuthError(e) && this.pool.providers.has(backend)) {
        this.pool.markNeedsAuth(backend);
        return errorResult(this.authMessage(backend));
      }
      return errorResult((e as Error)?.message ?? String(e));
    }
  }

  private async handleStatus(scope: Scope): Promise<CallToolResult> {
    const cat = new Map((await this.catalog(scope)).map((c) => [c.backend, c]));
    const lines = Object.keys(this.pool.configs)
      .filter((n) => inScope(scope, n))
      .map((n) => {
        const s = this.pool.status(n);
        const c = cat.get(n);
        const url = this.pool.authUrl(n);
        const info = c ? ` (${c.mode}, ${c.tools.length} tool)` : "";
        return `${n}: ${s}${info}${url ? `\n  login: ${url}` : ""}`;
      });
    return text(lines.join("\n"));
  }
}
