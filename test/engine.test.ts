import { describe, expect, it } from 'vitest';
import { GoogleApiError } from '../src/google/types.js';
import { runSync, type SyncDeps } from '../src/sync/engine.js';
import { googleEventId } from '../src/sync/mapper.js';
import { StateStore } from '../src/sync/state.js';
import type { SourceResult } from '../src/sources/types.js';
import { CAL, TZ, event, makeCalendar, seedForeign, seedManaged } from './support/helpers.js';

const idOf = (n: number) => googleEventId('ics', `ev-${n}`);
const result = (ns: number[], complete = true): SourceResult => ({
  source: 'ics',
  complete,
  events: ns.map((n) => event(n)),
});
const NOW = new Date('2026-11-04T10:00:00Z');

function setup() {
  const cal = makeCalendar();
  const state = StateStore.open(':memory:');
  const deps: SyncDeps = { calendar: cal.calendar, tz: TZ, threshold: 0.3, state, now: () => NOW };
  return { ...cal, state, deps };
}

describe('runSync: apply', () => {
  it('creates, patches, deletes and leaves unchanged events alone', async () => {
    const { api, deps, state } = setup();
    seedManaged(api, 1); // unchanged
    seedManaged(api, 2, { location: 'Old room' }); // will be patched
    for (const n of [3, 4, 5, 6, 7, 8]) seedManaged(api, n); // unchanged filler
    seedManaged(api, 9); // will be deleted (1 of 9 managed = 11%)
    const report = await runSync(deps, [result([1, 2, 3, 4, 5, 6, 7, 8, 10])], {
      dryRun: false,
      force: false,
    });

    expect(report.status).toBe('ok');
    expect(report.applied).toMatchObject({ created: 1, patched: 1, deleted: 1, failures: [] });
    expect(report.plan.unchanged).toBe(7);
    const live = api.snapshot(CAL).filter((e) => e.status !== 'cancelled');
    expect(live.find((e) => e.id === idOf(2))?.location).toBe('Room 1');
    expect(live.some((e) => e.id === idOf(10))).toBe(true);
    expect(live.some((e) => e.id === idOf(9))).toBe(false);
    expect(api.writes.map((w) => w.op).sort()).toEqual(['delete', 'insert', 'patch']);
    expect(state.lastRun()).toMatchObject({
      status: 'ok',
      created: 1,
      patched: 1,
      deleted: 1,
      unchanged: 7,
    });
    expect(state.managedCount(CAL)).toBe(2); // the ones written in this run
  });

  it('is idempotent: running twice makes the second run a no-op with zero writes', async () => {
    const { api, deps } = setup();
    await runSync(deps, [result([1, 2, 3])], { dryRun: false, force: false });
    const writesAfterFirst = api.writes.length;
    const second = await runSync(deps, [result([1, 2, 3])], { dryRun: false, force: false });
    expect(second.status).toBe('ok');
    expect(second.plan).toMatchObject({ creates: [], patches: [], deletes: [], unchanged: 3 });
    expect(api.writes.length).toBe(writesAfterFirst);
  });

  it('removes an event that vanished from the source, then re-adds it when it returns', async () => {
    const { api, deps } = setup();
    for (const n of [1, 2, 3, 4])
      await runSync(deps, [result([1, 2, 3, 4].slice(0, n))], { dryRun: false, force: false });
    const removed = await runSync(deps, [result([1, 2, 3])], { dryRun: false, force: false });
    expect(removed.applied?.deleted).toBe(1);
    const back = await runSync(deps, [result([1, 2, 3, 4])], { dryRun: false, force: false });
    expect(back.applied?.created).toBe(1); // id blocked by tombstone -> revived
    expect(api.snapshot(CAL).filter((e) => e.status !== 'cancelled')).toHaveLength(4);
  });

  it('never touches events that are not ours, whatever the sources say', async () => {
    const { api, deps } = setup();
    seedForeign(api, 'foreign1', 'Dentist');
    seedForeign(api, idOf(1), 'Squatting on our id');
    seedManaged(api, 2);
    const report = await runSync(deps, [result([1, 3])], { dryRun: false, force: true });
    expect(report.status).toBe('partial');
    expect(report.applied?.failures).toEqual([
      expect.objectContaining({ op: 'create', code: 'E_ID_COLLISION', sourceId: 'ev-1' }),
    ]);
    expect(report.applied).toMatchObject({ created: 1, deleted: 1 });
    const byId = new Map(api.snapshot(CAL).map((e) => [e.id, e]));
    expect(byId.get('foreign1')?.summary).toBe('Dentist');
    expect(byId.get(idOf(1))?.summary).toBe('Squatting on our id');
    expect(api.calls.filter((c) => c.eventId === 'foreign1' && c.op !== 'list')).toEqual([]);
  });
});

