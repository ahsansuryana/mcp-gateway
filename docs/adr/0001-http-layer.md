# ADR 0001 — HTTP layer for the gateway (resolves D16)

- Status: Proposed (needs human approval)
- Date: 2026-10-10
- Sprint: 0, task S0.7
- Decides: PLAN.md D16

## Context

PLAN.md D16 leaves the web framework open:

> D16 | Web framework: Express with the SDK's Express middleware if it exists and fits;
> otherwise `@modelcontextprotocol/node` with Node `http`. Decide in Sprint 0 from evidence,
> record in an ADR.

Evidence gathered in Sprint 0 (`spikes/`, `docs/SDK-NOTES.md`):

1. `@modelcontextprotocol/express@2.0.2` exists and peer-depends on
   `express ^4.18.0 || ^5.0.0` and `@modelcontextprotocol/server ^2.3.0`
   (`npm view @modelcontextprotocol/express peerDependencies`).
2. Its exports (`spikes/node_modules/@modelcontextprotocol/express/dist/index.d.mts`) are
   `createMcpExpressApp`, `hostHeaderValidation`, `localhostHostValidation`,
   `originValidation`, `localhostOriginValidation`, `requireBearerAuth`,
   `mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl`.
3. It does **not** export an MCP request handler. The handler itself always comes from
   `createMcpHandler` (`@modelcontextprotocol/server`) mounted through `toNodeHandler`
   (`@modelcontextprotocol/node`) — the Express package only supplies the middlewares.
4. `@modelcontextprotocol/node` additionally exposes `NodeStreamableHTTPServerTransport`
   (a stateful, session-based transport) and the plain-`node:http` guards
   `hostHeaderValidation` / `originValidation`. Those are the "legacy-era" building blocks;
   the 2026-07-28 stateless path does not need them.
5. `createMcpExpressApp()` defaults `host` to `'127.0.0.1'` and enables DNS-rebinding
   protection only for localhost-class binds; it sets `express.json({ limit })` with
   **Express's default of `'100kb'`**.

## Options

**A. Express + `@modelcontextprotocol/express` + `createMcpHandler`/`toNodeHandler`.**
Gains `requireBearerAuth` and `mcpAuthMetadataRouter` for free (Sprint 6),
`originValidation` middleware for D9/S2.5, and familiar routing for `GET /healthz` and
`GET /status` alongside `POST /mcp`. Costs one runtime dependency (`express`), and its
`express.json()` default limit (100kb) is far below PLAN.md S2.5's 1 MiB body limit — must
be raised explicitly or removed in favour of the SDK's own `maxRequestBodySize`.

**B. `@modelcontextprotocol/node` + plain `node:http`.**
Fewest dependencies. Loses `requireBearerAuth` / `mcpAuthMetadataRouter` (would have to be
re-derived from `verifyBearerToken` / `oauthMetadataResponse` in `@modelcontextprotocol/server`,
which are exported but require hand-written routing). Keeps the 4 MiB SDK default rather
than the plan's 1 MiB. Hand-rolls routing for the three endpoints.

**C. `@modelcontextprotocol/node` + `NodeStreamableHTTPServerTransport`.**
Rejected: that transport is session-based. PLAN.md D10 requires the gateway to be stateless,
and spec revision 2026-07-28 removed protocol sessions entirely.

## Decision

**Option A.** Express with `@modelcontextprotocol/express` middlewares, `createMcpHandler`
for the MCP surface, `toNodeHandler` to bridge.

Rationale: the plan author knows Express (D16), Sprint 6 needs the OAuth resource-server
documents that only `@modelcontextprotocol/express` provides ready-made, and the transport
layer — the part that must be exactly right — is the SDK's, not ours.

## Consequences

- `express` becomes a runtime dependency. `@modelcontextprotocol/node` still applies for
  `toNodeHandler`.
- `express.json()` must be configured with an explicit limit (PLAN.md S2.5: 1 MiB) or
  omitted so the SDK's `maxRequestBodySize` governs. S2.5 must decide which layer owns the
  limit and write it down.
- `createMcpExpressApp` auto-enables Host validation only for localhost binds. PLAN.md binds
  `0.0.0.0` by default, so `allowedHosts` / `allowedOrigins` must be configured explicitly
  rather than relied upon. **S2.5 must not assume the defaults cover a `0.0.0.0` deploy.**
- Origin allowlist content is driven by `gateway.publicUrl`, which is still Q4 in PLAN.md
  and unanswered.
- Hono (`@modelcontextprotocol/hono@2.0.2`) exists but was not chosen; it would repeat the
  same shape as Express.

## Open items this ADR does not resolve

- `gateway.publicUrl` (PLAN.md Q4) — needed for the Origin allowlist and for OAuth metadata.
- Whether `/healthz` and `/status` should sit inside the same Express app (recommended) or
  on a separate listener.