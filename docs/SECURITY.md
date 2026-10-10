# Security

Threat model, the security decisions this gateway makes, and the operator duties that
follow from them. Section references point at `PLAN.md`.

## The core warning: gateway config is code

`mcp` entries of type `local` name a command and arguments that the gateway spawns as a
child process on the host it runs on.

**Anyone who can edit the gateway configuration can run arbitrary commands on the
gateway host, with the gateway process's own privileges and environment.**

This is not a defect to be engineered away — a stdio MCP server is a program the operator
chose to run — but it must be stated plainly, because it is the single largest security
boundary in this project:

- The config file is a **trust boundary**, not configuration data. Treat write access to
  it exactly like write access to the service's code.
- `command` and `args` are executed with **no shell parsing**, but that is not a
  sandbox. `["sh", "-c", "curl … | sh"]` is a perfectly valid entry.
- A local upstream runs with the **same OS user** as the gateway. It is not confined, not
  namespaced, and not resource-limited by the gateway.
- Only operators who can supply trusted config should be able to run the gateway.

Restrict config file permissions accordingly. A local stdio upstream is a deliberate code
execution decision, and it should be reviewed with the same care as adding a dependency.

### Mitigating factors actually implemented

- `command` is spawned via `cross-spawn` with `shell: false`
  (verified: `node_modules/@modelcontextprotocol/client/dist/stdio.mjs`), so no implicit
  shell expansion is introduced by the gateway.
- Secrets in the child's environment are withheld (D13, below).
- A `local` upstream receives exactly the commands the config names — no argument
  interpolation from request data.

## D13 — environment isolation

A local upstream does **not** inherit `process.env`. It receives:

1. the MCP SDK's default environment allowlist (`getDefaultEnvironment()` — verified in
   `node_modules/@modelcontextprotocol/client/dist/stdio.mjs`), plus
2. the keys explicitly listed in that upstream's `environment` config block.

The gateway's own secrets (bearer keys, OAuth client secrets, encryption keys) are
therefore not visible to a child process unless an operator deliberately forwards them.

Verified in tests:

- `test/unit/stdio-upstream.test.ts` asserts a canary present in the gateway's own
  environment is absent from the child by both presence and value, while a configured
  value is still delivered.
- `scripts/s4-7-stdio-transcript.ts` repeats the check against a **vendor** server
  (`@modelcontextprotocol/server-everything`), whose `get-env` tool reports the canary
  absent. See `spikes/out-s4-7.txt`.

Two honest caveats:

- On Windows the SDK's allowlist includes `LOGONSERVER` and `USERDOMAIN`, which Windows
  supplies outside any allowlist (tracked as Q-WINDOWS-ENV in `docs/OPEN-QUESTIONS.md`).
  The guarantee is "no gateway secret is forwarded", not "the environment is a strict
  subset of an allowlist".
- Values substituted into `environment` come from `{env:VAR}` references in the config
  file (D7). Forwarding a secret is therefore an explicit, reviewable act.

## D14 — logging and redaction

Logs are structured JSON (pino). The redaction list covers `authorization`, `headers`,
`environment`, `token`, `apiKey`, `secret`, `password`, `cookie`, and known secret values
are additionally scrubbed from every message.

Guarantees relied on elsewhere:

- `/status` and `reports()` expose upstream names, kinds, states and error summaries only.
- Error text from a failed upstream is truncated and passed through the same secret
  scrub, so a spawn or transport failure cannot echo a credential into the log.
- Upstream stderr (S4.4) is line-buffered, truncated to 2 KiB per line, redacted, and
  logged with the `upstream` field. A child cannot flood the log with an unbounded line.

## Downstream authentication

Every gateway route is protected by a bearer key (`gateway.auth`). `/status` is not a
free-floating health endpoint; see `docs/reports/sprint-1.md`.

**Origin handling remains open.** Until `gateway.publicUrl` is configured, the gateway
accepts localhost origins only (Q4 in `docs/OPEN-QUESTIONS.md`). A public deployment must
set `publicUrl` before binding to a non-loopback interface.

## Upstream trust

Remote upstreams are contacted over Streamable HTTP with the TLS verification the Node
runtime performs by default. There is deliberately **no** HTTP+SSE fallback (ADR 0004):
an SSE-only upstream is a configuration error, reported as such, rather than a silent
downgrade of transport security.

## Process lifetime and shutdown

- SIGINT/SIGTERM starts a graceful stop with a 5 s ceiling
  (`SHUTDOWN_GRACE_MS`, `src/index.ts`).
- If the ceiling is exceeded, child process trees are force-killed so an unresponsive
  upstream cannot outlive the gateway.
- A second signal skips the wait entirely.
- The SDK's own `close()` terminates only the **direct** child. For wrapper-style commands
  (`npx`, `uvx`) that leaves grandchildren, so the gateway kills the tree.

**Operational note:** on Linux, killing a process tree requires `ps` (package `procps`).
Without it the gateway degrades to killing the direct child and logs
`process tree kill degraded to direct child` at `warn`. Minimal container images such as
`node:24-bookworm-slim` do not ship `procps`; install it if your stdio upstreams spawn
grandchildren.

## Known spec deviations

### Tokens obtained for upstreams are not audience-bound

The MCP authorization spec requires an OAuth client to send the RFC 8707 `resource`
parameter in **both** the authorization request and the token request, and to send it
"regardless of whether authorization servers support it"
(verified: `docs/ref/spec-2026-07-28-basic-authorization-index.md` lines 219-222, 254).

`@modelcontextprotocol/client` 2.3.1 does **not** send it. Measured, not assumed: see
`test/integration/oauth-flow.integration.test.ts`, "S5.6 resource parameter — SDK
DEVIATION, recorded", which asserts the observed absence so it fails loudly if the SDK
changes.

**What this means concretely.** An access token the gateway obtains from an upstream's
authorization server carries no cryptographic binding to *which* upstream it was minted for.
RFC 8707 exists precisely to prevent a token issued for one resource from being replayed at
another. The gateway does not hand a token to a different upstream on its own, but the
protection is delegated to the authorization server rather than enforced by us, and a
server that *requires* `resource` will reject us outright.

Policy: ship without the parameter, do not hand-roll around the SDK, and file upstream.
See `docs/adr/0008-rfc8707-resource-parameter-interim.md` and the draft issue at
`docs/ref/sdk-issue-resource-parameter.md`.

## Failures that must not leak

- A broken upstream never takes down the gateway (D8). Its tools are dropped from the
  aggregate and the reason is reported in `/status`.
- A tool call that fails upstream-side returns an `isError` **tool result**, not a
  JSON-RPC error, so a client cannot be tricked into treating a failure as a protocol
  violation (D12).
- Gateway-owned files that will hold credentials (OAuth token store) are specified in
  Sprint 5 with 0600 mode and atomic writes; they are not yet implemented.

## Reporting a vulnerability

This project is not yet published to a security contact. Until it is, open an issue in
the repository describing the concern.