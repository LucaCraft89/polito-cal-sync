import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { eventsFromIcs } from '../src/sources/ics/events.js';
import { IcsParseError, parseContentLine, parseIcs, unfold } from '../src/sources/ics/parse.js';
import {
  parseRRule,
  recurrenceDays,
  RRuleUnsupported,
  dayMs,
  ymd,
} from '../src/sources/ics/rrule.js';

const OPTS = {
  defaultTz: 'Europe/Rome',
  windowStart: new Date('2026-01-01T00:00:00Z'),
  windowEnd: new Date('2027-12-31T00:00:00Z'),
};

function cal(...vevents: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...vevents, 'END:VCALENDAR'].join('\r\n');
}
function vevent(...lines: string[]): string {
  return ['BEGIN:VEVENT', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'].join('\r\n');
}
const starts = (text: string, o = OPTS) => eventsFromIcs(text, o).events.map((e) => e.start);

describe('ics line parser', () => {
  it('unfolds, handles quotes and escapes', () => {
    expect(unfold('A:one\r\n two\r\nB:x')).toEqual(['A:onetwo', 'B:x']);
    const p = parseContentLine(
      'ATTENDEE;CN="Rossi, Mario: prof";ROLE=CHAIR:mailto:x@example.invalid',
    );
    expect(p.params['CN']).toEqual(['Rossi, Mario: prof']);
    expect(p.value).toBe('mailto:x@example.invalid');
  });
  it('rejects things that are not iCalendar', () => {
    expect(() => parseIcs('<html>login</html>')).toThrow(IcsParseError);
    expect(() => parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VCALENDAR')).toThrow(
      IcsParseError,
    );
    expect(() => parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT')).toThrow(IcsParseError);
  });
});

describe('ics time handling', () => {
  it('TZID Europe/Rome across the autumn DST change keeps the wall-clock time', () => {
    const text = cal(
      vevent(
        'UID:dst',
        'DTSTART;TZID=Europe/Rome:20261019T090000',
        'DTEND;TZID=Europe/Rome:20261019T100000',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'SUMMARY:L',
      ),
    );
    // 19 Oct is CEST (+2), 26 Oct is CET (+1): 09:00 local = 07:00Z, then 08:00Z.
    expect(starts(text)).toEqual([
      '2026-10-19T07:00:00.000Z',
      '2026-10-26T08:00:00.000Z',
      '2026-11-02T08:00:00.000Z',
    ]);
  });

  it('a time inside the spring gap uses the offset before the change; an ambiguous one is the first', () => {
    const gap = cal(vevent('UID:g', 'DTSTART;TZID=Europe/Rome:20270328T023000', 'SUMMARY:g'));
    expect(starts(gap)).toEqual(['2027-03-28T01:30:00.000Z']); // 02:30 does not exist; +1 before the change
    const overlap = cal(vevent('UID:o', 'DTSTART;TZID=Europe/Rome:20261025T023000', 'SUMMARY:o'));
    expect(starts(overlap)).toEqual(['2026-10-25T00:30:00.000Z']); // first 02:30 (CEST)
  });

  it('floating times use the configured zone, UTC times stay UTC', () => {
    const text = cal(
      vevent('UID:f', 'DTSTART:20261110T090000', 'DTEND:20261110T100000', 'SUMMARY:f'),
      vevent('UID:u', 'DTSTART:20261110T090000Z', 'DTEND:20261110T100000Z', 'SUMMARY:u'),
    );
    const r = eventsFromIcs(text, OPTS).events;
    expect(r.find((e) => e.sourceId === 'f')?.start).toBe('2026-11-10T08:00:00.000Z');
    expect(r.find((e) => e.sourceId === 'u')?.start).toBe('2026-11-10T09:00:00.000Z');
    const ny = eventsFromIcs(text, { ...OPTS, defaultTz: 'America/New_York' }).events;
    expect(ny.find((e) => e.sourceId === 'f')?.start).toBe('2026-11-10T14:00:00.000Z');
  });

  it('uses the VTIMEZONE of the feed for a non-IANA TZID', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'BEGIN:VTIMEZONE',
      'TZID:Custom Zone',
      'BEGIN:STANDARD',
      'DTSTART:19701025T030000',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:19700329T020000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
      vevent('UID:c1', 'DTSTART;TZID=Custom Zone:20260715T100000', 'SUMMARY:s'),
      vevent('UID:c2', 'DTSTART;TZID=Custom Zone:20261215T100000', 'SUMMARY:w'),
      'END:VCALENDAR',
    ].join('\r\n');
    expect(starts(text)).toEqual(['2026-07-15T08:00:00.000Z', '2026-12-15T09:00:00.000Z']);
  });

  it('an unknown TZID is reported, never guessed', () => {
    const r = eventsFromIcs(
      cal(vevent('UID:x', 'DTSTART;TZID=Nowhere/Land:20261110T090000', 'SUMMARY:x')),
      OPTS,
    );
    expect(r.events).toEqual([]);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).not.toContain('Nowhere'); // feed content stays out of messages
  });

  it('all-day: DTEND is exclusive in ICS, the canonical end is the last day', () => {
    const text = cal(
      vevent(
        'UID:a1',
        'DTSTART;VALUE=DATE:20261214',
        'DTEND;VALUE=DATE:20261217',
        'SUMMARY:three days',
      ),
      vevent('UID:a2', 'DTSTART;VALUE=DATE:20261208', 'SUMMARY:one day, no DTEND'),
      vevent(
        'UID:a3',
        'DTSTART;VALUE=DATE:20261220',
        'DTEND;VALUE=DATE:20261221',
        'SUMMARY:one day',
      ),
      vevent('UID:a4', 'DTSTART;VALUE=DATE:20261224', 'DURATION:P2D', 'SUMMARY:two days'),
    );
    const byId = Object.fromEntries(eventsFromIcs(text, OPTS).events.map((e) => [e.sourceId, e]));
    expect([byId['a1']?.start, byId['a1']?.end, byId['a1']?.allDay]).toEqual([
      '2026-12-14',
      '2026-12-16',
      true,
    ]);
    expect(byId['a2']?.end).toBe('2026-12-08');
    expect(byId['a3']?.end).toBe('2026-12-20');
    expect([byId['a4']?.start, byId['a4']?.end]).toEqual(['2026-12-24', '2026-12-25']);
  });

  it('DURATION and missing DTEND on timed events', () => {
    const text = cal(
      vevent('UID:d1', 'DTSTART:20261110T090000Z', 'DURATION:PT1H30M', 'SUMMARY:d'),
      vevent('UID:d2', 'DTSTART:20261111T090000Z', 'SUMMARY:point'),
    );
    const r = eventsFromIcs(text, OPTS).events;
    expect(r[0]?.end).toBe('2026-11-10T10:30:00.000Z');
    expect(r[1]?.end).toBe(r[1]?.start);
  });
});

