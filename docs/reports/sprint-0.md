# Sprint 0 report — Ground truth and spikes

- Branch: `sprint-0-ground-truth`
- Date: 2026-10-10
- Scope: PLAN.md §7 Sprint 0 (S0.1 … S0.7), no product code
- Status: **complete, stopped at the gate**

---

## 1. Tasks done

| Task | Status | What was produced |
|---|---|---|
| S0.1 Save spec pages to `docs/ref/` | done | 26 spec pages + 4 Inspector/SDK doc pages, all URLs discovered through `https://modelcontextprotocol.io/llms.txt` (no URL guessed) |
| S0.2 Install SDK v2 in a scratch project | done | `spikes/` with exact pins; versions + `engines` + peer deps recorded in `docs/SDK-NOTES.md` |
| S0.3 Verify (a)–(j) with runnable snippets | done | `docs/SDK-NOTES.md`; every item has import path, symbol, signature, a snippet that **ran**, and a captured output |
| S0.4 Spikes 1–3 + saved outputs | done | `spikes/spike-1.mjs`, `spike-2.mjs` (+ `fake-stdio-server.mjs`), `spike-3.mjs`; outputs in `spikes/out-*.txt` |
| S0.5 opencode MCP config | done | `docs/ref/opencode-mcp-config.md` + a differences table vs §6. **§6 was not edited** |
| S0.6 Tool-name limits | done | `docs/ref/claude-limits.md` |
| S0.7 OPEN-QUESTIONS + ADRs | done | `docs/OPEN-QUESTIONS.md`, `docs/adr/0001-http-layer.md` (D16), `docs/adr/0002-protocol-compatibility.md` (S0.3j), `docs/BACKLOG.md` |

### Acceptance criteria check

| Criterion (PLAN.md §7 Sprint 0) | Result |
|---|---|
| `docs/SDK-NOTES.md` has a runnable, cited snippet for every item (a)–(j) or "not possible because…" | **met** — (i) is interface-only and explicitly flagged as *not executed* (`Q-OAUTH-RUN`), everything else ran |
| All three spikes run and output is attached to the report | **met** — section 3 below plus `spikes/out-*.txt` in the repo |
| No files under `src/` | **met** — `ls src` → `No such file or directory` |

---

## 2. Deviations from PLAN.md

No fixed decision (D1–D16) was changed. What changed is *evidence*, not decisions.

1. **`server/discover` is also a cacheable result.** PLAN.md §2 lists `ttlMs`/`cacheScope` on
   tools/prompts/resources list + read. The spec page and the SDK both include
   `server/discover`. The SDK's closed list:
   `["tools/list","prompts/list","resources/list","resources/templates/list","resources/read","server/discover"]`.
2. **`MCP-Protocol-Version` is also required** on every POST, and must equal the `_meta`
   envelope value. PLAN.md §2 mentions only `Mcp-Method` and `Mcp-Name`.
3. **The `_meta` envelope is mandatory per request** — a missing
   `io.modelcontextprotocol/clientCapabilities` is answered `-32602`.
4. **§5's `tools/call` flow is incomplete for MRTR.** `inputResponses` and `requestState`
   are siblings of `arguments` in the request params, and the SDK lifts them out of `params`
   before the handler runs, so a proxy must re-attach them explicitly. Demonstrated as a
   10-round failure before the fix. → `Q-MRTRPROXY`.
5. **`_meta` trace keys confirmed** (`progressToken`, `traceparent`, `tracestate`,
   `baggage`) — PLAN.md was right; recorded with a working snippet.
6. **Error codes beyond the one PLAN.md mentions.** The spec defines `-32020 HeaderMismatch`,
   `-32021 MissingRequiredClientCapability`, `-32022 UnsupportedProtocolVersion`, and says
   `-32000..-32019` is implementation-defined and SHOULD NOT be used by new implementations.
   The SDK answers 405/413 with `-32000` anyway. PLAN.md §8's error table needs those rows.
