# Sprint 6 — Inbound OAuth (gateway as protected resource)

**Status:** code complete. Linux **NOT RUN**. Manual connector test not performed (blocked on
deployment + authorization server).
**Branch:** `sprint-6-oauth-resource`
**Commits:** 5, one per task ID.

| Commit | Task |
|---|---|
| `68e680f` | S6.0 ADR — option A, resource server only |
| `6d544ce` | S6.0b research — what claude.ai connectors require |
| `1f99f95` | S6.2 ADR — `gateway.auth` oauth variant (written **before** implementation) |
| `317f233` | S6.1 + S6.2 implementation |
| `c8b973c` | S6.3 tests + claude.ai manual checklist |

Pre-Sprint-6, on the same branch: `6994c43` (gate decisions), `bb7fd7a` (P6-1 CIMD document),
`212dcd0` (P6-2 token store fails closed).

---

## 1. Pre-Sprint-6 items

| Item | Result |
|---|---|
| Decisions recorded | ADR 0007 (Q4 + Q-CIMD), ADR 0008 (Q-SDK-RESOURCE), `SECURITY.md` deviation section, draft SDK issue, BACKLOG S5-MANUAL + S5-LINUX |
| P6-1 CIMD document | `GET /.well-known/oauth-client.json`, only when `publicUrl` is set; CIMD path throws naming `gateway.publicUrl` when unset |
| P6-2 fail-closed | 9 tests; reverting the Sprint 5 base64 bug makes **4 of them fail** with `Invalid authentication tag length: 24` |
| P6-3 clean tree + suite | clean, 223 passed at that point |

## 2. Tasks

### S6.0 — ADR 0005, option A
Replaces the Sprint 5 stub with the decision PLAN.md S6.0 required. The gateway is a resource
server and nothing more: no token minting, no authorization endpoint, no user store, no
inbound refresh token. Option B is **rejected, not deferred**, with a threat-model table:
an authorization server sharing a process that also runs `npx` children and holds upstream
OAuth credentials is a bad trade.

### S6.0b — research
`docs/ref/claude-connector-requirements.md`, from Anthropic's official docs, with source URLs.

**The finding that matters most: Claude follows the `2025-03-26` / `2025-06-18` / `2025-11-25`
authorization specifications, while PLAN.md pins this project to `2026-07-28`.** Logged as
Q-CLAUDE-ERA. Everything Claude documents is still implementable under our revision; the
divergence is in requirements Claude does not state.

Also captured, with citations: a `401` is mandatory (a `WWW-Authenticate` on a `200` is
**ignored**); `resource` must equal the MCP URL exactly including `/mcp`; only the **first**
`authorization_servers` entry is read; audience must be checked against the **canonical** URL
rather than a byte-for-byte match; the AS must support CIMD (gated on **two** metadata
values) or DCR; it must accept `https://claude.ai/api/mcp/auth_callback` **and** port-agnostic
loopback; form-urlencoded token endpoint; refresh rotation with `invalid_grant`; egress from
`160.79.104.0/21`.

Four things the docs do **not** say are recorded as Q-CLAUDE-GAPS rather than guessed.

No authorization server product is chosen. The doc ends with 12 criteria to check against any
candidate's live metadata.

### S6.1 — protected resource
- RFC 9728 metadata at `/.well-known/oauth-protected-resource/mcp` and at the root.
- A real `401` with `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`.
- Signature verified against a remote JWKS with `jose@6.2.12` (verified with `npm view` and
  its README first: zero dependencies, ESM, documented `jwtVerify` + `createRemoteJWKSet`).
- Issuer, audience and expiry validated. Rejections are a **named reason**, never a library
  message, so no token or key material can reach a log line.

### S6.2 — schema (ADR 0009 first)
`gateway.authOAuth` is **additive and optional**. Empty `auth.keys` is allowed **only** when
`authOAuth` is present; a config with neither is rejected at startup, because it would leave
`/mcp` open to anyone who can reach the port.

### S6.3 — tests and checklist
See § 3. Checklist in `docs/reports/sprint-6-manual-test.md`.

## 3. Test coverage

An in-repo fake authorization server **mints real RS256 JWTs and serves a real JWKS**, so
signature verification is genuinely exercised.

| Case | Result |
|---|---|
| Valid RS256 token | 200 |
| Static bearer key, side by side | 200 |
| Expired | 401 + challenge |
| Wrong issuer | 401 + challenge |
| Wrong audience | 401 + challenge |
| Signed with a **different key** | 401 + challenge |
| Tampered payload | 401 + challenge |
| `alg: none` | 401 + challenge |
| `HS256` with a shared secret | 401 + challenge |
| No `Authorization` header | 401 + challenge |
| Non-bearer scheme | 401 + challenge |
| `/healthz` unauthenticated | 200 |
| `/status` unauthenticated | 401 |
| Metadata `resource` equals the MCP URL | asserted |
| `authorization_servers` has exactly one entry | asserted |

Two of those are **structurally impossible to configure**, not merely switched off: only
asymmetric algorithms are passed to `jwtVerify`, so `alg=none` and `HS256` can never verify.
A symmetric key would be a shared secret, which ADR 0005 option A forbids on this path.

