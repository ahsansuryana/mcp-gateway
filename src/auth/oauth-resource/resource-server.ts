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
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(options: ResourceServerOptions) {
    this.#options = options;
    // verified: node_modules/jose/dist/types/jwks/remote.d.ts
    //   (createRemoteJWKSet(url, options?: RemoteJWKSetOptions)) — a key resolver with its
    //   own cache, cooldown and timeout. A remote resolver is used even for a configured
    //   jwksUri so key rotation is picked up without a restart.
    //
    // 30s timeout: Anthropic gives an authorization server 10s for its OAuth endpoints, and a
    // slow JWKS fetch must fail the request rather than hang it.
    this.#jwks = createRemoteJWKSet(
      new URL(options.jwksUri ?? defaultJwksUri(options.issuer)),
      {
        timeoutDuration: 10_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
        ...(options.fetchFn === undefined
          ? {}
          : { [Symbol.for('jose.fetch')]: options.fetchFn }),
      },
    );
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
      const { payload } = await jwtVerify(token, this.#jwks, {
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

/**
 * The conventional JWKS location for an issuer.
 *
 * When `jwksUri` is not configured the real JWKS URI comes from the issuer's
 * authorization-server metadata (`jwks_uri`). That discovery is the SDK's
 * `discoverAuthorizationServerMetadata()`; until it is wired, this conventional path is the
 * documented default and a mismatch surfaces as `unknown_key`, not as a silent pass.
 */
function defaultJwksUri(issuer: string): string {
  return new URL('/.well-known/jwks.json', issuer).href;
}

/** Never log a token. This exists so that temptation has one obvious place to be removed. */
export function describeTokenResult(result: TokenResult): Record<string, unknown> {
  return result.ok ? { ok: true, subject: result.subject } : { ok: false, reason: result.reason };
}

export type { JWTPayload };