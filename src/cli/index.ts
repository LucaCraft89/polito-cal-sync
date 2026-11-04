import { parseArgs } from 'node:util';
import { google } from 'googleapis';
import { ensureDataDir, loadConfig } from '../config/index.js';
import { createGoogleEventsApi } from '../google/adapter.js';
import { OwnedCalendar } from '../google/calendar.js';
import {
  CalendarChoice,
  chooseCalendar,
  createCalendarsApi,
  type CalendarsApi,
} from '../google/calendars.js';
import {
  authorizedClient,
  clientCredentials,
  loopbackAuthorize,
  TokenStore,
  type OAuthFlowClient,
} from '../google/oauth.js';
import { verifyGoogle } from '../google/verify.js';
import { evaluateHealth, HeartbeatStore } from '../serve/heartbeat.js';
import { ServeLoop } from '../serve/loop.js';
import { createStatusServer } from '../serve/status.js';
import { runSync } from '../sync/engine.js';
import { formatReport } from '../sync/format.js';
import { runConfiguredSync, type RuntimeDeps } from '../sync/run.js';
import { StateStore } from '../sync/state.js';
import { formatUserError, toUserError, UserError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { VERSION } from '../util/version.js';
import { loadFixture } from './fixture.js';
import type { EventsApi } from '../google/types.js';
import type { FeedReport } from '../sources/ics/index.js';
import type { DestinationStream } from 'pino';

/** Things tests replace (fake Google, fake network, a stop signal). Production passes none. */
export interface CliDeps extends RuntimeDeps {
  /** Stops `serve` (SIGTERM / SIGINT in production). */
  signal?: AbortSignal;
  /** `auth google` and `verify-google`: replacements for the real Google clients. */
  oauth?: {
    flowClient?: OAuthFlowClient;
    calendars?: CalendarsApi;
    eventsApi?: EventsApi;
  };
  /** How long `serve` waits for a run in progress at shutdown. */
  shutdownGraceMs?: number;
}

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  /** Where JSON logs go (stderr in production). */
  logStream: DestinationStream;
}

const USAGE = `polito-cal-sync ${VERSION} (unofficial, personal use)

Usage: polito-cal-sync <command> [options]

Commands
  auth google     Connect Google (sign-in in your browser) and create/pick the dedicated calendar.
    --port N        Port for the redirect on 127.0.0.1 (default: a free one).
    --bind ADDR     Address to listen on (default 127.0.0.1; use 0.0.0.0 inside Docker).
    --calendar-id ID  Use this existing secondary calendar instead of creating one.
    --calendar-name NAME  Name of the calendar to create or reuse.
  verify-google   One-off experiment on a throw-away calendar: what Google does with a
                  deleted event id (decision 002/010). Needs "auth google" first.
  sync            Copy the schedule into the Google calendar.
    --dry-run       Print the plan; write nothing (no calendar changes, no history).
    --details       Under each planned event also print its course, place and note.
    --force         Allow a run that deletes more than DELETE_THRESHOLD of our events.
    --fixture DIR   Developer mode: use the files in DIR (sources.json or .ics, and
                    calendar.json) and an in-memory calendar instead of real accounts
                    (see test/fixtures/m1 and m2).
  serve           Sync every SYNC_INTERVAL_MINUTES, with a status page on STATUS_PORT.
  healthcheck     Exit 0 if the data folder and state database are usable and, when
                  "serve" runs, its last sync is recent (used by Docker).
  doctor          Check the setup (not available yet: M5).

Exit codes: 0 ok, 1 error, 2 refused / partial / failed run, or a dry run that would be refused.`;

const FIXTURE_BANNER =
  'FIXTURE MODE: in-memory calendar built from files. No Google or Polito account is used; nothing real is read or written.';

function usageError(what: string): UserError {
  return new UserError({
    code: 'E_USAGE',
    what,
    why: 'A command or option is misspelled or missing.',
    action: 'Run with --help to see the commands and options.',
  });
}

function parseOptions<T extends Record<string, { type: 'boolean' | 'string'; default?: boolean }>>(
  command: string,
  args: string[],
  options: T,
) {
  try {
    return parseArgs({ args, options, allowPositionals: false, strict: true }).values;
  } catch (cause) {
    throw usageError(`Unknown or incomplete option for "${command}": ${(cause as Error).message}`);
  }
}

function incompleteNotes(feeds: readonly FeedReport[]): string[] {
  return feeds.map(
    (f) =>
      `${f.label}: ${f.status}${f.status === 'failed' ? '' : `, ${f.events} event(s)`}${f.cancelled ? `, ${f.cancelled} cancelled left out` : ''}${f.error ? `  [${f.error.code}]` : ''}`,
  );
}

