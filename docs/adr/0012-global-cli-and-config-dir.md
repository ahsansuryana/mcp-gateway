# ADR 0012 — Global CLI, and configuration in `.mcp-gateway`

- Status: **Accepted**
- Date: 2026-10-12
- Branch: `feat/global-cli-and-config-dir`
- Supersedes nothing. **Amends D6** (PLAN.md §4), which fixed the default config path as
  `./gateway.json`; PLAN.md rule 5 requires an ADR to change a fixed decision, and this is it.

---

## Step 0 — findings, recorded BEFORE any code was written

Everything below was read out of the repository on 2026-10-12. Nothing here is inferred.

### `package.json`

| Field | Value | Consequence |
|---|---|---|
| `name` | `mcp-gateway` | **TAKEN on npm** — see below |
| `version` | `0.0.0` | `--version` hardcodes it; must read it instead |
| `private` | `true` | must be removed for a global install to be meaningful |
| `bin` | **absent** | no CLI entry point at all |
| `files` | **absent** | `npm pack` currently ships everything not gitignored |
| `engines.node` | `>=20.19.0` | already matches the task requirement |
| `prepublishOnly` | **absent** | must be added |

`npm view mcp-gateway` returns **`mcp-gateway@1.0.0`**, owned by someone else, and it already
declares `bin: mcp-gateway`. `npm view @ahsansuryana/mcp-gateway` returns **404**. So the
package name becomes the scoped one, and only the `bin` stays `mcp-gateway`.

### `tsconfig.build.json`

`rootDir: src`, `outDir: dist`, `noEmit: false`, includes `src/**/*.ts`, excludes
`node_modules dist spikes test scripts`. **A shebang in `src/cli.ts` is emitted verbatim**,
so `dist/cli.js` keeps it — but only if the file is stored with LF. It currently is not
guaranteed: `.gitattributes` has `*.ts text`, which normalises to the platform's native
endings, and development happens on Windows.

### `.gitattributes`

`*.sh text eol=lf` already exists. `*.ts text` does **not** pin LF.

### `.gitignore`

Already anchored from the CI fix: `/gateway.json` and `/data/`. `.mcp-gateway/` is not
listed yet.

### `src/cli.ts`

- Commands: `serve` (default when no args), `validate`, `help`, `--version`, `--help`, `-h`.
  A leading `-` with no command word is also the default serve.
- `parseConfigFlag` handles `-c <path>`, `--config <path>`, `--config=<path>`.
- Exit codes: `EXIT_OK 0`, `EXIT_INVALID 1`, `EXIT_USAGE 2`.
- `--version` returns a **hardcoded** `'mcp-gateway 0.0.0'`, not the package version.
- `USAGE` claims the config default is `$GATEWAY_CONFIG or ./gateway.json`.
- The entry point rewrites `process.argv` before calling `main({ configPath })`.

### Config path resolution today — `src/config/load.ts`

```
resolveConfigPath(explicit?, env):
  explicit (from -c)        -> resolve(cwd, explicit)
  env GATEWAY_CONFIG         -> resolve(cwd, fromEnv)
  otherwise                 -> resolve(cwd, 'gateway.json')
```

Both explicit and env paths are resolved against **`process.cwd()`**, not the home directory.
`DEFAULT_CONFIG_FILENAME = 'gateway.json'`, `CONFIG_PATH_ENV_VAR = 'GATEWAY_CONFIG'`.

### `{file:}` substitution — **cwd-relative, and the code comment is wrong**

`src/config/substitute.ts` line 93 resolves with `resolvePath(process.cwd(), trimmed)`.
`parseConfig` calls `substitute(parsed, options)` and **does not pass `sourcePath`**, even
though its own doc comment says:

> `sourcePath` is only used to label errors **and to resolve relative `{file:...}` paths**.

That second clause is false. The behaviour is cwd-relative. Per the task, this is **kept as
is** and the comment corrected. Moving config files must therefore never be assumed to move
`{file:}` paths with them — this is the single most important operational consequence of
relocating the config file.

Also: `readFileSync(absolutePath, 'utf8')` with **no trimming**, so a trailing newline in a
secret file becomes part of the secret. Measured during the previous task: 200 without the
newline, 401 with it.

### Hot reload — `src/server/reload.ts`

Watches `this.#options.path`, which `startGateway` fills from the path `loadConfig` resolved.
**It is not hardcoded**, so it already follows any new resolution order for free.

### OAuth token store — `src/index.ts` + `src/auth/oauth-client/token-store.ts`

```
configured = options.tokenStorePath ?? process.env['GATEWAY_TOKEN_STORE']
storePath  = configured ? resolve(configured)
                        : join(dirname(configPath), 'data', 'tokens.enc.json')
```

