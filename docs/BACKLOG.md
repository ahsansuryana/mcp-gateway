# BACKLOG

Work noticed during a sprint that belongs to a later sprint, or that no sprint currently
owns. PLAN.md §3 rule 8: anything out of scope goes here instead of into code.

## From Sprint 0

| ID | Item | Origin | Suggested home |
|---|---|---|---|
| B-01 | E2E suite must run twice: modern client (`versionNegotiation: { mode: { pin: '2026-07-28' } }`) and default 2025-era client, asserting the 2025 shape as well as `ttlMs`/`cacheScope`/`resultType` | `docs/adr/0002-protocol-compatibility.md` | S2.6 |
| B-02 | Gateway's own `Client` instances toward upstreams must decide their era: `mode: 'auto'` tolerates a 2025-only upstream; `{ pin: '2026-07-28' }` does not | `docs/SDK-NOTES.md` (j) | S2.2 |
| B-03 | `ClientOptions.cachePartition` must be set per inbound principal so D11's `"private"` scope is not shared between gateway clients | `docs/SDK-NOTES.md` (e) | S2.2 / S6.2 |
| B-04 | Explicit `maxToolResultChars` guard (~150,000) for claude.ai consumption | `docs/ref/claude-limits.md` | S7 hardening |
| B-05 | Client MUST support the `x-mcp-header` annotation (spec requirement); the SDK client does it, but the **gateway** is a server, and a proxied tool's `inputSchema` may carry the annotation — decide whether to strip, forward, or reject | `docs/ref/spec-2026-07-28-basic-transports-streamable-http.md` | S2.3 |
| B-06 | Decide whether the gateway validates the mirrored `Mcp-Method` / `Mcp-Name` / `Mcp-Param-*` headers itself, or trusts `createMcpHandler` to do it. The spec makes it the intermediary's obligation if it routes on them | same page | S2.5 |
| B-07 | `X-Accel-Buffering: no` on SSE responses + SSE comment keep-alives matter behind nginx; the SDK sets keep-alives (`keepAliveMs`, default 15000) — confirm the proxy header story | `docs/ref/spec-2026-07-28-basic-transports-streamable-http.md` | S7.4 |
| B-08 | `requestState` integrity: if the gateway ever mints its own state, `createRequestStateCodec` (HMAC-SHA256) is the SDK helper. Currently the gateway keeps no state, so this is only needed if Q-MRTRPROXY option (B) is ever chosen | `docs/SDK-NOTES.md` (f) | S3.5 (if needed) |
| B-09 | S4.2 env-isolation assertion must be "no gateway secret present", not "child env ⊆ allowlist" — Windows injects `LOGONSERVER` / `USERDOMAIN` | `docs/OPEN-QUESTIONS.md` Q-WINDOWS-ENV | S4.2 |
| B-10 | `cwd` is an opencode-supported local-upstream field that §6 lacks; consider adding it | `docs/ref/opencode-mcp-config.md` | S1.2 (ADR if added) |
| B-11 | Zod v4 JSON-Schema export API must be verified before S1.5's `gen:schema` | `docs/OPEN-QUESTIONS.md` Q-ZODJSON | S1.5 |
| B-12 | `oauth.clientMetadataUrl` for the Client ID Metadata Document path is missing from §6 | `docs/OPEN-QUESTIONS.md` Q-DEVNAMES | S5.3 |
| B-13 | Confirm `npm audit` at every sprint end (PLAN.md §8) — Sprint 0 result was clean for the spikes tree | PLAN.md §8 | every sprint |

## From Sprint 3

| ID | Item | Origin | Suggested home |
|---|---|---|---|
| B-24 | The gateway ignores an upstream's `honoredFilter`. An upstream that answers `subscriptions/listen` with a smaller filter than requested is silently treated as subscribed. Branch on `honoredFilter` and log a warning when it is narrower than asked. | S3.4 | S3.4 follow-up |
| B-25 | `UpstreamManager.stop()` now emits status transitions so a stop is observable as a merged-list change. `Upstream.stop()` is also the place `RemoteUpstream` could emit directly; today only the manager does, which means a directly-stopped upstream is invisible. | S3.4 | S4.3 |
| B-26 | The gateway's upstream client declares `capabilities: { elicitation: {} }` because MRTR requires it. If sampling or roots ever need relaying, the same declaration must be extended; both are deprecated in 2026-07-28. | S3.5 | S5 |
| B-27 | `resources/templates/list` is deliberately not implemented and not advertised (non-goal). A test asserts the string `templates` never appears in the advertised capabilities. | S3.1 | — |