Security-review canaries: a rejected token never appears in the response body or the
challenge; the gateway never proxies or echoes a JWKS; an authorization-server outage yields
a plain `401` with no `ECONNREFUSED` text; `authOAuth` without `publicUrl` is a startup
error, not a silent downgrade.

## 4. Verification

### Windows — PASS

```
> npm run typecheck
> tsc --noEmit
exit=0

> npm run lint
> eslint .
(clean)

> npm test
 Test Files  20 passed (20)
      Tests  245 passed | 1 skipped (246)
   Duration  37.64s

> npm audit
found 0 vulnerabilities
```

The 1 skip is the POSIX-only `chmod 0600` assertion, unchanged since Sprint 5.

### Linux — **NOT RUN**

Retried at the end of this sprint; the remote Docker host is still unreachable:

```
$ docker version --format '{{.Server.Version}}'
error during connect: Get "http://docker.example.com/v1.55/version":
command [ssh -l root -o ConnectTimeout=30 -T -- 100.100.1.1 docker system dial-stdio]
has exited with exit status 255 ...
stderr=ssh: connect to host 100.100.1.1 port 22: Permission denied
```

**NOT RUN at the time of writing, and not claimed as a pass.** Tracked as S5-LINUX.

> **Closed 2026-10-10 (Sprint 7, P7-1).** The cause was a VPN on the human's side. With it
> off, the remote Docker host answered and the full matrix ran green on Linux:
> typecheck 0, lint 0, **246 tests passed / 20 files**, `npm audit` 0 vulnerabilities.
> 246 rather than Windows' 245 + 1 skipped, because the POSIX-only `chmod 0600` token-store
> assertion ran and passed. Evidence in `docs/reports/sprint-7.md`.

## 5. Defects found and fixed

1. **`client_id` was injectable through the Host header.** P6-1 first derived it from the
   request, which let any caller that reached the gateway rewrite the identity an
   authorization server was about to trust — and produced an `http://` client_id over the
   plain-HTTP test transport. It is now derived from `publicUrl`, which is also what makes
   the "client_id MUST match the document URL exactly" MUST hold in production.
2. **CIMD silently downgraded to deprecated DCR.** When an AS advertised CIMD but
   `publicUrl` was unset, the gateway logged a warning and fell through to DCR. It now
   throws naming `gateway.publicUrl`.
3. **A config with no inbound credential at all would have been accepted.** Relaxing
   `auth.keys` to allow the OAuth-only case created that hole; a cross-field refinement
   closes it.

## 6. Deviations

- **`gateway.auth` gained a sibling key (`authOAuth`) rather than becoming a union**, which is
  not the shape PLAN.md §6 suggested ("accepts an array or a `type: "oauth"` variant").
  ADR 0009 explains why: no breaking change, and "both work" is the default state rather than
  a mode to remember.
- **`jose` is a new runtime dependency.** Verified with `npm view` and its README per rule 4;
  pinned exactly at 6.2.12. Zero transitive dependencies.
- **The JWKS URI defaults to `<issuer>/.well-known/jwks.json`** when `jwksUri` is not
  configured. The real discovery path (`jwks_uri` from the authorization-server metadata) is
  not wired yet; a mismatch surfaces as `unknown_key`, never as a silent pass. Recorded
  below as a decision.
- **Token rejection reasons are coarse** (`wrong_audience` vs `wrong_issuer` vs
  `unknown_key`). Deliberate: a more precise reason would help an attacker enumerate.
- **No `iss` requirement is enforced inbound.** Q-CLAUDE-GAPS records that Claude's
  documentation never mentions `iss`; requiring it would risk rejecting a valid Claude
  client.
- **Linux NOT RUN.**

## 7. Open questions needing the human

| ID | Question |
|---|---|
| **Q-CLAUDE-ERA** | Keep `2026-07-28` as the single authority and treat Claude's behaviour as a compatibility target, or pin `2025-11-25` for the inbound path too? |
| **Q-CLAUDE-GAPS** | Read the remaining referenced Anthropic pages (notably lazy-authentication) before choosing an authorization server? |
| **JWKS discovery** | Wire `jwks_uri` discovery from the AS metadata, or is the conventional path plus an explicit `jwksUri` acceptable for v1? |
| **S5-LINUX** | Close the Linux verification gap before Sprint 7. |
| **S5-MANUAL** | Run the deferred Sprint 5 manual test once deployed. |

## 8. Risks

| Risk | Assessment |
|---|---|
| **No authorization server chosen** | The gateway cannot be tested against a real one until the human picks one. The in-repo fake covers the protocol; it does not cover a real AS's quirks. |
| **Claude's older spec revision** | Requirements Claude does not state (notably `iss`) could differ from ours. Mitigated by not requiring them. |
| **`160.79.104.0/21` allowlist** | The gateway is unreachable to Claude until the firewall allows it. Operational, not code. |
| **Audience derivation** | Derived from `publicUrl` + `/mcp`. If the AS mints a different audience, every request 401s. Mitigated by the explicit `audience` override. |
| **JWKS caching** | A 10-minute `cacheMaxAge` plus `createRemoteJWKSet` means a rotated signing key can take up to the cooldown window to be picked up. Standard for this pattern; not yet tuned to the operator's needs. |
| **Linux unverified** | Unchanged from Sprint 5. |