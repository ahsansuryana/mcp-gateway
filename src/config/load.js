import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { log } from "../utils/logger.js";

export function expandEnv(v) {
  if (typeof v === "string") return v.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? "");
  if (Array.isArray(v)) return v.map(expandEnv);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandEnv(x)]));
  return v;
}

export function loadConfig(path) {
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
