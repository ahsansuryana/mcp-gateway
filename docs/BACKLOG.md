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
## From Sprint 4

| ID | Item | Origin | Suggested home |
|---|---|---|---|
| B-29 | **The Docker daemon is a remote Linux host (Armbian), not Docker Desktop.** `F:\mcp-gateway` cannot be bind-mounted into a Linux container (`-v F:\mcp-gateway:/work` fails with `invalid mount path: 'F:/mcp-gateway' mount path must be absolute`). Source must travel via the build context (`docker build`), `docker cp`, or a tar stream into the container. Under MSYS/Git Bash, `tar` and `docker` mangle absolute POSIX arguments — `MSYS_NO_PATHCONV=1` is required. Confirmed again in Sprint 7: `docker build` works from the Windows context against the remote daemon, but there is no `docker` binary inside a container. | S4 Linux verification | S7.4 / CI |
| B-28 | **CLOSED in Sprint 7** — ADR 0010. `procps` is installed in the shipped image; the choice was made by running the same probe in two real images (with and without it). Original item: `tree-kill` builds a POSIX process tree with `ps --ppid`, absent from `node:24-bookworm-slim`; the `spawn ps ENOENT` is raised inside the dependency's own error handler where a `try/catch` cannot reach it. | S4.5 / Q-PROCPS | **CLOSED in S7.4** |

## From Sprint 4 follow-up (pre-Sprint 5)

| ID | Item | Origin | Suggested home |
|---|---|---|---|
| B-30 | **B-24 integrity pass — DONE at the Sprint 5 gate.** Closed in `f627199`: closed subscriptions now withdraw their `listChanged` contribution, and `prompts`/`resources` list-changed events are actually relayed. Kept here for traceability only. | human instruction | closed |

## From Sprint 5

| ID | Item | Origin | Suggested home |
|---|---|---|---|
| B-31 | **403 / `insufficient_scope` step-up is not implemented.** The spec says a client SHOULD respond to a runtime insufficient-scope challenge with a step-up authorization: compute the union of previously granted scopes and the challenge's, re-authorize, retry a few times, then treat it as permanent. v1 has no interactive surface, so the gateway cannot do this. | `docs/ref/oauth-flow.md` § 8 | S6 / S7, needs a UX decision |
| B-32 | **Operator documentation for `GATEWAY_TOKEN_KEY` is missing.** Losing the key makes every stored token unrecoverable; leaking it exposes all of them. `docs/SECURITY.md` needs a key-management section, and `gateway.example.json` should show the variable. | S5.2 / S5 risk review | S7.5 |
| B-33 | **Token-store key rotation is not supported.** `TokenStore` accepts one key; there is no re-encryption path for a rotated key. | S5.2 | S7 hardening |
| B-34 | **`application_type` and `clientMetadataUrl` are not in PLAN.md §6.** The gateway derives CIMD's URL from `publicUrl` rather than configuring it, so §6 stayed authoritative, but §6 should eventually be amended by hand (rule: the agent does not edit §6). | S5.1 § 11.3 | S6 / §6 amendment by human |

## Sprint 6 gate (human decisions, 2026-10-10)

| ID | Item | Origin | Suggested home |
|---|---|---|---|
| S5-MANUAL | **Sprint 5 manual test against a real OAuth server — DEFERRED by human decision until Q4 is deployed.** The full checklist is already written: `docs/reports/sprint-5-manual-test.md` (target Notion's `https://mcp.notion.com/mcp`, with the live metadata captured). Not a Sprint 6 blocker. | human decision at the Sprint 6 gate | run once the gateway is deployed behind `publicUrl` |
| S5-LINUX | **CLOSED 2026-10-10.** The cause was a VPN on the human's side; with it off the remote Docker host answered again. Linux run on `node:24-bookworm-slim` (v24.21.0, aarch64, Armbian 25.5.1): typecheck 0, lint 0, **246 tests passed / 20 files**, `npm audit` 0 vulnerabilities. 246 vs Windows' 245+1-skipped because the POSIX-only `chmod 0600` token-store assertion — the one thing that had never run on the platform exercising it — ran and passed. Evidence in `docs/reports/sprint-7.md`. | Sprint 7 P7-1 | **CLOSED** |

## From Sprint 7

| ID | Item | Origin | Suggested home |
|---|---|---|---|
| B-35 | **Lazy (mixed) authentication is not implemented.** Claude supports a connector mode where `initialize`, `tools/list` and public tool calls succeed with NO credential, and sign-in is requested only when a protected tool is reached. The gateway rejects every unauthenticated `POST /mcp` with 401, which is Claude's "Sign in now" mode — supported and correct, but different. Supporting lazy auth needs per-tool auth policy: which tools are public, where that lives in config, and what a not-signed-in user sees in `tools/list`. None of that exists in PLAN.md. | S7 P7-2, `docs/ref/claude-connector-requirements.md` § 4b | future sprint, needs a design decision first |
| B-36 | **Scope step-up (403 insufficient_scope) still not implemented.** Anthropic documents that a `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` triggers Claude to re-authorize with the UNION of the challenge scopes and the discovery scopes. The gateway has no insufficient-scope path at all. Depends on B-31. | S7 P7-2 | S6/S7 follow-up |

## From Sprint 7 (S7)

| ID | Item | Origin | Suggested home |
|---|---|---|---|
| B-37 | **Rate-limit buckets do not distinguish OAuth subjects.** The bucket key is the literal `'static-bearer'` for the static path. An OAuth caller is verified per request but every OAuth caller shares one bucket, so one noisy tenant can exhaust the allowance for all of them. Fixing it needs the verified `sub` (or a fallback for a token with no `sub`) threaded from `ResourceServer.verify` into the HTTP layer. | S7.2 | S7 follow-up / S8 |
