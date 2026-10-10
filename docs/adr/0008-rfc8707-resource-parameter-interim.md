# ADR 0008 — RFC 8707 `resource` parameter: interim policy (a)+(c)

- Status: **Accepted (interim)** — human decision, recorded at the Sprint 6 gate
- Date: 2026-10-10
- Resolves: `docs/OPEN-QUESTIONS.md` Q-SDK-RESOURCE

## Context

The MCP authorization spec makes the RFC 8707 resource indicator a MUST for clients:

> "MCP clients **MUST** implement Resource Indicators for OAuth 2.0 … The `resource`
> parameter: 1. **MUST** be included in both authorization requests and token requests.
> 2. **MUST** identify the MCP server that the client intends to use the token with."
> "MCP clients **MUST** send this parameter regardless of whether authorization servers
> support it."
> — verified: `docs/ref/spec-2026-07-28-basic-authorization-index.md` lines 219-222 and 254

Measured against the in-repo fake authorization server
(`test/fixtures/fake-auth-server.ts`, which advertises `resource` in its protected-resource
metadata), `@modelcontextprotocol/client` 2.3.1 sends it in **neither** request:

- the authorization URL it builds has no `resource` query parameter;
- the token request has no `resource` parameter either.

The regression test asserts this observed defect on purpose
(`test/integration/oauth-flow.integration.test.ts`, "S5.6 resource parameter — SDK
DEVIATION, recorded") so it fails loudly if the SDK changes.

## Investigation: is there a supported extension hook?

The human's instruction allows option (b) if — and only if — the installed package exposes a
supported extension hook, and then requires an ADR before implementing.

Checked in `node_modules/@modelcontextprotocol/client/dist/index.d.mts`:

| Hook | Signature | Covers |
|---|---|---|
| `OAuthClientProvider.prepareTokenRequest` | `(scope?: string) => URLSearchParams \| undefined` (line 597) | **Token request only** |
| `OAuthClientProvider.resourceUrl` / `saveResourceUrl` | `() => string \| undefined` (line 636) | Read-only access to the URL discovered via RFC 9728, for Cross-App Access consumers. Not an injection point. |
| `OAuthClientProvider.validateResourceURL` | `(serverUrl, resource?) => Promise<URL \| undefined>` (line 554) | Validates a resource; does not add one. |
| `prepareAuthorizationCodeRequest` | free function, **not** a provider hook | The authorization URL is constructed inside `auth()`/`startAuthorization()` with no provider callback for extra query parameters. |

**Conclusion: the hook is partial.** `prepareTokenRequest` could add `resource` to the token
request, but there is no equivalent for the authorization request, which the spec also
requires. Option (b) would therefore fix one of the two MUSTs while still hand-rolling
around the SDK for the other.

## Decision

Interim policy **(a) + (c)**:

- **(a) Continue without the `resource` parameter.** Do not hand-roll the authorization URL
  or the token request.
- **(c) File an upstream issue.** Draft text is prepared at
  `docs/ref/sdk-issue-resource-parameter.md`. It is **not** posted anywhere; the human files
  it.

Additional obligations accepted with this decision:

- The deviation is recorded in `docs/SECURITY.md` under "Known spec deviations", because it
  has a real security consequence: **tokens issued by the gateway are not audience-bound**.
  A token minted for upstream A is not cryptographically restricted to upstream A.
- The failing-on-change test stays.
- Option (b) may be revisited **only** if the SDK ships a hook covering both requests, or if
  the human asks for it after an ADR.

## Consequences

1. An authorization server that *requires* `resource` (RFC 8707 § 2 permits this) may reject
   the request or issue a token with a broader audience than intended.
2. The gateway does not independently check the audience of an access token it RECEIVES as a
   client; it relies on the upstream to validate. That is the upstream's role, so the exposure
   is at issuance, not acceptance.
3. Re-test whenever `@modelcontextprotocol/client` is upgraded.

## Related

- `docs/OPEN-QUESTIONS.md` Q-SDK-RESOURCE.
- `docs/ref/sdk-issue-resource-parameter.md`.
- `docs/SECURITY.md` "Known spec deviations".
- `test/integration/oauth-flow.integration.test.ts`.
- `docs/ref/oauth-flow.md` § 5 and MUST list A7-A9.