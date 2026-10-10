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

/**
 * Kills `pid` and every descendant.
 *
 * Returns the outcome rather than throwing: a shutdown path must not fail because a
 * process had already exited on its own.
 */
export function killProcessTree(pid: number): Promise<{ killed: boolean; error?: string }> {
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