# Sprint 5 — Upstream OAuth (gateway as OAuth client)

**Status:** code complete; one platform NOT RUN (see § Verification); manual test BLOCKED on a
human decision (see § Manual test).
**Branch:** `sprint-5-oauth-client`
**Commits:** 8, one per task ID (plus two docs-only follow-ups attached to the tasks they
document).

| Commit | Task |
|---|---|
| `02cbb82` | S5.1 `docs/ref/oauth-flow.md` |
| `4b7b609` | Q-CIMD recorded (follow-up to S5.1) |
| `43c30d1` | S5.2 encrypted token store |
| `772e213` | S5.3 `OAuthClientProvider` |
| `40410e9` | S5.4 routes, `auth_required`, `/status` start URL |
| `3c62fb4` | S5.5 refresh with 60s skew |
| `1c28468` | S5.6 fake authorization server + full-flow suite |
| `3fd3f56` | S5 manual-test checklist |

Pre-Sprint-5 work on the same branch: `f627199` (B-24 integrity pass), `327f929` (ADR 0003),
`d7bd713` (gate decisions).

---

## 1. Tasks

### S5.1 — `docs/ref/oauth-flow.md`
Written **before** any OAuth code, as instructed. Reads `basic/authorization`,
`authorization-server-discovery` and `client-registration` end to end from the pinned
`2026-07-28` revision and lists **every MUST applying to the gateway as an OAuth client**,
each with its source line and the task that satisfies it.

Three findings that shaped the implementation:

- **RFC 9207 comparison forbids normalisation.** *"clients MUST NOT apply scheme or host case
  folding, default-port elision, trailing-slash, or percent-encoding normalization before
  comparison"* (index.md line 213). `https://as.example/` and `https://as.example` are
  different issuers for this check, so normalising URLs in the gateway would silently
  disable `iss` validation.
- **CIMD needs a hosted https document**, which needs `publicUrl`, which needs Q4. Blocked.
- **The 403 step-up flow is deferred**: v1 has no interactive surface.

### S5.2 — Token store
AES-256-GCM, key from `GATEWAY_TOKEN_KEY` (base64, exactly 32 bytes), atomic temp-file+rename,
mode 0600. Records keyed by `(upstreamName, issuer)`.

Store path resolves to `GATEWAY_TOKEN_STORE`, else `data/tokens.enc.json` **beside the config
file**. Windows has no POSIX mode bits, so `chmod` is a documented no-op there and the NTFS ACL
inherited from the directory is the control; a POSIX-only test asserts mode 0600 and is
`skipIf(win32)`.

### S5.3 — `OAuthClientProvider`
Only the policy the gateway owns. Discovery, PKCE, `iss` validation and the exchange are all
delegated to the SDK's `auth()` / `discoverOAuthServerInfo()` / `refreshAuthorization()`.
Registration order is fixed: config `clientId` → CIMD when advertised → DCR with a deprecation
warning → configuration error.

### S5.4 — Routes and `auth_required`
`GET /admin/oauth/:name/start` (302) and `GET /oauth/callback`, both behind the gateway bearer
key. The callback consumes the pending record by `state`, so a replay finds nothing, and
compares a present `iss` before any code is transmitted.

`auth_required` hides the upstream's tools and **stops the request path from re-dialling it**:
without that guard every downstream request retried the connection while waiting for a human.

### S5.5 — Refresh
60s skew (`REFRESH_SKEW_MS`). A token whose AS omitted `expires_in` is never proactively
refreshed. No refresh token stored ⇒ no refresh attempt. Failure clears the record.

### S5.6 — Fake authorization server
In-repo, local-only. Covers metadata discovery, PKCE S256 (including a **wrong-verifier
rejection**), the resource indicator, `iss` mismatch rejection, a **replayed-callback
rejection**, cross-issuer credential isolation, refresh rotation, and refresh failure.

---

## 2. Verification

### Windows — PASS

```
> npm run typecheck
> tsc --noEmit
exit=0

> npm run lint
> eslint .
(no output — clean)

> npm test
 Test Files  17 passed (17)
      Tests  198 passed | 1 skipped (199)
   Duration  32.89s

> npm audit
found 0 vulnerabilities
```

The 1 skip is the POSIX-only `0600` mode assertion on Windows.

### Linux (Docker) — **NOT RUN**

The Docker daemon became unreachable during Sprint 5. It was reachable in Sprint 4 (Armbian
remote host, `100.100.1.1`), and stopped accepting SSH mid-sprint:

```
$ docker version
 Client: Docker Context  homeserver-ts
 Server: Docker Engine  community
  Git commit: dfc4efb

error during connect: Get "http://docker.example.com/v1.55/version":
command [ssh -l root -o ConnectTimeout=30 -T -- 100.100.1.1 docker system dial-stdio]
has exited with exit status 255 ...
stderr=ssh: connect to host 100.100.1.1 port 22: Permission denied
```

