// PLAN.md S4.5: force-kill a whole child process tree.
//
// The MCP SDK's `StdioClientTransport.close()` terminates the DIRECT child only
// (verified: node_modules/@modelcontextprotocol/client/dist/stdio.d.mts, `close()`).
// A stdio upstream is very often `npx`, `uvx` or `node` wrapping another process, so
// killing only the direct child orphans its grandchildren, which keep the stdio pipe and
// the port alive.

import treeKill from 'tree-kill';

// verified: node_modules/tree-kill/index.d.ts -> treeKill(pid: number, signal: string | number, callback: (error?: Error) => void): void
// verified: node_modules/tree-kill/index.js -> Windows uses taskkill /pid <pid> /T /F,
// which terminates the process AND its children; POSIX walks `ps --ppid` to build the tree
// and signals each pid, so the platform difference is handled by the dependency.
import { constants } from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Whether a POSIX process tree can actually be built.
 *
 * tree-kill walks the tree with `ps --ppid`, which lives in `procps`. That package is
 * absent from minimal container images: observed on `node:24-bookworm-slim`, where
 * `killProcessTree` raised `spawn ps ENOENT` from inside the dependency's own callback,
 * where a `try/catch` here cannot reach it.
 *
 * When it is missing we degrade to killing the direct child, which is the best available
 * and never worse than the SDK's own behaviour.
 */
let posixTreeAvailable: boolean | undefined;

function hasPs(): boolean {
  if (process.platform === 'win32') return true;
  posixTreeAvailable ??= (() => {
    try {
      execFileSync('ps', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  return posixTreeAvailable;
}

/**
 * Kills `pid` and every descendant.
 *
 * Returns the outcome rather than throwing: a shutdown path must not fail because a
 * process had already exited on its own.
 *
 * `treeOnly` reports that descendants were NOT included, so the caller can log the
 * degradation rather than silently claiming a full tree kill.
 */
export function killProcessTree(
  pid: number,
): Promise<{ killed: boolean; error?: string; treeOnly?: boolean }> {
  if (!hasPs()) {
    try {
      // verified: nodejs.org/api/process.html#processkillpid-signal
      process.kill(pid, 'SIGKILL');
      return Promise.resolve({ killed: true, treeOnly: true });
    } catch (err) {
      return Promise.resolve({
        killed: false,
        treeOnly: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (killed: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      resolve(error === undefined ? { killed } : { killed, error });
    };

    try {
      // verified: node_modules/@types/node/os.d.ts -> constants.signals is NodeJS.Signals
      treeKill(pid, constants.signals.SIGKILL, (error?: Error) => {
        if (error) {
          // ESRCH: the process is already gone, which is the desired end state.
          finish(false, error.message);
          return;
        }
        finish(true);
      });
    } catch (err) {
      finish(false, err instanceof Error ? err.message : String(err));
    }
  });
}