async function syncCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const values = parseOptions('sync', args, {
    'dry-run': { type: 'boolean', default: false },
    details: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    fixture: { type: 'string' },
  });

  const config = loadConfig(env);
  const dryRun = values['dry-run'] === true;
  const force = values.force === true;
  const logger = createLogger(env['LOG_LEVEL'] ? config.logLevel : 'warn', io.logStream);

  if (values.fixture === undefined) {
    const out = await runConfiguredSync({ config, logger, deps }, { dryRun, force });
    io.out(
      formatReport(out.report, {
        tz: config.tz,
        calendarId: out.calendarId,
        results: out.results,
        details: values.details === true,
        sourceNotes: [
          ...incompleteNotes(out.feeds),
          ...out.sourceErrors.map((e) => `${e.source}: ${e.error.code}`),
        ],
      }),
    );
    for (const f of out.feeds) if (f.error) io.err(formatUserError(f.error));
    for (const e of out.sourceErrors) io.err(formatUserError(e.error));
    if (out.report.error && out.report.status !== 'dry-run')
      io.err(formatUserError(out.report.error));
    const incomplete = out.results.some((r) => !r.complete);
    const bad =
      out.report.status === 'dry-run' ? out.report.error !== undefined : out.report.status !== 'ok';
    return bad || incomplete ? 2 : 0;
  }

  const fixture = loadFixture(values.fixture, config.tz, (deps.now ?? (() => new Date()))());
  const state = dryRun ? undefined : StateStore.open(':memory:');
  try {
    const report = await runSync(
      {
        calendar: new OwnedCalendar(fixture.api, fixture.calendarId),
        tz: config.tz,
        threshold: config.deleteThreshold,
        logger,
        ...(state ? { state } : {}),
      },
      fixture.results,
      { dryRun, force },
    );
    io.out(
      formatReport(report, {
        tz: config.tz,
        calendarId: fixture.calendarId,
        results: fixture.results,
        banner: FIXTURE_BANNER,
        sourceNotes: fixture.notes,
      }),
    );
    if (report.error && report.status !== 'dry-run') io.err(formatUserError(report.error));
    return report.status === 'ok' || (report.status === 'dry-run' && !report.error) ? 0 : 2;
  } finally {
    state?.close();
  }
}

async function authCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const [what, ...rest] = args;
  if (what !== 'google')
    throw usageError('Usage: auth google [--port N] [--bind ADDR] [--calendar-id ID]');
  const values = parseOptions('auth google', rest, {
    port: { type: 'string' },
    bind: { type: 'string' },
    'calendar-id': { type: 'string' },
    'calendar-name': { type: 'string' },
  });
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw usageError('--port must be a port number.');

  const config = loadConfig(env);
  ensureDataDir(config.dataDir);
  const creds = clientCredentials(config.google);
  const oauthClient = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
  const bind = values.bind ?? '127.0.0.1';

  io.out('Connecting Google. Your browser will ask you to sign in and allow calendar access.');
  const { tokens } = await loopbackAuthorize(deps.oauth?.flowClient ?? oauthClient, {
    bind,
    port,
    timeoutMs: 5 * 60_000,
    announce: (url) =>
      io.out(
        `\nOpen this address in your browser:\n\n  ${url}\n\nWaiting for Google to send you back to this program (up to 5 minutes)...`,
      ),
  });
  const store = new TokenStore(config.dataDir);
  store.write(tokens);
  io.out('Signed in. The login was saved in the data folder (private file, never printed).');

  const admin = deps.oauth?.calendars ?? createCalendarsApi(authorizedClient(creds, store));
  const pick = values['calendar-id'] ?? config.google.calendarId;
  const chosen = await chooseCalendar(admin, {
    tz: config.tz,
    ...(pick ? { pickId: pick } : {}),
    ...(values['calendar-name'] ? { name: values['calendar-name'] } : {}),
  });
  new CalendarChoice(config.dataDir).write(chosen.id);
  const verb = { created: 'Created', reused: 'Found and will reuse', picked: 'Using' }[
    chosen.action
  ];
  io.out(
    `${verb} the dedicated calendar "${chosen.summary}". Its id was saved in the data folder.`,
  );
  io.out(
    'Next: put your feed URL(s) in SOURCE_POLITO_ICS_URLS and run "sync --dry-run" (docs/M2-RUNBOOK.md).',
  );
  return 0;
}

