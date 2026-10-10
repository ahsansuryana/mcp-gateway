// The single source of truth for gateway.json (PLAN.md §6, D6, D7).
//
// Every external API used here carries a `// verified:` citation. Nothing in this file
// is written from memory of the MCP SDK or the spec.

import { z } from 'zod';

export const GATEWAY_NAME = 'mcp-gateway';
export const GATEWAY_VERSION = '0.0.0';

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

/**
 * PLAN.md D4: server names must not contain an underscore, so that splitting a
 * namespaced `<server>_<name>` at the FIRST underscore is unambiguous.
 */
export const SERVER_NAME_PATTERN = /^[a-z0-9-]{1,24}$/;

const serverName = z
  .string()
  .regex(SERVER_NAME_PATTERN, 'must match ^[a-z0-9-]{1,24}$ (lowercase, digits, hyphen; no underscore)');

/** PLAN.md D4: namespaced names longer than this are skipped with a warning. */
export const MAX_TOOL_NAME_LENGTH = 64;

const timeoutMs = z
  .int('must be an integer number of milliseconds')
  .min(1000, 'must be >= 1000')
  .max(600_000, 'must be <= 600000');

const enabled = z.boolean().default(true);

/**
 * PLAN.md §6: header names must be valid RFC 9110 tokens.
 * verified: https://datatracker.ietf.org/doc/html/rfc9110#section-5.6.2 (field-name = token)
 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const headerRecord = z.record(
  z.string().regex(HEADER_NAME_PATTERN, 'must be a valid HTTP header name (RFC 9110 token)'),
  z.string(),
);

const stringRecord = z.record(z.string(), z.string());

/**
 * PLAN.md §6 `oauth`: `false` disables OAuth auto-detection, or an object with the
 * pre-registered client fields. `clientMetadataUrl` is not in §6 — see
 * docs/OPEN-QUESTIONS.md Q-DEVNAMES; it is deliberately NOT added here so §6 stays
 * authoritative until the human amends it.
 */
const oauth = z.union([
  z.literal(false),
  z.strictObject({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    scope: z.string().optional(),
  }),
]);

/**
 * Localhost-class hosts that are allowed to use plain `http:` (PLAN.md §6).
 * `::1` is listed twice on purpose: `URL.hostname` yields `[::1]` with brackets for an
 * IPv6 literal, and without them for a bare host.
 * verified: https://developer.mozilla.org/docs/Web/API/URL/hostname (IPv6 literals keep their brackets)
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const remoteUpstream = z.strictObject({
  type: z.literal('remote'),
  url: z.url('must be a valid absolute URL'),
  headers: headerRecord.default({}),
  oauth: oauth.optional(),
  enabled,
  timeout: timeoutMs.optional(),
});

const localUpstream = z.strictObject({
  type: z.literal('local'),
  command: z
    .array(z.string())
    .min(1, 'must have at least the executable name')
    .refine((argv) => (argv[0] ?? '').length > 0, 'first element (the executable) must not be empty'),
  environment: stringRecord.default({}),
  enabled,
  timeout: timeoutMs.optional(),
  startupTimeoutMs: z.int('must be an integer').min(0).default(60_000),
  idleTimeoutMs: z.int('must be an integer').min(0, 'must be >= 0 (0 disables idle shutdown)').default(300_000),
});

const upstream = z.discriminatedUnion('type', [remoteUpstream, localUpstream]);

export type RemoteUpstreamConfig = z.infer<typeof remoteUpstream>;
export type LocalUpstreamConfig = z.infer<typeof localUpstream>;
export type UpstreamConfig = z.infer<typeof upstream>;

/**
 * The protocol-era posture, decided by the human at the Sprint 0 gate and recorded in
 * docs/adr/0002-protocol-compatibility.md.
 * verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (CreateMcpHandlerOptions.legacy; 'stateless' is the default)
 */
const legacyEra = z.enum(['stateless', 'reject']).default('stateless');

/**
 * PLAN.md S6.2 / docs/adr/0009-gateway-auth-oauth-variant.md: the gateway as an OAuth
 * protected resource. Purely ADDITIVE — an existing config without this key is unchanged and
 * static bearer keys keep working (D9).
 *
 * Named authOAuth, not oauth, because `mcp.<name>.oauth` already means the UPSTREAM side.
 * Strict object: an unknown key is a startup error naming the path.
 */
