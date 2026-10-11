// PLAN.md S6.1: the gateway as an OAuth 2.1 RESOURCE SERVER (ADR 0005, option A).
//
// The gateway validates bearer JWTs issued by an EXTERNAL authorization server. It never
// mints a token, never runs an authorization endpoint and never stores a user.
//
// verified: docs/ref/spec-2026-07-28-basic-authorization-index.md
//   - "MCP servers, acting in their role as an OAuth 2.1 resource server, MUST validate
//      access tokens as described in OAuth 2.1 Section 5.2."
//   - "MCP servers MUST validate that access tokens were issued specifically for them as the
//      intended audience, according to RFC 8707 Section 2."
//   - "Invalid or expired tokens MUST receive a HTTP 401 response."
//
// verified: docs/ref/claude-connector-requirements.md (Anthropic's own documentation)
//   - "The `401` status is required, because Claude doesn't honor a `WWW-Authenticate` header
//      on a `200` response."
//   - "Return `401` with a `resource_metadata` pointer."
//   - "List your primary issuer first ... Claude uses the first entry and doesn't fall back."
//   - "your MCP server should accept the canonical value when checking `aud` rather than
//      doing a strict byte-for-byte comparison against what the user typed."
//
// Nothing here ever logs, returns or interpolates a token value.

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import type { JWTPayload } from 'jose';

import type { Logger } from '../../observability/logger.js';

export interface ResourceServerOptions {
  /** The external authorization server's issuer identifier. */
  issuer: string;
  /** The audience a token must carry. */
  audience: string;
  /** Explicit JWKS URI. When absent it is discovered from the issuer's metadata. */
  jwksUri?: string;
  /** Optional scope hint advertised in the `WWW-Authenticate` challenge. */
  scope?: string;
  /** Injectable for tests; defaults to `fetch`. */
  fetchFn?: typeof fetch;
  logger: Logger;
}

export type TokenRejection =
  | 'missing'
  | 'malformed'
  | 'expired'
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'unknown_key'
  | 'unsupported_algorithm';

export interface TokenResult {
  ok: boolean;
  /** Present only when `ok` is true. Never logged in full. */
  subject?: string;
  /** Present only when `ok` is false. Names the reason; never the token. */
  reason?: TokenRejection;
}

export class ResourceServer {
  readonly #options: ResourceServerOptions;
  /** Built lazily so JWKS discovery can be async and cached. */
  #jwksPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;

  constructor(options: ResourceServerOptions) {
    this.#options = options;
  }

