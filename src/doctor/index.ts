import { statSync } from 'node:fs';
import type { Logger } from 'pino';
import { ensureDataDir, type Config } from '../config/index.js';
import {
  assertDedicatedCalendar,
  CalendarChoice,
  createCalendarsApi,
  type CalendarsApi,
} from '../google/calendars.js';
import { authorizedClient, clientCredentials, TokenStore } from '../google/oauth.js';
import { evaluateHealth, HeartbeatStore } from '../serve/heartbeat.js';
import { IcsSource } from '../sources/ics/index.js';
import { NoCache } from '../sources/ics/fetch.js';
import { MoodleSource } from '../sources/moodle/index.js';
import { PolitoPortalSource } from '../sources/polito/index.js';
import { LoginLatch } from '../sources/polito/portal/latch.js';
import { StateStore } from '../sync/state.js';
import type { RuntimeDeps } from '../sync/run.js';
import { toUserError, UserError } from '../util/errors.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  /** Short plain detail (counts, names we may show). Never a secret, an address or event text. */
  detail?: string;
  error?: UserError;
}

export interface DoctorOptions {
  config: Config;
  logger: Logger;
  /** Skip every check that contacts another server (Google, feeds, the university). */
  local?: boolean;
  deps?: RuntimeDeps & { calendars?: CalendarsApi };
}

const ok = (id: string, label: string, detail?: string): Check => ({
  id,
  label,
  status: 'ok',
  ...(detail ? { detail } : {}),
});
const fail = (id: string, label: string, err: unknown, status: CheckStatus = 'fail'): Check => ({
  id,
  label,
  status,
  error: toUserError(err),
});
const skipped = (id: string, label: string, detail: string): Check => ({
  id,
  label,
  status: 'skipped',
  detail,
});

/**
 * The checks of AGENTS.md: data folder writable, clock and time zone, state database, Google login and the
 * dedicated calendar, every enabled source reachable and logged in, the last sync. It only READS (a feed is one
 * unconditional GET without cache; the Polito check is one login and one data read, never repeated after a refusal:
 * the lockout latch applies), and prints counts and codes, never addresses or event text.
 */
