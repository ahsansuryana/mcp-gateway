# OAuth flow — the gateway as an OAuth 2.1 client

Reference for PLAN.md **S5.1**. Written **before** any OAuth code, as instructed.

Scope: this file covers what the gateway must do when an upstream MCP server is
OAuth-protected, i.e. the gateway is the **OAuth client** and the upstream is the **resource
server**. It does not cover the gateway's own inbound protection (that is Sprint 6, ADR
0005: resource server only).

Sources, all read end to end from the spec revision pinned by PLAN.md §3 rule 1
(`2026-07-28`), saved locally under `docs/ref/`:

| Ref | Page |
|---|---|
| [`spec-2026-07-28-basic-authorization-index.md`](../spec-2026-07-28-basic-authorization-index.md) | Authorization |
| [`spec-2026-07-28-basic-authorization-authorization-server-discovery.md`](../spec-2026-07-28-basic-authorization-authorization-server-discovery.md) | Authorization Server Discovery |
| [`spec-2026-07-28-basic-authorization-client-registration.md`](../spec-2026-07-28-basic-authorization-client-registration.md) | Client Registration |
| [`spec-2026-07-28-basic-authorization-security-considerations.md`](../spec-2026-07-28-basic-authorization-security-considerations.md) | Security Considerations |

Citation format below is `§<section>` plus the local ref file, so every statement can be
checked without a network round trip.

---

## 1. The flow

The spec's normative sequence (§ Authorization Flow Steps, lines 152–190). The gateway's
role is marked; the human's browser is the user agent.

```
1.  C -> M: MCP request without token                     (gateway)
2.  M -> C: 401 + WWW-Authenticate                        (upstream)
3.  Note over C: extract resource_metadata URL             (gateway)
4.  C -> M: GET Protected Resource Metadata                (gateway)
5.  Note over C: parse metadata, extract authorization_servers   (gateway)
6.  C -> A: GET AS metadata, trying OAuth 2.0 then OIDC endpoints in order   (gateway)
7.  alt Client ID Metadata Document:
        client_id is an HTTPS URL; A fetches and validates it  (gateway hosts the doc)
    else Dynamic Client Registration:
        C -> A: POST /register ; A -> C: client credentials  (gateway)
    else Pre-registered client:
        use existing client_id                                (gateway)
8.  Note over C: generate PKCE params; include `resource`; apply scope selection;
                  record expected issuer                       (gateway)
9.  C -> B: open browser with authorization URL + code_challenge + resource
10. B -> A: authorization request with `resource`
11. A -> B: redirect to callback with code + iss
12. B -> C: authorization code callback
13. Note over C: validate iss against recorded issuer (RFC 9207)   (gateway)
14. C -> A: token request + code_verifier + resource          (gateway)
15. A -> C: access token (+ refresh token)                   (gateway)
16. C -> M: MCP request with access token                    (gateway)
```

Sprint 5's routes implement steps 9→12 (`GET /admin/oauth/:name/start` and
`GET /oauth/callback`) and steps 13–16.

---

## 2. Discovery

### 2.1 Protected Resource Metadata (§ Authorization Server Discovery)

Two mechanisms; the gateway **MUST support both**
(line 49: *"MCP clients **MUST** support both discovery mechanisms"*):

1. `resource_metadata` parameter in the `WWW-Authenticate` header of the 401.
2. Well-known URI probing, in this order (line 49):
   - `https://<host>/.well-known/oauth-protected-resource<path of the MCP endpoint>`
   - `https://<host>/.well-known/oauth-protected-resource`

The header form wins when present; the well-known URIs are the fallback.

### 2.2 Selecting an authorization server (lines 29–37)

When `authorization_servers` lists more than one, each is an independent OAuth server.
> *"client identifiers are unique to the authorization server that issued them. Clients
> **MUST** maintain separate registration state (client credentials, tokens) per
> authorization server and **MUST NOT** assume that credentials valid for one authorization
> server will be accepted by another."*

This is why PLAN.md S5.2 keys records by `(upstreamName, issuer)` and not by upstream alone.

### 2.3 Authorization Server Metadata (lines 57–96)

The gateway **MUST** try several well-known endpoints, because issuer URLs vary:

