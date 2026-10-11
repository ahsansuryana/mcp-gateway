# DEPLOY.md — running the gateway on its own subdomain (Option A)

A step-by-step runbook. Every command is given with the exact form to type; nothing here
assumes a hostname you have not told me, and nothing touches your other MCP server.

- **Decision:** ADR 0007 (amended) — Option A, the gateway gets its **own subdomain**.
- **Not to be touched:** your existing MCP server's host. No DNS record, reverse-proxy rule,
  certificate or port on it is read or written by this runbook.
- **Authorization server:** still not chosen. Step 9 is therefore *blocked on your decision*,
  and everything before it is not.

---

## 0. Before you start: three things only you can supply

| # | What | Why it cannot be in this repo |
|---|---|---|
| 1 | **The new subdomain**, e.g. `mcp-gateway.yourdomain.tld` | A production hostname is never committed (PLAN.md rule 10). |
| 2 | **DNS control** for that subdomain | Must point at the Docker host. |
| 3 | **An authorization server** — *only for step 9* | Not chosen, and this runbook does not pick one. |

Throughout this document it is written `<SUBDOMAIN>`. Substitute it literally. If you see
`<SUBDOMAIN>` still in a command, **stop** — you have not filled in the hostname yet, and the
gateway must not be deployed with a guessed one.

---

## 1. Generate the secrets

Run these on the Docker host. **Write the values down in your password manager, never in a
file you commit and never into this repository.**

```bash
# Inbound static bearer key — clients present this as `Authorization: Bearer <key>`.
openssl rand -base64 32

# AES-256-GCM key for the upstream token store. ONLY needed if an upstream uses OAuth.
# It is REQUIRED from the moment you configure any OAuth upstream, and it cannot be
# rotated later: changing it makes every stored upstream credential undecryptable.
openssl rand -base64 32
```

Keep both **stable** for the life of the deployment. If you lose the second one, every stored
upstream credential must be re-authorized by hand.

### Environment variable names

Names only. Values go in the `.env` file in step 3.

| Variable | Required | Purpose |
|---|---|---|
| `GATEWAY_API_KEY` | yes | the inbound static bearer key (PLAN.md D9) |
| `GATEWAY_TOKEN_KEY` | only with OAuth upstreams | base64 32-byte AES-256-GCM key for the token store |
| `GATEWAY_CONFIG` | no | path to the config inside the container; defaults to `/app/gateway.json` |
| `GATEWAY_TOKEN_STORE` | no | path to the encrypted token store; defaults to `/app/data/tokens.json` |
| `PORT` | no | the port the gateway listens on inside the container; defaults to `3000` |

Verified in `src/index.ts` (`GATEWAY_TOKEN_STORE`, and the `GATEWAY_CONFIG` default) and by the
`{env:…}` substitution in `gateway.example.json` (`GATEWAY_API_KEY`).

---

## 2. Build the image

From a checkout of this repository:

```bash
docker build -t mcp-gateway:deploy .
```

The build is architecture-neutral — the base image is not pinned to `linux/amd64` or
`linux/arm64`, so it resolves to whatever the builder's platform is.

If your shell is **Git Bash on Windows** and the Docker daemon is remote, prefix `docker`
commands that take a path with `MSYS_NO_PATHCONV=1`:

```bash
MSYS_NO_PATHCONV=1 docker build -t mcp-gateway:deploy .
```

Without it, MSYS rewrites `/app/...` into `G:/Application/Git/app/...` and the path never
arrives. This is B-29, and it is not specific to this runbook.

---

## 3. Write the config and the .env

Create a directory that is **not** inside the git repository, e.g. `/opt/mcp-gateway`.

> ### If your Docker daemon is REMOTE, the runbook must run ON the Docker host
>
> The development host for this project has its daemon on a separate machine (Armbian,
> `linux/arm64`), reached over the network from Windows. That matters here because a bind
> mount source is resolved **on the daemon's host, not where you typed the command**. Running
> `docker compose up` from your Windows machine against a remote daemon would send
> `C:\...\gateway.json` as the mount source, and the Linux daemon has no such path — the
> container starts with an empty or missing config.
>
> Two consequences:
>
> - Put `gateway.json` and `.env` **on the Docker host**, at a real Linux path.
> - Run `docker compose` **on that host** (or with an absolute path that exists there).
>
> This is the same class of problem as B-29, where Git Bash rewrote `/app/...` into
> `G:/Application/Git/app/...` and the path never arrived. Always confirm which host a
> container's mounts actually resolved on:
>
> ```bash
> docker inspect <container> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
> ```

