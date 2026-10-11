# What claude.ai custom connectors require from this gateway and from its authorization server

Reference for PLAN.md **S6.0b**. Research only — **no authorization server product is chosen
here**. Every statement below is taken from Anthropic's official documentation, with the
source URL, and nothing is recalled from memory.

## Sources

| # | Page | URL |
|---|---|---|
| 1 | Authentication for connectors | https://claude.com/docs/connectors/building/authentication |
| 2 | Build an MCP server for Claude | https://claude.com/docs/connectors/building |
| 3 | Troubleshoot your connector | https://claude.com/docs/connectors/building/troubleshooting |
| 4 | Add a connector that isn't in the directory | https://claude.com/docs/connectors/custom/add-unlisted |
| 5 | Third party connectors with remote MCP | https://claude.com/docs/connectors/custom/remote-mcp |
| 6 | MCP connectors (Help Center) | https://support.claude.com/en/articles/14503689-mcp-connectors |

Anthropic's egress range, referenced by page 1: https://platform.claude.com/docs/en/api/ip-addresses

---

## 1. The finding that changes the plan's assumptions

Page 2 states:

> "Specification version: Claude follows the `2025-03-26`, `2025-06-18`, and `2025-11-25`
> authorization specifications"

and page 1 links its CIMD requirement to
`modelcontextprotocol.io/specification/2025-11-25/basic/authorization`.

PLAN.md §3 pins this project to spec revision **`2026-07-28`**, and every spec citation in
`docs/ref/` is from that revision. So:

**Claude's authorization behaviour is pinned to an EARLIER revision than ours.** Everything
below is therefore a *constraint from a different spec revision*, and where the two disagree
the conflict must be resolved deliberately, not assumed away. Recorded in
`docs/OPEN-QUESTIONS.md` as **Q-CLAUDE-ERA**.

Concretely visible: the gateway's own `/status` and error mapping follow `2026-07-28`'s
`WWW-Authenticate` shape, and `2026-07-28` additionally documents an `iss` requirement on
authorization responses. Claude's documented requirements below do not mention `iss` at all.
Nothing forbids Claude from *sending* it; the point is that its absence cannot be assumed to
break Claude, while its presence must not be *required* by us for Claude specifically.

## 2. Requirements on **this gateway** (we are the resource server)

### 2.1 Protected Resource Metadata

| # | Requirement | Source | Status in this repo |
|---|---|---|---|
| G1 | Serve RFC 9728 protected-resource metadata | p1 "Serve discovery metadata" | **Not implemented** — Sprint 6.1 |
| G2 | Unauthenticated requests **MUST** be answered `401`; a `WWW-Authenticate` header on a `200` is **ignored** | p1 | **Not implemented** — Sprint 6.1 |
| G3 | The `401` **MUST** carry `WWW-Authenticate: Bearer resource_metadata="<absolute HTTPS URL>"` | p1 | Not implemented |
| G4 | The document's `resource` **MUST equal the MCP server URL exactly**, including any path component | p1 | For us: `https://example.invalid/mcp` |
| G5 | `authorization_servers` **MUST** list the primary issuer **first**; Claude uses only the first entry and does not fall back | p1 | Not implemented |
| G6 | Scopes: put `scope` in the `WWW-Authenticate` `401`, or Claude uses `scopes_supported` from the PRM | p1 | Not implemented |

