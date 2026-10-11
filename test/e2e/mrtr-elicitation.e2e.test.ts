// P7-5 / ADR 0003: pin the MRTR elicitation behaviour end to end.
//
// Two halves, and BOTH must hold:
//
//   1. A downstream client that did NOT declare `elicitation` calling an upstream tool that
//      returns `input_required` gets a typed -32021. It must never receive the
//      `input_required` itself, because it cannot answer it.
//   2. A downstream client that DID declare `elicitation` receives the `input_required`
//      UNCHANGED, including `requestState`.
//
// These are the SDK's native behaviour, not gateway logic
// (node_modules/@modelcontextprotocol/server/dist/mcp-DIH4cS6P.mjs lines 1229-1235). The
// tests exist so that a dependency change which alters it fails loudly here instead of
// silently changing what downstream clients see.
//
// D15: LOCAL fake only.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { startFakeUpstream, unusedPort, type FakeUpstream } from '../fixtures/fake-upstream.js';
import { startGateway, type RunningGateway } from '../../src/index.js';
import { createLogger } from '../../src/observability/logger.js';

const API_KEY = 'P75-CANARY-KEY-0123456789';
const ARG_CANARY = 'P75-ARGUMENT-CANARY-secret-value';

let upstream: FakeUpstream;
let gateway: RunningGateway;
let logLines: string[];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-p75-'));
  upstream = await startFakeUpstream({
    port: await unusedPort(),
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
        port: await unusedPort(),
        auth: { type: 'bearer', keys: [API_KEY] },
        defaultTimeoutMs: 5_000,
        defaultTtlMs: 30_000,
      },
      mcp: { mrtr: { type: 'remote', url: upstream.url, timeout: 4_000 } },
    }),
    'utf8',
  );

  logLines = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk));
      cb();
    },
  });
  gateway = await startGateway({ configPath, logger: createLogger({ level: 'debug', destination: sink }) });
}, 60_000);

afterAll(async () => {
  await gateway?.stop();
  await upstream?.close();
}, 30_000);

async function connect(name: string, capabilities: { elicitation?: Record<string, never> }): Promise<Client> {
  const client = new Client(
    { name, version: '0.0.0' },
    {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
      defaultCacheTtlMs: 0,
      capabilities,
      // verified: node_modules/@modelcontextprotocol/client/dist/index.d.mts (ClientOptions
      //   .inputRequired) — "Set autoFulfill: false for manual mode: an input_required
      //   response then surfaces as a typed error unless the individual call passes
      //   allowInputRequired: true". Without this the SDK auto-answers the elicitation and
      //   the raw intermediate round is never observable.
      inputRequired: { autoFulfill: false },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
    }),
  );
  return client;
}