export async function runDoctor(o: DoctorOptions): Promise<Check[]> {
  const { config, deps = {} } = o;
  const checks: Check[] = [];
  const net = !o.local;

  // 1. data folder
  try {
    ensureDataDir(config.dataDir);
    const mode = statSync(config.dataDir).mode & 0o777;
    checks.push(
      mode & 0o077
        ? {
            id: 'data-dir',
            label: 'Data folder',
            status: 'warn',
            detail: `writable, but other users can open it (mode ${mode.toString(8)}); it holds your logins`,
          }
        : ok('data-dir', 'Data folder', 'writable, private'),
    );
  } catch (err) {
    checks.push(fail('data-dir', 'Data folder', err));
    return checks; // nothing else can work
  }

  // 2. clock and time zone
  const now = (deps.now ?? (() => new Date()))();
  const year = now.getUTCFullYear();
  checks.push(
    year < 2024 || year > 2100
      ? fail(
          'clock',
          'Clock and time zone',
          new UserError({
            code: 'E_CONFIG_INVALID',
            what: `The clock of this machine says ${now.toISOString().slice(0, 10)}, which cannot be right.`,
            why: 'A wrong clock makes every event land at the wrong time and Google refuse logins.',
            action: 'Set the system clock (or the container host clock) and run doctor again.',
          }),
        )
      : ok(
          'clock',
          'Clock and time zone',
          `${config.tz}, now ${new Intl.DateTimeFormat('en-GB', { timeZone: config.tz, dateStyle: 'medium', timeStyle: 'short' }).format(now)}`,
        ),
  );

  // 3. state database
  try {
    StateStore.probe(StateStore.fileIn(config.dataDir));
    checks.push(ok('state', 'Sync history database'));
  } catch (err) {
    checks.push(fail('state', 'Sync history database', err));
  }

  // 4. Google
  checks.push(await googleCheck(o, net));

  // 5. sources
  if (config.icsUrls.length === 0 && !config.polito.enabled) {
    checks.push({
      id: 'sources',
      label: 'Sources',
      status: 'warn',
      error: new UserError({
        code: 'E_NOT_CONFIGURED',
        what: 'No source is switched on.',
        why: 'There is no calendar feed and the Polito portal is off.',
        action: 'Add a feed or switch on the portal on the Sources page (or in .env).',
      }),
    });
  }
  for (const [i, url] of config.icsUrls.entries()) {
    const id = `feed-${i + 1}`;
    if (!net) {
      checks.push(skipped(id, `Calendar feed #${i + 1}`, 'not contacted (--local)'));
      continue;
    }
    if (i > 0) await (deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(1000);
    const source = new IcsSource({
      urls: [url],
      firstFeedNumber: i + 1,
      dataDir: config.dataDir,
      cache: new NoCache(),
      tz: config.tz,
      moodleHost: config.moodleHost,
      logger: o.logger,
      fetchOptions: {
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        attempts: 1,
      },
      ...(deps.now ? { now: deps.now } : {}),
    });
    const result = await source.fetch();
    const r = source.lastReport[0];
    const label = r?.label ?? `Calendar feed #${i + 1}`;
    checks.push(
      r?.error
        ? {
            ...fail(id, label, r.error, result.complete ? 'warn' : 'fail'),
            ...(r.events ? { detail: `${r.events} event(s) could be read` } : {}),
          }
        : ok(id, label, `${r?.events ?? 0} event(s), ${r?.cancelled ?? 0} cancelled left out`),
    );
  }
  if (config.polito.enabled) checks.push(await politoCheck(o, net));
  if (config.moodle.enabled) checks.push(await moodleCheck(o, net));

  // 6. last sync
  checks.push(lastSyncCheck(config, deps.now));
  return checks;
}

async function googleCheck(o: DoctorOptions, net: boolean): Promise<Check> {
  const { config, deps = {} } = o;
  const label = 'Google login and calendar';
  try {
    const creds = clientCredentials(config.google);
    const store = new TokenStore(config.dataDir);
    if (!store.read()) {
      return fail(
        'google',
        label,
        new UserError({
          code: 'E_NOT_CONFIGURED',
          what: 'Google is not connected yet.',
          why: 'There is no saved Google login in the data folder.',
          action: 'Press "Connect Google" under Settings in the web page, or run "auth google".',
        }),
      );
    }
    const calendarId = config.google.calendarId ?? new CalendarChoice(config.dataDir).read();
    if (!calendarId) {
      return fail(
        'google',
        label,
        new UserError({
          code: 'E_NOT_CONFIGURED',
          what: 'No dedicated Google calendar has been chosen yet.',
          why: 'The login exists but no calendar was created or picked.',
          action: 'Create or pick the calendar under Settings, or run "auth google".',
        }),
      );
    }
    if (!net) return skipped('google', label, 'login and calendar saved; not contacted (--local)');
    const admin = deps.calendars ?? createCalendarsApi(authorizedClient(creds, store));
    const entry = await assertDedicatedCalendar(admin, calendarId);
    return ok(
      'google',
      label,
      `signed in; the dedicated calendar "${entry.summary}" is reachable and writable`,
    );
  } catch (err) {
    return fail('google', label, err);
  }
}

async function politoCheck(o: DoctorOptions, net: boolean): Promise<Check> {
  const { config, deps = {} } = o;
  const label = 'Polito portal';
  const { username, password } = config.polito;
  if (!username || !password) {
    return fail(
      'polito',
      label,
      new UserError({
        code: 'E_NOT_CONFIGURED',
        what: 'The Polito portal is switched on, but the login is not set.',
        why: 'The username and/or password is empty.',
        action: 'Enter them under Sources (or in .env).',
      }),
    );
  }
  try {
    new LoginLatch(config.dataDir).assertOpen(username, password);
  } catch (err) {
    return fail('polito', label, err); // paused: no request is made
  }
  if (!net) return skipped('polito', label, 'login saved; not contacted (--local)');
  const source = new PolitoPortalSource({
    username,
    password,
    tz: config.tz,
    dataDir: config.dataDir,
    examCalls: config.polito.examCalls,
    squads: new Map(Object.entries(config.polito.squads).map(([id, v]) => [id, new Set(v)])),
    logger: o.logger,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.politoPortal ? { portal: deps.politoPortal } : {}),
  });
  const result = await source.fetch();
  const err = source.lastReport.find((r) => r.error)?.error;
  if (err) return fail('polito', label, err, result.complete ? 'warn' : 'fail');
  return ok(
    'polito',
    label,
    `logged in, ${source.courseNames.size} course(s), every part understood`,
  );
}

