// PLAN.md S5.3: the gateway's OAuthClientProvider, on top of the SDK's `auth()`.
//
// The instruction for S5.3 is explicit: do not hand-roll PKCE, discovery or token
// exchange if the SDK already does it. It does all three, so this file implements ONLY the
// persistence and the redirection policy, and delegates every protocol step to the SDK:
//
//   verified: node_modules/@modelcontextprotocol/client/dist/index.d.mts
//     - `auth(provider, options): Promise<AuthResult>` "Orchestrates the full auth flow with
//       a server ... instead of linking together the other lower-level functions"
//     - `discoverOAuthServerInfo(serverUrl, opts)` returns the AS URL plus metadata; used
//       here to choose the registration path BEFORE the flow starts
//     - `AuthResult = 'AUTHORIZED' | 'REDIRECT'`
//
// Registration order is fixed by the human and matches the spec's priority list
// (docs/ref/spec-2026-07-28-basic-authorization-client-registration.md lines 15-20):
//   1. static clientId from config
//   2. Client ID Metadata Document when the AS advertises
//      `client_id_metadata_document_supported`
//   3. Dynamic Client Registration when `registration_endpoint` is present, with a warning
//      because the spec marks it deprecated
//   4. otherwise a configuration error: v1 has no UI to prompt the operator

import { randomBytes } from 'node:crypto';

