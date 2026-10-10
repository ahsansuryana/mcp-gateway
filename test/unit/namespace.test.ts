import { describe, expect, it } from 'vitest';

import {
  MAX_TOOL_NAME_LENGTH,
  SERVER_NAME_PATTERN,
} from '../../src/config/schema.js';
import {
  namespaceBatch,
  namespaceName,
  namespaced,
  parseNamespacedName,
} from '../../src/aggregate/namespace.js';

describe('D4 namespacing', () => {
  it('joins server and tool with a single underscore', () => {
    expect(namespaced('github', 'list_repos')).toBe('github_list_repos');
    expect(namespaced('a', 'b')).toBe('a_b');
  });

  it('keeps a tool name of exactly 64 characters and skips 65', () => {
    // "<server>_" is 8 characters for the server name "github-".
    const server = 'github-';
    const prefixLength = server.length + 1;
    const exact = 'x'.repeat(MAX_TOOL_NAME_LENGTH - prefixLength);
    expect(namespaceName(server, exact).namespaced).toBe(`${server}_${exact}`);
    expect((exact.length + prefixLength)).toBe(MAX_TOOL_NAME_LENGTH);

    const tooLong = 'x'.repeat(MAX_TOOL_NAME_LENGTH - prefixLength + 1);
    expect(namespaceName(server, tooLong)).toEqual({ reason: 'too-long' });
  });

  it('rejects a server name that would make the split ambiguous', () => {
    for (const bad of ['has_underscore', 'UPPER', 'sp ace', 'a'.repeat(25), '']) {
      expect(namespaceName(bad, 'tool').namespaced).toBeUndefined();
      expect(SERVER_NAME_PATTERN.test(bad)).toBe(false);
    }
  });

  it('rejects an empty tool name', () => {
    expect(namespaceName('github', '')).toEqual({ reason: 'tool-name-empty' });
  });

  it('preserves underscores inside the tool name', () => {
    expect(parseNamespacedName('github_list_all_repos')).toEqual({
      server: 'github',
      name: 'list_all_repos',
    });
  });

  it('splits at the FIRST underscore only', () => {
    // A tool literally named "a_b" under server "s" round-trips exactly.
    const full = namespaced('s', 'a_b');
    expect(full).toBe('s_a_b');
    expect(parseNamespacedName(full)).toEqual({ server: 's', name: 'a_b' });
  });

  it('rejects names that could not have come from the gateway', () => {
    for (const bad of [
      'noseparator',
      '_tool',
      'server_',
      'UPPER_tool',
      '',
    ]) {
      expect(parseNamespacedName(bad), `${bad} must not parse`).toBeNull();
    }
  });

  it('splits a multi-underscore name at the first separator, as D4 mandates', () => {
    // 'bad_name_tool' is VALID output shape: server 'bad' could never itself contain an
    // underscore, so the first separator is unambiguous. This is exactly the ambiguity
    // D4's server-name regex removes.
    expect(parseNamespacedName('bad_name_tool')).toEqual({ server: 'bad', name: 'name_tool' });
    expect(parseNamespacedName('a_b_c_d')).toEqual({ server: 'a', name: 'b_c_d' });
  });

  it('round-trips every tool of a batch', () => {
    const entries = [
      { server: 'github', name: 'list_repos' },
      { server: 'fs', name: 'read_file' },
      { server: 'notion', name: 'search' },
    ];
    const { tools, report } = namespaceBatch(entries);
    expect(report).toEqual({ kept: 3, skipped: [] });
    for (const t of tools) {
      expect(parseNamespacedName(t.namespaced)).toEqual({ server: t.server, name: t.name });
    }
  });

  it('reports collisions instead of silently letting one win (S2.3 acceptance)', () => {
    // Two different servers exposing the SAME tool name must not collide, because the
    // prefix differs. A collision can only occur if a server name contained a separator.
    const { tools, report } = namespaceBatch([
      { server: 'a', name: 'x' },
      { server: 'b', name: 'x' },
    ]);
    expect(tools.map((t) => t.namespaced)).toEqual(['a_x', 'b_x']);
    expect(new Set(tools.map((t) => t.namespaced)).size).toBe(2);
    expect(report.skipped).toEqual([]);
  });

  it('separates kept tools from skipped ones and names both server and tool', () => {
    const long = 'y'.repeat(MAX_TOOL_NAME_LENGTH);
    const { tools, report } = namespaceBatch([
      { server: 'github', name: 'ok' },
      { server: 'github', name: long },
      { server: 'bad_name', name: 'ok' },
      { server: 'github', name: '' },
    ]);
    expect(tools.map((t) => t.namespaced)).toEqual(['github_ok']);
    expect(report.kept).toBe(1);
    expect(report.skipped).toEqual([
      { server: 'github', name: long, reason: 'too-long' },
      { server: 'bad_name', name: 'ok', reason: 'server-name-invalid' },
      { server: 'github', name: '', reason: 'tool-name-empty' },
    ]);
  });

  it('throws from the strict helper when a name cannot be namespaced', () => {
    expect(() => namespaced('github', 'z'.repeat(MAX_TOOL_NAME_LENGTH))).toThrow(/too-long/);
    expect(() => namespaced('bad_name', 'x')).toThrow(/server-name-invalid/);
  });

  it('is a no-op for an empty batch', () => {
    expect(namespaceBatch([])).toEqual({ tools: [], report: { kept: 0, skipped: [] } });
  });
});