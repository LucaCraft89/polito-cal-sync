import { z } from 'zod';
import { toCanonical } from '../../sync/mapper.js';
import { zonedToUtcIso } from '../../util/zone.js';
import { isValidDateOnly } from '../types.js';
import type { CanonicalEvent, EventDraft } from '../types.js';

export const POLITO_SOURCE_ID = 'polito';
/** The one JSON document the student portal serves after login (decision 018). */
export const STUDENT_DATA_PATH = '/pls/portal30/sviluppo.studente.getStudentData';

/**
 * Field names come from the owner's real sanitized sample (2026-11-04), not from guesses. What the
 * sample did NOT show is marked UNVERIFIED: the time zone of zone-less times (read as the configured TZ),
 * and what other `status` / agenda `type` values exist.
 */

export interface Mapped {
  /** Hints for the user (not errors), e.g. which squads exist. */
  notes?: string[];
  /** course id -> every squad label seen in its lessons (also when the student already chose one). */
  squadsSeen?: Map<string, Set<string>>;
  events: CanonicalEvent[];
  /** Positions and field names only, never content. A non-empty list makes the result incomplete. */
  issues: string[];
}

const idValue = z.union([z.string().min(1), z.number().int()]).transform(String);
const text = z.string().trim().min(1);
const optText = z.string().optional().nullable();
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?$/;
/** A date-time with an offset or Z (lectures, bookings) or WITHOUT a zone (exam calls). */
const dateTime = z.string().regex(DATETIME, 'must be an ISO date-time');
const place = z.looseObject({ name: optText }).nullish();

const lectureSchema = z.looseObject({
  id: idValue,
  courseId: idValue.nullish(),
  startsAt: dateTime,
  endsAt: dateTime.nullish(),
  courseName: text,
  description: optText,
  place,
});

const examSchema = z.looseObject({
  id: idValue,
  courseShortcode: optText,
  courseName: text,
  type: optText,
  classrooms: optText,
  notes: optText,
  status: optText,
  idBooking: z.number().nullish(),
  bookingStartsAt: optText,
  bookingEndsAt: optText,
  examStartsAt: dateTime,
  examEndsAt: dateTime.nullish(),
});

const carichiSchema = z.looseObject({
  id: idValue,
  name: optText,
  shortcode: optText,
});

const datedAgendaSchema = z.looseObject({
  id: idValue,
  title: text,
  date: z.string().refine(isValidDateOnly, 'must be a YYYY-MM-DD date'),
  type: optText,
});

const slotAgendaSchema = z.looseObject({
  id: idValue,
  title: text,
  type: optText,
  d_ini_turno_ts: dateTime,
  d_fin_turno_ts: dateTime.nullish(),
  place,
});

export interface MapContext {
  tz: string;
}

/** Offset/Z times are kept; zone-less times are read in the configured zone. */
function toIso(value: string, ctx: MapContext): string | undefined {
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return value;
  return zonedToUtcIso(value, ctx.tz);
}

const clip = (s: string, n: number): string => s.slice(0, n);
const clean = (s: string | null | undefined): string | undefined => {
  const t = s?.trim();
  return t ? t : undefined;
};

function problems(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'item'}: ${i.message}`)
    .join('; ');
}

function build(
  section: string,
  items: readonly unknown[],
  toDrafts: (item: unknown) => EventDraft[] | z.ZodError,
): Mapped {
  const events: CanonicalEvent[] = [];
  const issues: string[] = [];
  items.forEach((raw, i) => {
    const drafts = toDrafts(raw);
    if (drafts instanceof z.ZodError) {
      issues.push(`${section} #${i + 1}: ${problems(drafts)}`);
      return;
    }
    try {
      for (const d of drafts) events.push(toCanonical(d));
    } catch {
      issues.push(`${section} #${i + 1}: its fields could not be turned into a calendar event`);
    }
  });
  return { events, issues };
}

const base = (sourceId: string) => ({ source: POLITO_SOURCE_ID, sourceId });

