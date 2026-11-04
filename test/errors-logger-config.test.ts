import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureDataDir, loadConfig } from '../src/config/index.js';
import { formatUserError, toUserError, UserError } from '../src/util/errors.js';
import { createLogger } from '../src/util/logger.js';

const fakeToken = 'ya29.' + 'a0Af'.repeat(10);

describe('errors', () => {
  it('formats code, what, why, action and docs link', () => {
    const text = formatUserError(
      new UserError({ code: 'E_USAGE', what: 'Bad.', why: 'Typo.', action: 'Fix it.' }),
    );
    expect(text).toBe(
      ['E_USAGE: Bad.', '  Why:  Typo.', '  Do:   Fix it.', '  Docs: docs/ERRORS.md#e_usage'].join(
        '\n',
      ),
    );
  });
  it('wraps unknown errors as E_INTERNAL without a stack trace', () => {
    const text = formatUserError(new Error('boom'));
    expect(toUserError(new Error('x')).code).toBe('E_INTERNAL');
    expect(text).toContain('E_INTERNAL');
    expect(text).not.toMatch(/\n\s+at /);
  });
  it('never prints secrets even if one is in the message', () => {
    const text = formatUserError(new Error(`request failed for ${fakeToken}`));
    expect(text).not.toContain(fakeToken);
  });
});

describe('logger', () => {
  function capture() {
    const lines: string[] = [];
    const logger = createLogger('debug', { write: (s: string) => void lines.push(s) });
    return { lines, logger };
  }
  it('censors secret fields and scrubs messages and errors', () => {
    const { lines, logger } = capture();
    logger.info(
      { token: 'plain-token-value', nested: { password: 'hunter2' } },
      `got ${fakeToken}`,
    );
    logger.error({ err: new Error(`bad ${fakeToken}`) }, 'failed');
    const all = lines.join('');
    expect(all).not.toContain('plain-token-value');
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain(fakeToken);
    expect(all).toContain('[REDACTED]');
  });
});

describe('config', () => {
  it('applies defaults', () => {
    const c = loadConfig({});
    expect(c.tz).toBe('Europe/Rome');
    expect(c.syncIntervalMinutes).toBe(60);
    expect(c.deleteThreshold).toBe(0.3);
  });
  it('treats empty strings as unset (as in .env.example)', () => {
    expect(
      loadConfig({ SYNC_INTERVAL_MINUTES: '', GOOGLE_CLIENT_ID: '' }).google.clientId,
    ).toBeUndefined();
  });
  it('reports every problem by name and never echoes values', () => {
    const secretish = 'not-a-zone-' + 'zzzzzzzz';
    try {
      loadConfig({ TZ: secretish, SYNC_INTERVAL_MINUTES: '5', DELETE_THRESHOLD: '7' });
      expect.unreachable();
    } catch (e) {
      const err = e as UserError;
      expect(err.code).toBe('E_CONFIG_INVALID');
      expect(err.what).toContain('TZ');
      expect(err.what).toContain('SYNC_INTERVAL_MINUTES');
      expect(err.what).toContain('DELETE_THRESHOLD');
      expect(formatUserError(err)).not.toContain(secretish);
    }
  });
  it('creates the data dir and rejects an unusable one', () => {
    const base = mkdtempSync(join(tmpdir(), 'pcs-'));
    ensureDataDir(join(base, 'a', 'b'));
    const file = join(base, 'file');
    writeFileSync(file, 'x');
    chmodSync(file, 0o600);
    expect(() => ensureDataDir(file)).toThrowError(/E_DATA_DIR_NOT_WRITABLE/);
  });
});

describe('POLITO_SQUADS', () => {
  it('parses course=squad pairs, upper-cases, allows several squads per course', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const c = loadConfig({ POLITO_SQUADS: ' 309885=b , 309742=2,309742=3 ' });
    expect(c.polito.squads).toEqual({ '309885': ['B'], '309742': ['2', '3'] });
    expect(loadConfig({}).polito.squads).toEqual({});
  });
  it('rejects a malformed value naming the variable, not the value', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    expect(() => loadConfig({ POLITO_SQUADS: 'garbled value' })).toThrowError(/POLITO_SQUADS/);
    expect(() => loadConfig({ POLITO_SQUADS: 'garbled value' })).not.toThrowError(/garbled value/);
  });
});
