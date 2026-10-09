# opencode MCP config — verified field names

Source: <https://opencode.ai/docs/mcp-servers/> (page footer: "Last updated: Oct 8, 2026").
Fetched during Sprint 0 task S0.5. The plan author had reconstructed §6 of PLAN.md from
memory; this file records what the documentation actually says.

The gateway's own config is `gateway.json`, NOT opencode config. This document exists
because PLAN.md §6 was explicitly modelled on opencode's `mcp` section, so the real field
names are the reference point for §6.

## Top level

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "name-of-mcp-server": {
      "type": "local",
      "enabled": true
    }
  }
}
```

`$schema` points at `https://opencode.ai/config.json`. Servers are keyed by a **unique
name of the author's choosing** — the documentation places no regex constraint on the key.

## `type: "local"`

| Field | Type | Required | Notes from the docs |
|---|---|---|---|
| `type` | String | yes | must be `"local"` |
| `command` | Array | yes | command and arguments, e.g. `["npx", "-y", "pkg"]` |
| `cwd` | String | no | working directory for the process; relative paths resolve from the workspace |
| `environment` | Object | no | environment variables to set when running the server |
| `enabled` | Boolean | no | enable/disable on startup |
| `timeout` | Number | no | **timeout in ms for fetching tools; defaults to 5000 (5 s)** |

## `type: "remote"`

| Field | Type | Required | Notes from the docs |
|---|---|---|---|
| `type` | String | yes | must be `"remote"` |
| `url` | String | yes | URL of the remote MCP server |
| `enabled` | Boolean | no | |
| `headers` | Object | no | headers to send with the request |
| `oauth` | Object \| `false` | no | `false` disables OAuth auto-detection; see below |
| `timeout` | Number | no | same default: 5000 ms, for fetching tools |

### `oauth` object fields

| Field | Type | Notes |
|---|---|---|
| `clientId` | String | `{env:...}` substitution is used in the docs' own examples |
| `clientSecret` | String | |
| `scope` | String | space-separated scopes |

`{env:VAR}` substitution is confirmed as an opencode config feature (used throughout the
page's examples).

## Tool naming

The docs state, under "Glob patterns":

> MCP server tools are registered with server name as prefix, so to disable all tools for
> a server simply use: `"mymcpservername_*": false`

This confirms PLAN.md D4's `<server>_<name>` convention is opencode's, and that opencode
server names may themselves contain underscores in practice (`gh_grep` is the page's own
example, which is a `server_tool` pair only by ambiguity). No length limit for names or
tools is documented anywhere on this page.

## Tool enable/disable surface

MCP servers are also addressable through the top-level `tools` object, with glob patterns
(`*` = zero or more chars, `?` = exactly one char, everything else literal).

## Commands

- `opencode mcp auth <server-name>` — start the OAuth flow
- `opencode mcp auth list` — auth status for all OAuth-capable servers
- `opencode mcp list` — list servers and auth status
- `opencode mcp logout <server-name>` — remove stored credentials
- `opencode mcp debug <server-name>` — auth status, HTTP connectivity, OAuth discovery probe

Tokens are stored in `~/.local/share/opencode/mcp-auth.json`.

## Organization defaults

Organizations may publish defaults via a `.well-known/opencode` endpoint; those entries may
be disabled by default and are opted into locally with `"enabled": true`. Local values
override remote defaults.

---

## Differences from PLAN.md §6

| PLAN.md §6 | opencode reality | Impact on the gateway |
|---|---|---|
| `command` documented only for `local` | `local` has `command`, `remote` has `url` | matches §6 |
| `timeout` default `gateway.defaultTimeoutMs` (30000) | opencode default is **5000** and applies to *fetching tools* | decide the gateway's own default; §6's 30000 is a free choice, not an opencode inheritance |
| `cwd` not in §6 | `local` supports `cwd` | consider adding `cwd` to §6 |
| `environment` documented | `local` supports `environment` | matches §6 |
| `oauth` = `false` or object with `clientId`/`clientSecret`/`scope` | identical | matches §6 exactly |
| `mcp.<name>` must match `^[a-z0-9-]{1,24}$` | **no constraint documented** | D4's regex is the gateway's own constraint, not opencode's. Keep it, but the justification is D4's ambiguity rule, not opencode compatibility. |
| `startupTimeoutMs`, `idleTimeoutMs` | not present in opencode | gateway-specific, fine |
| top-level `gateway.*` block, `$schema: ./gateway.schema.json` | no `gateway` block; `$schema` is a remote URL | §6 is a superset; no change needed |
| `--config` / `GATEWAY_CONFIG` / `gateway.json` | opencode uses `opencode.json(c)` with a documented precedence chain | gateway-specific, fine |
| opencode uses Dynamic Client Registration by default | the 2026-07-28 spec **deprecates** DCR in favour of Client ID Metadata Documents | see `docs/OPEN-QUESTIONS.md` Q-AUTH-REG; opencode's behaviour is behind the current spec |