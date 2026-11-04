import { toCanonical, toGoogleEvent, OWNERSHIP_KEY, OWNERSHIP_VALUE } from '../sync/mapper.js';
import type { CalendarsApi } from './calendars.js';
import { GoogleApiError } from './types.js';
import type { EventsApi, GoogleEventResource } from './types.js';

export const VERIFY_CALENDAR_NAME = 'polito-cal-sync verify (safe to delete)';

export interface VerifyReport {
  /** One line per step, e.g. "3. delete the event: ok". */
  steps: string[];
  /** After a delete, `events.get` returns a tombstone with status "cancelled". */
  tombstoneIsCancelled: boolean | undefined;
  /** The tombstone still carries our extended properties (decision 002 assumes it does not). */
  tombstoneKeepsMarker: boolean | undefined;
  /** HTTP status of inserting the same id again (409 expected). */
  insertAfterDeleteStatus: number | 'ok' | undefined;
  /** `events.patch` brought the event back with our content and marker. */
  patchRestores: boolean | undefined;
  /** `events.update` did (only tried if patch did not). */
  updateRestores: boolean | undefined;
  recommendation: string;
  /** The throw-away calendar was deleted again. */
  cleanedUp: boolean;
  calendarId: string | undefined;
}

function describe(err: unknown): string {
  if (err instanceof GoogleApiError)
    return `HTTP ${err.status}${err.reason ? ` ${err.reason}` : ''}`;
  return err instanceof Error ? err.name : 'error';
}

const hasMarker = (e: GoogleEventResource) =>
  e.extendedProperties?.private?.[OWNERSHIP_KEY] === OWNERSHIP_VALUE;

/**
 * Runs the experiment behind docs/decisions/002 on a THROW-AWAY calendar that it creates and
 * deletes itself (so nothing of the real schedule is touched): create an event, delete it,
 * look at the tombstone, insert the same id again, patch it back, and fall back to update.
 * Prints only HTTP statuses and yes/no findings, never tokens or event text.
 */
export async function verifyGoogle(
  admin: CalendarsApi,
  api: EventsApi,
  tz: string,
  log: (line: string) => void = () => undefined,
): Promise<VerifyReport> {
  const r: VerifyReport = {
    steps: [],
    tombstoneIsCancelled: undefined,
    tombstoneKeepsMarker: undefined,
    insertAfterDeleteStatus: undefined,
    patchRestores: undefined,
    updateRestores: undefined,
    recommendation: 'The experiment did not finish; see the steps above.',
    cleanedUp: false,
    calendarId: undefined,
  };
  const step = (line: string) => {
    r.steps.push(line);
    log(line);
  };

  const event = toGoogleEvent(
    toCanonical({
      source: 'verify',
      sourceId: 'verify-1',
      kind: 'lecture',
      title: 'verify event A',
      start: '2030-01-15T10:00:00Z',
      end: '2030-01-15T11:00:00Z',
    }),
    tz,
  ) as GoogleEventResource & { id: string };
  const changed: GoogleEventResource & { id: string } = {
    ...event,
    summary: 'verify event B (restored)',
  };

  let calendarId: string | undefined;
  try {
    calendarId = (await admin.insert({ summary: VERIFY_CALENDAR_NAME, timeZone: tz })).id;
    r.calendarId = calendarId;
    step('1. created a throw-away calendar: ok');
    const cal = calendarId;
    const id = event.id;

    await api.insert({ calendarId: cal, resource: event });
    step('2. inserted event A: ok');

    await api.delete({ calendarId: cal, eventId: id });
    step('3. deleted event A: ok');

    try {
      const tomb = await api.get({ calendarId: cal, eventId: id });
      r.tombstoneIsCancelled = tomb.status === 'cancelled';
      r.tombstoneKeepsMarker = hasMarker(tomb);
      step(
        `4. get after delete: status "${tomb.status ?? '?'}", extended properties ${r.tombstoneKeepsMarker ? 'KEPT' : 'gone'}`,
      );
    } catch (err) {
      step(`4. get after delete: ${describe(err)}`);
    }

    try {
      await api.insert({ calendarId: cal, resource: event });
      r.insertAfterDeleteStatus = 'ok';
      step('5. inserting the same id again: accepted (no 409)');
    } catch (err) {
      r.insertAfterDeleteStatus = err instanceof GoogleApiError ? err.status : undefined;
      step(`5. inserting the same id again: ${describe(err)}`);
    }

    const restored = async (): Promise<boolean> => {
      const e = await api.get({ calendarId: cal, eventId: id });
      return e.status === 'confirmed' && hasMarker(e) && e.summary === changed.summary;
    };

    if (r.insertAfterDeleteStatus === 'ok') {
      r.patchRestores = undefined; // nothing to restore: Google let us re-create it
    } else {
      try {
        const res = await api.patch({ calendarId: cal, eventId: id, resource: changed });
        step(`6. events.patch on the deleted id: accepted (status "${res.status ?? '?'}")`);
      } catch (err) {
        step(`6. events.patch on the deleted id: ${describe(err)}`);
      }
      try {
        r.patchRestores = await restored();
      } catch (err) {
        r.patchRestores = false;
        step(`7. get after patch: ${describe(err)}`);
      }
      step(
        `7. after patch the event is back with our content and marker: ${r.patchRestores ? 'YES' : 'NO'}`,
      );

      if (!r.patchRestores) {
        try {
          await api.update({ calendarId: cal, eventId: id, resource: changed });
          step('8. events.update on the deleted id: accepted');
        } catch (err) {
          step(`8. events.update on the deleted id: ${describe(err)}`);
        }
        try {
          r.updateRestores = await restored();
        } catch {
          r.updateRestores = false;
        }
        step(
          `9. after update the event is back with our content and marker: ${r.updateRestores ? 'YES' : 'NO'}`,
        );
      }
    }

    try {
      const listed = await api.list({
        calendarId: cal,
        privateExtendedProperty: [`${OWNERSHIP_KEY}=${OWNERSHIP_VALUE}`],
      });
      step(`10. list filtered by our marker returns ${listed.items.length} event(s)`);
    } catch (err) {
      step(`10. list filtered by our marker: ${describe(err)}`);
    }

    if (r.insertAfterDeleteStatus === 'ok') {
      r.recommendation =
        'Google accepted re-creating a deleted id. The restore path (409 -> patch) is not needed, but is harmless.';
    } else if (r.patchRestores) {
      r.recommendation = 'Keep events.patch for restoring a deleted event (decision 002 holds).';
    } else if (r.updateRestores) {
      r.recommendation =
        'events.patch cannot restore a deleted event; events.update can. The program already falls back to update automatically.';
    } else {
      r.recommendation =
        'Neither patch nor update restored the event: a deleted id may be unusable. Report these steps in an issue; the program will skip such items with a clear error.';
    }
  } catch (err) {
    step(`stopped: ${describe(err)}`);
  } finally {
    if (calendarId) {
      try {
        await admin.delete(calendarId);
        r.cleanedUp = true;
        step('11. deleted the throw-away calendar: ok');
      } catch (err) {
        step(
          `11. could NOT delete the throw-away calendar (${describe(err)}). Delete the calendar named "${VERIFY_CALENDAR_NAME}" by hand in Google Calendar.`,
        );
      }
    }
  }
  return r;
}