import {
  auth,
  discoverOAuthServerInfo,
  type AuthResult,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';

import type { Logger } from '../../observability/logger.js';
import type { TokenStore } from './token-store.js';

/** How the gateway obtained a `client_id` for this upstream. */
export type RegistrationMethod = 'static' | 'cimd' | 'dcr' | 'none';

export interface GatewayOAuthProviderOptions {
  /** The upstream name in `mcp`; part of the store key. */
  upstreamName: string;
  /** The upstream's configured URL: the RFC 8707 `resource` and the discovery input. */
  serverUrl: string;
  /** Config-provided pre-registration (PLAN.md §6 `oauth.clientId`). */
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  /** Absolute callback URL the authorization server redirects to. */
  redirectUrl: string;
  /**
   * https URL the gateway can publish its Client ID Metadata Document at, derived from
   * `gateway.publicUrl`. Undefined while Q4 is open, which disables the CIMD branch.
   */
  clientMetadataUrl?: string;
  store: TokenStore;
  logger: Logger;
  now?: () => number;
}

export class GatewayOAuthProvider implements OAuthClientProvider {
  readonly #options: GatewayOAuthProviderOptions;
  readonly #now: () => number;
  /** Set by the SDK between `saveCodeVerifier` and `codeVerifier` within one `auth()` call. */
  #codeVerifier: string | undefined;
  #stateValue: string | undefined;
  #lastTokens: StoredOAuthTokens | undefined;
  #lastIssuer: string | undefined;
  /**
   * The SDK's CIMD opt-in.
   *
   * Declared as an optional PROPERTY rather than a getter returning `string | undefined`:
   * `OAuthClientProvider.clientMetadataUrl` is `clientMetadataUrl?: string`, and under
   * `exactOptionalPropertyTypes` a getter that can return undefined does not satisfy it.
   * The field is therefore only assigned when the AS actually advertises CIMD support AND
   * the gateway has an https URL to publish.
   */
  clientMetadataUrl?: string;

  /** Set by `redirectToAuthorization`: the URL the user must be sent to. */
  authorizationUrl: URL | undefined;

  constructor(options: GatewayOAuthProviderOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  // --- OAuthClientProvider surface ---------------------------------------------

  get redirectUrl(): string {
    return this.#options.redirectUrl;
  }

  /** The upstream URL; exposed so `runAuthorization` need not reach into private state. */
  get serverUrl(): string {
    return this.#options.serverUrl;
  }

  /** The issuer resolved during the most recent `auth()` call. */
  get lastIssuer(): string | undefined {
    return this.#lastIssuer;
  }

  /** The in-flight PKCE verifier, needed when persisting the pending authorization. */
  get pendingVerifier(): string | undefined {
    return this.#codeVerifier;
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      client_name: 'mcp-gateway',
      redirect_uris: [this.#options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // The gateway is a locally-hosted web application accessed via localhost.
      // verified: docs/ref/spec-2026-07-28-basic-authorization-client-registration.md
      //   lines 167-169 — native applications, "locally-hosted web applications accessed
      //   via localhost", SHOULD use application_type "native"
      application_type: 'native',
      token_endpoint_auth_method: 'client_secret_post',
    };
    if (this.#options.scope !== undefined) metadata.scope = this.#options.scope;
    return metadata;
  }

  state(): string {
    this.#stateValue ??= randomBytes(24).toString('base64url');
    return this.#stateValue;
  }

  async clientInformation(
    ctx?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    // 1. Pre-registration from config wins over anything stored or registrable.
    if (this.#options.clientId !== undefined) {
      const info: StoredOAuthClientInformation = { client_id: this.#options.clientId };
      if (this.#options.clientSecret !== undefined) info.client_secret = this.#options.clientSecret;
      return info;
    }
    const issuer = ctx?.issuer;
    if (issuer === undefined) return undefined;
    const record = await this.#options.store.get(this.#options.upstreamName, issuer);
    if (record === undefined) return undefined;
    return {
      client_id: record.clientId,
      ...(record.clientSecret === undefined ? {} : { client_secret: record.clientSecret }),
    };
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    const issuer = ctx?.issuer;
    if (issuer === undefined) return;
    const existing = await this.#options.store.get(this.#options.upstreamName, issuer);
    await this.#options.store.set(this.#options.upstreamName, issuer, {
      clientId: clientInformation.client_id,
      ...(clientInformation.client_secret === undefined
        ? {}
        : { clientSecret: clientInformation.client_secret }),
      accessToken: existing?.accessToken ?? '',
    });
  }

  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    if (ctx?.issuer !== undefined) {
      const record = await this.#options.store.get(this.#options.upstreamName, ctx.issuer);
      return record === undefined ? undefined : toStoredTokens(record);
    }
    // The transport's per-request bearer read. The SDK docs are explicit that this must
    // return the most recent set rather than undefined.
    // verified: node_modules/@modelcontextprotocol/client/dist/index.d.mts
    //   (OAuthClientProvider.tokens — "When called with no ctx ... return the
    //    most-recently-saved token set; do not return undefined for ctx === undefined")
    return this.#lastTokens;
  }

  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    this.#lastTokens = tokens;
    const issuer = ctx?.issuer ?? this.#lastIssuer;
    if (issuer === undefined) return;
    const info = await this.clientInformation({ issuer });
    await this.#options.store.set(this.#options.upstreamName, issuer, {
      clientId: info?.client_id ?? '',
      ...(info?.client_secret === undefined ? {} : { clientSecret: info.client_secret }),
      accessToken: tokens.access_token,
      ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
      ...(tokens.token_type === undefined ? {} : { tokenType: tokens.token_type }),
      ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
      ...(tokens.expires_in === undefined
        ? {}
        : { expiresAt: this.#now() + tokens.expires_in * 1000 }),
    });
  }

  /** The gateway has no browser: capture the URL so the HTTP route can redirect to it. */
  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this.#codeVerifier === undefined) {
      throw new Error('no PKCE code verifier was saved for this authorization attempt');
    }
    return this.#codeVerifier;
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'verifier' || scope === 'discovery') {
      this.#codeVerifier = undefined;
      return;
    }
    this.#lastTokens = undefined;
    const issuer = this.#lastIssuer;
    if (issuer === undefined) return;
    const record = await this.#options.store.get(this.#options.upstreamName, issuer);
    if (record === undefined) return;
    if (scope === 'client') {
      // Only the client credential is invalid. Replacing the whole record here would
      // silently drop a still-valid access token and force the user to re-consent for
      // something the server only rejected the client identity for.
      await this.#options.store.set(this.#options.upstreamName, issuer, { ...record, clientId: '' });
      return;
    }
    // 'tokens' and 'all': the credential is unusable. Drop the whole record rather than
    // leaving a client_id that would be reused against a different issuer.
    await this.#options.store.delete(this.#options.upstreamName, issuer);
  }

  /**
   * Seeds the in-memory token set from the store, so the SDK's `auth()` takes its refresh
   * branch instead of starting a new authorization.
   *
   * verified: node_modules/@modelcontextprotocol/client/dist/index.d.mts (auth) — with no
   *   authorizationCode, `auth` "runs discovery and either refreshes or initiates
   *   redirect", so a prior token set must be visible through `tokens()`.
   */
  restoreTokens(record: {
    accessToken: string;
    refreshToken?: string;
    tokenType?: string;
    scope?: string;
    expiresAt?: number;
  }): void {
    this.#lastTokens = {
      access_token: record.accessToken,
      token_type: record.tokenType ?? 'Bearer',
      ...(record.refreshToken === undefined ? {} : { refresh_token: record.refreshToken }),
      ...(record.scope === undefined ? {} : { scope: record.scope }),
      ...(record.expiresAt === undefined
        ? {}
        : { expires_in: Math.max(0, Math.round((record.expiresAt - Date.now()) / 1000)) }),
    };
  }

  /** Records the resolved issuer before the flow runs. */
  setIssuer(issuer: string | undefined): void {
    this.#lastIssuer = issuer;
  }

  /** Whether the config supplied `oauth.clientId`, i.e. pre-registration. */
  get hasPreRegisteredClientId(): boolean {
    return this.#options.clientId !== undefined;
  }

  /** The https URL the gateway would publish its client metadata document at. */
  get resolvableClientMetadataUrl(): string | undefined {
    return this.#options.clientMetadataUrl;
  }

  /** Clears the CIMD opt-in; used when the branch is declined. */
  clearClientMetadataUrl(): void {
    delete this.clientMetadataUrl;
  }
}