/** course key: the portal's numeric course id, in the `polito:` key space (decision 013). */
const courseKey = (id: string | null | undefined): string | undefined =>
  id ? `polito:${id}` : undefined;

/** A lesson of one squad (parallel group) says so in its description: "SQUADRA A", "SQUADRA 2". */
const SQUAD = /^squadra\s+(\S+)$/i;

/** course id -> the squads the student is in. A lesson of another squad of a listed course is left out. */
export type Squads = ReadonlyMap<string, ReadonlySet<string>>;

export function mapLectures(
  items: readonly unknown[],
  ctx: MapContext,
  squads: Squads = new Map(),
): Mapped {
  const seen = new Map<string, Set<string>>(); // courses with squads but no setting -> labels seen
  const all = new Map<string, Set<string>>(); // every course with squads -> every label seen
  const mapped = build('orari.lezioni', items, (raw) => {
    const p = lectureSchema.safeParse(raw);
    if (!p.success) return p.error;
    const l = p.data;
    const label = SQUAD.exec(l.description?.trim() ?? '')?.[1]?.toUpperCase();
    if (label && l.courseId) {
      const every = all.get(l.courseId) ?? new Set<string>();
      every.add(label);
      all.set(l.courseId, every);
      const mine = squads.get(l.courseId);
      if (mine) {
        if (!mine.has(label)) return []; // another squad: validated above, left out on purpose
      } else {
        const set = seen.get(l.courseId) ?? new Set<string>();
        set.add(label);
        seen.set(l.courseId, set);
      }
    }
    const start = toIso(l.startsAt, ctx);
    const end = l.endsAt ? toIso(l.endsAt, ctx) : undefined;
    if (!start)
      return new z.ZodError([
        { code: 'custom', path: ['startsAt'], message: 'unreadable time', input: l.startsAt },
      ]);
    const location = clean(l.place?.name);
    const description = clean(l.description);
    const course = courseKey(l.courseId);
    return [
      {
        ...base(`lecture:${l.id}`),
        kind: 'lecture',
        title: clip(l.courseName, 300),
        start,
        ...(end ? { end } : {}),
        ...(location ? { location } : {}),
        ...(description ? { description } : {}),
        ...(course ? { course } : {}),
      },
    ];
  });
  if (all.size > 0) mapped.squadsSeen = all;
  if (seen.size > 0) {
    const list = [...seen]
      .map(([id, labels]) => `${id} (${[...labels].sort().join(', ')})`)
      .join('; ');
    mapped.notes = [
      `Some lectures belong to squads and are ALL kept. Set POLITO_SQUADS=<course id>=<your squad>,... to keep only yours. Course ids and squads seen: ${list}.`,
    ];
  }
  return mapped;
}

/** `status: "booked"` is the only value seen; it (and only it) makes an exam call kind `exam`. */
export const EXAM_BOOKED_STATUS = 'booked';

/** Booked = the status says so, or the call carries a booking id (both held for the one booked call in the sample). */
const isBooked = (e: {
  status?: string | null | undefined;
  idBooking?: number | null | undefined;
}): boolean =>
  e.status === EXAM_BOOKED_STATUS || (typeof e.idBooking === 'number' && e.idBooking > 0);

