// Sprint 0 probe: S0.3(e) ttlMs/cacheScope, S0.3(h) subscriptions/listen,
// and progress / trace context / abort propagation through the gateway.

import http from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

const UP_PORT = 3121;
const GW_PORT = 3122;
const log = (...a) => console.log(...a);

let progressSeen = 0;
let upstreamAbortSeen = false;
let traceparentSeen = null;

// ---------------------------------------------------------------------------
// Upstream
// ---------------------------------------------------------------------------

const upstreamFactory = () => {
  // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (class McpServer, registerTool)
  const s = new McpServer(
    { name: 'sub-upstream', version: '0.0.1' },
    {
      capabilities: { tools: { listChanged: true } },
      // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (ServerOptions.cacheHints)
      cacheHints: {
        'tools/list': { ttlMs: 20000, cacheScope: 'private' },
        'server/discover': { ttlMs: 900000, cacheScope: 'public' },
      },
    },
  );

  s.registerTool(
    'slow_progress',
    { description: 'Emits progress notifications, then completes.', inputSchema: {} },
    async (_a, ctx) => {
      const token = ctx.mcpReq?._meta?.progressToken ?? ctx._meta?.progressToken;
      for (let i = 1; i <= 3; i += 1) {
        await new Promise((r) => setTimeout(r, 60));
        // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (RequestOptions.onprogress; ServerContext)
        if (token !== undefined) {
          // Progress notifications travel on the response stream of the request.
          ctx.mcpReq.send;
        }
        progressSeen += 1;
      }
      traceparentSeen = ctx.mcpReq?._meta?.traceparent ?? null;
      return { content: [{ type: 'text', text: `progress rounds=${progressSeen}` }] };
    },
  );

  s.registerTool(
    'hang',
    { description: 'Never completes; aborts on cancellation.', inputSchema: {} },
    async (_a, ctx) => {
      await new Promise((resolve, reject) => {
        ctx.mcpReq.signal.addEventListener('abort', () => {
          upstreamAbortSeen = true;
          reject(new Error('upstream observed abort'));
        });
        setTimeout(resolve, 30000);
      });
      return { content: [{ type: 'text', text: 'unreachable' }] };
    },
  );

  s.registerTool(
    'list_probe',
    { description: 'Used to read cache hints on tools/list.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  );

  return s;
};

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

const gatewayFactory = () => {
  // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (class Server, Protocol.setRequestHandler)
  const s = new Server(
    { name: 'gw', version: '0.0.0' },
    {
      capabilities: { tools: { listChanged: true } },
      cacheHints: { 'tools/list': { ttlMs: 5000, cacheScope: 'private' } },
    },
  );

  s.setRequestHandler('tools/list', async () => {
    const r = await upstreamClient.listTools({}, { cacheMode: 'refresh', timeout: 5000 });
    return { tools: r.tools.map((t) => ({ ...t, name: `up_${t.name}` })) };
  });

  s.setRequestHandler('tools/call', async (req, ctx) => {
    const name = req.params.name.slice(3);
    return upstreamClient.callTool(
      { name, arguments: req.params.arguments ?? {} },
      {
        signal: ctx.mcpReq.signal,
        timeout: 4000,
        // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (RequestOptions.onprogress)
        onprogress: (p) => {
          log('[gateway] progress from upstream =>', JSON.stringify(p));
        },
      },
    );
  });

  return s;
};

const upstreamHandler = createMcpHandler(upstreamFactory, { legacy: 'reject' });
const upstreamServer = http.createServer(toNodeHandler(upstreamHandler));
await new Promise((r) => upstreamServer.listen(UP_PORT, '127.0.0.1', r));

const upstreamClient = new Client(
  { name: 'gw-upstream-client', version: '0.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } }, defaultCacheTtlMs: 60000 },
);
// verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts (ClientOptions.listChanged)
upstreamClient.setNotificationHandler('notifications/tools/list_changed', () => {
  log('[gateway] upstream told us tools/list_changed');
});
await upstreamClient.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${UP_PORT}/mcp`)),
);

const gwHandler = createMcpHandler(gatewayFactory, { legacy: 'reject' });
const gwServer = http.createServer(toNodeHandler(gwHandler));
await new Promise((r) => gwServer.listen(GW_PORT, '127.0.0.1', r));

// ---------------------------------------------------------------------------
// (h) subscriptions/listen on the gateway
// ---------------------------------------------------------------------------

log('=== subscriptions/listen against the gateway ===');
const gwClient = new Client(
  { name: 'sub-client', version: '0.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
await gwClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${GW_PORT}/mcp`)));

// verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts (Client.listen(filter, options) -> McpSubscription)
const sub = await gwClient.listen({ toolsListChanged: true }, { timeout: 5000 });
log('listen() ack honoredFilter =>', JSON.stringify(sub.honoredFilter));

const received = [];
// verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts (Client.setNotificationHandler)
gwClient.setNotificationHandler('notifications/tools/list_changed', () => {
  received.push('tools/list_changed');
  log('[client] received notifications/tools/list_changed');
});

// verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (McpHttpHandler.notify.toolsChanged)
gwHandler.notify.toolsChanged();
await new Promise((r) => setTimeout(r, 300));
log('notifications received by the client =>', JSON.stringify(received));

// Upstream path: publish on the upstream, does the gateway forward? (Sprint 3 work)
log('publishing on the UPSTREAM bus...');
upstreamHandler.notify.toolsChanged();
await new Promise((r) => setTimeout(r, 300));
log('notifications after upstream publish =>', JSON.stringify(received));

log('subscription.close()...');
await sub.close();
log('sub.closed =>', await sub.closed);

// ---------------------------------------------------------------------------
// (e) ttlMs / cacheScope as observed by a raw POST
// ---------------------------------------------------------------------------

log('\n=== ttlMs/cacheScope on the wire ===');
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'probe', version: '0.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
async function raw(url, method, params, methodHeader) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': methodHeader ?? method,
      ...(params?.name ? { 'mcp-name': params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { ...ENVELOPE, ...(params?._meta ?? {}) } } }),
  });
  return res.text();
}

const upList = JSON.parse(await raw(`http://127.0.0.1:${UP_PORT}/mcp`, 'tools/list', {}));
log('upstream tools/list ttlMs/cacheScope =>', upList.result.ttlMs, upList.result.cacheScope);
const upDisc = JSON.parse(await raw(`http://127.0.0.1:${UP_PORT}/mcp`, 'server/discover', {}));
log('upstream server/discover ttlMs/cacheScope =>', upDisc.result.ttlMs, upDisc.result.cacheScope);
const gwList = JSON.parse(await raw(`http://127.0.0.1:${GW_PORT}/mcp`, 'tools/list', {}));
log('gateway tools/list ttlMs/cacheScope =>', gwList.result.ttlMs, gwList.result.cacheScope);

// ---------------------------------------------------------------------------
// Progress / abort
// ---------------------------------------------------------------------------

log('\n=== progress + traceparent through the gateway ===');
const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
try {
  const r = await gwClient.callTool(
    { name: 'up_slow_progress', arguments: {}, _meta: { traceparent: tp } },
    { onprogress: (p) => log('[client] progress =>', JSON.stringify(p)), timeout: 8000 },
  );
  log('slow_progress result =>', JSON.stringify(r.content));
} catch (err) {
  log('slow_progress error =>', err?.message);
}

log('\n=== abort propagates downstream -> upstream ===');
const ac = new AbortController();
setTimeout(() => ac.abort(), 300);
try {
  await gwClient.callTool({ name: 'up_hang', arguments: {} }, { signal: ac.signal, timeout: 10000 });
  log('hang: returned (unexpected)');
} catch (err) {
  log('hang aborted =>', err?.constructor?.name, err?.name, '|', err?.message);
}
await new Promise((r) => setTimeout(r, 300));
log('upstream observed abort? =>', upstreamAbortSeen);

await gwClient.close().catch(() => {});
await upstreamClient.close().catch(() => {});
gwServer.close();
upstreamServer.close();
log('\nprobe-subscriptions done');