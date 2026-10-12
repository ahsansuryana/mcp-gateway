# ADR 0007 — Q4 resolved, Q-CIMD option (a): the gateway serves its own Client ID Metadata Document

- Status: **Accepted** (amended 2026-10-11, human decision in the post-Sprint-7 follow-up)
- Date: 2026-10-10 (human decision, recorded at the Sprint 6 gate)
- Resolves: `docs/OPEN-QUESTIONS.md` Q4 and Q-CIMD; PLAN.md §9 Q4

## Context

PLAN.md §9 Q4 asked for the hosting target and public hostname, needed for
`gateway.publicUrl`. Q4 also blocked the Client ID Metadata Document (CIMD) branch of the
upstream OAuth registration order:

> "Clients **MUST** host their metadata document at an HTTPS URL following RFC requirements."
> "The `client_id` URL **MUST** use the 'https' scheme and contain a path component."
> "The metadata document **MUST** include at least the following properties: `client_id`,
> `client_name`, `redirect_uris`."
> "Clients **MUST** ensure the `client_id` value in the metadata matches the document URL
> exactly."
> — verified: `docs/ref/spec-2026-07-28-basic-authorization-client-registration.md` lines 40-43

With `publicUrl` unset the gateway could not act as a CIMD client, so an authorization server
supporting only CIMD was unusable. Sprint 5 recorded this as Q-CIMD with three options.

## Decisions

**Q4 — hosting target: OPTION A, the gateway gets its OWN subdomain.**

The hostname first recorded here, `<existing-hostname>`, **collides with an existing MCP
server** the operator already runs. That host is not the gateway's and must not be bound,
redirected, proxied to, or otherwise touched by this project.

The gateway's real public hostname is a **new subdomain the operator supplies separately**.

**While that hostname has not been supplied, it is NOT guessed.** The value provided in this
pass was a literal placeholder (`<SUBDOMAIN>`, angle brackets and all). A placeholder is not a
hostname, and inventing one would be worse than having none:

- `gateway.publicUrl` stays **configurable and unset in the repository**.
- No hostname is written into `src/`, into a test fixture that asserts production
  behaviour, into `gateway.example.json` as a working value, or into any transcript.
- `docs/DEPLOY.md` is written so the hostname is supplied in exactly one place at deploy time.
- The CIMD route stays gated on `publicUrl` (see Consequences 2), so an unset value cannot
  accidentally publish an identity at the wrong origin.

Rules that applied to the original answer still apply to the replacement:

- The value the operator actually runs with lives in the local, uncommitted `gateway.json`.
- It is never committed.

**Option A vs Option B.** Option A (own subdomain) was chosen over putting the gateway behind
the existing server (Option B). Consequence recorded here: the two servers share no routing,
no certificate and no process. Anything done to the existing server's host — a reverse-proxy
rule, a certificate renewal, a DNS record — has no effect on the gateway, and the reverse is
also true. The operational cost is one more subdomain to point, renew and monitor, which is
the price of not coupling two independently operated services.

**Q-CIMD — option (a).** The gateway serves its own Client ID Metadata Document under
`publicUrl`. An operator-supplied `clientMetadataUrl` field is explicitly **rejected**: it
would let a configuration file redirect the gateway's identity at a third-party URL, which is
a privilege-escalation shape in a document that is trusted by definition.

## Consequences

1. CIMD becomes implementable, and P6-1 implements it.
2. The route must **not exist at all** when `publicUrl` is unset, and the CIMD registration
   path must report a clear error naming `gateway.publicUrl`. A gateway without a public URL
   has no identity to publish.
3. The Origin allowlist can move beyond localhost-only once the deployment actually binds to
   that hostname. That is a separate change and is NOT made by this ADR; see
   `docs/OPEN-QUESTIONS.md` Q-CORS.
4. The Sprint 5 manual test against a real server is unblocked *in principle*, but the human
   deferred it; tracked as S5-MANUAL in `docs/BACKLOG.md`.
5. Serving a public document from the gateway is a new internet-facing surface. Its contents
   are fixed and non-secret (`client_id`, `client_name`, `redirect_uris`), and the spec requires
   the AS to validate `client_id` against the document URL and the `redirect_uris` against
   what the authorization request presents.
6. **Amended consequence.** Because the hostname is a NEW subdomain rather than the existing
   one, the gateway needs its own DNS record and its own TLS certificate. Neither can be
   borrowed from the existing server without re-coupling them, which is what Option A exists
   to avoid. `docs/DEPLOY.md` treats DNS and TLS as steps in their own right.

## Related

- PLAN.md §9 Q4; §6 `gateway.publicUrl`.
- `docs/ref/oauth-flow.md` § 3.1 and MUST list R2-R5.
- `docs/reports/sprint-5.md`; `docs/reports/sprint-5-manual-test.md`.
- `docs/adr/0005-inbound-oauth-resource-server.md` (Sprint 6's other gate).