# Sprint 4 — Local stdio upstreams

**Status:** complete.
**Branch:** `sprint-4-stdio`
**Tests:** 135 passed / 12 files — on Windows (local) **and** Linux (`node:24-bookworm-slim`
on Docker). `typecheck` 0, `lint` 0, `npm audit` 0 on both.

## Commits

| Commit | Task |
| --- | --- |
| `8d44729` | S4.1 / S4.3 / S4.4 — `StdioUpstream`, lazy start, idle shutdown, stderr capture |
| `3c9f81c` | S4.1 / S4.3 — four defects found by the new suite |
| `026eb4b` | S4.6 — fake stdio server + unit and integration suites |
| `065b97f` | S4.5 — graceful shutdown, process-tree kill |
| `25f436b` | test harness — port allocation flake |
| `a711dca` | S4.7 — transcript against a real public stdio server |
| `f1df9f6` | S4.5 — graceful degradation when `procps` is missing |
| `1c954f5` | S4.8 — `docs/SECURITY.md` |
| `235bb61` | Q-PROCPS recorded in open questions |

## Task results

### S4.1 `StdioUpstream`
Same `Upstream` contract as `RemoteUpstream`, backed by the SDK's `StdioClientTransport`.
`command[0]` goes through the same resolution path a remote operator would use, including
the Windows `cross-spawn` → `comspec` shim. Verified on both platforms.

### S4.2 Environment (D13)
Child environment is the SDK allowlist plus the configured `environment` keys — never
`process.env`. Asserted with a canary that exists in the gateway's own environment and is
absent from the child by both presence and value.

### S4.3 Lifecycle
Lazy start on first use, `startupTimeoutMs`, idle shutdown, crash detection, backoff
1s..30s, `failed` after 5 consecutive failures, retry at most once per 30s.

### S4.4 stderr
Line-buffered, truncated to 2 KiB, redacted, logged with `upstream`.

### S4.5 Shutdown
SIGINT/SIGTERM, 5s ceiling, then force-kill of the process tree. Verified on Windows that
a **grandchild** process is actually terminated, not just the child the SDK tracks.

### S4.6 Tests
Fake stdio server as a real child process: normal call, crash then recovery, idle shutdown
with an injected timer, startup timeout, env isolation, stderr redaction and truncation.

### S4.7 Real public server
`@modelcontextprotocol/server-everything@2026.8.31` (checked with `npm view`, not assumed)
runs through the production `StdioUpstream`. Transcript: **`spikes/out-s4-7.txt`**.

- 14 tools listed, `echo` and `get-sum` round-trip.
- The server speaks the current protocol revision, so **no ADR was required**.
- `get-env` confirms D13 against a vendor implementation.

### S4.8
`docs/SECURITY.md`.

## Defects found and fixed

These were real bugs, not test-harness problems.

1. **`StdioUpstream` threw on construction.** `#status` was a class field initialiser
   calling `this.#clock()`, which runs *before* the constructor body assigns `#options`.
   Every instantiation failed with `Cannot read properties of undefined (reading 'now')`.

2. **Configured environment was silently dropped.** `env` was only passed to the transport
   when `options.secrets` was defined, so operator configuration vanished otherwise.

3. **Lazy upstreams never started.** `UpstreamManager.#ensureStarted` returned early on
   `state === 'disabled'`, which is precisely a lazy upstream's initial state.

4. **Mid-session crashes were invisible.** The manager never subscribed to upstream status
   changes, so a child that exited while idle produced no status event, no backoff, and no
   escalation to `failed`. `onStatusChange` is now part of the `Upstream` contract.

5. **Spawn failure could not be distinguished from a crash.** Both surface as
   `SdkError(CONNECTION_CLOSED)` (verified on Windows for a missing binary), so message
   sniffing was removed rather than left in place; the manager escalates by repetition.

6. **`tree-kill` crashes on minimal Linux images.** It shells out to `ps` (procps); on
   `node:24-bookworm-slim` this raised `spawn ps ENOENT` from inside the dependency's own
   error handler, where a `try/catch` cannot intercept it. Now probed once, degrading to a
   direct-child kill with an explicit `warn`.

7. **E2E port flake.** `unusedPort()` closed its probe before the caller bound, and the OS
   may re-assign a released port; with 12 suites this intermittently failed a `beforeAll`
   and skipped whole files that then passed in isolation.

## Deviations and limitations

- **`getenv`-style strictness is not claimed.** The guarantee is "no gateway secret is
  forwarded". Windows supplies `LOGONSERVER`/`USERDOMAIN` outside any allowlist
  (Q-WINDOWS-ENV).
- **`trigger-elicitation-request` returns `-32601 Method not found`** against the vendor
  server even though the tool is advertised — the server refuses a client that has not
  declared elicitation support. This is live evidence for the static-vs-per-request
  capability question in ADR 0003 and is recorded, not worked around.
- **A missing binary is `error`, not `failed`, on first start.** By design: `failed` is
  reached by repetition (S4.3), because the SDK gives no signal to distinguish it from a
  crash.
- **Commit `8d44729` bundles S4.1/S4.3/S4.4** in one commit rather than one per task ID,
  as it was written before the test suite existed to define the seams. Subsequent work is
  split per task.

## Verification commands

```
npm run typecheck
npm run lint
npx vitest run
npm audit
npx tsx scripts/s4-7-stdio-transcript.ts   # writes spikes/out-s4-7.txt
```

Linux run: source copied into a `node:24-bookworm-slim` container (the Docker daemon is a
remote Linux host and cannot bind-mount a Windows drive).

## Not done / carried forward

- B-24 partial `honoredFilter` deserves a final integrity pass: `#honored` does not remove
  an upstream's contribution when its subscription closes, and prompts/resources
  `listChanged` may be advertised without being relayed. Both predate Sprint 4 and did not
  block it.
- Q-CORS, Q-HDRPREC, Q4 (public `Origin`) remain open.
- No Sprint 5 work started.