7. **opencode's `timeout` default is 5000 ms, not §6's 30000.** §6's value is a free choice,
   not an inheritance.
8. **opencode documents a `cwd` field** for local upstreams that §6 lacks.
9. **opencode imposes no regex on server names**, so D4's `^[a-z0-9-]{1,24}$` is the
   gateway's own constraint justified by the split-on-first-`_` rule — not by opencode
   compatibility.

---

## 3. Commands run (with output tails)

### Setup

```
$ git init && git checkout -b sprint-0-ground-truth
$ curl -sL https://modelcontextprotocol.io/llms.txt -o spikes/llms.txt
363 spikes/llms.txt
```

### S0.1 — spec pages

```
$ base=https://modelcontextprotocol.io/specification/2026-07-28
$ for p in index changelog deprecated architecture/index basic/index basic/versioning \
    basic/patterns/index basic/patterns/mrtr basic/patterns/subscriptions \
    basic/patterns/cancellation basic/patterns/progress basic/transports/index \
    basic/transports/stdio basic/transports/streamable-http basic/authorization/index \
    basic/authorization/authorization-server-discovery basic/authorization/client-registration \
    basic/authorization/security-considerations server/index server/discover server/tools \
    server/resources server/prompts server/utilities/caching server/utilities/pagination schema; do
    curl -sL "$base/$p.md" -o "docs/ref/spec-2026-07-28-${p//\//-}.md"; done

   5817 docs/ref/spec-2026-07-28-index.md
  11892 docs/ref/spec-2026-07-28-changelog.md
   3536 docs/ref/spec-2026-07-28-deprecated.md
  ...
 30407 docs/ref/spec-2026-07-28-basic-transports-streamable-http.md
 25173 docs/ref/spec-2026-07-28-basic-authorization-index.md
 10229 docs/ref/spec-2026-07-28-basic-authorization-client-registration.md
  24314 docs/ref/spec-2026-07-28-server-tools.md
 701659 docs/ref/spec-2026-07-28-schema.md
```

### S0.2 — packages

```
$ for p in @modelcontextprotocol/server @modelcontextprotocol/client @modelcontextprotocol/node \
          @modelcontextprotocol/express zod jsonc-parser; do npm view $p version; done
@modelcontextprotocol/server       2.3.1
@modelcontextprotocol/client       2.3.1
@modelcontextprotocol/node         2.1.1
@modelcontextprotocol/express      2.0.2
zod                                4.6.5
jsonc-parser                       3.3.1

$ npm view mcp-handler version engines peerDependencies description
version = '2.3.0'
engines = { node: '>=20' }
peerDependencies = { next: '>=13.0.0', '@modelcontextprotocol/server': '^2.0.0' }
description = 'Framework-agnostic HTTP adapter for Model Context Protocol servers'

$ npm view @modelcontextprotocol/inspector version bin engines
version = '2.10.1'
bin = { mcpdo: ..., inspector: ..., 'mcp-inspector': ... }
engines = { node: '>=22.19.0' }

$ npm install --no-audit --no-fund
added 88 packages in 20s

$ npm audit
found 0 vulnerabilities
```

Runtime constants:

```
$ node -e "import('@modelcontextprotocol/server').then(m=>console.log(...))"
LATEST_PROTOCOL_VERSION             2025-11-25
DEFAULT_NEGOTIATED_PROTOCOL_VERSION 2025-03-26
SUPPORTED_PROTOCOL_VERSIONS         ["2025-11-25","2025-06-18","2025-03-26","2024-11-05","2024-10-07"]
DEFAULT_REQUEST_TIMEOUT_MSEC        60000
DEFAULT_MAX_REQUEST_BODY_SIZE       4194304
```

### S0.4 — spikes, final re-run from clean

