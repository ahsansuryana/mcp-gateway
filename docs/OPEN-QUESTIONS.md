# OPEN-QUESTIONS.md

Sprint 0 findings that are **not** settled, or where PLAN.md and a primary source
disagree. Rule 3 of PLAN.md §3: nothing here was guessed; everything unverified landed
here instead of in code.

Status legend: `BLOCKING` = a Sprint 1+ task cannot start correctly until answered.
`NON-BLOCKING` = can proceed with a documented default.

---

## Q-MRTRPROXY — IMPLEMENTED in Sprint 3 (S3.5); PLAN.md §5 needs amending

**What.** PLAN.md §5 `tools/call` says to forward `_meta` entries and to forward an
`input_required` result unchanged, "including `requestState`". It does **not** say that the
gateway's `tools/call` handler must re-attach `inputResponses` and `requestState` to the
*upstream* call.

**Evidence.** The SDK server seam lifts both fields out of `params` before the handler runs
(`ctx.mcpReq.inputResponses`, `ctx.mcpReq.requestState()`); they are siblings of
`arguments` on the wire, not `_meta` entries
(`docs/ref/spec-2026-07-28-server-tools.md` lines 209-232). A handler that forwards only
`name` + `arguments` loses both.

**Observed.** `spikes/spike-1.mjs` first run:

```
[gateway-client] elicitation/create => Proceed?      (x10)
MRTR error: Multi-round-trip request 'tools/call' still required input after 10 rounds (inputRequired.maxRounds)
```

After re-attaching:

```
[gateway] tools/call forward params keys = name,arguments,inputResponses,requestState
callTool upstream_needs_input => {"content":[{"type":"text","text":"upstream-mrtr:complete state=upstream-minted-state"}]}
```

**Why it blocks.** S3.5's acceptance test ("test proves the gateway forwards both
unchanged, including `requestState`, and keeps no state") is unimplementable as written.

**Options.**
- (A) Amend §5 to state that the handler must rebuild `{name, arguments, inputResponses?,
  requestState?}` from `ctx.mcpReq` and pass `allowInputRequired: true` upstream.
  Recommended — it is the only reading that matches the SDK.
- (B) Have the gateway mint its own `requestState` and strip the upstream's. Breaks
  upstream semantics; the upstream owns the state.
- (C) Ask the SDK whether a transport-level passthrough exists. None was found in the
  `.d.ts` surface.

**Implementation (Sprint 3).** `aggregateCallTool` now takes an `extra` argument carrying
`inputResponses` / `requestState`, and `RemoteUpstream.callTool` re-attaches them as SIBLINGS
of `arguments` — not inside `_meta` — with `allowInputRequired: true`.

**Second requirement §5 does not mention at all: the gateway's UPSTREAM client must declare
`elicitation`.** Without it the SDK server seam answers `-32021 MissingRequiredClientCapability`
to the upstream's own `input_required` result and the gateway never sees it. Found in Sprint 3
when the raw wire showed `{"result":{"content":[{"type":"text","text":"Upstream 'up' is
unavailable"}],"isError":true,...}}` instead of the relayed `input_required`.

**E2E proof (Sprint 3):** `test/e2e/sprint3.e2e.test.ts` asserts the upstream saw exactly one
elicitation round, the final result carries `state=alpha-minted-state`, and the upstream's
`onMrtrComplete` callback observed `requestState === 'alpha-minted-state'` — byte-exact.
A second call starts a fresh round, proving the gateway keeps no MRTR state.

**Still needed from the human:** amend PLAN.md §5 so the two requirements above are written
down. The code follows the evidence; the plan text still does not describe it.

---

## Q-SUBSFWD — IMPLEMENTED in Sprint 3 (S3.4); policy offered for ratification

**What.** `createMcpHandler`'s `notify` facade publishes ONLY to that handler's own
subscription streams. Nothing connects an upstream's bus to a downstream handler's bus.

**Evidence.** `spikes/out-probe-subscriptions.txt`:

```
publishing on the UPSTREAM bus...
notifications after upstream publish => ["tools/list_changed"]   <-- unchanged
```

