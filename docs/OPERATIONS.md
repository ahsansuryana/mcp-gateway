# Operations

Running the gateway in production: deployment topology, keys, the OAuth callback, the
Client ID Metadata Document, and the firewall information Anthropic publishes.

> `docs/CONFIG.md` is generated from the schema and lists every field. This document is
> about **running** the thing, not configuring it.

---

## 1. Deployment topology — YOUR decision, two options

The gateway's `publicUrl`, `port` and `host` are fully configurable and nothing in this
repository assumes a particular deployment. **This section documents the options; it does
not choose one.**

> **Important.** The hostname recorded in `docs/adr/0007-q4-resolved-and-cimd-self-served.md`
> (`<existing-hostname>`) is **also in use by another MCP server**. Nothing here binds to it,
> deploys to it, or writes a script that targets it. Pick an option below and set
> `publicUrl` accordingly in your own `.mcp-gateway/gateway.json`.

### Option A — the gateway gets its own subdomain

```
https://gateway.example.com/mcp          -> the gateway
https://<existing-hostname>/mcp          -> your OTHER server, untouched
```

```jsonc
// ~/.mcp-gateway/gateway.json (never committed)
"gateway": { "publicUrl": "https://gateway.example.com", "host": "0.0.0.0", "port": 3000 }
```

- The gateway needs **no** inbound rule on `<existing-hostname>`.
- `<existing-hostname>` could later be added as an **upstream** of the gateway if you want it
  aggregated, but that is a separate, optional step.
- Both servers must be reachable from Anthropic's egress range (see §5).

**Cost:** one more hostname and TLS certificate.

### Option B — your other server moves behind the gateway as an upstream

```
https://gateway.example.com/mcp   -> the gateway (the only public MCP endpoint)
                                  -> upstream: https://<existing-hostname>/mcp
```

```jsonc
"mcp": { "other": { "type": "remote", "url": "https://<existing-hostname>/mcp" } }
```

- Tools appear as `other_<tool>`.
- **The other server must allow the gateway's egress IP**, and if it uses OAuth its
  redirect URIs must be updated to the gateway's client metadata document.
- `gateway.publicUrl` is the **gateway's** URL, never the upstream's. The protected-resource
  metadata advertises `resource = <publicUrl>/mcp`, and Claude requires it to match the URL
  users enter.

**Cost:** the other server is now one hop further from every client, and its own clients
are not automatically redirected to the gateway.

### Choosing

| | A: own subdomain | B: other server behind the gateway |
|---|---|---|
| Blast radius | none for the other server | the other server's ingress changes |
| Tools aggregated | no | yes |
| Hostnames | +1 | unchanged |
| Egress rules to open | gateway + AS | gateway + AS + other server |

Whichever you pick: set `publicUrl`, keep it out of version control, and confirm
`GET /.well-known/oauth-protected-resource/mcp` returns your URL **before** connecting a
client.

---

## 2. Environment variables

Names only. **Never commit a value.**

| Variable | Required | Notes |
|---|---|---|
| `GATEWAY_API_KEY` | yes | The inbound static bearer key. Referenced as `{env:GATEWAY_API_KEY}`. |
| `GATEWAY_TOKEN_KEY` | only when an upstream uses `oauth` | base64, exactly 32 bytes, AES-256-GCM |
| `GATEWAY_CONFIG` | no | Path to the config file. See the search order below. |
| `GATEWAY_HOME` | no | Where `.mcp-gateway/` lives. Defaults to your home directory. The image sets it to `/home/node`. |
| `GATEWAY_TOKEN_STORE` | no | Overrides the token store path. |

### Where the config file is

First hit wins:

1. `-c <path>` / `--config <path>` — **authoritative**. Used as given; a missing file is an
   error naming that path, never a silent fallback to another config.
2. `$GATEWAY_CONFIG` — skipped, not fatal, when the file is missing.
3. `./.mcp-gateway/gateway.json`
4. `$GATEWAY_HOME` (else your home directory) `/.mcp-gateway/gateway.json`
5. `./gateway.json` — deprecated; still works and warns once, so no existing install breaks.

If none exists, the gateway exits non-zero listing every path it checked and pointing at
`mcp-gate init`. There is no stack trace: it is a configuration mistake, not a crash.

The OAuth token store lives at `<config dir>/data/tokens.enc.json`, created 0700 with the
file at 0600. If a store exists at the pre-`.mcp-gateway` location (`<config dir>/../data/…`)
and not at the new one, it is **still used** and a warning names it — silently starting on an
empty store would look like a working gateway that had forgotten every credential.

> **`{file:...}` resolves against the working directory, not the config file.** Moving the
> config into `.mcp-gateway/` does not move `{file:}` paths with it. The file's contents are
> also used verbatim, so a trailing newline becomes part of the secret.

### Generating `GATEWAY_TOKEN_KEY`

One line. Run it, put the output in your secret store, and **do not** commit it:

```bash
openssl rand -base64 32
```