## Answers still owed by the human (PLAN.md §9)

- **Q1** — support legacy HTTP+SSE upstreams? Sprint 0 evidence: deprecated by the spec,
  Claude still supports it, the SDK v2 client exports `SSEClientTransport`. Default remains
  "no".
- **Q2** — **decided** at the Sprint 0 gate: `gateway.legacyEra` config field, default
  `'stateless'`. See `docs/adr/0002-protocol-compatibility.md`.
- **Q3** — Sprint 6 architecture. Still open. Gate S6.0.
- **Q4** — hosting target and public hostname. Still open, and now a hard requirement for
  claude.ai connectors (`docs/ref/claude-limits.md`).
- **Q5** — is the `io.modelcontextprotocol/tasks` extension needed? Still open
  (`docs/OPEN-QUESTIONS.md` Q-TASKS-EXT).

## From Sprint 1

| ID | Item | Origin | Suggested home |
|---|---|---|---|
| B-14 | `src/index.ts` and the `serve` command do not exist yet; `dev`/`start` currently launch the CLI, which only implements `validate`. | `docs/OPEN-QUESTIONS.md` Q-SERVE-CMD | S2.5 |
| B-15 | Decide the CORS posture for the Sprint 6 OAuth well-known routes. `@modelcontextprotocol/express` ships `cors` and `mcpAuthMetadataRouter` serves permissively; `/mcp` deliberately has no CORS middleware. | `docs/OPEN-QUESTIONS.md` Q-CORS | S6.1 |
| B-16 | Regenerate `gateway.schema.json` in CI and fail the build on drift, so the committed schema can never diverge from `src/config/schema.ts`. | S1.5 | S7.5 |
| B-17 | The dev-time Node floor is `>=20.19.0` (ESLint 10's `engines`), above the SDK's `>=20`. If a Node 20.0–20.18 target is ever required, ESLint must be pinned to v9. Recorded in `package.json#engines`. | S1.1 | — |
| B-18 | `substitute()` deep-copies every plain object and array it walks. That is correct for a config document but means callers must not rely on object identity after substitution. | S1.2 | — |

## From Sprint 2

| ID | Item | Origin | Suggested home |
|---|---|---|---|
| B-19 | The Inspector CLI, on a tool that returns `isError: true`, exits with a non-zero code and prints a libuv assertion on Windows teardown (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`). The JSON result itself is correct. Not a gateway defect, but it makes Inspector transcripts noisier than expected. | `spikes/out-spike-4.txt` | note only |
| B-20 | `RemoteUpstream` holds ONE long-lived `Client` per upstream and reuses it for every call. That matches PLAN.md §5 (stateless gateway) but means a long-idle upstream keeps its transport open. Consider an idle-reconnect policy together with S4.3's lifecycle work. | S2.2 | S4.3 |
| B-21 | `UpstreamManager` retries a `failed` upstream at most once per 30 s, triggered by incoming traffic (S2.1). S4.3 reuses the same rule for stdio upstreams; verify they share one implementation rather than two. | S2.1 / S4.3 | S4.3 |
| B-22 | The gateway currently never sets `tools.listChanged`, so a `tools/list` consumer must poll or rely on `ttlMs`. S3.4 turns this on. | S2.4 | S3.4 — **CLOSED in S3.4** |
| B-23 | `x-mcp-header` tool-parameter mirroring (B-05) is still undecided; the gateway currently forwards `inputSchema` verbatim, including any `x-mcp-header` annotation. A client that honours it will send `Mcp-Param-*` headers the gateway does not validate. | S2.3 | S2.5/S3 |