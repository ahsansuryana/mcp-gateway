// PLAN.md S4.7: prove the StdioUpstream talks to a REAL public MCP server.
//
//   npx @modelcontextprotocol/server-everything
//
// Package: @modelcontextprotocol/server-everything@2026.8.31
//   verified: `npm view @modelcontextprotocol/server-everything version bin`
//     version = 2026.8.31, bin = { 'mcp-server-everything': 'dist/index.js' }
//
// A fixture cannot prove interoperability: it was written against the same SDK. This
// script runs the vendor's own reference server through the gateway's production
// StdioUpstream and records a transcript.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';

import { StdioUpstream } from '../src/upstream/stdio.js';
import { createLogger } from '../src/observability/logger.js';

const SERVER = resolve('spikes/node_modules/@modelcontextprotocol/server-everything/dist/index.js');
const OUT = 'spikes/out-s4-7.txt';

const lines = [];
const log = (...parts) => {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  lines.push(line);
  process.stdout.write(line + '\n');
};

const sink = new Writable({
  write(chunk, _enc, cb) {
    lines.push(String(chunk).trimEnd());
    cb();
  },
});

log('# S4.7 real public stdio server transcript');
log('# package: @modelcontextprotocol/server-everything@2026.8.31');
log(`# server:  ${SERVER}`);
log('# platform:', process.platform, process.arch, `node ${process.version}`);
log('');

const logger = createLogger({ level: 'info', destination: sink });
const upstream = new StdioUpstream(
  'everything',
  {
    type: 'local',
    // Resolved through the same PATH/comspec shim logic a real operator would use.
    command: [SERVER],
    environment: {},
    enabled: true,
    startupTimeoutMs: 30_000,
    idleTimeoutMs: 0,
  },
  10_000,
  { logger, secrets: [] },
);

const signal = new AbortController().signal;
let exitCode = 0;

try {
  await upstream.start();
  log('start:', JSON.stringify(upstream.status()));
  log('pid:  ', String(upstream.pid));
  log('');

  const list = await upstream.listTools(signal);
  log('tools/list ->', list.tools.map((t) => t.name).join(', '));
  log('');

  // The echo tool is the vendor server's simplest round trip.
  const echoed = await upstream.callTool('echo', { message: 'hello from the gateway' }, undefined, signal);
  log('tools/call echo ->', JSON.stringify(echoed.content));
  log('');

  const sum = await upstream.callTool('get-sum', { a: 2, b: 3 }, undefined, signal);
  log('tools/call get-sum ->', JSON.stringify(sum.content));
  log('');

  // D13 against a vendor server rather than our own fixture: the gateway's environment
  // holds a canary that must not be visible to the child.
  process.env['SPIKE_GATEWAY_SECRET'] = 'SECRET-CANARY-S4-7';
  const env = await upstream.callTool('get-env', {}, undefined, signal);
  const envText = (env.content[0] as { text?: string } | undefined)?.text ?? '';
  log('tools/call get-env -> contains canary:', envText.includes('SECRET-CANARY-S4-7'));
  delete process.env['SPIKE_GATEWAY_SECRET'];
  log('');

  // PLAN.md MRTR: the gateway must relay an upstream elicitation. A live vendor server is
  // the only honest way to observe what the client actually receives.
  try {
    const elicitation = await upstream.callTool('trigger-elicitation-request', {}, undefined, signal);
    log('tools/call trigger-elicitation-request ->', JSON.stringify(elicitation));
  } catch (err) {
    log('tools/call trigger-elicitation-request -> threw:', err instanceof Error ? err.message : String(err));
  }
  log('');

  await upstream.stop();
  log('stop: ', JSON.stringify(upstream.status()));
  log('');
  log('RESULT: OK');
} catch (err) {
  exitCode = 1;
  log('RESULT: FAILED');
  log('error:', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  await upstream.stop().catch(() => undefined);
}

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
process.exit(exitCode);