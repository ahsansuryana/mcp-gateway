import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const cliSource = path.join(repoRoot, 'src', 'cli.ts');

/**
 * Whether this machine will let a test create a symlink.
 *
 * On Windows that needs Developer Mode or an elevated shell, and a stock Windows account has
 * neither. Without this the suite is red on most Windows machines -- measured here on
 * `origin/main` with none of the zero-config work present:
 *
 *   EPERM: operation not permitted, symlink ...\src\cli.ts -> ...\mcp-gate
 *
 * The probe actually attempts the operation rather than testing `process.platform`, because
 * a Windows box WITH Developer Mode does allow it and should still run the real assertion.
 *
 * The test SKIPS rather than passes when it cannot run. It verified nothing, and reporting
 * that as a pass would be a lie about what this suite covers -- the regression it guards is
 * the global-install "exit 0 with no output" failure, which only exists on POSIX installs
 * anyway, where CI runs it for real.
 */
function canCreateSymlink(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-gate-symprobe-'));
  try {
    symlinkSync(cliSource, path.join(dir, 'probe'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const symlinksAllowed = canCreateSymlink();

// Regression: `npm i -g` installs `bin` as a symlink. Node resolves symlinks for
// import.meta.url but leaves process.argv[1] as the symlink path, so a guard comparing the two
// directly never fired and the command exited 0 printing nothing (src/cli.ts, "SYMLINKS MUST BE
// RESOLVED"). The test runs the real entry point through a symlink, exactly as the shell does.
describe('cli entry point invoked through a symlink', () => {
  it.skipIf(!symlinksAllowed)(
    'still runs: `--version` prints the package name and version',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'mcp-gate-symlink-'));
      try {
        const link = path.join(dir, 'mcp-gate');
        symlinkSync(cliSource, link);

        const direct = spawnSync(process.execPath, ['--import', 'tsx', cliSource, '--version'], {
          cwd: repoRoot,
          encoding: 'utf8',
        });
        const viaLink = spawnSync(process.execPath, ['--import', 'tsx', link, '--version'], {
          cwd: repoRoot,
          encoding: 'utf8',
        });

        expect(direct.status).toBe(0);
        expect(direct.stdout).toMatch(/@ahsansuryana\/mcp-gateway \d+\.\d+\.\d+/);
        // The failure this guards against is exit 0 with EMPTY output, so assert the output.
        expect(viaLink.status).toBe(0);
        expect(viaLink.stdout).toBe(direct.stdout);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.skipIf(!symlinksAllowed)('runs the entry point directly, with no symlink involved', () => {
    // Not a substitute for the test above: it does not reproduce the symlink resolution. It
    // exists so a Windows machine that had to skip above still exercises the entry point
    // rather than contributing nothing to this file.
    const direct = spawnSync(process.execPath, ['--import', 'tsx', cliSource, '--version'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(direct.status).toBe(0);
    expect(direct.stdout).toMatch(/@ahsansuryana\/mcp-gateway \d+\.\d+\.\d+/);
  }, 60_000);
});