`/opt/mcp-gateway/gateway.json`:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/…/gateway.schema.json",
  "gateway": {
    "host": "0.0.0.0",
    "port": 3000,
    // YOUR hostname. This is the only place it is written.
    "publicUrl": "https://<SUBDOMAIN>",
    "auth": {
      "type": "bearer",
      "keys": ["{env:GATEWAY_API_KEY}"]
    },
    "defaultTimeoutMs": 30000,
    "defaultTtlMs": 30000,
    "legacyEra": "stateless"
  },
  "mcp": {
    // your upstreams
  }
}
```

`/opt/mcp-gateway/.env` — mode `600`, never committed:

```bash
chmod 600 /opt/mcp-gateway/.env
```

```
GATEWAY_API_KEY=<value from step 1>
GATEWAY_TOKEN_KEY=<value from step 1>
```

> `publicUrl` is required for the Client ID Metadata Document, the OAuth token audience, the
> RFC 9728 protected-resource metadata and the Origin allowlist. **With it unset the gateway
> refuses to start the CIMD route and has no identity to publish** (ADR 0007 consequence 2).
> If `<SUBDOMAIN>` is still in the file, you are not ready for step 8.

---

## 4. Compose file

`/opt/mcp-gateway/docker-compose.yml`:

```yaml
services:
  gateway:
    image: mcp-gateway:deploy
    # Bind-mounted READ-ONLY so the real config stays on the host and is never baked
    # into an image. This mount was missing from docker-compose.example.yml; the gateway
    # exited at startup with "could not read the config file at /app/config/gateway.json".
    volumes:
      - ./gateway.json:/app/config/gateway.json:ro
      - gateway-data:/app/data
    env_file:
      - .env
    environment:
      GATEWAY_CONFIG: /app/config/gateway.json
      PORT: "3000"
    # Loopback only. The TLS reverse proxy on the host reaches it from there; nothing
    # on the internet can reach the container port directly.
    ports:
      - "127.0.0.1:3000:3000"
    restart: unless-stopped
    # Long enough for the gateway's own drain (up to 10s) plus slack. Shortening this
    # makes Docker SIGKILL the process mid-request and skips the drain entirely.
    stop_grace_period: 30s
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true

volumes:
  gateway-data:
```

```bash
cd /opt/mcp-gateway
docker compose up -d
docker compose ps
docker compose logs -f gateway
```

Expect `gateway listening` and no error. If it exits immediately, the usual cause is a config
that fails validation — `docker compose logs gateway` names the offending key path.

---

## 5. Back up the token store

The `gateway-data` volume holds the encrypted token store.

> Losing the volume loses every stored upstream credential. Losing `GATEWAY_TOKEN_KEY` makes the
> store undecryptable **even if the file survives**. Back up both together, or neither.

```bash
docker run --rm -v mcp-gateway_gateway-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/gateway-data.tgz -C /data .
```

---

## 6. DNS

Create an **A record for the new subdomain only**, pointing at the Docker host:

```
<SUBDOMAIN>   A   <the Docker host's public IPv4>
```

- If the host's address changes, this record is what breaks first. Use a provider that gives
  the host a stable name, or update the record when it moves.
- Do **not** create a record for, or delegate anything of, your existing MCP server's host.

---

## 7. Expose it over HTTPS

The gateway speaks plain HTTP and expects a TLS-terminating proxy in front (ADR 0001). Three
options, described rather than chosen — **the choice is yours**, and nothing below is required
over the others.

### Option 7a — reverse proxy on the Docker host (most conventional)

Terminate TLS in front of `127.0.0.1:3000`.

- **Caddy** — automatic HTTPS with no certificate ceremony. A three-line config:

  ```
  <SUBDOMAIN> {
      reverse_proxy 127.0.0.1:3000
  }
  ```

  It obtains and renews the certificate by itself.

- **nginx + certbot** — you run `certbot --nginx -d <SUBDOMAIN>`, then reload. More moving parts,
  full control.

- **Traefik** — automatic discovery through Docker labels. Convenient if other containers on
  this host already use it.

> **Do not reuse the certificate, reverse-proxy config or container of your other MCP server.**
> Option A exists so the two servers are independent; sharing any of those re-couples them.

### Option 7b — tunnel (for a first test only)

```bash
cloudflared tunnel --url http://127.0.0.1:3000
# or
ngrok http 3000
```

Quick, no DNS and no certificate, but:

- the hostname is assigned to you and changes between runs, which breaks `publicUrl`,
  the CIMD document and any allowlist;
- it is **not** a production arrangement.

Use it to confirm the gateway answers, then move to 7a.

### Option 7c — an external load balancer or platform TLS

If the Docker host is already behind one. Same rule: a new hostname and its own certificate,
independent of the existing server's.

---

## 8. Post-deployment checks

Run from a machine that is **not** the Docker host, so you are testing the real path.

### 8a. Liveness

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<SUBDOMAIN>/healthz
# expect: 200
```

### 8b. The resource metadata Claude needs — do this before anything else

