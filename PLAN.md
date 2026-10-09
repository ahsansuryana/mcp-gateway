# MCP Gateway — PLAN.md

Plan date: 2026-10-10. Audience: a coding agent that will implement this project sprint by sprint.
Read this entire file before writing any code. Where this file and your memory of "how MCP works" disagree, this file and the primary sources it points to win.

---

## 1. Goal and non-goals

### Goal
A single Node.js service, `mcp-gateway`, that:

1. Reads ONE config file (`gateway.json`, opencode-style `mcp` section).
2. Exposes ONE MCP endpoint (`POST /mcp`, e.g. `https://mcp.app.com/mcp`).
3. Aggregates the tools, resources and prompts of N upstream MCP servers behind that endpoint, namespaced by upstream name.
4. Upstreams are either `remote` (Streamable HTTP URL) or `local` (child process started with a command such as `npx -y <pkg>`, talking over stdio).
5. Handles upstream authentication (static headers with secrets from env/file, later OAuth) and inbound authentication (static bearer keys first, OAuth later).

### Non-goals for v1 (do NOT build these unless an ADR in `docs/adr/` approves it)
- Sampling, Roots, Logging features (deprecated in spec 2026-07-28).
- The `io.modelcontextprotocol/tasks` extension.
- Per-user upstream credentials / multi-tenancy. One gateway = one identity toward each upstream.
- Resource templates aggregation (`resources/templates/list`).
- Legacy HTTP+SSE upstream transport (deprecated in the spec). See open question Q1.
- Any web UI.

---

## 2. Ground truth (verified when this plan was written)

Facts below were read from primary sources on 2026-10-10. Re-verify in Sprint 0 and record results in `docs/SDK-NOTES.md`.

- MCP spec revision `2026-07-28` is current. Source: https://modelcontextprotocol.io/specification/2026-07-28/changelog . Changes that shape this project:
  - Protocol-level sessions and the `Mcp-Session-Id` header are REMOVED. List endpoints no longer vary per connection. => The gateway is stateless; there is no session mapping to build.
  - The `initialize` / `notifications/initialized` handshake is REMOVED. Every request carries protocol version and client capabilities in `_meta` (`io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities`). Version mismatch returns `UnsupportedProtocolVersionError`.
  - `server/discover` is a REQUIRED RPC for servers (advertises versions, capabilities, identity).
  - `resources/subscribe` and the HTTP GET stream are replaced by `subscriptions/listen` (a long-lived POST-response stream; clients opt in to `toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions`).
  - `ping`, `logging/setLevel`, `notifications/roots/list_changed` removed.
  - Server-initiated requests (`sampling/createMessage`, `elicitation/create`, `roots/list`) are replaced by Multi Round-Trip Requests (MRTR): a server returns a result with `resultType: "input_required"` and `inputRequests`; the client retries the original request with `inputResponses` (and `requestState` if provided). Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
  - Every result carries a required `resultType` (`"complete"` | `"input_required"`). Results from older servers that omit it MUST be treated as `"complete"`.
  - SSE resumability (`Last-Event-ID`) removed. A broken stream loses the in-flight request; the client re-issues it.
  - `tools/list`, `prompts/list`, `resources/list`, `resources/read`, `resources/templates/list` results require `ttlMs` and `cacheScope` (`"public"` | `"private"`). `tools/list` SHOULD be deterministically ordered.
  - Streamable HTTP POST requests require the headers `Mcp-Method` and `Mcp-Name`.
  - Resource-not-found error code changed from `-32002` to `-32602`. Spec-reserved error range is `-32020..-32099`; `-32000..-32019` is implementation-defined.
  - OAuth: Dynamic Client Registration (RFC 7591) is DEPRECATED in favor of Client ID Metadata Documents; clients MUST key persisted credentials by authorization-server issuer and MUST validate `iss` (RFC 9207) when present.
