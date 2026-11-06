import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { toUserError, UserError } from '../../util/errors.js';
import { USER_AGENT } from '../../util/version.js';
import { LoginLatch } from '../polito/portal/latch.js';
import { PortalSession, type PortalOptions } from '../polito/portal/login.js';
import type { Source, SourceResult } from '../types.js';
import { courseSchema, MOODLE_SOURCE_ID, mapMoodleEvents } from './map.js';
import { APP_SCHEME, MoodleTokenStore, tokenFromRedirect } from './token.js';

export { MOODLE_SOURCE_ID };

const DAY_S = 86_400;

export interface MoodleStepReport {
  step: 'login' | 'site' | 'courses' | 'events';
  status: 'ok' | 'failed';
  items: number;
  /** Positions and field names only. */
  issues: string[];
  error?: UserError;
}

export interface MoodleSourceOptions {
  username: string;
  password: string;
  /** `https://moodle.polito.it` (MOODLE_BASE_URL). */
  baseUrl: string;
  dataDir: string;
  logger?: Logger;
  now?: () => Date;
  /** How far back and ahead events are kept, in days. Default 366 each way (as the ICS source). */
  pastDays?: number;
  futureDays?: number;
  /** Moodle course ids whose events are left out (their names are still read, for the course list). */
  excludedCourses?: readonly string[];
  /** Test hooks for the login and the web-service calls (fetch, allowed hosts, pauses). */
  portal?: PortalOptions;
}

const unexpected = (what: string): UserError =>
  new UserError({
    code: 'E_POLITO_API_UNEXPECTED_DATA',
    what: `The Moodle data was not understood: ${what}.`,
    why: 'Moodle changed its answer, or the login did not really succeed.',
    action:
      'Nothing was deleted. Run probe/06-moodle-token.mjs and compare with docs/decisions/033-moodle-probe-06-result.md; report the difference (field names only).',
  });

class MoodleRefused extends Error {
  constructor(readonly errorcode: string) {
    super(errorcode);
  }
}

/**
 * Moodle as a live Source: the calendar events of the student's courses through Moodle's mobile web service
 * (decisions 033 to 036). Login = the Moodle app's flow through the university SSO (same account as the portal,
 * so the same lockout latch); the token is kept in DATA_DIR and reused until Moodle refuses it, so a normal run
 * is three small requests, not a login. FAIL CLOSED like the portal source: `complete: true` only if every call
 * answered and every event was understood; anything else deletes nothing for this source. Never throws.
 */
export class MoodleSource implements Source {
  readonly id = MOODLE_SOURCE_ID;
  lastReport: MoodleStepReport[] = [];
  /** `moodle:<course id>` -> course name. */
  courseNames = new Map<string, string>();
  private readonly latch: LoginLatch;
  private readonly tokens: MoodleTokenStore;
  private last = 0;

  constructor(private readonly o: MoodleSourceOptions) {
    this.latch = new LoginLatch(o.dataDir);
    this.tokens = new MoodleTokenStore(o.dataDir);
  }

  private get host(): string {
    return new URL(this.o.baseUrl).hostname;
  }

  private fail(step: MoodleStepReport['step'], error: UserError): SourceResult {
    this.lastReport = [{ step, status: 'failed', items: 0, issues: [], error }];
    this.o.logger?.warn({ code: error.code }, 'moodle source failed; no deletions for it');
    return { source: this.id, complete: false, events: [] };
  }

  private async login(now: Date): Promise<string> {
    this.latch.assertOpen(this.o.username, this.o.password);
    const start = new URL('/admin/tool/mobile/launch.php', this.o.baseUrl);
    start.searchParams.set('service', 'moodle_mobile_app');
    start.searchParams.set('passport', randomBytes(8).toString('hex'));
    start.searchParams.set('urlscheme', APP_SCHEME.replace('://', ''));
    try {
      const session = await PortalSession.login(this.o.username, this.o.password, {
        allowedHosts: [this.host, 'idp.polito.it'],
        ...this.o.portal,
        startUrl: start.href,
        captureScheme: APP_SCHEME,
      });
      const token = session.captured ? tokenFromRedirect(session.captured) : undefined;
      if (!token) throw unexpected('the login did not end with a web-service token');
      this.tokens.write(this.o.username, token, now);
      return token;
    } catch (err) {
      const e = toUserError(err);
      if (e.code === 'E_POLITO_API_AUTH_REJECTED') {
        // One account, one latch: never repeat a refused login until the credentials change (decision 018).
        this.latch.block(this.o.username, this.o.password, now);
      }
      throw e;
    }
  }

