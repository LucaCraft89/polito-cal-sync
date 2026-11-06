/* eslint-disable @typescript-eslint/no-unsafe-assignment -- test code reads loose JSON answers */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { AuditLog } from '../src/settings/audit.js';
import { describeSettings, SETTING_FIELDS } from '../src/settings/fields.js';
import { loadConfigFromDisk, SettingsStore } from '../src/settings/store.js';
import { UserError } from '../src/util/errors.js';

const dir = () => mkdtempSync(join(tmpdir(), 'pcs-settings-'));
// Invented values; assembled so the repository secret scan does not mistake them for real ones.
const PW = ['invented', 'portal', 'pw', '123'].join('-');

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof UserError ? e.code : 'other';
  }
  return undefined;
}

describe('settings store', () => {
  it('saves atomically with mode 0600 and a versioned file', () => {
    const d = dir();
    const store = new SettingsStore(d, new AuditLog(d), () => new Date('2026-11-05T10:00:00Z'));
    expect(store.read()).toEqual({});
    const changed = store.apply(
      { set: { syncIntervalMinutes: 30, 'polito.squads': { '309865': ['A'] } } },
      {},
    );
    expect(changed.sort()).toEqual(['polito.squads', 'syncIntervalMinutes']);
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    const file = JSON.parse(readFileSync(store.file, 'utf8'));
    expect(file).toMatchObject({ version: 1, updatedAt: '2026-11-05T10:00:00.000Z' });
    expect(store.read()).toEqual({ syncIntervalMinutes: 30, 'polito.squads': { '309865': ['A'] } });
  });

  it('is layered UNDER the environment: env wins, the file fills the gaps', () => {
    const d = dir();
    new SettingsStore(d).apply(
      { set: { syncIntervalMinutes: 30, deleteThreshold: 0.5, 'polito.examCalls': 'all' } },
      {},
    );
    const cfg = loadConfigFromDisk({ DATA_DIR: d, SYNC_INTERVAL_MINUTES: '120' });
    expect(cfg.syncIntervalMinutes).toBe(120); // env wins
    expect(cfg.deleteThreshold).toBe(0.5); // from the file
    expect(cfg.polito.examCalls).toBe('all');
    // an EMPTY variable means "not set", exactly as in .env
    expect(loadConfigFromDisk({ DATA_DIR: d, SYNC_INTERVAL_MINUTES: '' }).syncIntervalMinutes).toBe(
      30,
    );
  });

  it('applies the same range rules as .env, naming the setting and never the value', () => {
    const d = dir();
    const store = new SettingsStore(d);
    let err: UserError | undefined;
    try {
      store.apply({ set: { syncIntervalMinutes: 5 } }, {});
    } catch (e) {
      err = e as UserError;
    }
    expect(err?.code).toBe('E_SETTING_INVALID');
    expect(err?.what).toContain('syncIntervalMinutes');
    expect(err?.what).toContain('at least 15');
    expect(code(() => store.apply({ set: { deleteThreshold: 7 } }, {}))).toBe('E_SETTING_INVALID');
    expect(code(() => store.apply({ set: { 'polito.examCalls': 'some' } }, {}))).toBe(
      'E_SETTING_INVALID',
    );
    expect(code(() => store.apply({ set: { 'no.such': 1 } }, {}))).toBe('E_SETTING_INVALID');
    expect(code(() => store.apply({ set: { tz: 'Mars/Base' } }, {}))).toBe('E_SETTING_INVALID');
    // all or nothing: a bad value next to a good one saves nothing
    expect(
      code(() => store.apply({ set: { syncIntervalMinutes: 20, deleteThreshold: 9 } }, {})),
    ).toBe('E_SETTING_INVALID');
    expect(store.read()).toEqual({});
  });

  it('refuses to change a setting an environment variable controls', () => {
    const d = dir();
    const store = new SettingsStore(d);
    let err: UserError | undefined;
    try {
      store.apply({ set: { 'polito.username': 'someone' } }, { POLITO_USERNAME: 'fromenv' });
    } catch (e) {
      err = e as UserError;
    }
    expect(err?.code).toBe('E_SETTING_LOCKED');
    expect(err?.action).toContain('POLITO_USERNAME');
    expect(code(() => store.apply({ clear: ['polito.username'] }, { POLITO_USERNAME: 'x' }))).toBe(
      'E_SETTING_LOCKED',
    );
    expect(store.read()).toEqual({});
  });

  it('clear forgets a value; a no-op change writes nothing', () => {
    const d = dir();
    const store = new SettingsStore(d, new AuditLog(d));
    store.apply({ set: { deleteThreshold: 0.2 } }, {});
    expect(store.apply({ set: { deleteThreshold: 0.2 } }, {})).toEqual([]);
    expect(store.apply({ clear: ['deleteThreshold'] }, {})).toEqual(['deleteThreshold']);
    expect(store.read()).toEqual({});
    expect(loadConfigFromDisk({ DATA_DIR: d }).deleteThreshold).toBe(0.3);
  });

  it('a damaged or newer settings file is an error, not silently ignored', () => {
    const d = dir();
    const store = new SettingsStore(d);
    writeFileSync(store.file, '{not json');
    expect(code(() => store.read())).toBe('E_SETTINGS_FILE_INVALID');
    writeFileSync(store.file, JSON.stringify({ version: 2, updatedAt: 'x', values: {} }));
    expect(code(() => store.read())).toBe('E_SETTINGS_FILE_INVALID');
    writeFileSync(
      store.file,
      JSON.stringify({ version: 1, updatedAt: 'x', values: { syncIntervalMinutes: 'abc' } }),
    );
    expect(code(() => loadConfigFromDisk({ DATA_DIR: d }))).toBe('E_SETTINGS_FILE_INVALID');
  });

  it('the audit log records which keys changed, never a value', () => {
    const d = dir();
    const store = new SettingsStore(d, new AuditLog(d), () => new Date('2026-11-05T10:00:00Z'));
    store.apply({ set: { 'polito.password': PW, 'polito.username': 'someone' } }, {});
    store.apply({ clear: ['polito.password'] }, {});
    const log = readFileSync(join(d, 'audit.log'), 'utf8');
    expect(log).not.toContain(PW);
    expect(log).not.toContain('someone');
    const entries = new AuditLog(d).recent();
    expect(entries[0]).toMatchObject({
      action: 'settings.update',
      set: ['polito.password', 'polito.username'],
    });
    expect(entries[1]).toMatchObject({ cleared: ['polito.password'] });
    expect(statSync(join(d, 'audit.log')).mode & 0o777).toBe(0o600);
  });
});