```
$ cd spikes && rm -f out-*.txt
$ for f in spike-1.mjs spike-2.mjs spike-3.mjs probe-compat.mjs probe-subscriptions.mjs probe-progress.mjs; do
    node "$f" > "out-${f%.mjs}.txt" 2>&1 && echo OK || echo FAILED; done

spike-1.mjs                OK (42 lines)
spike-2.mjs                OK (19 lines)
spike-3.mjs                OK (27 lines)
probe-compat.mjs           OK (43 lines)
probe-subscriptions.mjs    OK (22 lines)
probe-progress.mjs         OK (9 lines)
```

**spike-1 — remote proxy, dynamic handlers, raw wire, MRTR, timeout**

```
$ node spike-1.mjs
[upstream] listening on http://127.0.0.1:3101/mcp
[gateway] upstream server/discover => {"_meta":{"io.modelcontextprotocol/serverInfo":{"name":"fake-upstream","version":"0.0.1"}},"ttlMs":0,"cacheScope":"private","supportedVersions":["2026-07-28"],"capabilities":{"tools":{"listChanged":false}},"resultType":"complete"}
[gateway] listening on http://127.0.0.1:3102/mcp

=== raw POST server/discover ===
status 200 content-type application/json
{"result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{"listChanged":false}},"resultType":"complete","ttlMs":60000,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"mcp-gateway-spike","version":"0.0.0"}}},"jsonrpc":"2.0","id":1}

=== raw POST tools/call unknown namespaced tool (expect -32602) ===
{"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"Unknown tool: nope_missing"}}

=== raw POST tools/call upstream_boom (expect isError tool result) ===
{"result":{"_meta":{...},"content":[{"type":"text","text":"upstream deliberately failed"}],"isError":true,"resultType":"complete"},"jsonrpc":"2.0","id":4}

=== MRTR: gateway forwards input_required unchanged, client auto-fulfils ===
[gateway] tools/call forward params keys = name,arguments
[gateway-client] elicitation/create => Proceed?
[gateway] tools/call forward params keys = name,arguments,inputResponses,requestState
callTool upstream_needs_input => {"content":[{"type":"text","text":"upstream-mrtr:complete state=upstream-minted-state"}]}

=== timeout on the upstream call ===
timeout threw => SdkError | code = REQUEST_TIMEOUT | Request timed out
```

**spike-2 — stdio upstream, env allowlist, npx on Windows**

```
$ node spike-2.mjs
DEFAULT_INHERITED_ENV_VARS = ["APPDATA","COMSPEC",...,"USERPROFILE","WINDIR"]
stdio pid = 8848
stdio server/discover = ["2026-07-28"]
stdio tools = show_env,add
child env result = {"envKeys":[...,"SPIKE_UPSTREAM_NAME","SPIKE_UPSTREAM_VALUE",...],
  "upstreamName":"local-up","upstreamValue":"from-config","gatewaySecretLeaked":false}
gateway merged tools = local_show_env,local_add
through the gateway = {"envKeys":[...]}          # same, via the HTTP proxy
process.platform = win32

$ node -e "spawn('npx',['-y','--version'],{shell:false,windowsHide:true,env:{PATH,PATHEXT,COMSPEC,SYSTEMROOT,TEMP}})"
spawned ok, pid 10376
exit 0 stdout= "11.16.0" stderr= ""
```

**spike-3 — official MCP Inspector CLI against the skeleton**

```
$ node spike-3.mjs
$ npx -y @modelcontextprotocol/inspector@latest --cli http://127.0.0.1:3152/mcp --transport http --method tools/list --format json
[exit 0]
{"result":{"tools":[{"name":"up_add",...},{"name":"up_greet",...}]}}

$ ... --method tools/call --tool-name up_add --tool-arg a=2 --tool-arg b=40 --format json
[exit 0]
{"result":{"content":[{"type":"text","text":"42"}]}}

$ ... --cli http://127.0.0.1:3151/mcp --transport http --method tools/list      # legacy:'reject' upstream
[exit 1]
{"error":{"message":"Error POSTing to endpoint: {\"code\":-32022,\"message\":\"Unsupported protocol version: 2025-11-25\",\"data\":{\"supported\":[\"2026-07-28\"],\"requested\":\"2025-11-25\"}}"}}

$ ... --cli http://127.0.0.1:3151/mcp --transport http --protocol-era modern --method tools/list
[exit 0]
{"result":{"tools":[{"name":"add",...},{"name":"greet",...}]}}
```