So the default is **already anchored to the config file's directory**, in a `data/`
subdirectory, and it is overridable two ways. `TokenStore` creates its directory with
`mkdir(recursive: true)` (**no explicit mode**) and writes through a temp file with
`mode: 0o600` plus an explicit `chmod` where the platform allows it.

Two gaps this task must close: the directory is created without a `0700` mode, and there is
**no migration path** from an existing store at the old location.

### Docker

- `Dockerfile`: multi-stage, `procps` + `ca-certificates` installed (ADR 0010), runs as
  `USER node`, `WORKDIR /app`, `ENTRYPOINT ["node","dist/cli.js"]`, `CMD ["serve"]`,
  `HEALTHCHECK` on `/healthz`, `mkdir -p /app/data && chown -R node:node /app`.
- `docker-compose.example.yml`: named volume `gateway-data:/app/data`, ports bound to
  `127.0.0.1`, `read_only: true`, `stop_grace_period: 30s`. **No bind mount of the config.**
- `scripts/smoke.sh`: reads `GATEWAY_URL` and `GATEWAY_API_KEY` from the environment and is
  `docker exec`-ed into a running gateway. It must keep working unchanged.

### Docs and gates

- `PLAN.md` rule 3: unknown ⇒ `docs/OPEN-QUESTIONS.md`, never guess.
- `PLAN.md` rule 5: changing a fixed decision requires an ADR.
- `PLAN.md` rule 10: one commit per task ID, Conventional Commits, `gateway.example.json` only.
- ADR 0010: `procps` must stay in the image; process-tree kill depends on it.
- B-29: the Docker host is **remote**; Windows paths cannot be bind-mounted.

### Strict schema

`gatewayConfigSchema` is a `z.strictObject` that **explicitly accepts** `$schema` as an
optional string (line 187). So the generated file may carry a `$schema` key.

---

## Decisions

### D1 — package name is scoped; the command is not

`"name": "@ahsansuryana/mcp-gateway"`, `"bin": { "mcp-gateway": "dist/cli.js" }`,
`publishConfig.access: "public"`. The unscoped name is owned by a third party and publishing
it is not an option.

### D2 — config resolution order

First hit wins, and **each candidate is tested for existence**:

1. `-c <path>` / `--config <path>`
2. env `GATEWAY_CONFIG`
3. `./.mcp-gateway/gateway.json`
4. `$GATEWAY_HOME or os.homedir()` + `/.mcp-gateway/gateway.json`
5. `./gateway.json` — legacy, works, warns once

**`~` is never expanded.** Node does not expand it, and `resolve()` would treat a literal
`~/x` as a directory named `~` under the cwd. A path beginning with `~` is rejected by
`init` rather than silently producing a strange directory.

When nothing is found: exit `2`, no stack trace, and the message lists **every path that was
checked** and mentions `mcp-gateway init`.

### D3 — state lives beside the config, with a migration warning

The token store keeps its existing rule — `dirname(config)/data/tokens.enc.json`, overridable
by `GATEWAY_TOKEN_STORE` — because the config directory now *is* the per-installation state
directory. What is added:

- the directory is created with mode **0700**, files stay **0600** (POSIX-only, tested the
  same way the existing chmod test is);
- if a store exists at the **legacy** `<configDir>/../data/tokens.enc.json` and not at the new
  location, the old one is still read and a warning names both paths. Silently orphaning a
  user's stored upstream tokens would force a re-consent they never asked for.

### D4 — `{file:}` semantics do not change

Stays **cwd-relative**; only the false doc comment is corrected. Changing it would silently
break every existing deployment that relies on cwd-relative `{file:}` paths, and it is
outside this task's scope.

### D5 — Docker keeps `node dist/cli.js`

Not a global install in the image. The entrypoint is already correct, `scripts/smoke.sh`
depends on `dist/` at `/app`, and a global install would duplicate the tree for no benefit.
The config directory is a **named volume mounted at `/home/node`**, with `GATEWAY_HOME=/home/node`
so `os.homedir()` resolves there and the CLI's own default works unmodified inside the
container.

### Trade-offs accepted

- Five resolution levels is more than most CLIs need; levels 1–2 exist because they already
  exist, and level 5 exists so nobody is broken by this change.
- `$GATEWAY_HOME` mirrors `HOME` rather than being invented, so a container can relocate the
  whole state directory by changing one variable.
- Checking existence at each level means a `-c` pointing at a missing file falls through to
  the next candidate rather than erroring. That is surprising for an explicit flag, so `-c`
  is treated as authoritative when supplied: it is used as given and a missing file is a
  hard error.