**Why it blocks.** S3.4 as written ("the gateway subscribes to upstream list-changed
events and fans them out") is real work, not a wiring detail. Confirmed surface to use:
`client.listen(filter)` upstream + `handler.notify.toolsChanged()` downstream.

**Implemented policy** (`src/server/subscriptions.ts`, `DEBOUNCE_MS = 250`):

1. Bursts inside 250 ms coalesce into ONE `notifications/tools/list_changed`.
2. An UPSTREAM push event is ALWAYS relayed after the recompute — the upstream may have
   changed a description or a schema that the gateway cannot see in the name set.
3. A STATUS transition notifies only when the merged name set really changed, so repeated
   flapping between `ready` and `error` cannot spam clients.

**Two further findings Sprint 3 had to fix, both of which are PLAN.md-level lessons:**

- `Client.listen()` only OPENS the stream. Notifications dispatch to
  `setNotificationHandler` registrations, so an implementation that calls `listen()` alone
  silently receives nothing. `Upstream.onListChanged` was added to the contract for this.
- A server that declares `tools.listChanged: false` answers the `subscriptions/listen` ack
  with an EMPTY honoured filter and delivers nothing. Consumers must read
  `honoredFilter`, which the gateway currently does not branch on.

**Decision needed from the human:** ratify or replace the policy above, especially whether an
upstream push should be relayed unconditionally (point 2) or only when the name set differs.

---

## Q-TOOLNAME — BLOCKING (Sprint 2, S2.3 — D4's 64-char rule)

**What.** D4 skips any tool whose namespaced name exceeds 64 characters, "common client
limit of 64 chars (verify in Sprint 0)". The verification contradicts itself.

**Evidence.**

| Source | Limit |
|---|---|
| <https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools> (fetched 2026-10-10) | `name` "Must match the regex `^[a-zA-Z0-9_-]{1,128}$`" |
| <https://docs.anthropic.com/en/docs/build-with-claude/tool-use/implement-tool-use> | `^[a-zA-Z0-9_-]{1,64}$` |
| Real 400s in the wild, e.g. <https://github.com/anthropics/claude-code/issues/3102>, <https://github.com/anthropics/claude-code/issues/20830> | `String should have at most 64 characters` |
| <https://claude.com/docs/connectors/building> | no tool-name length documented at all |

**Assessment.** The **enforced** limit is 64 (server-side validation errors prove it), even
though the current prose says 128. 64 is also the conservative choice and is what D4
assumes.

**Options.**
- (A) Keep D4's 64. Safe; loses a handful of tools that would fit in 128.
- (B) Raise to 128 and document the observed 64 failures. Matches prose, breaks in practice.
- (C) Make it configurable (`gateway.maxToolNameLength`, default 64).

**Recommendation: keep 64, optionally with (C).** Not changed without a decision.

---

## Q-COMPAT — DECIDED at the Sprint 0 gate (resolves PLAN.md Q2)

**What.** PLAN.md §9 Q2 asks whether to serve 2025-era clients. The evidence was settled in
Sprint 0 (`docs/adr/0002-protocol-compatibility.md`); the **shape** is now decided.

**Decision.** `gateway.legacyEra: 'stateless' | 'reject'` exists in the config schema
(default `'stateless'`). Implemented in S1.2; consumed by `server/mcp.ts` in Sprint 2.

**Still open (carried into Sprint 2, not blocking Sprint 1).** The 2025-era wire codec has
no `resultType` / `ttlMs` / `cacheScope` path and no `input_required` vocabulary, so D11 and
the MRTR work are 2026-only in practice. See `docs/BACKLOG.md` B-01.

---

## Q-HDRPREC — NON-BLOCKING (Sprint 2, §6 config semantics)

**What.** PLAN.md §6: "`headers` and `oauth` together on one upstream: allowed; static
headers are sent on every request, OAuth adds `Authorization` only if no static
`Authorization` header is set."

**Evidence.** The SDK's actual precedence is the other way round
(`spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts`, `requestInit` doc
comment, lines 3411-3419): the transport-managed `Authorization` (from `authProvider`)
takes precedence, and a caller-supplied `Authorization` "is therefore only sent while the
provider has no token".

**Options.**
- (A) Document the SDK behaviour as the contract and drop §6's sentence.
- (B) Keep §6's sentence and implement the priority ourselves (strip `Authorization` from
  `headers` when `oauth` is configured). Small, explicit, matches the plan author's intent.

