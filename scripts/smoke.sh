#!/bin/sh
# PLAN.md S7.6 / F-1: smoke test hitting the endpoints a client actually uses.
#
#   GET  /healthz        unauthenticated liveness (D9)
#   POST /mcp            server/discover, tools/list, tools/call
#   GET  /status         the authenticated inventory
#
# The config used here (spikes/smoke/gateway.json) points at the in-repo stdio fixture, so
# the tools/call below is a REAL call: request -> gateway -> child process -> back. There is
# no network and no third-party server (PLAN.md D15).
#
# Runs INSIDE the container against a running gateway:
#   GATEWAY_API_KEY=... sh /app/scripts/smoke.sh
#
# or on a host against a local gateway:
#   GATEWAY_URL=http://127.0.0.1:3000 GATEWAY_API_KEY=... sh scripts/smoke.sh
#
# WHY NODE AND NOT curl: the runtime image is `node:24-bookworm-slim`, which ships no curl,
# and installing one purely so a smoke test can run would add a package to production for no
# operational benefit. Node is already required to run the gateway, so the test uses the
# same runtime as the thing it tests. POSIX sh, no bash, no jq.

set -eu

# Exported, not just set: the HTTP helper below runs `node`, which only sees the
# environment. A non-exported shell variable leaves process.env.GATEWAY_URL undefined and
# every request fails with "request failed" instead of a real status.
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:${PORT:-3000}}"
export GATEWAY_URL
GATEWAY_API_KEY="${GATEWAY_API_KEY:?GATEWAY_API_KEY must be set}"

failures=0

step() { printf '\n=== %s ===\n' "$1"; }

# WHY THESE HELPERS EXIST: the script runs under `set -e`, so a bare `[ ... ]` that returns
# non-zero terminates the shell IMMEDIATELY. An earlier version of this file did exactly
# that: every check was written as
#
#     [ "$status" = "200" ]
#     check $? "healthz answers 200"
#
# and on failure the process exited 1 having printed NOTHING. The `check` call was dead
# code, "SMOKE TEST FAILED" could never be printed, and a reader of the log saw a silent
# non-zero exit with no indication of which check broke. Running the command inside an
# `if` makes it a condition, where `set -e` does not apply.
pass() { printf '  PASS %s\n' "$1"; }
fail() {
  printf '  FAIL %s\n' "$1"
  failures=$((failures + 1))
}

# expect_status <description> <expected> <actual>
expect_status() {
  if [ "$2" = "$3" ]; then pass "$1 (status $3)"; else fail "$1: expected status $2, got $3"; fi
}

# expect_grep <description> <pattern> <text>
expect_grep() {
  if printf '%s' "$3" | grep -q -- "$2"; then pass "$1"; else fail "$1 (pattern: $2)"; fi
}

expect_not_grep() {
  if printf '%s' "$3" | grep -q -- "$2"; then fail "$1 (pattern: $2)"; else pass "$1"; fi
}