  /**
   * Resolves the JWKS URI, then builds the remote key set.
   *
   * verified: node_modules/jose/dist/types/jwks/remote.d.ts
   *   - `createRemoteJWKSet(url, options)` — a key resolver with its own cache.
   *   - `cooldownDuration`: "Time in milliseconds after a successful fetch before a missing
   *     key can trigger another fetch … Defaults to 30000 (30 seconds)." That IS the
   *     "unknown kid refreshes at most once per cooldown" requirement, so jose's built-in
   *     handling is used instead of a hand-rolled retry.
   *   - `cacheMaxAge`: "Maximum age of cached keys in milliseconds … Defaults to 600000".
   *
   * A remote resolver is used even for a CONFIGURED `jwksUri`, so key rotation is picked up
   * without a restart.
   */
  async #jwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    this.#jwksPromise ??= (async () => {
      const uri = await this.#resolveJwksUri();
      return createRemoteJWKSet(new URL(uri), {
        timeoutDuration: 10_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
        ...(this.#options.fetchFn === undefined
          ? {}
          : { [Symbol.for('jose.fetch')]: this.#options.fetchFn }),
      });
    })();
    return this.#jwksPromise;
  }

  /** The explicit `jwksUri` wins; otherwise `jwks_uri` is read from the issuer's metadata. */
  async #resolveJwksUri(): Promise<string> {
    if (this.#options.jwksUri !== undefined) return this.#options.jwksUri;
    return discoverJwksUri({
      issuer: this.#options.issuer,
      logger: this.#options.logger,
      ...(this.#options.fetchFn === undefined ? {} : { fetchFn: this.#options.fetchFn }),
    });
  }

  get issuer(): string {
    return this.#options.issuer;
  }

  get audience(): string {
    return this.#options.audience;
  }

  /**
   * The absolute https URL of this server's RFC 9728 protected-resource metadata.
   *
   * verified: docs/ref/claude-connector-requirements.md — "The `resource_metadata` URL
   *   doesn't have to be on the MCP server's origin", and Claude probes
   *   `/.well-known/oauth-protected-resource/<mcp-path>` first.
   */
  protectedResourceMetadataUrl(publicUrl: string, mcpPath = '/mcp'): string {
    return new URL(`/.well-known/oauth-protected-resource${mcpPath}`, publicUrl).href;
  }

  /**
   * The RFC 9728 protected-resource metadata document.
   *
   * `authorization_servers` carries exactly ONE entry: Claude reads only the first and does
   * not fall back to later ones (docs/ref/claude-connector-requirements.md, "Serve discovery
   * metadata"), and the MCP spec likewise makes the client's choice of AS its own
   * responsibility (authorization-server-discovery.md lines 29-37).
   */
  protectedResourceMetadata(publicUrl: string, mcpPath = '/mcp', resourceName?: string): Record<string, unknown> {
    const resource = new URL(mcpPath, publicUrl).href;
    return {
      resource,
      authorization_servers: [this.#options.issuer],
      scopes_supported: this.#options.scope === undefined ? [] : [this.#options.scope],
      bearer_methods_supported: ['header'],
      ...(resourceName === undefined ? {} : { resource_name: resourceName }),
    };
  }

  /**
   * The `WWW-Authenticate` challenge for an unauthenticated request.
   *
   * verified: docs/ref/claude-connector-requirements.md — a 401 is mandatory and the header
   *   must point at the protected-resource metadata; `scope` steers what Claude requests.
   */
  challenge(publicUrl: string, mcpPath = '/mcp', error?: TokenRejection): string {
    const parts = [`resource_metadata="${this.protectedResourceMetadataUrl(publicUrl, mcpPath)}"`];
    if (this.#options.scope !== undefined) parts.push(`scope="${this.#options.scope}"`);
    if (error !== undefined) parts.unshift(`error="invalid_token"`, `error_description="${error}"`);
    return `Bearer ${parts.join(', ')}`;
  }

  /**
   * Verifies a bearer token: signature, then issuer, audience and expiry.
   *
   * Every rejection is a named reason, never a message from the library, so nothing about
   * the token or the key can reach a log line.
   */
  async verify(token: string | undefined): Promise<TokenResult> {
    if (token === undefined || token.length === 0) return { ok: false, reason: 'missing' };

    try {
      const { payload } = await jwtVerify(token, await this.#jwks(), {
        issuer: this.#options.issuer,
        audience: this.#options.audience,
        // Only asymmetric algorithms. `none` and HMAC are excluded by construction: a
        // symmetric key would be a shared secret, which ADR 0005 forbids on this path.
        algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'],
      });
      return payload.sub === undefined ? { ok: true } : { ok: true, subject: payload.sub };
    } catch (err) {
      return { ok: false, reason: classify(err) };
    }
  }
}

function classify(err: unknown): TokenRejection {
  if (err instanceof joseErrors.JWTExpired) return 'expired';
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return 'bad_signature';
  if (err instanceof joseErrors.JWKSNoMatchingKey) return 'unknown_key';
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    const claim = (err as { claim?: unknown }).claim;
    if (claim === 'iss') return 'wrong_issuer';
    if (claim === 'aud') return 'wrong_audience';
    return 'malformed';
  }
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return 'unsupported_algorithm';
  if (err instanceof joseErrors.JWTInvalid) return 'malformed';
  return 'malformed';
}

/** How long a discovered `jwks_uri` is reused before the metadata is read again. */
export const DISCOVERY_TTL_MS = 600_000;

/** Process-wide discovery cache, keyed by issuer. */
const discoveryCache = new Map<string, { jwksUri: string; fetchedAt: number }>();

export interface DiscoverOptions {
  issuer: string;
  logger: Logger;
  fetchFn?: typeof fetch;
}