| Issuer shape | Order |
|---|---|
| With a path (`https://auth.example.com/tenant1`) | 1. `/.well-known/oauth-authorization-server/tenant1`  2. `/.well-known/openid-configuration/tenant1`  3. `/tenant1/.well-known/openid-configuration` |
| Without a path (`https://auth.example.com`) | 1. `/.well-known/oauth-authorization-server`  2. `/.well-known/openid-configuration` |

> *"After retrieving a metadata document, MCP clients **MUST** validate it as required by
> RFC8414 § 3.3 …: the `issuer` value in the document **MUST** be identical to the issuer
> identifier used to construct the well-known URL. If they differ, the client **MUST NOT**
> use the metadata."* (line 96)

The spec's own worked example: a document fetched from
`https://attacker.example/.well-known/oauth-authorization-server` containing
`"issuer": "https://honest.example"` **MUST** be rejected.

---

## 3. Client registration

Three mechanisms, with a **fixed priority** (§ Client Registration, lines 15–20):

> 1. Use pre-registered client information for the server if the client has it available
> 2. Use Client ID Metadata Documents if the Authorization Server indicates that it supports
>    them (via `client_id_metadata_document_supported` in OAuth Authorization Server Metadata)
> 3. Use Dynamic Client Registration as a fallback if the Authorization Server supports it
>    (via `registration_endpoint` in OAuth Authorization Server Metadata)
> 4. Prompt the user to enter the client information if no other option is available

This matches the human's instruction for S5.3 exactly. Note step 4 is out of scope for v1:
the gateway has no UI, so a server supporting neither CIMD nor DCR is a configuration error
reported in `/status`, not an interactive prompt.

### 3.1 Client ID Metadata Document (CIMD)

Requirements **For MCP Clients** (lines 38–44):

- Clients **MUST** host their metadata document at an HTTPS URL following RFC requirements.
- The `client_id` URL **MUST** use the `https` scheme **and contain a path component**,
  e.g. `https://example.com/client.json`.
- The metadata document **MUST** include at least `client_id`, `client_name`, `redirect_uris`.
- Clients **MUST** ensure the `client_id` value in the metadata matches the document URL
  exactly.
- Clients **MAY** use `private_key_jwt` for client authentication.

> **Blocker for this gateway.** CIMD requires the client to **host** a publicly reachable
> HTTPS document, and `client_id` must be an `https` URL. The gateway's `publicUrl` is
> unconfigured because Q4 (hosting target and public hostname) is still open, and the
> Sprint 5 instruction forbids inventing a hostname. A localhost redirect URI is explicitly
> shown as acceptable in the spec's own example (line 64: `http://localhost:3000/callback`),
> but the *document itself* must still be `https`.
>
> Consequence: **CIMD cannot be exercised in Sprint 5 without Q4 answered.** The gateway
> implements the branch, selects it only when the AS advertises
> `client_id_metadata_document_supported`, and reports a clear configuration error naming the
> missing `publicUrl`. Recorded as an open question, not worked around.

### 3.2 Dynamic Client Registration (deprecated)

Lines 140–152 mark DCR as **deprecated** and retained for backwards compatibility. Line 142:
> *"Dynamic Client Registration is deprecated. New implementations should use Client ID
> Metadata Documents instead."*

Constraints (lines 154–181):

- Clients **MUST** specify an appropriate `application_type` during DCR.
- *Native* applications (desktop, mobile, CLI, **locally-hosted web applications accessed via
  `localhost`**) **SHOULD** use `application_type: "native"`.
- Clients **MUST** be prepared to handle registration failures due to redirect URI
  constraints. When a registration request is rejected, clients **SHOULD** surface a
  meaningful error. Clients **MAY** retry with an adjusted `application_type`.

The gateway is a locally-hosted web application accessed via `localhost`, so
`application_type: "native"` is the correct value when DCR is used.

### 3.3 Authorization Server Binding (lines 183–204)

- Credentials from pre-registration or DCR **MUST** be associated with the issuer that
  issued them, keyed by `issuer`.
- When the AS changes, clients **MUST NOT** reuse credentials from a different AS and
  **MUST** re-register.
- CIMD-based client IDs are portable across ASes; no re-registration needed.

This is the normative basis for the S5.6 test "credentials of a different issuer are never
reused".

---

