import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { google, type Auth } from 'googleapis';
import { UserError } from '../util/errors.js';
import { writePrivateFile } from '../util/files.js';
import { USER_AGENT } from '../util/version.js';
import { retry } from '../util/retry.js';
import { toApiError } from './adapter.js';
import { mapGoogleError } from './calendar.js';
import { GoogleApiError } from './types.js';

export interface CalendarEntry {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

/** Thin, mockable mirror of the calendar list/management calls we need. */
export interface CalendarsApi {
  list(): Promise<CalendarEntry[]>;
  get(id: string): Promise<CalendarEntry>;
  insert(p: { summary: string; timeZone: string; description?: string }): Promise<CalendarEntry>;
  delete(id: string): Promise<void>;
}

export const DEFAULT_CALENDAR_NAME = 'Polito (polito-cal-sync)';
const OPTIONS = { headers: { 'User-Agent': USER_AGENT }, timeout: 30_000 } as const;

async function guarded<T>(fn: () => Promise<T>, calendarGone = false): Promise<T> {
  try {
    return await retry(
      async () => {
        try {
          return await fn();
        } catch (err) {
          throw toApiError(err);
        }
      },
      {
        attempts: 4,
        baseMs: 1000,
        maxMs: 30_000,
        shouldRetry: (e) =>
          e instanceof GoogleApiError && (e.network || e.status === 429 || e.status >= 500),
      },
    );
  } catch (err) {
    throw mapGoogleError(err, calendarGone);
  }
}

export function createCalendarsApi(auth: Auth.OAuth2Client): CalendarsApi {
  const cal = google.calendar({ version: 'v3', auth });
  const entry = (e: {
    id?: string | null;
    summary?: string | null;
    primary?: boolean | null;
    accessRole?: string | null;
  }): CalendarEntry => ({
    id: e.id ?? '',
    summary: e.summary ?? '',
    primary: e.primary === true,
    accessRole: e.accessRole ?? '',
  });
  return {
    list: () =>
      guarded(async () => {
        const out: CalendarEntry[] = [];
        let pageToken: string | undefined;
        do {
          const res = await cal.calendarList.list(
            { maxResults: 250, ...(pageToken ? { pageToken } : {}) },
            OPTIONS,
          );
          out.push(...(res.data.items ?? []).map(entry));
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);
        return out;
      }),
    get: (id) =>
      guarded(
        async () => entry((await cal.calendarList.get({ calendarId: id }, OPTIONS)).data),
        true,
      ),
    insert: (p) =>
      guarded(async () => {
        const res = await cal.calendars.insert(
          {
            requestBody: {
              summary: p.summary,
              timeZone: p.timeZone,
              ...(p.description ? { description: p.description } : {}),
            },
          },
          OPTIONS,
        );
        return { ...entry(res.data), accessRole: 'owner' };
      }),
    delete: (id) =>
      guarded(async () => {
        await cal.calendars.delete({ calendarId: id }, OPTIONS);
      }),
  };
}

/** The calendar we write to, remembered in DATA_DIR (not a secret, but private to the owner). */
export class CalendarChoice {
  private readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, 'google-calendar.json');
  }
  private load(): { calendarId?: unknown; summary?: unknown } {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as { calendarId?: unknown };
    } catch {
      return {};
    }
  }
  read(): string | undefined {
    const v = this.load();
    return typeof v.calendarId === 'string' && v.calendarId ? v.calendarId : undefined;
  }
  /** The calendar's name as it was when chosen (for display only; Google is the truth). */
  readSummary(): string | undefined {
    const v = this.load();
    return this.read() && typeof v.summary === 'string' && v.summary ? v.summary : undefined;
  }
  write(calendarId: string, summary?: string): void {
    writePrivateFile(this.path, JSON.stringify({ calendarId, ...(summary ? { summary } : {}) }));
  }
  clear(): void {
    rmSync(this.path, { force: true });
  }
}

/**
 * Which Google account signed in (the id of its main calendar is its email address). Display only, and
 * the way to notice that a new sign-in is another account, whose calendar choice must not be kept.
 */
export class AccountNote {
  private readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, 'google-account.json');
  }
  read(): string | undefined {
    try {
      const v = JSON.parse(readFileSync(this.path, 'utf8')) as { account?: unknown };
      return typeof v.account === 'string' && v.account ? v.account : undefined;
    } catch {
      return undefined;
    }
  }
  write(account: string): void {
    writePrivateFile(this.path, JSON.stringify({ account }));
  }
}

function isPrimaryId(id: string): boolean {
  return id === 'primary';
}

function primaryError(): UserError {
  return new UserError({
    code: 'E_GOOGLE_CALENDAR_IS_PRIMARY',
    what: 'The chosen calendar is the main calendar of the Google account, so it was refused.',
    why: 'This tool writes into a dedicated calendar so it can never mix with your real events.',
    action:
      'Run "auth google" without --calendar-id to create the dedicated calendar, or pass the id of a secondary calendar. Clear GOOGLE_CALENDAR_ID if you set it to your email address.',
  });
}

/**
 * Checks that a calendar can be used: it exists, is not the account's main calendar, and we may
 * write to it. Called at every start so a wrong GOOGLE_CALENDAR_ID can never reach the primary one.
 */
export async function assertDedicatedCalendar(
  admin: CalendarsApi,
  id: string,
): Promise<CalendarEntry> {
  if (isPrimaryId(id)) throw primaryError();
  const entry = await admin.get(id);
  if (entry.primary) throw primaryError();
  if (entry.accessRole !== 'owner' && entry.accessRole !== 'writer') {
    throw new UserError({
      code: 'E_GOOGLE_PERMISSION_DENIED',
      what: 'The connected account cannot edit the chosen calendar.',
      why: 'It only has read access to it.',
      action: 'Pick a calendar you own: run "auth google" without --calendar-id.',
    });
  }
  return entry;
}

export interface ChooseOptions {
  /** `--calendar-id`: use this existing calendar. */
  pickId?: string;
  name?: string;
  tz: string;
}

/** Creates or picks the dedicated calendar, and returns what was done in words. */
export async function chooseCalendar(
  admin: CalendarsApi,
  o: ChooseOptions,
): Promise<{ id: string; action: 'picked' | 'reused' | 'created'; summary: string }> {
  if (o.pickId) {
    const e = await assertDedicatedCalendar(admin, o.pickId);
    return { id: e.id, action: 'picked', summary: e.summary };
  }
  const name = o.name ?? DEFAULT_CALENDAR_NAME;
  const existing = (await admin.list()).find(
    (c) => c.summary === name && c.accessRole === 'owner' && !c.primary,
  );
  if (existing) return { id: existing.id, action: 'reused', summary: existing.summary };
  const created = await admin.insert({
    summary: name,
    timeZone: o.tz,
    description:
      'Created by polito-cal-sync. Events here are managed by the program; edits may be overwritten.',
  });
  return { id: created.id, action: 'created', summary: created.summary || name };
}
