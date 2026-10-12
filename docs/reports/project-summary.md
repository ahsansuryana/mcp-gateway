# Project summary

What exists, what is verified where, what is deviated from the specification, and what is
still deferred.

**Status after the post-Sprint-7 follow-up.** Branches `sprint-1-*` … `sprint-7-hardening`,
`post-s7-followup`; the current branch is `post-s7-followup`. Sprint 7 was accepted; the
follow-up closed B-37 and settled B-35/B-36 (ADR 0011).

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
| **Distribution** | Installable as a global command (`@ahsansuryana/mcp-gateway`, bin `mcp-gateway`), config in `.mcp-gateway/`, `mcp-gateway init` |
| **Docs** | Config reference (generated), security, operations, manual tests, ADRs, per-sprint reports |

## 2. What is verified, and where

| Platform | Typecheck | Lint | Tests | Audit |
|---|---|---|---|---|
| **Windows** (local, Node 24.18) | 0 | clean | 29 files, **329 passed + 4 skipped** (333) | 0 vulnerabilities |
| **Linux** (`node:24-bookworm-slim` v24.21.0 **+ procps**, arm64) | 0 | clean | 29 files, **333 passed, 0 skipped** | 0 vulnerabilities |

The 4 skips are POSIX-only permission assertions; they run and pass on Linux. The Linux run
**must** have `procps` installed — without it the suite fails 4 assertions and the
process-tree test silently takes its degraded branch, which is the configuration the shipped
image provides (ADR 0010).

Docker host: **Armbian 25.5.1, `linux/arm64`, Engine 28.3.2** — a *remote* host, so Windows
paths cannot be bind-mounted and source travels as build context or a tar stream (B-29).
`docs/DEPLOY.md` carries the same warning for deployment: a bind-mount source resolves on the
daemon's host, not where you typed the command.

The 1 skipped test on Windows is a POSIX-only `chmod 0600` assertion; it runs and passes on
Linux. **That difference is the whole point of the Linux run.**

Also verified in the real image:

- `docker build` produces a working image running as the non-root `node` user.
- `scripts/smoke.sh` **PASSED inside the container on both Windows and Linux**, and it now
  makes a **real `tools/call`** through a local stdio upstream rather than skipping it. The
  call is asserted on the upstream's own reply, not merely on a 200 (F-1).
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
| **Lazy authentication is not implemented.** | **Confirmed NOT required to add a connector**: Anthropic's docs scope it to servers with a mix of public and protected tools, and defer the real baseline to requirements that apply "regardless of when it asks for sign-in". Every tool here needs an identity, so the gateway's "Sign in now" posture is the supported one. **Accepted as a limitation.** | ADR 0011, B-35 |
| **Scope step-up is not implemented.** | No `403 insufficient_scope` path, so Claude is never asked to re-authorize mid-session. **Accepted as a limitation.** | ADR 0011, B-36 |
| **One commit bundled S4.1/S4.3/S4.4.** | History deliberately not rewritten, by human decision. | `docs/reports/sprint-4.md` |

**Fixed rather than carried:** rate-limit buckets are now keyed by the **verified** issuer and
subject, each configured static key has its own bucket, and a rejected or forged token cannot
create or consume a bucket (F-3, closing B-37).

## 4. Deferred

| Item | State | Unblocks when |
|---|---|---|
| **S5-MANUAL** | **Deferred, never run.** Now the *gating* item: it needs only a reachable `publicUrl`, so it unblocks as soon as the gateway is deployed. | `docs/DEPLOY.md` step 9a |
| **S6-MANUAL** | **Deferred, never run**, and blocked on the authorization server. | An authorization server is chosen |
| **Authorization server** | **Not chosen.** No product is assumed anywhere in the code. | A human picks one against the 12 criteria |
| **The gateway's subdomain** | **Not yet supplied.** The value given was the literal placeholder `<SUBDOMAIN>`, so **no hostname was invented**: `publicUrl` stays configurable and unset in the repo. | The operator supplies the hostname |
| **Deployment topology** | **Chosen: Option A**, the gateway's own subdomain. The hostname previously recorded in ADR 0007 collides with the operator's existing MCP server and must not be touched. | — resolved |
| **Q-CLAUDE-GAPS** | Partly answered. **Still unknown: whether Claude's AS emits `iss`.** | Reading the remaining Anthropic pages |
| **CI** | `.github/workflows/verify.yml` runs and is green on `main`. It has **not** run on `feat/global-cli-and-config-dir`. | The branch is pushed |
| **Publishing** | The package is **not published**; `npm publish` was deliberately not run. Verified only as a local tarball installed in a container. | A decision to publish |
| **B-16** | `docs/CONFIG.md` is generated, but the CI drift *check* is not wired. | CI exists |
| **B-33** | Token-store key rotation is unsupported. | A future hardening sprint |

## 5. Reading order

1. `README.md` — what it is and how to run it
2. `docs/DEPLOY.md` — the option-A runbook, if you are deploying
3. `docs/adr/0012-global-cli-and-config-dir.md` — why config lives in `.mcp-gateway/`
4. `docs/CONFIG.md` — every field, generated from the schema
5. `docs/SECURITY.md` — threat model, "config is code", known deviations
6. `docs/OPERATIONS.md` — deployment options, keys, firewall, troubleshooting
7. `docs/MANUAL-TESTS.md` — the two deferred tests
8. `docs/reports/project-summary.md` — this file
9. Per-sprint reports in `docs/reports/` and `docs/adr/` for the reasoning behind each decision

## 6. One-paragraph honesty note

The protocol behaviour, the security boundaries and the whole test matrix are verified on two
operating systems and, for the container, in a real image on a real arm64 host. What is **not**
verified is the part that only a deployment can prove: a real authorization server, a real
browser consent flow, and a real claude.ai connector. The deployment hostname has not been
supplied, so the gateway has never been bound to a public origin and its CIMD document has
never been fetched by a real client.

Two deviations remain open upstream — the absent RFC 8707 `resource` parameter (ADR 0008) and
the unaudience-bound tokens it implies. Everything else previously listed as outstanding has
either been fixed (B-37) or explicitly accepted as a limitation with the documentation that
settles it (B-35, B-36, ADR 0011). None of this is discoverable from the repository alone,
which is why it is written here rather than left implicit.
