# Sprint 7 — Hardening and delivery

**Status:** complete. Linux verified on the live Docker host. Manual tests deferred.
**Branch:** `sprint-7-hardening`
**Commits:** 9, one per task ID plus two backlog notes and one doc consolidation.

| Commit | Task |
|---|---|
| `2c0c691` | S7.1 hot reload |
| `577b6c1` | S7.2 rate limiting |
| `5fbc1be` | S7.3 graceful shutdown |
| `71ad950` | S7.4 Dockerfile + compose + ADR 0010 |
| `4d46494` | S7.5 docs |
| `dd72632` | S7.6 smoke.sh + Docker verification |
| `3ca5940`, `3e0b811`, `1a98733` | backlog notes and the manual-test consolidation |

Pre-Sprint-7 commits on this branch: `6994c43` (gate decisions), `bb7fd7a` (P6-1 CIMD),
`212dcd0` (P6-2 fail-closed), `489f045` (P7-1 Linux workflow), `1c78439` (**P7-1 S5-LINUX
CLOSED**), `48b52ef` (P7-2), `07c0ba4` (P7-3), `37e45ec` (P7-4), `5ef3156` (P7-5).

---

## 1. Pre-Sprint-7 gate

| Item | Result |
|---|---|
| P7-1 S5-LINUX | **CLOSED.** Docker was unreachable because a **VPN** on the human's side was blocking the SSH route to the remote host. With it off: Linux green, **246 tests, 0 skipped** — including the POSIX-only `chmod 0600` assertion that had never run on the platform exercising it. |
| P7-2 Q-CLAUDE-GAPS | Lazy-authentication page read end to end. **One genuine conflict found** (lazy auth vs the gateway's 401-everything posture) → B-35. Three implemented decisions confirmed. One body-shape difference found and **not** silently changed. |
| P7-3 JWKS discovery | Wired with the four required constraints, all tested. |
| P7-4 2025-era compat | The gateway **does** accept 2025-era clients. **No v1 SDK dev dependency needed**, so no ADR and no exception to D2. |
| P7-5 ADR 0003 | **(A)** adopted: the SDK's native behaviour accepted. **(E)** implemented. `PLAN.md` §5(c) amended. |

### The ADR 0003 evidence

`npx tsx spikes/probe-mrtr-downstream.mjs`, downstream client declaring `capabilities: {}`:

```
RESULT type : JSON-RPC ERROR (thrown)
code        : -32021
message     : Cannot request input 'proceed' (elicitation/create): the request's
              client capabilities do not declare the required capability
```

### The (E) implementation detail worth recording

The first implementation watched the `catch` block and **never fired**. Measured: an upstream
answering `-32601` arrives as an **`isError` tool result**, not a thrown error — S4.7 recorded
that exact shape, and the SDK server converts a thrown `ProtocolError` from a handler into the
same shape while **dropping the numeric code**. The detector therefore matches the result, and
the fixture returns the canonical text rather than throwing, because a thrown error would
exercise a shape no real upstream produces.

## 2. Tasks

### S7.1 hot reload
File watch plus `SIGHUP`. Three rules: an invalid config keeps the running one (reload never
throws); the error names the key path only; **unchanged upstreams keep their credentials** —
proved against the in-repo fake AS, where the token is byte-identical after a reload that
added an unrelated upstream.

### S7.2 rate limiting
In-memory token bucket, disabled by default. Keyed by authenticated identity, **never by IP**;
the subject is **hashed** before becoming a map key so a bearer secret cannot sit in a heap
dump. `Retry-After` computed from the real refill time, rounded up.

### S7.3 graceful shutdown
Stop accepting → drain up to `DRAIN_MS` (10 s) → tear down → flush the token store. Tests
prove an in-flight request still completes with a real 200 while `stop()` runs, that a new
connection is then refused, and that a stdio child's **grandchild** is gone.

### S7.4 Dockerfile + compose
Multi-stage, non-root, no architecture pin. **ADR 0010** settles B-28 by measurement (below).

### S7.5 docs
`README.md`, generated `docs/CONFIG.md`, `docs/OPERATIONS.md`, `docs/SECURITY.md` updated.

### S7.6 smoke.sh + Docker
Ran inside the real image. **SMOKE TEST PASSED.**

## 3. Verification

### Windows

```
> npm run typecheck     → exit 0
> npm run lint          → clean
> npm test              → 26 files, 301 passed | 1 skipped (302)
> npm audit             → found 0 vulnerabilities
```

The 1 skip is the POSIX-only `chmod 0600` assertion.

### Linux — live Docker host

**Host: Armbian 25.5.1, `linux/arm64`, Docker Engine 28.3.2.** The daemon is remote, so a
Windows drive cannot be bind-mounted; source travels as build context or a tar stream, and
`MSYS_NO_PATHCONV=1` is required for `tar` and `docker` under Git Bash (B-29).

```
$ docker build -t mcp-gateway:s7 .
Successfully built 11ffafa257ea

$ docker create --name smoke-gw -e GATEWAY_API_KEY=... mcp-gateway:s7 serve
$ docker start smoke-gw && docker ps --filter name=smoke-gw --format '{{.Status}}'
smoke-gw | Up 12 seconds (healthy)

$ docker exec -e GATEWAY_API_KEY=... smoke-gw sh /app/scripts/smoke.sh
=== GET /healthz (unauthenticated) ===
  status: 200  body: {"ok":true}
  PASS healthz answers 200
  PASS healthz returns ok:true

=== POST /mcp identity (server/discover, or initialize on a 2025-era connection) ===
  server/discover -> status 200, body ... {"code":-32601,"message":"Method not found"}
  initialize       -> status 200, body ... "serverInfo":{"name":"mcp-gateway",...}
  PASS initialize reports the gateway identity (2025 era path)

=== POST /mcp tools/list (authenticated) ===
  PASS tools/list returns a tools array

=== POST /mcp without a credential is rejected ===
  status: 401
  PASS unauthenticated tools/list is 401

=== GET /status (authenticated) ===
  PASS status reports upstreams

=== POST /mcp tools/call (one real call) ===
  SKIP no upstream tools configured; nothing to call

=== secrets are not echoed back ===
  PASS /status does not contain the bearer key

SMOKE TEST PASSED
```

Full suite on `node:24-bookworm-slim` (v24.21.0):

```
> npm run typecheck  → exit 0
> npm run lint       → clean
> npx vitest run     → 26 files, 302 passed (302), 0 skipped
> npm audit          → found 0 vulnerabilities
```

**302 on Linux vs 301 + 1 skipped on Windows** is the POSIX-only assertion running.

## 4. ADR 0010 — procps, decided by measurement

Same probe, two real images:

| Image | `ps` | Result |
|---|---|---|
| `mcp-gateway:s7` (with procps) | present | `treeKill: no error`; child **and grandchild** dead; `EXIT=0` |
| stock `node:24-bookworm-slim` | absent | `Error: spawn ps ENOENT  syscall: 'spawn ps'` |

**Decision: install `procps`.** The process-group alternative was rejected because a
`StdioClientTransport` child is not started with `setsid`, so there is no group to signal, and
wrapping every spawn would mean not using the SDK transport's spawn at all.

The probe's first version reported `ps available: true` in **both** images because it checked
`spawn().spawnfile`, which exists whether or not the binary does. Recorded in the ADR,
because an earlier draft of that evidence was wrong in the direction that hides the problem.

## 5. Defects found and fixed

1. **There was no `serve` command.** `src/cli.ts` knew only `help` and `validate`, so the
   image's `CMD ["serve"]` exited with a usage error. PLAN.md §5 has listed it since Sprint 1.
   **Only running the container found this** — the unit tests never ran the binary.
2. **`index.ts` had a top-level `await import('node:url')`** in its invocation guard, which
   suspended module evaluation so `cli.ts` importing it waited forever.
3. **`cli.ts` awaited `main()` at top level**, and `main()` returns once the server is
   listening; awaiting it made Node exit.
4. **The rate limiter sorted the whole bucket map on every check** past `MAX_BUCKETS` — one
   O(n log n) sort **per request**. Linux surfaced it as a 5.7 s test; eviction is now an O(1)
   shift off an insertion-order queue.
5. **Two Windows-only timeouts** on process-spawning suites under parallel load, passing
   unchanged on Linux. The default test timeout is now 20 s. Harness fragility, not product.
6. **`docs/BACKLOG.md` table corruption**: an edit collapsed two rows and dropped B-29. Both
   restored with correct column counts.

## 6. Deviations

- **`gateway.authOAuth` is an additive sibling key, not a union** (ADR 0009), not the shape
  PLAN.md §6 suggested.
- **`jose` is a new runtime dependency**, pinned exactly at 6.2.12, zero transitive deps.
- **The JWKS default is discovery**, not the conventional `/.well-known/jwks.json`, so the
  earlier fallback note in `docs/reports/sprint-6.md` is superseded.
- **Rate-limit buckets do not separate OAuth subjects** (B-37): every OAuth caller shares one
  bucket.
- **Lazy authentication is not implemented** (B-35) and **scope step-up is not implemented**
  (B-31, B-36). Both are documented, not silently assumed.
- **The `401` body shape differs from Anthropic's example** (`{error: unauthorized}` vs
  `{error: invalid_token, …}`). The page calls the body advisory; the status and header,
  which carry the signal, match. Left unchanged and recorded.
