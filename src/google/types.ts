/** The slice of the Google Calendar event resource that we read and write. */
export interface GoogleEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleEventResource {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  extendedProperties?: { private?: Record<string, string> };
}

export interface ListParams {
  calendarId: string;
  /** `key=value` filters, ANDed by Google. */
  privateExtendedProperty?: string[];
  pageToken?: string;
  showDeleted?: boolean;
}

/** Thin, mockable mirror of `calendar.events`. The real adapter and the in-memory fake implement it. */
export interface EventsApi {
  list(p: ListParams): Promise<{ items: GoogleEventResource[]; nextPageToken?: string }>;
  get(p: { calendarId: string; eventId: string }): Promise<GoogleEventResource>;
  insert(p: { calendarId: string; resource: GoogleEventResource }): Promise<GoogleEventResource>;
  patch(p: {
    calendarId: string;
    eventId: string;
    resource: GoogleEventResource;
  }): Promise<GoogleEventResource>;
  delete(p: { calendarId: string; eventId: string }): Promise<void>;
}

/** Failure of one Google call, before it is turned into a user-facing error. */
export class GoogleApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  /** Seconds, if Google sent Retry-After. */
  readonly retryAfter: number | undefined;
  /** Network-level failure (no HTTP status). */
  readonly network: boolean;

  constructor(init: {
    status: number;
    reason?: string;
    message?: string;
    retryAfter?: number;
    network?: boolean;
  }) {
    super(
      init.message ?? `Google API error ${init.status}${init.reason ? ` (${init.reason})` : ''}`,
    );
    this.name = 'GoogleApiError';
    this.status = init.status;
    this.reason = init.reason;
    this.retryAfter = init.retryAfter;
    this.network = init.network ?? false;
  }
}
