# ADR 0009 — `gateway.auth` gains an `oauth` variant alongside static bearer keys

- Status: **Accepted**
- Date: 2026-10-10 (Sprint 6, S6.2)
- Implements: PLAN.md §7 S6.2, which requires this ADR **before** the schema change.

## Context

PLAN.md D9 defines inbound auth v1 as static bearer keys compared with
`crypto.timingSafeEqual` on SHA-256 digests. Sprint 6 makes the gateway a resource server
that validates JWTs from an external authorization server (ADR 0005, option A).

S6.2 requires both to keep working side by side. The tension is that the two mechanisms have
different shapes:

| | static bearer | OAuth |
|---|---|---|
| Config | a list of key strings | an issuer, an audience, optionally a JWKS URI |
| Failure | 401, no challenge detail | 401 **with** a `WWW-Authenticate` challenge |
| What identifies the caller | the key itself | the token's `sub` |
| Secret material in config | yes, directly | no, only the issuer URL |

PLAN.md §6 offers two shapes: "`gateway.auth` accepts an array or a `type: "oauth"` variant".
Both were considered.

## Options considered

- **(A) `gateway.auth` becomes a union of `{ type: 'bearer', keys: [...] }` and
  `{ type: 'oauth', ... }`, and only ONE may be active.** Simplest schema, but it forces a
  choice. The human's instruction is that both keep working side by side, and an operator
  migrating gradually would have to flip a flag that takes effect for everyone at once.
- **(B) `gateway.auth` becomes a union member `bearer | oauth | both`.** Explicit but adds a
  third state nobody needs; `both` is just two keys in a list.
- **(C) Keep `gateway.auth` exactly as it is and ADD an `oauth` object beside it.** No union,
  no flag, no migration: an existing config is valid unchanged, and adding `oauth` is purely
  additive.

**Chosen: (C).**

### Why (C)

1. **No breaking change.** Every existing `gateway.json` keeps validating. Under (A), adding
   a `type` field to a config that has none would be a schema change for every deployment.
2. **Side by side is the default state, not a mode.** With (C) "both work" is what you get;
   under (A) it is a value you must remember to select.
3. **The failure modes differ**, and so do the responses: an OAuth-protected request gets a
   `WWW-Authenticate` challenge, a static-key failure does not. Forcing both behind one
   `type` would blur that.

The cost: `gateway` has two auth-shaped keys instead of one. Accepted — the semantics differ
enough that pretending they are one thing would be worse.

## Schema

```jsonc
{
  "gateway": {
    // Unchanged, D9. Static bearer keys keep working exactly as before.
    "auth": { "type": "bearer", "keys": ["{env:GATEWAY_API_KEY}"] },

    // New and OPTIONAL. Present => the gateway is an OAuth protected resource.
    // The metadata document is published here:
    "authOAuth": {
      // REQUIRED. The external authorization server's issuer identifier. Compared with the
      // token's `iss` claim using simple string comparison.
      "issuer": "{env:GATEWAY_OAUTH_ISSUER}",

      // OPTIONAL. The audience a token must carry. Derived from `gateway.publicUrl` + `/mcp`
      // when absent, which is the value Anthropic's documentation requires
      // (docs/ref/claude-connector-requirements.md § 2.2).
      "audience": "{env:GATEWAY_OAUTH_AUDIENCE}",

      // OPTIONAL. Where to fetch the signing keys. Discovered from the issuer's
      // authorization-server metadata when absent.
      "jwksUri": "https://auth.example.com/.well-known/jwks.json",

      // OPTIONAL. Scope hint placed in the `WWW-Authenticate` challenge.
      "scope": "mcp:read"
    }
  }
}
```

Naming: `authOAuth`, not `oauth`. The config already has an `oauth` key under `mcp.<name>`
for the *upstream* side (Sprint 5), and two different meanings of one name in one document is
a trap. `authOAuth` is unambiguous and strict-object validation will catch a mistake.

## Semantics

1. `gateway.auth` is **always** enforced. A request must satisfy it.
2. When `gateway.authOAuth` is present, a request **additionally** satisfies OAuth when it
   presents a valid bearer JWT. Either credential is sufficient; both are accepted.
3. When only `authOAuth` is configured and `auth.keys` is empty, static bearer accepts
   nothing.
4. A token that fails OAuth validation **does not** fall back to being treated as a static
   key, and vice versa. Both checks are attempted; a request passes if either passes.

## Validation rules

| Field | Rule | Why |
|---|---|---|
| `issuer` | non-empty string; `{env:}` substitution applies (D7) | It is a comparison value, and an absent issuer means no validation |
| `audience` | string, must be an absolute URI without a fragment | RFC 8707 §2 |
| `jwksUri` | absolute `https:` URL | a JWKS fetched over plaintext is an attack surface |
| `scope` | string | goes verbatim into the challenge |

`authOAuth` is a **strict** object: an unknown key is a startup error naming the path, like
every other object in the schema.

## Consequences

- `gateway.schema.json` is regenerated (S1.5) and the example updated.
- `/status` reports whether OAuth is configured and the **issuer**, never a token, a key, or
  the JWKS contents.
- Secrets: **none.** There is no client secret and no signing key in this configuration. The
  only secret on the inbound path is the external authorization server's, which never enters
  this process. This is a deliberate consequence of ADR 0005 option A.
- `{env:}` and `{file:}` substitution continues to apply (D7), so an operator can keep the
  issuer in the environment even though it is not itself a secret.

## Related

- PLAN.md §6, §7 S6.2; D9.
- `docs/adr/0005-inbound-oauth-resource-server.md` — option A, resource server only.
- `docs/ref/claude-connector-requirements.md` — why the audience is derived the way it is.
- `docs/adr/0007-q4-resolved-and-cimd-self-served.md` — `publicUrl`.