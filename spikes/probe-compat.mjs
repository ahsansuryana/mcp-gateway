// Sprint 0 probe: S0.3(j) protocol-version compatibility matrix.
//
// Question being answered:
//   - Does the SDK v2 SERVER accept 2025-era (initialize-based) clients?
//   - Does the SDK v2 CLIENT speak to a 2025-only server?
//   - What happens with an unknown/unsupported protocol version?

import http from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  McpServer,
  Server,
  createMcpHandler,
  isLegacyRequest,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

const PORT_STATELESS = 3111;
const PORT_REJECT = 3112;
const PORT_LEGACYONLY = 3113;
const log = (...a) => console.log(...a);

// verified: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http (Request Metadata: per-request _meta envelope is mandatory)
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'probe-compat', version: '0.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const factory = () => {
  // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (class McpServer)
  const s = new McpServer({ name: 'compat-fake', version: '0.0.1' }, { capabilities: { tools: {} } });
  s.registerTool('ping_tool', { description: 'pong', inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  return s;
};

// (1) createMcpHandler with the DEFAULT legacy option (2025-era serving).
const stateles = http.createServer(toNodeHandler(createMcpHandler(factory)));
// (2) createMcpHandler with legacy: 'reject' (modern-only strict).
const reject = http.createServer(toNodeHandler(createMcpHandler(factory, { legacy: 'reject' })));
// (3) A hand-wired legacy server: the v1-style wire, forced onto a 2025 revision.
const legacyOnly = http.createServer(
  toNodeHandler(
    createMcpHandler(factory, {
      legacy: 'reject',
    }),
  ),
);

for (const [p, name] of [
  [PORT_STATELESS, 'stateless-default'],
  [PORT_REJECT, 'legacy-reject'],
  [PORT_LEGACYONLY, 'modern-only'],
]) {
  const srv = name === 'stateless-default' ? stateles : name === 'legacy-reject' ? reject : legacyOnly;
  await new Promise((r) => srv.listen(p, '127.0.0.1', r));
  log(`[${name}] listening on ${p}`);
}

// ---------------------------------------------------------------------------
// isLegacyRequest predicate: how the entry decides era.
// ---------------------------------------------------------------------------
log('\n=== isLegacyRequest classification ===');
{
  const modernBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
  };
  const initBody = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };

  const mk = (body) =>
    new Request('http://x/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (function isLegacyRequest)
  log('modern tools/list classified legacy? ', await isLegacyRequest(mk(modernBody)));
  log('2025 initialize classified legacy?   ', await isLegacyRequest(mk(initBody)));
}

// ---------------------------------------------------------------------------
// Client behaviour matrix.
// ---------------------------------------------------------------------------
async function tryConnect(label, url, opts, doList) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  // verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts (class Client, options.versionNegotiation)
  const client = new Client({ name: 'compat-probe', version: '0.0.0' }, opts);
  try {
    await client.connect(transport);
    const disc = client.getDiscoverResult();
    log(`${label}: connect OK; discover=${disc ? JSON.stringify(disc.supportedVersions) : 'n/a'}`);
    if (doList) {
      const tools = await client.listTools({}, { cacheMode: 'bypass' });
      log(`${label}: tools = ${tools.tools.map((t) => t.name).join(',')}`);
    }
  } catch (err) {
    log(`${label}: FAILED -> ${err?.constructor?.name}: ${err?.message}`);
  } finally {
    await client.close().catch(() => {});
  }
}

