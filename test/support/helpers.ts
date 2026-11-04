import { MemoryEventsApi } from '../../src/google/memory.js';
import { OwnedCalendar } from '../../src/google/calendar.js';
import type { EventDraft } from '../../src/sources/types.js';
import { toCanonical, toGoogleEvent } from '../../src/sync/mapper.js';

export const CAL = 'cal-test';
export const TZ = 'Europe/Rome';

export function draft(n: number, patch: Partial<EventDraft> = {}): EventDraft {
  return {
    source: 'ics',
    sourceId: `ev-${n}`,
    kind: 'lecture',
    title: `Lecture ${n}`,
    start: `2026-11-${String(10 + n).padStart(2, '0')}T09:00:00+01:00`,
    end: `2026-11-${String(10 + n).padStart(2, '0')}T11:00:00+01:00`,
    location: 'Room 1',
    ...patch,
  };
}

export function event(n: number, patch: Partial<EventDraft> = {}) {
  return toCanonical(draft(n, patch));
}

/** Seeds an event exactly as we would have written it earlier. */
export function seedManaged(api: MemoryEventsApi, n: number, patch: Partial<EventDraft> = {}) {
  const g = toGoogleEvent(event(n, patch), TZ);
  api.seed(CAL, g as typeof g & { id: string });
  return g;
}

export function seedForeign(api: MemoryEventsApi, id: string, summary = 'Dentist') {
  api.seed(CAL, {
    id,
    status: 'confirmed',
    summary,
    start: { dateTime: '2026-11-12T15:00:00.000Z' },
    end: { dateTime: '2026-11-12T16:00:00.000Z' },
  });
}

export function makeCalendar(pageSize = 250) {
  const api = new MemoryEventsApi(pageSize);
  const sleeps: number[] = [];
  const calendar = new OwnedCalendar(api, CAL, {
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 1,
  });
  return { api, calendar, sleeps };
}
