import { parseArgs } from 'node:util';
import { ensureDataDir, loadConfig } from '../config/index.js';
import { OwnedCalendar } from '../google/calendar.js';
import { runSync } from '../sync/engine.js';
import { formatReport } from '../sync/format.js';
import { StateStore } from '../sync/state.js';
import { formatUserError, UserError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { VERSION } from '../util/version.js';
import { loadFixture } from './fixture.js';
import type { DestinationStream } from 'pino';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  /** Where JSON logs go (stderr in production). */
  logStream: DestinationStream;
}

const USAGE = `polito-cal-sync ${VERSION} (unofficial, personal use)

Usage: polito-cal-sync <command> [options]

Commands
  sync            Copy the schedule into the Google calendar.
    --dry-run       Print the plan; write nothing (no calendar changes, no history).
    --force         Allow a run that deletes more than DELETE_THRESHOLD of our events.
    --fixture DIR   Developer mode: use the sources.json/calendar.json in DIR and an
                    in-memory calendar instead of real accounts (see test/fixtures/m1).
  healthcheck     Exit 0 if the data folder and state database are usable (used by Docker).
  serve           Run the scheduled sync and the status page (not available yet: M2).
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

async function syncCommand(args: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        'dry-run': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        fixture: { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (cause) {
    throw usageError(`Unknown or incomplete option for "sync": ${(cause as Error).message}`);
  }

  const config = loadConfig(env);
  if (values.fixture === undefined) {
    throw new UserError({
      code: 'E_NOT_CONFIGURED',
      what: 'Cannot sync: Google is not connected and no source is enabled.',
      why: 'The Google login and the sources arrive in milestones M2 and later; this build only contains the sync engine.',
      action:
        'To see the engine work without any account, run: pnpm sync --dry-run --fixture test/fixtures/m1',
    });
  }

  const fixture = loadFixture(values.fixture, config.tz);
  const dryRun = values['dry-run'];
  const logger = createLogger(env['LOG_LEVEL'] ? config.logLevel : 'warn', io.logStream);
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
      { dryRun, force: values.force },
    );
    io.out(
      formatReport(report, {
        tz: config.tz,
        calendarId: fixture.calendarId,
        results: fixture.results,
        banner: FIXTURE_BANNER,
      }),
    );
    if (report.error && report.status !== 'dry-run') io.err(formatUserError(report.error));
    return report.status === 'ok' || (report.status === 'dry-run' && !report.error) ? 0 : 2;
  } finally {
    state?.close();
  }
}

function healthcheck(env: NodeJS.ProcessEnv, io: CliIo): number {
  const config = loadConfig(env);
  ensureDataDir(config.dataDir);
  StateStore.open(StateStore.fileIn(config.dataDir)).close();
  io.out('ok');
  return 0;
}

/** Runs one CLI invocation and returns the process exit code. Never throws. */
export async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
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
        return await syncCommand(rest, env, io);
      case 'healthcheck':
        return healthcheck(env, io);
      case 'serve':
      case 'doctor':
        throw new UserError({
          code: 'E_NOT_IMPLEMENTED',
          what: `"${command}" is not available in this build yet.`,
          why: `The project is built in milestones (docs/PLAN.md): serve arrives with M2, doctor with M5.`,
          action:
            'Nothing is broken. Use "sync --dry-run --fixture test/fixtures/m1" to try the engine.',
        });
      default:
        throw usageError(`Unknown command "${command}".`);
    }
  } catch (err) {
    io.err(formatUserError(err));
    return 1;
  }
}
