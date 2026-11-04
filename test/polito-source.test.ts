import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PolitoApi } from '../src/sources/polito/client.js';
import { PolitoApiSource } from '../src/sources/polito/index.js';
import { UserError } from '../src/util/errors.js';

// All data in test/fixtures/polito is INVENTED from the spec-derived field table (see its README).
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/polito/${name}.json`, import.meta.url), 'utf8'));
const NOW = new Date('2026-11-04T10:00:00Z');

type Answers = Record<string, unknown>;

function fakeApi(overrides: Answers = {}) {
  const answers: Answers = {
    '/v2/courses': fixture('courses'),
    '/lectures': fixture('lectures'),
    '/exams': fixture('exams'),
    '/bookings': fixture('bookings'),
    '/deadlines': fixture('deadlines'),
    '/courses/101/assignments': fixture('assignments-101'),
    '/courses/C-202/assignments': fixture('assignments-C-202'),
    ...overrides,
  };
  const calls: { path: string; query: Record<string, string> }[] = [];
  const api: PolitoApi = {
    get: (path, query = {}) => {
      calls.push({ path, query });
      if (!(path in answers)) return Promise.reject(new Error(`unexpected call ${path}`));
      const a = answers[path];
      return typeof a === 'function'
        ? Promise.resolve().then(a as () => never)
        : Promise.resolve(a);
    },
  };
  return { api, calls };
}

const source = (api: PolitoApi) => new PolitoApiSource({ api, now: () => NOW });
const fetchError = (code: 'E_POLITO_API_FETCH_FAILED' | 'E_POLITO_API_AUTH_REJECTED') => () => {
  throw new UserError({ code, what: 'x', why: 'y', action: 'z' });
};

describe('Polito API source: mapping (invented, spec-derived fixtures)', () => {
  it('maps every endpoint, is complete, and uses one request per endpoint', async () => {
    const { api, calls } = fakeApi();
    const s = source(api);
    const r = await s.fetch();
    expect(r.complete).toBe(true);
    expect(calls.map((c) => c.path)).toEqual([
      '/v2/courses',
      '/lectures',
      '/exams',
      '/bookings',
      '/deadlines',
      '/courses/101/assignments',
      '/courses/C-202/assignments',
    ]);
    const byId = new Map(r.events.map((e) => [e.sourceId, e]));
    expect(byId.get('lecture:1')).toMatchObject({
      kind: 'lecture',
      title: 'Alpha lecture',
      start: '2026-11-10T08:30:00.000Z',
      end: '2026-11-10T10:00:00.000Z',
      location: 'Room 1',
      course: 'polito:101',
      source: 'polito',
    });
    expect(byId.get('lecture:2')?.location).toBe('Room 2');
    expect(byId.get('exam:E1')).toMatchObject({ kind: 'exam_call', location: 'Room 3' });
    // No "booked" status values are known yet, so no entry becomes kind "exam" (see fields.ts).
    expect(byId.get('exam:E2')?.kind).toBe('exam_call');
    expect(byId.get('exam:E1:booking-closes')).toMatchObject({
      kind: 'deadline',
      start: '2026-11-28T21:59:00.000Z',
    });
    expect(byId.has('exam:E2:booking-closes')).toBe(false);
    expect(byId.get('booking:9')).toMatchObject({ kind: 'booking', location: 'Lab 5' });
    expect(byId.get('deadline:4')).toMatchObject({
      kind: 'deadline',
      allDay: true,
      start: '2026-11-20',
    });
    expect(byId.get('assignment:101:7')).toMatchObject({
      kind: 'assignment',
      course: 'polito:101',
    });
    expect(r.events).toHaveLength(9);
    expect(s.lastReport.every((x) => x.status === 'ok')).toBe(true);
  });

  it('asks for a bounded window with plain dates and derives stable ids when the API gives none', async () => {
    const { api, calls } = fakeApi();
    const r1 = await source(api).fetch();
    expect(calls.find((c) => c.path === '/lectures')?.query).toEqual({
      fromDate: '2026-08-06',
      toDate: '2027-05-03',
    });
    const r2 = await source(fakeApi().api).fetch();
    const derived = r1.events.filter((e) => e.sourceId.startsWith('deadline:h:'));
    expect(derived).toHaveLength(1);
    expect(r2.events.map((e) => e.sourceId).sort()).toEqual(
      r1.events.map((e) => e.sourceId).sort(),
    );
  });

  it('keeps the course key out of the hash: same content, other course, same hash', async () => {
    const a = (await source(fakeApi().api).fetch()).events.find((e) => e.sourceId === 'lecture:1');
    const altered = fixture('lectures') as { data: Record<string, unknown>[] };
    altered.data[0] = { ...altered.data[0], courseId: 999 };
    const b = (await source(fakeApi({ '/lectures': altered }).api).fetch()).events.find(
      (e) => e.sourceId === 'lecture:1',
    );
    expect(b?.course).toBe('polito:999');
    expect(b?.hash).toBe(a?.hash);
  });
});

describe('Polito API source: fail closed', () => {
  it('a field that does not match marks the run incomplete but keeps the understood items', async () => {
    const lectures = fixture('lectures') as { data: Record<string, unknown>[] };
    const broken = { data: [{ ...lectures.data[0], title: undefined }, lectures.data[1]] };
    const s = source(fakeApi({ '/lectures': broken }).api);
    const r = await s.fetch();
    expect(r.complete).toBe(false);
    expect(r.events.some((e) => e.sourceId === 'lecture:1')).toBe(false);
    expect(r.events.some((e) => e.sourceId === 'lecture:2')).toBe(true);
    const report = s.lastReport.find((x) => x.endpoint === 'lectures');
    expect(report?.error?.code).toBe('E_POLITO_API_UNEXPECTED_DATA');
    // Messages carry positions and field names, not content.
    expect(report?.issues.join(' ')).toContain('lectures #1');
    expect(report?.issues.join(' ')).not.toContain('Alpha');
  });

  it('a renamed time field (wrong guess) maps nothing and is incomplete', async () => {
    const renamed = [{ id: 1, title: 'T', beginsAt: '2026-11-10T08:30:00Z' }];
    const r = await source(fakeApi({ '/lectures': renamed }).api).fetch();
    expect(r.complete).toBe(false);
    expect(r.events.some((e) => e.kind === 'lecture')).toBe(false);
  });

  it('a date without a zone or a plain date where a date-time is expected is rejected', async () => {
    const r = await source(
      fakeApi({ '/lectures': [{ id: 1, title: 'T', startsAt: '2026-11-10T08:30:00' }] }).api,
    ).fetch();
    expect(r.complete).toBe(false);
    expect(r.events.filter((e) => e.kind === 'lecture')).toHaveLength(0);
  });

  it('an answer that is not a list is a failure of that endpoint, not an empty list', async () => {
    const s = source(fakeApi({ '/bookings': { bookings: [] } }).api);
    const r = await s.fetch();
    expect(r.complete).toBe(false);
    expect(s.lastReport.find((x) => x.endpoint === 'bookings')?.status).toBe('failed');
  });

  it('an empty list is a legitimate answer', async () => {
    const r = await source(fakeApi({ '/bookings': [] }).api).fetch();
    expect(r.complete).toBe(true);
  });

  it('a login or rate-limit failure stops all further requests and is incomplete', async () => {
    for (const code of ['E_POLITO_API_AUTH_REJECTED', 'E_POLITO_API_FETCH_FAILED'] as const) {
      const { api, calls } = fakeApi({ '/exams': fetchError(code) });
      const s = source(api);
      const r = await s.fetch();
      expect(r.complete).toBe(false);
      expect(calls.map((c) => c.path)).toEqual(['/v2/courses', '/lectures', '/exams']);
      expect(r.events.some((e) => e.sourceId === 'lecture:1')).toBe(true); // earlier results are kept
      expect(s.lastReport.filter((x) => x.status === 'not-run').length).toBeGreaterThan(0);
      expect(s.lastReport.find((x) => x.endpoint === 'exams')?.error?.code).toBe(code);
    }
  });

  it('never throws, even for non-UserErrors', async () => {
    const { api } = fakeApi({
      '/v2/courses': () => {
        throw new Error('boom');
      },
    });
    const s = source(api);
    const r = await s.fetch();
    expect(r).toMatchObject({ complete: false, events: [] });
    expect(s.lastReport[0]?.error?.code).toBe('E_INTERNAL');
  });
});