```bash
curl -si https://<SUBDOMAIN>/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -20
```

Expect **`401`** with a `WWW-Authenticate` header containing `resource_metadata=`.

> A `200` that merely *carries* the header is **ignored by Claude** and presents as
> "Couldn't reach the MCP server". If you see 200, stop here — nothing on Claude's side will
> work until this is a real 401. (`docs/ref/claude-connector-requirements.md`.)

Then confirm the document itself is served:

```bash
curl -s https://<SUBDOMAIN>/.well-known/oauth-protected-resource/mcp | jq
```

### 8c. Authenticated request and tool call

```bash
export GATEWAY_API_KEY='<value from step 1>'

curl -s -H "Authorization: Bearer $GATEWAY_API_KEY" https://<SUBDOMAIN>/status | jq

curl -s https://<SUBDOMAIN>/mcp \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

### 8d. In-container smoke test (needs the smoke config, not production)

The image bakes `spikes/smoke/gateway.json` and a single-tool stdio upstream for exactly this:

```bash
docker exec -e GATEWAY_API_KEY="$GATEWAY_API_KEY" mcp-gateway-deploy-1 \
  sh /app/scripts/smoke.sh
```

It hits `/healthz`, identity, `tools/list`, a 401, `/status` and a **real `tools/call`**, and
asserts the bearer key is not echoed back. Expect `SMOKE TEST PASSED`.

> It runs against the **baked smoke config**, not your production `gateway.json`. It proves the
> image works; it does not prove your production config is correct. Step 8c covers that.

### 8e. Optional: allowlist Anthropic's egress

Claude reaches your server from `160.79.104.0/21`
(<https://platform.claude.com/docs/en/api/ip-addresses>). Add it to your firewall or proxy ACL
if you front the gateway with one. **This is operational hygiene, not a security control** —
nothing about authentication depends on it, and blocking everything else is not required.

---

## 9. Run the manual tests, in this order

`docs/MANUAL-TESTS.md` has the full checklists. The order matters because the first one is
unblocked by this runbook and the second is not.

### Step 9a — S5-MANUAL first

**Needs only: a reachable `publicUrl`** — which you now have, because the CIMD document is
served from it. It does **not** need an authorization server.

Target: a real OAuth-protected MCP server (Notion's `https://mcp.notion.com/mcp` is the one
already investigated). What it proves: the gateway's OAuth **client** side, including CIMD
against a server that advertises it.

```bash
# 1. add the upstream to gateway.json with "oauth": { "scope": "default" }, then reload
docker compose restart gateway
# 2. confirm the upstream is in auth_required and get the start URL
curl -s -H "Authorization: Bearer $GATEWAY_API_KEY" https://<SUBDOMAIN>/status | jq
# 3. open the oauthStartUrl in a browser, approve, and expect
#    {"upstream":"notion","authorized":true}
# 4. tools/list must return notion_* tools
```

Watch for: the gateway does **not** send the RFC 8707 `resource` parameter (ADR 0008). If a
server rejects the token for that reason, it is the known deviation, not a new bug.

### Step 9b — S6-MANUAL second, and it is BLOCKED

**Needs an authorization server, which you have not chosen.** There is nothing to run until
there is one.

When you choose, `docs/ref/claude-connector-requirements.md` § 5 lists the 12 criteria to
check it against. Then:

1. `gateway.authOAuth` in `gateway.json`, with `issuer` and `audience`
   (`audience` = `https://<SUBDOMAIN>/mcp`, **no trailing slash**).
2. Restart, and re-run 8b — the `401` challenge must now name your issuer's metadata.
3. In Claude: **Customize → Connectors → Add custom connector**, server URL
   `https://<SUBDOMAIN>/mcp`, **Sign in now**.

> Authentication settings cannot be changed after a connector is added. Remove and re-add to
> change them.

---

## 10. Routine operations

```bash
docker compose logs -f gateway        # follow
docker compose restart gateway        # config reload also works: touch gateway.json,
                                      # or send SIGHUP to the process
docker compose down                   # stop; drains for up to 10s first
docker compose up -d --build          # rebuild after pulling changes
```

| Symptom | First thing to check |
|---|---|
| container exits at once | `docker compose logs gateway` — almost always config validation |
| `could not read the config file` | `GATEWAY_CONFIG` vs the mount in step 4 |
| 401 everywhere | `GATEWAY_API_KEY` in `.env` vs the `{env:…}` reference in the config |
| Claude: "Couldn't reach the MCP server" | 8b: is it a real `401` **with** the header? |
| upstreams flapping | `docker compose logs gateway \| grep -i upstream` |
| everything `429` | rate limit hit; each key and each OAuth subject now has its own bucket |

Full reference: `docs/OPERATIONS.md`, `docs/SECURITY.md`.
