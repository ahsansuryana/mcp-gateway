# Sprint 1 report — Scaffold and config

- Branch: `sprint-1-scaffold-and-config`
- Date: 2026-10-10
- Scope: PLAN.md §7 Sprint 1 (S1.1 … S1.6)
- Status: **complete, stopped at the gate**

Decisions taken at the Sprint 0 gate and applied here:

- **Q-COMPAT** — `gateway.legacyEra: 'stateless' | 'reject'`, default `'stateless'`, added to
  the config schema in S1.2.
- **D16 / ADR 0001** — Express + `@modelcontextprotocol/express` + `createMcpHandler` /
  `toNodeHandler`. Runtime dependencies installed in S1.1.

---

## 1. Tasks done

| Task | Status | What was produced |
|---|---|---|
| S1.1 Init repo | done | `package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.config.ts`, `.gitignore`, `.editorconfig` |
| S1.2 Config layer | done | `src/config/schema.ts`, `src/config/substitute.ts`, `src/config/load.ts` |
| S1.3 Observability | done | `src/observability/logger.ts`, `src/observability/redact.ts`, `test/unit/redact.test.ts` |
| S1.4 CLI | done | `src/cli.ts` (`validate -c <path>`) |
| S1.5 Example + schema | done | `gateway.example.json`, `gateway.schema.json`, `scripts/gen-schema.ts`, `npm run gen:schema` |
| S1.6 Unit tests | done | `test/unit/{substitute,schema,cli,redact}.test.ts` + 8 invalid fixtures in `test/fixtures/invalid/` |

### Acceptance criteria (PLAN.md §7 Sprint 1)

| Criterion | Result |
|---|---|
| `npm run typecheck && npm run lint && npm test` pass | **met** — 0 / 0 / 48 passed |
| `node dist/cli.js validate -c gateway.example.json` exits 0 with the example env vars set | **met** — exit 0 |
| 8 invalid config fixtures each exit 1 with the expected key path | **met** — 8/8 |

---

## 2. Commands run (with output tails)

### Dependency verification (PLAN.md rule 4 — `npm view` before adding anything)

```
$ for p in typescript vitest eslint typescript-eslint @types/node @types/express pino tsx; do npm view $p version; done
typescript           7.0.2
vitest               5.0.3
eslint               10.12.0
typescript-eslint    8.71.1
@types/node          26.6.5
@types/express       5.0.6
pino                 10.4.0
tsx                  4.23.15

$ npm view typescript-eslint peerDependencies
{ eslint: '^8.57.0 || ^9.0.0 || ^10.0.0', typescript: '>=4.8.4 <6.1.0' }

$ npm view vitest@5.0.3 engines        ->  { node: '^22.12.0 || ^24.0.0 || >=26.0.0' }
$ npm view vitest@4.1.11 engines       ->  { node: '^20.0.0 || ^22.0.0 || >=24.0.0' }
$ npm view eslint@10.12.0 engines      ->  { node: '^20.19.0 || ^22.13.0 || >=24' }
$ npm view typescript@7.0.2 deprecated ->  (empty)
$ npm view typescript@6.0.3 deprecated ->  (empty)
```

Two version conflicts were found and resolved deliberately:

- `typescript@latest` (7.0.2) is **outside** `typescript-eslint`'s peer range
  (`>=4.8.4 <6.1.0`). Pinned **6.0.3**, the newest release inside the range.
- `vitest@latest` (5.0.3) requires Node `^22.12.0`, which would break D1's Node >= 20 floor.
  Pinned **4.1.11**, which supports `^20.0.0`.

The resulting dev-time Node floor is `>=20.19.0` — the intersection of the SDK
(`engines: ">=20"`, confirmed in Sprint 0) and ESLint 10 (`^20.19.0`). Recorded in
`package.json#engines` and `docs/BACKLOG.md` B-17.

```
$ npm install --no-audit --no-fund
added 243 packages in 48s
$ npm audit
found 0 vulnerabilities
$ npx tsc --version && npx vitest --version && npx eslint --version
Version 6.0.3
vitest/4.1.11 win32-x64 node-v24.18.0
v10.12.0
```

### zod v4 JSON Schema API (resolves Q-ZODJSON)

```
$ node -e "const z=require('zod'); console.log('toJSONSchema?', typeof z.toJSONSchema);
           console.log(Object.keys(z).filter(k=>/JSONSchema/i.test(k)))"
toJSONSchema? function
[ 'toJSONSchema', 'fromJSONSchema' ]

$ grep -n "target\?:\|unrepresentable\|io\?:" node_modules/zod/v4/core/to-json-schema.d.cts
29:  target?: "draft-04" | "draft-07" | "draft-2020-12" | "openapi-3.0" | ({} & string) | undefined;
34:  unrepresentable?: "throw" | "any" | UnrepresentableHandler<schemas.$ZodTypes>;
44:  io?: "input" | "output";
```

### Acceptance: typecheck

