import Database from 'better-sqlite3';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateStore } from '../src/sync/state.js';

const T0 = new Date('2026-11-04T10:00:00Z');
const T1 = new Date('2026-11-04T10:00:05Z');
const zero = { created: 0, patched: 0, deleted: 0, unchanged: 0, failed: 0 };

describe('StateStore', () => {
  it('records a run and returns it as the last run', () => {
    const s = StateStore.open(':memory:');
    const id = s.startRun({ calendarId: 'c', forced: true, now: T0 });
    expect(s.lastRun()).toMatchObject({ id, status: 'running', forced: true, finishedAt: null });
    s.finishRun(
      id,
      {
        ...zero,
        status: 'partial',
        created: 2,
        failed: 1,
        errorCode: 'E_ID_COLLISION',
        details: { x: 1 },
      },
      T1,
    );
    expect(s.lastRun()).toMatchObject({
      status: 'partial',
      created: 2,
      failed: 1,
      errorCode: 'E_ID_COLLISION',
      details: { x: 1 },
      finishedAt: T1.toISOString(),
    });
  });

  it('mirrors what was written and forgets what was removed', () => {
    const s = StateStore.open(':memory:');
    const row = { googleId: 'g1', source: 'ics', sourceId: '1', kind: 'lecture', hash: 'h1' };
    s.recordApplied('c', [row, { ...row, googleId: 'g2', sourceId: '2' }], T0);
    s.recordApplied('c', [{ ...row, hash: 'h2' }], T1); // upsert, not duplicate
    expect(s.managedCount('c')).toBe(2);
    s.forget(['g1']);
    expect(s.managedCount('c')).toBe(1);
    expect(s.managedCount('other')).toBe(0);
  });

  it('marks a run that was left "running" by a crash as failed on next open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcs-state-'));
    const path = StateStore.fileIn(dir);
    const a = StateStore.open(path);
    a.startRun({ calendarId: 'c', forced: false, now: T0 });
    a.close();
    const b = StateStore.open(path);
    expect(b.lastRun()).toMatchObject({ status: 'failed', errorCode: 'E_INTERNAL' });
    b.close();
  });

  it('keeps the file private (0600)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcs-state-'));
    const path = StateStore.fileIn(dir);
    StateStore.open(path).close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses a database written by a newer version (E_STATE_DB_SCHEMA_NEWER)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcs-state-'));
    const path = StateStore.fileIn(dir);
    const raw = new Database(path);
    raw.pragma('user_version = 99');
    raw.close();
    expect(() => StateStore.open(path)).toThrowError(/E_STATE_DB_SCHEMA_NEWER/);
  });

  it('reports an unreadable file as E_STATE_DB_OPEN_FAILED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcs-state-'));
    expect(() => StateStore.open(join(dir, 'missing-dir', 'state.db'))).toThrowError(
      /E_STATE_DB_OPEN_FAILED/,
    );
  });
});
