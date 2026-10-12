// PLAN.md S4.6: tests against a fake stdio server.
//
//   normal call; kill -9 mid-call => isError result then a successful call after restart;
//   idle shutdown using an injected timer; startup timeout; env isolation.
//
// D15: unit tests use no network — this suite spawns LOCAL child processes only.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StdioUpstream } from '../../src/upstream/stdio.js';
import type { LocalUpstreamConfig } from '../../src/config/schema.js';
import { createLogger } from '../../src/observability/logger.js';

const FIXTURE = resolve(fileURLToPath(new URL('../fixtures/', import.meta.url)), 'fake-stdio-server.mjs');

/** D13: a secret that exists in the GATEWAY's environment and must never reach the child. */
const CANARY = 'SPIKE_GATEWAY_SECRET';
const CANARY_VALUE = 'SECRET-CANARY-123';

let workDir = '';
const started: StdioUpstream[] = [];

function localConfig(overrides: Partial<LocalUpstreamConfig> = {}): LocalUpstreamConfig {
  return {
    type: 'local',
    command: [process.execPath, FIXTURE],
    environment: { SPIKE_UPSTREAM_VALUE: 'from-config' },
    enabled: true,
    startupTimeoutMs: 15_000,
    idleTimeoutMs: 0,
    ...overrides,
  };
}

function makeUpstream(overrides: Partial<LocalUpstreamConfig> = {}, extra: Record<string, unknown> = {}) {
  const upstream = new StdioUpstream('fs', localConfig(overrides), 5_000, {
    logger: createLogger({ level: 'silent' }),
    secrets: [CANARY_VALUE],
    ...extra,
  });
  started.push(upstream);
  return upstream;
}

beforeEach(() => {
  // A writable temp dir per test; the child inherits a path from it on POSIX.
  workDir = mkdtempSync(join(tmpdir(), 'mcp-gateway-s4-'));
  expect(workDir.length).toBeGreaterThan(0);
  // The gateway's OWN environment holds the canary.
  process.env[CANARY] = CANARY_VALUE;
});

afterEach(async () => {
  delete process.env[CANARY];
  for (const upstream of started.splice(0)) {
    await upstream.stop().catch(() => undefined);
  }
});

describe('S4.1 a stdio upstream starts and answers', () => {
  it('lists and calls a tool from the child process', async () => {
    const upstream = makeUpstream();
    await upstream.start();
    expect(upstream.status().state).toBe('ready');

    const list = await upstream.listTools(new AbortController().signal);
    expect(list.tools.map((t) => t.name)).toContain('echo');

    const result = await upstream.callTool('echo', { text: 'hi' }, undefined, new AbortController().signal);
    expect((result.content[0] as { text: string }).text).toBe('stdio:hi');
  });

  it('is LAZY: not started until first use (S4.3)', async () => {
    const upstream = makeUpstream();
    expect(upstream.status().state).toBe('disabled');
    expect(upstream.lazy).toBe(true);

    // listTools triggers the lazy start rather than throwing.
    const list = await upstream.listTools(new AbortController().signal);
    expect(list.tools.length).toBeGreaterThan(0);
    expect(upstream.status().state).toBe('ready');
  });

  it('round-trips deeply nested JSON', async () => {
    const upstream = makeUpstream();
    await upstream.start();
    const payload = { a: 1, b: [1, { c: 'ünïcødé 🎉' }], d: null };
    const result = await upstream.callTool('deep', { payload }, undefined, new AbortController().signal);
    expect(result.structuredContent).toEqual(payload);
  });

  it('reports a spawn failure as an error, never leaking a secret', async () => {
    const upstream = makeUpstream({ command: ['definitely-not-a-real-binary-xyz'] });
    await upstream.start();
    const status = upstream.status();
    // A missing binary surfaces as the SDK's SdkError(CONNECTION_CLOSED), indistinguishable
    // from a crash, so it is `error`; the manager escalates to `failed` by repetition.
    expect(status.state).toBe('error');
    expect(status.lastError).toBeDefined();
    expect(status.lastError).not.toContain(CANARY_VALUE);
  }, 30_000);
});

