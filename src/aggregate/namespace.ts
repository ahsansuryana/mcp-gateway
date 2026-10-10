// PLAN.md S2.3 / D4: tool and prompt namespacing `<server>_<name>`.
//
// D4's rules, verbatim:
//   - server names must match `^[a-z0-9-]{1,24}$` (no underscore) so that splitting on
//     the FIRST underscore is unambiguous;
//   - a tool whose FULL namespaced name exceeds 64 characters is skipped, and a warning
//     naming the server and the tool is logged.

import { MAX_TOOL_NAME_LENGTH, SERVER_NAME_PATTERN } from '../config/schema.js';

/** The separator D4 fixes. */
export const NAMESPACE_SEPARATOR = '_';

export interface ParsedName {
  server: string;
  name: string;
}

export type SkipReason =
  | 'server-name-invalid'
  | 'tool-name-empty'
  | 'too-long';

export interface NamespaceOutcome {
  /** `undefined` when the tool must be skipped. */
  namespaced?: string;
  reason?: SkipReason;
}

/**
 * Builds `<server>_<tool>`.
 *
 * Returns a skip outcome instead of throwing, because a single over-long tool name must
 * not take down `tools/list` (D8) — it is dropped with a warning.
 */
export function namespaceName(server: string, name: string): NamespaceOutcome {
  if (!SERVER_NAME_PATTERN.test(server)) return { reason: 'server-name-invalid' };
  if (name.length === 0) return { reason: 'tool-name-empty' };
  const namespaced = `${server}${NAMESPACE_SEPARATOR}${name}`;
  if (namespaced.length > MAX_TOOL_NAME_LENGTH) return { reason: 'too-long' };
  return { namespaced };
}

/** The convenience form for callers that have already validated the server name. */
export function namespaced(server: string, name: string): string {
  const outcome = namespaceName(server, name);
  if (outcome.namespaced === undefined) {
    throw new Error(
      `cannot namespace '${server}${NAMESPACE_SEPARATOR}${name}': ${outcome.reason ?? 'unknown'}`,
    );
  }
  return outcome.namespaced;
}

/**
 * Splits a namespaced name at the FIRST underscore (D4).
 *
 * Returns `null` when the name cannot have come from this gateway: no separator, an empty
 * server part, an empty tool part, or a server part that violates D4's regex.
 */
export function parseNamespacedName(value: string): ParsedName | null {
  const index = value.indexOf(NAMESPACE_SEPARATOR);
  if (index < 0) return null;

  const server = value.slice(0, index);
  const name = value.slice(index + 1);

  if (!SERVER_NAME_PATTERN.test(server)) return null;
  if (name.length === 0) return null;
  return { server, name };
}

export interface NamespacingReport {
  kept: number;
  skipped: { server: string; tool: string; reason: SkipReason }[];
}

/**
 * Applies D4 across a batch, returning the skipped entries so the caller can log a
 * warning naming the server and the tool (D4) without dropping them silently.
 */
export function namespaceBatch(
  entries: readonly { server: string; name: string }[],
): { tools: { server: string; name: string; namespaced: string }[]; report: NamespacingReport } {
  const tools: { server: string; name: string; namespaced: string }[] = [];
  const skipped: NamespacingReport['skipped'] = [];

  for (const { server, name } of entries) {
    const outcome = namespaceName(server, name);
    if (outcome.namespaced !== undefined) {
      tools.push({ server, name, namespaced: outcome.namespaced });
    } else {
      skipped.push({ server, name, reason: outcome.reason ?? 'too-long' });
    }
  }

  return { tools, report: { kept: tools.length, skipped } };
}