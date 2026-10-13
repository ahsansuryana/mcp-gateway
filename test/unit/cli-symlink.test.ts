import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const cliSource = path.join(repoRoot, 'src', 'cli.ts');

// Regression: `npm i -g` installs `bin` as a symlink. Node resolves symlinks for
// import.meta.url but leaves process.argv[1] as the symlink path, so a guard comparing the two
// directly never fired and the command exited 0 printing nothing (src/cli.ts, "SYMLINKS MUST BE
// RESOLVED"). The test runs the real entry point through a symlink, exactly as the shell does.
describe('cli entry point invoked through a symlink', () => {
  it('still runs: `--version` prints the package name and version', () => {
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
  }, 60_000);
});
