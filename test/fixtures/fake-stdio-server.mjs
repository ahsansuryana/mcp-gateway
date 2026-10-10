// Fake stdio MCP server used by the Sprint 4 suite (PLAN.md D15, S4.6).
//
// Behaviour is driven entirely by argv so one script covers every scenario:
//
//   --tool=echo|deep|hang|crash   which tool to expose
//   --grandchild                 spawn a detached grandchild that outlives a naive kill
//   --startup-delay=<ms>         delay before answering anything (startup-timeout test)
//   --stderr=<text>              write one line to stderr
//   --stderr-bytes=<n>           write n bytes to stderr with NO newline (line-buffer test)
//   --env-dump                   expose a tool that prints the child's environment keys
//
// verified: docs/ref/spec-2026-07-28-basic-transports/stdio.md (newline-delimited JSON-RPC)

import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const argv = process.argv.slice(2);
const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name) => argv.includes(`--${name}`);

const tool = arg('tool') ?? 'echo';
const startupDelayMs = Number(arg('startup-delay') ?? '0');
const stderrBytes = Number(arg('stderr-bytes') ?? '0');
const stderrText = arg('stderr');

if (flag('grandchild')) {
  // A grandchild that does NOT exit when its parent's stdin closes. Used to prove that
  // killing the process TREE is necessary.
  const grandchild = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 600000)'],
    { stdio: 'ignore', detached: false },
  );
  process.stderr.write(`grandchild pid ${String(grandchild.pid)}\n`);
}

if (stderrText !== undefined) {
  process.stderr.write(`${stderrText}\n`);
}
if (stderrBytes > 0) {
  // No trailing newline: exercises the line buffer's unbounded-line guard.
  process.stderr.write('x'.repeat(stderrBytes));
}

const factory = () => {
  // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (class McpServer)
  const server = new McpServer(
    { name: 'fake-stdio', version: '0.0.1' },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.registerTool('echo', { description: 'Echoes.', inputSchema: { text: z.string() } }, ({ text }) => ({
    content: [{ type: 'text', text: `stdio:${text}` }],
  }));

  server.registerTool('deep', { description: 'Echoes nested JSON.', inputSchema: { payload: z.unknown() } }, ({ payload }) => ({
    content: [{ type: 'text', text: 'stdio:deep' }],
    structuredContent: payload,
  }));

  server.registerTool(
    'hang',
    { description: 'Never answers.', inputSchema: {} },
    (_args, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.mcpReq.signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      }),
  );

  server.registerTool('env_dump', { description: 'Prints the child env.', inputSchema: z.object({}) }, () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          envKeys: Object.keys(process.env).sort(),
          gatewaySecretPresent: 'SPIKE_GATEWAY_SECRET' in process.env,
          gatewaySecretValue: process.env['SPIKE_GATEWAY_SECRET'] ?? null,
          configuredValue: process.env['SPIKE_UPSTREAM_VALUE'] ?? null,
          configuredAbsent: process.env['SPIKE_UPSTREAM_ABSENT'] ?? null,
        }),
      },
    ],
  }));

  return server;
};

const ready = async () => {
  if (startupDelayMs > 0) {
    // verified: https://nodejs.org/api/timers.html#timers-promises (timers/promises setTimeout)
    const { setTimeout: delay } = await import('node:timers/promises');
    await delay(startupDelayMs);
  }
};

await ready();

if (tool === 'crash') {
  // Registered at module scope, not inside the factory: the factory only runs once the
  // first message arrives, which makes the crash time depend on the handshake.
  // verified: https://nodejs.org/api/process.html#processexitcode (process.exit)
  process.stderr.write('fake-stdio: crashing');
  setTimeout(() => process.exit(1), 150);
}

// verified: spikes/node_modules/@modelcontextprotocol/server/dist/stdio.d.mts (serveStdio)
serveStdio(factory, { legacy: 'serve' });
process.stderr.write('fake-stdio: ready\n');