- TypeScript SDK v2 is the stable line, released alongside spec 2026-07-28. Packages: `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, optional middleware `@modelcontextprotocol/node`, `@modelcontextprotocol/express`, `@modelcontextprotocol/hono`. Zod v4. v1 (`@modelcontextprotocol/sdk`) gets fixes for at least 6 months after v2. Sources: https://github.com/modelcontextprotocol/typescript-sdk , https://ts.sdk.modelcontextprotocol.io/v2/
- A third-party package (`mcp-handler@2`) states v2 requires Node.js >= 20 and Zod 4, and serves 2025-era stateless Streamable HTTP clients through a compatibility layer. The plan author did NOT verify whether the official SDK v2 server offers the same compatibility. See Sprint 0 task S0.3(j).

### NOT verified by the plan author (Sprint 0 must verify, do not assume)
- Exact v2 API names/signatures for: low-level request handlers, HTTP transport wiring, client transports, OAuth client provider, subscriptions.
- The exact opencode MCP config field names (the schema in §6 is modeled on the author's recollection of opencode's `mcp` section).
- Which protocol versions real clients (claude.ai custom connectors, Claude Code, opencode) speak today.

---

## 3. Hard rules for the implementing agent (anti-hallucination contract)

1. **Source hierarchy.** (1) MCP spec pages under https://modelcontextprotocol.io/specification/2026-07-28/ ; (2) the installed SDK's `.d.ts` files in `node_modules` and the v2 docs; (3) this PLAN. Never rely on training-data memory for MCP/SDK/OAuth APIs.
2. **Cite or don't write.** Every call into an external API (SDK, spec-defined field, node API with non-obvious semantics) gets a comment `// verified: <url or node_modules path>`. If you cannot cite it, you have not verified it.
3. **Unknown => stop, don't guess.** If something is unclear or missing, append it to `docs/OPEN-QUESTIONS.md` (what, why it blocks, options) and continue only with unblocked tasks. Never invent an API, option, header, error code, or package.
4. **Verify packages exist.** Before adding any dependency run `npm view <pkg> version` and read its README. Pin `@modelcontextprotocol/*` to exact versions.
5. **No silent decisions.** Section 4 lists fixed decisions. To change one, write `docs/adr/NNNN-title.md` (context, options, decision, consequences) and tell the human. Decisions marked GATE need human approval before proceeding.
6. **Run it or it didn't happen.** A task is done only when its acceptance commands were actually executed and passed. Paste the command and the tail of its output in the sprint report. Never claim tests pass without running them.
7. **No placeholder code.** No `TODO: implement`, no mocked success paths in `src/`. Fakes live only in `test/` and `spikes/`.
8. **Scope discipline.** Implement only the current sprint. If you notice work belonging to a later sprint, write it into `docs/BACKLOG.md`.
9. **Secrets.** Never log, echo, commit or put in an error message any secret value (API keys, tokens, header values, env values). Error messages may name the config key path (`mcp.github.headers.Authorization`), never the value.
10. **Git hygiene.** One branch per sprint (`sprint-N-<slug>`), one commit per task ID using Conventional Commits (`feat(upstream): S2.3 ...`). Do not commit `gateway.json` containing real secrets; commit `gateway.example.json` only.
11. **Report format.** At the end of each sprint produce `docs/reports/sprint-N.md`: tasks done, commands run + output tails, deviations, open questions, risks. Then STOP and wait for the human to say continue.

---

## 4. Fixed decisions

