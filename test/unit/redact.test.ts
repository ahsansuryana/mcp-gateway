import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';

import { createLogger, safe, scrubSecrets, secretsFromConfig, MIN_SCRUBBABLE_SECRET } from '../../src/observability/logger.js';
import { REDACTED_KEYS, redactValue, isRedactedKey, configSummary } from '../../src/observability/redact.js';

const CANARY = 'SECRET-CANARY-123';

function captureSink(): { sink: Writable; lines: () => string[] } {
  const buffer: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      buffer.push(String(chunk));
      cb();
    },
  });
  return { sink, lines: () => buffer.join('').split('\n').filter((l) => l.trim().length > 0) };
}

describe('D14 redaction', () => {
  it('redacts every D14 key at any depth, even without registering the value', () => {
    const { sink, lines } = captureSink();
    const log = createLogger({ level: 'trace', destination: sink });

    log.info(
      {
        authorization: `Bearer ${CANARY}`,
        headers: { Authorization: `Bearer ${CANARY}`, 'X-Api-Key': CANARY },
        environment: { TOKEN: CANARY },
        token: CANARY,
        apiKey: CANARY,
        secret: CANARY,
        password: CANARY,
        cookie: `session=${CANARY}`,
        upstream: { name: 'github', headers: { Authorization: CANARY } },
        req: { headers: { authorization: CANARY } },
      },
      'startup',
    );
    log.error({ err: { message: 'nested', config: { gateway: { auth: { keys: [CANARY] } } } } }, 'boom');

    const output = lines().join('\n');
    expect(output.length).toBeGreaterThan(0);
    expect(output).not.toContain(CANARY);
    for (const key of REDACTED_KEYS) {
      expect(output).toContain(`"${key}":"[Redacted]"`);
    }
  });

  it('scrubs known secret VALUES from the message string and err.message', () => {
    // pino's key-based redaction cannot reach these two paths; the value-scrubbing hook
    // is what closes them (verified: https://getpino.io/#/docs/api#logmethod).
    const { sink, lines } = captureSink();
    const log = createLogger({ level: 'trace', destination: sink, secrets: [CANARY] });

    log.info({ upstream: 'github' }, `startup with ${CANARY}`);
    log.error({ err: { message: `failed for ${CANARY}` } }, 'boom');

    const output = lines().join('\n');
    expect(output).not.toContain(CANARY);
    expect(output).toContain('[Redacted]');
    // Non-secret context survives.
    expect(output).toContain('github');
  });

  it('ignores secrets too short to scrub safely', () => {
    expect(scrubSecrets('a-b-a', ['a'])).toBe('a-b-a');
    expect(scrubSecrets('x-y', ['x'])).toBe('x-y');
    const long = 'y'.repeat(MIN_SCRUBBABLE_SECRET);
    expect(scrubSecrets(`before ${long} after`, [long])).toBe('before [Redacted] after');
  });

  it('keeps non-secret context so logs stay useful', () => {
    const { sink, lines } = captureSink();
    const log = createLogger({ destination: sink });
    log.info({ upstream: 'github', status: 'ready', headers: { Authorization: CANARY } }, 'upstream ready');

    const parsed = JSON.parse(lines()[0] ?? '{}') as Record<string, unknown>;
    expect(parsed['upstream']).toBe('github');
    expect(parsed['status']).toBe('ready');
    expect(JSON.stringify(parsed)).not.toContain(CANARY);
  });

  it('treats casing variants as redacted but not substrings', () => {
    expect(isRedactedKey('Authorization')).toBe(true);
    expect(isRedactedKey('APIKEY')).toBe(true);
    expect(isRedactedKey('ApiKey')).toBe(true);
    expect(isRedactedKey('tokenizer')).toBe(false);
    for (const key of REDACTED_KEYS) {
      expect(isRedactedKey(key)).toBe(true);
    }
  });

  it('redactValue breaks cycles instead of throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'a', authorization: CANARY };
    cyclic['self'] = cyclic;
    const out = redactValue(cyclic) as Record<string, unknown>;
    expect(out['name']).toBe('a');
    expect(JSON.stringify(out)).not.toContain(CANARY);
    expect(out['self']).toBe('[Redacted]');
  });

  it('safe() passes a value through redaction before it can be logged', () => {
    expect(JSON.stringify(safe({ nested: { secret: CANARY } }))).not.toContain(CANARY);
  });

  it('secretsFromConfig collects only literal values, never placeholders', () => {
    const values = secretsFromConfig({
      gateway: { auth: { keys: [CANARY] } },
      mcp: {
        github: { headers: { Authorization: `Bearer ${CANARY}` } },
        fs: { headers: {} },
      },
    });
    expect(values).toContain(CANARY);
    expect(values.join('|')).not.toContain('{env:');
  });
});

describe('configSummary', () => {
  it('reports upstream names and types but never values', () => {
    const summary = configSummary({
      host: '0.0.0.0',
      port: 3000,
      auth: { keys: [CANARY] },
      mcp: {
        github: { type: 'remote', url: 'https://example.com/mcp', headers: { Authorization: CANARY } },
        fs: { type: 'local', command: ['npx', '-y', 'x'], environment: { TOKEN: CANARY } },
      },
    });
    const json = JSON.stringify(summary);
    expect(json).not.toContain(CANARY);
    expect(summary['upstreamCount']).toBe(2);
    expect(summary['upstreams']).toEqual({
      github: { type: 'remote', enabled: undefined },
      fs: { type: 'local', enabled: undefined },
    });
  });
});