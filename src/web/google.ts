import { google } from 'googleapis';
import type { Logger } from 'pino';
import { loadConfig, type Config } from '../config/index.js';
import {
  AccountNote,
  CalendarChoice,
  chooseCalendar,
  createCalendarsApi,
  DEFAULT_CALENDAR_NAME,
  DEFAULT_MOODLE_CALENDAR_NAME,
  MOODLE_CALENDAR_FILE,
  type CalendarsApi,
} from '../google/calendars.js';
import {
  authorizedClient,
  clientCredentials,
  loopbackAuthorize,
  TokenStore,
  type OAuthFlowClient,
} from '../google/oauth.js';
import type { AuditLog } from '../settings/audit.js';
import type { SettingsStore } from '../settings/store.js';
import { toUserError, UserError } from '../util/errors.js';
import { problem, type ProblemView } from './preview.js';

/** Things tests replace (a fake Google sign-in and a fake calendar list). Production leaves them out. */
export interface GoogleDeps {
  flowClient?: OAuthFlowClient;
  calendars?: CalendarsApi;
}

export interface GoogleOptions {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  settings: SettingsStore;
  audit: AuditLog;
  logger: Logger;
  deps?: GoogleDeps;
  /** How long the sign-in waits for the browser to come back. */
  connectTimeoutMs?: number;
  /** Called when the sign-in state changed (the live updates). */
  onChange?: () => void;
}

export interface ConnectView {
  state: 'idle' | 'waiting' | 'done' | 'failed';
  /** While waiting: the Google page to open, and the local port Google sends the browser back to. */
  authUrl?: string;
  redirectPort?: number;
  error?: ProblemView;
}

export interface GoogleView {
  clientConfigured: boolean;
  /** A saved Google login exists (it may still have expired: a sync would say so). */
  connected: boolean;
  /** The signed-in account (the address of its main calendar), when known. */
  account?: string;
  /** The dedicated calendar, when one is chosen. `name` is missing when it is set by an environment variable. */
  calendar?: { name?: string };
  /** GOOGLE_CALENDAR_ID is set in the environment: the page cannot change the calendar. */
  calendarLocked: boolean;
  /** Moodle events go to a calendar of their own (the setting is on). */
  splitMoodle: boolean;
  /** The Moodle calendar, when one is chosen. */
  moodleCalendar?: { name?: string };
  moodleCalendarLocked: boolean;
  /** The saved login file is damaged. */
  problem?: ProblemView;
  connect: ConnectView;
}

export interface CalendarOption {
  id: string;
  name: string;
  /** The calendar currently in use. */
  current: boolean;
}