## 4. Authorization request, `state`, and `iss` (RFC 9207)

### 4.1 Recording and validating `iss` (§ Authorization Response Validation, line 194)

> *"Before redirecting the user-agent, the client **MUST** record the `issuer` value from the
> selected authorization server's validated metadata document … and associate it with the same
> per-request record used to store the PKCE code verifier (and the `state` value, if used)."*

The recorded value must come from **validated** metadata — the § 2.3 issuer-equality check —
"it provides no protection if the expected issuer was obtained from an unvalidated source."

The `state` value and the code verifier must live in the **same per-request record** as the
recorded issuer. This is why the gateway's pending-authorization record carries all three.

### 4.2 The validation table (lines 198–207)

On receiving the authorization response, clients **MUST** apply RFC 9207 § 2.4 before
transmitting the code to any token endpoint:

| `authorization_response_iss_parameter_supported` | `iss` in response | Client action |
|---|---|---|
| `true` | present | Compare to the recorded issuer, simple string comparison |
| `true` | absent | **Reject the response** |
| `false` or absent | present | Compare to the recorded issuer, simple string comparison |
| `false` or absent | absent | Proceed |

Comparison is **simple string comparison** (RFC 3986 § 6.2.1).

Line 213 adds a hard constraint:
> *"clients **MUST NOT** apply scheme or host case folding, default-port elision,
> trailing-slash, or percent-encoding normalization … before comparison."*

So `https://as.example/` and `https://as.example` are **different** issuers for this
comparison. URL normalization in the gateway would silently disable `iss` validation.

Line 215: this validation applies equally to error responses — on mismatch the client
**MUST NOT** act on or display `error`, `error_description` or `error_uri`.

---

## 5. Resource parameter (RFC 8707) — lines 217–254

- Clients **MUST** implement Resource Indicators.
- `resource` **MUST** be included in **both** authorization requests and token requests.
- `resource` **MUST** identify the MCP server the token is for.
- `resource` **MUST** be the canonical URI of the MCP server.
- Clients **SHOULD** provide the most specific URI they can.
- Clients **MUST** send this parameter **regardless of whether the AS supports it** (line 254).

Canonical URI examples (lines 234–240): `https://mcp.example.com/mcp`,
`https://mcp.example.com`, `https://mcp.example.com:8443`,
`https://mcp.example.com/server/mcp`.
Invalid: missing scheme, or containing a fragment.

Line 246 asks implementations to **consistently use the form without a trailing slash**.

**For this gateway** the canonical resource is the upstream's configured `url` — the same URL
already in the config and already sent to, never a URL taken from request input (PLAN.md §8:
*"Outbound requests only to URLs from config; no URL taken from request input"*).

---

## 6. Scope selection — lines 99–136, 381–404

Initial handshake, priority order (lines 127–131):

1. Use the `scope` parameter from the initial `WWW-Authenticate` 401, if provided.
2. Otherwise use all scopes in `scopes_supported` from Protected Resource Metadata,
   omitting `scope` if `scopes_supported` is undefined.

Lines 109–110: clients **MUST NOT** assume any set relationship between the challenged scope
set and `scopes_supported`, and **MUST** treat the challenge's scopes as authoritative for
the current operation.

Refresh tokens (lines 301–311):
- **MUST** keep refresh tokens confidential in transit and storage.
- **SHOULD** include `refresh_token` in `grant_types` client metadata.
- **MAY** add `offline_access` to `scope` when the AS metadata's `scopes_supported` contains it.
- **MUST NOT** assume refresh tokens will be issued.

---

## 7. Access token usage — lines 256–299

- `Authorization: Bearer <access-token>` **MUST** be used, and **MUST** be included in
  **every** HTTP request from client to server (line 271).
- Access tokens **MUST NOT** be included in the URI query string (line 273).
- Clients **MUST NOT** send tokens to the MCP server other than ones issued by that MCP
  server's authorization server (line 294).

---

## 8. Error handling — lines 317–325

| Status | Meaning |
|---|---|
| 401 | Authorization required or token invalid |
| 403 | Invalid scopes or insufficient permissions |
| 400 | Malformed authorization request |

