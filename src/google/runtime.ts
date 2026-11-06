import type { Config } from '../config/index.js';
import { UserError } from '../util/errors.js';
import { createGoogleEventsApi } from './adapter.js';
import {
  assertDedicatedCalendar,
  CalendarChoice,
  createCalendarsApi,
  MOODLE_CALENDAR_FILE,
} from './calendars.js';
import { authorizedClient, clientCredentials, TokenStore } from './oauth.js';
import type { EventsApi } from './types.js';

export interface GoogleRuntime {
  api: EventsApi;
  calendarId: string;
  /** The second calendar, present only when Moodle events are kept apart. */
  moodleCalendarId?: string;
}

export function moodleCalendarMissing(): UserError {
  return new UserError({
    code: 'E_NOT_CONFIGURED',
    what: 'Moodle events are set to go to their own calendar, but that calendar has not been chosen yet.',
    why: 'The setting "Keep Moodle events in their own calendar" is on, and no second calendar was created or picked.',
    action: 'Create or pick the Moodle calendar under Settings, or switch the setting off.',
  });
}

/** Builds the real Google client from the saved login and the saved (or configured) calendar. */
export async function connectGoogle(
  config: Config,
  onTokenSaveError?: (err: unknown) => void,
): Promise<GoogleRuntime> {
  const creds = clientCredentials(config.google);
  const client = authorizedClient(creds, new TokenStore(config.dataDir), onTokenSaveError);
  const calendarId = config.google.calendarId ?? new CalendarChoice(config.dataDir).read();
  if (!calendarId) {
    throw new UserError({
      code: 'E_NOT_CONFIGURED',
      what: 'No Google calendar has been chosen yet.',
      why: 'The setup step that creates or picks the dedicated calendar has not run.',
      action: 'Run "auth google" (docs/M2-RUNBOOK.md).',
    });
  }
  const admin = createCalendarsApi(client);
  await assertDedicatedCalendar(admin, calendarId);
  let moodleCalendarId: string | undefined;
  if (config.calendars.splitMoodle) {
    moodleCalendarId =
      config.google.moodleCalendarId ??
      new CalendarChoice(config.dataDir, MOODLE_CALENDAR_FILE).read();
    if (!moodleCalendarId) {
      throw moodleCalendarMissing();
    }
    if (moodleCalendarId === calendarId) {
      throw new UserError({
        code: 'E_GOOGLE_CALENDARS_SAME',
        what: 'The Polito calendar and the Moodle calendar are the same calendar.',
        why: 'Keeping Moodle events apart needs two different calendars.',
        action: 'Choose another calendar for Moodle under Settings, or switch the split off.',
      });
    }
    await assertDedicatedCalendar(admin, moodleCalendarId);
  }
  return {
    api: createGoogleEventsApi(client),
    calendarId,
    ...(moodleCalendarId ? { moodleCalendarId } : {}),
  };
}
