# ADR 0002 — Protocol-version compatibility posture (resolves PLAN.md Q2)

- Status: Proposed (needs human approval)
- Date: 2026-10-10
- Sprint: 0, tasks S0.3(j) and S0.7
- Decides: PLAN.md §9 Q2

## Context

PLAN.md §9 Q2:

> **Q2** Must the gateway also serve clients that speak 2025-era MCP (with `initialize` and
> sessions)? Default: yes IF the SDK v2 provides it without custom code; otherwise
> 2026-07-28 only, recorded in an ADR. (Decided after S0.3(j).)

PLAN.md §2 also flagged an unverified third-party claim:

> A third-party package (`mcp-handler@2`) states v2 requires Node.js >= 20 and Zod 4, and
> serves 2025-era stateless Streamable HTTP clients through a compatibility layer. The plan
> author did NOT verify whether the official SDK v2 server offers the same compatibility.
> See Sprint 0 task S0.3(j).

## What Sprint 0 verified

**The official SDK gives it away, by default, on the same endpoint and the same factory.**

`spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts`,
`CreateMcpHandlerOptions.legacy`:

> How 2025-era (non-envelope) traffic is served:
> - `'stateless'` (**the default**, also when the option is omitted) — old-school stateless
>   serving: each legacy request is answered by a fresh instance from the same factory …
> - `'reject'` — modern-only strict … **There is no 2025 serving in this mode.**

Supporting evidence:

- `mcp-handler` is at **2.3.0** and its `peerDependencies` are
  `{ next: ">=13.0.0", "@modelcontextprotocol/server": "^2.0.0" }` — it is a **Next.js**
  adapter and would drag Next into the gateway. Not needed.
- The official MCP Inspector CLI (`@modelcontextprotocol/inspector@2.10.1`) has
  `protocolEra` defaulting to `legacy`. Against the gateway built with the default
  `legacy: 'stateless'`, `tools/list` and `tools/call` both succeeded with **no flags**
  (`spikes/out-spike-3.txt`). Against a `legacy: 'reject'` upstream the same command failed
  with `-32022 Unsupported protocol version: 2025-11-25`, and succeeded with
  `--protocol-era modern`.
- Claude.ai custom connectors follow the **2025-03-26 / 2025-06-18 / 2025-11-25**
  authorization specifications, and Claude's own connector-testing docs describe Claude
  identifying itself "in the MCP `initialize` handshake"
  (<https://claude.com/docs/connectors/building>, <https://claude.com/docs/connectors/building/testing>).
  A modern-only gateway would simply be unreachable from Claude.

Full matrix in `docs/SDK-NOTES.md` (j); raw output in `spikes/out-probe-compat.txt`.

## Options

**A. `legacy: 'stateless'` — the SDK default. Serve both eras.**
- One factory, one endpoint, zero custom compatibility code.
- Works with claude.ai connectors, Claude Code, the default Inspector, and modern clients.
- The 2025-era wire codec has no cache-hint code path and no `input_required` vocabulary:
  D11 (`ttlMs`/`cacheScope`) and MRTR passthrough are 2026-only in practice. The 2025 codec
  also never stamps `serverInfo`.

**B. `legacy: 'reject'` — modern only.**
- Simplest; every response is 2026-07-28-shaped.
- Unreachable by claude.ai connectors and by the default Inspector. That contradicts the
  product goal in PLAN.md §1.

**C. `legacy: 'stateless'` with a config flag to switch to `'reject'`.**
- Same as A, plus an escape hatch.
- One more knob, and the flag's value must be validated at startup.

## Decision

**Option C, defaulting to A.**

`createMcpHandler(gatewayFactory)` with no `legacy` option (i.e. `'stateless'`), plus an
explicit `gateway.legacyEra: 'stateless' | 'reject'` config field defaulting to
`'stateless'`. Stated as an assumption to be confirmed by the human at the Sprint 0 gate;
if the human prefers the strict posture, this ADR is amended before Sprint 1.

The flag is not speculative: the era choice changes what D11 and the MRTR work mean, so it
belongs next to the config rather than in code.

## Consequences

- The gateway must maintain a capability advertisement that is honest for **both** eras. A
  `server/discover` reply only exists on the modern path; on the legacy path the same
  factory answers `initialize`. The factory therefore cannot vary by era for the tool set —
  only the `McpRequestContext.era` field tells it which era it is building for.
- E2E tests in S2.6 must run **twice**: once with `versionNegotiation: { mode: { pin:
  '2026-07-28' } }` (asserting `ttlMs`, `cacheScope`, `resultType`) and once with a default
  client (asserting the 2025 shape). This is new work not present in PLAN.md §7.
- `spikes/probe-compat.mjs` is the harness template for both legs.
- PLAN.md §5's "capabilities derived from what healthy upstreams provide" must hold on both
  paths; the legacy path answers `initialize` from the SDK, so the factory's declared
  `capabilities` are what Claude sees there.
- Nothing in this ADR permits `ping`, `logging/setLevel`, `notifications/roots/list_changed`
  or `resources/subscribe` to be adopted (they are removed or deprecated in 2026-07-28).

## Open items

- If the human wants strict 2026 only, Claude connectivity is lost and PLAN.md §1's target
  audience must be revised. Flagged for the gate.
- The `legacy: 'stateless'` leg answers GET/DELETE with `405` and oversize bodies with
  `413` using JSON-RPC code `-32000` — the sub-range the spec says new implementations
  SHOULD NOT use. Not ours to change (the SDK chooses it), but worth knowing before
  PLAN.md §8's error-mapping table is finalised.