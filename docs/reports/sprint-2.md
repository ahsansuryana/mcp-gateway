# Sprint 2 report — Remote upstreams, aggregated tools, inbound bearer auth

- Branch: `sprint-2-remote-upstreams`
- Date: 2026-10-10
- Scope: PLAN.md §7 Sprint 2 (S2.1 … S2.7)
- Status: **complete, stopped at the gate**

---

## 1. Tasks done

| Task | Status | What was produced |
|---|---|---|
| S2.1 Upstream types + manager | done | `src/upstream/types.ts`, `src/upstream/manager.ts` — status machine, backoff 1s→2s→4s→8s→16s→30s cap, `failed` after 5 consecutive failures, retry at most once per 30 s on traffic |
| S2.2 RemoteUpstream | done | `src/upstream/remote.ts` — SDK `Client` over `StreamableHTTPClientTransport`, static headers, per-request timeout + AbortSignal, 401 → `auth_required` |
| S2.3 Namespacing | done | `src/aggregate/namespace.ts` + `test/unit/namespace.test.ts` (13 exhaustive tests) |
| S2.4 Aggregated tools | done | `src/aggregate/tools.ts` — `tools/list` fan-out with D8/D11/D12, `tools/call` routing |
| S2.5 HTTP layer | done | `src/server/http.ts`, `src/server/mcp.ts`, `src/server/auth.ts`, `src/index.ts` |
| S2.6 E2E | done | `test/fixtures/fake-upstream.ts`, `test/e2e/gateway.e2e.test.ts` — 20 tests |
| S2.7 Inspector transcript | done | `spikes/spike-4.mjs` + `spikes/out-spike-4.txt` |

### Acceptance (PLAN.md §7 Sprint 2)

| Criterion | Result |
|---|---|
| All tests pass | **met** — 81 tests, 6 files, 0 failures |
| S2.7 transcript attached | **met** — `spikes/out-spike-4.txt`, reproduced below |

---

## 2. Commands run (with output tails)

```
$ rm -rf dist && npm run build
build OK

$ npm run typecheck      -> exit 0
$ npm run lint           -> exit 0

$ npm test
 Test Files  6 passed (6)
      Tests  81 passed (81)
   Duration  5.99s

$ npm audit
found 0 vulnerabilities
```

### S2.7 — official MCP Inspector CLI against the live gateway

```
$ npx tsx spikes/spike-4.mjs
[upstream] http://127.0.0.1:3161/mcp
[gateway] http://127.0.0.1:50061/mcp

$ npx -y @modelcontextprotocol/inspector@latest --cli http://127.0.0.1:50061/mcp \
    --transport http --header "Authorization: Bearer S2-7-CANARY-KEY-..." --method tools/list --format json
[exit 0]
{"result":{"tools":[{"name":"demo_add",...},{"name":"demo_boom",...},{"name":"demo_greet",...}]}}

$ ... --protocol-era modern --method tools/call --tool-name demo_add --tool-arg a=2 --tool-arg b=40
[exit 0]
{"result":{"content":[{"type":"text","text":"42"}],...}}

$ ... --protocol-era modern --method tools/call --tool-name demo_greet --tool-args-json '{"name":"inspector"}'
[exit 0]
{"result":{"content":[{"type":"text","text":"hello inspector"}],...}}

$ ... --protocol-era modern --method tools/call --tool-name demo_boom
[exit non-zero]
{"result":{"content":[{"type":"text","text":"upstream tool failure"}],"isError":true}}
[stderr] {"error":{"code":"tool_is_error","message":"Tool 'demo_boom' returned isError:true."}}

$ ... --method tools/list            # NO credentials
[exit 3]
[stderr] {"error":{"code":"auth_required","message":"Interactive OAuth requires a TTY ..."}}

$ curl -s -i http://127.0.0.1:PORT/healthz
HTTP 200 {"ok":true}

$ curl -s -i -H "Authorization: Bearer ..." http://127.0.0.1:PORT/status
HTTP 200 {"gateway":{"host":"127.0.0.1","port":50100,"publicUrl":null,"legacyEra":"stateless",
  "defaultTimeoutMs":30000,"defaultTtlMs":30000,"inboundAuthKeys":1,"configuredUpstreams":1},
 "upstreams":[{"name":"demo","kind":"remote","status":{"state":"ready","since":...}}]}

$ curl -s -i http://127.0.0.1:PORT/mcp     # no credentials
HTTP 401 www-authenticate=Bearer
```