log('\n=== client/server matrix ===');
// Default client (legacy mode) -> modern server: must fail or fall back.
await tryConnect('default-client -> modern-only server', `http://127.0.0.1:${PORT_LEGACYONLY}/mcp`, {}, true);
// Default client (legacy mode) -> server that also serves 2025: must succeed.
await tryConnect('default-client -> stateless-default server', `http://127.0.0.1:${PORT_STATELESS}/mcp`, {}, true);
// auto mode -> modern-only server.
await tryConnect(
  'auto-client -> modern-only server',
  `http://127.0.0.1:${PORT_LEGACYONLY}/mcp`,
  { versionNegotiation: { mode: 'auto' } },
  true,
);
// pinned -> modern-only server.
await tryConnect(
  'pinned-2026-07-28 client -> modern-only server',
  `http://127.0.0.1:${PORT_LEGACYONLY}/mcp`,
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  true,
);
// auto mode -> strict server that rejects legacy.
await tryConnect(
  'auto-client -> legacy-reject server',
  `http://127.0.0.1:${PORT_REJECT}/mcp`,
  { versionNegotiation: { mode: 'auto' } },
  true,
);
// pin a version the server does not implement.
await tryConnect(
  'pinned-1999-01-01 client -> stateless-default server',
  `http://127.0.0.1:${PORT_STATELESS}/mcp`,
  { versionNegotiation: { mode: { pin: '1999-01-01' } } },
  true,
);

// ---------------------------------------------------------------------------
// Raw wire: an unknown MCP-Protocol-Version header against the modern endpoint.
// ---------------------------------------------------------------------------
log('\n=== raw unknown MCP-Protocol-Version ===');
{
  const res = await fetch(`http://127.0.0.1:${PORT_REJECT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '1999-01-01',
      'mcp-method': 'tools/list',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { ...ENVELOPE, 'io.modelcontextprotocol/protocolVersion': '1999-01-01' } },
    }),
  });
  log('status', res.status, '=>', (await res.text()).slice(0, 400));
}

log('\n=== raw GET and DELETE on the MCP endpoint ===');
for (const method of ['GET', 'DELETE']) {
  const res = await fetch(`http://127.0.0.1:${PORT_STATELESS}/mcp`, { method });
  log(method, '->', res.status, (await res.text()).slice(0, 160));
}

log('\n=== raw header/body mismatch (Mcp-Method) ===');
{
  const res = await fetch(`http://127.0.0.1:${PORT_REJECT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { ...ENVELOPE } },
    }),
  });
  log('status', res.status, '=>', (await res.text()).slice(0, 400));
}

log('\n=== raw missing Mcp-Method header ===');
{
  const res = await fetch(`http://127.0.0.1:${PORT_REJECT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { ...ENVELOPE } },
    }),
  });
  log('status', res.status, '=>', (await res.text()).slice(0, 400));
}

log('\n=== body over the size limit (default 4 MiB, expect 413) ===');
{
  const big = 'x'.repeat(5 * 1024 * 1024);
  const res = await fetch(`http://127.0.0.1:${PORT_REJECT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/list',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { ...ENVELOPE }, pad: big },
    }),
  });
  log('status', res.status, '=>', (await res.text()).slice(0, 200));
}

log('\n=== Origin validation with the SDK helper in front ===');
{
  // verified: spikes/node_modules/@modelcontextprotocol/server/dist/index.d.mts (originValidationResponse)
  const handlerNode = toNodeHandler(createMcpHandler(factory, { legacy: 'reject' }));
  const guarded = http.createServer((req, res) => {
    void (async () => {
      const origin = req.headers.origin;
      const rejected = originValidationResponse(
        new Request('http://x/mcp', { headers: origin ? { origin } : {} }),
        ['allowed.example'],
      );
      if (rejected) {
        res.writeHead(rejected.status, Object.fromEntries(rejected.headers));
        res.end(await rejected.text());
        return;
      }
      await handlerNode(req, res);
    })();
  });
  await new Promise((r) => guarded.listen(3114, '127.0.0.1', r));

  for (const origin of ['https://evil.example', 'https://allowed.example', 'null', undefined]) {
    const res = await fetch('http://127.0.0.1:3114/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { ...ENVELOPE } },
      }),
    });
    log(`origin=${String(origin)} -> status ${res.status}`);
  }
  guarded.close();
}

for (const srv of [stateles, reject, legacyOnly]) srv.close();
log('\nprobe-compat done');