# Claude / claude.ai limits relevant to the gateway

Sprint 0 task S0.6. Fetched 2026-10-10. These are the client-side constraints the gateway
has to live with; they are **not** MCP spec facts.

## Tool name length

| Source | Stated limit |
|---|---|
| <https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools> | `name` "Must match the regex `^[a-zA-Z0-9_-]{1,128}$`" |
| <https://docs.anthropic.com/en/docs/build-with-claude/tool-use/implement-tool-use> | `^[a-zA-Z0-9_-]{1,64}$` |
| <https://claude.com/docs/connectors/building> | not documented |
| <https://platform.claude.com/docs/en/agents-and-tools/mcp-connector> | not documented |

Prose says 128 on the current page. Enforcement says 64 — see real 400s:

- <https://github.com/anthropics/claude-code/issues/3102> —
  `tools.17.custom.name: String should have at most 64 characters`
- <https://github.com/anthropics/claude-code/issues/20830> —
  `messages.63.content.0.tool_result.content.0.tool_reference.tool_name: String should have at most 64 characters`
- <https://github.com/anthropics/claude-code/issues/21050> — claude.ai MCP connectors with
  UUID server ids produce 72-character names and 400.

**Conclusion: PLAN.md D4's 64 stands** (kept conservative because 64 is what is actually
enforced). Tracked as `Q-TOOLNAME` in `docs/OPEN-QUESTIONS.md`.

## Character set

`^[a-zA-Z0-9_-]{1,64}$` — letters, digits, underscore, hyphen. PLAN.md D4's server-name
regex `^[a-z0-9-]{1,24}$` (no underscore, no uppercase) is a strict subset, so D4's
`<server>_<name>` convention is safe under this constraint.

## claude.ai connector constraints (<https://claude.com/docs/connectors/building>)

| Limit | claude.ai / Desktop | Claude Code |
|---|---|---|
| Maximum tool result size | ~150,000 characters | 25,000 tokens, configurable with `MAX_MCP_OUTPUT_TOKENS` |
| Tool call timeout | 240 seconds per tool call | configurable with `MCP_TOOL_TIMEOUT` |

Other facts from the same page:

- Supported: tools, prompts, resources; text and image tool results; text and binary
  resources.
- **Not supported by Claude: resource subscriptions, sampling, advanced/draft
  capabilities.** So `subscriptions/listen` fan-out (S3.4) has no consumer on claude.ai.
  Claude Code may still use it.
- Transport: Streamable HTTP recommended; legacy HTTP+SSE still supported by Claude but
  deprecated by the spec.
- Claude follows the **2025-03-26 / 2025-06-18 / 2025-11-25 authorization specs**, uses
  Dynamic Client Registration, redirect URI `https://claude.ai/api/mcp/auth_callback`, and
  a loopback redirect for Claude Code.

Custom-connector header rules (<https://claude.com/docs/connectors/custom/remote-mcp>):

- Header names come from a fixed allowlist (`authorization`, `x-api-key`, `x-auth-token`,
  …). Arbitrary header names are refused.
- Maximum **four** headers per connector.
- On an OAuth connection you cannot configure `Authorization` as a request header.

Implication for the gateway: a user connecting the gateway to claude.ai cannot add arbitrary
routing headers. The gateway's inbound auth must therefore be the bearer key carried in
`Authorization` (D9), which is on the allowlist.

## MCP connector (Messages API, beta)

<https://platform.claude.com/docs/en/agents-and-tools/mcp-connector>, beta header
`mcp-client-2025-11-20` (or `mcp-client-2026-09-15` for a pinned tool list):

- `mcp_servers[].url` **must** start with `https://`.
- `mcp_servers[].name` has no documented regex or length limit.
- Auth is `authorization_token` (an access token the caller already holds). The API is
  **not** an interactive OAuth client.
- Only **tool calls** are supported; no prompts, resources, or subscriptions.
- Tool names are used as the server lists them, without the server-name prefix.

## What this means for the gateway

1. Keep D4 at 64 chars.
2. `POST /mcp` must be reachable over plain HTTPS at a stable public URL — that is
   PLAN.md Q4, still unanswered, and it is now a hard requirement rather than a nicety.
3. Do not build inbound OAuth assuming claude.ai will drive it; Claude's connector client
   sends `authorization_token` to the Messages API, and for a *custom connector* it does
   run OAuth against the resource server (Sprint 6). Both paths need the SDK's
   `requireBearerAuth` / `mcpAuthMetadataRouter` shape.
4. Tool results must stay under ~150,000 characters when the gateway is consumed from
   claude.ai. Worth a `maxToolResultChars` note in the backlog.
5. `subscriptions/listen` fan-out targets Claude Code / the Inspector / other MCP-native
   clients — not claude.ai.