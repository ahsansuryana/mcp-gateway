# ADR 0003 — MRTR elicitation: static upstream declaration vs per-request downstream clients

- Status: Proposed — **STUB, no workaround implemented** (human instruction for the pre-Sprint-4 step)
- Date: 2026-10-10
- Addresses: PLAN.md §5 "MRTR proxy requirements" point **(c)**, an open risk found in Sprint 3

## Context

PLAN.md §5 point (b), added in Sprint 3, requires the gateway's **upstream** client to declare
`capabilities: { elicitation: {} }`. Without it the SDK's server seam answers the upstream's
`input_required` result with `-32021 MissingRequiredClientCapability` and the gateway never
sees the result at all.

verified: `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts`,
`Server._invokeInputRequiredCapableHandler` — "every embedded request must be covered by the
capabilities declared on the request's envelope (violations answer the typed `-32021`)".

The risk this ADR records is the consequence: the declaration is **static**, so the gateway
tells every upstream "my client supports elicitation" even when the actual downstream client
handling a given request does not.

## Investigation (Sprint 4, pre-step)

Question: can the SDK propagate the downstream request's declared capabilities per request?

**Answer: no on the client side; yes on the server side.** The two halves of the SDK are not
symmetric.

| Side | What the SDK exposes | Citation |
|---|---|---|
| Server | `ctx.mcpReq.envelope?: Partial<RequestMetaEnvelope>` — the per-request envelope, lifted out of `_meta` before the handler runs, so the declared `clientCapabilities` of THIS request are readable. | `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts`, `BaseContext.mcpReq.envelope` |
| Client | `_outboundMetaEnvelope()` builds every request's envelope from `this._capabilities`, the **instance** value fixed by `ClientOptions.capabilities` at construction. There is no per-request override in `RequestOptions`, `CallToolRequestOptions`, or anywhere else. | `node_modules/@modelcontextprotocol/client/dist/index.mjs`, `Client._outboundMetaEnvelope()` and `codecForVersion(...).outboundEnvelope({ ..., clientCapabilities: this._capabilities })` |

Consequence: the gateway CAN observe what a downstream client declared for a given request
(`ctx.mcpReq.envelope`), but CANNOT tell an upstream "this particular downstream client does
not support elicitation", because the upstream-facing envelope is static.

## Consequences of doing nothing

1. An upstream may return `input_required` with `elicitation/create` for a request whose
   downstream client has no elicitation capability.
2. The gateway relays the `input_required` faithfully.
3. The downstream client, which never declared elicitation, cannot fulfil it. Depending on
   the client this surfaces as a typed error or as a stalled round.
4. The gateway cannot pre-empt this without narrowing its upstream declaration, which would
   break MRTR for every other request.

The last point is the actual trade-off: a static declaration is a **superset** strategy. The
gateway accepts capability checks it may not be able to satisfy for some requests, in exchange
for being able to satisfy them for the requests that do support it.

## Options (NOT chosen — recorded for the human)

- **(A) Keep the static declaration (status quo).** Simplest, and the superset behaviour is
  arguably correct: the gateway is a proxy, the real client is downstream. The failure mode
  above is then the downstream client's problem to report.
- **(B) Connect to upstreams per downstream principal, so each connection carries that
  principal's capabilities.** Multiplies upstream connections by the number of inbound
  principals, which collides with D10 (stateless) and with one-identity-per-upstream in §1.
- **(C) Hand-roll the outbound envelope** so the gateway can rewrite `clientCapabilities`
  per request. Requires bypassing the SDK client's request funnel. Not acceptable without a
  decision; it is exactly the kind of custom wire-format code PLAN.md rule 5 guards against.
- **(D) Reject a `tools/call` whose downstream envelope lacks `elicitation` when the upstream
  has previously returned `input_required`.** Stateful and unreliable; also a heuristic.

## Decision

**No decision yet.** The human instruction was: investigate, record, and do NOT implement a
workaround in Sprint 4. Option (A) is the current behaviour and the recommendation for now.

## What must happen before this can be closed

- A real downstream client without elicitation must be observed returning `input_required`
  through the gateway, so the failure mode is characterised rather than predicted.
- Confirm with the SDK team (or the SDK's issue tracker) whether a per-request outbound
  envelope is planned, since (C) becomes unnecessary if it lands.

## Related

- PLAN.md §5 "MRTR proxy requirements" (a), (b), (c).
- `docs/OPEN-QUESTIONS.md` Q-MRTRPROXY.
- `docs/SDK-NOTES.md` (f).