export type CalendarSlot = 'polito' | 'moodle';
export type CalendarPick = ({ id: string } | { create: { name?: string | undefined } }) & {
  slot?: CalendarSlot | undefined;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 5 * 60_000;

/**
 * Connecting Google from the UI: the same loopback + PKCE flow as `auth google` (decision 011), run in the
 * background of the server, plus the dedicated-calendar picker. The primary calendar is never offered and
 * never accepted (assertDedicatedCalendar). Nothing here prints or returns a token.
 */
export class GoogleService {
  private connect: ConnectView = { state: 'idle' };
  private abort: AbortController | undefined;

  constructor(private readonly o: GoogleOptions) {}

  private config(): Config {
    return loadConfig({ ...this.o.env, DATA_DIR: this.o.dataDir }, this.o.settings.read());
  }

  private get log(): Logger {
    return this.o.logger;
  }

  status(): GoogleView {
    const config = this.config();
    const choice = new CalendarChoice(this.o.dataDir);
    let connected = false;
    let bad: ProblemView | undefined;
    try {
      connected = new TokenStore(this.o.dataDir).read() !== undefined;
    } catch (err) {
      bad = problem(toUserError(err));
    }
    const account = new AccountNote(this.o.dataDir).read();
    const calendarLocked = this.o.env['GOOGLE_CALENDAR_ID'] !== undefined;
    const effective = config.google.calendarId ?? choice.read();
    const summary = config.google.calendarId ? undefined : choice.readSummary();
    const moodleChoice = new CalendarChoice(this.o.dataDir, MOODLE_CALENDAR_FILE);
    const moodleEffective = config.google.moodleCalendarId ?? moodleChoice.read();
    const moodleSummary = config.google.moodleCalendarId ? undefined : moodleChoice.readSummary();
    return {
      clientConfigured: Boolean(config.google.clientId && config.google.clientSecret),
      connected,
      ...(account && connected ? { account } : {}),
      ...(effective ? { calendar: summary ? { name: summary } : {} } : {}),
      calendarLocked: calendarLocked && (this.o.env['GOOGLE_CALENDAR_ID'] ?? '') !== '',
      splitMoodle: config.calendars.splitMoodle,
      ...(moodleEffective ? { moodleCalendar: moodleSummary ? { name: moodleSummary } : {} } : {}),
      moodleCalendarLocked: (this.o.env['GOOGLE_MOODLE_CALENDAR_ID'] ?? '') !== '',
      ...(bad ? { problem: bad } : {}),
      connect: this.connect,
    };
  }

  /** Starts the sign-in (or returns the one already waiting) and answers with the Google page to open. */
  async startConnect(): Promise<ConnectView> {
    if (this.connect.state === 'waiting') return this.connect;
    const config = this.config();
    const creds = clientCredentials(config.google);
    const flow =
      this.o.deps?.flowClient ?? new google.auth.OAuth2(creds.clientId, creds.clientSecret);
    const abort = new AbortController();
    this.abort = abort;
    this.connect = { state: 'idle' };
    this.o.audit.append('google.connect.started');

    return new Promise<ConnectView>((resolve, reject) => {
      let announced = false;
      void loopbackAuthorize(flow, {
        bind: config.google.authBind,
        port: config.google.authPort,
        timeoutMs: this.o.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        signal: abort.signal,
        returnTo: 'the program',
        announce: (authUrl, redirectUri) => {
          announced = true;
          this.connect = {
            state: 'waiting',
            authUrl,
            redirectPort: Number(new URL(redirectUri).port),
          };
          resolve(this.connect);
          this.o.onChange?.();
        },
      })
        .then(async ({ tokens }) => {
          new TokenStore(this.o.dataDir).write(tokens);
          this.log.info('google login saved from the ui');
          await this.rememberAccount(creds);
          this.connect = { state: 'done' };
          this.o.audit.append('google.connected');
          this.o.onChange?.();
        })
        .catch((err: unknown) => {
          const e = toUserError(err);
          this.connect = { state: 'failed', error: problem(e) };
          this.o.audit.append('google.connect.failed', { code: e.code });
          this.log.warn({ code: e.code }, 'google sign-in from the ui did not finish');
          this.o.onChange?.();
          if (!announced) reject(e);
        })
        .finally(() => {
          if (this.abort === abort) this.abort = undefined;
        });
    });
  }

  cancelConnect(): ConnectView {
    this.abort?.abort();
    return this.connect;
  }

  /** Reads which account signed in; a different account than before drops the old calendar choice. */
  private async rememberAccount(creds: { clientId: string; clientSecret: string }): Promise<void> {
    const admin = this.calendarsApi(creds);
    const primary = (await admin.list()).find((c) => c.primary);
    if (!primary) return;
    const note = new AccountNote(this.o.dataDir);
    const before = note.read();
    if (before !== undefined && before !== primary.id) {
      // The saved calendar belongs to the other account: it must not stay selected.
      new CalendarChoice(this.o.dataDir).clear();
      new CalendarChoice(this.o.dataDir, MOODLE_CALENDAR_FILE).clear();
      this.log.info('google account changed; the calendar choice was cleared');
    }
    note.write(primary.id);
  }

  private calendarsApi(creds?: { clientId: string; clientSecret: string }): CalendarsApi {
    if (this.o.deps?.calendars) return this.o.deps.calendars;
    const c = creds ?? clientCredentials(this.config().google);
    return createCalendarsApi(authorizedClient(c, new TokenStore(this.o.dataDir)));
  }

  /** The calendars the owner may choose: not the main calendar, and only ones they can edit. */
  async listCalendars(
    slot: CalendarSlot = 'polito',
  ): Promise<{ calendars: CalendarOption[]; hidden: number }> {
    const config = this.config();
    const current =
      slot === 'moodle'
        ? (config.google.moodleCalendarId ??
          new CalendarChoice(this.o.dataDir, MOODLE_CALENDAR_FILE).read())
        : (config.google.calendarId ?? new CalendarChoice(this.o.dataDir).read());
    const all = await this.calendarsApi().list();
    const usable = all.filter(
      (c) => !c.primary && c.id !== 'primary' && ['owner', 'writer'].includes(c.accessRole),
    );
    return {
      calendars: usable.slice(0, 100).map((c) => ({
        id: c.id,
        name: c.summary,
        current: c.id === current,
      })),
      hidden: all.length - usable.length,
    };
  }

  /** Picks an existing calendar, or creates (or reuses by name) the dedicated one, and remembers it. */
  async chooseCalendar(pick: CalendarPick): Promise<GoogleView> {
    const slot: CalendarSlot = pick.slot ?? 'polito';
    const envName = slot === 'moodle' ? 'GOOGLE_MOODLE_CALENDAR_ID' : 'GOOGLE_CALENDAR_ID';
    const raw = this.o.env[envName];
    if (raw !== undefined && raw !== '') {
      throw new UserError({
        code: 'E_SETTING_LOCKED',
        what: `The calendar is set by the environment variable ${envName}, so it was not changed here.`,
        why: 'A variable set in the environment (.env or Docker) always wins over this page.',
        action: `Remove ${envName} from the environment and restart, then choose here.`,
      });
    }
    const config = this.config();
    const file = slot === 'moodle' ? MOODLE_CALENDAR_FILE : 'google-calendar.json';
    const settingKey = slot === 'moodle' ? 'google.moodleCalendarId' : 'google.calendarId';
    const chosen = await chooseCalendar(this.calendarsApi(), {
      tz: config.tz,
      ...('id' in pick ? { pickId: pick.id } : {}),
      ...('create' in pick
        ? {
            name:
              pick.create.name ??
              (slot === 'moodle' ? DEFAULT_MOODLE_CALENDAR_NAME : DEFAULT_CALENDAR_NAME),
          }
        : {}),
    });
    // The two calendars must differ, or the split would mix them again.
    const other =
      slot === 'moodle'
        ? (config.google.calendarId ?? new CalendarChoice(this.o.dataDir).read())
        : (config.google.moodleCalendarId ??
          new CalendarChoice(this.o.dataDir, MOODLE_CALENDAR_FILE).read());
    if (other !== undefined && other === chosen.id) {
      throw new UserError({
        code: 'E_GOOGLE_CALENDARS_SAME',
        what: 'The Polito calendar and the Moodle calendar would be the same calendar, so nothing was changed.',
        why: 'Keeping Moodle events apart needs two different calendars.',
        action: 'Choose another calendar, or create a new one.',
      });
    }
    new CalendarChoice(this.o.dataDir, file).write(chosen.id, chosen.summary);
    // A calendar id saved as a setting would win over this choice.
    if (this.o.settings.read()[settingKey] !== undefined) {
      this.o.settings.apply({ clear: [settingKey] }, this.o.env);
    }
    this.o.audit.append('google.calendar', { action: chosen.action, slot });
    this.log.info({ action: chosen.action }, 'ui chose the dedicated calendar');
    this.o.onChange?.();
    return this.status();
  }
}
