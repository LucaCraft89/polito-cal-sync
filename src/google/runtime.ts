import type { Config } from '../config/index.js';
import { UserError } from '../util/errors.js';
import { createGoogleEventsApi } from './adapter.js';
import { assertDedicatedCalendar, CalendarChoice, createCalendarsApi } from './calendars.js';
import { authorizedClient, clientCredentials, TokenStore } from './oauth.js';
import type { EventsApi } from './types.js';

export interface GoogleRuntime {
  api: EventsApi;
  calendarId: string;
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
  await assertDedicatedCalendar(createCalendarsApi(client), calendarId);
  return { api: createGoogleEventsApi(client), calendarId };
}
