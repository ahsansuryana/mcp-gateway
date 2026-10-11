# ADR 0011 — Post-Sprint-7 decisions: fix B-37, accept B-35 and B-36, defer the authorization server

- Status: **Accepted**
- Date: 2026-10-11 (human decision, post-Sprint-7 follow-up, branch `post-s7-followup`)
- Decides: `docs/BACKLOG.md` B-35, B-36, B-37
- Related: ADR 0007 (topology, amended the same day), ADR 0005 (inbound OAuth resource server)

## Context

Sprint 7 closed with three items in `docs/BACKLOG.md` that were explicitly deferred to a
follow-up pass: a rate-limit bucket key that did not distinguish callers (B-37), and two
capability gaps recorded while reading Anthropic's connector documentation (B-35 lazy
authentication, B-36 scope step-up). The authorization server was also still undecided.

All three were re-decided here. Two are code or a finding; one is a deferral. They are
recorded together because they were one decision point.

## Decisions

### B-37 — rate-limit buckets follow the verified identity. FIX IT NOW.

**Buckets are keyed by the verified issuer and subject (`iss` + `sub`), never by unverified
token content. Each configured static bearer key gets its own bucket.**

The original implementation keyed every static caller as the literal `'static-bearer'` and let
every OAuth caller share that same bucket. Two problems, of different severity:

1. **A noisy tenant could exhaust the allowance for everyone.** One shared bucket across all
   OAuth callers means one caller's traffic denies service to the rest.
2. **The OAuth path was not rate limited at all.** It returned before the limiter was reached,
   so "one shared bucket" described documentation rather than behaviour.

The constraint that shapes the implementation: **a bucket must only be creatable by an
identity the gateway actually proved.** Keying on the raw token would be wrong twice — it would
let anyone mint unbounded buckets by sending garbage, and it would place an unverified claim
into the key.

So the bucket is created *after* full validation:

- `ResourceServer.verify` returns the issuer **as read from the token**. That is safe because
  `jwtVerify` is given the configured issuer, so reaching the return means `iss` was already
  compared and matched. The token's value is returned rather than reconstructed from
  configuration so a caller cannot accidentally key on something other than what the token
  proved.
- The key is `oauth:<iss>\0<sub>`. The NUL separator matters: without it a crafted issuer and
  subject pair could collide with a different legitimate one.
- A verified token with **no `sub`** falls back to a per-issuer bucket. Keying on the raw
  token in that case would let a real authorization server mint unbounded buckets.
- Static keys get one bucket each, derived from the key's **SHA-256 digest**, so the secret is
  never a map key and two configured keys no longer share an allowance.
- The limiter's **O(1) insertion-order eviction is kept** (ADR 0010's tree-kill work revealed
  the previous sort-per-request cliff). Bounded memory does not depend on who the caller is.

Rejected: keying by IP (a gateway behind a proxy sees one IP for everyone), and keying by
token contents (above).

Tested in `test/e2e/rw-b37-rate-limit.e2e.test.ts`: two subjects do not share a bucket; a
forged signature, a wrong issuer and a garbage token each **cannot create or consume** a
bucket; each static key is independent; memory stays bounded. The two key tests were run
against the pre-fix code and fail there.

### B-35 — lazy authentication. ACCEPTED AS A LIMITATION.

**Not implemented, and confirmed not to be required for a connector to be added.**

Answered from the Anthropic documentation during F-5:

- <https://claude.com/docs/connectors/building/lazy-authentication> opens by scoping itself to
  servers "whose MCP server has some tools that work without the user's identity".
- <https://claude.com/docs/connectors/building/authentication> frames it conditionally — "*If*
  some of your tools work without the user's account" — and lists it as an alternative in the
  `none` row of the supported-authentication-types table, not as an entry requirement.
- Decisively, the lazy-auth page defers the real baseline to the authentication page as "the
  OAuth requirements **every server must meet regardless of when it asks for sign-in**".

Every tool this gateway exposes acts on a caller's identity, so there is no public subset to
expose first and the precondition for lazy auth does not apply. What the gateway does —
require a credential on every `POST /mcp`, and answer unauthenticated requests with a real
`401` plus `WWW-Authenticate` — is the supported "Sign in now" configuration.

It stays a *feature* worth considering (per-tool auth policy, so a user could browse a catalog
before consenting), with a real design question attached. It is not a defect and no work is
owed against it.

### B-36 — scope step-up. ACCEPTED AS A LIMITATION.

The `403` + `WWW-Authenticate: Bearer error="insufficient_scope"` path is documented by
Anthropic as a distinct optional flow. The gateway has no insufficient-scope path, so Claude is
never asked to re-authorize for a wider scope mid-session. Accepted as a limitation; it depends
on B-31 (per-tool scope policy) and on a real authorization server, neither of which exists yet.

### Authorization server — STILL NOT CHOSEN, AND NOT CHOSEN HERE.

The operator has not selected one. Nothing in this pass selects, assumes, defaults to, or
depends on a particular product. The 12 evaluation criteria remain in
`docs/ref/claude-connector-requirements.md` § 5, and `docs/DEPLOY.md` orders S5-MANUAL before
S6-MANUAL precisely so the parts that need only a public URL are unblocked first.

## Consequences

1. B-37 is closed. One noisy OAuth tenant can no longer exhaust other callers' allowance, and
   the OAuth path is now actually rate limited.
2. B-35 and B-36 are closed as accepted limitations, so `docs/BACKLOG.md` no longer implies
   outstanding gateway work against a connector.
3. **S5-MANUAL is now the gating item**, not the authorization server: it needs only a
   reachable `publicUrl` for the CIMD document. S6-MANUAL stays blocked on the AS choice.
4. The scope of any future per-tool auth work is unchanged; it is simply no longer owed.
