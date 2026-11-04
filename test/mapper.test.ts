import { describe, expect, it } from 'vitest';
import { base32hex, googleEventId, toCanonical, toGoogleEvent } from '../src/sync/mapper.js';
import { UserError } from '../src/util/errors.js';

const lecture = {
  source: 'ics',
  sourceId: 'abc-123',
  kind: 'lecture' as const,
  title: '  Analisi matematica I  ',
  start: '2026-11-05T09:00:00+01:00',
  end: '2026-11-05T11:00:00+01:00',
  location: 'Aula 5T',
};

describe('base32hex / googleEventId', () => {
  it('matches the RFC 4648 base32hex test vectors (lowercase, unpadded)', () => {
    const enc = (s: string) => base32hex(new TextEncoder().encode(s));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('co');
    expect(enc('fo')).toBe('cpng');
    expect(enc('foo')).toBe('cpnmu');
    expect(enc('foob')).toBe('cpnmuog');
    expect(enc('fooba')).toBe('cpnmuoj1');
    expect(enc('foobar')).toBe('cpnmuoj1e8');
  });
  it('yields a 32-char id using only a-v and 0-9, stable per source:sourceId', () => {
    const id = googleEventId('ics', 'abc-123');
    expect(id).toMatch(/^[0-9a-v]{32}$/);
    expect(googleEventId('ics', 'abc-123')).toBe(id);
    expect(googleEventId('ics', 'abc-124')).not.toBe(id);
    expect(googleEventId('moodle', 'abc-123')).not.toBe(id);
  });
});

describe('toCanonical', () => {
  it('normalises times to UTC, trims text and computes a hash', () => {
    const e = toCanonical(lecture);
    expect(e.start).toBe('2026-11-05T08:00:00.000Z');
    expect(e.end).toBe('2026-11-05T10:00:00.000Z');
    expect(e.title).toBe('Analisi matematica I');
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('gives the same hash for the same instant written with another offset', () => {
    const a = toCanonical(lecture);
    const b = toCanonical({
      ...lecture,
      start: '2026-11-05T08:00:00Z',
      end: '2026-11-05T10:00:00Z',
    });
    expect(b.hash).toBe(a.hash);
  });
  it('changes the hash when content changes, but not when only identity does', () => {
    const a = toCanonical(lecture);
    expect(toCanonical({ ...lecture, location: 'Aula 6T' }).hash).not.toBe(a.hash);
    expect(toCanonical({ ...lecture, description: 'x' }).hash).not.toBe(a.hash);
    expect(toCanonical({ ...lecture, sourceId: 'other' }).hash).toBe(a.hash);
  });
  it('makes end equal start for a point in time', () => {
    const e = toCanonical({
      ...lecture,
      end: undefined,
      kind: 'deadline',
      start: '2026-11-20T23:59:00+01:00',
    });
    expect(e.end).toBe(e.start);
  });
  it('treats all-day end as inclusive and defaults it to start', () => {
    expect(
      toCanonical({ ...lecture, allDay: true, start: '2026-11-20', end: undefined }),
    ).toMatchObject({
      start: '2026-11-20',
      end: '2026-11-20',
    });
  });
  it.each([
    ['empty title', { title: '   ' }],
    ['bad date', { start: '05/11/2026 09:00' }],
    ['no offset', { start: '2026-11-05T09:00:00' }],
    ['end before start', { end: '2026-11-05T07:00:00Z' }],
    ['date-time on an all-day event', { allDay: true }],
    ['unknown kind', { kind: 'party' }],
    ['uppercase source', { source: 'ICS' }],
    ['impossible date', { allDay: true, start: '2026-02-31', end: undefined }],
  ])('rejects %s with E_EVENT_INVALID naming source and id but not the title', (_n, patch) => {
    try {
      toCanonical({ ...lecture, ...patch } as never);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UserError);
      expect((e as UserError).code).toBe('E_EVENT_INVALID');
      expect((e as UserError).what).not.toContain('Analisi');
    }
  });
});

describe('toGoogleEvent', () => {
  it('writes a timed event with the ownership marker, hash and our id', () => {
    const e = toCanonical(lecture);
    const g = toGoogleEvent(e, 'Europe/Rome');
    expect(g.id).toBe(googleEventId('ics', 'abc-123'));
    expect(g.summary).toBe('Analisi matematica I');
    expect(g.start).toEqual({ dateTime: '2026-11-05T08:00:00.000Z', timeZone: 'Europe/Rome' });
    expect(g.extendedProperties?.private).toEqual({
      polito_cal_sync: '1',
      source: 'ics',
      sourceId: 'abc-123',
      kind: 'lecture',
      hash: e.hash,
    });
  });
  it('turns an inclusive all-day range into Google exclusive end', () => {
    const e = toCanonical({
      ...lecture,
      kind: 'deadline',
      allDay: true,
      start: '2026-11-30',
      end: '2026-12-01',
    });
    const g = toGoogleEvent(e, 'Europe/Rome');
    expect(g.start).toEqual({ date: '2026-11-30' });
    expect(g.end).toEqual({ date: '2026-12-02' });
  });
  it('appends the url to the description and clears removed fields', () => {
    const e = toCanonical({
      ...lecture,
      location: undefined,
      description: 'Note',
      url: 'https://example.org/x',
    });
    const g = toGoogleEvent(e, 'Europe/Rome');
    expect(g.description).toBe('Note\n\nhttps://example.org/x');
    expect(g.location).toBe('');
  });
});
