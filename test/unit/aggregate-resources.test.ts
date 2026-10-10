import { describe, expect, it } from 'vitest';

import { decodeResourceUri, encodeResourceUri, resourceNotFound } from '../../src/aggregate/resources.js';
import { aggregatePrompts, unknownPrompt } from '../../src/aggregate/prompts.js';

describe('D5 resource URI rewriting', () => {
  it('encodes as gw://<server>/<encodeURIComponent(originalUri)>', () => {
    expect(encodeResourceUri('github', 'file:///a/b.json')).toBe('gw://github/file%3A%2F%2F%2Fa%2Fb.json');
    expect(encodeResourceUri('fs', 'custom:thing')).toBe('gw://fs/custom%3Athing');
  });

  it('round-trips an arbitrary original URI', () => {
    const originals = [
      'file:///projects/my app/config.json',
      'https://example.com/a?b=c&d=e#frag',
      'custom:weird uri with spaces/and?slashes',
      'urn:uuid:1234-5678',
      'ünïcødé://ünïcødé/🎉',
    ];
    for (const server of ['github', 'fs', 'a']) {
      for (const original of originals) {
        const encoded = encodeResourceUri(server, original);
        expect(decodeResourceUri(encoded)).toEqual({ server, originalUri: original });
      }
    }
  });

  it('disambiguates two upstreams publishing the SAME original URI', () => {
    const a = encodeResourceUri('a', 'file:///shared');
    const b = encodeResourceUri('b', 'file:///shared');
    expect(a).not.toBe(b);
    expect(decodeResourceUri(a)).toEqual({ server: 'a', originalUri: 'file:///shared' });
    expect(decodeResourceUri(b)).toEqual({ server: 'b', originalUri: 'file:///shared' });
  });

  it('rejects URIs the gateway could not have produced', () => {
    for (const bad of [
      'file:///not-rewritten',
      'gw://',
      'gw://onlyserver',
      'gw://server/',
      'gw:///norepo',
      'gw://server/%E0%A4%A',
      '',
    ]) {
      expect(decodeResourceUri(bad), `${bad} must not decode`).toBeNull();
    }
  });

  it('names -32602 for an unknown resource (S3.1)', () => {
    expect(resourceNotFound('gw://x/%3A').code).toBe(-32602);
    expect(unknownPrompt('x_y').code).toBe(-32602);
  });
});

describe('S3.2 prompt namespacing', () => {
  it('applies D4 to prompts', () => {
    const { prompts, skipped } = aggregatePrompts([
      { server: 'github', name: 'review', prompt: { name: 'review', description: 'd' } },
      { server: 'fs', name: 'summarise_file', prompt: { name: 'summarise_file' } },
    ]);
    expect(skipped).toEqual([]);
    expect(prompts.map((p) => p.name)).toEqual(['fs_summarise_file', 'github_review']);
  });

  it('skips an over-long prompt name like D4 does for tools', () => {
    const long = 'z'.repeat(80);
    const { prompts, skipped } = aggregatePrompts([{ server: 'github', name: long, prompt: { name: long } }]);
    expect(prompts).toEqual([]);
    expect(skipped).toEqual([{ server: 'github', tool: long, reason: 'too-long' }]);
  });

  it('returns an empty list rather than failing when there are no prompts', () => {
    expect(aggregatePrompts([])).toEqual({ prompts: [], skipped: [] });
  });
});