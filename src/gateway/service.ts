import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BackendPool } from "../backend/pool.js";
import type { ExposeMode, GatewayConfig } from "../config/types.js";
import { globMatch } from "../utils/glob.js";
import { log } from "../utils/logger.js";
import { createCompactor, shorten, type Compactor } from "./compact.js";
import { buildMetaTools, buildStatusTool, buildToolNames, type ToolNames } from "./tools.js";

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
    const c = this.pool.configs[name];
    if (c.allow_tools?.length && !c.allow_tools.some((p) => globMatch(p, tool))) return false;
    return !(c.deny_tools ?? []).some((p) => globMatch(p, tool));
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
      if (c.mode !== "full") continue;
      for (const t of c.tools) out.push(this.compactor.compactTool({ ...t, name: `${c.backend}${this.sep}${t.name}` }));
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
    return this.callBackendTool(scope, full, args);
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
      return (await client.callTool({ name: tool, arguments: args ?? {} }, undefined, {
        timeout: this.timeoutMs,
      })) as CallToolResult;
    } catch (e) {
      if (isAuthError(e) && this.pool.providers.has(backend)) {
        this.pool.markNeedsAuth(backend);
        return errorResult(this.authMessage(backend));
      }
      return errorResult((e as Error)?.message ?? String(e));
    }
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