Notable: the **2025-era Inspector (no `--protocol-era`) listed the tools successfully**,
which confirms the `legacyEra: 'stateless'` decision end-to-end with the official client.

### S2.6 — what the E2E suite actually asserts

| Requirement (PLAN.md S2.6) | Test |
|---|---|
| merged list is correct | `fast_echo` and `slow_echo` present, `dead_*` absent |
| merged list is sorted | names equal their own sorted copy |
| call routes to the right upstream | `fast_echo` → `fast:hi`; `slow_echo` → `slow:yo` |
| slow upstream times out without blocking others | `slow_sleep` with `ms: 4000` and `timeout: 1000` → `isError`; the whole `tools/list` still returns in < 5 s |
| failing upstream is absent from list and `error` in `/status` | asserted state ∈ {error, failed, starting}, never `ready` |
| unauthorized request gets 401 | missing key and wrong key both → 401 + `WWW-Authenticate: Bearer` |
| `tools/list` has `ttlMs` and `cacheScope: "private"` | raw POST asserts `ttlMs === 5000` (the **minimum** of fast's 25000 and slow's 5000) and `cacheScope === "private"` |
| arguments/results round-trip byte-for-byte for nested JSON | `fast_deep` with `{a, b:[1,2,{c:"ünïcødé 🎉", d:null}], e:{f:{g:true}}}` → `structuredContent` deep-equals |
| extra (S2.5) | 403 for `Origin: https://evil.example`, 413 for a 2 MiB body, `/healthz` unauthenticated `{ok:true}`, `/status` leaks no secret, 2025-era client reaches the gateway |

---

## 3. Deviations from PLAN.md

No fixed decision was changed. Points where the plan was silent or wrong:

1. **Q-HDRPREC implemented as §6 says.** PLAN.md §6: "OAuth adds `Authorization` only if no
   static `Authorization` header is set." The SDK's precedence is the reverse. In Sprint 2
   there is no `authProvider` at all, so the question is dormant; the static
   `requestInit.headers` path is implemented exactly as §6 describes and the conflict stays
   open for Sprint 5. See `docs/OPEN-QUESTIONS.md` Q-HDRPREC.
2. **The 1 MiB body limit is set at BOTH layers.** `createMcpHandler` and `toNodeHandler`
   default to 4 MiB; Express's `express.json()` defaults to 100 kb. PLAN.md S2.5 says "1 MiB"
   without saying which layer owns it, so both were set to 1 MiB and the Express limit was
   raised explicitly. Recorded in `docs/adr/0001-http-layer.md`.
3. **`local` upstreams are rejected at construction.** `UpstreamManager` throws
   `only remote upstreams exist in Sprint 2` for a `type: "local"` entry. Sprint 4 adds
   `StdioUpstream`; throwing is deliberate so a `local` entry cannot silently do nothing.
4. **`listTools` uses `cacheMode: 'bypass'`.** The gateway, not the SDK's response cache,
   owns freshness (D11 computes a minimum across upstreams). Leaving the SDK cache on would
   make a TTL change invisible until the SDK's own entry expired.
5. **`upstream.callTool` sets `allowInputRequired: false`.** The MRTR passthrough is S3.5;
   enabling it now would surface a half-built behaviour.
6. **`GET /status` reports `inboundAuthKeys` as a count**, never the keys (PLAN.md rule 9).
7. **`gateway.publicUrl` is optional**, so the Origin allowlist is
   `{localhost, 127.0.0.1, [::1]}` plus the publicUrl host when set. PLAN.md Q4 is still
   unanswered, so the production allowlist is not yet expressible from config alone.
