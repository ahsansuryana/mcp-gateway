// Sprint 0 spike 3: run the official MCP Inspector CLI against the gateway
// skeleton produced by spike-1, and save the transcripts.
//
// Usage:  node spike-3.mjs            (starts the skeleton, runs the inspector)
//         node spike-3.mjs --serve    (starts the skeleton and stays up, for manual use)
//
// verified: https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/cli.md

import http from 'node:http';
// verified: https://www.npmjs.com/package/cross-spawn (v7.0.6; resolves Windows .cmd shims without a shell)
import spawn from 'cross-spawn';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

const UP_PORT = 3151;
const GW_PORT = 3152;
const UP_URL = `http://127.0.0.1:${UP_PORT}/mcp`;
const GW_URL = `http://127.0.0.1:${GW_PORT}/mcp`;
const log = (...a) => console.log(...a);

const upstreamFactory = () => {
  // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (class McpServer, registerTool)
  const s = new McpServer(
    { name: 'inspector-upstream', version: '0.0.1' },
    { capabilities: { tools: { listChanged: false } } },
  );
  s.registerTool(
    'add',
    { description: 'Add two integers.', inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  );
  s.registerTool(
    'greet',
    { description: 'Greet a person.', inputSchema: { name: z.string() } },
    async ({ name }) => ({ content: [{ type: 'text', text: `hello ${name}` }] }),
  );
  return s;
};

const upstreamServer = http.createServer(toNodeHandler(createMcpHandler(upstreamFactory, { legacy: 'reject' })));
await new Promise((r) => upstreamServer.listen(UP_PORT, '127.0.0.1', r));

const upstreamClient = new Client(
  { name: 'spike-3-gw', version: '0.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
await upstreamClient.connect(new StreamableHTTPClientTransport(new URL(UP_URL)));

const gatewayFactory = () => {
  // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (class Server, Protocol.setRequestHandler)
  const s = new Server(
    { name: 'mcp-gateway-spike', version: '0.0.0' },
    { capabilities: { tools: { listChanged: false } }, cacheHints: { 'tools/list': { ttlMs: 5000, cacheScope: 'private' } } },
  );
  s.setRequestHandler('tools/list', async () => {
    const r = await upstreamClient.listTools({}, { cacheMode: 'refresh', timeout: 5000 });
    return { tools: r.tools.map((t) => ({ ...t, name: `up_${t.name}` })) };
  });
  s.setRequestHandler('tools/call', async (req, ctx) =>
    upstreamClient.callTool(
      { name: req.params.name.slice(3), arguments: req.params.arguments ?? {} },
      { signal: ctx.mcpReq.signal, timeout: 5000 },
    ),
  );
  return s;
};

const gwServer = http.createServer(toNodeHandler(createMcpHandler(gatewayFactory, { legacy: 'stateless' })));
await new Promise((r) => gwServer.listen(GW_PORT, '127.0.0.1', r));
log(`[spike-3] upstream ${UP_URL} / gateway ${GW_URL}`);

function runInspector(args) {
  return new Promise((resolve) => {
    log(`\n$ npx -y @modelcontextprotocol/inspector@latest --cli ${args}`);
    // verified: https://www.npmjs.com/package/@modelcontextprotocol/inspector (bin: mcp-inspector)
    const p = spawn(
      'npx',
      ['-y', '@modelcontextprotocol/inspector@latest', '--cli', ...args],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    const timer = setTimeout(() => p.kill(), 180000);
    p.on('close', (code) => {
      clearTimeout(timer);
      log(`[exit ${code}]`);
      if (out.trim()) log(out.trim());
      if (err.trim()) log('[stderr]', err.trim().slice(0, 2000));
      resolve({ code, out, err });
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      log('[spawn error]', e.message);
      resolve({ code: -1, out, err });
    });
  });
}

if (process.argv.includes('--serve')) {
  log('[spike-3] --serve: skeleton stays up. Ctrl+C to stop.');
} else {
  // Default Inspector behaviour: legacy era (2025-11-25). Works against the
  // gateway because createMcpHandler defaults to legacy: 'stateless'.
  await runInspector([GW_URL, '--transport', 'http', '--method', 'tools/list', '--format', 'json']);
  await runInspector([
    GW_URL, '--transport', 'http', '--method', 'tools/call',
    '--tool-name', 'up_add', '--tool-arg', 'a=2', '--tool-arg', 'b=40', '--format', 'json',
  ]);
  await runInspector([
    GW_URL, '--transport', 'http', '--method', 'tools/call',
    '--tool-name', 'up_greet', '--tool-args-json', '{"name":"inspector"}', '--format', 'json',
  ]);
  // The modern-only upstream (legacy: 'reject') is unreachable at the default era.
  await runInspector([UP_URL, '--transport', 'http', '--method', 'tools/list', '--format', 'json']);
  // ...but reachable with --protocol-era modern / auto.
  // verified: https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/cli.md (--protocol-era flag)
  await runInspector([
    UP_URL, '--transport', 'http', '--protocol-era', 'modern', '--method', 'tools/list', '--format', 'json',
  ]);
  await runInspector([
    GW_URL, '--transport', 'http', '--protocol-era', 'modern', '--method', 'tools/list', '--format', 'json',
  ]);
  await upstreamClient.close().catch(() => {});
  gwServer.close();
  upstreamServer.close();
  log('\nspike-3 done');
}