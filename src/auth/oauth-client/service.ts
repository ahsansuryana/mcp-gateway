// PLAN.md S5.4: the two HTTP-facing OAuth operations, plus the `auth_required` state.
//
// Routes (PLAN.md S5.4):
//   GET /admin/oauth/:name/start  -> redirect to the authorization URL
//   GET /oauth/callback           -> code exchange
// Both sit behind the gateway's own bearer key.
//
// No protocol logic lives here: discovery, PKCE, RFC 9207 `iss` validation and the token
// exchange are all delegated to the SDK through `runAuthorization`.

import type { Logger } from '../../observability/logger.js';
import type { GatewayConfig, RemoteUpstreamConfig } from '../../config/schema.js';
import { GatewayOAuthProvider, runAuthorization, type RegistrationMethod } from './provider.js';
import type { TokenStore } from './token-store.js';

/** The path the authorization server redirects back to. */
export const CALLBACK_PATH = '/oauth/callback';

export interface OAuthServiceOptions {
  config: GatewayConfig;
  store: TokenStore;
  logger: Logger;
  /**
   * Port the gateway listens on, used to build the localhost callback URL. A FUNCTION
   * because the HTTP app is built before `listen()` has assigned an ephemeral port.
   */
  port: number | (() => number);
  now?: () => number;
}

export interface StartResult {
  /** Present when the user must consent: where to send the browser. */
  url: string | undefined;
  method: RegistrationMethod;
  /** Set when no interactive step is needed because a usable token already existed. */
  authorized: boolean;
}

export class OAuthService {
  readonly #options: OAuthServiceOptions;
  readonly #providers = new Map<string, GatewayOAuthProvider>();

  constructor(options: OAuthServiceOptions) {
    this.#options = options;
  }

  /** The absolute callback URL for this deployment. Q4 is open, so it is localhost. */
  get callbackUrl(): string {
    const host = this.#options.config.gateway.host;
    // `0.0.0.0` is a bind address, not a name the browser can reach back to.
    const hostname = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    const port = typeof this.#options.port === 'function' ? this.#options.port() : this.#options.port;
    return `http://${hostname}:${port}${CALLBACK_PATH}`;
  }

  /**
   * The https URL a Client ID Metadata Document would be published at.
   *
   * `undefined` while Q4 is open, which is what disables the CIMD branch
   * (docs/ref/oauth-flow.md § 3.1, docs/OPEN-QUESTIONS.md Q-CIMD).
   */
  get clientMetadataUrl(): string | undefined {
    const publicUrl = this.#options.config.gateway.publicUrl;
    if (publicUrl === undefined) return undefined;
    // verified: docs/ref/spec-2026-07-28-basic-authorization-client-registration.md
    //   line 41 — the client_id URL MUST use https and contain a path component.
    return new URL('/.well-known/oauth-client.json', publicUrl).href;
  }