async function verifyCommand(env: NodeJS.ProcessEnv, io: CliIo, deps: CliDeps): Promise<number> {
  const config = loadConfig(env);
  ensureDataDir(config.dataDir);
  let admin = deps.oauth?.calendars;
  let api = deps.oauth?.eventsApi;
  if (!admin || !api) {
    const client = authorizedClient(
      clientCredentials(config.google),
      new TokenStore(config.dataDir),
    );
    admin = createCalendarsApi(client);
    api = createGoogleEventsApi(client);
  }
  io.out('Experiment on a throw-away calendar (it is created and deleted by this command).');
  io.out('Your real calendar and its events are not touched.\n');
  const r = await verifyGoogle(admin, api, config.tz, (line) => io.out(`  ${line}`));
  io.out('\nFindings (no secrets, safe to share):');
  io.out(`  deleted event shows as "cancelled" tombstone : ${r.tombstoneIsCancelled ?? 'unknown'}`);
  io.out(`  tombstone keeps our extended properties      : ${r.tombstoneKeepsMarker ?? 'unknown'}`);
  io.out(
    `  insert of the same id after delete           : ${r.insertAfterDeleteStatus ?? 'unknown'}`,
  );
  io.out(`  events.patch restores the event              : ${r.patchRestores ?? 'not tested'}`);
  io.out(`  events.update restores the event             : ${r.updateRestores ?? 'not tested'}`);
  io.out(`  throw-away calendar removed                  : ${r.cleanedUp}`);
  io.out(`\nWhat it means: ${r.recommendation}`);
  const understood =
    r.patchRestores === true || r.updateRestores === true || r.insertAfterDeleteStatus === 'ok';
  return r.cleanedUp && understood ? 0 : 2;
}

async function serveCommand(env: NodeJS.ProcessEnv, io: CliIo, deps: CliDeps): Promise<number> {
  const config = loadConfig(env);
  ensureDataDir(config.dataDir);
  const logger = createLogger(config.logLevel, io.logStream);
  const heartbeat = new HeartbeatStore(config.dataDir);
  const loop = new ServeLoop({
    heartbeat,
    intervalMinutes: config.syncIntervalMinutes,
    logger,
    ...(deps.now ? { now: deps.now } : {}),
    runOnce: async () => {
      const out = await runConfiguredSync(
        { config, logger, deps },
        { dryRun: false, force: false },
      );
      const warning = out.feeds.find((f) => f.error)?.error ?? out.sourceErrors[0]?.error;
      return { report: out.report, ...(warning ? { warning } : {}) };
    },
  });

  let statusServer: ReturnType<typeof createStatusServer> | undefined;
  if (config.status.port !== 0) {
    statusServer = createStatusServer(() => loop.snapshot(), {
      bind: config.status.bind,
      port: config.status.port,
      ...(deps.now ? { now: deps.now } : {}),
    });
    try {
      const listening = await statusServer.listen();
      logger.info({ port: listening, bind: config.status.bind }, 'status page listening');
    } catch (err) {
      logger.warn({ err }, 'the status page could not start; syncing goes on without it');
      statusServer = undefined;
    }
  }

  const onStop = () => {
    logger.info('stop requested, finishing the current run');
    void loop.stop(deps.shutdownGraceMs).then(async () => {
      await statusServer?.close();
    });
  };
  if (deps.signal?.aborted) onStop();
  deps.signal?.addEventListener('abort', onStop, { once: true });

  logger.info(
    { intervalMinutes: config.syncIntervalMinutes, feeds: config.icsUrls.length },
    'serve started',
  );
  await loop.start();
  await statusServer?.close();
  logger.info('serve stopped');
  return 0;
}

function healthcheck(env: NodeJS.ProcessEnv, io: CliIo, deps: CliDeps): number {
  const config = loadConfig(env);
  ensureDataDir(config.dataDir);
  StateStore.probe(StateStore.fileIn(config.dataDir));
  const health = evaluateHealth(
    new HeartbeatStore(config.dataDir).read(),
    (deps.now ?? (() => new Date()))(),
  );
  if (!health.healthy) {
    io.err(`unhealthy: ${health.reason ?? 'unknown'}`);
    return 1;
  }
  io.out('ok');
  return 0;
}

/** Runs one CLI invocation and returns the process exit code. Never throws. */
export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  deps: CliDeps = {},
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case '--help':
      case '-h':
      case 'help':
        io.out(USAGE);
        return 0;
      case '--version':
        io.out(VERSION);
        return 0;
      case 'sync':
        if (rest.includes('--help') || rest.includes('-h')) {
          io.out(USAGE);
          return 0;
        }
        return await syncCommand(rest, env, io, deps);
      case 'auth':
        return await authCommand(rest, env, io, deps);
      case 'verify-google':
        return await verifyCommand(env, io, deps);
      case 'serve':
        return await serveCommand(env, io, deps);
      case 'healthcheck':
        return healthcheck(env, io, deps);
      case 'doctor':
        throw new UserError({
          code: 'E_NOT_IMPLEMENTED',
          what: `"${command}" is not available in this build yet.`,
          why: 'The project is built in milestones (docs/PLAN.md): doctor arrives with M5.',
          action: 'Nothing is broken. "sync --dry-run" shows what a run would do.',
        });
      default:
        throw usageError(`Unknown command "${command}".`);
    }
  } catch (err) {
    io.err(formatUserError(toUserError(err)));
    return 1;
  }
}