export function mapExams(
  items: readonly unknown[],
  ctx: MapContext,
  courseIdByShortcode: ReadonlyMap<string, string>,
  /** Keep only calls the student booked. Every item is still validated (an unknown shape stays an issue). */
  onlyBooked = false,
): Mapped {
  return build('appelli', items, (raw) => {
    const p = examSchema.safeParse(raw);
    if (!p.success) return p.error;
    const e = p.data;
    if (onlyBooked && !isBooked(e)) {
      // validated above; left out on purpose
      if (!toIso(e.examStartsAt, ctx))
        return new z.ZodError([
          {
            code: 'custom',
            path: ['examStartsAt'],
            message: 'unreadable time',
            input: e.examStartsAt,
          },
        ]);
      return [];
    }
    const start = toIso(e.examStartsAt, ctx);
    const end = e.examEndsAt ? toIso(e.examEndsAt, ctx) : undefined;
    if (!start)
      return new z.ZodError([
        {
          code: 'custom',
          path: ['examStartsAt'],
          message: 'unreadable time',
          input: e.examStartsAt,
        },
      ]);
    const closes = clean(e.bookingEndsAt)
      ? toIso(clean(e.bookingEndsAt) as string, ctx)
      : undefined;
    const opens = clean(e.bookingStartsAt)
      ? toIso(clean(e.bookingStartsAt) as string, ctx)
      : undefined;
    const lines = [
      clean(e.type),
      clean(e.notes),
      opens ? `Booking opens: ${opens}` : undefined,
      closes ? `Booking closes: ${closes}` : undefined,
    ].filter((x): x is string => !!x);
    const location = clean(e.classrooms);
    const shortcode = clean(e.courseShortcode);
    const courseId = shortcode ? courseIdByShortcode.get(shortcode) : undefined;
    const course = courseKey(courseId);
    return [
      {
        ...base(`exam:${e.id}`),
        kind: isBooked(e) ? 'exam' : 'exam_call',
        title: clip(e.courseName, 300),
        start,
        ...(end ? { end } : {}),
        ...(location ? { location } : {}),
        ...(lines.length ? { description: lines.join('\n') } : {}),
        ...(course ? { course } : {}),
      },
    ];
  });
}

/**
 * Academic-calendar markers by `type` (UNVERIFIED beyond the three seen: TASSE, LEZIONI, ESAMI; anything
 * else is treated as a deadline). All-day events.
 */
const AGENDA_KIND: Record<string, 'deadline' | 'lecture' | 'exam_call'> = {
  TASSE: 'deadline',
  LEZIONI: 'lecture',
  ESAMI: 'exam_call',
};

export function mapAgenda(items: readonly unknown[], ctx: MapContext): Mapped {
  return build('agenda', items, (raw) => {
    // A booking slot (has its own time range and place) or a dated marker; nothing else is understood.
    if (raw && typeof raw === 'object' && 'd_ini_turno_ts' in raw) {
      const p = slotAgendaSchema.safeParse(raw);
      if (!p.success) return p.error;
      const s = p.data;
      const start = toIso(s.d_ini_turno_ts, ctx);
      const end = s.d_fin_turno_ts ? toIso(s.d_fin_turno_ts, ctx) : undefined;
      if (!start)
        return new z.ZodError([
          {
            code: 'custom',
            path: ['d_ini_turno_ts'],
            message: 'unreadable time',
            input: s.d_ini_turno_ts,
          },
        ]);
      const location = clean(s.place?.name);
      return [
        {
          ...base(`agenda:${s.id}`),
          kind: 'booking',
          title: clip(s.title, 300),
          start,
          ...(end ? { end } : {}),
          ...(location ? { location } : {}),
        },
      ];
    }
    const p = datedAgendaSchema.safeParse(raw);
    if (!p.success) return p.error;
    const a = p.data;
    return [
      {
        ...base(`agenda:${a.id}`),
        kind: AGENDA_KIND[a.type ?? ''] ?? 'deadline',
        title: clip(a.title, 300),
        allDay: true,
        start: a.date,
      },
    ];
  });
}

/** shortcode -> course id, from the course list (`carico`). Also returns the issues of that list. */
export function mapCourses(items: readonly unknown[]): {
  byShortcode: Map<string, string>;
  names: Map<string, string>;
  issues: string[];
} {
  const byShortcode = new Map<string, string>();
  const names = new Map<string, string>();
  const issues: string[] = [];
  items.forEach((raw, i) => {
    const p = carichiSchema.safeParse(raw);
    if (!p.success) {
      issues.push(`carico #${i + 1}: ${problems(p.error)}`);
      return;
    }
    const sc = clean(p.data.shortcode);
    if (sc) byShortcode.set(sc, p.data.id);
    const name = clean(p.data.name);
    if (name) names.set(`polito:${p.data.id}`, name);
  });
  return { byShortcode, names, issues };
}
