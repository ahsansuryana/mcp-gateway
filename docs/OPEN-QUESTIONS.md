# OPEN-QUESTIONS.md

Sprint 0 findings that are **not** settled, or where PLAN.md and a primary source
disagree. Rule 3 of PLAN.md §3: nothing here was guessed; everything unverified landed
here instead of in code.

Status legend: `BLOCKING` = a Sprint 1+ task cannot start correctly until answered.
`NON-BLOCKING` = can proceed with a documented default.

---

## Q-MRTRPROXY — BLOCKING (Sprint 3, S3.5)

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

**Decision needed from:** the human (rule 5, no silent decisions).

---

## Q-SUBSFWD — BLOCKING (Sprint 3, S3.4)

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

**Open sub-question.** With N upstreams, does the gateway emit one `toolsListChanged` per
upstream change, or coalesce? Debounce policy is unspecified in PLAN.md.

**Decision needed from:** the human (fan-out policy + debounce).

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

## Q-SERVE-CMD — NON-BLOCKING (Sprint 2)

**What.** PLAN.md §5 lists `src/index.ts` ("serve entrypoint"). Sprint 1 deliberately did
NOT create it, because S1.1's `dev`/`start` scripts must not point at placeholder code
(PLAN.md rule 7). `package.json` currently has:

- `dev` -> `tsx src/cli.ts`
- `start` -> `node dist/cli.js`

and `USAGE` states "Commands not yet available: serve (arrives with Sprint 2)".

**Decision needed:** confirm that `serve` lands in S2.5 (`server/http.ts` + `server/mcp.ts`)
and that `src/index.ts` is created then. If the human expects `serve` to exist in Sprint 1,
that is a scope addition, not a bug.