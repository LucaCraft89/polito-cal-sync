import type { calendar_v3 } from 'googleapis';
import { describe, expect, it } from 'vitest';
import { createEventsApi, toApiError } from '../src/google/adapter.js';
import { GoogleApiError } from '../src/google/types.js';
import { USER_AGENT } from '../src/util/version.js';

type Handler = (params: Record<string, unknown>, opts: unknown) => Promise<{ data: unknown }>;

function stub(handlers: Partial<Record<'list' | 'get' | 'insert' | 'patch' | 'delete', Handler>>) {
  const seen: { name: string; params: Record<string, unknown>; opts: unknown }[] = [];
  const events: Record<string, Handler> = {};
  for (const name of ['list', 'get', 'insert', 'patch', 'delete'] as const) {
    events[name] = (params, opts) => {
      seen.push({ name, params, opts });
      return (handlers[name] ?? (() => Promise.resolve({ data: {} })))(params, opts);
    };
  }
  return { api: createEventsApi({ events } as unknown as calendar_v3.Calendar), seen };
}

describe('googleapis adapter', () => {
  it('lists with the ownership filter, paging and our User-Agent', async () => {
    const { api, seen } = stub({
      list: () => Promise.resolve({ data: { items: [{ id: 'a' }], nextPageToken: 'p2' } }),
    });
    const res = await api.list({
      calendarId: 'c',
      privateExtendedProperty: ['polito_cal_sync=1'],
      pageToken: 'p1',
    });
    expect(res).toEqual({ items: [{ id: 'a' }], nextPageToken: 'p2' });
    expect(seen[0]?.params).toMatchObject({
      calendarId: 'c',
      privateExtendedProperty: ['polito_cal_sync=1'],
      pageToken: 'p1',
      showDeleted: false,
      singleEvents: false,
    });
    expect(seen[0]?.opts).toMatchObject({ headers: { 'User-Agent': USER_AGENT } });
  });

  it('passes resource bodies to insert, patch and delete', async () => {
    const { api, seen } = stub({});
    await api.insert({ calendarId: 'c', resource: { id: 'x', summary: 's' } });
    await api.patch({ calendarId: 'c', eventId: 'x', resource: { summary: 't' } });
    await api.delete({ calendarId: 'c', eventId: 'x' });
    expect(seen.map((s) => s.name)).toEqual(['insert', 'patch', 'delete']);
    expect(seen[0]?.params).toMatchObject({ requestBody: { id: 'x', summary: 's' } });
    expect(seen[1]?.params).toMatchObject({ eventId: 'x', requestBody: { summary: 't' } });
  });

  it('converts googleapis failures into GoogleApiError without copying request data', async () => {
    const { api } = stub({
      get: () =>
        Promise.reject(
          Object.assign(new Error('Request failed with Authorization: Bearer abc'), {
            response: {
              status: 429,
              headers: { 'retry-after': '12' },
              data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } },
            },
          }),
        ),
    });
    const err = (await api
      .get({ calendarId: 'c', eventId: 'e' })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err).toMatchObject({ status: 429, reason: 'rateLimitExceeded', retryAfter: 12 });
    expect(err.message).not.toContain('Bearer');
  });

  it('recognises invalid_grant and network failures', () => {
    expect(
      toApiError({ response: { status: 400, data: { error: 'invalid_grant' } } }),
    ).toMatchObject({ status: 400, reason: 'invalid_grant' });
    expect(toApiError({ code: 'ENOTFOUND' })).toMatchObject({ network: true, reason: 'ENOTFOUND' });
    const unknown = new Error('plain bug');
    expect(toApiError(unknown)).toBe(unknown);
  });
});
