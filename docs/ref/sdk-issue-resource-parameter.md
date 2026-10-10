# Upstream issue draft — the OAuth client does not send the RFC 8707 `resource` parameter

**Status: DRAFT. Not filed. Not posted anywhere.** The human files this.

Suggested repository: the SDK that ships `@modelcontextprotocol/client` (v2, package
`@modelcontextprotocol/client`, measured at **2.3.1**).

---

## Summary

`auth()` does not include the RFC 8707 `resource` parameter in either the authorization
request or the token request. The MCP authorization specification requires it in **both**,
and requires it to be sent regardless of whether the authorization server supports it.

## What the spec requires

From the MCP specification, revision `2026-07-28`, page "Authorization", section "Resource
Parameter Implementation":

> MCP clients **MUST** implement Resource Indicators for OAuth 2.0 as defined in RFC 8707 to
> explicitly specify the target resource for which the token is being requested. The
> `resource` parameter:
>
> 1. **MUST** be included in both authorization requests and token requests.
> 2. **MUST** identify the MCP server that the client intends to use the token with.
> 3. **MUST** use the canonical URI of the MCP server as defined in RFC 8707 Section 2.

and later on the same page:

> MCP clients **MUST** send this parameter regardless of whether authorization servers support
> it.

RFC 8707 §2 additionally says a server **MAY** require `resource`, and if it is required and
absent the request MUST be rejected.

## What we measured

Against a local authorization server that advertises `resource` in its RFC 9728 protected
resource metadata (`{"resource": "http://127.0.0.1:PORT/mcp", "authorization_servers": [...]}`)
and advertises the OAuth endpoints:

1. `auth(provider, { serverUrl })` returns `'REDIRECT'` and the provider's
   `redirectToAuthorization` receives:

   ```
   http://127.0.0.1:PORT/authorize
     ?response_type=code
     &client_id=...
     &code_challenge=...
     &code_challenge_method=S256
     &redirect_uri=...
     &state=...
   ```

   **No `resource`.**

2. The subsequent token request body contains `grant_type`, `code`, `code_verifier`,
   `redirect_uri`, `client_id`, `code_challenge_method`. **No `resource`.**

Measured with `@modelcontextprotocol/client@2.3.1` on Node v24.18.0.

## Minimal repro

```ts
import { auth, discoverOAuthServerInfo } from '@modelcontextprotocol/client';

// 1. A protected resource that answers RFC 9728 metadata advertising `resource`.
const serverUrl = 'http://127.0.0.1:PORT/mcp';

// 2. A provider that captures the authorization URL.
let captured: URL | undefined;
const provider = {
  get redirectUrl() { return 'http://localhost:3000/callback'; },
  get clientMetadata() {
    return {
      client_name: 'repro',
      redirect_uris: ['http://localhost:3000/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  },
  clientInformation: () => ({ client_id: 'repro-client' }),
  tokens: () => undefined,
  saveTokens: () => {},
  saveCodeVerifier: () => {},
  codeVerifier: () => 'verifier',
  state: () => 'state',
  redirectToAuthorization(url: URL) { captured = url; },
};

const info = await discoverOAuthServerInfo(serverUrl);
await auth(provider, { serverUrl: info.authorizationServerUrl });

console.log('authorization URL:', captured?.href);
console.log('has resource param:', captured?.searchParams.has('resource'));
// Expected per spec: true. Actual: false.
```

## Suggested questions

1. Is the omission intentional? RFC 8707 §2 lets a server REQUIRE `resource`, in which case
   this client cannot talk to that server at all.
2. `OAuthClientProvider.prepareTokenRequest` returns the token-request `URLSearchParams`,
   which could cover the token request. Is there an equivalent hook for the authorization
   request query parameters? Without one, a provider cannot satisfy MUST #1 fully.
3. Would you accept a pull request adding `resource` (derived from the `serverUrl` the
   transport was constructed with, or from the RFC 9728 `resource` value) to both requests?

## Why we are not patching around it

Our project consumes this SDK rather than vendoring it, so the workaround would be to
construct the authorization URL and the token request body ourselves — that is exactly the
custom wire-format code we are trying to avoid. We are shipping with the parameter absent and
tracking it as a known deviation in the meantime.

## Environment

- `@modelcontextprotocol/client`: 2.3.1
- Node: v24.18.0
- Platform tested: win32 x64 (behaviour is not platform-specific)