# Report — zero-config startup (ADR 0013)

Branch `feat/zero-config-startup`, from `main` at `4599939`.

Five commits, one per step, each independently green:

| Commit | What |
|---|---|
| `2b14768` | JSON logs → stderr, reserving stdout for the banner |
| `6b31cba` | `--hostname`, `--port`, `--public-url` runtime overrides |
| `4c0d3a2` | Vite-style startup banner with real, reachable URLs |
| `b9dfe33` | Optional inbound key, refused unless the bind is loopback |
| `c388ce8` | Auto-create a starter config when none exists |

Plus this documentation commit.

## Test growth

| | before | after |
|---|---|---|
| Files | 29 | 33 |
| Passing | 329 | 412 |
| Skipped | 4 (POSIX-only) | 5 |

The suite was run three times in a row at the end: **412 passed, 5 skipped, every time.**
One `oauth-routes.e2e` failure appeared once during development and did not reproduce in
three subsequent runs or in isolation — treated as a flake, not a regression, and not
papered over by a retry.

## What was verified, and how

Measured against the built binary, not asserted from reading the code.

**The streams are actually separate.** `stdout -> 0 bytes`, `stderr -> JSON`, with a real
gateway running and the two redirected to different files.

**The flags reach the listener.**

```
file config   : 127.0.0.1:3000  publicUrl=(none)
effective     : 0.0.0.0:3777    publicUrl=https://tunnel.example
http://192.168.1.7:3777/healthz -> HTTP 200
gateway.json after the run      -> unchanged
```

**Every printed URL answers.** With `--hostname 0.0.0.0`, all four URLs on the banner were
requested; none returned `000`. (A `404` on `GET /mcp` is correct — the endpoint is POST-only
— and means the server answered.)

**Both sides of the key rule.** `serve --hostname 0.0.0.0` with no key → exit 1, naming
`gateway.auth.keys` and `--hostname 127.0.0.1`. Bound to loopback → it starts, the banner
says `auth NONE — POST /mcp accepts any caller`, `/status` reports `authMode: "open"`, and a
`warn` line lands in stderr.

**Auto-create, across three runs against a fresh `GATEWAY_HOME`:**

```
run 1 (nothing exists) -> "(just created)" + key shown;
                          key authenticates (200), wrong key 401, no key 401
run 2 (same home)     -> no "(just created)", key NOT shown again, file unchanged
run 3 (same home)     -> run 1's key still authenticates (200)
```

**Auto-create does not fire where it must not.** `-c ./tidak-ada.json` → exit 1, "could not
read", nothing written. `validate` with no config → exit 1, every checked path listed,
nothing written.

## Four things found by running rather than reading

Each would have shipped.

1. **`serve --port 0` answered `unknown option: serve`** and exited 2 — the command word
   reached the flag parser. No unit test caught it.
2. **The banner printed dead IPv6 URLs.** `listen(port, '0.0.0.0')` reaches `bind(2)` as
   `AF_INET`, so the listener accepts no IPv6. curl answered `000` for the IPv6 URL while all
   three IPv4 URLs answered `200`.
3. **Address de-duplication was a filter chained above the loop that populates the set**, so
   the set was empty when the filter ran. A VPN and its physical NIC reporting one address is
   the common case, not the edge case.
4. **The banner claimed a generated key was "not written to any file"** when it is written to
   the config file that the same call created. An operator believing that would trust their
   scrollback and lose the key.

## Corrections to earlier claims

- **`createBearerAuth([])` is deny-all, not open.** This was the trap in "make the key
  optional": removing the old guard alone produces a gateway that 401s everything. There is
  now a test asserting the two differ.
- **The supervisor is not in the zod schema, deliberately.** A `superRefine` runs inside
  `loadConfig`, which is before `applyOverrides`, so it could never see `--hostname
  0.0.0.0`. It is a function called twice; there is an e2e test for the flag path specifically.
- **`--public-url` is not a CORS setting.** Zero `Access-Control-*` headers are sent anywhere.
  It is the canonical identity feeding four OAuth documents.
- **A previous diagnosis that the whole repo was CRLF in the index was wrong.** Only
  `token-store.ts` was, and only because git treated its NUL bytes as binary.

## Not done, and why

**No authorization server.** A claude.ai hosted connector cannot use a static header — the
research already in this repo confirms it (§3.5 of
`docs/ref/claude-connector-requirements.md`). That needs an AS, which ADR 0005 forbids inside
the gateway process. An AS as a **separate process** is architecturally sound and is the
recommended follow-up, with its own ADR and its own threat model. It is not a small addition
to this branch, and it cannot be verified until a real domain with TLS exists.

**No lazy auth or scope step-up** (B-35, B-36). Still accepted limitations, still unrelated.

**`init` still writes `gateway.example.json`, not the new minimal template.** Deliberate: the
explicit command should produce the documented, fully commented file, while auto-create
produces the smallest thing that works.

## One thing the operator should decide

An ephemeral tunnel URL changes on restart, and `publicUrl` becomes the token `aud`. A stale
value fails as `audience mismatch`, which points nowhere near the cause. The gateway does not
discover the active tunnel URL — that would be a guess. OPERATIONS §2 documents the two
workarounds (named tunnel with your own domain, or passing `--public-url` each run) rather than
guessing one.