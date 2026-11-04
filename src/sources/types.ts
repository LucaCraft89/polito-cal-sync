import { z } from 'zod';

export const EVENT_KINDS = [
  'lecture',
  'exam',
  'exam_call',
  'booking',
  'deadline',
  'assignment',
  'moodle',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isValidDateOnly(s: string): boolean {
  if (!DATE_ONLY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

export function isValidDateTime(s: string): boolean {
  return DATE_TIME.test(s) && !Number.isNaN(new Date(s).getTime());
}

const optionalText = (max: number) => z.string().trim().max(max).optional();

/**
 * What a source adapter hands over. Times:
 * - timed event: `start` and `end` are ISO-8601 with an offset or `Z`; `end` may be omitted for a
 *   point in time (deadline at 23:59) and then equals `start`.
 * - all-day event (`allDay: true`): `start` and `end` are `YYYY-MM-DD`; `end` is the LAST day
 *   (inclusive) and defaults to `start`.
 */
export const eventDraftSchema = z
  .object({
    source: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'source must be a short lowercase id'),
    sourceId: z.string().min(1).max(512),
    kind: z.enum(EVENT_KINDS),
    title: z.string().trim().min(1).max(300),
    start: z.string(),
    end: z.string().optional(),
    allDay: z.boolean().default(false),
    location: optionalText(1000),
    url: z.url().max(1000).optional(),
    description: optionalText(20_000),
    course: optionalText(200),
  })
  .superRefine((e, ctx) => {
    const valid = e.allDay ? isValidDateOnly : isValidDateTime;
    const shape = e.allDay ? 'YYYY-MM-DD' : 'an ISO-8601 date-time with Z or an offset';
    if (!valid(e.start)) {
      ctx.addIssue({ code: 'custom', path: ['start'], message: `start must be ${shape}` });
    }
    if (e.end !== undefined && !valid(e.end)) {
      ctx.addIssue({ code: 'custom', path: ['end'], message: `end must be ${shape}` });
    }
    if (valid(e.start) && (e.end === undefined || valid(e.end))) {
      const endValue = e.end ?? e.start;
      const startMs = Date.parse(e.allDay ? `${e.start}T00:00:00Z` : e.start);
      const endMs = Date.parse(e.allDay ? `${endValue}T00:00:00Z` : endValue);
      if (endMs < startMs) {
        ctx.addIssue({ code: 'custom', path: ['end'], message: 'end must not be before start' });
      }
    }
  });

export type EventDraft = z.input<typeof eventDraftSchema>;

/** Normalised event: timed values in UTC (`...Z`), `end` always present, plus the content hash. */
export interface CanonicalEvent {
  source: string;
  sourceId: string;
  kind: EventKind;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  url?: string;
  description?: string;
  /**
   * Opaque key of the course this event belongs to (ICS `CATEGORIES`, Polito course id). Used later to
   * route events to per-course calendars (decision 013). NOT part of the content hash and not parsed.
   */
  course?: string;
  /** sha256 of the content fields; identity fields (source, sourceId) are not part of it. */
  hash: string;
}

/** What one source returned in one run. */
export interface SourceResult {
  source: string;
  /**
   * True only if the whole fetch succeeded (every page, every feed). Deletions are computed
   * only for complete results: a partial list must never delete events.
   */
  complete: boolean;
  events: CanonicalEvent[];
}

export interface Source {
  /** Matches `CanonicalEvent.source` of every event it returns. */
  readonly id: string;
  fetch(): Promise<SourceResult>;
}
