import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PolitoPortalSource } from '../src/sources/polito/index.js';
import { formatUserError } from '../src/util/errors.js';
import { zonedToUtcIso } from '../src/util/zone.js';
import { html, LOGIN_FORM, opts, PASS, USER, world } from './support/portal-world.js';

// Invented data shaped like the owner's real sample (see test/fixtures/polito-portal/README.md).
const fixture = (): { data: Record<string, unknown> } & Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL('./fixtures/polito-portal/student-data.json', import.meta.url), 'utf8'),
  ) as never;

function source(
  data: unknown,
  tz = 'Europe/Rome',
  extra: object = {},
  examCalls?: 'booked' | 'all',
  squads?: Map<string, Set<string>>,
) {
  const w = world({ data });
  const dataDir = mkdtempSync(join(tmpdir(), 'pcs-polsrc-'));
  const s = new PolitoPortalSource({
    username: USER,
    password: PASS,
    tz,
    dataDir,
    ...(examCalls ? { examCalls } : {}),
    ...(squads ? { squads } : {}),
    now: () => new Date('2026-11-04T10:00:00Z'),
    portal: opts(w.fetchImpl, extra),
  });
  return { s, w, dataDir };
}

describe('zonedToUtcIso', () => {
  it('reads zone-less times in the given zone, winter and summer', () => {
    expect(zonedToUtcIso('2027-02-14T14:30:00', 'Europe/Rome')).toBe('2027-02-14T13:30:00.000Z');
    expect(zonedToUtcIso('2027-07-07T08:30:00', 'Europe/Rome')).toBe('2027-07-07T06:30:00.000Z');
    expect(zonedToUtcIso('2027-02-14T14:30', 'America/New_York')).toBe('2027-02-14T19:30:00.000Z');
    expect(zonedToUtcIso('not a time', 'Europe/Rome')).toBeUndefined();
  });
  it('handles the spring gap and the autumn overlap like decision 009', () => {
    expect(zonedToUtcIso('2027-03-28T02:30:00', 'Europe/Rome')).toBe('2027-03-28T01:30:00.000Z');
    expect(zonedToUtcIso('2026-10-25T02:30:00', 'Europe/Rome')).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('Polito portal source: mapping', () => {
  it('maps lectures, exam calls, booked exams, agenda markers and slots; is complete', async () => {
    const { s } = source(fixture(), 'Europe/Rome', {}, 'all');
    const r = await s.fetch();
    expect(r.complete).toBe(true);
    const by = new Map(r.events.map((e) => [e.sourceId, e]));
    expect(r.events).toHaveLength(7);

    expect(by.get('lecture:9001')).toMatchObject({
      kind: 'lecture',
      title: 'Invented Analysis',
      start: '2026-12-09T08:00:00.000Z',
      end: '2026-12-09T09:30:00.000Z',
      location: 'Room 9',
      course: 'polito:5001',
    });
    expect(by.get('lecture:9001')?.description).toBeUndefined();
    expect(by.get('lecture:9002')?.description).toBe('Exercises');

    // zone-less exam times are read as Europe/Rome wall time
    expect(by.get('exam:7001')).toMatchObject({
      kind: 'exam_call',
      start: '2027-02-14T13:30:00.000Z',
      end: '2027-02-14T16:00:00.000Z',
      location: 'Room 1, Room 2',
      course: 'polito:5001',
    });
    expect(by.get('exam:7001')?.description).toContain('Booking closes: 2027-02-12T13:00:00.000Z');
    expect(by.get('exam:7001')?.description).not.toContain('Booking opens');
    expect(by.get('exam:7002')).toMatchObject({
      kind: 'exam',
      start: '2027-07-07T06:30:00.000Z',
      course: 'polito:5002',
    });
    expect(by.get('exam:7002')?.description).toContain('Bring ID');
    expect(by.get('exam:7002')?.description).toContain('Booking opens: 2026-11-01T08:00:00.000Z');

    expect(by.get('agenda:3001')).toMatchObject({
      kind: 'deadline',
      allDay: true,
      start: '2026-12-20',
    });
    expect(by.get('agenda:3002')).toMatchObject({ kind: 'lecture', allDay: true });
    expect(by.get('agenda:3003')).toMatchObject({
      kind: 'booking',
      start: '2026-12-24T12:00:00.000Z',
      end: '2026-12-24T15:00:00.000Z',
      location: 'Lab 5',
    });
  });

  it('keeps only booked exams by default; every call is still checked', async () => {
    const d = fixture();
    const r = await source(d).s.fetch();
    expect(r.complete).toBe(true);
    const ids = r.events.map((e) => e.sourceId);
    expect(ids).toContain('exam:7002');
    expect(ids).not.toContain('exam:7001');
    expect(r.events.filter((e) => e.sourceId.startsWith('exam:'))).toHaveLength(1);
    expect(r.events).toHaveLength(6);

    // a call that is not booked but unreadable is still an issue: nothing may be deleted on a guess
    (d.data['appelli'] as { data: Record<string, unknown>[] }).data[0]!['examStartsAt'] =
      'tomorrow';
    const bad = await source(d).s.fetch();
    expect(bad.complete).toBe(false);
  });

  it('a call with a booking id counts as booked even without the status text', async () => {
    const d = fixture();
    const calls = (d.data['appelli'] as { data: Record<string, unknown>[] }).data;
    calls[0] = { ...calls[0], idBooking: 99 };
    delete calls[1]!['status'];
    const r = await source(d).s.fetch();
    expect(
      r.events.filter((e) => e.sourceId.startsWith('exam:') && e.kind === 'exam'),
    ).toHaveLength(2);
  });

  it('reads zone-less times in the configured zone, and exposes course names', async () => {
    const { s } = source(fixture(), 'America/New_York', {}, 'all');
    const r = await s.fetch();
    expect(r.events.find((e) => e.sourceId === 'exam:7001')?.start).toBe(
      '2027-02-14T19:30:00.000Z',
    );
    expect(s.courseNames.get('polito:5001')).toBe('Invented Analysis');
  });

  it('ignores sections it does not need', async () => {
    const d = fixture();
    d.data['career'] = 'anything at all';
    d.data['applicazioni'] = { data: [{ weird: true }] };
    expect((await source(d).s.fetch()).complete).toBe(true);
  });
});

describe('Polito portal source: squads', () => {
  const withSquads = () => {
    const d = fixture();
    const l = (d.data['orari'] as { data: { lezioni: Record<string, unknown>[] } }).data.lezioni;
    const mk = (id: number, courseId: number, description: string) => ({
      ...l[0],
      id,
      courseId,
      description,
      startsAt: '2026-12-11T11:30:00+01:00',
      endsAt: '2026-12-11T13:00:00+01:00',
    });
    l.push(
      mk(9101, 5001, 'SQUADRA A'),
      mk(9102, 5001, 'SQUADRA B'),
      mk(9103, 5002, 'Squadra 2'),
      mk(9104, 5002, 'SQUADRA 3'),
    );
    return d;
  };
  const ids = (r: { events: { sourceId: string }[] }) => r.events.map((e) => e.sourceId);

  it('without a setting every squad is kept and a note says exactly what to set', async () => {
    const { s } = source(withSquads());
    const r = await s.fetch();
    expect(r.complete).toBe(true);
    expect(ids(r)).toEqual(
      expect.arrayContaining(['lecture:9101', 'lecture:9102', 'lecture:9103', 'lecture:9104']),
    );
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0]).toContain('POLITO_SQUADS');
    expect(s.notes[0]).toContain('5001 (A, B)');
    expect(s.notes[0]).toContain('5002 (2, 3)');
  });

  it('with a setting only your squad stays (per course); lessons without a squad are never dropped', async () => {
    const { s } = source(
      withSquads(),
      'Europe/Rome',
      {},
      undefined,
      new Map([
        ['5001', new Set(['B'])],
        ['5002', new Set(['2'])],
      ]),
    );
    const r = await s.fetch();
    expect(r.complete).toBe(true);
    expect(ids(r)).toEqual(
      expect.arrayContaining(['lecture:9102', 'lecture:9103', 'lecture:9001', 'lecture:9002']),
    );
    expect(ids(r)).not.toContain('lecture:9101');
    expect(ids(r)).not.toContain('lecture:9104');
    expect(s.notes).toEqual([]);
  });

  it('a squad setting for one course does not hide the note for another', async () => {
    const { s } = source(
      withSquads(),
      'Europe/Rome',
      {},
      undefined,
      new Map([['5001', new Set(['A'])]]),
    );
    await s.fetch();
    expect(s.notes[0]).toContain('5002');
    expect(s.notes[0]).not.toContain('5001 (');
  });

  it('a dropped squad lesson is still validated (an unreadable one keeps the run incomplete)', async () => {
    const d = withSquads();
    const l = (d.data['orari'] as { data: { lezioni: Record<string, unknown>[] } }).data.lezioni;
    l[l.length - 4]!['startsAt'] = 'later';
    const r = await source(
      d,
      'Europe/Rome',
      {},
      undefined,
      new Map([['5001', new Set(['B'])]]),
    ).s.fetch();
    expect(r.complete).toBe(false);
  });
});

describe('Polito portal source: fail closed', () => {
  const brokenCases: [string, (d: ReturnType<typeof fixture>) => void][] = [
    ['a missing section', (d) => void delete d.data['agenda']],
    ['a section that is not a list', (d) => void (d.data['appelli'] = { data: { oops: 1 } })],
    [
      'a renamed required field',
      (d) => {
        const l = (d.data['orari'] as { data: { lezioni: Record<string, unknown>[] } }).data
          .lezioni;
        l[0] = { ...l[0], startsAt: undefined, beginsAt: '2026-12-09T09:00:00+01:00' };
      },
    ],
    [
      'a time that is not a time',
      (d) => {
        (d.data['appelli'] as { data: Record<string, unknown>[] }).data[0]!['examStartsAt'] =
          'tomorrow';
      },
    ],
    [
      'an agenda item of an unknown shape',
      (d) => {
        (d.data['agenda'] as { data: unknown[] }).data.push({ id: 1, something: 'else' });
      },
    ],
    [
      'the same id twice',
      (d) => {
        const l = (d.data['orari'] as { data: { lezioni: unknown[] } }).data.lezioni;
        l.push(l[0]);
      },
    ],
  ];
  for (const [name, break_] of brokenCases) {
    it(`${name} marks the run incomplete but keeps what was understood`, async () => {
      const d = fixture();
      break_(d);
      const { s } = source(d);
      const r = await s.fetch();
      expect(r.complete).toBe(false);
      expect(r.events.length).toBeGreaterThan(0);
      expect(s.lastReport.some((x) => x.error?.code === 'E_POLITO_API_UNEXPECTED_DATA')).toBe(true);
    });
  }

  it('a document without success:true is rejected whole', async () => {
    const d = fixture();
    d['success'] = false;
    const r = await source(d).s.fetch();
    expect(r).toMatchObject({ complete: false, events: [] });
  });

  it('error messages carry positions and field names, never content', async () => {
    const d = fixture();
    (d.data['appelli'] as { data: Record<string, unknown>[] }).data[0]!['examStartsAt'] =
      'Secret Title';
    const { s } = source(d);
    await s.fetch();
    const text = s.lastReport.map((x) => x.error && formatUserError(x.error)).join('\n');
    expect(text).toContain('appelli #1');
    expect(text).not.toContain('Secret Title');
    expect(text).not.toContain('Invented Analysis');
  });
});

describe('Polito portal source: login problems', () => {
  it('a refused login is incomplete, never throws, and pauses further attempts until the credentials change', async () => {
    const w = world({ data: fixture(), idpAnswer: () => html(LOGIN_FORM) });
    const dataDir = mkdtempSync(join(tmpdir(), 'pcs-polsrc-'));
    const make = (password: string) =>
      new PolitoPortalSource({
        username: USER,
        password,
        tz: 'Europe/Rome',
        dataDir,
        portal: opts(w.fetchImpl),
      });
    const first = make('wrong-PASS-word');
    expect(await first.fetch()).toMatchObject({ complete: false, events: [] });
    expect(first.lastReport[0]?.error?.code).toBe('E_POLITO_API_AUTH_REJECTED');
    const requestsAfterFirst = w.log.length;

    const second = make('wrong-PASS-word');
    expect(await second.fetch()).toMatchObject({ complete: false });
    expect(second.lastReport[0]?.error?.code).toBe('E_POLITO_LOGIN_BLOCKED');
    expect(w.log.length).toBe(requestsAfterFirst); // not one request more

    const third = make('another-PASS-word'); // changed credentials: tried again
    await third.fetch();
    expect(w.log.length).toBeGreaterThan(requestsAfterFirst);
  });

  it('an MFA step is reported, not answered', async () => {
    const w = world({
      idpAnswer: () => html('<form action="/mfa" method="post"><input name="otp_code"></form>'),
    });
    const s = new PolitoPortalSource({
      username: USER,
      password: PASS,
      tz: 'Europe/Rome',
      dataDir: mkdtempSync(join(tmpdir(), 'pcs-polsrc-')),
      portal: opts(w.fetchImpl),
    });
    expect(await s.fetch()).toMatchObject({ complete: false, events: [] });
    expect(s.lastReport[0]?.error?.code).toBe('E_POLITO_LOGIN_EXTRA_STEP');
    expect(w.log.filter((l) => l.method === 'POST')).toHaveLength(1);
  });

  it('an outage is incomplete and does not block future attempts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pcs-polsrc-'));
    const down = (() => Promise.resolve(new Response(null, { status: 503 }))) as typeof fetch;
    const s = new PolitoPortalSource({
      username: USER,
      password: PASS,
      tz: 'Europe/Rome',
      dataDir,
      portal: opts(down),
    });
    expect(await s.fetch()).toMatchObject({ complete: false });
    expect(s.lastReport[0]?.error?.code).toBe('E_POLITO_API_FETCH_FAILED');
    const w = world({ data: fixture() });
    const again = new PolitoPortalSource({
      username: USER,
      password: PASS,
      tz: 'Europe/Rome',
      dataDir,
      portal: opts(w.fetchImpl),
    });
    expect((await again.fetch()).complete).toBe(true);
  });
});
