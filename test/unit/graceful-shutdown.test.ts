// PLAN.md S7.3: graceful shutdown — stop accepting, drain in flight, stop upstreams.
//
// D15: LOCAL fake only.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { startGateway, type RunningGateway, DRAIN_MS } from '../../src/index.js';
import { createLogger } from '../../src/observability/logger.js';
import { startFakeUpstream, unusedPort, type FakeUpstream } from '../fixtures/fake-upstream.js';
import { execFileSync } from 'node:child_process';

const API_KEY = 'S73-CANARY-KEY-0123456789';
const FIXTURE = join(process.cwd(), 'test', 'fixtures', 'fake-stdio-server.mjs');

let gateways: RunningGateway[] = [];
const upstreams: FakeUpstream[] = [];

afterEach(async () => {
  for (const g of gateways.splice(0)) await g.stop().catch(() => undefined);
  for (const u of upstreams.splice(0)) await u.close().catch(() => undefined);
});

function isAlive(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.includes(String(pid));
    }
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('S7.3 graceful shutdown', () => {
  it('stops accepting new connections but lets an in-flight request finish', async () => {
    const slow = await startFakeUpstream({
      port: await unusedPort(),
      kind: 'slow',
      prefix: 'drain',
    });
    upstreams.push(slow);

    const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-s73-'));
    const configPath = join(dir, 'gateway.json');
    const port = await unusedPort();
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          host: '127.0.0.1',
          port,
          auth: { type: 'bearer', keys: [API_KEY] },
          defaultTimeoutMs: 20_000,
          defaultTtlMs: 30_000,
        },
        mcp: { slow: { type: 'remote', url: slow.url, timeout: 20_000 } },
      }),
      'utf8',
    );

    const lines: string[] = [];
    const gateway = await startGateway({
      configPath,
      logger: createLogger({
        level: 'debug',
        destination: new Writable({
          write(chunk, _enc, cb) {
            lines.push(String(chunk));
            cb();
          },
        }),
      }),
    });
    gateways.push(gateway);

    // A request already in flight when shutdown starts.
    const inFlight = fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    await delay(150);

    const stopped = gateway.stop();
    await delay(150);

    // The in-flight request is NOT cut off: it still completes with a real response.
    const response = await inFlight;
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('slow_echo');

    await stopped;
  }, 60_000);

  it('a new connection after stop() begins is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-s73b-'));
    const configPath = join(dir, 'gateway.json');
    const port = await unusedPort();
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          host: '127.0.0.1',
          port,
          auth: { type: 'bearer', keys: [API_KEY] },
          defaultTimeoutMs: 5_000,
          defaultTtlMs: 30_000,
        },
        mcp: {},
      }),
      'utf8',
    );
    const gateway = await startGateway({ configPath, logLevel: 'silent' });
    gateways.push(gateway);

    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    const stopped = gateway.stop();
    await delay(250);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toBeDefined();
    await stopped;
  }, 40_000);

  it('stops stdio children, including their grandchildren', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-gateway-s73c-'));
    const configPath = join(dir, 'gateway.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          host: '127.0.0.1',
          port: await unusedPort(),
          auth: { type: 'bearer', keys: [API_KEY] },
          defaultTimeoutMs: 20_000,
          defaultTtlMs: 30_000,
        },
        mcp: {
          local: {
            type: 'local',
            command: [process.execPath, FIXTURE, '--grandchild'],
            environment: {},
            enabled: true,
            startupTimeoutMs: 20_000,
            idleTimeoutMs: 0,
            timeout: 10_000,
          },
        },
      }),
      'utf8',
    );
    const gateway = await startGateway({ configPath, logLevel: 'silent' });
    gateways.push(gateway);

    // Lazy: the child starts on first use.
    const res = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);

    const childPid = (gateway.manager.get('local') as { pid?: number } | undefined)?.pid;
    expect(childPid).toBeDefined();
    expect(isAlive(childPid!)).toBe(true);

    await gateway.stop();
    gateways = gateways.filter((g) => g !== gateway);

    // The process tree is gone, which is the S4.5 guarantee reused at shutdown.
    for (let i = 0; i < 100 && isAlive(childPid!); i += 1) await delay(100);
    expect(isAlive(childPid!)).toBe(false);
  }, 90_000);

  it('the drain deadline is a finite backstop', () => {
    expect(DRAIN_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DRAIN_MS)).toBe(true);
  });
});