/**
 * Reads `jwks_uri` from the issuer's authorization-server metadata.
 *
 * Rules, all required by the human's instruction:
 *   - the metadata's `issuer` MUST equal the configured issuer exactly (RFC 8414 §3.3);
 *   - metadata is fetched ONLY from URLs derived from the configured issuer;
 *   - the resulting `jwks_uri` MUST be https, except for a loopback host;
 *   - the result is cached with a TTL;
 *   - nothing from the document is logged except the issuer values.
 *
 * verified: docs/ref/spec-2026-07-28-basic-authorization-authorization-server-discovery.md
 *   lines 77-94 — for an issuer WITH a path, try path-insertion RFC 8414, then OIDC
 *   path-insertion, then OIDC path-appending. For one WITHOUT a path, the two root forms.
 */
export async function discoverJwksUri(options: DiscoverOptions): Promise<string> {
  const issuer = normaliseIssuer(options.issuer);
  const cached = discoveryCache.get(issuer);
  if (cached !== undefined && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) {
    return cached.jwksUri;
  }

  const fetchFn = options.fetchFn ?? fetch;
  let lastProblem = 'no endpoint responded';

  for (const url of wellKnownCandidates(issuer)) {
    let document: Record<string, unknown>;
    try {
      const response = await fetchFn(url);
      if (!response.ok) {
        lastProblem = `status ${response.status}`;
        continue;
      }
      document = (await response.json()) as Record<string, unknown>;
    } catch {
      lastProblem = 'request failed';
      continue;
    }

    // Exact string comparison. Normalising here would silently accept a document claiming
    // to be a different issuer.
    if (document['issuer'] !== issuer) {
      options.logger.warn(
        {
          configuredIssuer: issuer,
          advertisedIssuer: typeof document['issuer'] === 'string' ? document['issuer'] : '(absent)',
        },
        'authorization server metadata issuer does not match the configured issuer; rejecting',
      );
      throw new JwksDiscoveryError(
        'authorization server metadata issuer does not match gateway.authOAuth.issuer',
      );
    }

    const jwksUri = document['jwks_uri'];
    if (typeof jwksUri !== 'string' || jwksUri.length === 0) {
      lastProblem = 'no jwks_uri in the metadata';
      continue;
    }
    assertSafeJwksUri(jwksUri);
    discoveryCache.set(issuer, { jwksUri, fetchedAt: Date.now() });
    return jwksUri;
  }

  throw new JwksDiscoveryError(
    `could not discover jwks_uri for the configured issuer (${lastProblem})`,
  );
}

/** Trailing-slash-insensitive, otherwise verbatim: an issuer is compared as a string. */
function normaliseIssuer(issuer: string): string {
  return issuer.endsWith('/') && issuer.length > 8 ? issuer.slice(0, -1) : issuer;
}

function wellKnownCandidates(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  const root = `${url.protocol}//${url.host}`;
  return path === ''
    ? [`${root}/.well-known/oauth-authorization-server`, `${root}/.well-known/openid-configuration`]
    : [
        `${root}/.well-known/oauth-authorization-server${path}`,
        `${root}/.well-known/openid-configuration${path}`,
        `${root}${path}/.well-known/openid-configuration`,
      ];
}

/**
 * https required, except for a loopback host.
 *
 * The check is written out rather than delegated because `jose` does NOT export an
 * `isHttpsUrl` helper from its public entry point (verified:
 * node_modules/jose/dist/types/index.d.ts and node_modules/jose/dist/types/util/, which has
 * base64url, decode_jwt, decode_protected_header and errors only).
 */
function assertSafeJwksUri(jwksUri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(jwksUri);
  } catch {
    throw new JwksDiscoveryError('jwks_uri in the authorization server metadata is not a URL');
  }
  if (parsed.protocol === 'https:') return;
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return;
  throw new JwksDiscoveryError(
    'jwks_uri in the authorization server metadata is not https and the host is not loopback',
  );
}

/** A discovery failure safe to report; never carries key material. */
export class JwksDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwksDiscoveryError';
  }
}

/** Test seam: clears the process-wide discovery cache. */
export function clearJwksDiscoveryCache(): void {
  discoveryCache.clear();
}

/** Never log a token. This exists so that temptation has one obvious place to be removed. */
export function describeTokenResult(result: TokenResult): Record<string, unknown> {
  return result.ok ? { ok: true, subject: result.subject } : { ok: false, reason: result.reason };
}

export type { JWTPayload };