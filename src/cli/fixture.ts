import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { MemoryEventsApi } from '../google/memory.js';
import type { EventDraft, SourceResult } from '../sources/types.js';
import { eventsFromIcs } from '../sources/ics/events.js';
import { toCanonical, toGoogleEvent } from '../sync/mapper.js';
import { UserError } from '../util/errors.js';

const sourcesFile = z.object({
  sources: z.array(
    z.object({
      source: z.string(),
      complete: z.boolean(),
      events: z.array(z.looseObject({})),
    }),
  ),
});

const calendarFile = z.object({
  calendarId: z.string().min(1),
  /** Events we wrote on an earlier run, written as drafts so ids and hashes are computed for real. */
  managed: z.array(z.looseObject({})),
  /** Other people's events in the same calendar: they must never be touched. */
  foreign: z.array(
    z.object({
      id: z.string(),
      summary: z.string(),
      start: z.object({ dateTime: z.string() }),
      end: z.object({ dateTime: z.string() }),
    }),
  ),
});

function readJson(dir: string, name: string): unknown {
  const path = join(dir, name);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (cause) {
    throw fixtureError(`${path} is missing or is not valid JSON.`, cause);
  }
}

function fixtureError(what: string, cause?: unknown): UserError {
  return new UserError({
    code: 'E_FIXTURE_INVALID',
    what,
    why: 'Fixtures are developer-only input for trying the sync engine without any account.',
    action: 'Compare with test/fixtures/m1 (it has sources.json and calendar.json).',
    cause,
  });
}

export interface Fixture {
  calendarId: string;
  results: SourceResult[];
  api: MemoryEventsApi;
  /** Details of the ICS files that were parsed, for the report. */
  notes: string[];
}

const DAY_MS = 86_400_000;

/** Loads a fixture folder into an in-memory calendar and a list of source results. */
export function loadFixture(dir: string, tz: string, now: Date = new Date()): Fixture {
  let icsFiles: string[];
  try {
    icsFiles = readdirSync(dir)
      .filter((f) => f.endsWith('.ics'))
      .sort();
  } catch (cause) {
    throw fixtureError(`${dir} is not a readable folder.`, cause);
  }
  // A fixture is either ready-made source results (sources.json) or .ics files that go through
  // the real ICS parser. Only the calendar is simulated.
  const sources =
    existsSync(join(dir, 'sources.json')) || icsFiles.length === 0
      ? sourcesFile.safeParse(readJson(dir, 'sources.json'))
      : { success: true as const, data: { sources: [] } };
  if (!sources.success) {
    throw fixtureError(
      `sources.json has the wrong shape (${sources.error.issues[0]?.path.join('.') ?? '?'}).`,
    );
  }
  const calendar = calendarFile.safeParse(readJson(dir, 'calendar.json'));
  if (!calendar.success) {
    throw fixtureError(
      `calendar.json has the wrong shape (${calendar.error.issues[0]?.path.join('.') ?? '?'}).`,
    );
  }

  const api = new MemoryEventsApi();
  const calendarId = calendar.data.calendarId;
  for (const draft of calendar.data.managed) {
    const g = toGoogleEvent(toCanonical(draft as EventDraft), tz);
    api.seed(calendarId, g as typeof g & { id: string });
  }
  for (const f of calendar.data.foreign) api.seed(calendarId, { ...f, status: 'confirmed' });

  const results: SourceResult[] = sources.data.sources.map((s) => {
    // toCanonical validates every row and reports a bad one as E_EVENT_INVALID.
    return {
      source: s.source,
      complete: s.complete,
      events: s.events.map((e) => toCanonical(e as EventDraft)),
    };
  });
  const notes: string[] = [];
  if (icsFiles.length > 0) {
    const events = new Map<string, SourceResult['events'][number]>();
    let complete = true;
    for (const file of icsFiles) {
      const parsed = eventsFromIcs(readFileSync(join(dir, file), 'utf8'), {
        defaultTz: tz,
        windowStart: new Date(now.getTime() - 366 * DAY_MS),
        windowEnd: new Date(now.getTime() + 366 * DAY_MS),
      });
      for (const e of parsed.events) if (!events.has(e.sourceId)) events.set(e.sourceId, e);
      if (parsed.issues.length > 0) complete = false;
      notes.push(
        `${file}: ${parsed.events.length} event(s), ${parsed.cancelled} cancelled left out${parsed.issues.length ? `, ${parsed.issues.length} issue(s)` : ''}`,
      );
    }
    results.push({ source: 'ics', complete, events: [...events.values()] });
  }
  return { calendarId, results, api, notes };
}
