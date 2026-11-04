import type { Logger } from 'pino';
import { toUserError, UserError } from '../../util/errors.js';
import type { CanonicalEvent, Source, SourceResult } from '../types.js';
import { ENDPOINTS, FIELDS } from './fields.js';
import type { PolitoApi } from './client.js';
import {
  mapAssignments,
  mapBookings,
  mapDeadlines,
  mapExams,
  mapLectures,
  POLITO_SOURCE_ID,
  type Mapped,
} from './map.js';
import { courseSchema, listItems } from './schemas.js';

export { POLITO_SOURCE_ID };

const DAY_MS = 86_400_000;
/** Lectures and deadlines are asked for a window around today (the API takes plain dates). */
const WINDOW_PAST_DAYS = 90;
const WINDOW_FUTURE_DAYS = 180;
/** Safety cap on per-course calls (one request each). */
const MAX_COURSES = 40;

export interface EndpointReport {
  endpoint: string;
  status: 'ok' | 'failed' | 'not-run';
  items: number;
  events: number;
  /** Positions and field names only. */
  issues: string[];
  error?: UserError;
}

export interface PolitoSourceOptions {
  api: PolitoApi;
  logger?: Logger;
  now?: () => Date;
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The Polito student API as a Source. DISABLED unless SOURCE_POLITO_API_ENABLED=true, and FAIL CLOSED:
 * the result is `complete: true` only if every endpoint answered and every item was understood. Anything
 * else (login refused, rate limit, a field that does not match, a stopped run) makes it incomplete, so
 * the engine deletes nothing for this source. It never throws and never touches ICS events.
 */
export class PolitoApiSource implements Source {
  readonly id = POLITO_SOURCE_ID;
  lastReport: EndpointReport[] = [];

  constructor(private readonly o: PolitoSourceOptions) {}

  async fetch(): Promise<SourceResult> {
    const now = (this.o.now ?? (() => new Date()))();
    const from = isoDay(new Date(now.getTime() - WINDOW_PAST_DAYS * DAY_MS));
    const to = isoDay(new Date(now.getTime() + WINDOW_FUTURE_DAYS * DAY_MS));
    const range = { fromDate: from, toDate: to };

    const reports: EndpointReport[] = [];
    const events = new Map<string, CanonicalEvent>();
    let stopped = false;

    /** Runs one endpoint. After an error that would repeat on every call, nothing else is requested. */
    const run = async (
      endpoint: string,
      path: string,
      query: Record<string, string>,
      map: (items: unknown[]) => Mapped,
    ): Promise<unknown[] | undefined> => {
      if (stopped) {
        reports.push({ endpoint, status: 'not-run', items: 0, events: 0, issues: [] });
        return undefined;
      }
      try {
        const body = await this.o.api.get(path, query);
        const items = listItems(body);
        if (!items) {
          reports.push({
            endpoint,
            status: 'failed',
            items: 0,
            events: 0,
            issues: [],
            error: new UserError({
              code: 'E_POLITO_API_UNEXPECTED_DATA',
              what: `The answer for ${endpoint} is neither a list nor an object with a "data" list.`,
              why: 'Polito changed its API, or the way lists are wrapped was guessed wrong.',
              action:
                'Nothing was deleted. See docs/M3-RUNBOOK.md and report it (without content).',
            }),
          });
          return undefined;
        }
        const mapped = map(items);
        for (const e of mapped.events) if (!events.has(e.sourceId)) events.set(e.sourceId, e);
        const report: EndpointReport = {
          endpoint,
          status: 'ok',
          items: items.length,
          events: mapped.events.length,
          issues: mapped.issues,
        };
        if (mapped.issues.length > 0) {
          report.error = new UserError({
            code: 'E_POLITO_API_UNEXPECTED_DATA',
            what: `${mapped.issues.length} item(s) from ${endpoint} did not have the expected shape and were left out.`,
            why: `Details: ${mapped.issues.slice(0, 3).join('; ')}${mapped.issues.length > 3 ? '; ...' : ''}.`,
            action:
              'The other items are synced. Nothing is deleted from this source while this lasts. See docs/M3-RUNBOOK.md.',
          });
        }
        reports.push(report);
        return items;
      } catch (err) {
        const error = toUserError(err);
        reports.push({ endpoint, status: 'failed', items: 0, events: 0, issues: [], error });
        // Login problems, rate limits and outages repeat on every call: stop asking.
        if (error.code !== 'E_POLITO_API_UNEXPECTED_DATA') stopped = true;
        return undefined;
      }
    };

    const courseItems = await run('courses', ENDPOINTS.courses, {}, (items) => ({
      events: [],
      issues: items.flatMap((raw, i) => {
        const p = courseSchema.safeParse(raw);
        return p.success ? [] : [`courses #${i + 1}: ${p.error.issues[0]?.message ?? 'invalid'}`];
      }),
    }));
    await run('lectures', ENDPOINTS.lectures, range, mapLectures);
    await run('exams', ENDPOINTS.exams, {}, mapExams);
    await run('bookings', ENDPOINTS.bookings, {}, mapBookings);
    await run('deadlines', ENDPOINTS.deadlines, range, mapDeadlines);

    const courseIds = (courseItems ?? [])
      .map((c) =>
        c && typeof c === 'object' ? (c as Record<string, unknown>)[FIELDS.course.id] : undefined,
      )
      .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
      .map(String);
    const skippedCourses = Math.max(0, courseIds.length - MAX_COURSES);
    for (const courseId of courseIds.slice(0, MAX_COURSES)) {
      await run(
        `assignments (course ${courseIds.indexOf(courseId) + 1})`,
        ENDPOINTS.assignments(courseId),
        {},
        (items) => mapAssignments(courseId, items),
      );
    }

    this.lastReport = reports;
    for (const r of reports) {
      this.o.logger?.info(
        {
          endpoint: r.endpoint,
          status: r.status,
          items: r.items,
          events: r.events,
          issues: r.issues.length,
          ...(r.error ? { code: r.error.code } : {}),
        },
        'polito endpoint read',
      );
    }
    const complete =
      courseItems !== undefined &&
      skippedCourses === 0 &&
      reports.every((r) => r.status === 'ok' && r.issues.length === 0);
    return { source: this.id, complete, events: [...events.values()] };
  }
}
