import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IcsSource } from '../src/sources/ics/index.js';
import { formatReport } from '../src/sync/format.js';
import { toCanonical } from '../src/sync/mapper.js';
import { diff } from '../src/sync/differ.js';

// Invented feeds; only the host decides whether events are labelled as Moodle events.
const ics = (title: string) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:m1',
    'DTSTAMP:20261001T000000Z',
    'DTSTART:20261110T090000Z',
    'DTEND:20261110T100000Z',
    `SUMMARY:${title}`,
    'CATEGORIES:2026_ABC_1',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

const MOODLE_FEED = // secret-scan:ignore
  'https://moodle.example.test/calendar/export_execute.php?authtoken=SECRETSECRETSECRET'; // secret-scan:ignore
const OTHER_FEED = 'https://calendar.example.test/me.ics';

function run(url: string, moodleHost: string | undefined, title = 'Quiz opens') {
  const s = new IcsSource({
    urls: [url],
    dataDir: mkdtempSync(join(tmpdir(), 'pcs-moodle-')),
    tz: 'Europe/Rome',
    now: () => new Date('2026-11-04T10:00:00Z'),
    pauseBetweenFeedsMs: 0,
    ...(moodleHost ? { moodleHost } : {}),
    fetchOptions: {
      fetchImpl: () => Promise.resolve(new Response(ics(title), { status: 200 })),
    },
  });
  return s.fetch();
}

describe('Moodle labelling', () => {
  it('events from a feed on the Moodle host get kind moodle and a visible [Moodle] prefix', async () => {
    const r = await run(MOODLE_FEED, 'moodle.example.test');
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      kind: 'moodle',
      title: '[Moodle] Quiz opens',
      course: '2026_ABC_1',
    });
  });

  it('other feeds are untouched', async () => {
    const r = await run(OTHER_FEED, 'moodle.example.test');
    expect(r.events[0]).toMatchObject({ kind: 'lecture', title: 'Quiz opens' });
  });

  it('is idempotent (no double prefix) and changes the hash only through the label', async () => {
    const a = await run(MOODLE_FEED, 'moodle.example.test', '[Moodle] Quiz opens');
    expect(a.events[0]?.title).toBe('[Moodle] Quiz opens');
    const plain = await run(MOODLE_FEED, undefined);
    expect(plain.events[0]?.hash).not.toBe(a.events[0]?.hash);
    expect(plain.events[0]?.sourceId).toBe(a.events[0]?.sourceId); // same identity: an update, not delete + create
  });

  it('the token in the feed URL never reaches the event', async () => {
    const r = await run(MOODLE_FEED, 'moodle.example.test');
    expect(JSON.stringify(r.events)).not.toContain('SECRETSECRET');
  });
});

describe('--details', () => {
  it('prints course, place and note under created events, only when asked', () => {
    const e = toCanonical({
      source: 'polito',
      sourceId: 'lecture:1',
      kind: 'lecture',
      title: 'Invented',
      start: '2026-11-10T09:00:00Z',
      location: 'Room 9',
      description: 'Squad 2',
      course: 'polito:5001',
    });
    const plan = diff([{ source: 'polito', complete: true, events: [e] }], [], 0.3);
    const report = { status: 'dry-run' as const, plan, options: { dryRun: true, force: false } };
    const base = {
      tz: 'Europe/Rome',
      calendarId: 'c',
      results: [{ source: 'polito', complete: true, events: [e] }],
    };
    expect(formatReport(report, base)).not.toContain('Squad 2');
    const detailed = formatReport(report, { ...base, details: true });
    expect(detailed).toContain('course polito:5001 · at Room 9 · note: Squad 2');
  });
});