describe('ics recurrence', () => {
  const weekly = (...extra: string[]) =>
    cal(
      vevent(
        'UID:w',
        'DTSTART;TZID=Europe/Rome:20261109T083000',
        'DTEND;TZID=Europe/Rome:20261109T100000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6',
        'SUMMARY:W',
        ...extra,
      ),
    );

  it('COUNT, BYDAY and stable ids per occurrence', () => {
    const r = eventsFromIcs(weekly(), OPTS).events;
    expect(r.map((e) => e.start.slice(0, 10))).toEqual([
      '2026-11-09',
      '2026-11-11',
      '2026-11-16',
      '2026-11-18',
      '2026-11-23',
      '2026-11-25',
    ]);
    expect(r[0]?.sourceId).toBe('w#20261109T073000Z');
    // Same input, same ids.
    expect(eventsFromIcs(weekly(), OPTS).events.map((e) => e.sourceId)).toEqual(
      r.map((e) => e.sourceId),
    );
  });

  it('EXDATE removes one occurrence but COUNT still counts it', () => {
    const r = eventsFromIcs(weekly('EXDATE;TZID=Europe/Rome:20261111T083000'), OPTS).events;
    expect(r).toHaveLength(5);
    expect(r.map((e) => e.start.slice(0, 10))).not.toContain('2026-11-11');
  });

  it('a RECURRENCE-ID override replaces one occurrence and keeps its id', () => {
    const text = cal(
      vevent(
        'UID:w',
        'DTSTART:20261109T073000Z',
        'DTEND:20261109T090000Z',
        'RRULE:FREQ=DAILY;COUNT=3',
        'SUMMARY:W',
        'LOCATION:A',
      ),
      vevent(
        'UID:w',
        'RECURRENCE-ID:20261110T073000Z',
        'DTSTART:20261110T120000Z',
        'DTEND:20261110T130000Z',
        'SUMMARY:W moved',
        'LOCATION:B',
      ),
    );
    const r = eventsFromIcs(text, OPTS).events;
    expect(r).toHaveLength(3);
    const moved = r.find((e) => e.sourceId === 'w#20261110T073000Z');
    expect([moved?.start, moved?.location, moved?.title]).toEqual([
      '2026-11-10T12:00:00.000Z',
      'B',
      'W moved',
    ]);
  });

  it('cancelled events and cancelled occurrences are left out and counted', () => {
    const text = cal(
      vevent('UID:c', 'DTSTART:20261109T073000Z', 'STATUS:CANCELLED', 'SUMMARY:gone'),
      vevent('UID:w', 'DTSTART:20261109T073000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:W'),
      vevent(
        'UID:w',
        'RECURRENCE-ID:20261110T073000Z',
        'DTSTART:20261110T073000Z',
        'STATUS:CANCELLED',
        'SUMMARY:W',
      ),
    );
    const r = eventsFromIcs(text, OPTS);
    expect(r.cancelled).toBe(2);
    expect(r.events.map((e) => e.sourceId)).toEqual(['w#20261109T073000Z', 'w#20261111T073000Z']);
    expect(r.issues).toEqual([]);
  });

  it('only the window is expanded, but COUNT/UNTIL are anchored at DTSTART', () => {
    const text = cal(
      vevent('UID:y', 'DTSTART:20260105T080000Z', 'RRULE:FREQ=WEEKLY;COUNT=60', 'SUMMARY:Y'),
    );
    const narrow = eventsFromIcs(text, {
      ...OPTS,
      windowStart: new Date('2026-03-01T00:00:00Z'),
      windowEnd: new Date('2026-03-31T00:00:00Z'),
    });
    expect(narrow.events.map((e) => e.start.slice(0, 10))).toEqual([
      '2026-03-02',
      '2026-03-09',
      '2026-03-16',
      '2026-03-23',
      '2026-03-30',
    ]);
    const wide = eventsFromIcs(text, OPTS);
    expect(wide.events).toHaveLength(60);
  });

  it('monthly ordinals, interval and UNTIL', () => {
    const rule = parseRRule('FREQ=MONTHLY;BYDAY=-1FR');
    const days = [...recurrenceDays(rule, dayMs(2026, 11, 27), dayMs(2027, 2, 28))].map(
      (d) => `${ymd(d).y}-${ymd(d).m}-${ymd(d).d}`,
    );
    expect(days).toEqual(['2026-11-27', '2026-12-25', '2027-1-29', '2027-2-26']);
    const text = cal(
      vevent(
        'UID:m',
        'DTSTART:20260105T080000Z',
        'RRULE:FREQ=MONTHLY;INTERVAL=2;UNTIL=20260701T000000Z',
        'SUMMARY:M',
      ),
    );
    expect(starts(text).map((s) => s.slice(0, 10))).toEqual([
      '2026-01-05',
      '2026-03-05',
      '2026-05-05',
    ]);
  });

  it('all-day recurring events', () => {
    const text = cal(
      vevent(
        'UID:ad',
        'DTSTART;VALUE=DATE:20261201',
        'DTEND;VALUE=DATE:20261203',
        'RRULE:FREQ=WEEKLY;COUNT=2',
        'EXDATE;VALUE=DATE:20261208',
        'SUMMARY:AD',
      ),
    );
    const r = eventsFromIcs(text, OPTS).events;
    expect(r.map((e) => [e.start, e.end])).toEqual([['2026-12-01', '2026-12-02']]);
  });

  it('unsupported rules are reported as issues, not guessed', () => {
    expect(() => parseRRule('FREQ=HOURLY')).toThrow(RRuleUnsupported);
    expect(() => parseRRule('FREQ=WEEKLY;BYWEEKNO=3')).toThrow(RRuleUnsupported);
    const r = eventsFromIcs(
      cal(vevent('UID:h', 'DTSTART:20261109T073000Z', 'RRULE:FREQ=HOURLY', 'SUMMARY:h')),
      OPTS,
    );
    expect(r.events).toEqual([]);
    expect(r.issues).toHaveLength(1);
  });

  it('two versions of one event: the higher SEQUENCE wins; no UID is reported', () => {
    const text = cal(
      vevent('UID:v', 'DTSTART:20261109T073000Z', 'SEQUENCE:2', 'SUMMARY:new'),
      vevent('UID:v', 'DTSTART:20261109T073000Z', 'SEQUENCE:1', 'SUMMARY:old'),
      vevent('DTSTART:20261109T073000Z', 'SUMMARY:no uid'),
    );
    const r = eventsFromIcs(text, OPTS);
    expect(r.events.map((e) => e.title)).toEqual(['new']);
    expect(r.issues).toHaveLength(1);
  });
});

describe('sanitized fixture test/fixtures/m2/polito.ics', () => {
  it('produces the expected schedule', () => {
    const text = readFileSync(new URL('./fixtures/m2/polito.ics', import.meta.url), 'utf8');
    const r = eventsFromIcs(text, OPTS);
    expect(r.issues).toEqual([]);
    expect(r.cancelled).toBe(2);
    const titles = r.events.map((e) => e.title);
    expect(titles.filter((t) => t === 'Analisi matematica I')).toHaveLength(10); // 12 Mondays and Wednesdays minus one EXDATE and one cancelled
    expect(titles).not.toContain('Chimica (lezione annullata)');
    const exam = r.events.find((e) => e.title.startsWith('Sessione'));
    expect([exam?.start, exam?.end]).toEqual(['2026-12-14', '2026-12-16']);
    expect(r.events.find((e) => e.title === 'Fisica I')?.start).toBe('2026-11-10T09:00:00.000Z');
  });
});
