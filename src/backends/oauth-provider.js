import { randomBytes } from "node:crypto";

/** Provider OAuth (gateway = OAuth client) untuk satu backend, dipakai oleh transport SDK. */
export class GatewayOAuthProvider {
  constructor({ name, auth, store, redirectUrl }) {
    this.name = name;
    this.auth = auth;
    this.store = store;
    this._redirectUrl = redirectUrl;
    this.authUrl = null; // URL login terakhir (untuk ditunjukkan ke user)
    this.authRequired = false; // true begitu SDK meminta login
    this.pendingState = null;
    this._verifier = null;
  }
  get redirectUrl() {
    return this._redirectUrl;
  }
  get clientMetadata() {
    return {
      client_name: this.auth.client_name ?? "MCP Gateway",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.auth.client_secret ? "client_secret_post" : "none",
      ...(this.auth.scope ? { scope: this.auth.scope } : {}),
    };
  }
  state() {
    this.pendingState = randomBytes(16).toString("hex");
    return this.pendingState;
  }
  clientInformation() {
    if (this.auth.client_id) {
      return { client_id: this.auth.client_id, ...(this.auth.client_secret ? { client_secret: this.auth.client_secret } : {}) };
    }
    const info = this.store.get(this.name).clientInformation;
    // redirect URL berubah (port/public_url) -> registrasi lama tidak valid, daftar ulang
    if (info?.redirect_uris && !info.redirect_uris.includes(this._redirectUrl)) return undefined;
    return info;
  }
  saveClientInformation(info) {
    this.store.update(this.name, { clientInformation: info });
  }
  tokens() {
    return this.store.get(this.name).tokens;
  }
  saveTokens(tokens) {
    this.store.update(this.name, { tokens });
  }
  redirectToAuthorization(url) {
    this.authRequired = true;
    this.authUrl = url.toString();
  }
  saveCodeVerifier(v) {
    this._verifier = v;
  }
  codeVerifier() {
    if (!this._verifier) throw new Error("code verifier tidak ada (mulai ulang alur login)");
    return this._verifier;
  }
  invalidateCredentials(scope) {
    if (scope === "all") this.store.remove(this.name, ["tokens", "clientInformation"]);
    if (scope === "tokens") this.store.remove(this.name, ["tokens"]);
    if (scope === "client") this.store.remove(this.name, ["clientInformation"]);
    if (scope === "verifier") this._verifier = null;
  }
}
