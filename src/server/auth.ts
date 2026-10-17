// PLAN.md S2.5 / D9: inbound auth v1 is a static bearer key list, compared with
// `crypto.timingSafeEqual` on SHA-256 digests.
//
// PLAN.md rule 9: a failed comparison is reported without ever echoing the presented key.

import { createHash, timingSafeEqual } from 'node:crypto';

// verified: https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b
//   (timingSafeEqual throws when the two buffers differ in length; SHA-256 digests are
//    always 32 bytes, so the digests can always be compared directly.)
// verified: https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options
const DIGEST_BYTES = 32;

export type AuthFailure = 'missing' | 'malformed' | 'invalid';

export interface AuthSuccess {
  ok: true;
  /** Index into the configured key list; used only for telemetry, never returned. */
  keyIndex: number;
}

export interface AuthFailureResult {
  ok: false;
  reason: AuthFailure;
}

export type AuthResult = AuthSuccess | AuthFailureResult;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export interface BearerAuth {
  /** The presented key was among the configured ones. */
  authorize(headerValue: string | undefined): AuthResult;
}

/**
 * Builds the verifier. Keys are digested once at construction so a per-request cost is
 * one comparison, not one hash per configured key.
 */
export function createBearerAuth(keys: readonly string[]): BearerAuth {
  const digests = keys.map((key) => digest(key));

  return {
    authorize(headerValue: string | undefined): AuthResult {
      if (headerValue === undefined || headerValue.length === 0) return { ok: false, reason: 'missing' };

      // Case-insensitive scheme match; the spec's header values are case-sensitive but the
      // scheme token is not (verified: docs/ref/spec-2026-07-28-basic-authorization-index.md).
      const separator = headerValue.indexOf(' ');
      if (separator < 0) return { ok: false, reason: 'malformed' };
      const scheme = headerValue.slice(0, separator);
      if (scheme.toLowerCase() !== 'bearer') return { ok: false, reason: 'malformed' };

      const presented = headerValue.slice(separator + 1).trim();
      if (presented.length === 0) return { ok: false, reason: 'malformed' };

      const presentedDigest = digest(presented);
      // Every candidate is compared, so the loop runs in time independent of which key
      // matched. `foundIndex` only records WHICH key; the key value is never used again.
      let foundIndex = -1;
      for (let i = 0; i < digests.length; i += 1) {
        const candidate = digests[i];
        if (candidate === undefined) continue;
        if (timingSafeEqual(presentedDigest, candidate) && foundIndex < 0) foundIndex = i;
      }

      if (foundIndex < 0) return { ok: false, reason: 'invalid' };
      return { ok: true, keyIndex: foundIndex };
    },
  };
}

/**
 * D9 / PLAN.md §8: 401 with a `WWW-Authenticate: Bearer` challenge. No `resource_metadata`
 * parameter is advertised, because the gateway publishes no protected-resource metadata in
 * Sprint 2 (that arrives with the inbound OAuth work in Sprint 6).
 */
export function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({ error: 'unauthorized' }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer',
      },
    },
  );
}

/**
 * The verifier used when the gateway is deliberately unauthenticated (ADR 0013, loopback
 * binds only -- `checkAuthMode` in src/config/auth-mode.ts refuses anything else).
 *
 * It still parses the header rather than waving every request through. A caller who sends
 * `Authorization: nonsense` has made a mistake worth seeing, and answering 200 to a
 * malformed header makes "send anything at all" a path that works. The shape check is the
 * only thing standing between an open gateway and a client that believes it is
 * authenticating when it is not.
 *
 * `keyIndex` is -1 because there is no key: the rate limiter buckets on
 * `static:${sha256(key)}` for real keys, and must not collide with one.
 */
export function alwaysAuthorized(): BearerAuth {
  return {
    authorize(headerValue: string | undefined): AuthResult {
      if (headerValue === undefined || headerValue.length === 0) return { ok: true, keyIndex: -1 };
      const separator = headerValue.indexOf(' ');
      if (separator < 0) return { ok: false, reason: 'malformed' };
      const scheme = headerValue.slice(0, separator);
      if (scheme.toLowerCase() !== 'bearer') return { ok: false, reason: 'malformed' };
      const presented = headerValue.slice(separator + 1).trim();
      if (presented.length === 0) return { ok: false, reason: 'malformed' };
      // A well-formed bearer header is accepted, but the value is discarded: there is no
      // configured key to compare it against, and comparing against nothing is what would
      // look like verification without being it.
      return { ok: true, keyIndex: -1 };
    },
  };
}

export const DIGEST_LENGTH = DIGEST_BYTES;