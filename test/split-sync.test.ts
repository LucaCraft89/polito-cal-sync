import { describe, expect, it } from 'vitest';
import { OwnedCalendar } from '../src/google/calendar.js';
import { MemoryEventsApi } from '../src/google/memory.js';
import { GoogleApiError } from '../src/google/types.js';
import { googleEventId, toCanonical, toGoogleEvent } from '../src/sync/mapper.js';
import { runSplitSync } from '../src/sync/split.js';
import { StateStore } from '../src/sync/state.js';
import type { EventDraft, SourceResult } from '../src/sources/types.js';
import { draft } from './support/helpers.js';

// Moodle events in their own calendar (decision 040), against the in-memory Google: two calendars, one API.
const POLITO = 'cal-polito';
const MOODLE = 'cal-moodle';
const TZ = 'Europe/Rome';

const lecture = (n: number, patch: Partial<EventDraft> = {}) =>
  toCanonical(draft(n, { source: 'polito', sourceId: `l${n}`, ...patch }));
const moodle = (n: number, patch: Partial<EventDraft> = {}) =>
  toCanonical(
    draft(n, {
      source: 'moodle',
      sourceId: `m${n}`,
      kind: 'moodle',
      title: `[Moodle] Quiz ${n}`,
      ...patch,
    }),
  );
const result = (
  source: string,
  events: ReturnType<typeof toCanonical>[],
  complete = true,
): SourceResult => ({
  source,
  complete,
  events,
});

function world(o: { threshold?: number } = {}) {
  const api = new MemoryEventsApi();
  const cal = (id: string) =>
    new OwnedCalendar(api, id, { sleep: () => Promise.resolve(), random: () => 1 });
  const deps = { polito: cal(POLITO), moodle: cal(MOODLE), tz: TZ, threshold: o.threshold ?? 0.3 };
  const live = (id: string) => api.snapshot(id).filter((e) => e.status !== 'cancelled');
  const seed = (id: string, e: ReturnType<typeof toCanonical>) =>
    api.seed(id, { ...toGoogleEvent(e, TZ), id: googleEventId(e.source, e.sourceId) });
  const run = (results: SourceResult[], options = { dryRun: false, force: false }, extra = {}) =>
    runSplitSync({ ...deps, ...extra }, results, options);
  return { api, deps, live, seed, run };
}

