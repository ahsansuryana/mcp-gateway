# Manual tests

Tests that cannot be automated because they need a **real deployment**: a public hostname,
TLS, a browser consent screen, or a third-party service.

**Both tests below are DEFERRED and have NOT been run.** They are consolidated here from
`docs/reports/sprint-5-manual-test.md` (upstream OAuth against a real server) and
`docs/reports/sprint-6-manual-test.md` (claude.ai custom connector), which are kept for the
narrative detail.

Neither is a Sprint 7 blocker.

## Environment variables — NAMES ONLY

Never write a value into this file, a transcript or a commit.

| Variable | Needed for |
|---|---|
| `GATEWAY_API_KEY` | both tests |
| `GATEWAY_TOKEN_KEY` | both tests (upstream OAuth) |
| `GATEWAY_CONFIG` | optional; path to the config |
| `GATEWAY_TOKEN_STORE` | optional; token store path |

Generate the token key with: `openssl rand -base64 32`

## What to redact in any transcript

- every authorization `code`
- every `state`
- every `access_token` and `refresh_token`
- every `client_secret`
- the bearer key
- the values of the variables above

`/status` should never contain any of them; **asserting that is part of the test.**

---

# Test 1 — upstream OAuth against a real server

Target: Notion's `https://mcp.notion.com/mcp`, chosen because it is a real OAuth-protected
MCP server reachable from anywhere.

## Live metadata captured during Sprint 5 (not assumed)

`GET https://mcp.notion.com/mcp` without a token:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="OAuth",
                 resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp",
                 scope="default"
```

Authorization server metadata, `https://mcp.notion.com/.well-known/oauth-authorization-server`:

| Field | Value |
|---|---|
| `issuer` | `https://mcp.notion.com` |
| `authorization_endpoint` | `https://mcp.notion.com/authorize` |
| `token_endpoint` | `https://mcp.notion.com/token` |
| `registration_endpoint` | `https://mcp.notion.com/register` |
| `code_challenge_methods_supported` | `["S256"]` |
| `token_endpoint_auth_methods_supported` | `client_secret_basic`, `client_secret_post`, `none` |
| `scopes_supported` | `["default"]` |
| **`client_id_metadata_document_supported`** | **`true`** |
| `authorization_response_iss_parameter_supported` | `true` |

## Why it is blocked

The gateway's registration order is fixed, and Notion advertises CIMD, so the gateway
correctly selects **Client ID Metadata Document** — which requires the gateway to publish a
public `https` document. That needs `gateway.publicUrl`, which needs the deployment decision
in `docs/OPERATIONS.md` § 1.

The **redirect URI is not the blocker**: Notion lists `none` in its token endpoint auth
methods, and the MCP spec's own CIMD example accepts `http://localhost:3000/callback`.

## Steps, once deployed

1. Export `GATEWAY_API_KEY` and `GATEWAY_TOKEN_KEY`; write `gateway.json` with
   `"oauth": { "scope": "default" }` on the `notion` upstream (the scope comes from both
   `scopes_supported` and the `WWW-Authenticate` challenge).
2. Start the gateway and check:
   `curl -s -H "Authorization: Bearer $GATEWAY_API_KEY" http://127.0.0.1:3000/status`
   Expect `notion` in `auth_required` with an `oauthStartUrl`.
3. Open the start URL in a browser (with the bearer key) and approve Notion's consent page.
4. Expect `{"upstream":"notion","authorized":true}` from the callback.
5. `tools/list` must return `notion_*` tools.
6. Assert `/status` contains no token, code, state or client secret.

## Watch for

- The gateway does **not** send the RFC 8707 `resource` parameter (ADR 0008). If Notion
  rejects the token for that, it is the known deviation, not a new bug.
- Notion advertises `authorization_response_iss_parameter_supported: true`, so a callback
  without `iss` is rejected by design.

---

# Test 2 — claude.ai custom connector

Requirements researched from Anthropic's documentation are in
`docs/ref/claude-connector-requirements.md`. Read it first.

## Prerequisites

- [ ] The gateway is reachable at its public `https` URL from the internet
- [ ] `160.79.104.0/21` can reach it (Anthropic's egress range; **optional** firewall
      information, not a security control)
- [ ] An external authorization server exists and passes the 12 criteria in that document

## Step 1 — prove the resource side, before involving Claude

```bash
curl -s https://<host>/.well-known/oauth-protected-resource/mcp | jq
curl -si -X POST https://<host>/mcp   -H 'content-type: application/json' -H 'accept: application/json, text/event-stream'   -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -20
```

Expect a **real `401`** with
`WWW-Authenticate: Bearer resource_metadata="…"`.

> A `200` carrying the header is **ignored** by Claude and looks like an unreachable server.
> Stop here if this is wrong; nothing on Claude's side will work.

## Step 2 — check the authorization server against Claude's requirements

- [ ] `client_id_metadata_document_supported: true` **and** `"none"` in
      `token_endpoint_auth_methods_supported`, **or** a `registration_endpoint`
- [ ] `code_challenge_methods_supported` contains `["S256"]`
- [ ] redirect URI `https://claude.ai/api/mcp/auth_callback` registered exactly
- [ ] loopback `http://localhost/callback` and `http://127.0.0.1/callback` accepted with
      the **port ignored** (Claude Code)
- [ ] token endpoint accepts `application/x-www-form-urlencoded`
- [ ] refresh tokens rotate; a replayed one returns `invalid_grant`
- [ ] reachable from `160.79.104.0/21`

## Step 3 — add the connector

**Customize → Connectors → Add custom connector**, then:

1. Enter the connector name.
2. Enter the server URL: `https://<host>/mcp` — full URL including the path. It must match
   the `resource` in your metadata exactly.
3. Authentication → **Sign in now**.
4. OAuth client → **Use Claude's published identity** if Step 2's CIMD check passed,
   otherwise **Register automatically** or **Use your own OAuth client**.
5. Continue and add.

Authentication settings cannot be changed afterwards; remove and re-add to change them.

## Step 4 — consent, then verify

- [ ] the connector shows as connected
- [ ] a tool call succeeds
- [ ] the gateway log shows the request with a **verified subject** and no token value
- [ ] `/status` shows `oauthIssuer` and `oauthAudience` and nothing sensitive

## If it fails

| Symptom | Check |
|---|---|
| "Couldn't reach the MCP server" | Step 1: is it a real `401` with the header? |
| Sign-in page opens on your MCP host | `authorization_servers` must name the real issuer |
| "No way to register a client" | Step 2: CIMD needs **both** metadata values, or a `registration_endpoint` |
| Issuer mismatch | AS metadata `issuer` must equal the signing issuer (RFC 8414 §3.3) |
| Audience mismatch | AS must mint `aud` = your canonical MCP URL, no trailing slash |
| `415` from the token endpoint | form-urlencoded body parser missing |

Full diagnostics: https://claude.com/docs/connectors/building/troubleshooting
