import { createHash } from 'node:crypto';
import { toCanonical } from '../../sync/mapper.js';
import type { CanonicalEvent, EventDraft } from '../types.js';
import { EXAM_BOOKED_STATUSES, FIELDS } from './fields.js';
import {
  assignmentSchema,
  bookingSchema,
  deadlineSchema,
  examSchema,
  lectureSchema,
} from './schemas.js';
import type { z } from 'zod';

export const POLITO_SOURCE_ID = 'polito';

export interface Mapped {
  events: CanonicalEvent[];
  /** Positions and field names only, never content. A non-empty list makes the endpoint incomplete. */
  issues: string[];
}

type Item = Record<string, unknown>;
const get = (item: Item, name: string): unknown => item[name];
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** Ids are strings or whole numbers (the schemas already normalised them to strings). */
const idText = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

/** Course key in the `polito:` key space (decision 013). Opaque. */
export const courseKeyOf = (courseId: unknown): string | undefined =>
  courseId === null || courseId === undefined || courseId === ''
    ? undefined
    : `polito:${idText(courseId)}`;

/** Best-effort place text. The real shape is unknown, so unknown shapes simply give no location. */
export function locationText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value)) {
    const names = value.map(locationText).filter((x): x is string => !!x);
    return names.length > 0 ? names.slice(0, 3).join(', ') : undefined;
  }
  if (value && typeof value === 'object') return locationText((value as Item)['name']);
  return undefined;
}

/** Stable id for items the API gives no id for: a hash of what identifies them. */
function derivedId(...parts: string[]): string {
  return `h:${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24)}`;
}

function problems(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'item'}: ${i.message}`)
    .join('; ');
}

function build<T>(
  endpoint: string,
  items: readonly unknown[],
  schema: z.ZodType<T>,
  toDraft: (item: Item) => EventDraft[],
): Mapped {
  const events: CanonicalEvent[] = [];
  const issues: string[] = [];
  items.forEach((raw, i) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      issues.push(`${endpoint} #${i + 1}: ${problems(parsed.error)}`);
      return;
    }
    try {
      for (const draft of toDraft(parsed.data as Item)) events.push(toCanonical(draft));
    } catch {
      issues.push(`${endpoint} #${i + 1}: its fields could not be turned into a calendar event`);
    }
  });
  return { events, issues };
}

const base = (sourceId: string) => ({ source: POLITO_SOURCE_ID, sourceId });

export function mapLectures(items: readonly unknown[]): Mapped {
  const f = FIELDS.lecture;
  return build('lectures', items, lectureSchema, (it) => {
    const loc = locationText(get(it, f.location));
    const course = courseKeyOf(get(it, f.course));
    const end = str(get(it, f.end));
    return [
      {
        ...base(`lecture:${String(get(it, f.id))}`),
        kind: 'lecture',
        title: String(get(it, f.title)).slice(0, 300),
        start: String(get(it, f.start)),
        ...(end ? { end } : {}),
        ...(loc ? { location: loc } : {}),
        ...(course ? { course } : {}),
      },
    ];
  });
}

export function mapExams(items: readonly unknown[]): Mapped {
  const f = FIELDS.exam;
  return build('exams', items, examSchema, (it) => {
    const id = String(get(it, f.id));
    const title = String(get(it, f.title)).slice(0, 300);
    const status = str(get(it, f.status));
    const loc = locationText(get(it, f.location));
    const course = courseKeyOf(get(it, f.course));
    const end = str(get(it, f.end));
    const closes = str(get(it, f.bookingCloses));
    const kind =
      status !== undefined && EXAM_BOOKED_STATUSES.includes(status) ? 'exam' : 'exam_call';
    const common = { ...(loc ? { location: loc } : {}), ...(course ? { course } : {}) };
    const drafts: EventDraft[] = [
      {
        ...base(`exam:${id}`),
        kind,
        title,
        start: String(get(it, f.start)),
        ...(end ? { end } : {}),
        ...common,
        ...(status ? { description: `Status: ${status}` } : {}),
      },
    ];
    if (closes) {
      drafts.push({
        ...base(`exam:${id}:booking-closes`),
        kind: 'deadline',
        title: `Booking closes: ${title}`.slice(0, 300),
        start: closes,
        ...(course ? { course } : {}),
      });
    }
    return drafts;
  });
}

export function mapBookings(items: readonly unknown[]): Mapped {
  const f = FIELDS.booking;
  return build('bookings', items, bookingSchema, (it) => {
    const loc = locationText(get(it, f.location));
    const end = str(get(it, f.end));
    return [
      {
        ...base(`booking:${String(get(it, f.id))}`),
        kind: 'booking',
        title: String(get(it, f.title)).slice(0, 300),
        start: String(get(it, f.start)),
        ...(end ? { end } : {}),
        ...(loc ? { location: loc } : {}),
      },
    ];
  });
}

export function mapDeadlines(items: readonly unknown[]): Mapped {
  const f = FIELDS.deadline;
  return build('deadlines', items, deadlineSchema, (it) => {
    const title = String(get(it, f.title)).slice(0, 300);
    const date = String(get(it, f.date));
    const rawId = get(it, f.id);
    const course = courseKeyOf(get(it, f.course));
    const id =
      rawId === null || rawId === undefined ? derivedId(title, date, course ?? '') : idText(rawId);
    return [
      {
        ...base(`deadline:${id}`),
        kind: 'deadline',
        title,
        allDay: true,
        start: date,
        ...(course ? { course } : {}),
      },
    ];
  });
}

/** Assignments of one course. The API publishes only the upload time, so that is the event time. */
export function mapAssignments(courseId: string, items: readonly unknown[]): Mapped {
  const f = FIELDS.assignment;
  return build('assignments', items, assignmentSchema, (it) => {
    const title = String(get(it, f.title)).slice(0, 300);
    const uploadedAt = String(get(it, f.uploadedAt));
    const rawId = get(it, f.id);
    const id = rawId === null || rawId === undefined ? derivedId(title, uploadedAt) : idText(rawId);
    const course = courseKeyOf(courseId);
    return [
      {
        ...base(`assignment:${courseId}:${id}`),
        kind: 'assignment',
        title,
        start: uploadedAt,
        description: 'Uploaded on the student portal. No due date is published for this item.',
        ...(course ? { course } : {}),
      },
    ];
  });
}
