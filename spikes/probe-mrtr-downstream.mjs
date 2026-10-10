// PROBE (P7-5): does the SDK server seam ALREADY refuse to relay an upstream
// `input_required` to a downstream request that did not declare `elicitation`?
//
// ADR 0003 and the human's stated condition assume the gateway would have to ADD this.
// If the SDK already does it, implementing it again would replace a typed, spec-aligned
// error with a custom tool result.
//
// Not a test. Run with: npx tsx spikes/probe-mrtr-downstream.mjs

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startFakeUpstream } from '../test/fixtures/fake-upstream.js';

const dir = mkdtempSync(join(tmpdir(), 'probe-mrtr-'));
const up = await startFakeUpstream({
  port: 30000 + Math.floor(Math.random() * 20000),
  kind: 'fast',
  prefix: 'mrtr',
  withMrtr: true,
});

const configPath = join(dir, 'gateway.json');
writeFileSync(
  configPath,
  JSON.stringify({
    gateway: {
      host: '127.0.0.1',
      port: 30000 + Math.floor(Math.random() * 20000),
      auth: { type: 'bearer', keys: ['PROBE-KEY-0123456789'] },
      defaultTimeoutMs: 5000,
      defaultTtlMs: 30000,
    },
    mcp: { mrtr: { type: 'remote', url: up.url, timeout: 4000 } },
  }),
);

const { startGateway } = await import('../src/index.js');
const gateway = await startGateway({ configPath, logLevel: 'silent' });

// A downstream client that declares NOTHING: no elicitation.
const plain = new Client(
  { name: 'probe-plain', version: '0.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } }, defaultCacheTtlMs: 0, capabilities: {} },
);

await plain.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer PROBE-KEY-0123456789' } },
  }),
);

console.log('downstream capabilities:', JSON.stringify(plain.getCapabilities?.() ?? null));

try {
  const result = await plain.callTool({ name: 'mrtr_needs_input', arguments: {} });
  console.log('RESULT type     :', 'tool result');
  console.log('RESULT isError  :', result.isError);
  console.log('RESULT content  :', JSON.stringify(result.content));
} catch (err) {
  console.log('RESULT type     : JSON-RPC ERROR (thrown)');
  console.log('name            :', err?.name);
  console.log('code            :', err?.code);
  console.log('message         :', String(err?.message).slice(0, 220));
}

await plain.close().catch(() => undefined);
await gateway.stop();
await up.close();
process.exit(0);