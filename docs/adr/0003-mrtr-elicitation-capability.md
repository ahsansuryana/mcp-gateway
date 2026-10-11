# ADR 0003 — MRTR elicitation: static upstream declaration vs per-request downstream clients

- Status: **Accepted** — human decision 2026-10-10 (Sprint 7, P7-5)
- Date: 2026-10-10 (Sprint 5 pre-step, completed with Sprint 4 S4.7 live evidence)
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

## Live evidence from S4.7

Sprint 4 S4.7 connected the vendor reference server
`@modelcontextprotocol/server-everything@2026.8.31` through the production `StdioUpstream`
(transcript: `spikes/out-s4-7.txt`).

The gateway's upstream client declares `capabilities: { elicitation: {} }` (S3.5), and:

```
tools/list -> echo, get-annotated-message, get-env, get-resource-links, ...
             trigger-elicitation-request, simulate-research-query

tools/call trigger-elicitation-request
  -> {"content":[{"type":"text","text":"MCP error -32601: Method not found"}],"isError":true}
```

### What this proves

The tool is **advertised** by a server built with the same SDK generation, so the failure is
not a missing tool and not a protocol-version mismatch. The same SDK's client, declaring
`elicitation`, still receives JSON-RPC `-32601 Method not found` when the tool is invoked.

That is consistent with exactly one documented rule:

> "Servers **MUST NOT** send an `inputRequests` that the client has not declared support for
> in its capabilities. For example, if a client does not declare support for `elicitation`,
> the server **MUST NOT** include any `elicitation/create` requests in the `inputRequests`
> field."
> — verified: `docs/ref/spec-2026-07-28-basic-patterns-mrtr.md`, Server Requirements §7

The consequence of the gateway declaring `elicitation` upstream is therefore observable on
real traffic: a server that checks declarations strictly may answer a tool it just listed
with `-32601`, because it does not agree with the gateway about *which* capability is
declared, or because it re-validates the envelope at call time.

### What this does NOT prove

- It does **not** prove the failure is caused by the gateway's `elicitation` declaration.
  The transcript records the request/response only; the server's internal reason is not
  visible. A server that refuses an elicitation-capable client for a different reason, or
  whose tool fails for its own reasons, would produce the same wire result.
- It does **not** prove option (C) below is viable.
- It does **not** characterise the ORIGINAL risk in this ADR, which is about a *downstream*
  client that never declared elicitation. S4.7 exercised a stdio upstream with no downstream
  client in the path at all.
- It does **not** show `-32601` being returned for an `input_required` result. No
  `input_required` result was produced at all; the tool never got that far.

The honest reading is that S4.7 surfaced a **second, distinct** problem (an elicitation tool
that fails for an elicitation-capable client) *adjacent* to the one this ADR was opened for.

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

The S4.7 observation adds a fifth consequence: the superset strategy is not free even when
the downstream client DOES support elicitation, because a strict upstream can reject the
gateway's declaration outright.

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
- **(E) NEW, from the S4.7 evidence — degrade on `-32601` for an advertised elicitation
  tool.** Treat a `-32601` from a tool whose description promises elicitation as an upstream
  capability mismatch and surface a clear error naming the upstream, rather than passing a
  bare `-32601` to the client. This does not fix either problem; it only makes the failure
  legible. It is cheap and carries no protocol risk.

## Recommendation

**Adopt (A) for the declared-capability risk, and adopt (E) as a diagnostic-only improvement.**
Options (B), (C) and (D) are rejected for the reasons above.

Concretely, proposed for a future sprint with an ADR of its own:

1. Keep `capabilities: { elicitation: {} }` on the gateway's upstream client. MRTR cannot work
   without it, and the spec's rule 7 is a rule about what servers *send*, so the gateway must
   offer the capability it might need.
2. Log a `warn` when an upstream answers `-32601` for a tool call, naming the upstream and the
   tool but no argument values, so the capability mismatch is visible in `/status` terms
   without leaking anything.

## What must happen before this can be closed

- A real **downstream** client without elicitation must be observed returning
  `input_required` through the gateway, so the original failure mode is characterised rather
  than predicted. S4.7 did not do this.
- The `@modelcontextprotocol/server-everything` `-32601` needs a cause. Ask the SDK/vendor team,
  or reproduce against a server whose source shows the check, before any conclusion is drawn.
