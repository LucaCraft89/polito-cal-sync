import { GoogleApiError } from './types.js';
import type { EventsApi, GoogleEventResource, ListParams } from './types.js';

type Op = 'list' | 'get' | 'insert' | 'patch' | 'delete';

export interface Call {
  op: Op;
  calendarId: string;
  eventId?: string;
}

function merge<T>(target: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const base: Record<string, unknown> =
    target && typeof target === 'object' ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch)) base[k] = merge(base[k], v);
  return base as T;
}

/**
 * In-memory Google Calendar `events` API. It models the behaviours that matter for sync safety:
 * ids can be reused only by their owner (409 otherwise), deleted events leave a "cancelled"
 * tombstone that still blocks the id, `list` filters on private extended properties and pages,
 * and patch merges nested objects like the real API.
 *
 * Used by the unit tests and by the developer-only `sync --fixture` mode. It is NOT a stand-in
 * for Google in any real run.
 */
export class MemoryEventsApi implements EventsApi {
  readonly calls: Call[] = [];
  private readonly calendars = new Map<string, Map<string, GoogleEventResource>>();
  private readonly failures: { op: Op; error: GoogleApiError; times: number }[] = [];

  constructor(private readonly pageSize = 250) {}

  /** Test helper: put an event in a calendar as if it was already there. */
  seed(calendarId: string, resource: GoogleEventResource & { id: string }): void {
    this.cal(calendarId).set(resource.id, structuredClone(resource));
  }

  /** Test helper: make the next `times` calls of `op` fail. */
  failNext(op: Op, error: GoogleApiError, times = 1): void {
    this.failures.push({ op, error, times });
  }

  /** Test helper: everything stored, tombstones included. */
  snapshot(calendarId: string): GoogleEventResource[] {
    return [...this.cal(calendarId).values()].map((e) => structuredClone(e));
  }

  /** Calls that changed something. */
  get writes(): Call[] {
    return this.calls.filter((c) => c.op === 'insert' || c.op === 'patch' || c.op === 'delete');
  }

  private cal(id: string): Map<string, GoogleEventResource> {
    let c = this.calendars.get(id);
    if (!c) {
      c = new Map();
      this.calendars.set(id, c);
    }
    return c;
  }

  private enter(call: Call): void {
    this.calls.push(call);
    const f = this.failures.find((x) => x.op === call.op && x.times > 0);
    if (f) {
      f.times--;
      throw f.error;
    }
  }

  list(p: ListParams): Promise<{ items: GoogleEventResource[]; nextPageToken?: string }> {
    this.enter({ op: 'list', calendarId: p.calendarId });
    const filters = (p.privateExtendedProperty ?? []).map((f) => f.split('=') as [string, string]);
    const all = [...this.cal(p.calendarId).values()]
      .filter((e) => p.showDeleted === true || e.status !== 'cancelled')
      .filter((e) => filters.every(([k, v]) => e.extendedProperties?.private?.[k] === v));
    const offset = p.pageToken ? Number(p.pageToken) : 0;
    const items = all.slice(offset, offset + this.pageSize).map((e) => structuredClone(e));
    const next = offset + this.pageSize;
    return Promise.resolve(next < all.length ? { items, nextPageToken: String(next) } : { items });
  }

  get(p: { calendarId: string; eventId: string }): Promise<GoogleEventResource> {
    this.enter({ op: 'get', calendarId: p.calendarId, eventId: p.eventId });
    const e = this.cal(p.calendarId).get(p.eventId);
    if (!e) return Promise.reject(new GoogleApiError({ status: 404, reason: 'notFound' }));
    return Promise.resolve(structuredClone(e));
  }

  insert(p: { calendarId: string; resource: GoogleEventResource }): Promise<GoogleEventResource> {
    const id = p.resource.id;
    this.enter({ op: 'insert', calendarId: p.calendarId, ...(id ? { eventId: id } : {}) });
    if (!id) return Promise.reject(new GoogleApiError({ status: 400, reason: 'invalid' }));
    const cal = this.cal(p.calendarId);
    if (cal.has(id)) {
      return Promise.reject(new GoogleApiError({ status: 409, reason: 'duplicate' }));
    }
    cal.set(id, structuredClone({ ...p.resource, status: p.resource.status ?? 'confirmed' }));
    return Promise.resolve(structuredClone(cal.get(id) as GoogleEventResource));
  }

  patch(p: {
    calendarId: string;
    eventId: string;
    resource: GoogleEventResource;
  }): Promise<GoogleEventResource> {
    this.enter({ op: 'patch', calendarId: p.calendarId, eventId: p.eventId });
    const cal = this.cal(p.calendarId);
    const current = cal.get(p.eventId);
    if (!current) return Promise.reject(new GoogleApiError({ status: 404, reason: 'notFound' }));
    const next = merge(current, p.resource);
    cal.set(p.eventId, next);
    return Promise.resolve(structuredClone(next));
  }

  delete(p: { calendarId: string; eventId: string }): Promise<void> {
    this.enter({ op: 'delete', calendarId: p.calendarId, eventId: p.eventId });
    const cal = this.cal(p.calendarId);
    const current = cal.get(p.eventId);
    if (!current) return Promise.reject(new GoogleApiError({ status: 404, reason: 'notFound' }));
    if (current.status === 'cancelled') {
      return Promise.reject(new GoogleApiError({ status: 410, reason: 'deleted' }));
    }
    // Like Google: a deleted event stays as a bare tombstone and keeps blocking its id.
    cal.set(p.eventId, { id: p.eventId, status: 'cancelled' });
    return Promise.resolve();
  }
}
