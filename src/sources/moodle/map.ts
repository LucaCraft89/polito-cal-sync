import { z } from 'zod';
import { toCanonical } from '../../sync/mapper.js';
import type { CanonicalEvent } from '../types.js';

export const MOODLE_SOURCE_ID = 'moodle';

/**
 * Field names are those seen in the owner's real answers (probe 07, decision 034), shapes only; values were
 * never saved. `core_calendar_get_calendar_events` returns events with: id, name, description (HTML), courseid,
 * modulename, eventtype, timestart (Unix seconds), timeduration (seconds, 0 = a point in time), visible.
 */
const eventSchema = z.looseObject({
  id: z.number().int(),
  name: z.string().trim().min(1),
  description: z.string().nullish(),
  courseid: z.number().int().nullish(),
  modulename: z.string().nullish(),
  eventtype: z.string().nullish(),
  timestart: z.number().int().positive(),
  timeduration: z.number().int().min(0).nullish(),
  visible: z.number().int().nullish(),
});

export const courseSchema = z.looseObject({
  id: z.number().int(),
  fullname: z.string().min(1),
  shortname: z.string().nullish(),
});

/** Moodle descriptions are HTML: keep the text only (the result is plain text in a calendar). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface MappedMoodle {
  events: CanonicalEvent[];
  /** Positions and field names only, never content. A non-empty list makes the result incomplete. */
  issues: string[];
}

/** `moodle:<course id>`: opaque course key (decision 013). */
export const courseKey = (id: number | null | undefined): string | undefined =>
  id ? `moodle:${id}` : undefined;

export function mapMoodleEvents(
  list: unknown[],
  baseUrl: string,
  names: ReadonlyMap<number, string>,
): MappedMoodle {
  const events = new Map<string, CanonicalEvent>();
  const issues: string[] = [];
  list.forEach((raw, i) => {
    const r = eventSchema.safeParse(raw);
    if (!r.success) {
      const fields = [...new Set(r.error.issues.map((x) => String(x.path[0] ?? 'event')))];
      issues.push(`event #${i + 1}: unexpected field(s) ${fields.join(', ')}`);
      return;
    }
    const e = r.data;
    if (e.visible === 0) return; // hidden from the student in Moodle too
    const startMs = e.timestart * 1000;
    const duration = e.timeduration ?? 0;
    const courseName = e.courseid ? names.get(e.courseid) : undefined;
    const description = [
      courseName ? `Course: ${courseName}` : undefined,
      e.description ? htmlToText(e.description) : undefined,
    ]
      .filter((x): x is string => Boolean(x))
      .join('\n\n');
    try {
      const sourceId = String(e.id);
      if (events.has(sourceId)) {
        issues.push(`event #${i + 1}: the id appears twice`);
        return;
      }
      events.set(
        sourceId,
        toCanonical({
          source: MOODLE_SOURCE_ID,
          sourceId,
          kind: 'moodle',
          title: `[Moodle] ${e.name}`.slice(0, 300),
          start: new Date(startMs).toISOString(),
          ...(duration > 0 ? { end: new Date(startMs + duration * 1000).toISOString() } : {}),
          allDay: false,
          ...(description ? { description } : {}),
          ...(e.courseid
            ? { url: new URL(`/course/view.php?id=${e.courseid}`, baseUrl).href }
            : {}),
          ...(e.courseid ? { course: `moodle:${e.courseid}` } : {}),
        }),
      );
    } catch {
      issues.push(`event #${i + 1}: its fields could not be turned into a calendar event`);
    }
  });
  return { events: [...events.values()], issues };
}
