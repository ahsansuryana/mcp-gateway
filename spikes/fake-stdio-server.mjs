// Fake stdio MCP server used by spike-2.mjs.
// Speaks the newline-delimited JSON-RPC of the MCP stdio binding.
// verified: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio

import { createInterface } from 'node:readline';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const factory = () => {
  // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (class McpServer)
  const s = new McpServer(
    { name: 'fake-stdio-upstream', version: '0.0.1' },
    { capabilities: { tools: { listChanged: false } } },
  );

  s.registerTool(
    'show_env',
    {
      description: 'Print which environment variables this child process can see.',
      inputSchema: { filter: z.string().optional() },
    },
    async ({ filter }) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            envKeys: Object.keys(process.env).sort(),
            upstreamName: process.env.SPIKE_UPSTREAM_NAME ?? null,
            upstreamValue: process.env.SPIKE_UPSTREAM_VALUE ?? null,
            gatewaySecretLeaked: 'SPIKE_GATEWAY_SECRET' in process.env,
            filtered: filter ?? null,
          }),
        },
      ],
    }),
  );

  s.registerTool(
    'add',
    {
      description: 'Add two numbers.',
      inputSchema: { a: z.number(), b: z.number() },
    },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  );

  return s;
};

// verified: spikes/node_modules/@modelcontextprotocol/server/dist/stdio.d.mts (function serveStdio, ServeStdioOptions.legacy)
// verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (const McpServer)
const handle = serveStdio(factory, { legacy: 'serve' });

process.stderr.write('fake-stdio-server: ready\n');
process.on('SIGTERM', () => void handle.close().then(() => process.exit(0)));