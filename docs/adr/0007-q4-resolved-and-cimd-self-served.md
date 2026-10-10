# ADR 0007 — Q4 resolved, Q-CIMD option (a): the gateway serves its own Client ID Metadata Document

- Status: **Accepted**
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

**Q4 — hosting target.** The public hostname is **`example.invalid`**, so the canonical
public URL is `https://example.invalid`.

Rules attached to that answer:

- `gateway.example.json` shows it as an **example comment only**. The value that the operator
  actually runs with lives in the local, uncommitted `gateway.json`.
- It is never written into `src/`, into a test fixture that asserts production behaviour, or
  into a transcript.

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

## Related

- PLAN.md §9 Q4; §6 `gateway.publicUrl`.
- `docs/ref/oauth-flow.md` § 3.1 and MUST list R2-R5.
- `docs/reports/sprint-5.md`; `docs/reports/sprint-5-manual-test.md`.
- `docs/adr/0005-inbound-oauth-resource-server.md` (Sprint 6's other gate).