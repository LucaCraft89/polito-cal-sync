import { MemoryEventsApi } from '../../src/google/memory.js';
import type { RuntimeDeps } from '../../src/sync/run.js';

export const FEED = 'https://feed.example.invalid/secret-feed-token-AAAABBBBCCCC/me.ics';
export const CAL_ID = 'dedicated-cal';
export const NOW = new Date('2026-11-04T10:00:00Z');

export const ics = (...events: [uid: string, start: string, title: string][]): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    ...events.flatMap(([uid, start, title]) => [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      'DTSTAMP:20261001T000000Z',
      `DTSTART:${start}`,
      `DTEND:${start.replace(/T(\d\d)/, (_m, h: string) => `T${String(Number(h) + 1).padStart(2, '0')}`)}`,
      `SUMMARY:${title}`,
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ].join('\r\n');

/** Fake Google (in memory) and a fake feed: what the preview runs against in tests. Never a real account. */
export function previewWorld(
  feedText: () => string = () => ics(['a', '20261110T090000Z', 'Fisica']),
) {
  const api = new MemoryEventsApi();
  const fetched: string[] = [];
  const portalAttempts: string[] = [];
  const deps: RuntimeDeps = {
    now: () => NOW,
    pauseBetweenFeedsMs: 0,
    sleep: () => Promise.resolve(),
    // The tests never contact the real university portal (CI has network access): an enabled Polito source
    // fails at once, offline, with its normal "no connection" error.
    politoPortal: {
      fetchImpl: (url) => {
        portalAttempts.push(
          typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        );
        return Promise.reject(new Error('offline: tests never reach the real portal'));
      },
      pauseMs: 0,
      sleep: () => Promise.resolve(),
    },
    googleFactory: () => Promise.resolve({ api, calendarId: CAL_ID }),
    fetchImpl: (url) => {
      fetched.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
      return Promise.resolve(new Response(feedText(), { status: 200 }));
    },
  };
  return { api, deps, fetched, portalAttempts };
}
