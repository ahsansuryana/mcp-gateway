# mcp-gateway

An aggregated MCP gateway. It presents one `POST /mcp` endpoint that fans out to many
upstream MCP servers — remote over Streamable HTTP, or local as `npx`-spawned stdio
processes — and namespaces what it returns.

- **Tools, prompts and resources** are namespaced `<server>_<name>` (D4).
- **Resource URIs** are rewritten `gw://<server>/<encoded original>` (D5).
- **Upstream failures never break the gateway** (D8): a broken upstream's tools disappear
  from `tools/list` and the reason shows in `GET /status`.
- **Two independent OAuth roles**: the gateway is an OAuth **client** toward upstreams
  (Sprint 5) and an OAuth **resource server** for inbound callers (Sprint 6). They share no
  credentials.

Documentation:

| Document | What it covers |
|---|---|
| [`docs/CONFIG.md`](docs/CONFIG.md) | Every configuration field, generated from the schema |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, "config is code", known spec deviations |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | **Step-by-step runbook for your own subdomain** |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Deployment, keys, firewall, troubleshooting |
| [`docs/MANUAL-TESTS.md`](docs/MANUAL-TESTS.md) | Tests that need a real deployment |
| [`docs/reports/project-summary.md`](docs/reports/project-summary.md) | What exists and what is verified where |
| [`docs/adr/`](docs/adr/) | Architecture decisions |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | Known gaps, deferred work |
| [`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md) | Questions still owed by a human |

## Quick start

### Install as a command

```bash
npm i -g @ahsansuryana/mcp-gateway
mcp-gate init                             # writes ~/.mcp-gateway/gateway.json
$EDITOR ~/.mcp-gateway/gateway.json       # then edit it
export GATEWAY_API_KEY='...'              # the example config uses {"env:GATEWAY_API_KEY"}
mcp-gate                                  # serve is the default command
```

`mcp-gate init --local` writes `./.mcp-gateway/gateway.json` instead, for a config that
belongs to one project rather than to you.

> If `npm i -g` fails with a permissions error, npm's global prefix is not writable by your
> user. `npm config get prefix` tells you where it is; a version manager (nvm, volta, asdf)
> or `npx @ahsansuryana/mcp-gateway` avoids the question.

### From a clone

```bash
npm ci
npm run build
node dist/cli.js init --local
export GATEWAY_API_KEY='...'
npm start                                 # serve is the default command
```

`serve` is the default, so `npm start`, `npm run dev`, `node dist/cli.js` and
`node dist/cli.js -c ./gateway.json` all start the gateway. `npm start -- -c <path>` works too.

Check it:

```bash
curl -s localhost:3000/healthz                          # {"ok":true} — unauthenticated
curl -s -H "Authorization: Bearer $GATEWAY_API_KEY" \
     localhost:3000/status | jq
```

### Where the config is looked for

First hit wins:

1. `-c <path>` / `--config <path>` — **authoritative**: used as given, and a missing file is an
   error naming that path rather than a silent fallback to another config
2. `$GATEWAY_CONFIG`
3. `./.mcp-gateway/gateway.json`
4. `$GATEWAY_HOME` (or your home directory) `/.mcp-gateway/gateway.json`
5. `./gateway.json` — deprecated, still works, warns once

`~` is never expanded: Node does not expand it, and a path starting with `~` would resolve
under the working directory rather than your home.

> **`{file:...}` in a config resolves against the WORKING DIRECTORY, not against the config
> file.** Moving your config into `.mcp-gateway/` does not move `{file:}` paths with it. See
> `docs/adr/0012-global-cli-and-config-dir.md`.

## With Docker

```bash
cp docker-compose.example.yml docker-compose.yml
printf 'GATEWAY_API_KEY=%s\nGATEWAY_TOKEN_KEY=%s\n' \
  "$(openssl rand -base64 24)" "$(openssl rand -base64 32)" > .env

docker compose run --rm gateway init     # writes the config INTO the volume
docker compose up --build                # then start it
```

The config lives in a **named volume** at `/home/node/.mcp-gateway/`, which is
`$GATEWAY_HOME`. `init` must run before the first `up`, because the config is not in the
image — it belongs to your installation, not to the build.

There is deliberately **no host bind mount**: the Docker host here is a remote machine, so a
local path cannot be mounted there at all, and a bind mount would hand the non-root `node`
user whatever permissions the host directory happens to carry.

`GATEWAY_TOKEN_KEY` is only needed when an upstream sets `oauth`. Back up the volume
*together with* that key: the token store is useless without it, and it cannot be rotated.

Full runbook: [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Upstream OAuth (gateway as client)

An upstream with `"oauth": {}` is registered through Dynamic Client Registration or a
Client ID Metadata Document, whichever the authorization server supports. The gateway
redirects a human to the authorization URL:

```bash
curl -i -H "Authorization: Bearer $GATEWAY_API_KEY" \
     localhost:3000/admin/oauth/<upstream>/start
curl -i localhost:3000/status | jq '.upstreams[] | select(.state=="auth_required")'
```

The authorization server must be able to reach the gateway's
`/.well-known/oauth-client.json`, so `gateway.publicUrl` must be set. See
`docs/OPERATIONS.md`.

## Inbound OAuth (gateway as resource server)

With `gateway.authOAuth` configured, the gateway publishes
`/.well-known/oauth-protected-resource/mcp`, answers unauthenticated `POST /mcp` with a
`401` carrying a `WWW-Authenticate` challenge, and validates bearer JWTs against the
authorization server's JWKS. Static bearer keys keep working side by side.

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | Run from source |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |
| `npm test` | Full suite |
| `npm run typecheck` / `npm run lint` | Gates required before every commit |
| `npm run gen:schema` | Regenerate `gateway.schema.json` **and** `docs/CONFIG.md` |
| `npm audit` | Required at every sprint end (PLAN.md §8) |

## Reloading

Edit `gateway.json` and it reloads automatically; `SIGHUP` forces a reload. An **invalid**
new file keeps the running configuration and logs the error naming the key path — it never
takes the gateway down. Upstreams whose entry did not change are left completely alone, so a
reload does not force users to re-consent.

## Development

```bash
npm ci
npm run typecheck && npm run lint && npm test
```

`node_modules` must be a real install: the test fixtures and the Docker image copy
`test/` deliberately. Tests never contact a third-party service.

## License

See the repository.