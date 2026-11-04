import { OWNERSHIP_KEY, OWNERSHIP_VALUE } from '../sync/mapper.js';
import { UserError } from '../util/errors.js';
import { retry, type RetryOptions } from '../util/retry.js';
import { GoogleApiError } from './types.js';
import type { EventsApi, GoogleEventResource } from './types.js';

/** An event in the target calendar that carries our marker. */
export interface ManagedEvent {
  googleId: string;
  /** Missing if the marker is there but source/sourceId are not (never touched by the differ). */
  source?: string;
  sourceId?: string;
  kind?: string;
  hash?: string;
  /** For display only. */
  summary?: string;
  start?: string;
}

export type CreateOutcome = 'created' | 'revived';
export type PatchOutcome = 'patched' | 'created';
export type DeleteOutcome = 'deleted' | 'already_gone';

const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);

function isTransient(err: unknown): boolean {
  if (!(err instanceof GoogleApiError)) return false;
  if (err.network || err.status === 429 || err.status >= 500) return true;
  // 403 is also how Google reports per-minute rate limits, but not the daily cap.
  return err.status === 403 && err.reason !== undefined && err.reason !== 'dailyLimitExceeded'
    ? RATE_LIMIT_REASONS.has(err.reason)
    : false;
}

const DEFAULT_RETRY: RetryOptions = {
  attempts: 5,
  baseMs: 1000,
  maxMs: 60_000,
  shouldRetry: isTransient,
  retryAfterMs: (e) =>
    e instanceof GoogleApiError && e.retryAfter ? e.retryAfter * 1000 : undefined,
};

/** Turns a failed Google call into a user-facing error. `calendarGone` = a 404 means the calendar. */
export function mapGoogleError(err: unknown, calendarGone = false): unknown {
  if (!(err instanceof GoogleApiError)) return err;
  const detail = `HTTP ${err.status}${err.reason ? `, reason ${err.reason}` : ''}`;
  if (err.status === 401 || err.reason === 'invalid_grant' || err.reason === 'authError') {
    return new UserError({
      code: 'E_GOOGLE_AUTH_EXPIRED',
      what: 'Google no longer accepts the saved login.',
      why: 'The access was revoked, the password was changed, or the Google Cloud app is in "Testing" mode (its refresh tokens expire after 7 days).',
      action:
        'Reconnect Google from the setup wizard. See docs/ERRORS.md for how to avoid weekly expiry.',
      cause: err,
    });
  }
  if (err.status === 403 && err.reason !== undefined && RATE_LIMIT_REASONS.has(err.reason)) {
    return quota(err);
  }
  if (err.status === 403) {
    return new UserError({
      code: 'E_GOOGLE_PERMISSION_DENIED',
      what: `Google refused the request (${detail}).`,
      why: 'The connected account cannot edit this calendar, or the Google Calendar API is not enabled in your Google Cloud project.',
      action:
        'Choose a calendar you own in the wizard and enable the "Google Calendar API" for the project.',
      cause: err,
    });
  }
  if (err.status === 404 && calendarGone) {
    return new UserError({
      code: 'E_GOOGLE_CALENDAR_NOT_FOUND',
      what: 'The chosen Google calendar was not found.',
      why: 'It was deleted, or the calendar id in the settings is wrong.',
      action: 'Choose or create the calendar again in the setup wizard.',
      cause: err,
    });
  }
  if (err.status === 429) return quota(err);
  if (err.network || err.status >= 500) {
    return new UserError({
      code: 'E_GOOGLE_UNAVAILABLE',
      what: `Google could not be reached or had a server problem (${err.network ? 'network' : detail}).`,
      why: 'A temporary Google outage, or no internet connection from this machine or container.',
      action:
        'Nothing: the next scheduled run tries again. If it persists, check the network of the machine.',
      cause: err,
    });
  }
  return new UserError({
    code: 'E_GOOGLE_REQUEST_FAILED',
    what: `Google rejected a request (${detail}).`,
    why: 'An error we have no specific explanation for.',
    action:
      'Run again with LOG_LEVEL=debug and open an issue with the log (remove personal data first).',
    cause: err,
  });
}

function quota(cause: GoogleApiError): UserError {
  return new UserError({
    code: 'E_GOOGLE_QUOTA',
    what: 'Google asked us to slow down and kept refusing after several waits.',
    why: 'Too many requests in a short time (rate limit or daily quota).',
    action: 'Nothing: the next scheduled run continues. Do not lower SYNC_INTERVAL_MINUTES.',
    cause,
  });
}

function marker(resource: GoogleEventResource): boolean {
  return resource.extendedProperties?.private?.[OWNERSHIP_KEY] === OWNERSHIP_VALUE;
}

function toManaged(e: GoogleEventResource): ManagedEvent {
  const p = e.extendedProperties?.private ?? {};
  const start = e.start?.dateTime ?? e.start?.date;
  return {
    googleId: e.id as string,
    ...(p['source'] ? { source: p['source'] } : {}),
    ...(p['sourceId'] ? { sourceId: p['sourceId'] } : {}),
    ...(p['kind'] ? { kind: p['kind'] } : {}),
    ...(p['hash'] ? { hash: p['hash'] } : {}),
    ...(e.summary ? { summary: e.summary } : {}),
    ...(start ? { start } : {}),
  };
}

