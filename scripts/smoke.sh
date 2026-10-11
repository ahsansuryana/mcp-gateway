#!/bin/sh
# PLAN.md S7.6: smoke test hitting the endpoints a client actually uses.
#
#   GET  /healthz        unauthenticated liveness (D9)
#   POST /mcp            server/discover, tools/list, tools/call
#   GET  /status         the authenticated inventory
#
# Runs INSIDE the container against a running gateway:
#   docker compose exec gateway /app/scripts/smoke.sh
#
# or standalone:
#   GATEWAY_URL=http://127.0.0.1:3000 GATEWAY_API_KEY=... ./scripts/smoke.sh
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

check() {
  if [ "$1" = "0" ]; then
    printf '  PASS %s\n' "$2"
  else
    printf '  FAIL %s\n' "$2"
    failures=$((failures + 1))
  fi
}

# One HTTP call, printed as `status<newline>body`, performed by Node.
rpc() {
  # $1 method, $2 path, $3 body or empty, $4 auth or empty
  node -e '
    const [method, path, body, auth] = process.argv.slice(1);
    const url = new URL(path, process.env.GATEWAY_URL);
    const headers = { accept: "application/json, text/event-stream" };
    if (body) headers["content-type"] = "application/json";
    if (auth) headers.authorization = "Bearer " + auth;
    fetch(url, { method, headers, body: body || undefined })
      .then(async (r) => {
        process.stdout.write(String(r.status) + "\n");
        process.stdout.write(await r.text());
      })
      .catch((e) => {
        process.stdout.write("000\n");
        process.stdout.write(String(e && e.message));
      });
  ' "$1" "$2" "$3" "${4:-}" 2>/dev/null || printf '000\nrequest failed'
}

status_of() { printf '%s' "$1" | head -n 1; }
body_of() { printf '%s' "$1" | tail -n +2; }

printf 'mcp-gateway smoke test against %s\n' "$GATEWAY_URL"

step "GET /healthz (unauthenticated)"
r="$(rpc GET /healthz '' '')"
b="$(body_of "$r")"
printf '  status: %s  body: %s\n' "$(status_of "$r")" "$b"
[ "$(status_of "$r")" = "200" ]
check $? "healthz answers 200"
printf '%s' "$b" | grep -q '"ok":true'
check $? "healthz returns ok:true"

step "POST /mcp identity (server/discover, or initialize on a 2025-era connection)"
# `server/discover` only exists in protocol revision 2026-07-28. A bare JSON-RPC POST has no
# version negotiation, so on the gateway's default `legacyEra: stateless` it lands on the
# 2025 era and answers -32601 -- which is CORRECT, not a failure. The test therefore tries
# the modern method and falls back to `initialize`, which every era answers.
r="$(rpc POST /mcp '{"jsonrpc":"2.0","id":1,"method":"server/discover"}' "$GATEWAY_API_KEY")"
b="$(body_of "$r")"
printf '  server/discover -> status %s, body %.200s\n' "$(status_of "$r")" "$b"

if printf '%s' "$b" | grep -q 'mcp-gateway'; then
  check 0 "server/discover reports the gateway identity (modern era)"
else
  init="$(rpc POST /mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}' "$GATEWAY_API_KEY")"
  ib="$(body_of "$init")"
  printf '  initialize       -> status %s, body %.200s\n' "$(status_of "$init")" "$ib"
  printf '%s' "$ib" | grep -q 'mcp-gateway'
  check $? "initialize reports the gateway identity (2025 era path)"
fi

step "POST /mcp tools/list (authenticated)"
r="$(rpc POST /mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "$GATEWAY_API_KEY")"
tools="$(body_of "$r")"
printf '  status: %s  body: %.300s\n' "$(status_of "$r")" "$tools"
printf '%s' "$tools" | grep -q '"tools"'
check $? "tools/list returns a tools array"

step "POST /mcp without a credential is rejected"
r="$(rpc POST /mcp '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' '')"
printf '  status: %s\n' "$(status_of "$r")"
[ "$(status_of "$r")" = "401" ]
check $? "unauthenticated tools/list is 401"

step "GET /status (authenticated)"
r="$(rpc GET /status '' "$GATEWAY_API_KEY")"
b="$(body_of "$r")"
printf '  status: %s  body: %.300s\n' "$(status_of "$r")" "$b"
printf '%s' "$b" | grep -q '"upstreams"'
check $? "status reports upstreams"

step "POST /mcp tools/call (one real call)"
first_tool="$(printf '%s' "$tools" | sed -n 's/.*"name":"\([A-Za-z0-9_-]*\)".*/\1/p' | head -n 1)"
if [ -z "$first_tool" ]; then
  printf '  SKIP no upstream tools configured; nothing to call\n'
else
  printf '  calling: %s\n' "$first_tool"
  r="$(rpc POST /mcp "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"${first_tool}\",\"arguments\":{}}}" "$GATEWAY_API_KEY")"
  b="$(body_of "$r")"
  printf '  status: %s  body: %.300s\n' "$(status_of "$r")" "$b"
  # An `isError` result is a legitimate outcome when an upstream is down; a JSON-RPC
  # error would mean the gateway itself is broken.
  printf '%s' "$b" | grep -Eq '"result"'
  check $? "tools/call returned a JSON-RPC result (isError is acceptable)"
fi

step "secrets are not echoed back"
if printf '%s' "$(body_of "$(rpc GET /status '' "$GATEWAY_API_KEY")")" | grep -q "$GATEWAY_API_KEY"; then
  printf '  FAIL /status leaked the bearer key\n'
  failures=$((failures + 1))
else
  printf '  PASS /status does not contain the bearer key\n'
fi

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf 'SMOKE TEST PASSED\n'
  exit 0
fi
printf 'SMOKE TEST FAILED: %s check(s)\n' "$failures"
exit 1