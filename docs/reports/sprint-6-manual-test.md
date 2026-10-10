# S6.3 manual checklist — registering the gateway as a claude.ai custom connector

**Not performed.** The human runs this once **Q4 is deployed** (the gateway reachable at its
public https URL) **and an authorization server exists**. Neither is true yet.

Requirements this checklist satisfies were researched from Anthropic's official
documentation and recorded with citations in `docs/ref/claude-connector-requirements.md`.
Read that file first — it explains *why* each step below exists.

## Prerequisites

| # | Prerequisite | How to confirm |
|---|---|---|
| P1 | The gateway is reachable at `https://<your-public-host>/mcp` from the public internet | `curl` from an outside network |
| P2 | `160.79.104.0/21` can reach the gateway | Anthropic's egress range; see the doc |
| P3 | An external authorization server is chosen and satisfies the 12 criteria in `docs/ref/claude-connector-requirements.md` §5 | Its live `/.well-known/` metadata |
| P4 | `gateway.json` has `publicUrl` and `authOAuth` | `npm run start`, then `GET /status` |
| P5 | `GATEWAY_TOKEN_KEY` is set in the gateway's environment | never committed |

## Step 1 — prove the resource side first, before involving Claude

```bash
# 1a. Metadata at the MCP path
curl -s https://<host>/.well-known/oauth-protected-resource/mcp | jq

# 1b. An unauthenticated call MUST be a 401 carrying the challenge
curl -si -X POST https://<host>/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -20
```

Expect in 1b: `HTTP/1.1 401` and
`WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp"`.

**Why this matters:** Anthropic's documentation states the `401` status is *required*, because
Claude **ignores** a `WWW-Authenticate` header on a `200`. A server that answers `200` with
the header will appear to Claude as an unreachable server.

Stop here if 1a/1b are wrong. Nothing Claude does will work.

## Step 2 — check the authorization server against Claude's specific requirements

From `docs/ref/claude-connector-requirements.md` §3:

- [ ] metadata advertises `client_id_metadata_document_supported: true` **AND** `"none"` in
      `token_endpoint_auth_methods_supported` — otherwise Claude silently falls back to DCR
- [ ] or a `registration_endpoint` is exposed
- [ ] `code_challenge_methods_supported` contains `"S256"`
- [ ] redirect URI `https://claude.ai/api/mcp/auth_callback` registered exactly
- [ ] loopback `http://localhost/callback` and `http://127.0.0.1/callback` accepted with the
      **port ignored** (Claude Code)
- [ ] token endpoint accepts `application/x-www-form-urlencoded`, not JSON-only
- [ ] refresh tokens rotate; a replayed refresh token returns `invalid_grant`
- [ ] reachable from `160.79.104.0/21`

## Step 3 — add the connector in claude.ai

1. **Customize → Connectors → Add custom connector**.
2. Enter the connector name (what users see).
3. Enter the **server URL**: `https://<host>/mcp` — the full URL including the path. It must
   match the `resource` in your metadata exactly.
4. Continue. Review the authentication settings Claude detected.
5. Under **Authentication** choose **Sign in now**.
6. Under **OAuth client** leave **Use Claude's published identity (Recommended)** if the AS
   passes the CIMD check above; otherwise choose **Register automatically** (DCR) or
   **Use your own OAuth client** with a client you registered.
7. Continue and add.

You cannot change authentication settings afterwards — remove and re-add to change them.

## Step 4 — complete the consent step

A browser opens your authorization server's consent page. Approve. Claude receives the code
at `https://claude.ai/api/mcp/auth_callback`, then exchanges it at your token endpoint.

Watch the authorization server's logs for a successful token exchange.

## Step 5 — verify end to end

- [ ] the connector shows as connected
- [ ] a tool call succeeds and returns a result
- [ ] your gateway log shows the request with a **verified** subject, and **no token value**
- [ ] `GET /status` shows `oauthIssuer` and `oauthAudience` and no token material

## If it fails

| Symptom | First thing to check |
|---|---|
| "Couldn't reach the MCP server" | Step 1b — is it a real `401` with the header? |
| Browser opens a sign-in page on your MCP host | Claude could not read your metadata; the `authorization_servers` entry must be the AS issuer URL |
| "No way to register a client" | Step 2 — CIMD needs BOTH metadata flags, or a `registration_endpoint` |
| Issuer mismatch | the AS metadata `issuer` must equal the issuer that signs tokens (RFC 8414 §3.3) |
| Audience mismatch | the AS must mint `aud` = your canonical MCP URL (`https://<host>/mcp`, no trailing slash) |
| PKCE failure | `code_challenge_methods_supported` must contain `"S256"` |
| `415` from the token endpoint | form-urlencoded body parser is missing on the AS |

Full diagnostics: `https://claude.com/docs/connectors/building/troubleshooting`

## Redaction

If a transcript is captured: replace every authorization code, `state`, access token and
refresh token with `<REDACTED>`. The gateway's own logs never contain them; the AS's might.