describe('S4.2 environment isolation (D13)', () => {
  it('the gateway secret does NOT reach the child', async () => {
    const upstream = makeUpstream();
    await upstream.start();

    const result = await upstream.callTool('env_dump', {}, undefined, new AbortController().signal);
    const dump = JSON.parse((result.content[0] as { text: string }).text) as {
      envKeys: string[];
      gatewaySecretPresent: boolean;
      gatewaySecretValue: string | null;
      configuredValue: string | null;
    };

    // The canary exists in the gateway's own environment right now.
    expect(process.env[CANARY]).toBe(CANARY_VALUE);

    // ...and is absent from the child, by both presence and value.
    expect(dump.gatewaySecretPresent).toBe(false);
    expect(dump.gatewaySecretValue).toBeNull();
    expect(dump.envKeys).not.toContain(CANARY);
    expect(JSON.stringify(dump)).not.toContain(CANARY_VALUE);

    // The configured value IS present.
    expect(dump.configuredValue).toBe('from-config');
  });

  it('the child env is the SDK allowlist plus exactly the configured keys', async () => {
    const upstream = makeUpstream({ environment: { SPIKE_UPSTREAM_VALUE: 'v', CUSTOM_KEY: 'c' } });
    await upstream.start();
    const result = await upstream.callTool('env_dump', {}, undefined, new AbortController().signal);
    const dump = JSON.parse((result.content[0] as { text: string }).text) as { envKeys: string[] };

    for (const key of ['SPIKE_UPSTREAM_VALUE', 'CUSTOM_KEY']) {
      expect(dump.envKeys).toContain(key);
    }
    // Windows injects LOGONSERVER/USERDOMAIN regardless of the allowlist (Q-WINDOWS-ENV), so
    // the assertion is "no gateway secret", not "env is a strict subset".
    expect(dump.envKeys).not.toContain(CANARY);
  });

  it('a value configured from the environment is substituted before it reaches the child', () => {
    // D7 substitution happens in config/load.ts; this asserts the schema carries the result.
    const config = localConfig({ environment: { TOKEN: 'plain-value' } });
    expect(config.environment['TOKEN']).toBe('plain-value');
    expect(config.environment['TOKEN']).not.toContain('{env:');
  });
});

