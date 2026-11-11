import { BackendPool } from "./backend/pool.js";
import { TokenStore } from "./backend/token-store.js";
import { loadConfig } from "./config/load.js";
import { createGatewayServerFactory } from "./gateway/server.js";
import { buildHttpServer } from "./http/server.js";
import { OAuthServer } from "./oauth-server/server.js";
import { log } from "./utils/logger.js";

const norm = (u: string): string => String(u).replace(/\/+$/, "");

/** Muat config, rakit semua komponen, lalu jalankan gateway. */
export function startGateway(configPath: string): void {
  const cfg = loadConfig(configPath);

  const host = cfg.server.host ?? "0.0.0.0";
  const port = cfg.server.port ?? 8000;
  // Harus sama persis dengan redirect URI yang didaftarkan ke authorization server.
  // Jika gateway di server remote, isi server.public_url (HTTPS), mis. https://gw.example.com
  const publicUrl = norm(cfg.server.public_url ?? `http://localhost:${port}`);
  // Redirect URI untuk login ke backend OAuth (mis. Vercel). Terpisah dari public_url (issuer agen -> gateway):
  // sebagian provider hanya menyetujui redirect localhost. Default tetap <public_url>/oauth/callback.
  const redirectUrl = String(cfg.server.backend_redirect_url ?? `${publicUrl}/oauth/callback`);
  if (!/\/oauth\/callback$/.test(redirectUrl)) {
    throw new Error("server.backend_redirect_url harus berakhiran /oauth/callback (route callback gateway)");
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
  const bases = [
    ...new Set([
      publicUrl,
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      ...(cfg.server.extra_public_urls ?? []).map(norm),
    ]),
  ];

  const http = buildHttpServer({
    cfg,
    pool,
    oauth,
    createGatewayServer: createGatewayServerFactory(cfg, pool),
    publicUrl,
    bases,
  });

  pool.start();
  http.listen(port, host, () => {
    log("INFO", `gateway di http://${host}:${port}/mcp`);
    for (const [name, servers] of Object.entries(cfg.profiles)) {
      log("INFO", `profil: http://${host}:${port}/mcp/${name} -> ${servers.join(", ")}`);
    }
    if (oauth) log("INFO", `OAuth gateway aktif. Issuer diterima untuk: ${bases.join(", ")}`);
    if (Object.values(cfg.servers).some((s) => s.auth?.type === "oauth" && s.enabled !== false)) {
      log("INFO", `OAuth redirect URI: ${redirectUrl}  (token disimpan di ${cfg.server.token_store})`);
    }
  });

  const shutdown = async (): Promise<void> => {
    log("INFO", "shutdown...");
    http.close();
    await pool.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
