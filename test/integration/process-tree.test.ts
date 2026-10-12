// PLAN.md S4.5: a stdio child tree is actually terminated, on this platform.
//
// The MCP SDK's `close()` signals the DIRECT child only. A stdio upstream is typically a
// wrapper (`npx`, `uvx`, a shell) that itself has children, so a naive stop leaves
// grandchildren alive. These tests spawn a real grandchild and assert it is gone.
//
// D15: LOCAL child processes only.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StdioUpstream } from '../../src/upstream/stdio.js';
import { killProcessTree } from '../../src/upstream/process-tree.js';
import { createLogger } from '../../src/observability/logger.js';
import type { LocalUpstreamConfig } from '../../src/config/schema.js';

const FIXTURE = resolve(fileURLToPath(new URL('../fixtures/', import.meta.url)), 'fake-stdio-server.mjs');

const upstreams: StdioUpstream[] = [];
const spawnedPids: number[] = [];

function local(overrides: Partial<LocalUpstreamConfig> = {}): LocalUpstreamConfig {
  return {
    type: 'local',
    command: [process.execPath, FIXTURE, '--grandchild'],
    environment: {},
    enabled: true,
    startupTimeoutMs: 20_000,
    idleTimeoutMs: 0,
    ...overrides,
  };
}

/**
 * Whether a POSIX process tree can be walked on this host.
 *
 * tree-kill needs `ps` (procps), which minimal container images such as
 * `node:24-bookworm-slim` do not ship. The gateway degrades to a direct-child kill there,
 * and the test asserts the behaviour that actually applies instead of pretending.
 */
function hasPs(): boolean {
  if (process.platform === 'win32') return true;
  try {
    execFileSync('ps', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * True while `pid` is still RUNNING. Windows uses tasklist; POSIX reads the state from `ps`.
 *
 * A ZOMBIE IS NOT ALIVE, and `process.kill(pid, 0)` cannot tell the difference.
 *
 * Signal 0 only asks "does this PID exist in the process table", and a SIGKILLed process
 * whose parent died in the same instant is never reaped: it is reparented to PID 1 and
 * stays in state Z indefinitely whenever PID 1 does not call wait(). In a container PID 1 is
 * typically `sleep` or the test runner, neither of which reaps anything.
 *
 * Measured, in node:24-bookworm-slim with procps:
 *
 *   AFTER grandchild 359 Z    MainThread alive=true     <- process.kill(359, 0) succeeded
 *
 * So the original helper reported a correctly-killed process as alive, and the tree-kill
 * test failed on any host where the zombie was never reaped -- ubuntu-latest CI, and this
 * arm64 host -- while passing on Windows, which has no zombie state at all. The kill was
 * never broken; only this predicate was wrong.
 *
 * A zombie executes no code, holds no files or memory, and cannot be signalled. Treating it
 * as dead is the correct semantics for "is this process still running".
 */
function isAlive(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      // "INFO: No tasks are running..." is the empty result.
      return out.includes(String(pid));
    }
    // `ps` is available here by construction: this suite is the one that decides whether a
    // POSIX tree can be walked at all, and the degraded branch below is covered too.
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (stat.length === 0) return false;
    // Z = zombie, Z+ = zombie with a pending `&` disposition. Both are dead.
    return !stat.startsWith('Z');
  } catch (err) {
    // EPERM means the process exists but is not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

/**
 * Captures the gateway log so the test can read the grandchild pid the fixture reports on
 * its own stderr. Going through the logger also exercises the S4.4 stderr path end to end
 * instead of adding a test-only getter to production code.
 */
function captureLogger(): { logger: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { logger: createLogger({ level: 'info', destination: sink }), lines };
}

afterEach(async () => {
  for (const upstream of upstreams.splice(0)) {
    await upstream.forceStop?.().catch(() => undefined);
  }
  for (const pid of spawnedPids.splice(0)) {
    if (isAlive(pid)) await killProcessTree(pid);
  }
});

describe('S4.5 process tree termination', () => {
  it('forceStop() kills the direct child AND its grandchild', async () => {
    const { logger, lines } = captureLogger();
    const upstream = new StdioUpstream('fs', local(), 5_000, { logger });
    upstreams.push(upstream);
    await upstream.start();
    expect(upstream.status().state).toBe('ready');

    const childPid = upstream.pid;
    expect(childPid).toBeDefined();

    // The fixture prints the grandchild pid on stderr; S4.4 relays it with `upstream: 'fs'`.
    const deadline = Date.now() + 15_000;
    let grandchildPid: number | undefined;
    while (Date.now() < deadline && grandchildPid === undefined) {
      const found = /grandchild pid (\d+)/.exec(lines.join('\n'));
      if (found?.[1]) grandchildPid = Number(found[1]);
      else await new Promise((r) => setTimeout(r, 150));
    }
    expect(grandchildPid).toBeDefined();
    expect(lines.join('\n')).toContain('"upstream":"fs"');
    spawnedPids.push(grandchildPid!);

    expect(isAlive(childPid!)).toBe(true);
    expect(isAlive(grandchildPid!)).toBe(true);

    await upstream.forceStop?.();
    // The direct child must always die.
    expect(await waitUntil(() => !isAlive(childPid!), 15_000)).toBe(true);
    expect(upstream.status().state).toBe('disabled');

    if (hasPs()) {
      // The whole tree must be gone, not just the process the SDK tracks.
      expect(await waitUntil(() => !isAlive(grandchildPid!), 15_000)).toBe(true);
    } else {
      // Degraded path: without procps the grandchild survives and the gateway must SAY so.
      expect(isAlive(grandchildPid!)).toBe(true);
      expect(lines.join('\n')).toContain('process tree kill degraded to direct child');
    }
  }, 60_000);

  it('killProcessTree is safe on an already-dead pid', async () => {
    // A shutdown path must not fail because a process exited on its own.
    const result = await killProcessTree(0x7ffffff0);
    expect(result.killed === true || typeof result.error === 'string').toBe(true);
  }, 20_000);
});