Retried 4 times over ~3 minutes with the same result. **This is a NOT RUN, not a pass.**

What that leaves unverified on Linux, and what specifically could differ:

| Area | Linux risk |
|---|---|
| S5.6 fake AS over `127.0.0.1` | Low; the fake is pure Node HTTP. |
| `chmod` 0600 test | The one skipped test on Windows RUNS on Linux — it is currently unverified. |
| Token store file permissions | Same. |
| Everything else | Pure TypeScript/Node with no platform branch. |

The two OS-specific behaviours Sprint 5 touches are the `chmod` assertions, and they are the
ones that cannot be claimed green. Re-run on Linux before shipping.

### `data/` is git-ignored

`git status` stays clean because the encrypted token store lands in `data/`, which is ignored.

---

## 3. Defects found and fixed

1. **`StdioUpstream`/`GatewayOAuthProvider` field-initializer ordering** (carried from S4).
2. **`invalidCredentials('client')` destroyed a valid access token.** It replaced the whole
   stored record, so a server rejecting only the client identity forced the user to re-consent.
3. **Token store read sliced the base64 TEXT by byte offsets.** On a wrong key it produced
   `Invalid authentication tag length: 24` instead of a decryption failure — i.e. it did not
   fail closed. Now decodes once and slices bytes.
4. **Token store path resolved against `process.cwd()`.** Two gateways from different
   directories shared one file; under a parallel test run one suite's key could not decrypt
   another's store and the upstream was reported `error` instead of `auth_required`. Now
   anchored to the config file's directory, overridable per deployment.
5. **`oauth.clientSecret` was never registered with the logger's redaction list**, so a client
   secret could have been printed. `secretsFromConfig` now collects it.
6. **The fake AS issued a refresh token it did not store** (generated two strings, returned
   one). Every refresh would have been rejected; the test caught it.
7. **`OAuthService.refreshIfNeeded` used `auth()`**, which returns `REDIRECT` for a token
   inside the gateway's own skew window — demanding a fresh consent instead of using the
   refresh token already held. Switched to the SDK's `refreshAuthorization()`.

---

## 4. Deviations

- **The SDK sends no `resource` parameter** (Q-SDK-RESOURCE). The spec makes it a MUST in both
  the authorization and the token request, and says to send it regardless of AS support
  (index.md lines 219-222, 254). Measured with `@modelcontextprotocol/client` 2.3.1: absent
  from both. **Not worked around** — doing so means hand-rolling the authorization URL, which
  the S5.3 instruction forbids without an ADR. The test asserts the observed defect on purpose
  so it fails loudly if the SDK changes.
- **`clientMetadataUrl` is not in PLAN.md §6.** §6 allows only `clientId`, `clientSecret`,
  `scope`. The field is derived from `publicUrl`, not configured, so no schema change was
  needed — but a config field would be an ADR.
- **CIMD is unreachable while Q4 is open.** The branch is implemented and selected correctly;
  it reports a warning and falls back instead of failing opaquely.
- **No 403 / `insufficient_scope` step-up.** Deferred with a BACKLOG entry.
- **Linux NOT RUN.** See § Verification.

---

## 5. Open questions needing the human

| ID | Question |
|---|---|
| **Q4** | Hosting target and public hostname. Blocks CIMD, blocks Sprint 6 metadata, blocks the S5 manual test. |
| **Q-CIMD** | (a) answer Q4, (b) keep CIMD disabled and rely on deprecated DCR, or (c) accept an operator-supplied `clientMetadataUrl`. |
| **Q-SDK-RESOURCE** | Ship without `resource`, write an ADR for a narrow hand-rolled parameter, or ask the SDK team. |
| **Manual test** | Which of the three options in `docs/reports/sprint-5-manual-test.md`. |

Also still open from earlier sprints: Q-CORS, Q-HDRPREC, Q-DEVNAMES.

## 6. Risks

| Risk | Assessment |
|---|---|
| No `resource` parameter | Authorization servers that *require* RFC 8707 `resource` will reject or issue over-broad tokens. Notion's metadata advertises `resource`, so this may surface during the manual test. |
| CIMD unimplementable | Any authorization server supporting **only** CIMD is unusable until Q4 is answered. |
| Linux unverified | Two file-permission assertions have not run on the platform that exercises them. |
| Token store key management | A key that is lost makes every stored token unrecoverable; a leaked key exposes all of them. Not yet documented for operators — `docs/SECURITY.md` needs a section in Sprint 7. |
| B-24 prompts/resources relay | Fixed and regression-guarded, but the relay path itself is only covered by the three new E2E tests. |

## 7. Generated key command

For an operator to create the token-store key (never printed or committed by the agent):

```bash
# Linux/macOS
openssl rand -base64 32
```

```powershell
# Windows PowerShell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($b); [Convert]::ToBase64String($b)
```

## 8. Not done

Sprint 6 was not started. `docs/BACKLOG.md` gained the step-up flow entry.