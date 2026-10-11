// Smoke-test upstream for scripts/smoke.sh (PLAN.md S7.6 / F-1).
//
// WHY THIS EXISTS INSTEAD OF REUSING test/fixtures/fake-stdio-server.mjs
//
// The test fixture is driven entirely by argv and exposes every behaviour the suite needs:
// `--tool=deep`, `--tool=hang`, `--tool=crash`, `--grandchild`, `--stderr-bytes`. Several of
// those are deliberately hostile -- `hang` NEVER answers, `crash` exits non-zero. Pointing
// the smoke test at it made the result depend on WHICH tool the script happened to pick.
//
// The first attempt did exactly that, and failed informatively:
//
//     calling: smoke_hang with {"text":"smoke"}
//     {"result":{"content":[{"type":"text","text":"Upstream 'smoke' is unavailable"}],
//               "isError":true}}
//
// A smoke test whose outcome depends on a tool it did not choose is not a smoke test. This
// file exposes exactly ONE tool with a deterministic name, so the test asserts on the
// upstream actually answering rather than on parsing luck.
//
// It is deliberately NOT a copy of the test fixture: that one is a test asset whose
// behaviour is allowed to change, and the smoke test needs a contract that will not move
// under it.
//
// verified: docs/ref/spec-2026-07-28-basic-transports/stdio.md (newline-delimited JSON-RPC)
// verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-*.d.mts
//   (class McpServer)

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer(
  { name: 'smoke-upstream', version: '0.0.1' },
  { capabilities: { tools: { listChanged: false } } },
);

// The reply is prefixed `smoke-upstream:` so the caller can tell, from the response alone,
// that the answer came from THIS process rather than being synthesised by the gateway.
server.registerTool(
  'echo',
  { description: 'Echoes the given text. Used by the gateway smoke test.', inputSchema: { text: z.string() } },
  ({ text }) => ({ content: [{ type: 'text', text: `smoke-upstream:${text}` }] }),
);

serveStdio(() => server, { legacy: 'serve' });
