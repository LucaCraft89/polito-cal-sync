/* eslint-disable @typescript-eslint/no-unsafe-member-access -- test code reads loose JSON answers */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRunLock } from '../src/sync/lock.js';
import { StateStore } from '../src/sync/state.js';
import { startHarness, type Harness, type Reply } from './support/web.js';
import { CAL_ID, FEED, ics, previewWorld } from './support/preview-world.js';

// Sync now WRITES to the calendar, so every test runs against the in-memory Google (MemoryEventsApi) and an
// in-memory feed. Nothing here can reach a real calendar or server.
const SECRET = 'password-that-must-not-leak-9X'; // secret-scan:ignore
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const feed = (n: number, from = 0): string =>
  ics(
    ...Array.from(
      { length: n },
      (_, i) =>
        [
          `ev${from + i}`,
          `2026-11-${String(10 + ((from + i) % 15)).padStart(2, '0')}T09:00:00Z`.replace(
            /[-:]/g,
            '',
          ),
          `Lesson ${from + i}`,
        ] as [string, string, string],
    ),
  );

async function setup(o: { events?: number } = {}) {
  const clock = { t: 1_800_000_000_000 };
  let events = o.events ?? 1;
  let skip = 0;
  const world = previewWorld(() => feed(events, skip));
  h = await startHarness({
    env: { TZ: 'Europe/Rome' },
    app: { runDeps: world.deps, previewMinIntervalMs: 0, now: () => clock.t },
  });
  const auth = await h.setup();
  const post = (path: string, body: unknown = {}) =>
    h!.call('POST', path, { body, cookie: auth.cookie, headers: { 'X-CSRF-Token': auth.csrf } });
  const get = (path: string) => h!.call('GET', path, { cookie: auth.cookie });
  await h.put('/api/settings', auth, { set: { icsUrls: [FEED], 'polito.password': SECRET } });
  const preview = async () => {
    const r = await post('/api/preview');
    if (r.status !== 200) throw new Error(`preview failed: ${r.text}`);
    return r.json.preview as {
      generatedAt: string;
      counts: { creates: number; deletes: number };
      safety: { exceeded: boolean; deletes: number };
    };
  };
  const confirm = (p: { generatedAt: string }, extra: object = {}) =>
    post('/api/sync', { previewAt: p.generatedAt, confirm: true, ...extra });
  const done = async (): Promise<Reply> => {
    for (let i = 0; i < 200; i++) {
      const r = await get('/api/sync');
      if (r.json.run.state === 'done') return r;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    throw new Error('sync did not finish');
  };
  const managed = () => world.api.snapshot(CAL_ID).filter((e) => e.status !== 'cancelled');
  return {
    clock,
    world,
    auth,
    post,
    get,
    preview,
    confirm,
    done,
    managed,
    setEvents: (n: number, from = 0) => {
      events = n;
      skip = from;
    },
  };
}

describe('Sync now: guards', () => {
  it('needs a session and a CSRF token', async () => {
    const s = await setup();
    expect((await h!.call('POST', '/api/sync', { body: {} })).status).toBe(401);
    expect((await h!.call('GET', '/api/sync')).status).toBe(401);
    const r = await h!.call('POST', '/api/sync', { body: {}, cookie: s.auth.cookie });
    expect(r.status).toBe(403);
    expect(s.world.api.writes).toHaveLength(0);
  });

  it('starts idle, and refuses without a preview (nothing written)', async () => {
    const s = await setup();
    expect((await s.get('/api/sync')).json).toEqual({
      run: { state: 'idle' },
      nextAllowedAt: null,
    });
    const r = await s.post('/api/sync', { previewAt: '2026-01-01T00:00:00.000Z', confirm: true });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('E_UI_SYNC_NEEDS_PREVIEW');
    expect(s.world.api.writes).toHaveLength(0);
  });

  it('wants exactly {previewAt, confirm: true}: other bodies are refused', async () => {
    const s = await setup();
    const p = await s.preview();
    for (const body of [
      {},
      { previewAt: p.generatedAt },
      { previewAt: p.generatedAt, confirm: false },
      { previewAt: p.generatedAt, confirm: 'yes' },
      { previewAt: p.generatedAt, confirm: true, force: true },
      { confirm: true },
    ]) {
      const r = await s.post('/api/sync', body);
      expect(r.status, JSON.stringify(body)).toBe(403);
    }
    expect(s.world.api.writes).toHaveLength(0);
  });

  it('only the preview that was looked at, and only while it is fresh and the settings are unchanged', async () => {
    const s = await setup();
    const p = await s.preview();
    const other = await s.post('/api/sync', {
      previewAt: '2020-01-01T00:00:00.000Z',
      confirm: true,
    });
    expect(other.json.error.code).toBe('E_UI_SYNC_NEEDS_PREVIEW');
    expect(other.json.error.why).toContain('not the latest');

    // A setting that changes what a sync does makes it stale; the interval does not.
    await h!.put('/api/settings', s.auth, { set: { syncIntervalMinutes: 120 } });
    s.clock.t += 60_000;
    expect((await s.confirm(p)).status).toBe(202);
    await s.done();

    const s2 = await setup();
    const p2 = await s2.preview();
    await h!.put('/api/settings', s2.auth, { set: { deleteThreshold: 0.5 } });
    const changed = await s2.confirm(p2);
    expect(changed.json.error.code).toBe('E_UI_SYNC_NEEDS_PREVIEW');
    expect(changed.json.error.why).toContain('setting changed');

    const s3 = await setup();
    const p3 = await s3.preview();
    s3.clock.t += 31 * 60_000;
    const old = await s3.confirm(p3);
    expect(old.json.error.code).toBe('E_UI_SYNC_NEEDS_PREVIEW');
    expect(old.json.error.why).toContain('30 minutes');
    expect(s3.world.api.writes).toHaveLength(0);
  });
});

describe('Sync now: the run', () => {
  it('writes the confirmed plan, records the run, clears the preview and leaves an audit trail', async () => {
    const s = await setup({ events: 3 });
    const p = await s.preview();
    expect(p.counts.creates).toBe(3);
    expect(s.managed()).toHaveLength(0); // the preview wrote nothing
    const start = await s.confirm(p);
    expect(start.status).toBe(202);
    expect(start.json.run.state).toBe('running');
    const end = await s.done();
    expect(end.json.run.result).toMatchObject({
      status: 'ok',
      created: 3,
      patched: 0,
      deleted: 0,
      failed: 0,
    });
    expect(end.json.nextAllowedAt).toBe(new Date(s.clock.t + 15 * 60_000).toISOString());
    expect(s.managed()).toHaveLength(3);
    // Every written event carries our marker, in the one calendar.
    expect(s.world.api.writes.every((c) => c.calendarId === CAL_ID)).toBe(true);
    expect(
      s.managed().every((e) => e.extendedProperties?.private?.['polito_cal_sync'] === '1'),
    ).toBe(true);
    const state = StateStore.open(StateStore.fileIn(h!.dataDir));
    const last = state.lastRun();
    state.close();
    expect(last).toMatchObject({ status: 'ok', created: 3, forced: false });
    // The preview described the calendar before the run: a new one is needed.
    expect((await s.get('/api/preview')).json.preview).toBeNull();
    const again = await s.confirm(p);
    expect(again.json.error.code).toBe('E_UI_SYNC_NEEDS_PREVIEW');
    const audit = (await s.get('/api/audit')).json.entries as { action: string }[];
    expect(audit.map((e) => e.action)).toEqual(
      expect.arrayContaining(['sync.started', 'sync.finished']),
    );
    const everything = [
      start.text,
      end.text,
      ...h!.logs,
      readFileSync(join(h!.dataDir, 'audit.log'), 'utf8'),
    ].join('\n');
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('Lesson 0'); // counts only
  });

  it('is limited to one start per 15 minutes; a refusal changes nothing and costs no traffic', async () => {
    const s = await setup();
    await s.confirm(await s.preview());
    await s.done();
    const writes = s.world.api.writes.length;
    s.setEvents(2);
    const p = await s.preview();
    const r = await s.confirm(p);
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe('E_UI_SYNC_RATE_LIMITED');
    expect(s.world.api.writes).toHaveLength(writes);
    s.clock.t += 15 * 60_000 + 1;
    const p2 = await s.preview();
    expect((await s.confirm(p2)).status).toBe(202);
    const end = await s.done();
    expect(end.json.run.result.status).toBe('ok');
    expect(s.managed()).toHaveLength(2);
  });

  it('a second start while one runs is refused, and shutdown can wait for the run (settle)', async () => {
    const s = await setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const p = await s.preview();
    const base = s.world.deps.googleFactory!;
    s.world.deps.googleFactory = async (c) => {
      await gate;
      return base(c);
    };
    expect((await s.confirm(p)).status).toBe(202);
    let settled = false;
    void h!.web.settle().then(() => (settled = true));
    const second = await s.confirm(p);
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe('E_SYNC_ALREADY_RUNNING');
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    release();
    await s.done();
    await h!.web.settle();
    expect(settled).toBe(true);
  });

  it('takes the run lock of decision 012: while serve or a manual sync holds it, nothing is written', async () => {
    const s = await setup();
    const p = await s.preview();
    const lock = acquireRunLock(h!.dataDir);
    try {
      expect((await s.confirm(p)).status).toBe(202);
      const end = await s.done();
      expect(end.json.run.result.status).toBe('failed');
      expect(end.json.run.result.error.code).toBe('E_SYNC_ALREADY_RUNNING');
      expect(s.world.api.writes).toHaveLength(0);
    } finally {
      lock.release();
    }
  });

  it('a Google failure is a result with the three-line problem, not a hang', async () => {
    const s = await setup();
    const p = await s.preview();
    s.world.deps.googleFactory = () => Promise.reject(new Error('boom'));
    expect((await s.confirm(p)).status).toBe(202);
    const end = await s.done();
    expect(end.json.run.result.status).toBe('failed');
    expect(end.json.run.result.error.code).toBe('E_INTERNAL');
  });
});

describe('Sync now: removals', () => {
  /** A calendar that already holds `n` events we wrote, then a feed that lost `lost` of them. */
  async function withManaged(n: number, lost: number) {
    const s = await setup({ events: n });
    await s.confirm(await s.preview());
    await s.done();
    expect(s.managed()).toHaveLength(n);
    s.clock.t += 16 * 60_000;
    s.setEvents(n - lost, lost); // the last n - lost events remain
    return s;
  }

  it('within the limit: no typed confirmation, the removal happens', async () => {
    const s = await withManaged(10, 2);
    const p = await s.preview();
    expect(p.counts.deletes).toBe(2);
    expect(p.safety.exceeded).toBe(false);
    expect((await s.confirm(p)).status).toBe(202);
    const end = await s.done();
    expect(end.json.run.result).toMatchObject({ status: 'ok', deleted: 2 });
    expect(s.managed()).toHaveLength(8);
  });

  it('beyond the limit: needs the typed phrase "remove N", only then is the run forced', async () => {
    const s = await withManaged(5, 5); // a complete but empty source: the 100% case
    const p = await s.preview();
    expect(p.safety).toMatchObject({ exceeded: true, deletes: 5 });
    for (const typed of [undefined, '', 'yes', 'remove 4', 'remove all']) {
      const r = await s.confirm(p, typed === undefined ? {} : { typed });
      expect(r.status, String(typed)).toBe(422);
      expect(r.json.error.code).toBe('E_UI_SYNC_CONFIRMATION');
      expect(r.json.error.action).toContain('remove 5');
    }
    expect(s.managed()).toHaveLength(5); // nothing removed, nothing started, no rate limit consumed
    expect((await s.get('/api/sync')).json.run.state).toBe('done'); // still the first run's result
    const ok = await s.confirm(p, { typed: '  Remove 5 ' });
    expect(ok.status).toBe(202);
    const end = await s.done();
    expect(end.json.run.result).toMatchObject({ status: 'ok', deleted: 5 });
    expect(s.managed()).toHaveLength(0);
    const state = StateStore.open(StateStore.fileIn(h!.dataDir));
    const last = state.lastRun();
    state.close();
    expect(last).toMatchObject({ status: 'ok', deleted: 5, forced: true });
  });

  it('the typed phrase does not allow MORE removals than the preview showed (plan changed)', async () => {
    const s = await withManaged(10, 1);
    const p = await s.preview();
    expect(p.counts.deletes).toBe(1);
    s.setEvents(7, 3); // meanwhile the source lost two more events: 3 removals, still within the 30% limit
    expect((await s.confirm(p)).status).toBe(202);
    const end = await s.done();
    expect(end.json.run.result.status).toBe('refused');
    expect(end.json.run.result.error.code).toBe('E_SYNC_PLAN_CHANGED');
    expect(end.json.run.result).toMatchObject({ created: 0, patched: 0, deleted: 0 });
    expect(s.managed()).toHaveLength(10);
    const state = StateStore.open(StateStore.fileIn(h!.dataDir));
    const last = state.lastRun();
    state.close();
    expect(last).toMatchObject({ status: 'refused', errorCode: 'E_SYNC_PLAN_CHANGED' });
  });

  it('a forced run is also held to the confirmed number', async () => {
    const s = await withManaged(5, 5);
    const p = await s.preview();
    // The feed stays empty: the removals are the same 5 that were confirmed.
    s.setEvents(0, 5);
    expect((await s.confirm(p, { typed: 'remove 5' })).status).toBe(202);
    const end = await s.done();
    expect(end.json.run.result).toMatchObject({ status: 'ok', deleted: 5 });
  });
});
