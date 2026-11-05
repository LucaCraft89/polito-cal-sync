import { toUserError, UserError } from '../../util/errors.js';
import type { Logger } from 'pino';
import type { CanonicalEvent, Source, SourceResult } from '../types.js';
import { toCanonical } from '../../sync/mapper.js';
import { eventsFromIcs } from './events.js';
import { feedLabel, fetchFeed, FeedCache, type FetchOptions } from './fetch.js';
import { IcsParseError } from './parse.js';

export const ICS_SOURCE_ID = 'ics';

export interface FeedReport {
  label: string;
  status: 'ok' | 'not-modified' | 'failed';
  events: number;
  cancelled: number;
  /** Parts of the feed that could not be handled (positions and reasons, no event text). */
  issues: string[];
  error?: UserError;
}

export interface IcsSourceOptions {
  urls: readonly string[];
  dataDir: string;
  /** Zone for floating times; the configured TZ. */
  tz: string;
  /** How far back and ahead occurrences are kept. Default 366 days each way. */
  pastDays?: number;
  futureDays?: number;
  /** Events from a feed on this host are Moodle events: kind `moodle` and a visible "[Moodle] " title prefix. */
  moodleHost?: string;
  fetchOptions?: FetchOptions;
  now?: () => Date;
  logger?: Logger;
  /** Pause between two feeds, to stay gentle with the server. Default 1000 ms. */
  pauseBetweenFeedsMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DAY_MS = 86_400_000;

const MOODLE_PREFIX = '[Moodle] ';

function hostOf(url: string): string | undefined {
  return URL.canParse(url) ? new URL(url).hostname : undefined;
}

/** Same event, labelled as coming from Moodle (the label is part of the title, so it is in the hash). */
function asMoodle(e: CanonicalEvent): CanonicalEvent {
  // toCanonical ignores the old hash and computes a new one for the labelled content.
  return toCanonical({
    ...e,
    kind: 'moodle',
    title: e.title.startsWith(MOODLE_PREFIX) ? e.title : `${MOODLE_PREFIX}${e.title}`.slice(0, 300),
  });
}

/** Codes whose usual cure, for a Moodle feed, is to generate the export URL again (decision 022). */
const MOODLE_REGENERATE_CODES = new Set(['E_ICS_FEED_REJECTED', 'E_ICS_FEED_INVALID']);

/**
 * Adds the Moodle-specific cure to a refused or unreadable feed. The menu names are those of stock Moodle
 * (UNVERIFIED for moodle.polito.it: what Moodle really answers to a stale token has not been observed),
 * so the sentence says "usually" and gives the Italian label too.
 */
function withMoodleHint(err: UserError): UserError {
  if (!MOODLE_REGENERATE_CODES.has(err.code)) return err;
  return new UserError({
    code: err.code,
    what: err.what,
    why: `${err.why} For a Moodle feed this usually means the export link was regenerated or its token expired.`,
    action: `In Moodle open the Calendar, choose "Import or export calendars" ("Importa o esporta calendari"), export again and copy the new URL into SOURCE_POLITO_ICS_URLS. ${err.action}`,
    cause: err,
  });
}

/**
 * Reads the configured calendar feeds one by one. The result is `complete` ONLY if every feed
 * was downloaded (or confirmed unchanged) and every event in it was understood; otherwise the
 * engine deletes nothing for this source.
 */
export class IcsSource implements Source {
  readonly id = ICS_SOURCE_ID;
  /** What happened to each feed in the last `fetch()`, for the CLI output and logs. */
  lastReport: FeedReport[] = [];

  constructor(private readonly o: IcsSourceOptions) {}

  async fetch(): Promise<SourceResult> {
    const now = (this.o.now ?? (() => new Date()))();
    const windowStart = new Date(now.getTime() - (this.o.pastDays ?? 366) * DAY_MS);
    const windowEnd = new Date(now.getTime() + (this.o.futureDays ?? 366) * DAY_MS);
    const cache = new FeedCache(this.o.dataDir);
    const reports: FeedReport[] = [];
    const events = new Map<string, CanonicalEvent>();
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    for (const [i, url] of this.o.urls.entries()) {
      if (i > 0) await sleep(this.o.pauseBetweenFeedsMs ?? 1000);
      const label = feedLabel(i, url);
      const isMoodle = this.o.moodleHost !== undefined && hostOf(url) === this.o.moodleHost;
      try {
        const feed = await fetchFeed(url, label, cache, this.o.fetchOptions);
        let parsed;
        try {
          parsed = eventsFromIcs(feed.text, {
            defaultTz: this.o.tz,
            windowStart,
            windowEnd,
          });
        } catch (err) {
          if (!(err instanceof IcsParseError)) throw err;
          throw new UserError({
            code: 'E_ICS_FEED_INVALID',
            what: `${label}: the answer is not a readable calendar file (${err.message}).`,
            why: 'The URL may point to a web page (for example a login page) instead of a calendar feed, or the file is damaged.',
            action:
              'Open the URL in a private browser window: it should download a .ics file. If it asks you to log in, copy the feed URL again. Nothing was deleted because of this.',
          });
        }
        feed.commit();
        if (isMoodle) parsed.events = parsed.events.map(asMoodle);
        for (const e of parsed.events) if (!events.has(e.sourceId)) events.set(e.sourceId, e);
        const report: FeedReport = {
          label,
          status: feed.fromCache ? 'not-modified' : 'ok',
          events: parsed.events.length,
          cancelled: parsed.cancelled,
          issues: parsed.issues,
        };
        if (parsed.issues.length > 0) {
          report.error = new UserError({
            code: 'E_ICS_FEED_UNSUPPORTED',
            what: `${label}: ${parsed.issues.length} event(s) in the feed could not be handled.`,
            why: `Details: ${parsed.issues.slice(0, 3).join('; ')}${parsed.issues.length > 3 ? '; ...' : ''}.`,
            action:
              'The other events are synced. Nothing is deleted from this source until the problem is gone. Report it in an issue (without event text).',
          });
        }
        reports.push(report);
      } catch (err) {
        reports.push({
          label,
          status: 'failed',
          events: 0,
          cancelled: 0,
          issues: [],
          error: isMoodle ? withMoodleHint(toUserError(err)) : toUserError(err),
        });
      }
    }

    this.lastReport = reports;
    for (const r of reports) {
      this.o.logger?.info(
        {
          feed: r.label,
          status: r.status,
          events: r.events,
          cancelled: r.cancelled,
          issues: r.issues.length,
          ...(r.error ? { code: r.error.code } : {}),
        },
        'ics feed read',
      );
    }
    const complete =
      this.o.urls.length > 0 &&
      reports.every((r) => r.status !== 'failed' && r.issues.length === 0);
    return { source: this.id, complete, events: [...events.values()] };
  }
}
