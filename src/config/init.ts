// ADR 0012: `mcp-gate init` — write a starter config.
//
// Fails loudly rather than overwriting: an existing config may hold real credentials, and a
// generated file that replaced it would be silent data loss.
//
// verified: nodejs.org/api/fs.html#fswritefilesyncfile-data-options (writeFileSync mode)
// verified: nodejs.org/api/fs.html#fsmkdirsyncpath-options (mkdirSync mode)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CONFIG_DIR_NAME, CONFIG_FILENAME, homeRoot } from './paths.js';
import { packageName, packageVersion } from '../package-info.js';

export interface InitOptions {
  /** Write to `./.mcp-gateway` instead of the home directory. */
  local?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  /** Existence predicate, injected by tests. */
  exists?: (absolutePath: string) => boolean;
  /** Example document source, injected by tests. */
  readExample?: () => string;
  /**
   * Write this document instead of the bundled example. ADR 0013: auto-create supplies a
   * minimal template here rather than the full `gateway.example.json`, which references three
   * environment variables and two upstreams that do not exist yet.
   *
   * `$schema` is still rewritten on the way out, so both paths produce the same published
   * schema URL.
   */
  contents?: string;
  /**
   * Exact path to write. Set by auto-create, which has already resolved where the file
   * belongs and must not have that decision re-made by the `local`/home logic below.
   */
  target?: string;
}

export interface InitResult {
  status: 'created' | 'exists' | 'error';
  path: string;
  /** Set when the file already existed; never a reason to overwrite. */
  message?: string;
}

/**
 * The published URL of the JSON Schema, built from the real package name and version.
 *
 * jsDelivr serves files from npm packages, so this only resolves once the package is
 * published; before that it 404s, which is harmless and honest. It is written into the
 * generated file for editor completion, and `gatewayConfigSchema` accepts `$schema`
 * explicitly, so validation is unaffected either way.
 */
export function schemaUrl(name: string, version: string): string {
  return `https://cdn.jsdelivr.net/npm/${name}@${version}/gateway.schema.json`;
}

/** The example config, read from the installed package root. */
export function readExampleConfig(): string {
  // verified: nodejs.org/api/url.html#urlfileurltopathname-options (URL fileURLToPath)
  return readFileSync(fileURLToPath(new URL('../../gateway.example.json', import.meta.url)), 'utf8');
}

/**
 * Rewrites the example's `$schema` to the published URL.
 *
 * The example points at `./gateway.schema.json`, which is right in a repository checkout and
 * wrong in `~/.mcp-gateway/` where no such file sits next to it. A dangling relative path
 * makes editors silently stop offering completion, so it is replaced rather than removed.
 */
export function withPublishedSchema(example: string, name: string, version: string): string {
  const url = schemaUrl(name, version);
  const replaced = example.replace(/"\$\s*schema"\s*:\s*"[^"]*"/, `"$schema": ${JSON.stringify(url)}`);
  if (replaced === example) return `{\n  "$schema": ${JSON.stringify(url)},\n${example.slice(1)}`;
  return replaced;
}

export function runInit(options: InitOptions = {}): InitResult {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? ((p: string) => readFileExists(p));
  const readExample = options.readExample ?? readExampleConfig;

  const target =
    options.target ??
    (options.local === true
      ? join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME)
      : join(homeRoot(env), CONFIG_DIR_NAME, CONFIG_FILENAME));

  if (exists(target)) {
    return {
      status: 'exists',
      path: target,
      message:
        `refusing to overwrite an existing config at ${target}\n` +
        'edit it by hand, or delete it first if you really want a fresh one',
    };
  }

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });

  // Every failure here is reported as a sentence, never as a Node stack trace. The first
  // real run of this inside the container printed a raw ENOENT for
  // /app/gateway.example.json, which says nothing about the cause and looks like a crash.
  let document: string;
  try {
    document = withPublishedSchema(
      options.contents ?? readExample(),
      packageName(),
      packageVersion(),
    );
  } catch {
    return {
      status: 'error',
      path: target,
      message:
        `could not read the bundled gateway.example.json, so no config was written to ${target}\n` +
        'this build of the package is incomplete; reinstall it',
    };
  }

  try {
    writeFileSync(target, document, { encoding: 'utf8', mode: 0o600 });
  } catch {
    return {
      status: 'error',
      path: target,
      message:
        `could not write ${target}\n` +
        'check that the directory exists and is writable by the current user',
    };
  }

  return { status: 'created', path: target };
}

/**
 * The minimal config `mcp-gateway serve` writes when it finds no config anywhere (ADR 0013).
 *
 * Deliberately NOT `gateway.example.json`. That file references `{env:GITHUB_TOKEN}`,
 * `{env:FOO}` and two upstreams that do not exist yet, so writing it on first run produces a
 * gateway that starts and then exposes nothing -- the operator would have to delete two
 * upstreams before they could add their own. This is a starting point: valid, serving, empty.
 *
 * host is 127.0.0.1, NOT the schema's 0.0.0.0 default. This file is created silently by
 * someone who has not decided anything about networking yet, and a wildcard bind would mean
 * a brand-new gateway answers on the whole LAN. `--hostname 0.0.0.0` asks for that
 * explicitly; nothing should ask for it by omission.
 *
 * JSONC, so the comments survive: the parser runs jsonc-parser with disallowComments: false.
 * The key is embedded as a JSON string literal, so base64url is safe here without escaping.
 */
export function renderTemplate(host: string, key: string): string {
  return `{
  // Created by \`mcp-gateway serve\` on first run. Safe to edit; it is never overwritten.

  "gateway": {
    // Loopback by default. Use \`mcp-gateway --hostname 0.0.0.0\` to reach it from other
    // devices on your network, or \`--public-url\` when it sits behind a tunnel.
    "host": ${JSON.stringify(host)},
    "port": 3000,
    "auth": { "type": "bearer", "keys": [${JSON.stringify(key)}] }
  },

  // Add upstreams here. Every tool is exposed to clients as <name>_<tool>.
  // See docs/CONFIG.md for every field, or gateway.example.json for a worked one.
  "mcp": {
    // "github": {
    //   "type": "remote",
    //   "url": "https://api.githubcopilot.com/mcp/",
    //   "headers": { "Authorization": "Bearer {env:GITHUB_TOKEN}" }
    // }
  }
}
`;
}

function readFileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}