| ID | Decision | Reason |
|----|----------|--------|
| D1 | TypeScript (`strict`, `noUncheckedIndexedAccess`), ESM, Node >= 20 (confirm against SDK `engines`), npm, lockfile committed. | Matches SDK v2 requirements and the author's stack. |
| D2 | Use SDK v2 packages only. `@modelcontextprotocol/sdk` (v1) only via ADR. | v2 is stable and implements the current spec. |
| D3 | Aggregated mode only: one endpoint `POST /mcp`. No per-server path routing in v1. | Human chose aggregated. |
| D4 | Tool/prompt namespacing: `<server>_<name>`. Server names must match `^[a-z0-9-]{1,24}$` (no underscore) so splitting on the FIRST `_` is unambiguous. If the full name exceeds 64 chars, the tool is skipped and a warning is logged naming server and tool. | Common client limit of 64 chars for tool names (verify in Sprint 0); opencode uses the same `server_tool` convention. |
| D5 | Resource namespacing: rewritten URI `gw://<server>/<encodeURIComponent(originalUri)>`; `resources/read` decodes and routes. | Original URIs are arbitrary schemes and can collide. |
| D6 | Config is JSONC, file `gateway.json`, path from `--config <path>` or env `GATEWAY_CONFIG`, default `./gateway.json`. Parse with `jsonc-parser` (verify with `npm view`). | opencode-style config allows comments. |
| D7 | After parsing, substitute `{env:NAME}` and `{file:path}` inside every string value, THEN validate with zod (strict objects: unknown keys are errors). Missing env var or unreadable file => startup error naming the key path only. | Typos must fail loudly; secrets stay out of the JSON. |
| D8 | Failure isolation: one broken upstream never breaks the others. `tools/list` returns tools of healthy upstreams only; broken ones show in `GET /status`. | Gateway availability. |
| D9 | Inbound auth v1: static bearer keys, compared with `crypto.timingSafeEqual` on SHA-256 digests. `GET /healthz` unauthenticated and returns only `{"ok":true}`. `GET /status` requires auth. | Simple and safe starting point. |
| D10 | The gateway is stateless: no session store, no sticky routing. | Spec 2026-07-28 has no protocol sessions. |
| D11 | `cacheScope` is always `"private"` in v1. `ttlMs` = minimum upstream `ttlMs` among contributing upstreams, or `gateway.defaultTtlMs` (default 30000) if none provided one. | Safe default: the aggregate may include authenticated content. |
| D12 | Tool-execution failures caused by an upstream (down, timeout, needs auth) are returned as a tool result with `isError: true` and a short text; protocol-level problems (unknown tool, bad params) are JSON-RPC errors. Verify exact codes in the spec's tools page. | Lets the LLM see and react to the failure. |
| D13 | Local (stdio) upstreams start with an explicit environment allowlist (SDK default env helper if one exists + config `environment`), never the full `process.env`. | Prevents leaking gateway secrets into child processes. |
| D14 | Logging: `pino` JSON logs, with a redaction list covering `authorization`, `headers`, `environment`, `token`, `apiKey`, `secret`, `password`, `cookie`. | Secret safety. |
| D15 | Tests: `vitest`. Unit tests use no network. E2E tests spin up fake upstream servers built with the SDK inside `test/fixtures/`. | Deterministic CI. |
| D16 | Web framework: Express with the SDK's Express middleware if it exists and fits; otherwise `@modelcontextprotocol/node` with Node `http`. Decide in Sprint 0 from evidence, record in an ADR. | The author knows Express; SDK middleware reduces custom transport code. |

---

## 5. Architecture

```
MCP client (claude.ai / Claude Code / opencode / Inspector)
        |  POST /mcp  (Authorization: Bearer ...)
        v
+--------------------------- mcp-gateway ----------------------------+
| http layer: auth -> origin check -> size limit -> MCP server handler |
|        |                                                            |
| aggregate layer: namespace, merge, route, cache metadata, errors    |
|        |                                                            |
| upstream manager: one Upstream per config entry, status machine     |
|   RemoteUpstream (Streamable HTTP client, headers/OAuth)            |
|   StdioUpstream  (child process via command, lifecycle)             |
+----------------------------------------------------------------------+
        |                                   |
   remote MCP servers                  npx child processes
```

