import type { Logger } from 'pino';
import { toUserError, UserError } from '../../util/errors.js';
import type { CanonicalEvent, Source, SourceResult } from '../types.js';
import {
  mapAgenda,
  mapCourses,
  mapExams,
  mapLectures,
  type Squads,
  POLITO_SOURCE_ID,
  STUDENT_DATA_PATH,
  type Mapped,
} from './map.js';
import { LoginLatch } from './portal/latch.js';
import { PortalSession, type PortalOptions } from './portal/login.js';

export { POLITO_SOURCE_ID };

export interface SectionReport {
  section: string;
  status: 'ok' | 'failed';
  items: number;
  events: number;
  /** Positions and field names only. */
  issues: string[];
  error?: UserError;
}

export interface PolitoSourceOptions {
  username: string;
  password: string;
  /** Zone in which zone-less portal times are read (the configured TZ). */
  tz: string;
  dataDir: string;
  logger?: Logger;
  now?: () => Date;
  /** `booked` (default): only exam calls the student booked; `all`: every open call. */
  examCalls?: 'booked' | 'all';
  /** The student's squad per course id (lessons of other squads are left out). */
  squads?: Squads;
  /** Test hooks for the login (fetch, allowed hosts, pauses). */
  portal?: PortalOptions;
}

const unexpected = (what: string): UserError =>
  new UserError({
    code: 'E_POLITO_API_UNEXPECTED_DATA',
    what: `The portal data was not understood: ${what}.`,
    why: 'The portal changed its answer, or the login did not really succeed (an expired session returns a page, not data).',
    action:
      'Nothing was deleted. Run probe/05-idp-login.mjs and compare the sections with docs/decisions/018-portal-sso-finding.md; report the difference (field names only).',
  });

function section(root: Record<string, unknown>, name: string): unknown[] | undefined {
  const s = root[name];
  const data = s && typeof s === 'object' ? (s as Record<string, unknown>)['data'] : undefined;
  return Array.isArray(data) ? (data as unknown[]) : undefined;
}

/**
 * The student portal as a Source (decisions 017/018). DISABLED unless SOURCE_POLITO_PORTAL_ENABLED=true.
 * FAIL CLOSED: `complete: true` only if the login worked, the answer had every expected section and every
 * item was understood. Anything else (refused login, MFA step, outage, unknown shape) makes it incomplete,
 * so the engine deletes nothing for this source. It never throws and never touches ICS events.
 */
export class PolitoPortalSource implements Source {
  readonly id = POLITO_SOURCE_ID;
  lastReport: SectionReport[] = [];
  /** Hints for the user from the last fetch (not errors). */
  notes: string[] = [];
  /** `polito:<course id>` -> course name, from the course list (feeds course-names for decision 013). */
  courseNames = new Map<string, string>();
  private readonly latch: LoginLatch;

  constructor(private readonly o: PolitoSourceOptions) {
    this.latch = new LoginLatch(o.dataDir);
  }

  private fail(error: UserError): SourceResult {
    this.lastReport = [
      { section: 'login', status: 'failed', items: 0, events: 0, issues: [], error },
    ];
    this.o.logger?.warn({ code: error.code }, 'polito portal source failed; no deletions for it');
    return { source: this.id, complete: false, events: [] };
  }

  async fetch(): Promise<SourceResult> {
    const now = (this.o.now ?? (() => new Date()))();
    let data: unknown;
    try {
      this.latch.assertOpen(this.o.username, this.o.password);
      const session = await PortalSession.login(this.o.username, this.o.password, this.o.portal);
      data = await session.getJson(STUDENT_DATA_PATH);
    } catch (err) {
      const error = toUserError(err);
      if (error.code === 'E_POLITO_API_AUTH_REJECTED') {
        // Never repeat a refused login until the credentials change (lockout protection).
        this.latch.block(this.o.username, this.o.password, now);
      }
      return this.fail(error);
    }

    const root = (
      data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
    )?.['data'];
    const top = data as Record<string, unknown> | undefined;
    if (!top || top['success'] !== true || !root || typeof root !== 'object') {
      return this.fail(unexpected('the document has no "success" flag or no "data" part'));
    }
    const sections = root as Record<string, unknown>;
    const orari = (sections['orari'] as { data?: { lezioni?: unknown } } | undefined)?.data
      ?.lezioni;
    const lezioni = Array.isArray(orari) ? (orari as unknown[]) : undefined;
    const appelli = section(sections, 'appelli');
    const agenda = section(sections, 'agenda');
    const carico = section(sections, 'carico');

    this.notes = [];
    const ctx = { tz: this.o.tz };
    const reports: SectionReport[] = [];
    const events = new Map<string, CanonicalEvent>();
    const missing = (name: string): void => {
      reports.push({
        section: name,
        status: 'failed',
        items: 0,
        events: 0,
        issues: [],
        error: unexpected(`the section "${name}" is missing or is not a list`),
      });
    };
    const take = (name: string, items: unknown[], mapped: Mapped): void => {
      const issues = [...mapped.issues];
      for (const e of mapped.events) {
        if (events.has(e.sourceId)) issues.push(`${name}: the id ${e.sourceId} appears twice`);
        else events.set(e.sourceId, e);
      }
      const report: SectionReport = {
        section: name,
        status: 'ok',
        items: items.length,
        events: mapped.events.length,
        issues,
      };
      if (issues.length > 0) {
        report.error = unexpected(
          `${issues.length} item(s) in "${name}" did not have the expected shape (${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '; ...' : ''})`,
        );
      }
      reports.push(report);
    };

    let byShortcode = new Map<string, string>();
    if (carico) {
      const courses = mapCourses(carico);
      byShortcode = courses.byShortcode;
      this.courseNames = courses.names;
      take('carico', carico, { events: [], issues: courses.issues });
    } else missing('carico');
    if (lezioni) {
      const lectures = mapLectures(lezioni, ctx, this.o.squads);
      this.notes.push(...(lectures.notes ?? []));
      take('orari', lezioni, lectures);
    } else missing('orari');
    if (appelli)
      take(
        'appelli',
        appelli,
        mapExams(appelli, ctx, byShortcode, (this.o.examCalls ?? 'booked') === 'booked'),
      );
    else missing('appelli');
    if (agenda) take('agenda', agenda, mapAgenda(agenda, ctx));
    else missing('agenda');

    this.lastReport = reports;
    for (const r of reports) {
      this.o.logger?.info(
        {
          section: r.section,
          status: r.status,
          items: r.items,
          events: r.events,
          issues: r.issues.length,
        },
        'polito section read',
      );
    }
    const complete = reports.every((r) => r.status === 'ok' && r.issues.length === 0);
    return { source: this.id, complete, events: [...events.values()] };
  }
}