- **`docs/CONFIG.md` is generated**; a CI drift check is still not wired (B-16 remains open
  for the check itself).

## 7. Open questions needing the human

| ID | Question |
|---|---|
| **Deployment topology** | Option A (own subdomain) or Option B (other server behind the gateway)? `docs/OPERATIONS.md` § 1. **Your decision; nothing was chosen.** |
| **Authorization server** | Still not chosen. 12 criteria are ready in `docs/ref/claude-connector-requirements.md` § 5. |
| **Q-CLAUDE-ERA** | Resolved: 2026-07-28 stays the single authority, claude.ai is a compatibility target. Remaining question: which concrete differences to accept. |
| **Q-CLAUDE-GAPS** | Partly answered by P7-2. **Still unknown: whether Claude's AS emits `iss`.** |
| **B-37** | Wire the OAuth `sub` into the rate-limit bucket key. |
| **B-35 / B-36** | Lazy authentication and scope step-up: implement, or accept as limitations? |

## 8. Risks

| Risk | Assessment |
|---|---|
| **No authorization server chosen** | Nothing can be tested against a real one. The in-repo fake covers the protocol, not a real AS's quirks. |
| **Manual tests never run** | Both are deferred; real deployments are unproven. |
| **Tokens not audience-bound** | ADR 0008, unresolved upstream. |
| **Rate limiting is coarse** | One shared bucket for all OAuth callers; one noisy tenant affects all. |
| **JWKS TTL vs rotation** | 10-minute `cacheMaxAge`; a rotated key can take up to the cooldown window to be used. Standard; not yet tuned. |
| **Rate limiter hashing cost** | SHA-256 per request. Measured acceptable, but it is per-request work added for the privacy property. |
| **Image size** | 491 MB vs a 249 MB base image, `procps` plus production `node_modules`. Not yet trimmed; `npm prune --omit=dev` is not applied. |