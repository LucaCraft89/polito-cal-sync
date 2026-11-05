import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { loadConfig } from '../config/index.js';
import type { SettingsStore } from '../settings/store.js';
import { IcsSource } from '../sources/ics/index.js';
import { NoCache } from '../sources/ics/fetch.js';
import { PolitoPortalSource } from '../sources/polito/index.js';
import { LoginLatch } from '../sources/polito/portal/latch.js';
import type { RuntimeDeps } from '../sync/run.js';
import { toUserError, UserError } from '../util/errors.js';
import { RateGate } from './gate.js';
import { problem, type ProblemView } from './preview.js';

/** A feed test is one GET of a course or Moodle feed: once per feed per 15 minutes, 10 tests per 15 minutes in all. */
export const FEED_TEST_MIN_INTERVAL_MS = 15 * 60_000;
export const FEED_TEST_MAX_PER_WINDOW = 10;
/** A login test is a full portal login (13 requests): once per set of credentials per 15 minutes. */
export const LOGIN_TEST_MIN_INTERVAL_MS = 15 * 60_000;

export interface FeedTestView {
  /** "feed #2 (host)": never the address, which can hold a secret token. */
  label: string;
  ok: boolean;
  /** Events found in the window (kept for 366 days either side), cancelled ones left out. */
  events: number;
  cancelled: number;
  /** Events the program could not handle. */
  issues: number;
  problem?: ProblemView;
  nextAllowedAt: string;
}

export interface LoginTestView {
  /** The login worked and every part of the answer was understood. */
  ok: boolean;
  courses: number;
  /** Counts only; no titles, rooms or names. */
  sections: { section: string; items: number; events: number; issues: number }[];
  problem?: ProblemView;
  nextAllowedAt: string | null;
}

export interface ChecksOptions {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  settings: SettingsStore;
  logger: Logger;
  deps?: RuntimeDeps;
  now: () => number;
}

const fingerprint = (...parts: string[]): string =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);

/**
 * The "Test" buttons of the Sources page (decision 028). A feed test is ONE unconditional GET with a single
 * attempt that leaves no cache behind. A login test is the portal source's own login and data read, so the
 * lockout latch of decision 018 applies exactly as in a sync: a refused login is written to the latch and is
 * never repeated until the credentials change. Both are single flight and rate limited; a refused request
 * costs no traffic.
 */
export class SourceChecks {
  private feedBusy = false;
  private loginBusy = false;
  private readonly feeds: RateGate;
  private readonly logins: RateGate;

  constructor(private readonly o: ChecksOptions) {
    this.feeds = new RateGate({
      minIntervalMs: FEED_TEST_MIN_INTERVAL_MS,
      now: o.now,
      globalMax: FEED_TEST_MAX_PER_WINDOW,
    });
    this.logins = new RateGate({ minIntervalMs: LOGIN_TEST_MIN_INTERVAL_MS, now: o.now });
  }

  private config() {
    return loadConfig({ ...this.o.env, DATA_DIR: this.o.dataDir }, this.o.settings.read());
  }

  private busy(what: string): UserError {
    return new UserError({
      code: 'E_UI_TEST_BUSY',
      what: `A ${what} test is already running.`,
      why: 'Only one runs at a time, so the other side is not asked twice at once.',
      action: 'Wait for it to finish; the result appears on this page.',
    });
  }

  private limited(waitMs: number, what: string): UserError {
    const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
    return new UserError({
      code: 'E_UI_TEST_RATE_LIMITED',
      what: `This ${what} was tested a moment ago, so no new test was started.`,
      why: 'Every test contacts the other server. Limiting how often protects your account and the server. The limit counts from the start of the last test, also when it failed.',
      action: `Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}. Changing the address (or, for the login, the username or password) lifts it.`,
    });
  }

  async testFeed(index: number): Promise<FeedTestView> {
    const config = this.config();
    const url = config.icsUrls[index];
    if (url === undefined) {
      throw new UserError({
        code: 'E_SETTING_INVALID',
        what: `Feed ${index + 1} does not exist.`,
        why: 'The list changed since this page was loaded.',
        action: 'Reload the page and try again.',
      });
    }
    if (this.feedBusy) throw this.busy('feed');
    const key = fingerprint('feed', url);
    const wait = this.feeds.waitMs(key);
    if (wait > 0) throw this.limited(wait, 'feed');
    this.feedBusy = true;
    this.feeds.start(key);
    try {
      const deps = this.o.deps ?? {};
      const source = new IcsSource({
        urls: [url],
        firstFeedNumber: index + 1,
        dataDir: config.dataDir,
        cache: new NoCache(),
        tz: config.tz,
        moodleHost: config.moodleHost,
        logger: this.o.logger,
        fetchOptions: {
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          attempts: 1,
        },
        ...(deps.now ? { now: deps.now } : {}),
      });
      const result = await source.fetch();
      const r = source.lastReport[0];
      this.o.logger.info({ ok: result.complete }, 'ui feed test done');
      const next = new Date(this.o.now() + FEED_TEST_MIN_INTERVAL_MS).toISOString();
      if (!r) throw new Error('the feed produced no report');
      return {
        label: r.label,
        ok: result.complete,
        events: r.events,
        cancelled: r.cancelled,
        issues: r.issues.length,
        ...(r.error ? { problem: problem(r.error) } : {}),
        nextAllowedAt: next,
      };
    } finally {
      this.feedBusy = false;
    }
  }

  async testLogin(): Promise<LoginTestView> {
    const config = this.config();
    const { username, password } = config.polito;
    if (!username || !password) {
      throw new UserError({
        code: 'E_NOT_CONFIGURED',
        what: 'The Polito login is not saved yet, so there is nothing to test.',
        why: 'The username and/or password is empty.',
        action: 'Enter both, press Save, then test. Typed but unsaved values are never used.',
      });
    }
    if (this.loginBusy) throw this.busy('login');
    // A refused login stays refused until the credentials change (decision 018): no traffic, no counting.
    try {
      new LoginLatch(config.dataDir).assertOpen(username, password);
    } catch (err) {
      return {
        ok: false,
        courses: 0,
        sections: [],
        problem: problem(toUserError(err)),
        nextAllowedAt: null,
      };
    }
    const key = fingerprint('login', username, password);
    const wait = this.logins.waitMs(key);
    if (wait > 0) throw this.limited(wait, 'login');
    this.loginBusy = true;
    this.logins.start(key);
    try {
      const deps = this.o.deps ?? {};
      const source = new PolitoPortalSource({
        username,
        password,
        tz: config.tz,
        dataDir: config.dataDir,
        examCalls: config.polito.examCalls,
        squads: new Map(Object.entries(config.polito.squads).map(([id, v]) => [id, new Set(v)])),
        logger: this.o.logger,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.politoPortal ? { portal: deps.politoPortal } : {}),
      });
      const result = await source.fetch();
      const firstError = source.lastReport.find((r) => r.error)?.error;
      this.o.logger.info({ ok: result.complete }, 'ui login test done');
      return {
        ok: result.complete,
        courses: source.courseNames.size,
        sections: source.lastReport
          .filter((r) => r.section !== 'login')
          .map((r) => ({
            section: r.section,
            items: r.items,
            events: r.events,
            issues: r.issues.length,
          })),
        ...(firstError ? { problem: problem(firstError) } : {}),
        nextAllowedAt: new Date(this.o.now() + LOGIN_TEST_MIN_INTERVAL_MS).toISOString(),
      };
    } finally {
      this.loginBusy = false;
    }
  }
}