/**
 * The only way the rest of the program touches the user's calendar. It enforces:
 *  - we list only events that carry the ownership marker (server-side filter + local re-check);
 *  - patch and delete are refused (E_NOT_OURS) for any id that was not seen carrying the marker
 *    in this instance's `listManaged()` or created by it;
 *  - a foreign event is never overwritten when an id is already taken (E_ID_COLLISION);
 *  - Google calls are sequential, retried with backoff on 429/5xx, and failures become UserErrors.
 */
export class OwnedCalendar {
  private readonly owned = new Set<string>();
  private readonly retryOptions: RetryOptions;

  constructor(
    private readonly api: EventsApi,
    readonly calendarId: string,
    retryOverrides: Partial<RetryOptions> = {},
  ) {
    this.retryOptions = { ...DEFAULT_RETRY, ...retryOverrides };
  }

  private async call<T>(fn: () => Promise<T>, calendarGone = false): Promise<T> {
    try {
      return await retry(fn, this.retryOptions);
    } catch (err) {
      throw mapGoogleError(err, calendarGone);
    }
  }

  async listManaged(): Promise<ManagedEvent[]> {
    const out: ManagedEvent[] = [];
    this.owned.clear();
    let pageToken: string | undefined;
    do {
      const token = pageToken;
      const page = await this.call(
        () =>
          this.api.list({
            calendarId: this.calendarId,
            privateExtendedProperty: [`${OWNERSHIP_KEY}=${OWNERSHIP_VALUE}`],
            showDeleted: false,
            ...(token ? { pageToken: token } : {}),
          }),
        true,
      );
      for (const item of page.items) {
        if (!item.id || !marker(item) || item.status === 'cancelled') continue; // local re-check
        this.owned.add(item.id);
        out.push(toManaged(item));
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async create(resource: GoogleEventResource & { id: string }): Promise<CreateOutcome> {
    try {
      await this.call(() => this.api.insert({ calendarId: this.calendarId, resource }), true);
      this.owned.add(resource.id);
      return 'created';
    } catch (err) {
      if (
        !(err instanceof UserError) ||
        !(err.cause instanceof GoogleApiError) ||
        err.cause.status !== 409
      ) {
        throw err;
      }
    }
    // 409: the id is taken. Either a tombstone of a deleted event, or a live event.
    const existing = await this.call(() =>
      this.api.get({ calendarId: this.calendarId, eventId: resource.id }),
    );
    if (existing.status === 'cancelled') {
      // A deleted event keeps blocking its id and loses its properties. Nothing of anyone's is
      // left in it, so restore it with our full content.
      await this.call(() =>
        this.api.patch({ calendarId: this.calendarId, eventId: resource.id, resource }),
      );
      this.owned.add(resource.id);
      return 'revived';
    }
    if (marker(existing)) {
      await this.call(() =>
        this.api.patch({ calendarId: this.calendarId, eventId: resource.id, resource }),
      );
      this.owned.add(resource.id);
      return 'revived';
    }
    throw new UserError({
      code: 'E_ID_COLLISION',
      what: 'An event that is not ours already uses the id of a new event, so that item was skipped.',
      why: 'Ids are a hash, so this is extremely unlikely unless the event was created by hand with that id.',
      action: 'Nothing was changed on that event. Report it in an issue.',
    });
  }

  async patch(googleId: string, resource: GoogleEventResource): Promise<PatchOutcome> {
    this.assertOwned(googleId);
    try {
      await this.call(() =>
        this.api.patch({ calendarId: this.calendarId, eventId: googleId, resource }),
      );
      return 'patched';
    } catch (err) {
      const gone =
        err instanceof UserError && err.cause instanceof GoogleApiError && err.cause.status === 404;
      if (!gone) throw err;
    }
    // Someone deleted it in the Google UI since we listed it: put it back.
    await this.create({ ...resource, id: googleId });
    return 'created';
  }

  async delete(googleId: string): Promise<DeleteOutcome> {
    this.assertOwned(googleId);
    try {
      await this.call(() => this.api.delete({ calendarId: this.calendarId, eventId: googleId }));
    } catch (err) {
      const status =
        err instanceof UserError && err.cause instanceof GoogleApiError ? err.cause.status : 0;
      if (status === 404 || status === 410) return 'already_gone';
      throw err;
    }
    this.owned.delete(googleId);
    return 'deleted';
  }

  private assertOwned(googleId: string): void {
    if (this.owned.has(googleId)) return;
    throw new UserError({
      code: 'E_NOT_OURS',
      what: 'The program was about to change or delete an event it did not create, and stopped.',
      why: 'The event has no polito_cal_sync marker, or it was not found in the list of our events.',
      action: 'Nothing was changed on that event. If this repeats, report it in an issue.',
    });
  }
}
