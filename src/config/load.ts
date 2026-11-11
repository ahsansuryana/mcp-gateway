import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { log } from "../utils/logger.js";
import type { GatewayConfig } from "./types.js";

export class ConfigError extends Error {}

/** Ganti `${NAMA}` dengan nilai environment variable (kosong bila tidak ada), rekursif. */
export function expandEnv<T>(v: T): T {
  if (typeof v === "string") return v.replace(/\$\{(\w+)\}/g, (_, k: string) => process.env[k] ?? "") as T;
  if (Array.isArray(v)) return v.map(expandEnv) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandEnv(x)])) as T;
  }
  return v;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function loadConfig(path: string): GatewayConfig {
  let cfg: any;
  try {
    cfg = expandEnv(JSON.parse(readFileSync(path, "utf-8")));
  } catch (e) {
    throw new ConfigError(`Gagal membaca ${path}: ${(e as Error).message}`);
  }

  cfg.server ??= {};
  cfg.separator ??= "__";
  cfg.servers ??= {};
  cfg.profiles ??= {};

  for (const [n, c] of Object.entries<any>(cfg.servers)) {
    if (c.expose !== undefined && !["full", "lazy", "auto"].includes(c.expose)) {
      throw new ConfigError(`servers.${n}.expose harus "full", "lazy", atau "auto" (bukan ${JSON.stringify(c.expose)})`);
    }
  }

  for (const [p, list] of Object.entries<any>(cfg.profiles)) {
    if (!/^[\w.-]+$/.test(p) || !Array.isArray(list)) {
      throw new ConfigError(`profiles.${p}: nama harus [A-Za-z0-9_.-] dan isinya array nama server`);
    }
    for (const n of list) {
      if (!(n in cfg.servers)) log("WARN", `profil '${p}' menyebut server '${n}' yang tidak ada di "servers"`);
    }
  }

  const baseDir = dirname(resolve(path));
  cfg.server.token_store = resolve(baseDir, cfg.server.token_store ?? "tokens.json");

  const o = cfg.server.oauth;
  if (o && o.enabled !== false) {
    o.password ||= cfg.server.auth_token;
    if (!o.password) {
      throw new ConfigError("server.oauth aktif tetapi tidak ada password: isi server.oauth.password (atau server.auth_token)");
    }
    o.store = resolve(baseDir, o.store ?? "oauth-server.json");
  } else {
    cfg.server.oauth = null;
  }

  return cfg as GatewayConfig;
}
