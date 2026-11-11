import { globMatch } from "../utils/glob.js";
import { log } from "../utils/logger.js";
import { isAuthError } from "./results.js";

/** scope = Set nama backend (profil) atau null untuk semua. */
export const inScope = (scope, name) => !scope || scope.has(name);

export function createCatalog({ pool, timeoutMs, lazyThreshold }) {
  /** Apakah tool lolos allow_tools / deny_tools milik backend. `tool` tanpa awalan server. */
  const allowed = (name, tool) => {
    const c = pool.configs[name];
    if (c.allow_tools?.length && !c.allow_tools.some((p) => globMatch(p, tool))) return false;
    return !(c.deny_tools ?? []).some((p) => globMatch(p, tool));
  };

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

  return { allowed, catalog, authMessage };
}
