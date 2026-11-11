import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { BackendAuthConfig } from "../config/types.js";
import type { TokenStore } from "./token-store.js";

export interface OAuthProviderOptions {
  name: string;
  auth: BackendAuthConfig;
  store: TokenStore;
  redirectUrl: string;
}

/** Provider OAuth untuk SDK: gateway sebagai OAuth client ke satu backend. */
export class GatewayOAuthProvider implements OAuthClientProvider {
  readonly name: string;
  private readonly auth: BackendAuthConfig;
  private readonly store: TokenStore;
  private readonly _redirectUrl: string;
  private _verifier: string | null = null;

  /** URL login terakhir (untuk ditunjukkan ke user). */
  authUrl: string | null = null;
  /** true begitu SDK meminta login. */
  authRequired = false;
  pendingState: string | null = null;

  constructor({ name, auth, store, redirectUrl }: OAuthProviderOptions) {
    this.name = name;
    this.auth = auth;
    this.store = store;
    this._redirectUrl = redirectUrl;
  }

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.auth.client_name ?? "MCP Gateway",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.auth.client_secret ? "client_secret_post" : "none",
      ...(this.auth.scope ? { scope: this.auth.scope } : {}),
    };
  }

  state(): string {
    this.pendingState = randomBytes(16).toString("hex");
    return this.pendingState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.auth.client_id) {
      return {
        client_id: this.auth.client_id,
        ...(this.auth.client_secret ? { client_secret: this.auth.client_secret } : {}),
      };
    }
    const info = this.store.get(this.name).clientInformation as
      | (OAuthClientInformationMixed & { redirect_uris?: string[] })
      | undefined;
    // redirect URL berubah (port/public_url) -> registrasi lama tidak valid, daftar ulang
    if (info?.redirect_uris && !info.redirect_uris.includes(this._redirectUrl)) return undefined;
    return info;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.store.update(this.name, { clientInformation: info });
  }

  tokens(): OAuthTokens | undefined {
    return this.store.get(this.name).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.update(this.name, { tokens });
  }

  redirectToAuthorization(url: URL): void {
    this.authRequired = true;
    this.authUrl = url.toString();
  }

  saveCodeVerifier(v: string): void {
    this._verifier = v;
  }

  codeVerifier(): string {
    if (!this._verifier) throw new Error("code verifier tidak ada (mulai ulang alur login)");
    return this._verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): void {
    if (scope === "all") this.store.remove(this.name, ["tokens", "clientInformation"]);
    if (scope === "tokens") this.store.remove(this.name, ["tokens"]);
    if (scope === "client") this.store.remove(this.name, ["clientInformation"]);
    if (scope === "verifier") this._verifier = null;
  }
}