export interface AuthorizationOutcome {
  result: AuthResult;
  method: RegistrationMethod;
  issuer: string;
  /** Present when `result === 'REDIRECT'`: where the user must go. */
  authorizationUrl: URL | undefined;
}

/**
 * Runs discovery, picks the registration method, then delegates the whole flow to the SDK.
 */
export async function runAuthorization(
  provider: GatewayOAuthProvider,
  options: { authorizationCode?: string; iss?: string; scope?: string } = {},
  log?: Logger,
): Promise<AuthorizationOutcome> {
  // Step 1: discovery, before any registration decision.
  // verified: node_modules/@modelcontextprotocol/client/dist/index.d.mts
  //   (discoverOAuthServerInfo(serverUrl, opts))
  const info = await discoverOAuthServerInfo(provider.serverUrl);
  const metadata = info.authorizationServerMetadata as Record<string, unknown>;
  const issuer =
    typeof metadata['issuer'] === 'string' ? metadata['issuer'] : info.authorizationServerUrl;
  provider.setIssuer(issuer);

  // Step 2: the fixed registration order.
  const method = chooseRegistrationMethod(provider, metadata, log);

  // Step 3: the SDK performs discovery, PKCE, `iss` validation and the exchange.
  // verified: node_modules/@modelcontextprotocol/client/dist/index.d.mts (auth)
  const result = await auth(provider, {
    serverUrl: provider.serverUrl,
    ...(options.authorizationCode === undefined ? {} : { authorizationCode: options.authorizationCode }),
    ...(options.iss === undefined ? {} : { iss: options.iss }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  });

  return { result, method, issuer, authorizationUrl: provider.authorizationUrl };
}

function chooseRegistrationMethod(
  provider: GatewayOAuthProvider,
  metadata: Record<string, unknown>,
  log?: Logger,
): RegistrationMethod {
  // 1. Pre-registered client information, when the config provides it.
  if (provider.hasPreRegisteredClientId) return 'static';

  // 2. Client ID Metadata Document, only when the AS advertises support for it.
  //    The document itself must be an https URL the gateway hosts, which needs
  //    `gateway.publicUrl`; without it the branch is reported rather than attempted
  //    (docs/ref/oauth-flow.md § 3.1, docs/OPEN-QUESTIONS.md Q-CIMD).
  if (metadata['client_id_metadata_document_supported'] === true) {
    const cimdUrl = provider.resolvableClientMetadataUrl;
    if (cimdUrl !== undefined) provider.clientMetadataUrl = cimdUrl;
    if (cimdUrl === undefined) {
      log?.warn(
        'authorization server supports Client ID Metadata Documents but gateway.publicUrl is unset, so no https client metadata URL can be published; falling back',
      );
    } else {
      return 'cimd';
    }
  }

  // 3. Dynamic Client Registration, deprecated but still needed for ASes without CIMD.
  //    verified: docs/ref/spec-2026-07-28-basic-authorization-client-registration.md
  //      lines 142-147 — "Dynamic Client Registration is deprecated ... retained for
  //      backwards compatibility".
  if (typeof metadata['registration_endpoint'] === 'string') {
    log?.warn(
      'using deprecated Dynamic Client Registration; this authorization server does not support Client ID Metadata Documents',
    );
    return 'dcr';
  }

  return 'none';
}

function toStoredTokens(record: {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  expiresAt?: number;
}): StoredOAuthTokens {
  // verified: node_modules/@modelcontextprotocol/client/dist/index.d.mts
  //   (StoredOAuthTokens requires access_token and token_type)
  const tokens: StoredOAuthTokens = {
    access_token: record.accessToken,
    token_type: record.tokenType ?? 'Bearer',
  };
  if (record.refreshToken !== undefined) tokens.refresh_token = record.refreshToken;
  if (record.scope !== undefined) tokens.scope = record.scope;
  if (record.expiresAt !== undefined) {
    tokens.expires_in = Math.max(0, Math.round((record.expiresAt - Date.now()) / 1000));
  }
  return tokens;
}