8. **`src/index.ts` was created in S2.5**, closing `docs/OPEN-QUESTIONS.md` Q-SERVE-CMD.

---

## 4. Open questions

Unchanged from Sprint 1 except Q-SERVE-CMD, which is now closed. Still blocking later
sprints: **Q-MRTRPROXY** (S3.5), **Q-SUBSFWD** (S3.4), **Q-TOOLNAME** (resolved in practice
by D4 = 64, see below), **Q-OAUTH-RUN** (S5). Non-blocking: Q-HDRPREC, Q-CORS,
Q-WINDOWS-ENV, Q-DEVNAMES, Q-TASKS-EXT.

**Q-TOOLNAME is no longer blocking.** D4 already fixes 64 characters and the E2E suite
asserts namespacing at exactly that boundary (`test/unit/namespace.test.ts`: 64 kept, 65
skipped). Implementing PLAN.md as written is not a silent decision, so no further approval is
needed. The prose-vs-enforcement conflict remains documented for whenever D4 is revisited.

---

## 5. Risks

| Risk | Severity | Note |
|---|---|---|
| The gateway never sets `tools.listChanged` | high | Consumers must poll or rely on `ttlMs`. S3.4 turns it on; B-22 tracks it. |
| One long-lived `Client` per upstream | medium | A long-idle upstream holds its transport open. B-20. |
| `x-mcp-header` annotations are forwarded verbatim | medium | A conforming client may send `Mcp-Param-*` headers the gateway neither validates nor rejects. B-23 / B-06. |
| Origin allowlist is localhost-only until `publicUrl` is set | medium | A public deploy must set `publicUrl` or explicitly extend the allowlist. Q4 is unanswered. |
| `express.json()` and the SDK both parse the body | low | Verified end to end: 413 comes back correctly for 2 MiB. Express parses first, so the SDK receives `parsedBody`. |
| The Inspector exits non-zero on `isError` results and prints a libuv assertion on Windows | low | Not a gateway defect (B-19). |
| Backoff timers keep the process alive after `stop()` | low | `stop()` clears every pending retry handle; asserted by construction, not yet by test. |
| `RemoteUpstream` classifies "needs auth" by regex-matching `401` in the message | low | Works, but is a heuristic. `UnauthorizedError` is checked first; Sprint 5 should rely on the typed error only. |

---

## 6. Tests that found real bugs

1. **`GET /status` reported `upstreamCount: 0`.** `configSummary(config.gateway)` was passed
   the *gateway* section while `configSummary` reads `.mcp`. Found by reading the S2.7
   Inspector transcript, not by the E2E suite — which is exactly why S2.7 exists. Fixed by
   building the status payload explicitly; an E2E assertion now covers `configuredUpstreams`.
2. **The fake-upstream fixture could not compile** under D1's strictness: `toNodeHandler`'s
   duck-typed request shape declares `method?: string` while Node types it
   `string | undefined`, which `exactOptionalPropertyTypes` rejects. eslint's
   `no-unnecessary-type-assertion` simultaneously reported the fix as unnecessary — that rule
   does not model `exactOptionalPropertyTypes`. Resolved with one documented cast rather than
   weakening the compiler setting project-wide.
3. **A namespace test asserted the wrong thing.** `bad_name_tool` parses as
   `{server: 'bad', name: 'name_tool'}` — which is exactly the case D4's server-name regex
   exists to make unambiguous. The test was wrong, not the code.
4. **The E2E config was rejected** for `timeout: 300`, because §6 fixes the minimum at
   1000. The schema was right; the test was adjusted and `slow_sleep` now sleeps 4 s against
   a 1 s timeout.

---

## 7. Commits

```
179d58b fix(server): S2.7 correct /status payload; add inspector transcript spike
a887b58 test(e2e): S2.6 three fake upstreams, routing, isolation, auth and era coverage
e6b0072 feat(server): S2.4/S2.5 aggregated tools, bearer auth, HTTP layer and serve entrypoint
0c0a3db feat(upstream): S2.1/S2.2/S2.3 manager, RemoteUpstream and D4 namespacing
```