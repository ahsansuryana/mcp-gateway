import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rand, safeEq, sha256base64url, sha256hex } from "../utils/crypto.js";
import { log } from "../utils/logger.js";
import { redirectWith, validRedirect } from "./redirect.js";

/**
 * OAuth 2.1 authorization server milik gateway (arah: agen -> gateway).
 * Discovery (RFC 9728 + 8414), Dynamic Client Registration (RFC 7591),
 * Authorization Code + PKCE S256, refresh token berputar, revoke (RFC 7009).
 * Login pemilik: satu password (server.oauth.password).
 */

type AuthMethod = "none" | "client_secret_post" | "client_secret_basic";
const AUTH_METHODS: AuthMethod[] = ["none", "client_secret_post", "client_secret_basic"];

interface ClientRecord {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: AuthMethod;
  secret_hash?: string;
}
interface TokenRecord {
  client_id: string;
  exp: number;
}
interface Stored {
  clients: Record<string, ClientRecord>;
  access: Record<string, TokenRecord>;
  refresh: Record<string, TokenRecord>;
}
interface AuthTxn {
  client_id: string;
  redirect_uri: string;
  state?: string;
  challenge: string;
  resource?: string;
  exp: number;
}
interface AuthCode extends AuthTxn {}

export interface OAuthServerOptions {
  issuer: string;
  password: string;
  storePath: string;
  accessTtl: number;
  refreshTtl: number;
}

/** Info yang dibutuhkan halaman login. */
export interface LoginInfo {
  txn: string;
  client: ClientRecord;
  redirectHost: string;
}

export type AuthorizeStart = { fatal: string } | { redirect: string } | LoginInfo;
export type ApproveResult =
  | { kind: "ok"; location: string }
  | { kind: "expired" | "locked" | "wrong" };
export type TokenParams = Record<string, string | undefined>;
export type TokenResult = { status: number; body: Record<string, unknown> };

const hostOf = (u: string): string => new URL(u).host || new URL(u).protocol;

export class OAuthServer {
  private readonly issuer: string;
  private readonly password: string;
  private readonly path: string;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private data: Stored = { clients: {}, access: {}, refresh: {} };
  private readonly codes = new Map<string, AuthCode>(); // hash(code) -> data (memori, 5 menit)
  private readonly txns = new Map<string, AuthTxn>(); //   id login -> data (memori, 10 menit)
  private readonly fails = new Map<string, { n: number; until: number }>(); // ip -> percobaan salah

  constructor({ issuer, password, storePath, accessTtl, refreshTtl }: OAuthServerOptions) {
    this.issuer = issuer;
    this.password = password;
    this.path = storePath;
    this.accessTtl = accessTtl;
    this.refreshTtl = refreshTtl;
    if (existsSync(storePath)) {
      try {
        Object.assign(this.data, JSON.parse(readFileSync(storePath, "utf-8")));
      } catch {
        log("WARN", `oauth store ${storePath} rusak, mulai dari kosong`);
      }
    }
    this.data.clients ??= {};
    this.data.access ??= {};
    this.data.refresh ??= {};
    this.prune();
  }

