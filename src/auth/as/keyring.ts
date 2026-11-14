// PLAN.md S8.2: the embedded AS's signing keyring.
//
// WHY THIS EXISTS AT ALL, AND WHY IT IS ROTABLE.
//
// B-33 is the cautionary tale in this repository: the UPSTREAM token store key cannot be
// rotated, so one leaked key means one permanent re-consent. This keyring is built to avoid
// repeating that. Two properties make rotation possible without downtime:
//
//   1. a new key is PUBLISHED in JWKS before it signs anything, so a client that has cached
//      the JWKS can already verify a token signed with it;
//   2. an old key is retired only after every token it signed has expired, so retirement can
//      never invalidate a live token.
//
// Everything lives under `<config dir>/data/`, 0600 inside the 0700 config directory, which is
// the same rule the upstream token store already follows (ADR 0012 D3).
//
// The private key is never logged, never in `/status`, and never in an error message
// (PLAN.md rule 9).

import { generateKeyPair, exportJWK, importJWK, SignJWT, jwtVerify, type JWK, type CryptoKey } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Ed25519, not RS256.
 *
 * Ed25519 keys are 32 bytes and signing is a constant-time operation, so there is no key
 * length to choose wrong and no RSA parameter to get subtly wrong. Claude validates any
 * asymmetric signature, so nothing about the client prefers RSA.
 *
 * verified: node_modules/jose — `generateKeyPair('Ed25519')`, `exportJWK`, `SignJWT`,
 *   `jwtVerify` are all exported by jose 6.2.12 (checked against the installed package,
 *   not from memory).
 */
export const KEY_ALGORITHM = 'Ed25519';

/** Default signing-key lifetime before rotation is advised. */
export const KEY_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export interface SigningKeyEntry {
  /** Published in JWKS and carried in every token header, so a key can be selected. */
  kid: string;
  alg: 'EdDSA';
  /** Public half. Safe to serve. */
  publicJwk: JWK;
  createdAt: number;
  /**
   * `undefined` means "never expires" — the current signing key. A past timestamp means the
   * key is retired and may be dropped once no live token needs it.
   */
  retireAfter?: number;
}

interface KeyringFile {
  keys: SigningKeyEntry[];
}

/** What the verifier needs. Declared here so S8.1's seam does not depend on this file. */
export interface KeyringVerifierResult {
  subject?: string;
  issuer?: string;
  scopes?: string[];
  expiresAt?: number;
}

export interface KeyringOptions {
  path: string;
  /** Injectable so tests never write to a real filesystem or use a real clock. */
  now?: () => number;
  /** Injectable so tests can force rotation without waiting 90 days. */
  keyLifetimeMs?: number;
}

export class SigningKeyring {
  readonly #path: string;
  readonly #now: () => number;
  readonly #lifetimeMs: number;
  #entries: SigningKeyEntry[] = [];
  /** Private keys held only in memory, never written. */
  readonly #private = new Map<string, CryptoKey>();
  #loaded = false;

  constructor(options: KeyringOptions) {
    this.#path = options.path;
    this.#now = options.now ?? Date.now;
    this.#lifetimeMs = options.keyLifetimeMs ?? KEY_LIFETIME_MS;
  }

  get path(): string {
    return this.#path;
  }

  /** True once at least one live signing key exists. */
  get ready(): boolean {
    this.#load();
    return this.#current() !== undefined;
  }