```
$ npm run typecheck
> mcp-gateway@0.0.0 typecheck
> tsc --noEmit
-> exit 0
```

### Acceptance: lint

```
$ npm run lint
> mcp-gateway@0.0.0 lint
> eslint .
-> exit 0
```

### Acceptance: tests

```
$ npm test
> mcp-gateway@0.0.0 test
> vitest run

 Test Files  4 passed (4)
      Tests  48 passed (48)
   Duration  2.91s
```

### Acceptance: validate the example config

```
$ GATEWAY_API_KEY=GWKEY-0123456789 GITHUB_TOKEN=GHTOK-0123456789 FOO=bar \
    node dist/cli.js validate -c gateway.example.json
OK  F:\mcp-gateway\gateway.example.json
    gateway: 0.0.0.0:3000  legacyEra=stateless  defaultTtlMs=30000
    upstreams: 2
      - github  remote  enabled  api.githubcopilot.com
      - fs  local  enabled  npx
    inbound auth: bearer, 1 key(s)
-> exit 0

$ node dist/cli.js validate -c gateway.example.json      # no env vars set
INVALID  F:\mcp-gateway\gateway.example.json

1 problem(s):
  - gateway.auth.keys.0: environment variable GATEWAY_API_KEY is not set

Hints:
  - set the variable in the environment before validating, or remove the {env:NAME} placeholder
  - namespaced tool names longer than 64 characters are skipped at runtime (D4)
-> exit 1
```

### Acceptance: 8 invalid fixtures

```
01-unknown-top-level-key.json          exit=1  path=<root>
02-bad-upstream-name.json              exit=1  path=mcp.Bad_Name
03-http-remote-url.json                exit=1  path=mcp.github.url
04-empty-command.json                  exit=1  path=mcp.fs.command
05-missing-env-var.json                exit=1  path=gateway.auth.keys.0
06-timeout-out-of-range.json           exit=1  path=mcp.github.timeout
07-unknown-upstream-key.json           exit=1  path=mcp.github
08-invalid-header-name.json            exit=1  path=mcp.github.headers.Bad Header
-> 8/8 fixtures exited 1
```

Example failure output (never contains a value):

```
$ node dist/cli.js validate -c test/fixtures/invalid/02-bad-upstream-name.json
INVALID  F:\mcp-gateway\test\fixtures\invalid\02-bad-upstream-name.json

1 problem(s):
  - mcp.Bad_Name: must match ^[a-z0-9-]{1,24}$ (lowercase, digits, hyphen; no underscore)

Hints:
  - upstream names must match /^[a-z0-9-]{1,24}$/ so <server>_<tool> splits unambiguously
  - namespaced tool names longer than 64 characters are skipped at runtime (D4)
-> exit 1
```

### Schema generation

```
$ npm run gen:schema
> mcp-gateway@0.0.0 gen:schema
> tsx scripts/gen-schema.ts
wrote F:\mcp-gateway\gateway.schema.json

$ head -30 gateway.schema.json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  ...
  "mcp": {
      "type": "object",
      "propertyNames": { "type": "string", "pattern": "^[a-z0-9-]{1,24}$" },
      "additionalProperties": { "oneOf": [ remote, local ] }
  }
}
```

### Audit

```
$ npm audit
found 0 vulnerabilities
```

---

## 3. Deviations from PLAN.md

No fixed decision was changed. Deviations are all either forced by a primary source or
deliberately documented:

1. **`src/index.ts` and the `serve` command were NOT created.** §5 lists
   `src/index.ts` as the serve entrypoint, but S1.1 requires `dev`/`start` scripts and
   rule 7 forbids placeholder code. `dev` -> `tsx src/cli.ts`, `start` ->
   `node dist/cli.js`, and `USAGE` states that `serve` arrives with Sprint 2. Tracked as
   `docs/OPEN-QUESTIONS.md` Q-SERVE-CMD and `docs/BACKLOG.md` B-14.
2. **Node floor is `>=20.19.0`, not `>=20`.** D1 says Node >= 20 "confirm against SDK
   `engines`"; the SDK says `>=20`, but ESLint 10 requires `^20.19.0`. Noted in
   `package.json#engines` and B-17.
3. **typescript 6.0.3 and vitest 4.1.11 instead of `latest`.** Both forced by peer/engine
   constraints; see the commands above.
4. **`gateway.legacyEra` was added to the schema**, which §6 does not list. Explicitly
   approved at the Sprint 0 gate (ADR 0002).
5. **`gateway.publicUrl` is optional in the schema**, whereas §6's example shows it
   unquoted as a plain string and Q4 (hosting target) is still unanswered. Making it
   required would force a placeholder value into `gateway.example.json`.
6. **`{file:path}` resolves against `process.cwd()`.** §6 and D7 do not say what a relative
   path is relative to. `cwd` is the only sensible default and is documented in the code.
