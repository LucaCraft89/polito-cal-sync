import { describe, expect, it } from 'vitest';
import { googleEventId, toGoogleEvent } from '../src/sync/mapper.js';
import { GoogleApiError } from '../src/google/types.js';
import { CAL, TZ, event, makeCalendar, seedForeign, seedManaged } from './support/helpers.js';

const idOf = (n: number) => googleEventId('ics', `ev-${n}`);
const resource = (n: number) =>
  toGoogleEvent(event(n), TZ) as ReturnType<typeof toGoogleEvent> & { id: string };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? 'NOT_A_USER_ERROR';
  }
  return 'NO_ERROR';
}

describe('OwnedCalendar.listManaged', () => {
  it('returns only events with our marker, across pages, and skips deleted ones', async () => {
    const { api, calendar } = makeCalendar(2);
    for (const n of [1, 2, 3, 4, 5]) seedManaged(api, n);
    seedForeign(api, 'foreign1');
    seedForeign(api, 'foreign2');
    await api.delete({ calendarId: CAL, eventId: idOf(5) }); // tombstone
    const managed = await calendar.listManaged();
    expect(managed.map((m) => m.googleId).sort()).toEqual([1, 2, 3, 4].map(idOf).sort());
    expect(managed[0]).toMatchObject({ source: 'ics', kind: 'lecture' });
    expect(managed.every((m) => m.hash?.length === 64)).toBe(true);
  });

  it('re-checks the marker locally even if the server filter returned something else', async () => {
    const { api, calendar } = makeCalendar();
    seedForeign(api, 'foreign1');
    const real = api.list.bind(api);
    api.list = async (p) => ({ items: (await real({ ...p, privateExtendedProperty: [] })).items });
    expect(await calendar.listManaged()).toEqual([]);
  });
});

describe('OwnedCalendar writes', () => {
  it('creates a new event', async () => {
    const { api, calendar } = makeCalendar();
    expect(await calendar.create(resource(1))).toBe('created');
    expect(api.snapshot(CAL)).toHaveLength(1);
  });

  it('revives our own deleted event whose id is still blocked by a tombstone', async () => {
    const { api, calendar } = makeCalendar();
    await calendar.create(resource(1));
    await calendar.listManaged();
    await calendar.delete(idOf(1));
    expect(await calendar.create(resource(1))).toBe('revived');
    const live = (await calendar.listManaged()).map((m) => m.googleId);
    expect(live).toEqual([idOf(1)]);
    expect(api.snapshot(CAL)[0]?.summary).toBe('Lecture 1');
  });

  it('refuses to overwrite a foreign event that holds the id (E_ID_COLLISION)', async () => {
    const { api, calendar } = makeCalendar();
    seedForeign(api, idOf(1), 'Mine, hands off');
    expect(await code(calendar.create(resource(1)))).toBe('E_ID_COLLISION');
    expect(api.snapshot(CAL)[0]?.summary).toBe('Mine, hands off');
    expect(api.writes.filter((c) => c.op === 'patch')).toHaveLength(0);
  });

  it('patches a managed event after listing it', async () => {
    const { api, calendar } = makeCalendar();
    seedManaged(api, 1);
    await calendar.listManaged();
    const changed = toGoogleEvent(event(1, { location: 'Room 9' }), TZ);
    expect(await calendar.patch(idOf(1), changed)).toBe('patched');
    expect(api.snapshot(CAL)[0]?.location).toBe('Room 9');
    expect(api.snapshot(CAL)[0]?.extendedProperties?.private?.['polito_cal_sync']).toBe('1');
  });

  it('recreates an event that was deleted in the Google UI between list and patch', async () => {
    const { api, calendar } = makeCalendar();
    seedManaged(api, 1);
    await calendar.listManaged();
    api.seed(CAL, { id: idOf(2), status: 'confirmed' }); // unrelated noise
    await api.delete({ calendarId: CAL, eventId: idOf(1) });
    // The tombstone is still there, so patch revives rather than 404s; also cover a hard 404:
    api.failNext('patch', new GoogleApiError({ status: 404, reason: 'notFound' }));
    expect(await calendar.patch(idOf(1), resource(1))).toBe('created');
  });

  it('deletes a managed event, and treats an already deleted one as done', async () => {
    const { api, calendar } = makeCalendar();
    seedManaged(api, 1);
    seedManaged(api, 2);
    await calendar.listManaged();
    expect(await calendar.delete(idOf(1))).toBe('deleted');
    await api.delete({ calendarId: CAL, eventId: idOf(2) });
    expect(await calendar.delete(idOf(2))).toBe('already_gone');
  });
});

