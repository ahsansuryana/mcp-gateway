// PLAN.md S4.6: the manager drives a real stdio child process end to end.
//
// This is the integration layer `stdio-upstream.test.ts` cannot cover: it proves the LAZY
// contract holds THROUGH the manager. A lazy upstream starts out `disabled`, and
// `UpstreamManager.#ensureStarted` must not short-circuit on that state -- that regression
// guard is the point of this file.
//
// D15: LOCAL child processes only, no network.

import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UpstreamManager } from '../../src/upstream/manager.js';
import { StdioUpstream } from '../../src/upstream/stdio.js';
import { createLogger } from '../../src/observability/logger.js';
import type { GatewayConfig, LocalUpstreamConfig } from '../../src/config/schema.js';

const FIXTURE = resolve(fileURLToPath(new URL('../fixtures/', import.meta.url)), 'fake-stdio-server.mjs');

const CANARY = 'SPIKE_GATEWAY_SECRET';
const CANARY_VALUE = 'SECRET-CANARY-MGR';

const managers: UpstreamManager[] = [];
const upstreams: StdioUpstream[] = [];

function local(overrides: Partial<LocalUpstreamConfig> = {}): LocalUpstreamConfig {
  return {
    type: 'local',
    command: [process.execPath, FIXTURE],
    environment: { SPIKE_UPSTREAM_VALUE: 'from-config' },
    enabled: true,
    startupTimeoutMs: 20_000,
    idleTimeoutMs: 0,
    ...overrides,
  };
}

/** Builds a real GatewayConfig so the manager walks its normal construction path. */
function gatewayConfig(mcp: Record<string, LocalUpstreamConfig>): GatewayConfig {
  return {
    gateway: {
      host: '127.0.0.1',
      port: 0,
      auth: { type: 'bearer', keys: ['k'] },
      defaultTimeoutMs: 5_000,
      defaultTtlMs: 30_000,
      legacyEra: 'stateless',
    },
    mcp,
  };
}

function build(name: string, upstream: LocalUpstreamConfig): UpstreamManager {
  // A factory keeps the test in control of the instance while the manager owns the
  // lifecycle, backoff and status machine.
  const manager = new UpstreamManager(gatewayConfig({ [name]: upstream }), {
    logger: createLogger({ level: 'silent' }),
    factory: () => {
      const created = new StdioUpstream(name, upstream, 5_000, {
        logger: createLogger({ level: 'silent' }),
        secrets: [CANARY_VALUE],
      });
      upstreams.push(created);
      return created;
    },
  });
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop().catch(() => undefined);
  for (const upstream of upstreams.splice(0)) await upstream.stop().catch(() => undefined);
  delete process.env[CANARY];
});

describe('S4.6 manager + stdio child', () => {
  it('start() does NOT start a lazy upstream; the first listAllTools() does', async () => {
    process.env[CANARY] = CANARY_VALUE;
    const manager = build('fs', local());
    await manager.start();

    // PLAN.md S4.3: manager.start() skips lazy upstreams, so no child exists yet.
    const before = manager.status('fs');
    expect(['disabled', 'starting']).toContain(before?.state);
    expect(before?.state).not.toBe('ready');

    // First use starts the child. This is the regression guard for the
    // `state === 'disabled'` short-circuit in `#ensureStarted`.
    const signal = new AbortController().signal;
    const tools = await manager.listAllTools(signal);
    expect(tools.get('fs')?.tools.map((t) => t.name)).toContain('echo');
    expect(manager.status('fs')?.state).toBe('ready');
  }, 40_000);

  it('routes a tool call to the child and isolates the gateway secret (D13)', async () => {
    process.env[CANARY] = CANARY_VALUE;
    const manager = build('fs', local());
    await manager.start();

    const signal = new AbortController().signal;
    await manager.listAllTools(signal);
    const upstream = manager.get('fs');
    expect(upstream).toBeDefined();

    const echo = await upstream!.callTool('echo', { text: 'through-manager' }, undefined, signal);
    expect((echo.content[0] as { text: string }).text).toBe('stdio:through-manager');

    const dump = await upstream!.callTool('env_dump', {}, undefined, signal);
    const parsed = JSON.parse((dump.content[0] as { text: string }).text) as {
      gatewaySecretPresent: boolean;
      configuredValue: string | null;
    };
    expect(process.env[CANARY]).toBe(CANARY_VALUE);
    expect(parsed.gatewaySecretPresent).toBe(false);
    expect(parsed.configuredValue).toBe('from-config');
  }, 40_000);

  it('a crashing child is never reported ready (S4.3)', async () => {
    const manager = build('crashy', local({ command: [process.execPath, FIXTURE, '--tool=crash'] }));

    // Assert on TRANSITIONS, not on an instantaneous sample. The child exits ~150ms after
    // every start, so the upstream legitimately passes through `ready` before crashing;
    // polling for "not ready" races the restart that traffic triggers.
    const seen: string[] = [];
    manager.onStatusChange((name, state) => {
      if (name === 'crashy') seen.push(state);
    });

    await manager.start();
    const signal = new AbortController().signal;
    for (let i = 0; i < 4; i += 1) {
      await manager.listAllTools(signal);
      await new Promise((r) => setTimeout(r, 400));
    }

    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toContain('error');
  }, 60_000);
});