# ADR 0005 — Inbound OAuth: gateway is a resource server only

- Status: **STUB — decision accepted, ADR to be completed in Sprint 6**
- Resolves: PLAN.md §9 Q3, and removes the S6.0 gate

## Decision (human, 2026-10-10)

**Option A.** In Sprint 6 the gateway is an OAuth **resource server only**: it validates
tokens issued by an **external** authorization server.

**Option B (an embedded authorization server inside the gateway) is out of scope and MUST NOT
be built.**

Consequence: PLAN.md S6.0 no longer requires a human decision. The work it gated proceeds
when Sprint 6 starts.

## Why this ADR is a stub

The implementation detail that still needs an ADR is the **token validation mechanism**:
library choice, JWKS caching and rotation, audience/resource binding, and the
`WWW-Authenticate` challenge shape. Those can only be chosen once Sprint 6 has re-read the
authorization pages against the installed SDK surface, which is S6.1's own first step.

The non-negotiable constraints already fixed here:

- No embedded authorization server. No token issuance, no consent UI, no user store.
- No per-user upstream credentials / multi-tenancy (§1). One gateway = one identity per
  upstream.
- Static bearer keys (D9) keep working side by side; the schema change for that is its own
  ADR, per S6.2.

## To be completed in Sprint 6

Fill in: options for the JWT validation library, the chosen one, the JWKS cache policy, and
the exact challenge parameters. This file must not stay a stub past S6.1.
