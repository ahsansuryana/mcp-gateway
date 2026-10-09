// Sprint 0 spike 1: gateway-style proxy over a remote Streamable HTTP upstream.
//
// Purpose: prove the wiring that PLAN.md S0.3(a)-(e) depends on, end to end,
// against the real SDK v2 packages. This file is throwaway and is never
// imported by src/.

import http from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  INVALID_PARAMS,
  McpServer,
  ProtocolError,
  Server,
  createMcpHandler,
  inputRequired,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

const UPSTREAM_PORT = 3101;
const GATEWAY_PORT = 3102;
const UPSTREAM_URL = `http://127.0.0.1:${UPSTREAM_PORT}/mcp`;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}/mcp`;
const UPSTREAM_TOKEN = 'SECRET-CANARY-UPSTREAM';

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// Fake upstream MCP server: 2 tools.
// ---------------------------------------------------------------------------

// verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (class McpServer, registerTool)
const upstreamFactory = () => {
  const server = new McpServer(
    { name: 'fake-upstream', version: '0.0.1' },
    {
      capabilities: { tools: { listChanged: false } },
      // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (ServerOptions.cacheHints)
      cacheHints: { 'tools/list': { ttlMs: 15000, cacheScope: 'private' } },
    },
  );

  server.registerTool(
    'echo',
    {
      title: 'Echo',
      description: 'Echo back the input, namespaced by the gateway.',
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({ content: [{ type: 'text', text: `upstream-echo:${text}` }] }),
  );

  server.registerTool(
    'boom',
    {
      description: 'Always fails at the tool level (isError: true).',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: 'upstream deliberately failed' }],
      isError: true,
    }),
  );

  // MRTR probe: first round asks for input, second round completes.
  server.registerTool(
    'needs_input',
    {
      description: 'Returns input_required once, then completes on the retry.',
      inputSchema: {},
    },
    async (_args, ctx) => {
      const responses = ctx.mcpReq.inputResponses;
      if (responses && Object.keys(responses).length > 0) {
        return {
          content: [
            {
              type: 'text',
              text: `upstream-mrtr:complete state=${String(ctx.mcpReq.requestState())}`,
            },
          ],
        };
      }
      // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (const inputRequired)
      return inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: 'Proceed?',
            requestedSchema: z.object({ proceed: z.boolean() }),
          }),
        },
        requestState: 'upstream-minted-state',
      });
    },
  );

  return server;
};

const upstreamServer = http.createServer(
  toNodeHandler(
    createMcpHandler(upstreamFactory, {
      // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (CreateMcpHandlerOptions.legacy)
      legacy: 'reject',
      maxRequestBodySize: 1024 * 1024,
    }),
  ),
);

await new Promise((r) => upstreamServer.listen(UPSTREAM_PORT, '127.0.0.1', r));
log(`[upstream] listening on ${UPSTREAM_URL}`);

// ---------------------------------------------------------------------------
// The gateway's upstream connection (remote Streamable HTTP client + headers).
// ---------------------------------------------------------------------------

// verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts (StreamableHTTPClientTransportOptions.requestInit)
const upstreamTransport = new StreamableHTTPClientTransport(new URL(UPSTREAM_URL), {
  requestInit: {
    headers: {
      Authorization: `Bearer ${UPSTREAM_TOKEN}`,
      'X-Gateway-Test': 'spike-1',
    },
  },
});

const upstreamClient = new Client(
  { name: 'mcp-gateway-spike', version: '0.0.0' },
  {
    // verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts (ClientOptions.versionNegotiation)
    versionNegotiation: { mode: { pin: '2026-07-28' } },
    capabilities: { elicitation: {} },
  },
);

upstreamTransport.onmessage = (m) => log('[upstream<-gateway] recv', JSON.stringify(m).slice(0, 120));
await upstreamClient.connect(upstreamTransport);
const discover = await upstreamClient.getDiscoverResult();
log('[gateway] upstream server/discover =>', JSON.stringify(discover));

// ---------------------------------------------------------------------------
// Gateway: aggregated, stateless POST /mcp with DYNAMIC low-level handlers.
// ---------------------------------------------------------------------------

const gatewayFactory = () => {
  // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (class Server)
  const server = new Server(
    { name: 'mcp-gateway-spike', version: '0.0.0' },
    {
      capabilities: { tools: { listChanged: false } },
      // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (ServerOptions.cacheHints)
      cacheHints: {
        'tools/list': { ttlMs: 10000, cacheScope: 'private' },
        'server/discover': { ttlMs: 60000, cacheScope: 'private' },
      },
    },
  );

  // Dynamic list handler: no registerTool, the list is computed per request.
  // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (Protocol.setRequestHandler)
  server.setRequestHandler('tools/list', async () => {
    const res = await upstreamClient.listTools({}, { timeout: 5000 });
    const tools = res.tools.map((t) => ({ ...t, name: `upstream_${t.name}` }));
    tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    log('[gateway] tools/list merged names =', tools.map((t) => t.name).join(', '));
    return { tools };
  });

  // Dynamic call handler: split at the FIRST underscore (D4) and route.
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const name = request.params.name;
    const idx = name.indexOf('_');
    if (idx < 1 || !name.startsWith('upstream_')) {
      // Unknown namespaced tool is a protocol error, not a tool error (D12).
      // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (class ProtocolError; INVALID_PARAMS === -32602)
      throw new ProtocolError(INVALID_PARAMS, `Unknown tool: ${name}`);
    }
    const upstreamName = name.slice(idx + 1);
    try {
      // MRTR round-trip: the seam lifts `inputResponses` / `requestState` out of
      // params into ctx.mcpReq, so a proxy MUST re-attach them explicitly.
      // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (ServerContext.mcpReq.inputResponses / .requestState)
      const requestState = ctx.mcpReq.requestState();
      const forwardParams = {
        name: upstreamName,
        arguments: request.params.arguments ?? {},
        ...(ctx.mcpReq.inputResponses ? { inputResponses: ctx.mcpReq.inputResponses } : {}),
        ...(typeof requestState === 'string' ? { requestState } : {}),
      };
      log('[gateway] tools/call forward params keys =', Object.keys(forwardParams).join(','));

      // verified: spikes/node_modules/@modelcontextprotocol/client/dist/index.d.mts (Client.callTool)
      const result = await upstreamClient.callTool(forwardParams, {
        signal: ctx.mcpReq.signal,
        timeout: 5000,
        allowInputRequired: true,
      });
      // The upstream result (including resultType: "input_required") is
      // forwarded unchanged.
      return result;
    } catch (err) {
      // D12: upstream failures become isError tool results, never JSON-RPC errors.
      return {
        content: [
          { type: 'text', text: `Upstream 'upstream' is unavailable: ${err?.message ?? String(err)}` },
        ],
        isError: true,
      };
    }
  });

  return server;
};

const gatewayServer = http.createServer(
  toNodeHandler(createMcpHandler(gatewayFactory, { legacy: 'stateless', maxRequestBodySize: 1024 * 1024 })),
);

await new Promise((r) => gatewayServer.listen(GATEWAY_PORT, '127.0.0.1', r));
log(`[gateway] listening on ${GATEWAY_URL}`);

// ---------------------------------------------------------------------------
// (b) Raw wire check: what a 2026-07-28 client actually POSTs.
// ---------------------------------------------------------------------------

async function rawPost(body, headers = {}) {
  const res = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': body.method,
      ...(body.params?.name ? { 'mcp-name': body.params.name } : {}),
      ...(body.params?.uri ? { 'mcp-name': body.params.uri } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type'), text };
}

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'spike-raw', version: '0.0.0' },
  'io.modelcontextprotocol/clientCapabilities': { elicitation: {} },
};

log('\n=== raw POST server/discover ===');
const rawDiscover = await rawPost({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } });
log('status', rawDiscover.status, 'content-type', rawDiscover.contentType);
log(rawDiscover.text.slice(0, 700));

log('\n=== raw POST tools/list ===');
const rawList = await rawPost({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } });
log('status', rawList.status, 'content-type', rawList.contentType);
log(rawList.text.slice(0, 700));

log('\n=== raw POST tools/call unknown namespaced tool (expect -32602) ===');
const rawUnknown = await rawPost({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'nope_missing', arguments: {}, _meta: meta },
});
log(rawUnknown.text.slice(0, 400));

log('\n=== raw POST tools/call upstream_boom (expect isError tool result) ===');
const rawBoom = await rawPost({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: { name: 'upstream_boom', arguments: {}, _meta: meta },
});
log(rawBoom.text.slice(0, 500));

// ---------------------------------------------------------------------------
// (f) SDK client against the gateway, with MRTR auto-fulfilment.
// ---------------------------------------------------------------------------

log('\n=== SDK client (modern era) against the gateway ===');
const gatewayTransport = new StreamableHTTPClientTransport(new URL(GATEWAY_URL));
const gatewayClient = new Client(
  { name: 'spike-1-client', version: '0.0.0' },
  {
    versionNegotiation: { mode: { pin: '2026-07-28' } },
    capabilities: { elicitation: {} },
    defaultCacheTtlMs: 0,
  },
);

// Auto-fulfil the gateway-forwarded elicitation.
gatewayClient.setRequestHandler('elicitation/create', async (request) => {
  log('[gateway-client] elicitation/create =>', request.params.message);
  return { action: 'accept', content: { proceed: true } };
});

await gatewayClient.connect(gatewayTransport);
const gatewayDiscover = await gatewayClient.getDiscoverResult();
log('gateway server/discover =>', JSON.stringify(gatewayDiscover));

const listed = await gatewayClient.listTools({}, { cacheMode: 'bypass' });
log('tools/list names =>', listed.tools.map((t) => t.name).join(', '));

const echoed = await gatewayClient.callTool({ name: 'upstream_echo', arguments: { text: 'hi' } });
log('callTool upstream_echo =>', JSON.stringify(echoed));

log('\n=== MRTR: gateway forwards input_required unchanged, client auto-fulfils ===');
try {
  const mrtr = await gatewayClient.callTool({ name: 'upstream_needs_input', arguments: {} });
  log('callTool upstream_needs_input =>', JSON.stringify(mrtr).slice(0, 400));
} catch (err) {
  log('MRTR error:', err?.message);
}

// ---------------------------------------------------------------------------
// (g) AbortSignal + timeout.
// ---------------------------------------------------------------------------

log('\n=== timeout on the upstream call ===');
try {
  await upstreamClient.callTool({ name: 'echo', arguments: { text: 'x' } }, { timeout: 1 });
  log('timeout: NOT thrown (unexpected)');
} catch (err) {
  log('timeout threw =>', err?.constructor?.name, '| code =', err?.code, '|', err?.message);
}

// ---------------------------------------------------------------------------
// Cleanup.
// ---------------------------------------------------------------------------

await gatewayClient.close().catch(() => {});
await upstreamClient.close().catch(() => {});
gatewayServer.close();
upstreamServer.close();
log('\nspike-1 done');