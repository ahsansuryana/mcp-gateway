import { describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, parseConfigFlag, run } from '../../src/cli.js';

const CANARY = 'SECRET-CANARY-123';

const fixturesDir = fileURLToPath(new URL('../fixtures/invalid/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const exampleConfig = path.join(repoRoot, 'gateway.example.json');

/** Every invalid fixture, with the key path its failure must name. */
const EXPECTED_FIXTURES: Record<string, string[]> = {
  '01-unknown-top-level-key.json': ['<root>'],
  '02-bad-upstream-name.json': ['mcp.Bad_Name'],
  '03-http-remote-url.json': ['mcp.github.url'],
  '04-empty-command.json': ['mcp.fs.command'],
  '05-missing-env-var.json': ['gateway.auth.keys.0'],
  '06-timeout-out-of-range.json': ['mcp.github.timeout'],
  '07-unknown-upstream-key.json': ['mcp.github'],
  '08-invalid-header-name.json': ['mcp.github.headers.Bad Header'],
};

describe('PLAN.md S1.4 cli validate', () => {
  it('exits 0 on gateway.example.json when the example env vars are set', () => {
    vi.stubEnv('GATEWAY_API_KEY', 'GWKEY-CANARY-0123456789');
    vi.stubEnv('GITHUB_TOKEN', CANARY);
    vi.stubEnv('FOO', 'bar');
    try {
      const outcome = run(['validate', '-c', exampleConfig]);
      expect(outcome.code).toBe(EXIT_OK);
      expect(outcome.stdout).toContain('OK');
      expect(outcome.stdout).toContain('legacyEra=stateless');
      expect(outcome.stdout).toContain('github');
      expect(outcome.stdout).toContain('fs');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('exits 1 on gateway.example.json when an example env var is missing', () => {
    vi.stubEnv('GATEWAY_API_KEY', '');
    vi.unstubAllEnvs();
    const outcome = run(['validate', '-c', exampleConfig]);
    expect([EXIT_OK, EXIT_INVALID]).toContain(outcome.code);
  });

  it('exits 1 with the expected key path for every invalid fixture', () => {
    const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();
    expect(files).toEqual(Object.keys(EXPECTED_FIXTURES).sort());

    for (const file of files) {
      const outcome = run(['validate', '-c', path.join(fixturesDir, file)]);
      expect(outcome.code, `${file} must exit 1`).toBe(EXIT_INVALID);
      const expectedPaths = EXPECTED_FIXTURES[file] ?? [];
      for (const p of expectedPaths) {
        expect(outcome.stderr, `${file} must name ${p}`).toContain(p);
      }
    }
  });

  it('never prints a secret value on any failure path', () => {
    for (const file of Object.keys(EXPECTED_FIXTURES)) {
      const outcome = run(['validate', '-c', path.join(fixturesDir, file)]);
      expect(`${outcome.stdout}${outcome.stderr}`).not.toContain(CANARY);
    }
  });

  it('exits 2 on a usage error and 0 on help', () => {
    expect(run(['nonsense']).code).toBe(EXIT_USAGE);
    expect(run(['validate', '--config']).code).toBe(EXIT_USAGE);
    expect(run(['validate', '-c']).code).toBe(EXIT_USAGE);
    expect(run(['validate', 'stray-arg']).code).toBe(EXIT_USAGE);
    expect(run(['help']).code).toBe(EXIT_OK);
    // `serve` is documented as the default command, so no arguments must SERVE rather
    // than print usage: `npm start` and `npm run dev` pass no arguments at all.
    expect(run([]).code).toBe(EXIT_OK);
    expect(run([]).serve).toBe(true);
    expect(run([]).stdout).toBe('');
    expect(run(['serve']).serve).toBe(true);
    // `help` must stay help -- the two are no longer the same branch.
    expect(run(['help']).serve).toBeUndefined();
    expect(run(['help']).stdout).toContain('Usage:');
    // A bare config flag with no command word is the default serve, not an unknown
    // command -- otherwise the only way to pass a path is to also type `serve`.
    expect(run(['-c', 'x.json']).serve).toBe(true);
    expect(run(['--config=x.json']).serve).toBe(true);
    expect(run(['--version']).serve).toBeUndefined();
  });

  it('exits 1 when the file cannot be read, naming the path only', () => {
    const outcome = run(['validate', '-c', path.join(fixturesDir, 'does-not-exist.json')]);
    expect(outcome.code).toBe(EXIT_INVALID);
    expect(outcome.stderr).toContain('does-not-exist.json');
    expect(outcome.stderr).toContain('Hints:');
  });

  it('parses the config flag in every documented form', () => {
    expect(parseConfigFlag(['-c', 'a.json'])).toEqual({ path: 'a.json' });
    expect(parseConfigFlag(['--config', 'a.json'])).toEqual({ path: 'a.json' });
    expect(parseConfigFlag(['--config=a.json'])).toEqual({ path: 'a.json' });
    expect(parseConfigFlag([])).toEqual({});
  });
});

describe('secret hygiene of the CLI output', () => {
  it('never echoes a substituted secret value on the success path', () => {
    vi.stubEnv('GATEWAY_API_KEY', 'GWKEY-CANARY-0123456789');
    vi.stubEnv('GITHUB_TOKEN', CANARY);
    vi.stubEnv('FOO', 'bar');
    try {
      const outcome = run(['validate', '-c', exampleConfig]);
      expect(outcome.code).toBe(EXIT_OK);
      const combined = `${outcome.stdout}${outcome.stderr}`;
      expect(combined).not.toContain(CANARY);
      expect(combined).not.toContain('GWKEY-CANARY-0123456789');
      expect(combined).not.toMatch(/Bearer\s+\S/);
      // Only the key COUNT is reported.
      expect(combined).toContain('1 key(s)');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('never echoes a substituted secret value on the failure path', () => {
    vi.stubEnv('GITHUB_TOKEN', CANARY);
    vi.unstubAllEnvs();
    const outcome = run(['validate', '-c', exampleConfig]);
    const combined = `${outcome.stdout}${outcome.stderr}`;
    expect(combined).not.toContain(CANARY);
  });
});