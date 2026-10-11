# ADR 0010 — Linux process-tree kill in the shipped image: install `procps`

- Status: **Accepted** — decided by measurement, not preference
- Date: 2026-10-10 (Sprint 7, S7.4)
- Closes: `docs/BACKLOG.md` **B-28** (Sprint 4 finding, escalated to Sprint 7)

## Context

PLAN.md B-28 required choosing, **with evidence from the real image**, between:

- **(a)** installing `procps` in the image, or
- **(b)** replacing the `ps`-based tree kill with a process-group (`setsid` / negative-PID)
  approach on Linux.

The reason this needs deciding rather than defaulting: `tree-kill@1.2.2` builds a POSIX
process tree by shelling out to `ps --ppid`. `ps` lives in `procps`, which is **absent from
`node:24-bookworm-slim`** (verified: `command -v ps` returns nothing in the stock image).

Sprint 4 hit this on Linux: `spawn ps ENOENT`, raised from inside `tree-kill`'s own
`ChildProcess` error handler. That location matters — a `try/catch` around the `treeKill()`
call cannot intercept it, so it escapes as an uncaught exception during shutdown. The
gateway now probes for `ps` and degrades to a direct-child `SIGKILL` with a `warn`
(`src/upstream/process-tree.ts`), but that means grandchildren of `npx`/`uvx`-style
wrappers survive a forced shutdown.

## Measurement in the real image

Docker host: **Armbian 25.5.1, linux/arm64**, Docker Engine 28.3.2 (remote host; the source
is sent as build context because a Windows drive cannot be bind-mounted).

Probe: `spikes/verify-tree-kill-in-image.mjs`. It spawns a child that spawns a grandchild,
prints the grandchild's pid on a **pipe**, calls `treeKill(childPid, 'SIGKILL')`, waits, and
reports whether either pid is still alive. Exit 0 only if both are gone.

### WITH procps — `mcp-gateway:s7` (the image this ADR ships)

```
platform      : linux arm64
ps available  : true
child pid     : 255 alive: true
grandchild pid: 263 alive: true
treeKill      : no error
after kill -> child alive     : false
after kill -> grandchild alive: false
EXIT=0
```

The whole tree is terminated. `ps` resolves to `/usr/bin/ps`, procps-ng 4.0.2.

### WITHOUT procps — stock `node:24-bookworm-slim`, same probe

```
ps available  : false
Error: spawn ps ENOENT
  syscall: 'spawn ps',
```

The failure is reproduced exactly as Sprint 4 recorded, and it is fatal to the process
rather than a returned error.

### Note on the probe's own history

The first version of the probe reported `ps available: true` in BOTH images, because it
checked `spawn('ps', ...).spawnfile !== undefined` — a property that exists on the returned
`ChildProcess` whether or not the binary exists. It now uses `spawnSync(...).status === 0`
and the absence check. Recorded because an earlier draft of this evidence was misleading.

## Decision

**(a) Install `procps` in the runtime image.**

The Dockerfile installs `procps` alongside `ca-certificates` with
`--no-install-recommends`, and the runtime image is the only stage that needs it.

### Why not (b), the process-group approach

- `setsid` puts a child in a **new** session and process group. A stdio upstream spawned via
  `StdioClientTransport` is NOT started with `setsid`, so there is no group to signal:
  achieving it means wrapping every spawn, which means not using the SDK transport's spawn.
- Even with a group, the kill is `kill(-pgid)`, which still leaves anything that called
  `setsid` itself outside the group — the same class of escape `tree-kill` does not solve
  either.
- (b) is a **larger change with more ways to fail**, taken to avoid one `apt-get install`
  line. That is the wrong trade for a documented runtime dependency.

### Costs accepted

- The image grows by the size of `procps`. Measured as part of the image build, not
  estimated.
- A dependency that must be kept current. `apt-get` is run in the build with
  `rm -rf /var/lib/apt/lists/*`, so no package index ships in the image.

### Consequence for the runtime code

`src/upstream/process-tree.ts` keeps its `ps` probe and its graceful degradation. That
degradation is now a **defence in depth** for images built some other way, not the normal
path: the shipped image has `ps`, so a forced shutdown terminates the whole tree.

## Verification

Both cases were run on the real host, in real images, with the same probe. Neither result is
inferred from documentation.

`docs/reports/sprint-7.md` records the exact commands and their tails.

## Related

- `docs/BACKLOG.md` B-28.
- `docs/reports/sprint-4.md` — the original finding.
- `src/upstream/process-tree.ts` — the probe and degradation.
- `Dockerfile`.