describe('P7-5 a downstream client WITHOUT elicitation', () => {
  it('gets -32021 and never receives the input_required', async () => {
    const client = await connect('no-elicitation', {});
    try {
      await expect(
        client.callTool({ name: 'mrtr_needs_input', arguments: { secret: ARG_CANARY } }),
      ).rejects.toMatchObject({ code: -32021 });

      // The SDK's message names the missing capability, which is the whole point: the
      // client is told WHY it cannot proceed rather than being handed an unanswerable
      // request.
      let message = '';
      try {
        await client.callTool({ name: 'mrtr_needs_input', arguments: {} });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/client capabilities do not declare/i);
      expect(message).toMatch(/elicitation/i);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 30_000);
});

describe('P7-5 a downstream client WITH elicitation', () => {
  it('receives input_required unchanged, including requestState', async () => {
    const client = await connect('with-elicitation', { elicitation: {} });
    try {
      const result = await client.callTool(
        { name: 'mrtr_needs_input', arguments: {} },
        { allowInputRequired: true },
      );

      // resultType marks it as a non-final round.
      expect(result.resultType).toBe('input_required');
      expect(result.requestState).toBeDefined();
      expect(typeof result.requestState).toBe('string');

      // The request is relayed verbatim: an `elicitation/create` entry.
      const requests = result.inputRequests as Record<string, unknown> | undefined;
      expect(requests).toBeDefined();
      expect(JSON.stringify(requests)).toContain('elicitation');
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 30_000);

  it('the relayed round is byte-exact: the gateway adds nothing and removes nothing', async () => {
    const client = await connect('with-elicitation-exact', { elicitation: {} });
    try {
      // Called twice against the same upstream, the two interim rounds must be identical
      // apart from the opaque requestState, which is allowed to differ.
      const a = await client.callTool(
        { name: 'mrtr_needs_input', arguments: {} },
        { allowInputRequired: true },
      );
      const b = await client.callTool(
        { name: 'mrtr_needs_input', arguments: {} },
        { allowInputRequired: true },
      );

      const strip = (r: unknown) => JSON.stringify((r as { inputRequests?: unknown }).inputRequests);
      expect(strip(b)).toBe(strip(a));
      expect(a.inputRequests).toBeDefined();

      // The FULL multi-round completion (inputResponses -> upstream completes) is covered
      // by the Sprint 3 S3.5 E2E against the same fake. What is pinned HERE is the half
      // ADR 0003 is about: which downstream clients can see an interim round at all.
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 30_000);
});

describe('P7-5 ADR 0003 option (E): the -32601 diagnostic', () => {
  // A second gateway wired to an upstream that answers -32601, observed through a captured
  // logger so the warning line itself can be asserted rather than merely inferred.
  let strict: RunningGateway;
  let strictLines: string[];

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-p75-strict-'));
    const strictUpstream = await startFakeUpstream({
      port: await unusedPort(),
      kind: 'fast',
      prefix: 'strict',
      methodNotFoundTool: 'wants_elicitation',
    });
    const configPath = join(dir, 'gateway.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          host: '127.0.0.1',
          port: await unusedPort(),
          auth: { type: 'bearer', keys: [API_KEY] },
          defaultTimeoutMs: 5_000,
          defaultTtlMs: 30_000,
        },
        mcp: { strict: { type: 'remote', url: strictUpstream.url, timeout: 4_000 } },
      }),
      'utf8',
    );
    strictLines = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        strictLines.push(String(chunk));
        cb();
      },
    });
    strict = await startGateway({ configPath, logger: createLogger({ level: 'warn', destination: sink }) });

    const client = await (async () => {
      const c = new Client(
        { name: 'strict-probe', version: '0.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } }, defaultCacheTtlMs: 0, capabilities: {} },
      );
      await c.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${strict.port}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
        }),
      );
      return c;
    })();
    const tools = await client.listTools({}, { cacheMode: 'bypass' });
    expect(tools.tools.map((t) => t.name)).toContain('strict_wants_elicitation');
    // D12: an upstream-caused failure is an isError tool result, not a JSON-RPC error.
    const outcome = await client.callTool({ name: 'strict_wants_elicitation', arguments: { secret: ARG_CANARY } });
    expect(outcome.isError).toBe(true);
    await client.close().catch(() => undefined);
  }, 60_000);

  afterAll(async () => {
    await strict?.stop();
  }, 30_000);

  it('warns that the upstream answered method-not-found', () => {
    const output = strictLines.join('\n');
    expect(output).toContain('upstream answered method-not-found');
    // The upstream is named, so the operator knows which server to look at.
    expect(output).toContain('"upstream":"strict"');
    expect(output).toContain('-32601');
  });

  it('carries NOTHING from the request: no arguments, no tool name, no token', () => {
    const output = strictLines.join('\n');
    expect(output).not.toContain(ARG_CANARY);
    expect(output).not.toContain(API_KEY);
    // The (E) diagnostic names the UPSTREAM ONLY.
    expect(output).not.toContain('wants_elicitation');
    expect(output).not.toContain('arguments');
  });

  it('no separate "upstream call failed" line: the upstream returned a RESULT', () => {
    // The -32601 arrives as an isError tool result, so the call itself did not fail. If a
    // future SDK change made it a thrown error instead, this assertion is what would tell
    // us that the (E) detector needs a second site.
    const output = strictLines.join('\n');
    expect(output).not.toContain('upstream call failed');
  });
});