async function moodleCheck(o: DoctorOptions, net: boolean): Promise<Check> {
  const { config, deps = {} } = o;
  const label = 'Moodle (live)';
  const { username, password } = config.polito;
  if (!username || !password) {
    return fail(
      'moodle',
      label,
      new UserError({
        code: 'E_NOT_CONFIGURED',
        what: 'The live Moodle source is switched on, but the university login is not set.',
        why: 'Moodle uses the same username and password as the Polito portal.',
        action: 'Enter them under Sources (Polito portal card).',
      }),
    );
  }
  try {
    new LoginLatch(config.dataDir).assertOpen(username, password);
  } catch (err) {
    return fail('moodle', label, err);
  }
  if (!net) return skipped('moodle', label, 'login saved; not contacted (--local)');
  const source = new MoodleSource({
    username,
    password,
    baseUrl: config.moodleBaseUrl,
    dataDir: config.dataDir,
    logger: o.logger,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.politoPortal ? { portal: deps.politoPortal } : {}),
  });
  const result = await source.fetch();
  const err = source.lastReport.find((r) => r.error)?.error;
  if (err) return fail('moodle', label, err, result.complete ? 'warn' : 'fail');
  return ok(
    'moodle',
    label,
    `${result.events.length} event(s) in ${source.courseNames.size} course(s)`,
  );
}

function lastSyncCheck(config: Config, now?: () => Date): Check {
  const label = 'Last sync';
  try {
    const [last] = StateStore.recent(StateStore.fileIn(config.dataDir), 1);
    const hb = new HeartbeatStore(config.dataDir).read();
    const health = evaluateHealth(hb, (now ?? (() => new Date()))());
    if (!last) {
      return {
        id: 'last-sync',
        label,
        status: 'warn',
        detail: 'no sync has written anything yet (a preview or dry run is not a sync)',
      };
    }
    const detail = `${last.status} at ${last.startedAt}: ${last.created} added, ${last.patched} changed, ${last.deleted} removed`;
    if (last.status === 'failed' || last.status === 'refused') {
      return {
        ...fail(
          'last-sync',
          label,
          new UserError({
            code: (last.errorCode as UserError['code'] | null) ?? 'E_INTERNAL',
            what: `The last sync ended as "${last.status}".`,
            why: 'See the code; docs/ERRORS.md explains it.',
            action: 'Fix the cause, then run a preview and sync again.',
          }),
          'warn',
        ),
        detail,
      };
    }
    if (!health.healthy) {
      return {
        id: 'last-sync',
        label,
        status: 'warn',
        detail: `${detail}. The scheduled loop: ${health.reason ?? 'unhealthy'}`,
      };
    }
    return ok('last-sync', label, detail);
  } catch (err) {
    return fail('last-sync', label, err, 'warn');
  }
}

const MARK: Record<CheckStatus, string> = {
  ok: '[ok]  ',
  warn: '[warn]',
  fail: '[FAIL]',
  skipped: '[skip]',
};

/** Plain text for the terminal; three-line form for every problem; never a stack trace. */
export function formatChecks(checks: readonly Check[]): string {
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${MARK[c.status]} ${c.label}${c.detail ? `: ${c.detail}` : ''}`);
    if (c.error) {
      lines.push(
        `         ${c.error.code}: ${c.error.what}`,
        `         Why:  ${c.error.why}`,
        `         Do:   ${c.error.action}`,
        `         Docs: ${c.error.docsAnchor}`,
      );
    }
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  lines.push(
    '',
    failed
      ? `${failed} problem(s) to fix${warned ? `, ${warned} warning(s)` : ''}.`
      : warned
        ? `Nothing is broken; ${warned} warning(s).`
        : 'Everything checked is fine.',
  );
  return lines.join('\n');
}