**Recommendation: (B)** — it matches the stated intent and costs one line.

---

## Q-ZODJSON — RESOLVED in Sprint 1 (S1.5)

**Question.** PLAN.md §6 requires exporting `gateway.schema.json` from the zod schema and
says "verify the zod v4 API for this".

**Answer.** zod v4 exports `toJSONSchema`. Verified against
`node_modules/zod/v4/core/to-json-schema.d.cts` and exercised by
`scripts/gen-schema.ts` (`npm run gen:schema`, wired in S1.5).

```ts
z.toJSONSchema(schema, {
  target: 'draft-2020-12',   // default; also the MCP spec's dialect for tool input schemas
  io: 'input',               // describe what a human writes, so defaults stay "default"
});
```

`unrepresentable` defaults to `"throw"`, `cycles` to `"ref"`. `override` is available for
custom post-processing. Generated output puts the D4 upstream-name regex into
`propertyNames`, so the strict-object rules survive into editor tooling.

**Resolved.** No action needed. `gateway.schema.json` is committed and regenerable with
`npm run gen:schema`.

---

## Q-OAUTH-RUN — BLOCKING (Sprint 5)

**What.** The `OAuthClientProvider` interface and the helper functions were read from the
`.d.ts` (see `docs/SDK-NOTES.md` (i)) but **no authorization server was available in Sprint
0**, so nothing was executed.

**Specifically unverified.** The exact handshake between `auth()` /
`startAuthorization()` / `exchangeAuthorization()` / `refreshAuthorization()` and a real
server; the Client ID Metadata Document path (`clientMetadataUrl` + `resolveClientMetadata`);
the `iss` (RFC 9207) rejection path; per-issuer credential keying via
`OAuthClientInformationContext.issuer`.

**Plan.** S5.1 already requires reading the authorization pages end to end; the agent will
verify against the SDK then, and against a fake in-repo AS for S5.6.

---

## Q-WINDOWS-ENV — NON-BLOCKING (Sprint 4, S4.2)

**What.** On Windows the child's environment is **not** a subset of the SDK allowlist.
`spikes/out-spike-2.txt` shows `LOGONSERVER` and `USERDOMAIN` present in the child although
they are not in `DEFAULT_INHERITED_ENV_VARS` and not in the caller's `env` — Windows injects
them.

**Consequence.** An S4.2 test of the form "child env keys ⊆ allowlist" fails on Windows.
The correct assertion is "no gateway secret is present in the child env"
(`gatewaySecretLeaked: false` in the spike).

**No decision needed** unless the human wants a stricter allowlist posture.

---

## Q-TASKS-EXT — NON-BLOCKING (PLAN.md Q5)

**What.** The `io.modelcontextprotocol/tasks` extension is out of scope for v1 (PLAN.md
§1). Sprint 0 confirms the SDK ships tasks surface anyway
(`CancelTaskRequest`, `GetTaskRequest`, `tasks/update`, `TaskAugmentedRequestParams`),
because the extension is now official.

**Question to the human (PLAN.md Q5, still unanswered):** is the tasks extension needed for
any upstream the gateway will actually be pointed at? If not, it stays out of scope and the
gateway simply never advertises `tasks`.

---

## Q-DEVNAMES — NON-BLOCKING (Sprint 5/6, §6 `oauth` shape)

**What.** PLAN.md §6 says `oauth` is `false` or an object with `clientId?`, `clientSecret?`,
`scope?`. opencode's docs agree exactly
(`docs/ref/opencode-mcp-config.md`). But the SDK's provider interface also needs
`clientMetadataUrl` for the Client ID Metadata Document path, which the current schema
cannot express.