describe('runSync: deletion safety threshold', () => {
  it('refuses the whole run when too many events would go, and writes nothing', async () => {
    const { api, deps, state } = setup();
    for (const n of [1, 2, 3, 4, 5]) seedManaged(api, n);
    const report = await runSync(deps, [result([1, 6])], { dryRun: false, force: false });
    expect(report.status).toBe('refused');
    expect(report.error).toMatchObject({ code: 'E_DELETE_THRESHOLD' });
    expect(report.error?.what).toContain('4 of the 5');
    expect(api.writes).toEqual([]); // not even the harmless create of ev-6
    expect(state.lastRun()).toMatchObject({ status: 'refused', errorCode: 'E_DELETE_THRESHOLD' });
  });

  it('refuses when a complete source returns nothing at all', async () => {
    const { api, deps } = setup();
    for (const n of [1, 2, 3]) seedManaged(api, n);
    const report = await runSync(deps, [result([])], { dryRun: false, force: false });
    expect(report.status).toBe('refused');
    expect(api.writes).toEqual([]);
  });

  it('proceeds with --force', async () => {
    const { api, deps, state } = setup();
    for (const n of [1, 2, 3, 4, 5]) seedManaged(api, n);
    const report = await runSync(deps, [result([1])], { dryRun: false, force: true });
    expect(report.status).toBe('ok');
    expect(report.applied?.deleted).toBe(4);
    expect(state.lastRun()).toMatchObject({ status: 'ok', forced: true });
  });

  it('does not delete anything for an incomplete fetch, and does not refuse for it', async () => {
    const { api, deps } = setup();
    for (const n of [1, 2, 3, 4, 5]) seedManaged(api, n);
    const report = await runSync(deps, [result([1, 6], false)], { dryRun: false, force: false });
    expect(report.status).toBe('ok');
    expect(report.applied).toMatchObject({ created: 1, deleted: 0 });
    expect(report.plan.incompleteSources).toEqual(['ics']);
    expect(api.snapshot(CAL).filter((e) => e.status !== 'cancelled')).toHaveLength(6);
  });
});

describe('runSync: dry run', () => {
  it('returns the plan and performs no writes and no state changes', async () => {
    const { api, deps, state } = setup();
    for (const n of [1, 2, 3, 4]) seedManaged(api, n);
    seedForeign(api, 'foreign1');
    const before = JSON.stringify(api.snapshot(CAL));
    const report = await runSync(deps, [result([1, 2, 3, 5])], { dryRun: true, force: false });
    expect(report.status).toBe('dry-run');
    expect(report.plan).toMatchObject({ unchanged: 3 });
    expect(report.plan.creates).toHaveLength(1);
    expect(report.plan.deletes).toHaveLength(1);
    expect(api.writes).toEqual([]);
    expect(JSON.stringify(api.snapshot(CAL))).toBe(before);
    expect(state.lastRun()).toBeUndefined();
  });

  it('shows that the real run would be refused', async () => {
    const { api, deps } = setup();
    for (const n of [1, 2, 3]) seedManaged(api, n);
    const report = await runSync(deps, [result([])], { dryRun: true, force: false });
    expect(report.status).toBe('dry-run');
    expect(report.error?.code).toBe('E_DELETE_THRESHOLD');
    expect(api.writes).toEqual([]);
  });

  it('does not need a state store', async () => {
    const { deps } = setup();
    const report = await runSync(
      { calendar: deps.calendar, tz: deps.tz, threshold: deps.threshold },
      [result([1])],
      { dryRun: true, force: false },
    );
    expect(report.plan.creates).toHaveLength(1);
  });
});

describe('runSync: failures', () => {
  it('stops at once on a fatal error and records the run as failed', async () => {
    const { api, deps, state } = setup();
    api.failNext('insert', new GoogleApiError({ status: 401 }), 99);
    const report = await runSync(deps, [result([1, 2, 3])], { dryRun: false, force: false });
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('E_GOOGLE_AUTH_EXPIRED');
    expect(api.calls.filter((c) => c.op === 'insert')).toHaveLength(1); // did not hammer on
    expect(state.lastRun()).toMatchObject({ status: 'failed', errorCode: 'E_GOOGLE_AUTH_EXPIRED' });
  });

  it('throws the coded error and records a failed run when listing fails', async () => {
    const { api, deps, state } = setup();
    api.failNext('list', new GoogleApiError({ status: 404, reason: 'notFound' }));
    await expect(
      runSync(deps, [result([1])], { dryRun: false, force: false }),
    ).rejects.toMatchObject({
      code: 'E_GOOGLE_CALENDAR_NOT_FOUND',
    });
    expect(state.lastRun()).toMatchObject({
      status: 'failed',
      errorCode: 'E_GOOGLE_CALENDAR_NOT_FOUND',
    });
  });

  it('keeps going after a non-fatal failure and reports a partial run', async () => {
    const { api, deps } = setup();
    api.failNext('insert', new GoogleApiError({ status: 400, reason: 'invalid' }));
    const report = await runSync(deps, [result([1, 2, 3])], { dryRun: false, force: false });
    expect(report.status).toBe('partial');
    expect(report.applied).toMatchObject({ created: 2 });
    expect(report.applied?.failures).toHaveLength(1);
    expect(report.applied?.failures[0]).toMatchObject({ code: 'E_GOOGLE_REQUEST_FAILED' });
  });

  it('does not put event titles into the stored run details', async () => {
    const { api, deps, state } = setup();
    api.failNext('insert', new GoogleApiError({ status: 400, reason: 'invalid' }));
    await runSync(deps, [result([1])], { dryRun: false, force: false });
    expect(JSON.stringify(state.lastRun()?.details)).not.toContain('Lecture');
  });
});