7. **Error messages for `{file:...}` never contain the path.** PLAN.md rule 9 says name the
   key path, never the value; a filesystem path can itself be sensitive, so the CLI reports
   `mcp.<x>.headers.Authorization: could not read the referenced file`.
8. **The generated JSON Schema uses `oneOf` for the remote/local union**, not a
   discriminator keyword, because that is what zod v4's `discriminatedUnion` emits. Editors
   still narrow correctly because each branch carries `const` on `type`.
9. **`scripts/` is a new top-level directory** (not in §5's layout) because
   `npm run gen:schema` needs a TypeScript entry point that must not be part of
   `dist/src/`. §5 says "add files only when a task needs them"; S1.5 needed this.

---

## 4. Open questions

`docs/OPEN-QUESTIONS.md` was updated:

- **Q-ZODJSON** — RESOLVED. `z.toJSONSchema` exists; documented with the exact options used.
- **Q-COMPAT** — DECIDED. `gateway.legacyEra` in the schema; the 2025-codec consequences
  remain open for Sprint 2.
- **Q-CORS** — NEW, non-blocking (Sprint 6).
- **Q-SERVE-CMD** — NEW, non-blocking (Sprint 2).

Still blocking later sprints, unchanged: **Q-MRTRPROXY** (S3.5), **Q-SUBSFWD** (S3.4),
**Q-TOOLNAME** (S2.3), **Q-OAUTH-RUN** (S5). Non-blocking: Q-HDRPREC, Q-WINDOWS-ENV,
Q-DEVNAMES, Q-TASKS-EXT.

---

## 5. Risks

| Risk | Severity | Note |
|---|---|---|
| The 2025-era SDK codec drops `resultType`, `ttlMs`, `cacheScope` and MRTR | high | Accepted by the gate decision. Sprint 2's tests must run both eras (B-01). |
| `express.json()` default limit is `'100kb'`, far below the planned 1 MiB | medium | `createMcpHandler`'s own default is 4 MiB. S2.5 must decide which layer owns the limit and write it down (ADR 0001). |
| `createMcpExpressApp` auto-enables DNS-rebinding protection only for localhost binds | medium | `0.0.0.0` needs explicit `allowedHosts`/`allowedOrigins` in S2.5. |
| TypeScript 6.0.3 is not `latest` | low | Forced by `typescript-eslint`'s peer range. Revisit when typescript-eslint widens it. |
| No CI is configured | low | `typecheck`/`lint`/`test` are scripted; wiring them into a runner belongs to S7.4. |
| `gateway.schema.json` can drift from `src/config/schema.ts` | low | Regenerate is one command; CI drift check is B-16. |
| Config substitution deep-copies objects | low | Callers must not rely on identity after `substitute()` (B-18). |

---

## 6. Tests that found real bugs

Worth recording, because they are the reason the suite exists:

1. **IPv6 localhost was rejected.** `new URL('http://[::1]:3000/mcp').hostname` is `"[::1]"`
   **with brackets**, but `LOCAL_HOSTS` contained `::1`. Every `http://[::1]` upstream would
   have failed validation. Fixed in `src/config/schema.ts`.
2. **pino's key-based redaction does not cover the message string or `err.message`.** The
   first version of `redact.test.ts` failed on exactly that. Fixed with a
   `hooks.logMethod` value-scrubbing pass (verified:
   <https://getpino.io/#/docs/api#logmethod>), which required registering known secret
   VALUES at logger construction — see `secretsFromConfig`.
3. **The CLI entrypoint guard was a no-op on Windows.** `import.meta.url` is
   `file:///F:/...` (three slashes) while a hand-built `file://${argv[1]}` string has two, so
   `node dist/cli.js validate ...` exited 0 and printed nothing. Fixed with
   `pathToFileURL(process.argv[1]).href` (verified: <https://nodejs.org/api/url.html#urlpathtofileurlpath-options>).
4. **Record-key validation errors lost their message.** zod reports `"Invalid key in
   record"` on the outer issue and keeps the real reason in `issue.issues[0].message`.
   `load.ts` now unwraps it, so the user sees the actual D4 rule instead of a generic
   string.
5. **A cross-platform assertion was wrong, not the code.** `path.resolve` on Windows emits
   backslashes, so `endsWith('secrets/token.txt')` failed. The test now normalises
   separators, as D15 requires the suite to pass on Windows and Linux.

---

## 7. Commits

```
852c42a feat(config): S1.5 example config and generated gateway.schema.json
29ce631 feat(cli): S1.4 validate command with secret-free error output
bc43ffb style(observability): S1.3 drop redundant type assertions
596795c feat(observability): S1.3 pino logger with D14 redaction and secret-scrubbing hook
7eb998c test(config): S1.6 unit tests, 8 invalid fixtures and canary-secret assertions
8c0519b feat(config): S1.2 zod schema, {env}/{file} substitution and JSONC loader
4262a69 chore: S1.1 init repo with TS/ESLint/vitest toolchain and SDK v2 deps
```