# ADR 0006 — No `io.modelcontextprotocol/tasks` extension

- Status: Accepted (human decision, 2026-10-10)
- Resolves: PLAN.md §9 Q5

## Context

The tasks extension left core protocol revision 2026-07-28 and is now official under
`io.modelcontextprotocol/tasks` (verified: `docs/ref/spec-2026-07-28-changelog.md`, Major
change 6). The SDK v2 ships the surface anyway — `CancelTaskRequest`, `GetTaskRequest`,
`TaskAugmentedRequestParams`, `tasks/update` — so the capability is reachable from both sides.

PLAN.md §1 already lists the extension as a non-goal for v1.

## Decision

**No tasks extension.**

1. The gateway **never declares** the `io.modelcontextprotocol/tasks` capability, toward
   upstreams or downstream.
2. If an upstream nevertheless returns a task handle, the gateway answers the downstream
   `tools/call` with a tool result carrying `isError: true` and a short explanation that the
   upstream started an async task the gateway does not support, and **logs a warning naming the
   upstream**.
3. This is **not** a protocol error: the request itself was well-formed and the upstream ran
   it. It is an unsupported-feature condition, which is exactly D12's "tool result with
   `isError`" shape.

## Rationale

- The extension is optional and no upstream the gateway is pointed at needs it.
- Task handles require lifecycle management (polling `tasks/get`, cancellation, `tasks/update`
  for client input) that is a product feature, not a passthrough.
- Advertising a capability the gateway cannot honour is worse than not advertising it.

## Consequences

- An upstream that requires the extension cannot be used. The error message must therefore be
  actionable, which is why it names the upstream and says what happened.
- No schema change: the config gains no `tasks` toggle in v1.

## Reopen condition

A concrete upstream that only works with tasks, plus a use case that justifies the lifecycle
work. Both are required before revisiting.