**Options.**
- (A) Add `clientMetadataUrl?: string` to the `oauth` object now (Sprint 1).
- (B) Add it in Sprint 5 via an ADR when the schema change is actually needed.

**Recommendation: (B)** — keeps §6 stable for now; noted here so Sprint 5 does not
discover it late.

---

## Resolved during Sprint 0 (kept for the record)

| Question | Resolution |
|---|---|
| Does the SDK v2 server serve 2025-era clients for free? | Yes — `legacy: 'stateless'` is the `createMcpHandler` default, same factory, same endpoint. `mcp-handler` is not needed. → `docs/adr/0002-protocol-compatibility.md` |
| Does an SDK env allowlist helper exist (D13)? | Yes — `getDefaultEnvironment()`; a caller `env` is merged ON TOP, never a replacement. No ADR needed. |
| Which web layer (D16)? | Express + `@modelcontextprotocol/express` middleware + `createMcpHandler`/`toNodeHandler`. → `docs/adr/0001-http-layer.md`. **Approved at the Sprint 0 gate**; dependencies installed in S1.1. |
| Are `inputResponses` / `requestState` inside `_meta`? | No — siblings of `arguments` in the request params. See Q-MRTRPROXY. |
| Is `resources/subscribe` still a thing? | Replaced by `subscriptions/listen`; `Client.listen()` throws `MethodNotSupportedByProtocolVersion` on a 2025-era connection. |

---

## New in Sprint 1

## Q-CORS — NON-BLOCKING (Sprint 2, S2.5)

**What.** `@modelcontextprotocol/express` depends on `cors ^2.8.5`, and
`mcpAuthMetadataRouter` serves its discovery documents "with permissive CORS". The gateway
binds `0.0.0.0` by default and is meant to be reached from claude.ai, Claude Desktop and
Claude Code — none of which are browsers.

PLAN.md §8 says "no wildcard CORS by default", which this satisfies by NOT adding CORS
middleware for `/mcp`. But the two OAuth discovery routes in Sprint 6 will be
cross-origin to a browser-based client, and the question of what CORS policy they need has
not been answered.

**Decision needed (Sprint 6, not Sprint 2):** whether the well-known OAuth metadata routes
get a restricted CORS allowlist, and what the allowlist is.

---

## Q-SERVE-CMD — RESOLVED in Sprint 2

Sprint 1 deliberately did not create `src/index.ts` (PLAN.md rule 7 forbids placeholder
code behind a `dev`/`start` script). Sprint 2 S2.5 created it and it wires the full stack:
`loadConfig` -> `createLogger` -> `UpstreamManager` -> `buildHttpApp` -> listen, with
SIGINT/SIGTERM shutdown. The gateway is demonstrably serving (see
`spikes/out-spike-4.txt` and the 20-test E2E suite).
---

## Q-PROCPS — tree-kill needs `ps` on Linux (found in Sprint 4)

`tree-kill` builds a POSIX process tree with `ps --ppid`, which lives in the `procps`
package. Minimal container images do not ship it: running the suite on
`node:24-bookworm-slim` produced `spawn ps ENOENT`, raised from inside the dependency's
own error handler where a `try/catch` cannot intercept it.

The gateway now probes for `ps` once and degrades to a direct-child `SIGKILL`, logging
`process tree kill degraded to direct child` at `warn` so the limitation is never
silently claimed as a full tree kill.

**Not a question for the gateway itself** — the behaviour is decided and documented in
`docs/SECURITY.md`. What remains open is whether the project should document `procps` as
a runtime dependency of the container image, and whether a `Dockerfile` will be shipped at
all (currently the Linux test path is `node:24-bookworm-slim` driven by hand).

**Decision needed (deployment, not Sprint 4):** add `procps` to any image used in
production, or drop the tree-kill escalation and rely on the SDK's direct-child close.

---

## Q-CIMD — Client ID Metadata Documents are blocked by Q4 (found in Sprint 5 S5.1)

S5.1 (`docs/ref/oauth-flow.md` § 3.1, § 9 R2–R5) establishes that the Client ID Metadata
Document path requires the client to **host a publicly reachable `https` document** and to use
that URL as `client_id`.

