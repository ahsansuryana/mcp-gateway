# ADR 0013 — Zero-config startup, runtime overrides, and an optional inbound key

- Status: **Accepted**
- Date: 2026-10-17
- Branch: `feat/zero-config-startup`
- Amends **ADR 0012** (config resolution) only by adding a branch at the end of it. The
  resolution order itself is unchanged.
- Records four human decisions, each reached during planning and each worth being able to
  re-litigate later.

---

## Context

`mcp-gateway` was correct and hard to start. A fresh `npm i -g` ended at a message listing
five paths it had checked and a suggestion to run another command. Nothing told an operator
which URL to point a client at. Reaching the gateway from a second device meant editing a
file. Reaching it through a tunnel meant understanding that one field feeds four different
OAuth documents.

Four decisions were open when this work started:

1. Should `serve` create a config when none exists?
2. What does an auto-created config look like?
3. May `gateway.auth.keys` be empty?
4. What are `--hostname`, `--port` and `--public-url`, and do they persist?

---

## Step 0 — findings, recorded before any code

Measured on the development machine, not assumed.

| Question | Finding |
|---|---|
| Is `"mcp": {}` valid? | Yes. `validate` exits 0 with `upstreams: 0`, and at runtime `tools/list` answers `{"tools":[],"ttlMs":30000,"cacheScope":"private"}`. |
| Where do logs go? | **stdout** — `src/observability/logger.ts`, `destination ?? process.stdout`. A stdout banner would interleave with JSON. |
| Does anything depend on that? | `grep "process.stdout" src/ test/ \| grep -v cli.ts` → nothing. Tests inject their own `destination`. `scripts/smoke.sh` never reads the gateway's stdout. CI reads `docker logs`, which captures both streams. |
| Is CORS used? | **No.** `grep "Access-Control" src/` and the same grep over `@modelcontextprotocol/express` both return nothing. No `Access-Control-*` header is ever sent. |
| What does `originValidation` do? | Rejects. `node_modules/@modelcontextprotocol/server/dist/index.mjs:1598`: `if (originHeader == null \|\| originHeader === "") return { ok: true }`. An absent `Origin` **passes**. It is DNS-rebinding protection, not CORS. |
| What reads `gateway.publicUrl`? | Five places: `resolveAllowedOrigins`; `authOAuth.audience`; the RFC 9728 `resource`; the CIMD `client_id`/`client_uri`; the upstream OAuth callback. Four of the five are security identity, not CORS. |
| What does `createBearerAuth([])` do? | **Deny-all.** `digests` is empty, the loop never runs, `foundIndex` stays `-1`, every request is rejected. It is not "open". |
| What does `os.networkInterfaces()` return here? | Five addresses across Tailscale, two Ethernet adapters and loopback. A "list every IP" banner is a real feature, not a hypothetical. |
| Which upstream names may be used? | `^[a-z0-9-]{1,24}$`, no underscore. |

---

## Decisions

### D1 — `serve` creates a starter config when none exists

`validate` does not, and neither does `-c <missing>`.

An explicit `-c` path that does not exist is a mistake the operator made on this command
line; answering it by writing a file somewhere else would be worse than saying so. `validate`
is read-only, and a validation command with a filesystem side effect is a surprise.

**It writes to the home directory only, never to the working directory.** Auto-create makes a
file appear; making one appear in whatever directory someone ran the command from would litter
their project — often read-only, often under version control. `init --local` remains the
explicit way to get a project-local config.

`ensureConfig` decides **existence only**. It does not parse, substitute or validate, and it
never touches a file that exists. An invalid config is `loadConfig`'s to report, with the key
path; doing it in two places would mean two renderings of one class of error.

### D2 — the template is minimal, and bound to loopback

Not `gateway.example.json`. That file references `GATEWAY_API_KEY`, `GITHUB_TOKEN` and `FOO`
and ships two upstreams; writing it on first run gives a gateway that starts, exposes nothing,
and forces the operator to delete both upstreams before adding their own. The generated file
is valid, serving, and empty, with the example upstream commented out. A test asserts the
stronger property: it loads through the real `loadConfig` with `env: {}` — no variables set
at all.

`host` is **`127.0.0.1`**, not the schema's `0.0.0.0` default. Two reasons, the second
decisive: a `0.0.0.0` generated config would be **refused** by D3's supervisor, so first run
would fail for a reason nobody could see; and it would expose a brand-new gateway to the
entire LAN by omission.

The key is 32 bytes of entropy in **base64url**. Not base64, whose `+`, `/` and `=` each need
escaping somewhere among a curl header, a JSON string, a `.env` line and a shell variable. It
is shown once in the banner and never again, never logged, never in `/status`.

### D3 — `gateway.auth.keys` may be empty; open mode is loopback-only

An unauthenticated gateway is now allowed. The refusal becomes conditional rather than
absolute:

| `host` | `keys` | Result |
|---|---|---|
| loopback | empty | **open** — starts, warns loudly, says so in `/status` |
| `0.0.0.0`, `::`, LAN IP, hostname | empty | **refused before `listen`**, naming the key path and the flag |
| any | non-empty | normal bearer behaviour |

Two reasons this needed a named state rather than just a deleted `superRefine`:

- `createBearerAuth([])` is **deny-all**. Removing the old guard alone would have produced a
  gateway that rejects everything — one that looks broken rather than dangerous, and would
  have been reported as a bug.
- The check is **not in the zod schema**. A `superRefine` runs inside `loadConfig`, which runs
  *before* `applyOverrides`, so it could never see `--hostname 0.0.0.0`: the flag would pass
  validation and the gateway would listen on the LAN with `/mcp` open. The check is therefore
  a plain function called from two places — `parseConfig` (so `validate` reports it) and
  `startGateway` after the overrides, before `listen`. There is an e2e test for exactly the
  flag case.

Open mode is visible in three places, because the banner is seen once and scrolls away:
the banner, a `warn` log line, and `/status.authMode`.

### D4 — `--hostname`, `--port`, `--public-url`: per-process, never persisted

They are not written back to `gateway.json`, following the precedent `-c` already sets. This
matters most for `--public-url`: persisting it would turn a tunnel's ephemeral URL into the
installation's permanent identity, so the next run without the flag would advertise the wrong
`aud` and fail as `audience mismatch`.

Applied **before** the HTTP app is built, because the Origin allowlist, the RFC 9728 audience
and the CIMD `client_id` are derived from `config.gateway.publicUrl` at that moment. Applied
afterwards, they would change `/status` while the OAuth metadata still pointed at the old host.

Rejected deliberately: `--port 0` (the caller cannot learn which port was taken, so every
printed URL would be uncallable), `--port 3000abc` (`parseInt` would bind a different port than
was typed), and any unknown flag (a typo'd `--host` must not be indistinguishable from one
that worked).

`--public-url` is documented as what it is: the gateway's canonical identity feeding four
OAuth documents. It is **not** a CORS setting, and no `Access-Control-*` header is ever sent.

---

## Consequences

### Good

- `npm i -g && mcp-gateway` works. One command, no file to write, and the URL is printed.
- The banner lists addresses that are real: loopback, every usable non-link-local interface
  address, and `publicUrl` when set.
- `0.0.0.0` with no key is impossible, and it is impossible *before* the port is bound.
- Flags let an operator try a different bind or tunnel without editing a file, so the file
  never accumulates per-attempt state.

### Costs, accepted

- An unauthenticated gateway is reachable by anything that can reach the loopback interface,
  which includes every local process and anything with SSRF access. This is the accepted
  meaning of "optional key".
- Auto-create writes to the home directory unprompted. Mitigated by 0600-in-0700, by never
  overwriting, and by saying so in the banner.
- Flags do not survive a reload. `ConfigReloader` reloads upstreams only, so changing
  `gateway.publicUrl` in the file has no effect on a process started with `--public-url`.
  Restarting is the fix.
- The generated key is base64url in a JSON file. The file is gitignored and mode 0600, and the
  file is the operator's own.

### Boundaries that follow

- `publicUrl` is derived, never invented. The gateway does not try to discover an active
  tunnel URL: that would be a guess, and a wrong guess fails as `audience mismatch`, which
  points nowhere near the cause. Ephemeral-tunnel handling is the operator's, and OPERATIONS
  §2 says so.
- Lazy authentication and scope step-up remain unimplemented (B-35, B-36). Open mode is the
  opposite of lazy auth: it requires no identity at all, on loopback only.

---

## Things found by running rather than reading

Recorded because each would have shipped.

1. **`serve --port 0` answered `unknown option: serve`.** The command word reached the flag
   parser. No unit test caught it; running the built binary did.
2. **The banner printed dead IPv6 URLs.** `listen(port, '0.0.0.0')` reaches `bind(2)` as
   `AF_INET`, so the listener accepts no IPv6 at all. curl answered `000` for the IPv6 URL
   while all three IPv4 URLs on the same banner answered `200`. IPv6 is now listed only for an
   `::` bind.
3. **Address de-duplication was a filter chained above the loop that populates the set**, so
   the set was empty when the filter ran and both copies of a shared address passed. A VPN and
   the physical NIC reporting one address is the common case.
4. **The banner claimed a generated key was "not written to any file".** It is written to the
   config file that the same call created. An operator believing that would trust their
   scrollback and lose the key.

---

## Related

- `docs/adr/0012-global-cli-and-config-dir.md` — the resolution order this adds a branch to.
- `docs/adr/0005-inbound-oauth-resource-server.md` — why the gateway is not an authorization
  server, and what is still missing for a claude.ai connector.
- `docs/OPERATIONS.md` §2 — runtime flags, and what `publicUrl` does and does not do.