describe('split sync: Moodle events in their own calendar', () => {
  it('routes by kind, keeps the [Moodle] title, marks every event, and a second run changes nothing', async () => {
    const w = world();
    const results = [
      result('polito', [lecture(1), lecture(2)]),
      result('moodle', [moodle(3), moodle(4)]),
    ];
    const r = await w.run(results);
    expect(r.status).toBe('ok');
    expect(r.applied).toMatchObject({ created: 4 });
    expect(w.live(POLITO).map((e) => e.summary)).toEqual(['Lecture 1', 'Lecture 2']);
    expect(w.live(MOODLE).map((e) => e.summary)).toEqual(['[Moodle] Quiz 3', '[Moodle] Quiz 4']);
    for (const e of [...w.live(POLITO), ...w.live(MOODLE)]) {
      expect(e.extendedProperties?.private?.['polito_cal_sync']).toBe('1');
    }
    const again = await w.run(results);
    expect(again.plan).toMatchObject({ creates: [], patches: [], deletes: [], unchanged: 4 });
    expect(w.api.writes.length).toBe(4); // nothing new
  });

  it('a dry run writes nothing', async () => {
    const w = world();
    const r = await w.run([result('polito', [lecture(1)]), result('moodle', [moodle(2)])], {
      dryRun: true,
      force: false,
    });
    expect(r.status).toBe('dry-run');
    expect(r.plan.creates).toHaveLength(2);
    expect(w.api.writes).toHaveLength(0);
  });

  it('switching on: Moodle events already in the Polito calendar MOVE (new copy first, then the old one is deleted) and a mass move is not a mass deletion', async () => {
    const w = world();
    const mo = [moodle(1), moodle(2), moodle(3), moodle(4)];
    for (const e of mo) w.seed(POLITO, e); // written earlier, when everything went to one calendar
    w.seed(POLITO, lecture(9));
    const results = [result('polito', [lecture(9)]), result('moodle', mo)];
    const dry = await w.run(results, { dryRun: true, force: false });
    expect(dry.moves).toEqual({ toMoodle: 4, toPolito: 0 });
    expect(dry.plan.safety).toMatchObject({ deletes: 0, exceeded: false }); // 4 of 5 events "leave", yet no deletion
    const r = await w.run(results);
    expect(r.status).toBe('ok');
    expect(w.live(MOODLE)).toHaveLength(4);
    expect(w.live(POLITO).map((e) => e.summary)).toEqual(['Lecture 9']);
    // The order: every create in the Moodle calendar happened before the first delete in the Polito calendar.
    const calls = w.api.calls.filter((c) => c.op === 'insert' || c.op === 'delete');
    const lastInsert = calls
      .map((c, i) => (c.op === 'insert' && c.calendarId === MOODLE ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);
    const firstDelete = calls.findIndex((c) => c.op === 'delete');
    expect(firstDelete).toBeGreaterThan(lastInsert);
  });

  it('a move whose new copy could not be written keeps the old copy, and the next run finishes it', async () => {
    const w = world();
    const mo = [moodle(1), moodle(2)];
    for (const e of mo) w.seed(POLITO, e);
    w.api.failNext('insert', new GoogleApiError({ status: 400, reason: 'invalid' }), 1);
    const r = await w.run([result('polito', []), result('moodle', mo)]);
    expect(r.status).toBe('partial');
    expect(w.live(MOODLE)).toHaveLength(1);
    expect(w.live(POLITO)).toHaveLength(1); // the one that could not be copied is still there: never lost
    const next = await w.run([result('polito', []), result('moodle', mo)]);
    expect(next.status).toBe('ok');
    expect(w.live(MOODLE)).toHaveLength(2);
    expect(w.live(POLITO)).toHaveLength(0);
  });

  it('each calendar has its own deletion limit and EITHER one refuses the whole run (nothing is written)', async () => {
    const w = world();
    for (const n of [1, 2, 3, 4, 5]) w.seed(MOODLE, moodle(n));
    w.seed(POLITO, lecture(1));
    // Moodle came back empty and complete (all five would go: 100%), and the Polito side has a new event.
    const results = [result('polito', [lecture(1), lecture(2)]), result('moodle', [])];
    const r = await w.run(results);
    expect(r.status).toBe('refused');
    expect(r.error?.code).toBe('E_DELETE_THRESHOLD');
    expect(w.live(MOODLE)).toHaveLength(5);
    expect(w.live(POLITO)).toHaveLength(1); // the new lecture was NOT written either
    const forced = await w.run(results, { dryRun: false, force: true });
    expect(forced.status).toBe('ok');
    expect(w.live(MOODLE)).toHaveLength(0);
    expect(w.live(POLITO)).toHaveLength(2);
  });

  it('an incomplete Moodle read deletes nothing in either calendar and still writes the rest', async () => {
    const w = world();
    for (const n of [1, 2, 3]) w.seed(MOODLE, moodle(n));
    const r = await w.run([result('polito', [lecture(1)]), result('moodle', [], false)]);
    expect(r.status).toBe('ok');
    expect(r.plan.incompleteSources).toEqual(['moodle']);
    expect(w.live(MOODLE)).toHaveLength(3);
    expect(w.live(POLITO)).toHaveLength(1);
  });

  it('switching off (merge): what is in the Moodle calendar moves back, and the report says it is empty afterwards', async () => {
    const w = world();
    const mo = [moodle(1), moodle(2)];
    for (const e of mo) w.seed(MOODLE, e);
    const r = await w.run(
      [result('polito', []), result('moodle', mo)],
      { dryRun: false, force: false },
      { routing: 'merge' },
    );
    expect(r.status).toBe('ok');
    expect(r.moves).toEqual({ toMoodle: 0, toPolito: 2 });
    expect(r.moveBack).toEqual({ empty: true });
    expect(w.live(POLITO)).toHaveLength(2);
    expect(w.live(MOODLE)).toHaveLength(0);
  });

  it('one history row for both calendars, with the merged counts', async () => {
    const w = world();
    const state = StateStore.open(':memory:');
    const r = await w.run(
      [result('polito', [lecture(1)]), result('moodle', [moodle(2), moodle(3)])],
      { dryRun: false, force: false },
      { state },
    );
    expect(r.status).toBe('ok');
    const last = state.lastRun();
    expect(last).toMatchObject({ status: 'ok', created: 3, deleted: 0 });
    expect(last?.id).toBe(1); // a single row
    expect(state.managedCount(POLITO)).toBe(1);
    expect(state.managedCount(MOODLE)).toBe(2);
    state.close();
  });
});