const authOAuth = z.strictObject({
  /** REQUIRED. Compared with the token's `iss` claim by simple string comparison. */
  issuer: z.string().min(1, 'must not be empty'),
  /**
   * OPTIONAL. Defaults to `publicUrl` + `/mcp`, the canonical value Anthropic's documentation
   * requires (docs/ref/claude-connector-requirements.md § 2.2).
   */
  audience: z.url('must be a valid absolute URL').optional(),
  /** OPTIONAL. Discovered from the issuer's metadata when absent. */
  jwksUri: z.url('must be a valid absolute URL').optional(),
  /** OPTIONAL. Advertised in the `WWW-Authenticate` challenge. */
  scope: z.string().min(1, 'must not be empty').optional(),
});

const gateway = z.strictObject({
  host: z.string().default('0.0.0.0'),
  port: z.int('must be an integer').min(1).max(65_535).default(3000),
  publicUrl: z.url('must be a valid absolute URL').optional(),
  auth: z.strictObject({
    type: z.literal('bearer').default('bearer'),
    keys: z.array(z.string().min(1, 'must not be empty')),
  }),
  defaultTimeoutMs: timeoutMs.default(30_000),
  defaultTtlMs: z
    .int('must be an integer number of milliseconds')
    .min(0, 'must be >= 0')
    .max(2_147_483_647, 'must be a valid millisecond TTL')
    .default(30_000),
  legacyEra,
});

/**
 * PLAN.md §6: an arbitrary JSON object whose KEYS are upstream names.
 * The key regex is enforced by zod's record key check (it also lands in the generated
 * JSON Schema as `propertyNames`), and the http-unless-localhost rule — which zod cannot
 * express — is enforced by `validateRemoteUrls`.
 */
const mcp = z.record(serverName, upstream);

const gatewayWithAuth = gateway.extend({
  /** PLAN.md S6.2 / ADR 0009. Optional; absent means "not an OAuth protected resource". */
  authOAuth: authOAuth.optional(),
});

/**
 * At least ONE inbound credential must exist.
 *
 * `keys` may now be empty (ADR 0009 lets OAuth stand alone), but an empty `keys` AND no
 * `authOAuth` would leave `/mcp` open to anyone who can reach the port. That combination is
 * rejected at startup rather than discovered in production.
 */
const gatewayGuarded = gatewayWithAuth.superRefine((value, ctx) => {
  if (value.auth.keys.length === 0 && value.authOAuth === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['auth', 'keys'],
      message:
        'at least one inbound credential is required: set gateway.auth.keys or gateway.authOAuth',
    });
  }
});

export const gatewayConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  gateway: gatewayGuarded,
  mcp,
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export type GatewaySection = z.infer<typeof gateway>;

// ---------------------------------------------------------------------------
// Cross-field validation that JSON Schema and zod's per-field schema cannot express.
// Kept here so `schema.ts` remains the single source of truth (PLAN.md S1.2).
// ---------------------------------------------------------------------------

/** PLAN.md §6: `https:` is required unless the host is localhost-class. */
export function isNonLocalHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname);
}

/** PLAN.md §6: plain `http:` is only allowed for localhost-class hosts. */
export function validateRemoteUrls(upstreams: Record<string, UpstreamConfig>): string[] {
  const errors: string[] = [];
  for (const [name, entry] of Object.entries(upstreams)) {
    if (entry.type !== 'remote') continue;
    let parsed: URL;
    try {
      parsed = new URL(entry.url);
    } catch {
      // zod's `z.url()` already reported this; do not duplicate the message.
      continue;
    }
    if (isNonLocalHttpUrl(parsed)) {
      errors.push(
        `mcp.${name}.url: must use https: unless the host is localhost, 127.0.0.1 or ::1`,
      );
    }
  }
  return errors;
}

/**
 * Runs every cross-field rule and returns their errors together, so a single `validate`
 * run reports all of them rather than only the first.
 */
export function validateCrossFieldConfig(config: {
  mcp: Record<string, UpstreamConfig>;
}): string[] {
  return [...validateRemoteUrls(config.mcp)];
}