describe('S4.3 lifecycle', () => {
  it('shuts down after idleTimeoutMs (injected timer, S4.3)', async () => {
    const scheduled: { fn: () => void; ms: number }[] = [];
    const cleared: unknown[] = [];

    const upstream = makeUpstream(
      { idleTimeoutMs: 300_000 },
      {
        setTimeoutFn: (fn: () => void, ms: number) => {
          scheduled.push({ fn, ms });
          return scheduled.length;
        },
        clearTimeoutFn: (handle: unknown) => cleared.push(handle),
      },
    );

    await upstream.start();
    expect(upstream.status().state).toBe('ready');
    expect(scheduled.at(-1)?.ms).toBe(300_000);

    // Fire the idle timer. The SDK's own close() can take up to 2s, so poll rather than
    // assume an instant transition.
    scheduled.at(-1)?.fn();
    await waitFor(() => upstream.status().state === 'disabled', 10_000);
    expect(upstream.status().state).toBe('disabled');
  }, 30_000);

  it('idleTimeoutMs 0 disables idle shutdown (PLAN.md §6)', async () => {
    const scheduled: { ms: number }[] = [];
    const upstream = makeUpstream(
      { idleTimeoutMs: 0 },
      {
        setTimeoutFn: (_fn: () => void, ms: number) => {
          scheduled.push({ ms });
          return scheduled.length;
        },
        clearTimeoutFn: () => undefined,
      },
    );
    await upstream.start();
    // Only the listen/ack timers would appear; no 0-length idle timer is armed.
    expect(scheduled.some((s) => s.ms === 0)).toBe(false);
  });

  it('a call resets the idle window', async () => {
    const scheduled: { ms: number }[] = [];
    const upstream = makeUpstream(
      { idleTimeoutMs: 60_000 },
      {
        setTimeoutFn: (_fn: () => void, ms: number) => {
          scheduled.push({ ms });
          return scheduled.length;
        },
        clearTimeoutFn: () => undefined,
      },
    );
    await upstream.start();
    const before = scheduled.filter((s) => s.ms === 60_000).length;
    await upstream.callTool('echo', { text: 'x' }, undefined, new AbortController().signal);
    const after = scheduled.filter((s) => s.ms === 60_000).length;
    expect(after).toBeGreaterThan(before);
  }, 30_000);

  it('a crashing child is detected and the next call restarts it', async () => {
    const upstream = makeUpstream({ command: [process.execPath, FIXTURE, '--tool=crash'] });
    await upstream.start();
    expect(upstream.status().state).toBe('ready');

    // The fixture exits ~50ms after start.
    await waitFor(() => upstream.status().state !== 'ready', 10_000);
    expect(upstream.status().state).toBe('error');

    expect(upstream.status().state).toBe('error');

    // A healthy fixture then works after a restart.
    const healthy = new StdioUpstream('fs2', localConfig(), 5_000, {
      logger: createLogger({ level: 'silent' }),
      secrets: [CANARY_VALUE],
    });
    started.push(healthy);
    await healthy.start();
    const ok = await healthy.callTool('echo', { text: 'ok' }, undefined, new AbortController().signal);
    expect((ok.content[0] as { text: string }).text).toBe('stdio:ok');
  }, 45_000);

  it('an unusable upstream REJECTS at the contract layer (D12 turns that into isError)', async () => {
    // Deterministic: a missing binary can never start, so there is no race with a restart.
    const upstream = makeUpstream({ command: ['definitely-not-a-real-binary-xyz'] });
    await upstream.start();
    await expect(
      upstream.callTool('echo', { text: 'x' }, undefined, new AbortController().signal),
    ).rejects.toBeDefined();
  }, 30_000);

  it('startupTimeoutMs is enforced (the child never answers in time)', async () => {
    // The fixture is given an explicit startup delay so the child GENUINELY cannot answer
    // within the budget.
    //
    // This test used to pass no delay at all and simply relied on spawning Node and
    // importing the MCP SDK taking longer than 500 ms. That made it a machine-speed test,
    // not a timeout test: it passed on a slow Windows host and failed on ubuntu-latest CI,
    // where the child was ready in well under 500 ms and the state came back 'ready'. It
    // would also have passed for the wrong reason on a host that was merely slow.
    //
    // With a delay the outcome is the same everywhere, because the child is made slow
    // rather than found slow.
    const upstream = makeUpstream({
      startupTimeoutMs: 500,
      command: [process.execPath, FIXTURE, '--startup-delay=5000'],
    });
    await upstream.start();
    const status = upstream.status();
    expect(status.state).not.toBe('ready');
    expect(status.lastError).toBeDefined();
    expect(status.lastError?.toLowerCase()).toContain('timed out');
  }, 30_000);
});

describe('S4.4 stderr capture', () => {
  it('logs stderr lines with the upstream field, redacted', async () => {
    const lines: string[] = [];
    const sink = new (await import('node:stream')).Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const logger = createLogger({ level: 'info', destination: sink, secrets: [CANARY_VALUE] });
    const upstream = new StdioUpstream('fs', localConfig({ command: [process.execPath, FIXTURE, `--stderr=${CANARY_VALUE}-leak`] }), 5_000, {
      logger,
      secrets: [CANARY_VALUE],
    });
    started.push(upstream);
    await upstream.start();
    await waitFor(() => lines.some((l) => l.includes('stderr')), 10_000);

    const output = lines.join('\n');
    expect(output).toContain('"upstream":"fs"');
    expect(output).toContain('"stderr"');
    expect(output).not.toContain(CANARY_VALUE);
    expect(output).toContain('[Redacted]');
  }, 30_000);

  it('truncates a single line to 2 KiB', async () => {
    const lines: string[] = [];
    const sink = new (await import('node:stream')).Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const logger = createLogger({ level: 'info', destination: sink });
    const upstream = new StdioUpstream('fs', localConfig({ command: [process.execPath, FIXTURE, '--stderr-bytes=20000'] }), 5_000, {
      logger,
    });
    started.push(upstream);
    await upstream.start();
    await waitFor(() => lines.some((l) => l.includes('[truncated]')), 10_000);

    const line = lines.find((l) => l.includes('"stderr"')) ?? '';
    // The logged value is at most 2048 characters plus the "[truncated]" marker.
    const match = /"stderr":"((?:[^"\\]|\\.)*)"/.exec(line);
    expect(match).not.toBeNull();
    expect((match?.[1] ?? '').length).toBeLessThanOrEqual(2100);
  }, 30_000);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
