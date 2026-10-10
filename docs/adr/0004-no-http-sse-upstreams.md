# ADR 0004 — No legacy HTTP+SSE upstreams

- Status: Accepted (human decision, 2026-10-10)
- Resolves: PLAN.md §9 Q1

## Context

Protocol revision 2026-07-28 reclassified the HTTP+SSE transport (introduced in `2024-11-05`)
as **Deprecated** under the feature lifecycle policy. Verified in
`docs/ref/spec-2026-07-28-changelog.md`, Deprecated item 2, and in
`docs/ref/spec-2026-07-28-basic-transports-streamable-http.md`, which still documents a
client-side fallback for older servers.

The SDK v2 client still ships `SSEClientTransport` (verified:
`spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts`, export list), so a
fallback would be implementable. That is not sufficient reason to build one.

## Decision

**No support for legacy HTTP+SSE upstreams. No fallback.**

A remote upstream that only speaks HTTP+SSE MUST fail with:

- an error that **names the upstream** (the config key, e.g. `sse-only`);
- **no secret material** — never the URL's query string, credentials or headers
  (PLAN.md rule 9);
- upstream state `error` in `GET /status`;
- downstream behaviour per D12: a `tools/call` to it returns a tool result with
  `isError: true`, not a JSON-RPC error.

## Rationale

- The transport is deprecated by the specification. Building a fallback creates a second code
  path with its own session, auth and error semantics that nothing else in the gateway needs.
- CLAUDE's own connector docs still accept HTTP+SSE, but they also recommend Streamable HTTP
  (verified: `docs/ref/claude-limits.md`). A gateway that speaks only the current transport is
  the smaller surface.
- PLAN.md §1 already lists it as a non-goal "unless an ADR in `docs/adr/` approves it". This
  ADR declines it.

## Consequences

- An upstream that only offers HTTP+SSE is unreachable. Users must front it with a proxy that
  speaks Streamable HTTP.
- The failure must be explicit and name the upstream, so the message is part of the product.
- `SSEClientTransport` stays unused. No dependency is removed by that.

## Reopen condition

If a specific upstream the gateway must serve offers only HTTP+SSE, revisit — with an ADR that
states the added test matrix, not a silent fallback.