The gateway's `gateway.publicUrl` is unset because **Q4** (hosting target and public hostname)
is still open, and inventing a hostname is forbidden.

**What this blocks:** an authorization server that supports *only* CIMD cannot be used. ASes
that offer `registration_endpoint` (DCR) or accept a pre-registered `clientId` still work.

**What is NOT blocked:** the localhost redirect URI. The spec's own CIMD example lists
`http://localhost:3000/callback` as acceptable
(`docs/ref/spec-2026-07-28-basic-authorization-client-registration.md` line 64). The blocker is
specifically the *metadata document*, which must be `https` and publicly reachable.

**Options:**

- (a) Answer Q4 and set `publicUrl`. The gateway then serves
  `GET /.well-known/oauth-client.json` and CIMD works fully.
- (b) Keep CIMD disabled and rely on DCR, documenting that CIMD-only ASes are unsupported.
  Accepts the deprecation the spec warns about for DCR.
- (c) Allow an operator-supplied static `clientMetadataUrl` pointing at a document they host
  themselves. Keeps the gateway from having to be publicly reachable, but the operator owns
  the hosting and its TLS.

**Decision needed (human, before CIMD can be exercised):** which of (a), (b) or (c).

---

## Q-SDK-RESOURCE — the SDK sends no `resource` parameter (found in Sprint 5 S5.6)

The spec is unambiguous:

> "MCP clients **MUST** implement Resource Indicators for OAuth 2.0 … The `resource`
> parameter: 1. **MUST** be included in both authorization requests and token requests …"
> "MCP clients **MUST** send this parameter regardless of whether authorization servers
> support it."
> — verified: `docs/ref/spec-2026-07-28-basic-authorization-index.md` lines 219-222 and 254

Measured against the in-repo fake authorization server (`test/fixtures/fake-auth-server.ts`),
which advertises `resource` in its protected-resource metadata:

- the authorization URL the SDK builds contains **no** `resource` query parameter;
- the token request contains **no** `resource` parameter either
  (`test/integration/oauth-flow.integration.test.ts`, "S5.6 resource parameter — SDK
  DEVIATION, recorded" — the test asserts the observed defect on purpose).

`@modelcontextprotocol/client` 2.3.1 was used for the measurement.

**Why the gateway does not work around it.** Making `resource` appear would mean
constructing the authorization URL and the token request body by hand. The human's S5.3
instruction is explicit: do not implement PKCE, discovery or token exchange by hand if the
SDK does it, and justify any hand-rolled part in an ADR. This is a judgement call that
belongs to the human, not to the implementation agent.

**Options:**

- (a) Ship as is and log the deviation. Authorization servers that require `resource` (RFC
  8707 "MAY be required") will reject or issue over-broad tokens.
- (b) ADR permitting a narrow hand-rolled `resource` parameter on top of the SDK.
- (c) Ask the SDK team whether this is a bug in 2.3.1 and track a fix.

**Decision needed (human):** (a), (b) or (c).

---

## Q-SDK-REFRESH — `auth()` defeats the 60s refresh skew (found in Sprint 5 S5.6, worked around)

PLAN.md S5.5 asks for a refresh **60 seconds before** expiry. The SDK's `auth()` orchestrator
decides between the refresh grant and a fresh authorization using its own expiry check, so a
token inside the gateway's skew window is judged by a different rule.

Measured against the S5.6 fake with a token 5 seconds from expiry: `auth()` returned
`REDIRECT`, i.e. it asked for a **new user consent** instead of using the refresh token the
gateway already held.

**Worked around, not hand-rolled.** `refreshIfNeeded` calls the SDK's own
`refreshAuthorization()` free function instead of `auth()`:

> verified: `node_modules/@modelcontextprotocol/client/dist/index.d.mts`
> (`refreshAuthorization` — "Exchange a refresh token for an updated access token")

The gateway still owns *when* to refresh (the 60s skew); the SDK still owns *how*.

**No decision needed** unless the human prefers a single `auth()` entry point. Recorded for
traceability.