### Folder layout (create exactly this; add files only when a task needs them)
```
src/
  cli.ts                      # commands: serve, validate
  index.ts                    # serve entrypoint
  config/schema.ts            # zod schema (single source of truth)
  config/load.ts              # read file, parse JSONC
  config/substitute.ts        # {env:} / {file:}
  upstream/types.ts           # Upstream interface, status types
  upstream/manager.ts
  upstream/remote.ts
  upstream/stdio.ts
  aggregate/namespace.ts
  aggregate/tools.ts
  aggregate/resources.ts
  aggregate/prompts.ts
  aggregate/errors.ts
  server/http.ts
  server/auth.ts
  server/mcp.ts               # builds the downstream MCP server
  auth/oauth-client/          # Sprint 5
  auth/oauth-resource/        # Sprint 6
  observability/logger.ts
  observability/redact.ts
test/
  unit/ e2e/ fixtures/
spikes/                       # Sprint 0 only, never imported by src/
docs/
  SDK-NOTES.md  OPEN-QUESTIONS.md  BACKLOG.md  adr/  ref/  reports/
gateway.example.json
```

### Upstream contract (internal TypeScript interface; adapt types to the SDK's real types after Sprint 0)
```ts
type UpstreamStatus = 'disabled' | 'starting' | 'ready' | 'auth_required' | 'error' | 'failed';
interface Upstream {
  readonly name: string;
  readonly kind: 'remote' | 'local';
  status(): { state: UpstreamStatus; since: number; lastError?: string }; // lastError must be redacted
  start(): Promise<void>;
  stop(): Promise<void>;
  listTools(signal: AbortSignal): Promise<ToolListResult>;
  callTool(name: string, args: unknown, meta: unknown, signal: AbortSignal): Promise<CallToolResult>;
  // plus listResources/readResource/listPrompts/getPrompt added in Sprint 3
}
```

### Request flows
- `server/discover`: answered by the gateway itself: identity `mcp-gateway`, capabilities derived from what healthy upstreams provide (tools/resources/prompts, list-changed support). Implementation comes from the SDK; do not hand-roll the wire format.
- `tools/list`: fan out to all `ready` upstreams in parallel, each with `timeout`; collect; prefix names (D4); drop over-length names; sort ascending by namespaced name; set `ttlMs`/`cacheScope` (D11).
- `tools/call`: split the name at the first `_`; unknown server or tool => protocol error (verify code); strip prefix; forward `arguments` untouched; forward `_meta` entries needed for progress and trace context (`progressToken`, `traceparent`, `tracestate`, `baggage`); wire the downstream AbortSignal to the upstream call; return the upstream result unchanged. If the result is `input_required` (MRTR), forward it UNCHANGED, including `requestState`. The client's retry arrives as a normal new `tools/call` and is routed the same way. The gateway keeps no MRTR state.

---

## 6. Config schema (the contract)

```jsonc
{
  "$schema": "./gateway.schema.json",
  "gateway": {
    "host": "0.0.0.0",
    "port": 3000,
    "publicUrl": "https://mcp.app.com",          // used for OAuth metadata (Sprint 5/6) and Origin checks
    "auth": { "type": "bearer", "keys": ["{env:GATEWAY_API_KEY}"] },
    "defaultTimeoutMs": 30000,
    "defaultTtlMs": 30000
  },
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer {env:GITHUB_TOKEN}" },
      "enabled": true,
      "timeout": 30000
    },
    "notion": { "type": "remote", "url": "https://example.com/notion/mcp", "oauth": {} },   // Sprint 5
    "fs": {                                                                                   // Sprint 4
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "environment": { "FOO": "{env:FOO}" },
      "enabled": true,
      "timeout": 30000,
      "startupTimeoutMs": 60000,
      "idleTimeoutMs": 300000
    }
  }
}
```