**probe-compat — the protocol-version matrix (S0.3(j))**

```
$ node probe-compat.mjs
=== isLegacyRequest classification ===
modern tools/list classified legacy?  false
2025 initialize classified legacy?    true

default client            -> modern-only server : FAILED SdkHttpError -32022 Unsupported protocol version: 2025-11-25
default client            -> stateless-default  : connect OK, tools = ping_tool
auto client               -> modern-only server : connect OK, discover=["2026-07-28"]
pinned 2026-07-28 client  -> modern-only server : connect OK, discover=["2026-07-28"]
pinned 1999-01-01 client  -> stateless-default  : FAILED TypeError at construction

raw unknown MCP-Protocol-Version -> 400 {"code":-32022,"data":{"supported":["2026-07-28"],"requested":"1999-01-01"}}
raw GET    -> 405 {"code":-32000,"message":"Method not allowed."}
raw DELETE -> 405 {"code":-32000,"message":"Method not allowed."}
raw Mcp-Method/body mismatch -> 400 {"code":-32020,"message":"Bad Request: the request headers and body disagree: ..."}
raw missing Mcp-Method       -> 400 {"code":-32020,"message":"... the required Mcp-Method header is absent"}
body over the limit (5 MiB)  -> 413 {"code":-32000,"message":"Payload Too Large: Request body must not exceed 4194304 bytes"}

origin=https://evil.example   -> 403
origin=https://allowed.example-> 200
origin=null                   -> 403
origin absent                 -> 200
```

**probe-subscriptions — cache hints, listen/notify, abort chain**

```
$ node probe-subscriptions.mjs
listen() ack honoredFilter => {"toolsListChanged":true}
[client] received notifications/tools/list_changed
publishing on the UPSTREAM bus...
notifications after upstream publish => ["tools/list_changed"]     <-- unchanged (Q-SUBSFWD)
sub.closed => local

upstream tools/list       ttlMs/cacheScope => 20000 private
upstream server/discover  ttlMs/cacheScope => 900000 public
gateway  tools/list       ttlMs/cacheScope => 5000 private

hang aborted => SdkError | AbortError: This operation was aborted
upstream observed abort? => true
```

**probe-progress — progress notifications and trace context**

```
$ node probe-progress.mjs
[gateway] forwarding _meta keys = progressToken,traceparent
[upstream] received progressToken=0 traceparent=00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
[client] progress => {"progress":1,"total":3,"message":"[gw] step 1"}
[client] progress => {"progress":2,"total":3,"message":"[gw] step 2"}
[client] progress => {"progress":3,"total":3,"message":"[gw] step 3"}
progress notifications seen by the client => 3
```

### S0.5 / S0.6 — external docs

```
$ curl -sL https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/cli.md  -> docs/ref/inspector-cli.md
$ curl -sL https://opencode.ai/docs/mcp-servers/                                    -> docs/ref/opencode-mcp-config.md
$ curl -sL https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
$ curl -sL https://claude.com/docs/connectors/building
   -> docs/ref/claude-limits.md
```

### Scope check

```
$ ls src
ls: cannot access 'src': No such file or directory
```

---

## 4. Open questions (detail in `docs/OPEN-QUESTIONS.md`)

Blocking:

- **Q-MRTRPROXY** — §5's `tools/call` flow must be amended to re-attach
  `inputResponses`/`requestState` from `ctx.mcpReq`. Blocks S3.5.