  private flush(): void {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  private prune(): void {
    const now = Date.now();
    for (const k of ["access", "refresh"] as const) {
      for (const [h, v] of Object.entries(this.data[k])) if (v.exp <= now) delete this.data[k][h];
    }
    for (const m of [this.codes, this.txns] as Map<string, { exp: number }>[]) {
      for (const [k, v] of m) if (v.exp <= now) m.delete(k);
    }
    for (const [k, v] of this.fails) if ((v.until ?? 0) <= now && v.n === 0) this.fails.delete(k);
  }

  authServerMetadata(i: string = this.issuer): Record<string, unknown> {
    return {
      issuer: i,
      authorization_endpoint: `${i}/authorize`,
      token_endpoint: `${i}/token`,
      registration_endpoint: `${i}/register`,
      revocation_endpoint: `${i}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: AUTH_METHODS,
      scopes_supported: ["mcp"],
    };
  }

  // ---- Dynamic Client Registration (RFC 7591) ------------------------------
  register(body: any): { ok: Record<string, unknown> } | { error: string; error_description: string } {
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && validRedirect(u))) {
      return { error: "invalid_redirect_uri", error_description: "redirect_uris wajib (1-10 URI; https, atau http://localhost)" };
    }
    const method: AuthMethod = body.token_endpoint_auth_method ?? "none";
    if (!AUTH_METHODS.includes(method)) {
      return { error: "invalid_client_metadata", error_description: "token_endpoint_auth_method tidak didukung" };
    }
    const client: ClientRecord = {
      client_id: rand(16),
      client_name: String(body.client_name ?? "").slice(0, 100) || "MCP client",
      redirect_uris: uris,
      token_endpoint_auth_method: method,
    };
    const issuedAt = Math.floor(Date.now() / 1000);
    let secret: string | undefined;
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

  // ---- /authorize -----------------------------------------------------------
  /** Validasi request /authorize. `fatal` = jangan redirect (client/redirect_uri tidak tepercaya). */
  beginAuthorize(q: URLSearchParams): AuthorizeStart {
    const client = this.data.clients[q.get("client_id") ?? ""];
    if (!client) return { fatal: "client_id tidak dikenal. Hubungkan ulang dari agen (registrasi mungkin hilang)." };
    const given = q.get("redirect_uri");
    const ru = given ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
    if (!ru || !client.redirect_uris.includes(ru)) return { fatal: "redirect_uri tidak cocok dengan yang didaftarkan." };
    const state = q.get("state") ?? undefined;
    const fail = (error: string, desc: string) => ({ redirect: redirectWith(ru, { error, error_description: desc, state }) });
    if (q.get("response_type") !== "code") return fail("unsupported_response_type", "hanya response_type=code");
    const challenge = q.get("code_challenge");
    if (!challenge || q.get("code_challenge_method") !== "S256" || !/^[\w-]{43}$/.test(challenge)) {
      return fail("invalid_request", "PKCE dengan code_challenge_method=S256 wajib");
    }
    this.prune();
    const txn = rand();
    this.txns.set(txn, {
      client_id: client.client_id,
      redirect_uri: ru,
      state,
      challenge,
      resource: q.get("resource") ?? undefined,
      exp: Date.now() + 10 * 60e3,
    });
    return { txn, client, redirectHost: hostOf(ru) };
  }

  txnInfo(id: string | undefined): LoginInfo | null {
    const t = this.txns.get(id ?? "");
    if (!t || t.exp <= Date.now()) return null;
    const client = this.data.clients[t.client_id];
    return client ? { txn: id!, client, redirectHost: hostOf(t.redirect_uri) } : null;
  }

  approve(txnId: string | undefined, password: string | undefined, ip: string): ApproveResult {
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
    this.txns.delete(txnId!);
    const code = rand();
    this.codes.set(sha256hex(code), { ...t, exp: Date.now() + 5 * 60e3 });
    return { kind: "ok", location: redirectWith(t.redirect_uri, { code, state: t.state }) };
  }

  // ---- /token ---------------------------------------------------------------
  private issue(clientId: string): Record<string, unknown> {
    const access = rand();
    const refresh = rand();
    const now = Date.now();
    this.data.access[sha256hex(access)] = { client_id: clientId, exp: now + this.accessTtl * 1000 };
    this.data.refresh[sha256hex(refresh)] = { client_id: clientId, exp: now + this.refreshTtl * 1000 };
    this.prune();
    this.flush();
    return { access_token: access, token_type: "Bearer", expires_in: this.accessTtl, refresh_token: refresh, scope: "mcp" };
  }

  token(p: TokenParams, basic?: { id: string; secret: string }): TokenResult {
    const err = (error: string, error_description: string, status = 400): TokenResult => ({
      status,
      body: { error, error_description },
    });
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
      if (!/^[\w.~-]{43,128}$/.test(v) || !safeEq(sha256base64url(v), c.challenge)) {
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

  revoke(tok: string | undefined): void {
    const h = sha256hex(tok ?? "");
    if (this.data.access[h] || this.data.refresh[h]) {
      delete this.data.access[h];
      delete this.data.refresh[h];
      this.flush();
    }
  }

  /** Validasi access token milik gateway. */
  verify(tok: string | null | undefined): boolean {
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
