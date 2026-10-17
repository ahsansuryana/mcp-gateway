// ADR 0013: whether `POST /mcp` is open, decided in exactly one place.
//
// WHY THIS IS NOT IN THE ZOD SCHEMA.
//
// `gatewayGuarded` used to be a superRefine in src/config/schema.ts, which runs inside
// loadConfig -- and loadConfig runs BEFORE `applyOverrides`. A supervisor living there would
// never see `--hostname 0.0.0.0`, so `mcp-gateway --hostname 0.0.0.0` against a keyless
// config would pass validation and then listen on the LAN with /mcp open. The check is
// therefore a plain function called from two places: parseConfig (so `validate` reports it
// for a config file) and startGateway after the overrides (so a flag cannot walk past it).
//
// WHY AN EXPLICIT `open` MODE EXISTS AT ALL.
//
// `createBearerAuth([])` is not "unauthenticated" -- it is deny-all. src/server/auth.ts
// digests every key once; with an empty list the comparison loop never runs, `foundIndex`
// stays -1, and every request is rejected. Deleting the old superRefine without adding this
// would not have produced an open gateway, it would have produced one that 401s everything
// and looks broken rather than dangerous. So the two states are named, not inferred.
//
// The rule: open mode is allowed only on a loopback bind. `--hostname 0.0.0.0` with no key
// is refused before `listen`, so there is no window in which an unauthenticated gateway is
// reachable from the network -- not even a brief one.

import type { GatewayConfig } from './schema.js';
import { isLoopbackHost } from '../server/banner.js';

export type AuthMode = 'bearer' | 'oauth-only' | 'open';

export interface AuthModeDecision {
  mode: AuthMode;
  /** Only ever a count. A key value never reaches a decision, a log or a status body. */
  keyCount: number;
  /**
   * Set only for `open`. One line, safe to print and safe to log: it names key paths and
   * flags, never a value.
   */
  reason?: string;
}

const UNPROTECTED_REASON =
  'POST /mcp accepts any caller: no bearer key and no OAuth resource server are configured.';

/** Classifies the inbound auth configuration. Pure; never throws. */
export function resolveAuthMode(config: GatewayConfig): AuthModeDecision {
  const keyCount = config.gateway.auth.keys.length;
  if (keyCount > 0) return { mode: 'bearer', keyCount };
  // ADR 0009 already allows OAuth to stand alone with no static keys, so this combination is
  // not the dangerous one -- the request is still checked, just against a token instead.
  if (config.gateway.authOAuth !== undefined) return { mode: 'oauth-only', keyCount };
  return { mode: 'open', keyCount, reason: UNPROTECTED_REASON };
}

/** A schema-shaped problem, so callers can render it without importing ConfigErrorList. */
export interface AuthModeProblem {
  path: string;
  reason: string;
}

/**
 * Returns a problem when the configuration would expose an unauthenticated /mcp to the
 * network. Returns undefined when it is safe -- which includes every configuration that has
 * a credential, and the keyless-but-loopback case.
 *
 * The message names the key path and the flag, because a message that only said "invalid"
 * would send the operator looking in the schema instead of at their own config.
 */
export function checkAuthMode(config: GatewayConfig): AuthModeProblem | undefined {
  const decision = resolveAuthMode(config);
  if (decision.mode !== 'open') return undefined;
  if (isLoopbackHost(config.gateway.host)) return undefined;

  return {
    path: 'gateway.auth.keys',
    reason:
      `is empty and gateway.host is "${config.gateway.host}", which would expose POST /mcp ` +
      'to every host that can reach this port.\n' +
      'Choose one:\n' +
      '  - bind to loopback:  --hostname 127.0.0.1   (an unauthenticated gateway is then allowed)\n' +
      '  - or set an inbound credential:  gateway.auth.keys: ["..."]   (or gateway.authOAuth)',
  };
}