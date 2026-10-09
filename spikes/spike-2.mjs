// Sprint 0 spike 2: gateway-style proxy over a LOCAL (stdio) upstream.
//
// Purpose: prove the stdio client transport, the environment allowlist (D13),
// and child-process lifecycle as the SDK actually implements them.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment, DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';
import { McpServer, Server, createMcpHandler } from '@modelcontextprotocol/server';
import http from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const GW_PORT = 3141;
const log = (...a) => console.log(...a);
const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// (d) What the SDK's default environment allowlist actually is.
// ---------------------------------------------------------------------------
log('=== default inherited env vars (D13) ===');
log('DEFAULT_INHERITED_ENV_VARS =', JSON.stringify(DEFAULT_INHERITED_ENV_VARS));
log('getDefaultEnvironment() keys =', JSON.stringify(Object.keys(getDefaultEnvironment())));

process.env.SPIKE_GATEWAY_SECRET = 'SECRET-CANARY-ENV';

// ---------------------------------------------------------------------------
// stdio upstream (spawned child process)
// ---------------------------------------------------------------------------

// verified: spikes/node_modules/@modelcontextprotocol/client/dist/stdio.d.mts (StdioClientTransport, StdioServerParameters.env)
const stdioTransport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, 'fake-stdio-server.mjs')],
  // verified: spikes/node_modules/@modelcontextprotocol/client/dist/stdio.mjs (start(): env = { ...getDefaultEnvironment(), ...serverParams.env })
  // The SDK ALWAYS merges the allowlist underneath; a caller-supplied `env` is additive, never a replacement.
  env: {
    SPIKE_UPSTREAM_NAME: 'local-up',
    SPIKE_UPSTREAM_VALUE: 'from-config',
  },
  // verified: spikes/node_modules/@modelcontextprotocol/client/dist/stdio.d.mts (StdioServerParameters.stderr: "pipe" surfaces child stderr)
  stderr: 'pipe',
});

stdioTransport.stderr?.on('data', (chunk) => {
  log('[child stderr]', String(chunk).trim());
});

const stdioClient = new Client(
  { name: 'gw-stdio-client', version: '0.0.0' },
  { versionNegotiation: { mode: 'auto' } },
);

await stdioClient.connect(stdioTransport);
log('stdio pid =', stdioTransport.pid);
log('stdio server/discover =', JSON.stringify(stdioClient.getDiscoverResult()?.supportedVersions ?? null));
log('stdio getServerVersion =', JSON.stringify(stdioClient.getServerVersion()));
const stdioTools = await stdioClient.listTools({}, { cacheMode: 'bypass' });
log('stdio tools =', stdioTools.tools.map((t) => t.name).join(','));
const envProbe = await stdioClient.callTool({ name: 'show_env', arguments: {} });
log('child env result =', envProbe.content?.[0]?.text?.slice(0, 400));

// ---------------------------------------------------------------------------
// Gateway in front of the stdio upstream, over HTTP.
// ---------------------------------------------------------------------------

const gatewayFactory = () => {
  // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (class Server)
  const s = new Server(
    { name: 'gw-stdio', version: '0.0.0' },
    { capabilities: { tools: { listChanged: false } } },
  );
  s.setRequestHandler('tools/list', async () => {
    const r = await stdioClient.listTools({}, { cacheMode: 'refresh', timeout: 5000 });
    return { tools: r.tools.map((t) => ({ ...t, name: `local_${t.name}` })) };
  });
  s.setRequestHandler('tools/call', async (req, ctx) =>
    stdioClient.callTool(
      { name: req.params.name.slice('local_'.length), arguments: req.params.arguments ?? {} },
      { signal: ctx.mcpReq.signal, timeout: 5000 },
    ),
  );
  return s;
};

const gwServer = http.createServer(toNodeHandler(createMcpHandler(gatewayFactory, { legacy: 'reject' })));
await new Promise((r) => gwServer.listen(GW_PORT, '127.0.0.1', r));
log('\n[gateway] listening on', GW_PORT);

const downstream = new Client(
  { name: 'spike-2-client', version: '0.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
await downstream.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${GW_PORT}/mcp`)));
const merged = await downstream.listTools({}, { cacheMode: 'bypass' });
log('gateway merged tools =', merged.tools.map((t) => t.name).join(','));
const called = await downstream.callTool({ name: 'local_show_env', arguments: {} });
log('through the gateway =', called.content?.[0]?.text?.slice(0, 300));

// ---------------------------------------------------------------------------
// (d) Windows npx resolution: spawn WITHOUT a shell.
// ---------------------------------------------------------------------------
log('\n=== npx resolution probe (no shell) ===');
log('process.platform =', process.platform);
try {
  const probe = await new Promise((resolve, reject) => {
    // verified: spikes/node_modules/@modelcontextprotocol/client/dist/stdio.d.mts (StdioServerParameters.command / args)
    const t = new StdioClientTransport({ command: 'npx', args: ['-y', '--version'], stderr: 'pipe' });
    const out = [];
    let err = '';
    t.stderr?.on('data', (c) => (err += String(c)));
    setTimeout(() => reject(new Error('npx probe timed out after 30s')), 30000).unref?.();
    t.start()
      .then(() => {
        t.onmessage = (m) => {
          if (m?.id === undefined) return;
          t.close().catch(() => {});
          resolve({ out, err: err.slice(0, 200) });
        };
      })
      .catch(reject);
  });
  log('npx probe result =', JSON.stringify(probe));
} catch (err) {
  log('npx probe FAILED =>', err?.message);
}

await downstream.close().catch(() => {});
await stdioClient.close().catch(() => {});
gwServer.close();
log('\nspike-2 done');