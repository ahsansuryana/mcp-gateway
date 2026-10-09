// Sprint 0 probe: S0.3(g) progress notifications, trace context forwarding,
// and request-scoped notification plumbing through the gateway.

import http from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

const UP_PORT = 3131;
const GW_PORT = 3132;
const log = (...a) => console.log(...a);

const upstreamFactory = () => {
  // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (class McpServer)
  const s = new McpServer(
    { name: 'prog-upstream', version: '0.0.1' },
    { capabilities: { tools: { listChanged: false } } },
  );

  s.registerTool(
    'counted',
    { description: 'Emits notifications/progress then completes.', inputSchema: {} },
    async (_a, ctx) => {
      const token = ctx.mcpReq._meta?.progressToken;
      const traceparent = ctx.mcpReq._meta?.traceparent;
      log(`[upstream] received progressToken=${String(token)} traceparent=${String(traceparent)}`);
      for (let i = 1; i <= 3; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        if (token === undefined) continue;
        // verified: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress (progress notifications ride the response stream of their request)
        // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (BaseContext.mcpReq.notify)
        await ctx.mcpReq.notify({
          method: 'notifications/progress',
          params: { progressToken: token, progress: i, total: 3, message: `step ${i}` },
        });
      }
      return { content: [{ type: 'text', text: 'counted done' }] };
    },
  );

  return s;
};

const gatewayFactory = () => {
  // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (class Server, Protocol.setRequestHandler)
  const s = new Server(
    { name: 'gw-prog', version: '0.0.0' },
    { capabilities: { tools: { listChanged: false } } },
  );

  s.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'up_counted', description: 'x', inputSchema: { type: 'object', properties: {} } }] }));

  s.setRequestHandler('tools/call', async (req, ctx) => {
    const meta = ctx.mcpReq._meta ?? {};
    const forwardMeta = {};
    // verified: https://modelcontextprotocol.io/specification/2026-07-28/changelog (minor change 2: trace context via _meta keys traceparent/tracestate/baggage)
    for (const k of ['progressToken', 'traceparent', 'tracestate', 'baggage']) {
      if (meta[k] !== undefined) forwardMeta[k] = meta[k];
    }
    log('[gateway] forwarding _meta keys =', Object.keys(forwardMeta).join(',') || '(none)');

    return upstreamClient.callTool(
      { name: 'counted', arguments: {}, _meta: forwardMeta },
      {
        timeout: 5000,
        signal: ctx.mcpReq.signal,
        // verified: spikes/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts (RequestOptions.onprogress)
        onprogress: async (p) => {
          const downstreamToken = meta.progressToken;
          if (downstreamToken === undefined) return;
          await ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: {
              progressToken: downstreamToken,
              progress: p.progress,
              total: p.total,
              message: `[gw] ${p.message ?? ''}`,
            },
          });
        },
      },
    );
  });

  return s;
};

const upstreamServer = http.createServer(toNodeHandler(createMcpHandler(upstreamFactory, { legacy: 'reject' })));
await new Promise((r) => upstreamServer.listen(UP_PORT, '127.0.0.1', r));

const upstreamClient = new Client(
  { name: 'gw-up', version: '0.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
await upstreamClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${UP_PORT}/mcp`)));

const gwServer = http.createServer(toNodeHandler(createMcpHandler(gatewayFactory, { legacy: 'reject' })));
await new Promise((r) => gwServer.listen(GW_PORT, '127.0.0.1', r));

const client = new Client(
  { name: 'prog-client', version: '0.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${GW_PORT}/mcp`)));

const TP = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const seen = [];
const result = await client.callTool(
  { name: 'up_counted', arguments: {}, _meta: { traceparent: TP } },
  {
    timeout: 8000,
    onprogress: (p) => {
      seen.push(p);
      log('[client] progress =>', JSON.stringify(p));
    },
  },
);
log('result =>', JSON.stringify(result.content));
log('progress notifications seen by the client =>', seen.length);

await client.close().catch(() => {});
await upstreamClient.close().catch(() => {});
gwServer.close();
upstreamServer.close();
log('\nprobe-progress done');