Canonical `401` shape, quoted from p1:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"
```

The `resource_metadata` URL "doesn't have to be on the MCP server's origin" (p1) — useful if
the deployment cannot serve `/.well-known/*` at the root.

### 2.2 Audience / resource binding

Page 3, "Audience mismatch":

> "Claude sends the RFC 8707 `resource` parameter on authorization and token requests, set to
> the canonical form of your MCP server URL, including any path component. The canonical form
> has a lowercase scheme and host, no trailing slash, no fragment, and no default port. Your
> authorization server should issue tokens with that audience, and your MCP server should
> **accept the canonical value when checking `aud` rather than doing a strict byte-for-byte
> comparison against what the user typed**."

Two consequences for Sprint 6.1:

1. The audience we validate against is the **canonical** form of our MCP URL
   (`https://example.invalid/mcp` — no trailing slash), not whatever a user typed into the
   connector dialog.
2. Claude **does** send `resource`. This is the consumer side of the deviation recorded in
   `docs/adr/0008-rfc8707-resource-parameter-interim.md`: we do not send it when *we* are the
   client toward an upstream, but Claude does send it when it is the client toward us. The
   authorization server must therefore be willing to audience-bind.

### 2.3 Network

Page 1, "Network reference":

> "Anthropic's outbound traffic to your server originates from `160.79.104.0/21`."

Page 5 adds that a server "must be reachable over the public internet from Anthropic's IP
ranges", and that a WAF in front of the identity provider can break the flow even when the
MCP server is reachable, because discovery requests to the authorization server come from the
same range.

**Operational consequence:** the firewall must allow `160.79.104.0/21` inbound to the gateway,
and the same range inbound to the authorization server's `/.well-known/` paths.

### 2.4 Latency (bears on our upstream timeouts, not our inbound path)

Page 1, "Endpoint latency": Claude waits **10 s** for discovery, registration and token
endpoints, and **30 s** for refresh. It treats a timeout as a flow failure even if the server
later completes. Applies to the external AS, not to us.

## 3. Requirements on the **external authorization server** (the operator must choose it)

### 3.1 Client registration — the hard constraint

Claude needs a client identity. Page 1:

> "Claude selects CIMD only when your authorization server metadata advertises **both**
> `"client_id_metadata_document_supported": true` **and** `"none"` in
> `token_endpoint_auth_methods_supported`. The second is required because Claude's CIMD client
> authenticates as a public client at your token endpoint. If either is missing, Claude falls
> back to DCR."

So the authorization server must satisfy **at least one** of:

- **CIMD**: metadata advertises `client_id_metadata_document_supported: true` **AND**
  `"none"` in `token_endpoint_auth_methods_supported`.
- **DCR**: metadata exposes a `registration_endpoint`.
- *(Not available to us as an automatic path)* `oauth_anthropic_creds` and
  `custom_connection` both require emailing `mcp-review@anthropic.com`.

Page 1 warns about DCR at scale:

> "DCR causes Claude to register a new client on every fresh connection, which can result in
> very large numbers of registered clients on your authorization server."

For a custom connector (one user, our gateway), that is a non-issue. For a directory listing,
it is not.

### 3.2 Redirect URIs — both must be accepted

Page 1, "Callback URLs":

| Surface | Redirect URI to accept |
|---|---|
| Hosted apps (claude.ai web, Desktop, mobile, Cowork) | exactly `https://claude.ai/api/mcp/auth_callback` |
| Claude Code | loopback on **any** port; Claude Code declares `http://localhost/callback` and `http://127.0.0.1/callback` and requires a **port-agnostic** match |

> "Apply the same port-agnostic match to `localhost` so Claude Code works, even though RFC 8252
> section 8.3 discourages `localhost`."

Also required, per page 1: display the redirect URI's hostname clearly on the consent screen,
with an extra warning when the only registered redirect URIs are loopback.

### 3.3 Token endpoint

| # | Requirement | Source |
|---|---|---|
| A1 | **MUST** accept `Content-Type: application/x-www-form-urlencoded` for both the code exchange and refresh; otherwise answer `415` | p1 |
| A2 | `/register` (DCR) uses `application/json` per RFC 7591 — a different parser | p1 |
| A3 | Invalid refresh **MUST** return RFC 6749 `invalid_grant`, not `invalid_request` or a custom code | p1 |
| A4 | Refresh tokens **MUST** be rotated for public clients (DCR and CIMD both register Claude as a public client); the new refresh token goes in the same response that invalidates the old one | p1 |
| A5 | `code_challenge_methods_supported` **MUST** advertise `["S256"]` | p1, MCP authorization spec |
| A6 | PKCE S256 on every authorization request, regardless of registration mechanism | p1 |
| A7 | Claude refreshes reactively on a `401` and proactively up to **five minutes** before expiry | p1 |

Note A7: Claude's proactive window is **5 minutes**, whereas our upstream OAuth client uses a
**60 second** skew (S5.5). Different clients, different policies; both are their own choice.

### 3.4 Scopes

Page 1: Claude appends `offline_access` when the authorization server metadata lists it in
`scopes_supported`, to obtain a refresh token.

### 3.5 Not supported

> "A machine-to-machine `client_credentials` grant isn't supported" (p1)

The authorization server must therefore implement the **authorization code** flow with a
logged-in user. There is no headless service-account path.

## 4. What the docs do **not** say

Recorded in `docs/OPEN-QUESTIONS.md` as **Q-CLAUDE-GAPS** rather than guessed:

1. **No `iss` requirement.** The MCP `2025-11-25` revision Claude follows, and Claude's own
   documentation, say nothing about the RFC 9207 `iss` parameter on authorization responses.
   Whether Claude sends it is unknown from the docs.
2. **No statement about `resource`-less tokens.** Since Claude sends `resource`, an AS that
   requires it is fine — but nothing says what Claude does if a token arrives without it.
3. **No published list of authorization servers known to satisfy §3.1.** The docs name Auth0,
   Okta, Microsoft Entra, Keycloak and Supabase Auth only as examples of hosts that serve
   `/.well-known/openid-configuration`; they do not say which of them satisfy the CIMD
   two-flag rule.
4. **`oauth_anthropic_creds` and `custom_connection`** are described but require contacting
   Anthropic; no self-service path is documented.

## 4b. Behaviour BEFORE authentication (added in Sprint 7, P7-2)

Source: https://claude.com/docs/connectors/building/lazy-authentication (read end to end).

This page documents **lazy authentication** ("mixed auth"): a connector where Claude can
connect, list tools and call public tools with no sign-in, and is asked to sign in only when
it reaches a protected tool.

### What Claude requires for lazy auth

| Requirement | Consequence for this gateway |
|---|---|
| "A tool handler can't produce that response: once the MCP SDK is running a tool, whatever the handler returns is wrapped in a `200`. The check has to run in your HTTP handler, on the parsed JSON-RPC body, before the request reaches the SDK." | A protected-tool gate must live in the Express layer, BEFORE `toNodeHandler`. |
| "`initialize`, `tools/list`, and calls to public tools never hit the gate, so the connector is fully usable before sign-in." | `server/discover` and `tools/list` must be answerable **without a credential**. |
| "Only a transport-level `401` causes Claude to pause the call, run the OAuth flow, and retry." | A `200` wrapping `isError: true` does NOT trigger sign-in. |
| "`403` triggers re-authentication only when accompanied by `WWW-Authenticate: Bearer error=\"insufficient_scope\"` … any other `403` is surfaced as a terminal error." | Scope step-up needs that exact header (see B-31). |

### **This conflicts with what the gateway implements today**

The gateway currently rejects **every** unauthenticated `POST /mcp` with `401` — including
`tools/list` and `server/discover`. That is Claude's **"Sign in now"** mode, which Claude
fully supports (https://claude.com/docs/connectors/custom/add-unlisted, "Authentication:
Sign in now").

Lazy authentication is a **different, optional** mode. Supporting it would require per-tool
auth policy, which the gateway has no configuration for and which no task in PLAN.md asks
for.

**Decision taken: not implemented, and documented here rather than silently assumed.** If
per-user visibility of tool names matters (so a user can browse the catalog before
consenting), that is a future feature with a real design question attached — not a bug fix.
Recorded in `docs/BACKLOG.md` as B-35.

### Is lazy authentication REQUIRED to add a connector? (answered F-5)

**No. It is not required, and the gateway does not need it.**

Reading both pages in full, lazy authentication is described as an option conditioned on the
server having a *mix* of tools, not as an entry requirement. The lazy-authentication page opens
by scoping itself: *"This page is for developers whose MCP server has some tools that work
without the user's identity"* (https://claude.com/docs/connectors/building/lazy-authentication).
The authentication page repeats the same conditional framing — *"**If** some of your tools work
without the user's account, see Lazy authentication"* — and lists lazy auth as an alternative in
the `none` row of the supported-authentication-types table rather than as a requirement
(https://claude.com/docs/connectors/building/authentication). Crucially, that page states the
baseline explicitly: the lazy-auth page itself defers to it as *"the OAuth requirements **every
server must meet regardless of when it asks for sign-in**"*.

What every server must meet is therefore independent of lazy auth: answer unauthenticated
requests with a real `401` carrying `WWW-Authenticate` (including `resource_metadata`), publish
RFC 9728 protected-resource metadata, and support PKCE S256 plus CIMD-or-DCR at the
authorization server. The gateway implements all of that (Sprint 6, ADR 0005).

This gateway requires a credential for **every** `POST /mcp` — a static bearer key or a valid
OAuth token — which is the ordinary all-tools-need-an-identity case. There is no public subset
of tools to expose before sign-in, so the precondition that makes lazy auth meaningful does not
apply. That is the supported "Sign in now" configuration, not a gap.

**Consequence: B-35 can be closed as an accepted limitation rather than an open defect.** It
stays a *feature* someone may want later — per-tool auth policy, so a user could browse a
catalog before consenting — but it is not a blocker for adding a connector, and no work is
owed against it. B-36 (scope step-up, the `403 insufficient_scope` path) remains a separate,
genuinely optional feature and is also accepted as a documented limitation.

### What this page CONFIRMS about decisions already made

1. **Token verification.** "check the JWT signature, that `iss` matches your authorization
   server, that `aud` equals the `resource` value you advertise in your protected resource
   metadata, and `exp`, or use RFC 7662 token introspection". That is exactly what S6.1
   implements. No change needed.
2. **The `WWW-Authenticate` parameters.** The documented value is
   `Bearer error="invalid_token", error_description="…", resource_metadata="…", scope="…"`
   — the same four parameters the gateway emits. No change needed.
3. **CIMD's two-flag rule**, restated: `client_id_metadata_document_supported: true` **and**
   `"none"` in `token_endpoint_auth_methods_supported`. No change needed.
4. **Loopback matching** port-agnostically for both `127.0.0.1` and `localhost`. Matches §2.

### One difference found, NOT silently changed

The documented `401` body is:

```json
{"error":"invalid_token","error_description":"Authentication required for this tool"}
```

The gateway sends `{"error":"unauthorized"}`. The page states **"the body is advisory"** —
the signal is the status and the header, both of which match. Left unchanged and recorded
here rather than altered, per the instruction not to change code silently.

### Cache implication for P7-3 (JWKS discovery)

> "Claude caches your protected resource metadata and the authorization-server metadata it
> points to globally, keyed by URL, with a staleness window of about five minutes by default."
> "Stale on failure: if a refresh fails, Claude serves the stale entry and tries again on a
> later request."

Relevant to the gateway's own caches: a JWKS TTL much shorter than five minutes buys
nothing for Claude-driven discovery, and a cache that fails CLOSED on a refresh outage would
be worse than one that serves stale. The gateway's token verification already fails closed on
verification error; that is a different concern from metadata caching and is unaffected.

### Still not stated anywhere

Q-CLAUDE-GAPS item 1 (**`iss`**) is **not** answered by this page. It describes token
validation from the server's side only. Whether Claude's authorization server emits `iss`
remains unknown.

## 5. Criteria to check when choosing an authorization server

Deliberately **not** a product recommendation. Check each against the chosen AS's live
metadata, not its marketing page.

| # | Criterion | Where to verify |
|---|---|---|
| 1 | Advertises `client_id_metadata_document_supported: true` **AND** `"none"` in `token_endpoint_auth_methods_supported` | `GET <issuer>/.well-known/oauth-authorization-server` (or `/openid-configuration`) |
| 2 | Or exposes `registration_endpoint` | same document |
| 3 | `code_challenge_methods_supported` contains `S256` | same document |
| 4 | Accepts `https://claude.ai/api/mcp/auth_callback` exactly, and loopback `localhost` / `127.0.0.1` **port-agnostically** | registration config |
| 5 | Token endpoint accepts `application/x-www-form-urlencoded`; answers `415` otherwise | live `POST` |
| 6 | Refresh token rotation with `invalid_grant` on a replayed token | docs + live test |
| 7 | Reachable inbound from `160.79.104.0/21` on `/.well-known/` and `/token` | `curl` from outside, firewall |
| 8 | `/token` responds well under 10 s (refresh under 30 s) | load test |
| 9 | Supports authorization_code with an interactive user; no `client_credentials` needed | docs |
| 10 | `issuer` in metadata is identical to the value it puts in tokens (RFC 8414 §3.3) | compare both documents |
| 11 | Can mint tokens whose `aud` is the **canonical** MCP URL | token inspection |
| 12 | WAF/CDN in front of it does not strip `WWW-Authenticate` or block `.well-known` | edge test |

## 6. What this changes in the implementation

- Sprint 6.1's PRM `resource` **MUST** be `https://example.invalid/mcp` (G4) — the MCP path
  is part of the identity, not incidental.
- The `401` **MUST** be a real `401` with `WWW-Authenticate`; a `200` carrying the header is
  ignored (G2, G3).
- Audience validation **MUST** compare against the canonical URL rather than a strict
  byte-for-byte match (§2.2), which also means normalising a trailing slash.
- `authorization_servers` **MUST** list exactly one entry — Claude ignores later ones (G5).
- The gateway must be reachable from `160.79.104.0/21`.

## Related

- `docs/adr/0005-inbound-oauth-resource-server.md` — S6.0 gate, option A.
- `docs/adr/0007-q4-resolved-and-cimd-self-served.md` — Q4, `https://example.invalid`.
- `docs/adr/0008-rfc8707-resource-parameter-interim.md` — the client-side deviation.
- `docs/ref/oauth-flow.md` — the gateway as OAuth *client* (Sprint 5).
- `docs/OPEN-QUESTIONS.md` — Q-CLAUDE-ERA, Q-CLAUDE-GAPS.