- Confirm with the SDK team (or the SDK's issue tracker) whether a per-request outbound
  envelope is planned, since (C) becomes unnecessary if it lands.

## FINDING 2026-10-10 (Sprint 7, P7-5) — the SDK already enforces the requested fallback

The human asked for this to be implemented ONLY if it matches the fallback in PLAN.md §5(c):
*when the downstream request did not declare `elicitation`, return an `isError` tool result
explaining that the client lacks elicitation support instead of forwarding an `input_required`
it cannot answer.* The instruction was: if this ADR proposes something different, stop and
show the difference.

**It proposes something different, and the difference is larger than it looks.**

### ADR 0003 recommends (A) + (E)

(A) keep the static declaration and do nothing per-request; (E) log a `warn` when an upstream
answers `-32601`. Neither produces a per-request `isError` fallback.

### PLAN.md §5(c) describes the risk, not a fallback

Its exact words: *"The gateway cannot currently narrow that per request."* No `isError`
behaviour is specified there.

### The SDK already implements the protective behaviour natively

verified: `node_modules/@modelcontextprotocol/server/dist/mcp-DIH4cS6P.mjs` lines 1229-1235 —
before returning an `input-required` result the seam reads the REQUEST's declared
capabilities (`this._inputRequestCapabilityView(ctx)`), computes
`missingClientCapabilities(required, declared)`, and throws
`MissingRequiredClientCapabilityError` when anything is undeclared.

Measured end to end through the gateway (`spikes/probe-mrtr-downstream.mjs`), with a
downstream client declaring `capabilities: {}`:

```
RESULT type     : JSON-RPC ERROR (thrown)
name            : ProtocolError
code            : -32021
message         : Cannot request input 'proceed' (elicitation/create): the request's
                  client capabilities do not declare the required capability
```

### What this means

The `input_required` result **never reaches** a client that cannot answer it. The protection
the human asked for is already in place, delivered as a typed `-32021` whose message states
exactly the reason.

The only difference is the SHAPE: a typed JSON-RPC error rather than an `isError` tool
result. Implementing the requested condition would therefore **replace** SDK behaviour
rather than add to it, and would move a protocol-level condition into D12's tool-result
channel:

> PLAN.md D12: "Tool-execution failures caused by an upstream (down, timeout, needs auth) are
> returned as a tool result with `isError: true` ...; protocol-level problems (unknown tool,
> bad params) are JSON-RPC errors."

A client that did not declare a capability the upstream requires is a protocol-level
condition, so the SDK's choice is the one consistent with D12.

## Decision (human, 2026-10-10)

**(A) is adopted.** The SDK's native behaviour is accepted: a downstream client that did not
declare `elicitation` receives `-32021` with the SDK's explanatory message. No custom
per-request logic. The `isError` condition the human originally proposed is **withdrawn**,
because the empirical evidence shows the SDK already enforces the equivalent with a
spec-defined error code.

**(E) is adopted**, with the log naming the upstream and nothing else from the request.

PLAN.md §5(c) was amended to state the resolved behaviour rather than an open risk.

### Evidence recorded for the accepted behaviour

Command run, from the repository root, on the pre-Sprint-7 tree:

```
npx tsx spikes/probe-mrtr-downstream.mjs
```

Downstream client: `new Client({ name: 'probe-plain', version: '0.0.0' }, { versionNegotiation:
{ mode: { pin: '2026-07-28' } }, defaultCacheTtlMs: 0, capabilities: {} })` — **no
`elicitation` capability declared**. Upstream: the in-repo fake's `needs_input` tool, which
returns `input_required` with an `elicitation/create` request.

Observed output, verbatim:

```
downstream capabilities: null
RESULT type     : JSON-RPC ERROR (thrown)
name            : ProtocolError
code            : -32021
message         : Cannot request input 'proceed' (elicitation/create): the request's
                  client capabilities do not declare the required capability
```

The probe is kept at `spikes/probe-mrtr-downstream.mjs` so the observation is reproducible.

### Regression tests

`test/e2e/mrtr-elicitation.e2e.test.ts` pins both halves:

1. A downstream client WITHOUT `elicitation` receives `-32021` and **never** the
   `input_required`; the message names the missing capability.
2. A downstream client WITH `elicitation` receives the `input_required` unchanged, including
   `requestState`, and two consecutive rounds carry identical `inputRequests`.

A dependency change that alters this fails there loudly rather than silently changing what
downstream clients see.

### Implementation note for (E): where -32601 actually arrives

The first implementation detected `-32601` in the `catch` block and **never fired**. Measured:
an upstream answering `-32601` arrives as an **`isError` tool result**, not a thrown error:

- S4.7 recorded `{"content":[{"type":"text","text":"MCP error -32601: Method not found"}],"isError":true}`
  from `@modelcontextprotocol/server-everything@2026.8.31`;
- the SDK server converts a thrown `ProtocolError` from a tool handler into the same shape,
  but **drops the numeric code**, keeping only the handler's own message.

So the detector matches the RESULT (`isError === true` plus `-32601` or "method not found" in
the text), and the fixture deliberately returns the canonical text rather than throwing —
otherwise the test would exercise a shape no real upstream produces.

## Related

- PLAN.md §5 "MRTR proxy requirements" (a), (b), (c).
- `docs/OPEN-QUESTIONS.md` Q-MRTRPROXY.
- `docs/SDK-NOTES.md` (f).
- `spikes/out-s4-7.txt` — the transcript this ADR's live evidence comes from.
- `docs/BACKLOG.md` B-26.