| Field | Applies to | Required | Default | Validation |
|-------|-----------|----------|---------|-----------|
| `mcp.<name>` key | all | yes | - | regex `^[a-z0-9-]{1,24}$` (D4) |
| `type` | all | yes | - | `"remote"` or `"local"` |
| `enabled` | all | no | `true` | boolean |
| `timeout` | all | no | `gateway.defaultTimeoutMs` | int 1000..600000, ms, per upstream request |
| `url` | remote | yes | - | valid URL; `https:` required unless host is `localhost`/`127.0.0.1`/`::1` |
| `headers` | remote | no | `{}` | record string->string; header names valid per RFC 9110 token rule |
| `oauth` | remote | no | absent | `false`, or object (Sprint 5 defines fields: `clientId?`, `clientSecret?`, `scope?`) |
| `command` | local | yes | - | non-empty string array; first element non-empty |
| `environment` | local | no | `{}` | record string->string |
| `startupTimeoutMs` | local | no | 60000 | int |
| `idleTimeoutMs` | local | no | 300000 | int >= 0; 0 disables idle shutdown |

Rules: all objects are strict (unknown key => error naming the path). `headers` and `oauth` together on one upstream: allowed; static headers are sent on every request, OAuth adds `Authorization` only if no static `Authorization` header is set (document this in `docs/CONFIG.md`). Export a JSON Schema (`gateway.schema.json`) from the zod schema (verify the zod v4 API for this).

---

## 7. Sprints

Each sprint ends with the report in rule 11 and a STOP.