  private async ws(
    token: string,
    fn: string,
    params: Record<string, string | number>,
  ): Promise<unknown> {
    const sleep =
      this.o.portal?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const wait = this.last + (this.o.portal?.pauseMs ?? 1000) - Date.now();
    if (this.last > 0 && wait > 0) await sleep(wait);
    const url = new URL('/webservice/rest/server.php', this.o.baseUrl);
    const allowed = this.o.portal?.allowedHosts ?? [this.host];
    if (!allowed.includes(url.hostname))
      throw unexpected('the Moodle address is not an allowed host');
    let res: Response;
    try {
      res = await (this.o.portal?.fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        // The token goes in the body, never in the address.
        body: new URLSearchParams({
          wstoken: token,
          wsfunction: fn,
          moodlewsrestformat: 'json',
          ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
        }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (cause) {
      throw new UserError({
        code: 'E_POLITO_API_FETCH_FAILED',
        what: 'A request to Moodle failed: no connection or a timeout.',
        why: 'Moodle is down or busy, or this machine is offline.',
        action: 'Nothing was deleted. The next scheduled run tries again.',
        cause,
      });
    } finally {
      this.last = Date.now();
    }
    if (res.status === 429 || res.status >= 500) {
      throw new UserError({
        code: 'E_POLITO_API_FETCH_FAILED',
        what: `A request to Moodle failed: the server answered ${res.status}.`,
        why: 'Moodle is down or busy, or we asked too often.',
        action: 'Nothing was deleted. The next scheduled run tries again.',
      });
    }
    let data: unknown;
    try {
      data = JSON.parse(await res.text());
    } catch {
      throw unexpected('an answer that is not JSON');
    }
    if (data && typeof data === 'object' && !Array.isArray(data) && 'exception' in data) {
      const raw = (data as { errorcode?: unknown }).errorcode;
      const code = (typeof raw === 'string' ? raw : 'unknown').replace(/[^\w]/g, '').slice(0, 40);
      throw new MoodleRefused(code);
    }
    return data;
  }

  /** One pass of the three calls with `token`. A refused token surfaces as MoodleRefused('invalidtoken'). */
  private async read(token: string, now: Date): Promise<SourceResult> {
    const reports: MoodleStepReport[] = [];
    const site = (await this.ws(token, 'core_webservice_get_site_info', {})) as {
      userid?: unknown;
    } | null;
    if (!site || typeof site !== 'object' || !Number.isInteger(site.userid)) {
      throw unexpected('the site information has no user id');
    }
    reports.push({ step: 'site', status: 'ok', items: 1, issues: [] });

    const rawCourses = await this.ws(token, 'core_enrol_get_users_courses', {
      userid: site.userid as number,
    });
    if (!Array.isArray(rawCourses)) throw unexpected('the course list is not a list');
    const names = new Map<number, string>();
    const courseIssues: string[] = [];
    rawCourses.forEach((c, i) => {
      const r = courseSchema.safeParse(c);
      if (r.success) names.set(r.data.id, r.data.fullname);
      else courseIssues.push(`course #${i + 1}: unexpected shape`);
    });
    reports.push({ step: 'courses', status: 'ok', items: rawCourses.length, issues: courseIssues });

    const nowS = Math.floor(now.getTime() / 1000);
    const params: Record<string, string | number> = {
      'options[userevents]': 1,
      'options[siteevents]': 1,
      'options[ignorehidden]': 1,
      'options[timestart]': nowS - (this.o.pastDays ?? 366) * DAY_S,
      'options[timeend]': nowS + (this.o.futureDays ?? 366) * DAY_S,
    };
    const asked = [...names.keys()].filter(
      (id) => !(this.o.excludedCourses ?? []).includes(String(id)),
    );
    asked.forEach((id, i) => (params[`events[courseids][${i}]`] = id));
    const answer = (await this.ws(token, 'core_calendar_get_calendar_events', params)) as {
      events?: unknown;
    } | null;
    if (!answer || typeof answer !== 'object' || !Array.isArray(answer.events)) {
      throw unexpected('the event list is missing');
    }
    const excluded = new Set(this.o.excludedCourses ?? []);
    const mapped = mapMoodleEvents(
      answer.events.filter((e) => !excluded.has(String((e as { courseid?: unknown }).courseid))),
      this.o.baseUrl,
      names,
    );
    reports.push({
      step: 'events',
      status: 'ok',
      items: answer.events.length,
      issues: mapped.issues,
    });
    if (mapped.issues.length > 0) {
      const last = reports[reports.length - 1];
      if (last) {
        last.error = unexpected(
          `${mapped.issues.length} event(s) did not have the expected shape (${mapped.issues.slice(0, 3).join('; ')}${mapped.issues.length > 3 ? '; ...' : ''})`,
        );
      }
    }
    this.courseNames = new Map([...names].map(([id, n]) => [`moodle:${id}`, n]));
    this.lastReport = reports;
    return {
      source: this.id,
      complete: reports.every((r) => r.issues.length === 0),
      events: mapped.events,
    };
  }

  async fetch(): Promise<SourceResult> {
    const now = (this.o.now ?? (() => new Date()))();
    try {
      let token = this.tokens.read(this.o.username);
      let fresh = false;
      if (!token) {
        token = await this.login(now);
        fresh = true;
      }
      try {
        return await this.read(token, now);
      } catch (err) {
        if (!(err instanceof MoodleRefused) || err.errorcode !== 'invalidtoken' || fresh) throw err;
        // The saved token was refused (expired or reset): log in once more and try once more.
        this.tokens.clear();
        token = await this.login(now);
        return await this.read(token, now);
      }
    } catch (err) {
      if (err instanceof MoodleRefused) {
        return this.fail(
          'events',
          new UserError({
            code: 'E_MOODLE_API_ERROR',
            what: `Moodle refused a request (${err.errorcode}).`,
            why: 'The web service may be switched off for this account, the token was refused again, or the function is not allowed.',
            action:
              'Nothing was deleted. Run probe/06-moodle-token.mjs to see what Moodle allows; the Moodle calendar feed still works as a fallback.',
          }),
        );
      }
      const e = toUserError(err);
      return this.fail(e.code === 'E_POLITO_LOGIN_BLOCKED' ? 'login' : 'events', e);
    }
  }
}
