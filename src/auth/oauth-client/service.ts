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
import { refreshAuthorization } from '@modelcontextprotocol/client';

import type { GatewayConfig, RemoteUpstreamConfig } from '../../config/schema.js';
import { GatewayOAuthProvider, runAuthorization, type RegistrationMethod } from './provider.js';
import type { TokenStore } from './token-store.js';

/** The path the authorization server redirects back to. */
export const CALLBACK_PATH = '/oauth/callback';

/**
 * PLAN.md S5.5: refresh this many milliseconds BEFORE the token actually expires.
 *
 * A refresh attempted at the expiry instant races the request it is meant to protect: the
 * clock, the network and the AS disagree by enough to land on the wrong side. 60s is the
 * figure PLAN.md specifies.
 */
export const REFRESH_SKEW_MS = 60_000;

/** Below this remaining lifetime the token is refreshed rather than reused. */
export function needsRefresh(expiresAt: number | undefined, now: number): boolean {
  if (expiresAt === undefined) return false;
  return expiresAt - REFRESH_SKEW_MS <= now;
}

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
   * PLAN.md S5.5: refreshes the stored access token when it is within the skew window.
   *
   * Returns true when a NEW token was obtained. Returns false — without throwing — when
   * there is nothing to do or when the refresh failed: the caller moves the upstream to
   * `auth_required`, which is the state the spec's error table already gives to "token
   * invalid".
   *
   * verified: docs/ref/spec-2026-07-28-basic-authorization-index.md lines 323 — 401 means
   *   "Authorization required or token invalid".
   */
  async refreshIfNeeded(name: string, issuer?: string): Promise<boolean> {
    const provider = this.providerFor(name);
    if (provider === undefined || issuer === undefined) return false;

    const record = await this.#options.store.get(name, issuer);
    const info = await this.clientInformationFor(name, issuer);
    // MUST NOT assume refresh tokens will be issued.
    // verified: docs/ref/spec-2026-07-28-basic-authorization-index.md line 311
    if (record === undefined || record.refreshToken === undefined) return false;

    const now = (this.#options.now ?? Date.now)();
    if (!needsRefresh(record.expiresAt, now)) return false;

    provider.setIssuer(issuer);

    try {
      // The SDK's `refreshAuthorization()` is used directly rather than `auth()`.
      //
      // `auth()` decides between refresh and a fresh authorization using its OWN expiry
      // check. A token inside the gateway's 60s skew still looks valid to the SDK, so it
      // either refreshes too late or returns 'REDIRECT' and demands a new consent — which
      // defeats the point of refreshing. Verified against the S5.6 fake: a token with 5s
      // remaining made `auth()` return 'REDIRECT'.
      //
      // verified: node_modules/@modelcontextprotocol/client/dist/index.d.mts
      //   (refreshAuthorization — "Exchange a refresh token for an updated access token",
      //    preserving the original refresh token when a new one is not returned)
      const refreshed = await refreshAuthorization(issuer, {
        clientInformation: info ?? { client_id: '' },
        refreshToken: record.refreshToken,
        ...(this.resourceFor(name) === undefined ? {} : { resource: this.resourceFor(name)! }),
      });

      await provider.saveTokens(
        {
          access_token: refreshed.access_token,
          token_type: refreshed.token_type,
          ...(refreshed.refresh_token === undefined ? {} : { refresh_token: refreshed.refresh_token }),
          ...(refreshed.scope === undefined ? {} : { scope: refreshed.scope }),
          ...(refreshed.expires_in === undefined
            ? {}
            : { expires_in: refreshed.expires_in }),
        },
        { issuer },
      );
      return true;
    } catch (err) {
      // The failure reason is safe to log: SDK OAuth errors name the endpoint and the
      // OAuth error code, never the token. The token itself is never interpolated.
      this.#options.logger.warn(
        {
          upstream: name,
          reason: err instanceof Error ? err.message : String(err),
        },
        'refresh failed; upstream needs authorization again',
      );
      await this.#options.store.delete(name, issuer);
      return false;
    }
  }

  /** The upstream's configured URL, which is also the RFC 8707 `resource`. */
  /** Public: used by `refreshIfNeeded` and testable on its own. */
  resourceFor(name: string): string | undefined {
    const upstream = this.#options.config.mcp[name];
    return upstream?.type === 'remote' ? upstream.url : undefined;
  }

  private async clientInformationFor(name: string, issuer: string) {
    const upstream = this.#options.config.mcp[name];
    if (upstream?.type === 'remote' && typeof upstream.oauth === 'object' && upstream.oauth.clientId !== undefined) {
      return { client_id: upstream.oauth.clientId, ...(upstream.oauth.clientSecret === undefined ? {} : { client_secret: upstream.oauth.clientSecret }) };
    }
    const record = await this.#options.store.get(name, issuer);
    if (record === undefined || record.clientId === '') return undefined;
    return { client_id: record.clientId, ...(record.clientSecret === undefined ? {} : { client_secret: record.clientSecret }) };
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