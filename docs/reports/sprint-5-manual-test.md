# S5 manual test — connecting to a real OAuth-protected MCP server

Status: **BLOCKED, needs a human decision.** Do not improvise past the blocker below.

## Target: Notion's remote MCP

Discovered, not assumed. Every value below came from live metadata fetched during Sprint 5.

### 1. The resource server challenges

```
$ curl -sD - -o /dev/null https://mcp.notion.com/mcp
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="OAuth",
                 resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp",
                 scope="default"
```

A `WWW-Authenticate` challenge carrying `resource_metadata` — mechanism 1 of the two the spec
requires clients to support (`docs/ref/spec-2026-07-28-basic-authorization-authorization-server-discovery.md`
line 49).

### 2. Protected Resource Metadata

`GET https://mcp.notion.com/.well-known/oauth-protected-resource/mcp`

```json
{
  "resource": "https://mcp.notion.com/mcp",
  "authorization_servers": ["https://mcp.notion.com"],
  "scopes_supported": ["default"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Notion MCP (Beta)"
}
```

### 3. Authorization Server Metadata

`GET https://mcp.notion.com/.well-known/oauth-authorization-server`

| Field | Value |
|---|---|
| `issuer` | `https://mcp.notion.com` |
| `authorization_endpoint` | `https://mcp.notion.com/authorize` |
| `token_endpoint` | `https://mcp.notion.com/token` |
| `registration_endpoint` | `https://mcp.notion.com/register` |
| `code_challenge_methods_supported` | `["S256"]` |
| `token_endpoint_auth_methods_supported` | `client_secret_basic`, `client_secret_post`, **`none`** |
| `grant_types_supported` | `authorization_code`, `refresh_token`, `urn:ietf:params:oauth:grant-type:jwt-bearer` |
| `scopes_supported` | `["default"]` |
| **`client_id_metadata_document_supported`** | **`true`** |
| `authorization_response_iss_parameter_supported` | `true` |

## Why this is blocked

The gateway's registration order is fixed (`docs/ref/oauth-flow.md` § 3):

1. static `clientId` from config — **not configured**
2. **Client ID Metadata Document — Notion advertises this (`true`)**
3. Dynamic Client Registration (`registration_endpoint` present)
4. operator prompt

So the gateway correctly selects **step 2, CIMD**. CIMD requires the gateway to publish a
client metadata document at a public **https** URL whose path is `client_id`
(`docs/ref/spec-2026-07-28-basic-authorization-client-registration.md` lines 40-43). That
needs `gateway.publicUrl`, which is unset because **Q4 is open** and no hostname may be
invented. This is logged as **Q-CIMD**.

**The redirect URI is NOT the blocker.** `token_endpoint_auth_methods_supported` includes
`none`, and the spec's own CIMD example lists `http://localhost:3000/callback` as acceptable
(same page, line 64). `http://localhost:<port>/oauth/callback` satisfies Notion.

## Decision required

Pick one; the agent does not choose.

| Option | What it means | Cost |
|---|---|---|
| **A. Answer Q4** | Set `gateway.publicUrl` to a real https URL the gateway is reachable at, and serve `/.well-known/oauth-client.json`. CIMD then works as specified. | Needs a hostname + TLS. The sprint-6 metadata work also needs it. |
| **B. Force DCR for this upstream** | A config flag that skips the CIMD branch and uses `registration_endpoint`. Notion supports it. | A new config field = a schema change, so it needs an ADR. DCR is deprecated by the spec. |
| **C. Pre-register a client at Notion** | Put the resulting `clientId` in `oauth.clientId`, taking step 1 of the order. | Requires registering manually outside the gateway. |

Option A is the one that unblocks the most (Sprint 6 needs `publicUrl` too). Option B is the
shortest path to a manual test but bends the fixed registration order, which you specified.

## Steps, once the decision is made

These are written now so the manual test is a checklist, not an improvisation.

1. **Set the environment**

   ```
   # Windows PowerShell — generate the token-store key, then export it.
   $b = New-Object byte[] 32
   [Security.Cryptography.RandomNumberGenerator]::Fill($b)
   $env:GATEWAY_TOKEN_KEY = [Convert]::ToBase64String($b)
   ```

   Never write that value into a file, a transcript or a commit. The `data/` directory is
   git-ignored.

2. **Write `gateway.json`** (JSONC, comments allowed)

   ```jsonc
   {
     "gateway": {
       "host": "127.0.0.1",
       "port": 3000,
       "auth": { "type": "bearer", "keys": ["{env:GATEWAY_API_KEY}"] },
       "defaultTimeoutMs": 30000,
       "defaultTtlMs": 30000
     },
     "mcp": {
       "notion": {
         "type": "remote",
         "url": "https://mcp.notion.com/mcp",
         "timeout": 30000,
         "oauth": { "scope": "default" }
       }
     }
   }
   ```

   The `scope` comes from `scopes_supported` and the `WWW-Authenticate` challenge, both
   `default` — the spec's scope selection priority (step 1: use the challenge's `scope`).

3. **Start the gateway** and check the initial state

   ```
   npm run start
   curl -s -H "Authorization: Bearer $env:GATEWAY_API_KEY" http://127.0.0.1:3000/status
   ```

   Expect `"state": "auth_required"` for `notion` and an `oauthStartUrl`.

4. **You perform the consent step in a browser**

   Open `http://127.0.0.1:3000/admin/oauth/notion/start` **with the gateway bearer key**.
   Express does not send credentials to the gateway from a plain link, so either paste the
   header via a browser extension or use:

   ```
   curl -i -H "Authorization: Bearer $env:GATEWAY_API_KEY" \
     http://127.0.0.1:3000/admin/oauth/notion/start
   ```

   and open the `Location:` URL it returns. You will land on Notion's consent page. Approve.

5. **Notion redirects to the callback**

   `http://127.0.0.1:3000/oauth/callback?code=...&state=...&iss=https://mcp.notion.com`
   Expect `{"upstream":"notion","authorized":true}`.

6. **Verify the upstream is usable**

   ```
   curl -s -H "Authorization: Bearer $env:GATEWAY_API_KEY" \
     -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     http://127.0.0.1:3000/mcp
   ```

   Tools must be namespaced `notion_*`.

7. **Redaction.** In the transcript, replace `code`, `state`, every `access_token`, every
   `refresh_token` and any `client_secret` with `<REDACTED>`. `GET /status` must never show
   any of them; that is itself an assertion worth making.

## What to watch for

- **Step 4 will fail today** with a CIMD warning, because `publicUrl` is unset. That is the
  expected state, not a new bug.
- Notion advertises `authorization_response_iss_parameter_supported: true`, so a callback
  **without** `iss` must be rejected. If Notion ever omits it, the gateway refuses the
  response by design (`docs/ref/spec-2026-07-28-basic-authorization-index.md` line 203).
- The gateway will **not** send a `resource` parameter (Q-SDK-RESOURCE). Notion's metadata
  advertises `resource` and `protected_resources`, so if it rejects a token issued without
  `resource`, that is this known deviation surfacing, not a new bug. Record which.