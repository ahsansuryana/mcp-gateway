# Project summary

What exists, what is verified where, what is deviated from the specification, and what is
still deferred.

**Status at the end of Sprint 7.** Branches `sprint-1-*` … `sprint-7-hardening`; the current
branch is `sprint-7-hardening`.

---

## 1. What exists

An aggregated MCP gateway in TypeScript, ESM, Node ≥ 20.19, on `@modelcontextprotocol/*`
v2 pinned exactly.

| Layer | What it does |
|---|---|
| **Config** | JSONC with `{env:}` / `{file:}` substitution, strict zod validation, JSON Schema export |
| **HTTP** | One `POST /mcp`, `/healthz` (unauthenticated), `/status` (authenticated), Origin allowlist, body-size limit |
| **Aggregate** | Namespaced tools/prompts, rewritten resource URIs, per-upstream timeouts, `ttlMs`/`cacheScope`, D12 `isError` mapping |
| **Upstream — remote** | Streamable HTTP, static headers, OAuth as a client (DCR / CIMD) |
| **Upstream — local** | stdio child processes: lazy start, startup timeout, idle shutdown, crash detection, backoff, stderr capture |
| **Inbound OAuth** | RFC 9728 protected-resource metadata, `WWW-Authenticate` challenge, JWT validation via `jose` against a discovered JWKS |
| **Subscriptions** | `subscriptions/listen` fan-out with D17 debounce and truthful `listChanged` advertisement |
| **Operations** | Hot reload + `SIGHUP`, rate limiting, graceful shutdown, Dockerfile, compose, smoke test |
| **Docs** | Config reference (generated), security, operations, manual tests, ADRs, per-sprint reports |

## 2. What is verified, and where

| Platform | Typecheck | Lint | Tests | Audit |
|---|---|---|---|---|
| **Windows** (local, Node 24.18) | 0 | clean | 26 files, **301 passed + 1 skipped** | 0 vulnerabilities |
| **Linux** (`node:24-bookworm-slim`, v24.21.0, arm64) | 0 | clean | 26 files, **302 passed, 0 skipped** | 0 vulnerabilities |

Docker host: **Armbian 25.5.1, `linux/arm64`, Engine 28.3.2** — a *remote* host, so Windows
paths cannot be bind-mounted and source travels as build context or a tar stream (B-29).

The 1 skipped test on Windows is a POSIX-only `chmod 0600` assertion; it runs and passes on
Linux. **That difference is the whole point of the Linux run.**

Also verified in the real image:

- `docker build` produces a working image running as the non-root `node` user.
- `scripts/smoke.sh` **PASSED** inside the container.
- The process-tree kill terminates a child **and its grandchild** with `procps` installed, and
  fails with `spawn ps ENOENT` without it (ADR 0010, measured in two real images).

**Never verified on any platform:** the two manual tests. They need a public deployment.

## 3. Known deviations

| Deviation | Why | Where |
|---|---|---|
| **Upstream tokens are not audience-bound.** The SDK does not send the RFC 8707 `resource` parameter. | Interim policy (a)+(c); an issue is drafted for the SDK team and not posted. | ADR 0008, `docs/SECURITY.md` |
| **The 2025-era `2026-07-28` split.** The project is pinned to `2026-07-28`; claude.ai follows `2025-11-25`. | `2026-07-28` is the single authority; claude.ai is a compatibility target. Differences listed. | `docs/ref/claude-connector-requirements.md` |
| **`gateway.authOAuth` is an additive sibling key**, not the union PLAN.md §6 suggested. | No breaking change; "both mechanisms work" is the default state. | ADR 0009 |
| **MRTR elicitation: the SDK's native `-32021` is accepted**, not a custom `isError`. | The SDK already enforces it with a spec-defined code. | ADR 0003 |
| **Rate-limit buckets do not separate OAuth subjects.** | Every OAuth caller shares one bucket. | B-37 |
| **Lazy authentication is not implemented.** | The gateway requires a credential before any `/mcp` request — Claude's supported "Sign in now" mode. | B-35 |
| **Scope step-up is not implemented.** | No `403 insufficient_scope` path. | B-31, B-36 |
| **One commit bundled S4.1/S4.3/S4.4.** | History deliberately not rewritten, by human decision. | `docs/reports/sprint-4.md` |

## 4. Deferred

| Item | State | Unblocks when |
|---|---|---|
| **S5-MANUAL / S6-MANUAL** | Both **deferred, never run**. Consolidated in `docs/MANUAL-TESTS.md`. | The gateway is deployed behind a public URL |
| **Authorization server** | **Not chosen.** No product is assumed anywhere in the code. | A human picks one against the 12 criteria |
| **Deployment topology** | **Not chosen.** Option A (own subdomain) and Option B (other server behind the gateway) are both documented with trade-offs. | A human decides; see `docs/OPERATIONS.md` § 1 |
| **Q-CLAUDE-GAPS** | Partly answered. **Still unknown: whether Claude's AS emits `iss`.** | Reading the remaining Anthropic pages |
| **CI** | `.github/workflows/verify.yml` is written but the repository has **no git remote**, so it has never run. | A remote is configured and the workflow is pushed |
| **B-16** | `docs/CONFIG.md` is generated, but the CI drift *check* is not wired. | CI exists |
| **B-33** | Token-store key rotation is unsupported. | A future hardening sprint |

## 5. Reading order

1. `README.md` — what it is and how to run it
2. `docs/CONFIG.md` — every field, generated from the schema
3. `docs/SECURITY.md` — threat model, "config is code", known deviations
4. `docs/OPERATIONS.md` — deployment options, keys, firewall, troubleshooting
5. `docs/MANUAL-TESTS.md` — the two deferred tests
6. `docs/reports/project-summary.md` — this file
7. Per-sprint reports in `docs/reports/` for the reasoning behind each decision

## 6. One-paragraph honesty note

The protocol behaviour, the security boundaries and the whole test matrix are verified on two
operating systems and, for the container, in a real image. What is **not** verified is the
part that only a deployment can prove: a real authorization server, a real browser consent
flow, and a real claude.ai connector. Two known deviations remain open with upstream or with
the human. None of that is discoverable from the repository alone, which is why it is written
here rather than left implicit.
