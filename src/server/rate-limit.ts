// PLAN.md S7.2: per-subject rate limiting with an in-memory token bucket.
//
// Design notes:
//
//   - The bucket is keyed by the AUTHENTICATED identity, never by IP. A gateway behind a
//     proxy sees one IP for every caller, and D9 already establishes that auth failures
//     must not reveal anything about the presented key.
//   - `Retry-After` is computed from the bucket's actual refill time, not a constant.
//   - The clock is injectable so a test does not have to sleep for a minute to observe
//     exhaustion.
//
// verified: nodejs.org/api/timers.html#settimeoutcallback-delay-args (setTimeout)

import { createHash } from 'node:crypto';

/** Hard cap on tracked subjects. Above this, the oldest buckets are evicted. */
export const MAX_BUCKETS = 10_000;

export interface RateLimitOptions {
  /** Sustained requests per window. 0 or less disables limiting entirely. */
  limit: number;
  /** Window in ms. */
  windowMs: number;
  /** Injectable for tests. */
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds to put in `Retry-After`; absent when allowed. */
  retryAfterSeconds?: number;
  remaining: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();
  /**
   * Insertion order, so eviction is O(1) per entry instead of sorting.
   *
   * An earlier version sorted the whole map on every check once the cap was reached. Past
   * MAX_BUCKETS that meant one O(n log n) sort PER REQUEST: on the Linux CI host the
   * 'memory stays bounded' test took 5.7 s and timed out. Bounded memory is the goal;
   * paying a sort per request to achieve it is not acceptable.
   */
  #order: string[] = [];
  /** Guards against unbounded growth from a flood of distinct subjects. */
  #lastSweep = 0;

  constructor(options: RateLimitOptions) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.#limit > 0;
  }

  /**
   * Consumes one token for `subject`.
   *
   * The subject is HASHED before it becomes a map key. A bearer key is a secret; keeping
   * it in memory as a plain map key would put it in a heap dump, and an operator printing
   * the limiter's state would print it.
   */
  check(subject: string): RateLimitDecision {
    if (!this.enabled) return { allowed: true, remaining: Number.POSITIVE_INFINITY };

    const now = this.#now();
    const key = createHash('sha256').update(subject).digest('base64url');

    const existing = this.#buckets.get(key);
    if (existing === undefined) {
      this.#buckets.set(key, { tokens: this.#limit - 1, updatedAt: now });
      this.#order.push(key);
      this.#maybeSweep(now);
      return { allowed: true, remaining: this.#limit - 1 };
    }

    // Refill proportionally to the time elapsed, so a partial window recovers gradually
    // rather than all at once.
    const elapsed = Math.max(0, now - existing.updatedAt);
    const refill = (elapsed / this.#windowMs) * this.#limit;
    existing.tokens = Math.min(this.#limit, existing.tokens + refill);
    existing.updatedAt = now;

    if (existing.tokens >= 1) {
      existing.tokens -= 1;
      return { allowed: true, remaining: Math.floor(existing.tokens) };
    }

    // Time until one whole token is available.
    const tokensPerMs = this.#limit / this.#windowMs;
    const waitMs = (1 - existing.tokens) / tokensPerMs;
    return {
      allowed: false,
      // RFC 9110 §10.2.3 allows a delay-seconds value; round UP so a client that obeys it
      // is not rejected again immediately.
      retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      remaining: 0,
    };
  }

  /**
   * Keeps the bucket map bounded.
   *
   * An age-based sweep alone is not enough: a flood of DISTINCT subjects arriving in one
   * burst creates them all at the same instant, so at sweep time none of them is old enough
   * to drop and the map keeps growing. A hard cap with oldest-first eviction bounds the
   * memory regardless of arrival pattern. The evicted subjects get a fresh bucket, i.e. a
   * full allowance, which is the safe direction to be wrong in.
   */
  #maybeSweep(now: number): void {
    const stale = this.#buckets.size > MAX_BUCKETS;
    if (!stale && now - this.#lastSweep < this.#windowMs) return;
    this.#lastSweep = now;

    for (const key of this.#order) {
      const bucket = this.#buckets.get(key);
      if (bucket !== undefined && now - bucket.updatedAt >= this.#windowMs) this.#buckets.delete(key);
    }
    if (this.#buckets.size <= MAX_BUCKETS) return;

    // Still over the cap after the age sweep: evict in INSERTION order from the front of
    // the queue. O(1) per entry, and insertion order is a fair proxy for age here because
    // the age sweep already removed everything genuinely expired.
    while (this.#buckets.size > MAX_BUCKETS) {
      const oldest = this.#order.shift();
      if (oldest === undefined) break;
      this.#buckets.delete(oldest);
    }
  }

  get size(): number {
    return this.#buckets.size;
  }

  /**
   * Test seam: the HASHED bucket keys, never the subjects. Exposing the subjects would put
   * a bearer key in a test's failure output.
   */
  keys(): IterableIterator<string> {
    return this.#buckets.keys();
  }

  clear(): void {
    this.#buckets.clear();
    this.#order = [];
  }
}