Runtime insufficient-scope (§ Scope Challenge Handling) yields **403** with
`WWW-Authenticate: Bearer error="insufficient_scope", scope="...", resource_metadata="..."`.
Clients **SHOULD** respond with a step-up authorization (scope union of previously granted
plus the challenge, line 392), retrying *"no more than a few times and treat this as a
permanent authorization failure"* (line 401), and **SHOULD** implement retry limits (line 403).

---

## 9. Complete MUST list applying to the gateway as an OAuth client

Every row is a `MUST` in the cited page. "Where" is where Sprint 5 satisfies it.

### Discovery

| # | MUST | Source | Sprint 5 |
|---|---|---|---|
| D1 | Support **both** PRM discovery mechanisms (WWW-Authenticate `resource_metadata` and well-known URI probing, in the listed order) | Discovery ll. 49 | S5.3 via SDK `discoverOAuthProtectedResourceMetadata` |
| D2 | Use the header's `resource_metadata` when present, else probe the well-known URIs in order | Discovery l. 49 | S5.3 |
| D3 | Parse `WWW-Authenticate` and respond to 401 from the MCP server | Discovery l. 51 | S5.3 |
| D4 | Maintain **separate** registration state per authorization server; never assume credentials from one AS work at another | Discovery ll. 32–35 | S5.2 (keyed by `(upstreamName, issuer)`) + S5.6 test |
| D5 | Try the AS metadata well-known endpoints in the specified priority order (3 forms with a path, 2 without) | Discovery ll. 77–94 | S5.3 via SDK |
| D6 | Validate that the metadata document's `issuer` is **identical** to the issuer used to build the well-known URL, and **MUST NOT** use the metadata if they differ | Discovery l. 96 | S5.3 + S5.6 test |

### Client registration

| # | MUST | Source | Sprint 5 |
|---|---|---|---|
| R1 | Obtain a client ID by one of the three mechanisms, in the stated priority order | CR ll. 94–97 | S5.3 |
| R2 | (CIMD) Host the metadata document at an HTTPS URL | CR l. 40 | **BLOCKED by Q4** — see § 3.1 |
| R3 | (CIMD) `client_id` URL **MUST** use `https` and contain a path component | CR l. 41 | **BLOCKED by Q4** |
| R4 | (CIMD) Document **MUST** include at least `client_id`, `client_name`, `redirect_uris` | CR l. 42 | S5.3 |
| R5 | (CIMD) `client_id` in the metadata **MUST** match the document URL exactly | CR l. 43 | S5.3 |
| R6 | (DCR) Specify an appropriate `application_type` | CR l. 164 | S5.3 (`"native"`, § 3.2) |
| R7 | (DCR) Be prepared to handle rejection from redirect URI constraints; surface a meaningful error | CR ll. 174–177 | S5.3 |
| R8 | Associate persisted client credentials with the issuing AS, keyed by `issuer`; **MUST NOT** reuse across ASes; **MUST** re-register when the AS changes | CR ll. 187–193 | S5.2 + S5.6 test |

### Authorization request / response

| # | MUST | Source | Sprint 5 |
|---|---|---|---|
| A1 | Record the `issuer` from the **validated** AS metadata, associated with the same per-request record as the PKCE verifier and `state` | Auth l. 194 | S5.3 |
| A2 | Apply RFC 9207 § 2.4 validation **before** transmitting the code to any token endpoint | Auth l. 198 | S5.3 |
| A3 | Reject the response when `iss` is absent but the AS advertised `authorization_response_iss_parameter_supported: true` | Auth l. 203 | S5.3 + S5.6 test |
| A4 | Compare a present `iss` against the recorded issuer with **simple string comparison** | Auth ll. 202–204 | S5.3 |
| A5 | **MUST NOT** normalize scheme/host case, default port, trailing slash or percent-encoding before comparing | Auth l. 213 | S5.3 — see § 4.2 |
| A6 | On `iss` mismatch, **MUST NOT** act on or display `error` / `error_description` / `error_uri` | Auth l. 215 | S5.3 |
| A7 | Implement Resource Indicators; include `resource` in **both** the authorization and the token request | Auth ll. 219–222 | S5.3 |
| A8 | `resource` **MUST** be the canonical URI of the MCP server | Auth l. 224 | S5.3 (upstream `url`) |
| A9 | Send `resource` **regardless** of whether the AS supports it | Auth l. 254 | S5.3 |

