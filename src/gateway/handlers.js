import { inScope } from "./catalog.js";
import { shorten } from "./compact.js";
import { errorResult, isAuthError, text } from "./results.js";

/**
 * Handler untuk semua panggilan tool yang masuk ke gateway.
 * `scope` = Set nama backend (profil) atau null untuk semua.
 */
export function createHandlers(ctx, { allowed, catalog, authMessage }) {
  const { pool, sep, timeoutMs, searchDesc, NAME } = ctx;

  /** Eksekusi tool backend (dipakai panggilan langsung & gateway__call_tool). */
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

  return { callBackendTool, handleSearch, handleDescribe, handleStatus };
}
