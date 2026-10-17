// PLAN.md S8.1 / D18: the ONE interface `POST /mcp` uses to authenticate a caller.
//
// WHY THIS FILE EXISTS AS A SEAM.
//
// Sprint 8 embeds an authorization server in the gateway process (D18), which reverses the
// Sprint 6 decision in ADR 0005. The thing that decision was protecting is still worth
// protecting, and it is no longer protected by a process boundary -- so it is protected by an
// import boundary instead:
//
//   - AS code lives under `src/auth/as/**` and nowhere else.
//   - `src/auth/token-verifier.ts` is the only module outside `src/auth/as/**` allowed to
//     import it.
//   - `POST /mcp` talks to this interface and never to the AS.
//
// `test/unit/auth-module-boundary.test.ts` walks the real import graph and fails if that ever
// stops being true, so the rule is checked rather than asserted in a comment.
//
// The payoff is the one D18 promises: moving the AS out to a separate service later is a
// config change to `ExternalTokenVerifier`, not a refactor of the aggregate layer.
//
// TWO IMPLEMENTATIONS, ONE INTERFACE.
//
//   embedded  the AS in this process signs; the keyring verifies. Default.
//   external  an external IdP signs; the existing ResourceServer verifies over JWKS. This is
//             the Sprint 6 behaviour, kept working, and what a config with `authOAuth` and no
//             `authMode` still selects -- so no existing config changes meaning.

import type { JWTPayload } from 'jose';

import type { GatewayConfig } from '../config/schema.js';

/**
 * Why a token was refused.
 *
 * Reused from the existing ResourceServer vocabulary so a rejection reads identically whether
 * the token came from this process or an external IdP -- the rate limiter and the logs key off
 * it, and a caller should not be able to tell which AS issued a token just from the error.
 */
export type TokenRejection =
  | 'missing'
  | 'malformed'
  | 'expired'
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'unknown_key'
  | 'unsupported_algorithm';

export interface VerifiedClaims {
  /** The `sub` claim, when the token carries one. Never used as an identity on its own. */
  subject?: string;
  /**
   * The issuer AS READ FROM THE TOKEN, not reconstructed from configuration.
   *
   * Reached only after signature, issuer and expiry have been validated, so the value is
   * proven. It is returned rather than rebuilt because a rate-limit bucket keyed on anything
   * other than what the token actually proved would let a rejected token claim someone
   * else's allowance.
   */
  issuer?: string;
  scopes?: readonly string[];
  /** `exp` in seconds since the epoch, for logging. Never for authorisation decisions. */
  expiresAt?: number;
}

export type TokenVerification =
  | { ok: true; claims: VerifiedClaims }
  | { ok: false; reason: TokenRejection };

/**
 * The whole surface `POST /mcp` may use to authenticate a caller.
 *
 * Deliberately NOT named `verifyTokenAsync` and deliberately has one method: every additional
 * method is one more way for the MCP layer to reach past the seam.
 */
export interface TokenVerifier {
  /**
   * Verifies a bearer token. MUST return a rejection rather than throw for a bad token --
   * an exception here would escape into the Express handler and become a 500, which tells a
   * caller nothing and looks like a server fault rather than a credential fault.
   */
  verify(token: string | undefined): Promise<TokenVerification>;
  /** For `/status` and the banner. Never a secret. */
  readonly mode: 'embedded' | 'external';
}

/**
 * Which verifier a config selects.
 *
 * `authOAuth` alone means `external`, which is what every config written before Sprint 8
 * means. `authMode: 'embedded'` WITH `authOAuth` is rejected rather than resolved: the two
 * name different token issuers, and picking one silently would mean a config the operator
 * believes is doing one thing is doing another.
 */
export function resolveAuthModeFromConfig(config: GatewayConfig): 'embedded' | 'external' {
  return config.gateway.authMode ?? (config.gateway.authOAuth === undefined ? 'embedded' : 'external');
}

/** The conflict message, used by the config layer so the wording exists in one place. */
export function authModeConflictReason(): string {
  return (
    'gateway.authMode is "embedded" and gateway.authOAuth is also set, but they name ' +
    'different token issuers and cannot both apply.\n' +
    'Choose one:\n' +
    '  - embedded AS in this process:  remove gateway.authOAuth\n' +
    '  - an external identity provider:  set gateway.authMode to "external" (or remove it)'
  );
}

// ---------------------------------------------------------------------------
// external — the Sprint 6 implementation, unchanged
// ---------------------------------------------------------------------------

/**
 * Wraps the existing `ResourceServer` so the MCP layer does not care which one it holds.
 *
 * `ResourceServer` stays exactly as it is: it is the external AS client and its own test
 * suite proves signature, issuer, audience and expiry handling against a real JWKS. This
 * wrapper only reshapes the result, so switching modes cannot change how an external token is
 * judged.
 */
export function externalVerifier(resourceServer: {
  verify(token: string | undefined): Promise<{
    ok: boolean;
    issuer?: string;
    subject?: string;
    reason?: TokenRejection;
  }>;
}): TokenVerifier {
  return {
    mode: 'external',
    async verify(token) {
      const result = await resourceServer.verify(token);
      if (!result.ok) {
        return { ok: false, reason: result.reason ?? 'malformed' };
      }
      const claims: VerifiedClaims = {};
      if (result.issuer !== undefined) claims.issuer = result.issuer;
      if (result.subject !== undefined) claims.subject = result.subject;
      return { ok: true, claims };
    },
  };
}

// ---------------------------------------------------------------------------
// embedded — this process's own AS
// ---------------------------------------------------------------------------

/**
 * What S8.1 needs from the keyring, declared here so the seam does not depend on S8.2's file
 * layout. S8.2 implements it; until then the tests inject a fake, which is why the interface
 * is declared against behaviour rather than against a concrete class.
 */
export interface SigningKeyResolver {
  /** Verifies a compact JWS against this process's keys. Resolves false on any failure. */
  verify(token: string, expected: { issuer: string; audience: string }): Promise<VerifiedClaims | undefined>;
}

export function embeddedVerifier(options: {
  keys: SigningKeyResolver;
  /** The canonical resource URL, used as the required `aud`. */
  audience: string;
  /** The issuer this process publishes. Must equal the `iss` it signs. */
  issuer: string;
}): TokenVerifier {
  return {
    mode: 'embedded',
    async verify(token) {
      if (token === undefined || token.length === 0) return { ok: false, reason: 'missing' };
      const claims = await options.keys.verify(token, {
        issuer: options.issuer,
        audience: options.audience,
      });
      if (claims === undefined) return { ok: false, reason: 'bad_signature' };
      return { ok: true, claims };
    },
  };
}

/** Re-exported so callers can build an audience without importing the config module. */
export function canonicalAudience(publicUrl: string): string {
  return new URL('/mcp', publicUrl).href.replace(/\/$/, '');
}

export type { JWTPayload };