### Sprint 0 — Ground truth and spikes (no product code)
**Goal:** replace every assumption with a verified fact.
- **S0.1** Save the spec pages to `docs/ref/` (Markdown copies): the 2026-07-28 changelog, `basic/transports/streamable-http`, `basic/patterns/mrtr`, `basic/index` (error codes), `basic/authorization` and `basic/authorization/client-registration`, `deprecated`, and the pages for tools, resources, prompts, discover and subscriptions. Find the exact URLs through https://modelcontextprotocol.io/llms.txt ; do not guess URLs.
- **S0.2** In a scratch project install `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, the middleware packages and `zod`. Record exact versions and `engines` in `docs/SDK-NOTES.md`. Read the v2 docs and the `.d.ts` files.
- **S0.3** In `docs/SDK-NOTES.md`, for each item give: import path, symbol, signature, and a snippet that you ran. (a) A server whose list/call handlers are DYNAMIC (needed for proxying; the static `registerTool` style alone may not suffice: find out). (b) Serving `POST /mcp` over HTTP statelessly, including `server/discover`. (c) Client over Streamable HTTP with custom headers. (d) Client over stdio, including env handling and Windows `npx` behavior. (e) How `ttlMs`/`cacheScope` are read and set. (f) How `input_required` results surface in the client API and how to return them from a server handler unchanged. (g) AbortSignal and timeout support on client calls. (h) `subscriptions/listen` on client and server. (i) The OAuth client provider interface. (j) Which protocol versions the v2 server accepts (2025-era clients?) and which the v2 client can speak to older servers.
- **S0.4** Spikes in `spikes/`: spike-1 starts a fake remote MCP server with 2 tools and the gateway-style proxy skeleton in ~100 lines; spike-2 same over stdio; spike-3 connects the official MCP Inspector (`npx @modelcontextprotocol/inspector`, verify command) to the skeleton and lists/calls a tool. Save the outputs.
- **S0.5** Find opencode's MCP config documentation (web search on opencode.ai) and record the real field names in `docs/ref/opencode-mcp-config.md`. Compare to §6; list differences in the report. Do not edit §6 yourself.
- **S0.6** Check the max tool-name length accepted by Claude's API and by claude.ai connectors from official docs; record it (D4 assumes 64).
- **S0.7** Fill `docs/OPEN-QUESTIONS.md`; write ADRs for D16 and for any compatibility finding from S0.3(j).
**Acceptance:** `docs/SDK-NOTES.md` has a runnable, cited snippet for every item (a)-(j) or an explicit "not possible because ..."; all three spikes run (`node spikes/spike-1.mjs` etc.) and output is attached to the report; no files under `src/`.
**Gate:** human reviews the report before Sprint 1.

### Sprint 1 — Scaffold and config
- **S1.1** Init repo: `package.json` (scripts: `build`, `dev`, `start`, `test`, `typecheck`, `lint`), `tsconfig.json` (D1), ESLint, vitest, `.gitignore` (includes `gateway.json`, `data/`), `.editorconfig`.
- **S1.2** `config/schema.ts` per §6; `config/substitute.ts` (D7); `config/load.ts` (D6).
- **S1.3** `observability/logger.ts` and `redact.ts` (D14) with a unit test proving secrets never appear in log output.
- **S1.4** `cli.ts` with `validate -c <file>`: exit 0 on valid, exit 1 with a human-readable list of errors (key path + reason, never values).
- **S1.5** `gateway.example.json` and generated `gateway.schema.json`; a script `npm run gen:schema`.
- **S1.6** Unit tests: substitution (env, file, missing, nested), strict unknown keys, name regex, `url` https rule, command array rules, error messages contain no secret value (use a canary secret like `SECRET-CANARY-123` and assert it never appears).
**Acceptance:** `npm run typecheck && npm run lint && npm test` pass; `node dist/cli.js validate -c gateway.example.json` exits 0 (with example env vars set); a fixtures set of 8 invalid configs each exits 1 with the expected key path.

### Sprint 2 — Remote upstreams, aggregated tools, inbound bearer auth
- **S2.1** `upstream/types.ts`, `manager.ts` (create one Upstream per enabled config entry; status machine; lazy reconnect with exponential backoff 1s..30s cap).
- **S2.2** `RemoteUpstream` using the SDK client over Streamable HTTP; static `headers`; per-request timeout and AbortSignal.
- **S2.3** `aggregate/namespace.ts` (D4) with exhaustive unit tests (collisions, underscore tool names, over-length, empty names).
- **S2.4** `aggregate/tools.ts`: `tools/list` and `tools/call` per §5; D8, D11, D12.
- **S2.5** `server/http.ts` and `server/mcp.ts`: `POST /mcp`, `GET /healthz`, `GET /status`; `server/auth.ts` (D9): missing/invalid key => 401 with `WWW-Authenticate: Bearer`; Origin validation per the Streamable HTTP spec page (read it; follow what it says); request body size limit 1 MiB.
- **S2.6** E2E tests with three fake upstreams (fast, slow > timeout, always-failing) and the SDK client as downstream: merged list is correct and sorted; call routes to the right upstream; slow upstream times out without blocking others; failing upstream is absent from list and appears in `/status` with state `error`; unauthorized request gets 401; `tools/list` result has `ttlMs` and `cacheScope: "private"`; arguments/results round-trip byte-for-byte for a tool with nested JSON.
- **S2.7** Manual check with MCP Inspector against the running gateway; attach a transcript.
**Acceptance:** all tests pass; S2.7 transcript attached.

### Sprint 3 — Resources, prompts, subscriptions, MRTR, progress, cancellation
- **S3.1** Resources: `resources/list`, `resources/read` with D5 rewriting; read of unknown server or URI returns `-32602`. Resource templates are NOT aggregated (non-goal); the capability must not advertise them.
- **S3.2** Prompts: `prompts/list`, `prompts/get` with D4 namespacing.
- **S3.3** `ttlMs`/`cacheScope` on every list/read result per D11.
- **S3.4** `subscriptions/listen`: the gateway subscribes (when the upstream supports it) to upstream list-changed events and fans them out to opted-in downstream listeners; the gateway also emits `toolsListChanged` when an upstream's status transitions change the merged list. Use the SDK facilities found in S0.3(h); no hand-rolled streams unless the SDK lacks them (then ADR).
- **S3.5** MRTR passthrough: fake upstream tool returns `input_required` then `complete` on retry with `inputResponses`; test proves the gateway forwards both unchanged, including `requestState`, and keeps no state.
- **S3.6** Progress and trace context: progress notifications from upstream appear on the downstream response stream of the same request; `traceparent` passes through; cancelling the downstream request aborts the upstream request (assert via the fake upstream observing the abort).
**Acceptance:** E2E tests for each task pass; the capability advertisement from `server/discover` matches reality (test).

### Sprint 4 — Local stdio upstreams (npx)
- **S4.1** `StdioUpstream` with the SDK stdio client transport, same `Upstream` contract; `command[0]` resolution; Windows handling per S0.3(d) (test on Windows AND Linux/Docker).
- **S4.2** Environment (D13): allowlist + `environment` from config; a test spawns a child that prints its env keys and asserts no gateway secret leaks.
- **S4.3** Lifecycle: lazy start on first use, `startupTimeoutMs` (first `npx` download is slow), idle shutdown after `idleTimeoutMs`, crash detection, restart with backoff 1s..30s, max 5 consecutive failures => state `failed`, retried at most once per 30s on incoming traffic.
- **S4.4** stderr capture: line-buffered, truncated to 2 KiB per line, redacted, logged with field `upstream`.
- **S4.5** Graceful shutdown: SIGTERM, wait 5s, then force kill (kill the process TREE on Windows; verify how).
- **S4.6** Tests with a fake stdio server script: normal call; `kill -9` mid-call => `isError` result then successful call after restart; idle shutdown using fake timers; startup timeout; env isolation.
- **S4.7** Compatibility: connect one real public stdio server (for example `@modelcontextprotocol/server-everything`; verify the package exists first) in a manual test only; attach transcript. If it speaks an older protocol revision and the SDK client cannot talk to it, stop and write an ADR.
- **S4.8** `docs/SECURITY.md` section: "gateway config is code" (anyone who can edit it can run commands on the host).
**Acceptance:** all tests pass on Linux (CI/Docker) and Windows; S4.7 transcript attached.

### Sprint 5 — Upstream OAuth (gateway as OAuth client)
- **S5.1** Read the `basic/authorization` and `client-registration` pages end to end; summarize the exact flow in `docs/ref/oauth-flow.md` with spec citations.
- **S5.2** Token store: AES-256-GCM encrypted JSON file `data/tokens.enc.json`, key from env `GATEWAY_TOKEN_KEY` (32 bytes, base64), atomic writes (temp file + rename), file mode 0600. Records keyed by `(upstreamName, issuer)`.
- **S5.3** Implement the SDK's OAuth client provider interface (S0.3(i)). Client registration order: static `clientId` from config; else Client ID Metadata Document if the authorization server supports it; else Dynamic Client Registration (deprecated, log a warning). PKCE S256. Validate `state` and `iss` (RFC 9207) as the spec requires.
- **S5.4** Routes (protected by the gateway bearer key): `GET /admin/oauth/:name/start` => redirect to the authorization URL; `GET /oauth/callback` => code exchange. Upstream state becomes `auth_required` on 401; tools of such an upstream are hidden from `tools/list`; `/status` shows the `start` URL.
- **S5.5** Refresh tokens before expiry (60s skew) and on 401; on refresh failure go to `auth_required`.
- **S5.6** Tests against a fake in-repo authorization server (metadata discovery, PKCE, refresh, `iss` mismatch rejected, wrong-issuer credential reuse rejected). No real third-party service in CI.
**Acceptance:** tests pass; manual connection to one real OAuth-protected remote MCP server documented in the report (redact tokens).

### Sprint 6 — Inbound OAuth (gateway as protected resource)
- **S6.0 GATE (human decision required):** choose between (A) gateway is only a resource server and validates JWTs from an external authorization server (default recommendation; use `jose` for JWKS validation; verify with `npm view`), or (B) the gateway embeds its own authorization server. Do not start B without explicit human approval and an ADR with a threat model. Reason: an embedded AS is security-critical code.
- **S6.1** Per the authorization spec page (read it again): publish the protected-resource metadata document, respond to unauthenticated requests with the `WWW-Authenticate` challenge the spec requires, validate audience/resource and expiry of tokens.
- **S6.2** Keep static bearer keys working side by side (config `gateway.auth` accepts an array or a `type: "oauth"` variant; define the schema change in an ADR first).
- **S6.3** Test with a fake authorization server and a client that follows the discovery flow. Then a manual test as a custom connector from claude.ai (the human performs this; the agent prepares the checklist).
**Acceptance:** tests pass; checklist delivered.

### Sprint 7 — Hardening and delivery
- **S7.1** Hot reload: watch the config file and handle SIGHUP; diff upstreams (add/remove/changed); apply atomically; invalid new config keeps the old one running and logs the error.
- **S7.2** Rate limiting per inbound key/subject (in-memory token bucket, configurable), 429 with `Retry-After`.
- **S7.3** Graceful shutdown of the whole process (stop accepting, drain in-flight up to 10s, stop upstreams).
- **S7.4** Dockerfile (multi-stage, non-root user, no assumption about CPU architecture), `docker-compose.example.yml`.
- **S7.5** Docs: `README.md`, `docs/CONFIG.md` (generated from the schema), `docs/SECURITY.md`, `docs/OPERATIONS.md`.
- **S7.6** Full E2E suite run in Docker; a smoke test script `scripts/smoke.sh` hitting `/healthz`, `server/discover`, `tools/list`, one `tools/call`.
**Acceptance:** `docker build` + smoke script pass; all earlier tests still pass.

---

## 8. Cross-cutting requirements

### Error mapping (verify codes against the spec pages; adjust only with citation)
| Situation | Response |
|-----------|----------|
| Unknown namespaced tool/prompt/resource | JSON-RPC protocol error (`-32602` per spec; verify) |
| Upstream down / timeout / needs auth during `tools/call` | tool result `isError: true`, text `Upstream '<name>' is unavailable | timed out | requires authentication` |
| Unsupported protocol version | SDK/spec-defined `UnsupportedProtocolVersionError`; do not hand-roll |
| Invalid inbound credentials | HTTP 401 + `WWW-Authenticate` |
| Body too large | HTTP 413 |
| Rate limited | HTTP 429 + `Retry-After` |

### Security checklist (reviewed at every sprint end)
- No secret in logs, errors, `/status`, tool results, or stack traces.
- Constant-time key comparison. Auth failures logged without the presented key.
- `Origin` validation per the Streamable HTTP page; no wildcard CORS by default.
- Outbound requests only to URLs from config; no URL taken from request input.
- `local` upstreams: environment allowlist (D13); document that config is code.
- Dependencies: `npm audit` run at each sprint end; report findings.

### Definition of Done (every task)
Code + tests + `npm run typecheck && npm run lint && npm test` green + external API calls cited (rule 2) + docs updated if behavior changed + one commit referencing the task ID.

---

## 9. Open questions for the human
- **Q1** Support legacy HTTP+SSE upstreams? Default: no (deprecated in the spec). Some older remote servers only offer SSE.
- **Q2** Must the gateway also serve clients that speak 2025-era MCP (with `initialize` and sessions)? Default: yes IF the SDK v2 provides it without custom code; otherwise 2026-07-28 only, recorded in an ADR. (Decided after S0.3(j).)
- **Q3** Sprint 6 architecture (GATE S6.0): external authorization server (A) or embedded (B)?
- **Q4** Hosting target and public hostname (for `publicUrl`, TLS termination, Origin allowlist).
- **Q5** Is the tasks extension (`io.modelcontextprotocol/tasks`) needed for any upstream you plan to use?