describe('ownership guard', () => {
  it('refuses to patch or delete a foreign event, even by exact id, and never calls the API', async () => {
    const { api, calendar } = makeCalendar();
    seedManaged(api, 1);
    seedForeign(api, 'foreign1');
    await calendar.listManaged();
    const before = api.writes.length;
    expect(await code(calendar.patch('foreign1', resource(1)))).toBe('E_NOT_OURS');
    expect(await code(calendar.delete('foreign1'))).toBe('E_NOT_OURS');
    expect(api.writes.length).toBe(before);
    expect(api.snapshot(CAL).find((e) => e.id === 'foreign1')?.summary).toBe('Dentist');
  });

  it('refuses everything that was not listed or created by this instance', async () => {
    const { api, calendar } = makeCalendar();
    seedManaged(api, 1);
    expect(await code(calendar.delete(idOf(1)))).toBe('E_NOT_OURS');
    expect(api.writes).toHaveLength(0);
  });
});

describe('Google errors and backoff', () => {
  it('retries 429 with exponential backoff and then succeeds', async () => {
    const { api, calendar, sleeps } = makeCalendar();
    api.failNext('insert', new GoogleApiError({ status: 429 }), 2);
    expect(await calendar.create(resource(1))).toBe('created');
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('honours Retry-After when it is longer than the backoff', async () => {
    const { api, calendar, sleeps } = makeCalendar();
    api.failNext('insert', new GoogleApiError({ status: 429, retryAfter: 7 }));
    await calendar.create(resource(1));
    expect(sleeps).toEqual([7000]);
  });

  it('gives up on persistent 429 with E_GOOGLE_QUOTA after 5 tries', async () => {
    const { api, calendar } = makeCalendar();
    api.failNext('insert', new GoogleApiError({ status: 429 }), 99);
    expect(await code(calendar.create(resource(1)))).toBe('E_GOOGLE_QUOTA');
    expect(api.calls.filter((c) => c.op === 'insert')).toHaveLength(5);
  });

  it('maps persistent 503 and network failures to E_GOOGLE_UNAVAILABLE', async () => {
    const a = makeCalendar();
    a.api.failNext('list', new GoogleApiError({ status: 503 }), 99);
    expect(await code(a.calendar.listManaged())).toBe('E_GOOGLE_UNAVAILABLE');
    const b = makeCalendar();
    b.api.failNext(
      'list',
      new GoogleApiError({ status: 0, network: true, reason: 'ENOTFOUND' }),
      99,
    );
    expect(await code(b.calendar.listManaged())).toBe('E_GOOGLE_UNAVAILABLE');
  });

  it('retries a 403 rateLimitExceeded but not a plain 403', async () => {
    const a = makeCalendar();
    a.api.failNext('insert', new GoogleApiError({ status: 403, reason: 'rateLimitExceeded' }));
    expect(await a.calendar.create(resource(1))).toBe('created');
    const b = makeCalendar();
    b.api.failNext('insert', new GoogleApiError({ status: 403, reason: 'forbidden' }));
    expect(await code(b.calendar.create(resource(1)))).toBe('E_GOOGLE_PERMISSION_DENIED');
    expect(b.api.calls.filter((c) => c.op === 'insert')).toHaveLength(1);
  });

  it('does not retry auth failures', async () => {
    const { api, calendar, sleeps } = makeCalendar();
    api.failNext('list', new GoogleApiError({ status: 401 }), 99);
    expect(await code(calendar.listManaged())).toBe('E_GOOGLE_AUTH_EXPIRED');
    expect(sleeps).toEqual([]);
    const b = makeCalendar();
    b.api.failNext('list', new GoogleApiError({ status: 400, reason: 'invalid_grant' }));
    expect(await code(b.calendar.listManaged())).toBe('E_GOOGLE_AUTH_EXPIRED');
  });

  it('maps a 404 on list to E_GOOGLE_CALENDAR_NOT_FOUND', async () => {
    const { api, calendar } = makeCalendar();
    api.failNext('list', new GoogleApiError({ status: 404, reason: 'notFound' }));
    expect(await code(calendar.listManaged())).toBe('E_GOOGLE_CALENDAR_NOT_FOUND');
  });

  it('maps an unknown 4xx to E_GOOGLE_REQUEST_FAILED with status and reason', async () => {
    const { api, calendar } = makeCalendar();
    api.failNext('insert', new GoogleApiError({ status: 400, reason: 'invalid' }));
    await expect(calendar.create(resource(1))).rejects.toMatchObject({
      code: 'E_GOOGLE_REQUEST_FAILED',
      what: expect.stringContaining('HTTP 400, reason invalid') as string,
    });
  });
});