  /** The upstream names that have `oauth` configured and are not explicitly disabled. */
  oauthUpstreams(): string[] {
    return Object.entries(this.#options.config.mcp)
      .filter(([, upstream]) => upstream.type === 'remote' && upstream.oauth !== undefined && upstream.oauth !== false)
      .map(([name]) => name);
  }

  isOAuthUpstream(name: string): boolean {
    return this.oauthUpstreams().includes(name);
  }

  /** The provider for one upstream, created once so in-flight state survives across calls. */
  providerFor(name: string): GatewayOAuthProvider | undefined {
    const existing = this.#providers.get(name);
    if (existing !== undefined) return existing;

    const upstream = this.#options.config.mcp[name];
    if (upstream === undefined || upstream.type !== 'remote' || upstream.oauth === undefined || upstream.oauth === false) {
      return undefined;
    }
    const oauth: RemoteUpstreamConfig['oauth'] = upstream.oauth;
    const provider = new GatewayOAuthProvider({
      upstreamName: name,
      serverUrl: upstream.url,
      redirectUrl: this.callbackUrl,
      ...(this.clientMetadataUrl === undefined ? {} : { clientMetadataUrl: this.clientMetadataUrl }),
      store: this.#options.store,
      logger: this.#options.logger,
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      ...(typeof oauth === 'object' && oauth.clientId !== undefined ? { clientId: oauth.clientId } : {}),
      ...(typeof oauth === 'object' && oauth.clientSecret !== undefined ? { clientSecret: oauth.clientSecret } : {}),
      ...(typeof oauth === 'object' && oauth.scope !== undefined ? { scope: oauth.scope } : {}),
    });
    this.#providers.set(name, provider);
    return provider;
  }

  /** Whether a stored, unexpired access token exists for this upstream. */
  async hasUsableToken(name: string, issuer?: string): Promise<boolean> {
    if (issuer === undefined) return false;
    const record = await this.#options.store.get(name, issuer);
    if (record === undefined) return false;
    if (record.expiresAt === undefined) return true;
    return record.expiresAt > (this.#options.now ?? Date.now)();
  }

  /**
   * `GET /admin/oauth/:name/start`.
   *
   * Returns the URL the route should redirect to, or `authorized: true` when a usable
   * token already existed and no consent is needed.
   */
  async start(name: string): Promise<StartResult> {
    const provider = this.providerFor(name);
    if (provider === undefined) {
      throw new OAuthServiceError(`upstream '${name}' has no oauth configuration`);
    }

    const outcome = await runAuthorization(provider, {}, this.#options.logger);

    if (outcome.result === 'AUTHORIZED') {
      return { url: undefined, method: outcome.method, authorized: true };
    }
    if (outcome.authorizationUrl === undefined) {
      throw new OAuthServiceError(`no authorization URL was produced for upstream '${name}'`);
    }

    // Persist the in-flight PKCE verifier, the state and the recorded issuer together, so
    // the callback can validate `iss` against an issuer captured BEFORE the redirect.
    // verified: docs/ref/spec-2026-07-28-basic-authorization-index.md line 194 — the issuer
    //   MUST be recorded and associated with the same per-request record as the PKCE code
    //   verifier and the state value.
    await this.#options.store.savePending(name, {
      codeVerifier: provider.pendingVerifier ?? '',
      state: provider.state(),
      issuer: outcome.issuer,
      createdAt: (this.#options.now ?? Date.now)(),
    });

    this.#options.logger.info(
      { upstream: name, method: outcome.method, issuer: outcome.issuer },
      'upstream authorization started; redirecting the operator to the authorization server',
    );

    return { url: outcome.authorizationUrl.href, method: outcome.method, authorized: false };
  }

  /**
   * `GET /oauth/callback`.
   *
   * The `state` is looked up in the encrypted pending store and consumed, so a replayed
   * callback finds nothing.
   */
  async callback(params: { code?: string; state?: string; iss?: string; error?: string; errorDescription?: string }): Promise<{ upstreamName: string; method: RegistrationMethod }> {
    const stateValue = params.state;
    if (stateValue === undefined || stateValue.length === 0) {
      throw new OAuthServiceError('the callback is missing the state parameter');
    }

    const found = await this.#options.store.takePendingByState(stateValue);
    if (found === undefined) {
      throw new OAuthServiceError('no pending authorization matches this state value');
    }

    const provider = this.providerFor(found.upstreamName);
    if (provider === undefined) {
      throw new OAuthServiceError(`upstream '${found.upstreamName}' has no oauth configuration`);
    }

    // The SDK's `auth` performs the RFC 9207 §2.4 comparison against the issuer it records
    // for this flow. We also compare here so the recorded value is used even if the SDK's
    // ordering changes, and so a mismatch is reported without acting on the error params.
    // verified: docs/ref/spec-2026-07-28-basic-authorization-index.md lines 198-215
    if (params.iss !== undefined && params.iss !== found.pending.issuer) {
      // Simple string comparison; no scheme/host case folding, no trailing-slash elision.
      // verified: same page, line 213 and RFC 3986 §6.2.1
      throw new OAuthServiceError('authorization response issuer does not match the recorded issuer');
    }

    if (params.error !== undefined) {
      // MUST NOT act on or display error/error_description when `iss` is absent and the AS
      // advertised support: we cannot prove which AS answered.
      // verified: docs/ref/spec-2026-07-28-basic-authorization-index.md line 215
      throw new OAuthServiceError(`the authorization server returned an error (${params.error})`);
    }
    if (params.code === undefined) {
      throw new OAuthServiceError('the callback is missing the code parameter');
    }

    provider.saveCodeVerifier(found.pending.codeVerifier);
    provider.setIssuer(found.pending.issuer);

    const outcome = await runAuthorization(
      provider,
      { authorizationCode: params.code, ...(params.iss === undefined ? {} : { iss: params.iss }) },
      this.#options.logger,
    );

    this.#options.logger.info(
      { upstream: found.upstreamName, method: outcome.method, result: outcome.result },
      'upstream authorization completed',
    );
    return { upstreamName: found.upstreamName, method: outcome.method };
  }

  /**
   * The URL `/status` shows for an `auth_required` upstream.
   *
   * Deliberately a relative link built from the LOCAL gateway, not a public hostname:
   * Q4 is open and no hostname may be invented.
   */
  startUrlFor(name: string): string {
    return `/admin/oauth/${encodeURIComponent(name)}/start`;
  }
}

/** An OAuth error safe to show an operator: never carries a token, code or client secret. */
export class OAuthServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthServiceError';
  }
}