# One HTTP call, printed as `status<newline>body`, performed by Node.
#
# THE URL PATH IS PASSED WITHOUT A LEADING SLASH, BECAUSE MSYS REWRITES PATHS.
#
# Under Git Bash on Windows, MSYS converts anything path-shaped into a Windows path before
# a native program sees it -- both argv values AND environment variables. Passing
# "/healthz" produced, on Windows only:
#
#     URL BUILT: g:/Application/Git/healthz     CAUSE: fetch failed | unknown scheme
#
# The identical script passed inside the Linux container, so the failure presented as a
# gateway defect rather than a shell one. The usual workarounds (MSYS_NO_PATHCONV=1,
# MSYS2_ENV_CONV_EXCL='*') require the operator to remember a flag, and a smoke test that
# only works when you remember a flag is not a smoke test. A bare "healthz" is not
# path-shaped, so nothing rewrites it; the leading slash is re-added inside Node.
# Verified on node 24.18 Windows and node 24.21 linux/arm64.
rpc() {
  RPC_METHOD="$1" RPC_TARGET="$2" RPC_BODY="$3" RPC_AUTH="${4:-}" node -e '
    const url = new URL("/" + process.env.RPC_TARGET.replace(/^\//, ""), process.env.GATEWAY_URL);
    const headers = { accept: "application/json, text/event-stream" };
    const body = process.env.RPC_BODY;
    if (body) headers["content-type"] = "application/json";
    if (process.env.RPC_AUTH) headers.authorization = "Bearer " + process.env.RPC_AUTH;
    fetch(url, { method: process.env.RPC_METHOD, headers, body: body || undefined })
      .then(async (r) => {
        process.stdout.write(String(r.status) + "\n");
        process.stdout.write(await r.text());
      })
      .catch((e) => {
        process.stdout.write("000\n");
        process.stdout.write(String((e && e.cause && e.cause.code) || (e && e.message)));
      });
  ' 2>/dev/null || printf '000\nrequest failed'
}

status_of() { printf '%s' "$1" | head -n 1; }
body_of() { printf '%s' "$1" | tail -n +2; }

printf 'mcp-gateway smoke test against %s\n' "$GATEWAY_URL"

step "GET /healthz (unauthenticated)"
r="$(rpc GET healthz '' '')"
b="$(body_of "$r")"
printf '  status: %s  body: %s\n' "$(status_of "$r")" "$b"
expect_status "healthz answers 200" 200 "$(status_of "$r")"
expect_grep "healthz returns ok:true" '"ok":true' "$b"

step "POST /mcp identity (server/discover, or initialize on a 2025-era connection)"
# `server/discover` only exists in protocol revision 2026-07-28. A bare JSON-RPC POST has no
# version negotiation, so on the gateway's default `legacyEra: stateless` it lands on the
# 2025 era and answers -32601 -- which is CORRECT, not a failure. The test therefore tries
# the modern method and falls back to `initialize`, which every era answers.
r="$(rpc POST mcp '{"jsonrpc":"2.0","id":1,"method":"server/discover"}' "$GATEWAY_API_KEY")"
b="$(body_of "$r")"
printf '  server/discover -> status %s, body %.200s\n' "$(status_of "$r")" "$b"

if printf '%s' "$b" | grep -q 'mcp-gateway'; then
  pass "server/discover reports the gateway identity (modern era)"
else
  init="$(rpc POST mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}' "$GATEWAY_API_KEY")"
  ib="$(body_of "$init")"
  printf '  initialize       -> status %s, body %.200s\n' "$(status_of "$init")" "$ib"
  expect_grep "initialize reports the gateway identity (2025 era path)" 'mcp-gateway' "$ib"
fi

step "POST /mcp tools/list (authenticated)"
r="$(rpc POST mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "$GATEWAY_API_KEY")"
tools="$(body_of "$r")"
printf '  status: %s  body: %.300s\n' "$(status_of "$r")" "$tools"
expect_status "tools/list answers 200" 200 "$(status_of "$r")"
expect_grep "tools/list returns a tools array" '"tools"' "$tools"

step "POST /mcp without a credential is rejected"
r="$(rpc POST mcp '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' '')"
printf '  status: %s\n' "$(status_of "$r")"
expect_status "unauthenticated tools/list is 401" 401 "$(status_of "$r")"

step "GET /status (authenticated)"
r="$(rpc GET status '' "$GATEWAY_API_KEY")"
b="$(body_of "$r")"
printf '  status: %s  body: %.300s\n' "$(status_of "$r")" "$b"
expect_status "status answers 200" 200 "$(status_of "$r")"
expect_grep "status reports upstreams" '"upstreams"' "$b"

step "POST /mcp tools/call (one REAL call through the gateway to a real upstream)"
# The aggregated name is <upstream>_<tool> (PLAN.md S4.2), so `echo` becomes `smoke_echo`.
# It is parsed out of tools/list rather than hardcoded, so the assertion is that a REAL
# upstream answered, not that a literal string matched.
#
# `grep -o`, NOT `sed 's/.*X.*Y/'`. The SSE body is effectively ONE line, and a leading `.*`
# is greedy, so sed matched to the LAST occurrence on the line and returned the last tool in
# the list rather than the first. Against the multi-tool test fixture that selected
# `smoke_hang` -- the tool that never answers -- producing a failure that had nothing to do
# with the gateway. `grep -o` emits one match per line, so `head -n 1` is genuinely the first.
first_tool="$(printf '%s' "$tools" | grep -o '"name":"[A-Za-z0-9_-]*"' | head -n 1 | sed 's/"name":"//; s/"$//')"
if [ -z "$first_tool" ]; then
  # Previously a SKIP. A skip here would mean the smoke test never proved a tool call works,
  # which is the entire reason an upstream exists in this config. It is a failure.
  fail "no tools were listed, so no real tools/call could be made"
else
  printf '  calling: %s with {"text":"smoke"}\n' "$first_tool"
  r="$(rpc POST mcp "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"${first_tool}\",\"arguments\":{\"text\":\"smoke\"}}}" "$GATEWAY_API_KEY")"
  b="$(body_of "$r")"
  printf '  status: %s  body: %.300s\n' "$(status_of "$r")" "$b"
  expect_status "tools/call answers 200" 200 "$(status_of "$r")"
  # Assert the UPSTREAM's answer came back, not merely that a JSON-RPC envelope did. The
  # smoke upstream prefixes its reply with `smoke-upstream:`, so seeing that proves the
  # request reached the child process and returned through the aggregator.
  expect_grep "the upstream really answered (found its reply)" 'smoke-upstream:smoke' "$b"
  expect_not_grep "tools/call did not return isError" '"isError":true' "$b"
fi

step "secrets are not echoed back"
status_body="$(body_of "$(rpc GET status '' "$GATEWAY_API_KEY")")"
expect_not_grep "/status does not leak the bearer key" "$GATEWAY_API_KEY" "$status_body"

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf 'SMOKE TEST PASSED\n'
  exit 0
fi
printf 'SMOKE TEST FAILED: %s check(s)\n' "$failures"
exit 1