describe('settings view', () => {
  it('shows source and lock per setting, hides secrets and feed URLs', () => {
    const d = dir();
    const feed = 'https://moodle.example.test/cal.php?authtoken=' + 'Z'.repeat(20); // secret-scan:ignore
    const values = {
      'polito.password': PW,
      icsUrls: [feed],
      deleteThreshold: 0.4,
    };
    const env = { POLITO_USERNAME: 'envuser' };
    const config = loadConfig({ ...env, DATA_DIR: d }, values);
    const view = describeSettings(env, values, config);
    const by = (k: string) => view.find((v) => v.key === k)!;
    expect(by('polito.username')).toMatchObject({ source: 'env', locked: true, value: 'envuser' });
    expect(by('deleteThreshold')).toMatchObject({ source: 'ui', locked: false, value: 0.4 });
    expect(by('syncIntervalMinutes')).toMatchObject({ source: 'default', value: 60 });
    expect(by('polito.password')).toMatchObject({ secret: true, set: true });
    expect(by('polito.password')).not.toHaveProperty('value');
    expect(by('icsUrls').value).toEqual([{ index: 1, host: 'moodle.example.test' }]);
    const text = JSON.stringify(view);
    expect(text).not.toContain(PW);
    expect(text).not.toContain('authtoken');
    expect(view).toHaveLength(SETTING_FIELDS.length);
  });
});