  #current(): SigningKeyEntry | undefined {
    return this.#entries.find((entry) => entry.retireAfter === undefined);
  }

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    if (!existsSync(this.#path)) return;
    const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as KeyringFile;
    this.#entries = parsed.keys ?? [];
  }

  /**
   * Ensures a live signing key exists, creating one on first run.
   *
   * Generated on first use rather than at import time so that merely importing the module
   * never touches a filesystem, and so a gateway configured without the embedded AS never
   * creates a key it will not use.
   */
  async ensureKey(): Promise<SigningKeyEntry> {
    this.#load();
    const current = this.#current();
    if (current !== undefined) {
      // Rotated on age, but only when one is actually needed — a token may be signed later.
      if (this.#now() - current.createdAt < this.#lifetimeMs) return current;
    }
    return this.rotate();
  }

  /**
   * Publishes a NEW key and marks the current one for retirement.
   *
   * The new key is written to the keyring BEFORE it is returned, so it is in JWKS as soon as
   * this returns — property (1) above. The old key keeps serving verification until its
   * `retireAfter` passes.
   */
  async rotate(): Promise<SigningKeyEntry> {
    this.#load();
    const now = this.#now();

    const { publicKey, privateKey } = await generateKeyPair(KEY_ALGORITHM, {
      // The private key is extractable=false: it cannot be exported even by code with
      // access to this object, so a bug that tries to serialise the keyring leaks nothing.
      extractable: false,
    });
    const publicJwk = await exportJWK(publicKey);
    publicJwk.alg = 'EdDSA';
    publicJwk.use = 'sig';

    const kid = createHash('sha256')
      .update(JSON.stringify(publicJwk))
      .digest('base64url')
      .slice(0, 16);
    this.#private.set(kid, privateKey);

    for (const entry of this.#entries) {
      if (entry.retireAfter === undefined) {
        // Long enough for any token already signed by this key to have expired. Property (2).
        entry.retireAfter = now + this.#lifetimeMs;
      }
    }

    const fresh: SigningKeyEntry = { kid, alg: 'EdDSA', publicJwk, createdAt: now };
    this.#entries.push(fresh);
    this.#persist();
    return fresh;
  }

  /**
   * Drops retired keys whose tokens can no longer be live.
   *
   * Called from the same place as rotation. Without it the file grows by one key every 90
   * days forever, and JWKS grows with it.
   */
  prune(): number {
    this.#load();
    const now = this.#now();
    const before = this.#entries.length;
    this.#entries = this.#entries.filter(
      (entry) => entry.retireAfter === undefined || entry.retireAfter > now,
    );
    const removed = before - this.#entries.length;
    if (removed > 0) this.#persist();
    return removed;
  }

  #persist(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    // `keys` only: the PRIVATE halves live only in memory, so the file on disk cannot
    // disclose a signing key even if it is copied.
    writeFileSync(this.#path, `${JSON.stringify({ keys: this.#entries }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      chmodSync(this.#path, 0o600);
    } catch {
      // POSIX-only; on Windows the ACL inherited from the config directory applies.
    }
  }

  /** The document served at `/.well-known/jwks.json`. Public material only. */
  jwks(): { keys: JWK[] } {
    this.#load();
    return { keys: this.#entries.map((entry) => entry.publicJwk) };
  }

  /**
   * Signs an access token with the current key.
   *
   * `aud` and `iss` are passed in by the caller, which takes them from configuration (D20)
   * rather than from the request.
   */
  async signAccessToken(input: {
    subject: string;
    issuer: string;
    audience: string;
    expiresInMs: number;
    scopes?: readonly string[];
  }): Promise<string> {
    const entry = await this.ensureKey();
    const privateKey = this.#private.get(entry.kid);
    if (privateKey === undefined) {
      // Reachable only if the process restarted and the file survived: the private half is
      // memory-only by design, so after a restart the key must be replaced rather than
      // reused. Rotating is correct here -- old tokens are still verifiable through JWKS
      // until they expire.
      await this.rotate();
      return this.signAccessToken(input);
    }
    const now = Math.floor(this.#now() / 1000);
    return new SignJWT({
      sub: input.subject,
      ...(input.scopes === undefined ? {} : { scope: [...input.scopes] }),
      // The `scope` claim is what an RFC 6749 client expects; `scopes` is not a registered
      // claim name and would be ignored by anything that does not know about it.
    })
      .setProtectedHeader({ alg: entry.alg, kid: entry.kid, typ: 'at+jwt' })
      .setIssuer(input.issuer)
      .setAudience(input.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + Math.ceil(input.expiresInMs / 1000))
      .sign(privateKey);
  }

  /**
   * Verifies a compact JWS against every live key.
   *
   * Retired keys are STILL tried, because a token signed before retirement stays valid until
   * it expires. That is property (2), and it is why `prune` is allowed to drop them.
   *
   * Returns undefined on any failure rather than throwing: the seam's contract is a
   * rejection, and an exception here would surface as a 500 for what is a credential fault.
   */
  async verify(token: string, expected: { issuer: string; audience: string }): Promise<KeyringVerifierResult | undefined> {
    this.#load();
    if (this.#entries.length === 0) return undefined;
    for (const entry of this.#entries) {
      try {
        const publicKey = await importJWK(entry.publicJwk, KEY_ALGORITHM);
        const { payload } = await jwtVerify(token, publicKey, {
          issuer: expected.issuer,
          audience: expected.audience,
          algorithms: ['EdDSA'],
        });
        const result: KeyringVerifierResult = {};
        if (typeof payload.sub === 'string') result.subject = payload.sub;
        if (typeof payload.iss === 'string') result.issuer = payload.iss;
        if (typeof payload.exp === 'number') result.expiresAt = payload.exp;
        const scope = payload['scope'];
        if (typeof scope === 'string') result.scopes = scope.split(' ').filter((s) => s.length > 0);
        return result;
      } catch {
        // This key did not match. A token verifies against exactly one key, so trying the
        // rest is correct; swallowing the reason is fine because the caller only ever learns
        // "not valid".
      }
    }
    return undefined;
  }

  /** A fresh opaque identifier. Kept here so id generation has one home. */
  static newId(): string {
    return randomUUID();
  }
}

/** The path the keyring uses beside a resolved config file. */
export function keyringPathFor(configPath: string): string {
  return join(dirname(configPath), 'data', 'as-signing-keys.json');
}