# ADR 0005 — Sprint 6 gate: the gateway is an OAuth RESOURCE SERVER only (supersedes the stub)

- Status: **Accepted** — option A. Human decision, recorded at the Sprint 6 gate.
- Date: 2026-10-10 (Sprint 5) / amended 2026-10-10 (Sprint 6 gate)
- Gate: PLAN.md §7 **S6.0**, which required an explicit human decision and an ADR.
- Supersedes: the Sprint 5 stub of this same ADR, which recorded the question without a
  decision.

## Context

PLAN.md §7 S6.0 offered two shapes for the gateway's inbound authorization:

- **(A)** The gateway is only a **resource server**: it validates JWTs minted by an
  **external** authorization server.
- **(B)** The gateway embeds its **own** authorization server.

PLAN.md is explicit that B must not be started without explicit human approval and an ADR
with a threat model, and gives the reason: *"an embedded AS is security-critical code."*

## Decision

**Option A. The gateway is an OAuth 2.1 resource server and nothing more.**

The gateway:

- **MUST NOT** issue tokens.
- **MUST NOT** run an authorization endpoint, a token endpoint, a user login, a consent
  screen, a client-registration endpoint, or a user store.
- **MUST NOT** hold a refresh token for an inbound caller.
- **MUST** validate a bearer token's signature against an **external** authorization
  server's published JWKS, and validate issuer, audience/resource and expiry.

**Option B is out of scope for v1 and is not a backlog item.** It is not deferred pending
time; it is rejected because it would put authorization-server-grade security-critical code
(maintaining this project) into a process that also runs arbitrary local child processes
(Sprint 4) and holds upstream OAuth credentials (Sprint 5). If it is ever wanted, it
requires its own ADR and its own threat model.

## Consequences

### Good

- The gateway has no user database, no password handling and no token minting. The
  blast radius of a compromise does not include "everyone's credentials".
- Interoperability: any standards-compliant authorization server works, and the operator
  picks it.
- claude.ai custom connectors already speak this flow.

### Costs, accepted

- The operator must run or choose an authorization server. That is real operational work
  and it is why S6.0b exists: research first, then choose.
- The gateway depends on an external service's availability for token validation. JWKS is
  cached, so an outage does not take the gateway down immediately.
- The gateway cannot revoke a token itself; revocation is the authorization server's job
  and only takes effect when the token expires or the JWKS/issuer stops being trusted.

### Boundaries that follow

- **Upstream OAuth (Sprint 5) and inbound OAuth (Sprint 6) are independent.** The gateway
  holding upstream credentials says nothing about who may call it.
- The gateway **MUST NOT** use its own upstream-issued tokens to authenticate inbound
  callers, nor vice versa. `GATEWAY_TOKEN_KEY` protects stored upstream credentials;
  inbound tokens come from the external AS.
- Metadata the gateway publishes (RFC 9728 protected-resource metadata, and the CIMD
  document from ADR 0007) **MUST NOT** be used to make the gateway an authorization server.

## Threat model sketch (why B is rejected)

| Property | Option A | Option B |
|---|---|---|
| Password storage | none | full user store, hashing, resets |
| Consent UI | none | full authorization-server UX |
| Token minting | none | signing keys in-process |
| Attack surface added | JWKS fetch + JWT verification | user endpoints, login, consent, token issuance |
| Blast radius of compromise | read access to MCP results | every connected user's account |
| Coexistence with Sprint 4/5 | clean | an AS sharing a process with `npx` children and an OAuth token store |

## Consequences for the implementation

1. `jose` is used for JWT verification against a JWKS. It was verified with `npm view jose`
   before use; see the sprint report.
2. `gateway.auth` keeps its static bearer keys working side by side with an OAuth variant
   (S6.2). The schema change is defined in `docs/adr/0009-gateway-auth-oauth-variant.md`.
3. Unauthenticated requests are answered with the `WWW-Authenticate` challenge the spec
   requires, not with a bare 401.

## Related

- PLAN.md §7 S6.0, S6.1, S6.2, S6.3; §9 Q3.
- `docs/adr/0009-gateway-auth-oauth-variant.md` (S6.2 schema).
- `docs/adr/0007-q4-resolved-and-cimd-self-served.md` (Q4, CIMD self-service).
- `docs/ref/spec-2026-07-28-basic-authorization-index.md`.
- `docs/ref/claude-connector-requirements.md` (S6.0b).