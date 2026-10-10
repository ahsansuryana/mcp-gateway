// PLAN.md S2.7: run the official MCP Inspector CLI against a live gateway.
//
//   node spikes/spike-4.mjs          -> fake upstream + gateway, inspector transcript
//   node spikes/spike-4.mjs --serve  -> keep it up for manual poking
//
// verified: https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/cli.md

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import spawn from 'cross-spawn';

import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import http from 'node:http';
import { z } from 'zod';

import { startGateway } from '../src/index.js';

const UPSTREAM_PORT = 3161;
const API_KEY = 'S2-7-CANARY-KEY-0123456789';
const log = (...a) => console.log(...a);

// --- fake upstream ---------------------------------------------------------

const upstream = http.createServer(
  toNodeHandler(
    createMcpHandler(() => {
      // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts
      const s = new McpServer({ name: 's27-upstream', version: '0.0.1' }, { capabilities: { tools: {} } });
      s.registerTool(
        'add',
        { description: 'Add two integers.', inputSchema: { a: z.number(), b: z.number() } },
        ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
      );
      s.registerTool(
        'greet',
        { description: 'Greet a person.', inputSchema: { name: z.string() } },
        ({ name }) => ({ content: [{ type: 'text', text: `hello ${name}` }] }),
      );
      s.registerTool(
        'boom',
        { description: 'Always reports a tool-level failure.', inputSchema: z.object({}) },
        () => ({ content: [{ type: 'text', text: 'upstream tool failure' }], isError: true }),
      );
      return s;
    }, { legacy: 'reject' }),
  ),
);
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));
log(`[upstream] http://127.0.0.1:${UPSTREAM_PORT}/mcp`);

// --- gateway ---------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-s27-'));
mkdirSync(join(dir, 'out'), { recursive: true });
const configPath = join(dir, 'gateway.json');
const gatewayPort = await unusedPort();

writeFileSync(
  configPath,
  JSON.stringify(
    {
      gateway: {
        host: '127.0.0.1',
        port: gatewayPort,
        auth: { type: 'bearer', keys: [API_KEY] },
        defaultTtlMs: 30000,
      },
      mcp: {
        demo: { type: 'remote', url: `http://127.0.0.1:${UPSTREAM_PORT}/mcp`, timeout: 5000 },
      },
    },
    null,
    2,
  ),
  'utf8',
);

const gateway = await startGateway({ configPath });
const gatewayUrl = `http://127.0.0.1:${gatewayPort}/mcp`;
log(`[gateway] ${gatewayUrl}`);

// --- inspector -------------------------------------------------------------

function runInspector(args) {
  return new Promise((resolve) => {
    log(`\n$ npx -y @modelcontextprotocol/inspector@latest --cli ${args.join(' ')}`);
    const p = spawn(
      'npx',
      ['-y', '@modelcontextprotocol/inspector@latest', '--cli', ...args],
      {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MCP_GATEWAY_KEY: API_KEY },
      },
    );
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    const timer = setTimeout(() => p.kill(), 180_000);
    p.on('close', (code) => {
      clearTimeout(timer);
      log(`[exit ${code}]`);
      if (out.trim()) log(out.trim());
      if (err.trim()) log('[stderr]', err.trim().slice(0, 1500));
      resolve({ code, out, err });
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      log('[spawn error]', e.message);
      resolve({ code: -1, out, err });
    });
  });
}

// The inspector's auth flag is `--header "Name: Value"`, verified in
// https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/configuration.md
const auth = ['--header', `Authorization: Bearer ${API_KEY}`];

if (process.argv.includes('--serve')) {
  log('[spike-4] --serve: gateway stays up. Ctrl+C to stop.');
} else {
  await runInspector([gatewayUrl, '--transport', 'http', ...auth, '--method', 'tools/list', '--format', 'json']);
  await runInspector([
    gatewayUrl, '--transport', 'http', '--protocol-era', 'modern', ...auth,
    '--method', 'tools/call', '--tool-name', 'demo_add', '--tool-arg', 'a=2', '--tool-arg', 'b=40',
    '--format', 'json',
  ]);
  await runInspector([
    gatewayUrl, '--transport', 'http', '--protocol-era', 'modern', ...auth,
    '--method', 'tools/call', '--tool-name', 'demo_greet', '--tool-args-json', '{"name":"inspector"}',
    '--format', 'json',
  ]);
  await runInspector([
    gatewayUrl, '--transport', 'http', '--protocol-era', 'modern', ...auth,
    '--method', 'tools/call', '--tool-name', 'demo_boom', '--format', 'json',
  ]);

  // Unauthenticated must be refused.
  await runInspector([gatewayUrl, '--transport', 'http', '--method', 'tools/list', '--format', 'json']);

  // Plain HTTP checks against the same gateway.
  log('\n$ curl -s -i http://127.0.0.1:PORT/healthz');
  const healthz = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
  log(`HTTP ${healthz.status} ${JSON.stringify(await healthz.json())}`);

  log(`\n$ curl -s -i -H "Authorization: Bearer ${API_KEY}" http://127.0.0.1:PORT/status`);
  const status = await fetch(`http://127.0.0.1:${gatewayPort}/status`, {
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  log(`HTTP ${status.status} ${JSON.stringify(await status.json())}`);

  log('\n$ curl -s -i http://127.0.0.1:PORT/mcp   (no credentials)');
  const noAuth = await fetch(gatewayUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  log(`HTTP ${noAuth.status} www-authenticate=${noAuth.headers.get('www-authenticate')}`);

  await gateway.stop();
  upstream.close();
  log('\nspike-4 done');
}

async function unusedPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const addr = probe.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  await new Promise((r) => probe.close(r));
  return port;
}