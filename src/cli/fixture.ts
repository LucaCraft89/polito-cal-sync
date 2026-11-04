import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { MemoryEventsApi } from '../google/memory.js';
import type { EventDraft, SourceResult } from '../sources/types.js';
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
}

/** Loads a fixture folder into an in-memory calendar and a list of source results. */
export function loadFixture(dir: string, tz: string): Fixture {
  const sources = sourcesFile.safeParse(readJson(dir, 'sources.json'));
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

  const results = sources.data.sources.map((s) => {
    // toCanonical validates every row and reports a bad one as E_EVENT_INVALID.
    return {
      source: s.source,
      complete: s.complete,
      events: s.events.map((e) => toCanonical(e as EventDraft)),
    };
  });
  return { calendarId, results, api };
}
