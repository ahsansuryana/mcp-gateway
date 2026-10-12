// ADR 0012: the package manifest, read at runtime.
//
// Lives in its own module because both `cli.ts` (for --version) and `config/init.ts` (for
// the published $schema URL) need it, and init.ts must not import cli.ts: cli.ts already
// imports init.ts, so that would be a cycle.
//
// verified: nodejs.org/api/url.html#urlfileurltopathname-options (URL fileURLToPath)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface PackageInfo {
  name: string;
  version: string;
}

const FALLBACK: PackageInfo = { name: 'mcp-gateway', version: '0.0.0' };

/**
 * Reads name and version from the manifest shipped with this file.
 *
 * `dist/cli.js` sits one level below the package root, so `../package.json` is correct both
 * in a checkout and in an installed global package. npm always includes package.json in a
 * tarball regardless of the `files` whitelist, so this cannot be missing in a real install.
 *
 * The fallbacks exist so a missing or malformed manifest degrades to something printable
 * instead of throwing a parse error out of `--version`.
 */
export function readPackageInfo(): PackageInfo {
  try {
    const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const { name, version } = parsed as { name?: unknown; version?: unknown };
      return {
        name: typeof name === 'string' && name.length > 0 ? name : FALLBACK.name,
        version: typeof version === 'string' && version.length > 0 ? version : FALLBACK.version,
      };
    }
    return FALLBACK;
  } catch {
    return FALLBACK;
  }
}

/** The package name, e.g. `@ahsansuryana/mcp-gateway`. */
export function packageName(): string {
  return readPackageInfo().name;
}

/** The package version, e.g. `0.1.0`. */
export function packageVersion(): string {
  return readPackageInfo().version;
}