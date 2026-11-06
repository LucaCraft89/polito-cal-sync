import { google, type Auth, type calendar_v3 } from 'googleapis';
import { USER_AGENT } from '../util/version.js';
import { GoogleApiError } from './types.js';
import type { EventsApi, GoogleEventResource } from './types.js';

const REQUEST_OPTIONS = { headers: { 'User-Agent': USER_AGENT }, timeout: 30_000 } as const;

interface GaxiosLikeError {
  code?: string | number;
  message?: string;
  status?: number;
  response?: {
    status?: number;
    headers?: Record<string, unknown>;
    data?: { error?: string | { errors?: { reason?: string }[]; status?: string } };
  };
}

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNABORTED',
  'EPIPE',
]);

/** Converts whatever googleapis throws into our GoogleApiError (no secrets are copied over). */
export function toApiError(err: unknown): unknown {
  if (err instanceof GoogleApiError) return err;
  const e = err as GaxiosLikeError | null;
  if (!e || typeof e !== 'object') return err;
  const status = e.response?.status ?? e.status ?? (typeof e.code === 'number' ? e.code : 0);
  const data = e.response?.data?.error;
  const reason =
    typeof data === 'string' ? data : (data?.errors?.[0]?.reason ?? data?.status ?? undefined);
  const retryAfterRaw = e.response?.headers?.['retry-after'];
  const retryAfter = retryAfterRaw !== undefined ? Number(retryAfterRaw) : NaN;
  if (status === 0) {
    if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) {
      return new GoogleApiError({ status: 0, reason: e.code, network: true });
    }
    return err;
  }
  return new GoogleApiError({
    status,
    ...(reason ? { reason } : {}),
    ...(Number.isFinite(retryAfter) ? { retryAfter } : {}),
  });
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err);
  }
}

/** Real Google Calendar implementation of EventsApi. */
export function createEventsApi(calendar: calendar_v3.Calendar): EventsApi {
  const events = calendar.events;
  return {
    list: (p) =>
      guarded(async () => {
        const res = await events.list(
          {
            calendarId: p.calendarId,
            ...(p.privateExtendedProperty
              ? { privateExtendedProperty: p.privateExtendedProperty }
              : {}),
            ...(p.pageToken ? { pageToken: p.pageToken } : {}),
            showDeleted: p.showDeleted ?? false,
            singleEvents: false,
            maxResults: 250,
          },
          REQUEST_OPTIONS,
        );
        return {
          items: (res.data.items ?? []) as GoogleEventResource[],
          ...(res.data.nextPageToken ? { nextPageToken: res.data.nextPageToken } : {}),
        };
      }),
    get: (p) =>
      guarded(async () => {
        const res = await events.get(
          { calendarId: p.calendarId, eventId: p.eventId },
          REQUEST_OPTIONS,
        );
        return res.data as GoogleEventResource;
      }),
    insert: (p) =>
      guarded(async () => {
        const res = await events.insert(
          { calendarId: p.calendarId, requestBody: p.resource },
          REQUEST_OPTIONS,
        );
        return res.data as GoogleEventResource;
      }),
    patch: (p) =>
      guarded(async () => {
        const res = await events.patch(
          {
            calendarId: p.calendarId,
            eventId: p.eventId,
            requestBody: p.resource,
          },
          REQUEST_OPTIONS,
        );
        return res.data as GoogleEventResource;
      }),
    update: (p) =>
      guarded(async () => {
        const res = await events.update(
          { calendarId: p.calendarId, eventId: p.eventId, requestBody: p.resource },
          REQUEST_OPTIONS,
        );
        return res.data as GoogleEventResource;
      }),
    delete: (p) =>
      guarded(async () => {
        await events.delete({ calendarId: p.calendarId, eventId: p.eventId }, REQUEST_OPTIONS);
      }),
  };
}

/** Builds the real client from an authorised OAuth2 client (the OAuth flow itself arrives in M2). */
export function createGoogleEventsApi(auth: Auth.OAuth2Client): EventsApi {
  return createEventsApi(google.calendar({ version: 'v3', auth }));
}
