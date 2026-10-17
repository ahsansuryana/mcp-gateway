# Report — global CLI and `.mcp-gateway` config directory

**Branch:** `feat/global-cli-and-config-dir`
**Scope:** ship the gateway as an installable command, and move configuration into a
`.mcp-gateway` directory. `docs/adr/0012-global-cli-and-config-dir.md` holds the decisions;
this file records what was run and what is still unproven.

> **The command in the transcripts below is `mcp-gateway`.** That is what it was called when
> this ran. It was renamed to **`mcp-gate`** the next day (PR #2) because `mcp-gateway`,
> `mcpgate` and `mcpgw` are all taken on npm. The package is still
> `@ahsansuryana/mcp-gateway`; only the command name changed. The transcripts are left as
> they were recorded rather than rewritten, because editing them would make this a false
> record of what the tool printed.

---

## What changed

| Step | Commit | What |
|---|---|---|
| 0 | `e95731f` | Step 0 findings in ADR 0012; four open questions |
| 1 | `68c8d50` | `bin`, `files`, scoped name, shebang, version from `package.json` |
| 2 | `3c5f71e` | `.mcp-gateway` resolution, `init`, token-store 0700 + migration |
| 3 | `59d2dcf` | `GATEWAY_HOME` named volume, compose, example config in the image |
| 4 | `f3f26ff` | 22 tests for resolution, `init`, permissions, migration |
| 5 | `6bf44a6` | The symlink bug acceptance found, plus the acceptance evidence |
| 6 | this | docs |

## Step 5 — commands actually run, with real output

### Build and pack

```
npm run build      -> @ahsansuryana/mcp-gateway@0.1.0 build
npm pack           -> ahsansuryana-mcp-gateway-0.1.0.tgz   (65 files)
```

### Global install in a fresh container, with NOTHING from the repository mounted

```
docker create --name gcli2 -w /tmp node:24-bookworm-slim sleep 1800
docker cp ahsansuryana-mcp-gateway-0.1.0.tgz gcli2:/tmp/pkg.tgz
docker exec gcli2 sh -c 'cd /tmp && npm i -g ./pkg.tgz'

head -1 "$(command -v mcp-gateway)" | cat -A
  #!/usr/bin/env node$          <- LF, no ^M

mcp-gateway --version
  @ahsansuryana/mcp-gateway 0.1.0     rc=0
mcp-gateway --help
  rc=0

mcp-gateway            (no config anywhere)
  configuration is invalid (1 error):
    - <file>: no gateway config found. Checked:
          - /tmp/.mcp-gateway/gateway.json
          - /root/.mcp-gateway/gateway.json
          - /tmp/gateway.json
      Create one with: mcp-gateway init   (or --local for /tmp/.mcp-gateway/gateway.json)
  rc=1        <- and no stack trace

mcp-gateway init
  created /root/.mcp-gateway/gateway.json

stat -c "%a %n" ~/.mcp-gateway ~/.mcp-gateway/gateway.json
  700 /root/.mcp-gateway
  600 /root/.mcp-gateway/gateway.json

head -2 ~/.mcp-gateway/gateway.json
  { "$schema": "https://cdn.jsdelivr.net/npm/@ahsansuryana/mcp-gateway@0.1.0/gateway.schema.json",

docker exec -d -e GATEWAY_API_KEY=global-cli-key -e GITHUB_TOKEN=d -e FOO=f gcli2 mcp-gateway
  healthz            200 {"ok":true}
  /status  Bearer    200
  /status  no auth   401
```

**No `GATEWAY_CONFIG` was set.** The gateway found its config in the volume / home
directory by itself, which is the whole point of the change.

### The project's own image

```
docker build -t mcp-gateway:final .
docker create --name smoke12 -e GATEWAY_API_KEY=ci-smoke-key \
  -e GATEWAY_CONFIG=/app/spikes/smoke/gateway.json mcp-gateway:final serve
docker exec -e GATEWAY_API_KEY=ci-smoke-key smoke12 sh /app/scripts/smoke.sh
  calling: smoke_echo with {"text":"smoke"}
  {"result":{"content":[{"type":"text","text":"smoke-upstream:smoke"}]}}
  SMOKE TEST PASSED        rc=0
```

### Gates

| Gate | Windows (Node 24.18) | Linux arm64 (`node:24-bookworm-slim` **+ procps**) |
|---|---|---|
| `npm run typecheck` | clean | clean |
| `npm run lint` | clean | clean |
| `npm test` | 29 files, **329 passed + 4 skipped** (333) | 29 files, **333 passed, 0 skipped** |
| `npm audit` | 0 vulnerabilities | 0 vulnerabilities |

The 4 skips are the POSIX-only permission assertions. They **ran and passed** on Linux.

`npm run gen:schema` rewrote `gateway.schema.json` and `docs/CONFIG.md`; **neither differs**,
so the committed generated files are not drifting. B-16 stays open — the CI *check* is still
not wired.

### Docker, config in the volume

```
docker run --rm -v gateway-home-test:/home/node -e GATEWAY_API_KEY=k mcp-gateway:s12 init
  created /home/node/.mcp-gateway/gateway.json

docker run --rm -e GATEWAY_API_KEY=… -v gateway-home-test:/home/node mcp-gateway:s12 serve
  "config":"/home/node/.mcp-gateway/gateway.json"      <- with no GATEWAY_CONFIG
  healthz 200, /status 200

stat -c "%a %U:%G %n"
  700 node:node /home/node/.mcp-gateway
  600 node:node /home/node/.mcp-gateway/gateway.json
```

## Three defects found while doing this

**1. The global install silently did nothing.** `npm i -g` installs `bin` as a symlink. Node
resolves symlinks when loading the main module, so `import.meta.url` was the real path while
`process.argv[1]` stayed the symlink path. The entry-point guard compared them directly,
decided it was not being run directly, and the command exited **0 printing nothing**:

```
node /usr/local/lib/node_modules/…/dist/cli.js --version  -> @ahsansuryana/… 0.1.0
/usr/local/bin/mcp-gateway --version                       -> (no output), rc=0
```

Only the acceptance step could have found this — no test in the suite runs the binary
through a symlink. `realpathSync` now resolves it.

**2. The source label was computed from an array index.** `resolveConfigLocation` recovered
which level matched by comparing the path against `candidates[2]` and `candidates[3]`. The
array shifts when a flag or env var is absent, so with an empty env the project candidate sat
at index 1 and was mislabelled. Caught by the unit tests written in Step 4, after Step 2 had
already been committed. Candidates now carry their source as they are built.

**3. `init` inside the image printed a raw Node stack trace**, because
`gateway.example.json` was never copied into the image and `runInit` did not catch the read
error. Both fixed; `init` now returns a status and the CLI prints a sentence.

## Unverified / not done

- **Nothing was published.** `npm publish` was not run, as instructed. Everything above is a
  local tarball.
- **The jsDelivr `$schema` URL 404s until the package is published.** That is expected; the
  path only resolves once the package exists on npm.
- **`npm i -g` without `sudo` is untested on the operator's actual machine** — it depends on
  where npm's global prefix lives there (Q-CLI-4). The tarball install was verified as root in
  a container.
- **The Windows↔Linux bind-mount advice in DEPLOY.md is unchanged** and still correct for the
  remote host (B-29), but the new compose file has **no bind mount at all**, so that section
  is now only relevant to a local daemon.
- **CI has not run on this branch.** The workflow file is unchanged, so the same 4 jobs will
  run on push; the Linux jobs use `ubuntu-latest`, which has `procps` and therefore exercises
  the real tree-kill path.
- **Rotation of `GATEWAY_TOKEN_KEY` is still unsupported** (B-33) and is now slightly more
  consequential: the key guards a store inside a volume that also holds the config.

## Open questions added

| ID | Question |
|---|---|
| Q-CLI-1 | `mcp-gateway` on npm is a third party's package that already claims the same `bin`. Confirm it is unrelated. |
| Q-CLI-2 | `{file:}` is cwd-relative; `parseConfig`'s comment claimed otherwise. Comment fixed, behaviour kept. A change to config-relative would be breaking. |
| Q-CLI-3 | The token store wrote its file 0600 but created the directory under the umask. Now 0700, explicitly. |
| Q-CLI-4 | Whether `npm i -g` works without `sudo` cannot be determined from the repository. |