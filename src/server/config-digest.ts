// A stable digest of a parsed configuration value.
//
// Object key order is not stable across a parse, so the digest sorts keys before
// serialising. Without that, saving a file unchanged would produce a "changed" upstream and
// restart it — which, for an OAuth upstream, means the user has to consent again.
//
// Secrets are hashed WITH the value: the digest never leaves this module and is only ever
// compared for equality, never stored or logged.

import { createHash } from 'node:crypto';

export function configDigest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** JSON with object keys sorted, so two structurally equal values digest identically. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}