- **Q-SUBSFWD** — upstream `list_changed` does NOT reach downstream listeners; fan-out must
  be built. Debounce/fan-out policy unspecified. Blocks S3.4.
- **Q-TOOLNAME** — D4's 64 vs the documented 128. Blocks S2.3.
- **Q-COMPAT** — the era posture (PLAN.md Q2). Blocks the whole of Sprint 2's shape.
- **Q-ZODJSON** — zod v4 JSON-Schema export API unverified. Blocks S1.5.
- **Q-OAUTH-RUN** — nothing in the OAuth path was executed. Blocks S5.

Non-blocking: **Q-HDRPREC** (Authorization precedence), **Q-WINDOWS-ENV** (Windows injects
`LOGONSERVER`/`USERDOMAIN` into child envs), **Q-DEVNAMES** (`oauth.clientMetadataUrl`),
**Q-TASKS-EXT** (PLAN.md Q5).

---

## 5. Risks

| Risk | Severity | Note |
|---|---|---|
| The 2025-era codec drops `resultType`, `ttlMs`, `cacheScope` and the MRTR vocabulary | high | If Q-COMPAT resolves to "serve both", D11 and MRTR are 2026-only in practice, and the PLAN.md §8 error table differs between eras. Sprint 2's tests must cover both. |
| `responseMode: 'json'` silently drops mid-call notifications | medium | `progress`/`notifications/message` before the result are discarded. Never use `'json'` on `/mcp` if S3.6 matters. |
| Upstream `Client` era is not auto-negotiated by default | medium | `{ pin: '2026-07-28' }` will hard-fail against a 2025-only upstream; `mode: 'auto'` costs one extra `server/discover` round trip on stdio. Needs a decision in S2.2. |
| `createMcpExpressApp` auto-enables DNS-rebinding protection only for localhost binds | medium | PLAN.md binds `0.0.0.0`; `allowedHosts`/`allowedOrigins` must be set explicitly or there is no Host/Origin protection in production. |
| The SDK answers 405/413 with `-32000`, a sub-range the spec says new implementations should avoid | low | Not fixable from the gateway; note it in PLAN.md §8. |
| `mcp-handler` is a Next.js adapter (`peerDependencies: { next: ">=13" }`) | low | Do not add it. It is not needed (ADR 0002). |
| Windows child env is not a strict subset of the allowlist | low | Only affects the S4.2 test's shape (`Q-WINDOWS-ENV`). |
| claude.ai does not support resource subscriptions, sampling, or draft capabilities | low | S3.4's fan-out targets Claude Code / Inspector / other native clients, not claude.ai. |

---

## 6. What is NOT done (deliberately)

- Sprint 1 and beyond. Sprint 0's scope was docs + spikes only.
- `src/` does not exist.
- PLAN.md §6 was **not** edited (S0.5 forbids it); the differences are listed in
  `docs/ref/opencode-mcp-config.md` for the human to apply.
- PLAN.md §5 and §8 were **not** edited; the required changes are in section 2 above and in
  `docs/OPEN-QUESTIONS.md` for the human to ratify.
- No OAuth flow was executed (no authorization server available).

---

## 7. Commits

```
1d41e16 docs: S0.7 open questions, ADR 0001 (D16) and ADR 0002 (compatibility), backlog
f1b06e2 docs(sdk): S0.3 verified SDK v2 API notes for items (a)-(j)
d9b45ee docs(ref): S0.5 opencode MCP config fields and S0.6 Claude tool-name limits
e0ebe89 feat(spikes): S0.4 proxy spikes and SDK verification probes
72b6fe9 chore(spikes): S0.2 install MCP SDK v2 scratch project
3272db5 docs(ref): S0.1 save MCP spec 2026-07-28 pages to docs/ref
7a9e2d8 docs(plan): add PLAN.md baseline
```