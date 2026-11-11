import { BackendPool } from "./backends/pool.js";
import { TokenStore } from "./backends/token-store.js";
import { loadConfig } from "./config/load.js";
import { resolveRuntime } from "./config/runtime.js";
import { buildHttpServer } from "./http/server.js";
import { OAuthServer } from "./oauth-server/oauth-server.js";
import { log } from "./utils/logger.js";

/** Merakit config, pool backend, OAuth server, dan HTTP server. Belum listen sampai start(). */
export function createApp(configPath) {
  const cfg = loadConfig(configPath);
  const { host, port, publicUrl, redirectUrl, bases } = resolveRuntime(cfg);

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

  const http = buildHttpServer(cfg, pool, oauth, publicUrl, bases);

  return {
    cfg,
    http,
    pool,
    start() {
      pool.start();
      http.listen(port, host, () => {
        log("INFO", `gateway di http://${host}:${port}/mcp`);
        for (const p of Object.keys(cfg.profiles)) log("INFO", `profil: http://${host}:${port}/mcp/${p} -> ${cfg.profiles[p].join(", ")}`);
        if (oauth) log("INFO", `OAuth gateway aktif. Issuer diterima untuk: ${bases.join(", ")}`);
        if (Object.values(cfg.servers).some((s) => s.auth?.type === "oauth" && s.enabled !== false)) {
          log("INFO", `OAuth redirect URI: ${redirectUrl}  (token disimpan di ${cfg.server.token_store})`);
        }
      });
    },
    async stop() {
      http.close();
      await pool.stop();
    },
  };
}