Windows PowerShell:

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($b); [Convert]::ToBase64String($b)
```

The store is at `data/tokens.enc.json` beside the config file (or `GATEWAY_TOKEN_STORE`).
It is AES-256-GCM encrypted and written atomically.

> **Back up the key and the store together, or neither.** Losing the key makes the file
> undecryptable even if it survives; losing the file loses every stored upstream credential.

---

## 3. The OAuth callback and the Client ID Metadata Document

These matter when the gateway acts as an OAuth **client** toward an upstream.

### What the gateway serves

| Path | Auth | Purpose |
|---|---|---|
| `/.well-known/oauth-client.json` | none | Its Client ID Metadata Document |
| `/admin/oauth/:name/start` | gateway bearer key | Redirects to the authorization server |
| `/oauth/callback` | none (the AS redirects here) | Code exchange |

The metadata route exists **only** when `gateway.publicUrl` is set. Without it there is no
`https` `client_id` to publish, and the CIMD registration path fails with an error naming
`gateway.publicUrl` rather than silently downgrading to deprecated Dynamic Client
Registration.

### Start a flow

```bash
curl -i -H "Authorization: Bearer $GATEWAY_API_KEY" \
     http://localhost:3000/admin/oauth/notion/start
```

Returns `302` with a `Location:` the operator opens in a browser. Approve, and the AS
redirects to `<publicUrl>/oauth/callback`; the gateway replies `{"authorized":true}`.

### Check state

```bash
curl -s -H "Authorization: Bearer $GATEWAY_API_KEY" http://localhost:3000/status \
  | jq '.upstreams[] | select(.state=="auth_required")'
```

`/status` shows the **start URL**, never a token, a client secret, or key material.

### What the authorization server must support

Recorded with citations in
[`docs/ref/claude-connector-requirements.md`](ref/claude-connector-requirements.md). The
short version: CIMD (which needs **two** metadata values) or DCR; PKCE `S256`; a
form-urlencoded token endpoint; refresh-token rotation.

---

## 4. Inbound OAuth as a resource server

`gateway.authOAuth` makes the gateway validate bearer JWTs.

```jsonc
"gateway": {
  "publicUrl": "https://gateway.example.com",
  "auth": { "type": "bearer", "keys": ["{env:GATEWAY_API_KEY}"] },
  "authOAuth": { "issuer": "https://auth.example.com", "scope": "mcp:read" }
}
```

- `jwks_uri` is discovered from the issuer's metadata; `jwksUri` overrides it.
- The discovered issuer **must equal** `issuer` exactly.
- Only asymmetric signatures are accepted, which is what makes `alg: none` and `HS256`
  unusable.
- **There is no client secret and no signing key in this configuration.** The gateway is a
  resource server only (ADR 0005): it cannot mint a token or run a login.

---

## 5. Firewall information for claude.ai — OPTIONAL

> **This is not a security control.** It is published information that tells you which
> inbound connections to expect. Do not treat the allowlist below as protection: it does not
> authenticate anything, it changes, and an attacker is not obliged to route through it. Your
> real controls remain the bearer key, the OAuth validation, and TLS.

Anthropic documents that:

> "Anthropic's outbound traffic to your server originates from `160.79.104.0/21`."

— source: https://claude.com/docs/connectors/building/authentication
(also listed at https://platform.claude.com/docs/en/api/ip-addresses)

If you are behind a WAF that blocks unknown sources, you may allowlist `160.79.104.0/21` to
receive connections. The same range must reach:

- your gateway's `/mcp`, and
- your authorization server's `/.well-known/` and `/token`.

A WAF that strips `WWW-Authenticate`, or answers `403` on `/.well-known/`, breaks
discovery even when the server itself is fine.

---

## 6. Process lifecycle

- **Reload.** Editing the resolved config file reloads it; `SIGHUP` forces one. An invalid file keeps
  the running configuration and logs the key path. Unchanged upstreams are not restarted,
  so a reload never forces a re-consent.
- **Graceful shutdown.** On `SIGTERM` the gateway stops accepting, drains in-flight
  requests for up to `DRAIN_MS` (10 s), then stops upstreams including stdio children and
  flushes the token store. Give your orchestrator at least that long: `stop_grace_period:
  30s` in the compose example.
- **Process trees.** A forced shutdown kills the whole child tree. The shipped image
  installs `procps` so this works on Linux (ADR 0010); without it the gateway degrades to a
  direct-child kill and logs `process tree kill degraded to direct child`.

---

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| `401` with no `WWW-Authenticate` | The listener answered the request; a `401` carrying the header is what triggers sign-in |
| "Couldn't reach the MCP server" from a client | Is it a real `401`? Is `.well-known/oauth-protected-resource/mcp` returning `200`? |
| Browser opens a sign-in page on the MCP host | The client could not read your metadata; `authorization_servers` must name the real issuer |
| "No way to register a client" | The AS advertises neither CIMD's two flags nor a `registration_endpoint` |
| Issuer mismatch | The AS metadata `issuer` must equal the issuer that signs tokens (RFC 8414 §3.3) |
| Audience mismatch | The AS must mint `aud` = your canonical MCP URL (no trailing slash) |
| `415` from the token endpoint | It needs `application/x-www-form-urlencoded` |
| Upstream stuck in `auth_required` | Start the flow: `/admin/oauth/:name/start` |
| Every request `429` | `gateway.rateLimit` is set; `Retry-After` says when to retry |
| Config reload rejected | The log names the key path. The previous configuration is still running. |

---

## 8. Known limitations

Recorded rather than discovered later:

- **Tokens obtained for upstreams are not audience-bound** (ADR 0008). The SDK does not send
  the RFC 8707 `resource` parameter; see `docs/SECURITY.md`.
- **Lazy authentication is not implemented** (B-35). The gateway requires a credential
  before any `/mcp` request, which is Claude's "Sign in now" mode.
- **Scope step-up is not implemented** (B-31, B-36).
- **Rate-limit buckets do not separate OAuth subjects** (B-37).
- **The Docker daemon on the development machine is a remote host**; see B-29.