### Tokens and refresh

| # | MUST | Source | Sprint 5 |
|---|---|---|---|
| T1 | Keep refresh tokens confidential in transit and storage | Auth l. 308 | S5.2 (AES-256-GCM at rest) |
| T2 | Use `Authorization: Bearer <access-token>` on **every** request to the server | Auth ll. 264–271 | S5.3 via SDK transport |
| T3 | **MUST NOT** put access tokens in the URI query string | Auth l. 273 | S5.3 via SDK transport |
| T4 | **MUST NOT** send tokens issued by another server's AS | Auth l. 294 | S5.2 issuer keying |
| T5 | **MUST NOT** assume refresh tokens will be issued | Auth l. 311 | S5.5 — degrade to `auth_required` |

### Not applicable to this gateway

| Requirement | Why not |
|---|---|
| "Implementations using an STDIO transport **SHOULD NOT** follow this specification" (Auth l. 23) | Applies to stdio upstreams; `StdioUpstream` takes credentials from the environment instead |
| 403 / `insufficient_scope` step-up flow (Auth ll. 327–407) | Deferred: the gateway has no interactive surface in v1. Tracked in `docs/BACKLOG.md`. |

---

## 10. What the SDK already does (PLAN.md S5.3 constraint)

Sprint 5 must NOT hand-roll PKCE, discovery or token exchange if the SDK provides them.
`docs/SDK-NOTES.md` § (i) records, from the installed `@modelcontextprotocol/client` 2.3.1:

- Interface `OAuthClientProvider` with `redirectUrl`, `clientMetadata`, `clientInformation`,
  `tokens`, `saveTokens`, `redirectToAuthorization`, `saveCodeVerifier`, `codeVerifier`,
  optional `state`, `clientMetadataUrl`, `saveClientInformation`, `invalidateCredentials`,
  `prepareTokenRequest`, `addClientAuthentication`.
- Free functions: `auth()`, `startAuthorization()`, `exchangeAuthorization()`,
  `refreshAuthorization()`, `registerClient()`, `fetchToken()`, `discoverOAuthMetadata()`,
  `discoverOAuthProtectedResourceMetadata()`, `discoverAuthorizationServerMetadata()`,
  `selectResourceURL()`, `validateAuthorizationResponseIssuer()`,
  `prepareAuthorizationCodeRequest()`, `resolveClientMetadata()`, `assertSecureTokenEndpoint()`.
- `pkce-challenge` is already a transitive dependency of the client package.

Mapping to the MUST list:

| MUST | SDK facility |
|---|---|
| D1–D3 | `discoverOAuthProtectedResourceMetadata()` |
| D5–D6 | `discoverAuthorizationServerMetadata()` / `discoverOAuthMetadata()` |
| R4–R5 | `resolveClientMetadata(provider)` reads `clientMetadataUrl` |
| A1 | `OAuthClientInformationContext.issuer` passed through `saveTokens`/`clientInformation` |
| A2, A4, A6 | `validateAuthorizationResponseIssuer()` |
| A7–A9 | `selectResourceURL()` / `prepareAuthorizationCodeRequest()` |
| T2–T3 | `StreamableHTTPClientTransport` + the SDK's auth provider |
| PKCE | `pkce-challenge` via `saveCodeVerifier` / `codeVerifier()` |

**What the gateway must add itself** is only the persistence and the two HTTP routes: an
encrypted, atomically written token store keyed by `(upstreamName, issuer)`, and
`GET /admin/oauth/:name/start` + `GET /oauth/callback`. Any further hand-rolling would need
an ADR per the human's instruction.

---

## 11. Open questions this document raises

1. **Q4 blocks CIMD.** CIMD needs an `https` client-metadata URL; `publicUrl` is unset. Until
   Q4 is answered the gateway can only reach ASes that accept pre-registration or DCR. Logged
   in `docs/OPEN-QUESTIONS.md`.
2. **403 step-up is out of scope for v1.** Deferred with a BACKLOG entry.
3. **`clientMetadataUrl` is not in PLAN.md §6.** `oauth` currently allows only
   `clientId`, `clientSecret`, `scope`. Adding `clientMetadataUrl` (and `applicationType` for
   DCR) is a schema change; see the ADR written with S5.3.