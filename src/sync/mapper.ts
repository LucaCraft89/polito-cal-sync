import { createHash } from 'node:crypto';
import { UserError } from '../util/errors.js';
import type { GoogleEventResource } from '../google/types.js';
import {
  eventDraftSchema,
  type CanonicalEvent,
  type EventDraft,
  type SourceResult,
} from '../sources/types.js';

/** Marker on every event we write; we only ever touch events that carry it. */
export const OWNERSHIP_KEY = 'polito_cal_sync';
export const OWNERSHIP_VALUE = '1';

const DESCRIPTION_LIMIT = 8000; // Google's own limit is 8192 characters

const B32HEX = '0123456789abcdefghijklmnopqrstuv';

/** RFC 4648 base32hex, lowercase, no padding. Google accepts exactly a-v and 0-9 in event ids. */
export function base32hex(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32HEX[(value << (5 - bits)) & 31];
  return out;
}

/** Stable Google event id for a (source, sourceId) pair: makes upserts idempotent. */
export function googleEventId(source: string, sourceId: string): string {
  return base32hex(createHash('sha1').update(`${source}:${sourceId}`).digest());
}

function contentHash(e: Omit<CanonicalEvent, 'hash'>): string {
  const content = [
    e.kind,
    e.title,
    e.start,
    e.end,
    e.allDay,
    e.location ?? null,
    e.url ?? null,
    e.description ?? null,
  ];
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Validates a draft from a source adapter and turns it into a normalised CanonicalEvent. */
export function toCanonical(draft: EventDraft): CanonicalEvent {
  const parsed = eventDraftSchema.safeParse(draft);
  if (!parsed.success) {
    const d = draft as Partial<Record<'source' | 'sourceId', unknown>>;
    const where = `${String(d.source)}:${String(d.sourceId)}`;
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'event'}: ${i.message}`);
    throw new UserError({
      code: 'E_EVENT_INVALID',
      what: `A source produced an invalid event (${where}): ${problems.join('; ')}.`,
      why: 'The source data is missing a field, uses an unexpected date format, or ends before it starts.',
      action:
        'Nothing was written. Report the source and id above in an issue (without the event text).',
    });
  }
  const e = parsed.data;
  const normalized = e.allDay
    ? { start: e.start, end: e.end ?? e.start }
    : {
        start: new Date(e.start).toISOString(),
        end: new Date(e.end ?? e.start).toISOString(),
      };
  const base: Omit<CanonicalEvent, 'hash'> = {
    source: e.source,
    sourceId: e.sourceId,
    kind: e.kind,
    title: e.title,
    allDay: e.allDay,
    ...normalized,
    ...(e.location ? { location: e.location } : {}),
    ...(e.url ? { url: e.url } : {}),
    ...(e.description ? { description: truncate(e.description, DESCRIPTION_LIMIT) } : {}),
  };
  return { ...base, hash: contentHash(base) };
}

/** Convenience: validates a whole source result. */
export function toSourceResult(input: {
  source: string;
  complete: boolean;
  events: EventDraft[];
}): SourceResult {
  return {
    source: input.source,
    complete: input.complete,
    events: input.events.map(toCanonical),
  };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Builds the Google event resource we write. Always carries the ownership marker and the hash. */
export function toGoogleEvent(event: CanonicalEvent, tz: string): GoogleEventResource {
  const description = [event.description, event.url].filter(Boolean).join('\n\n');
  return {
    id: googleEventId(event.source, event.sourceId),
    status: 'confirmed',
    summary: event.title,
    // Explicit empty strings so a patch clears a field that was removed at the source.
    location: event.location ?? '',
    description,
    start: event.allDay ? { date: event.start } : { dateTime: event.start, timeZone: tz },
    end: event.allDay
      ? { date: addDays(event.end, 1) } // Google's all-day end is exclusive
      : { dateTime: event.end, timeZone: tz },
    extendedProperties: {
      private: {
        [OWNERSHIP_KEY]: OWNERSHIP_VALUE,
        source: event.source,
        sourceId: event.sourceId,
        kind: event.kind,
        hash: event.hash,
      },
    },
  };
}
