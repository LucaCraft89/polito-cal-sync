import { describe, expect, it } from 'vitest';
import { eventsFromIcs } from '../src/sources/ics/events.js';
import { toCanonical } from '../src/sync/mapper.js';

// Invented feed lines. The course code shape mimics Moodle (year_code_n) but is made up.
const OPTS = {
  defaultTz: 'Europe/Rome',
  windowStart: new Date('2026-01-01T00:00:00Z'),
  windowEnd: new Date('2027-12-31T00:00:00Z'),
};
const feed = (...extra: string[]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:a1',
    'DTSTAMP:20260101T000000Z',
    'DTSTART:20261110T090000Z',
    'DTEND:20261110T100000Z',
    'SUMMARY:Lezione',
    ...extra,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

describe('course key', () => {
  it('takes the first CATEGORIES value, opaque and unparsed', () => {
    const [e] = eventsFromIcs(feed('CATEGORIES:2026_ABC123_8'), OPTS).events;
    expect(e?.course).toBe('2026_ABC123_8');
    const [f] = eventsFromIcs(feed('CATEGORIES:2026_X_1,other'), OPTS).events;
    expect(f?.course).toBe('2026_X_1');
  });
  it('is absent without CATEGORIES or with an empty one', () => {
    expect(eventsFromIcs(feed(), OPTS).events[0]?.course).toBeUndefined();
    expect(eventsFromIcs(feed('CATEGORIES:'), OPTS).events[0]?.course).toBeUndefined();
  });
  it('is not part of the content hash (moving an event between courses is not a content change)', () => {
    const base = {
      source: 'ics',
      sourceId: 'x',
      kind: 'lecture' as const,
      title: 'T',
      start: '2026-11-10T09:00:00Z',
    };
    const a = toCanonical({ ...base, course: 'A' });
    const b = toCanonical({ ...base, course: 'B' });
    const none = toCanonical(base);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(none.hash);
    expect(a.course).toBe('A');
  });
});
