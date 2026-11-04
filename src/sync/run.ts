import type { Logger } from 'pino';
import { ensureDataDir, type Config } from '../config/index.js';
import { OwnedCalendar } from '../google/calendar.js';
import { connectGoogle, type GoogleRuntime } from '../google/runtime.js';
import { IcsSource, type FeedReport } from '../sources/ics/index.js';
import type { Source, SourceResult } from '../sources/types.js';
import { UserError } from '../util/errors.js';
import { runSync, type SyncReport } from './engine.js';
import { acquireRunLock } from './lock.js';
import { StateStore } from './state.js';

/** Things tests replace; production leaves them all out. */
export interface RuntimeDeps {
  googleFactory?: (config: Config) => Promise<GoogleRuntime>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between two ICS feeds (ms). */
  pauseBetweenFeedsMs?: number;
}

export interface RunContext {
  config: Config;
  logger: Logger;
  deps?: RuntimeDeps;
}

export interface RunOutput {
  report: SyncReport;
  results: SourceResult[];
  calendarId: string;
  feeds: FeedReport[];
}

/** The sources switched on by the configuration. Today: the ICS feeds. */
export function buildSources(ctx: RunContext): { sources: Source[]; ics?: IcsSource } {
  const { config, logger, deps = {} } = ctx;
  if (config.icsUrls.length === 0) {
    throw new UserError({
      code: 'E_NOT_CONFIGURED',
      what: 'No source is enabled, so there is nothing to sync.',
      why: 'SOURCE_POLITO_ICS_URLS is empty.',
      action:
        'Put the calendar feed URL(s) of your courses in .env as SOURCE_POLITO_ICS_URLS (comma separated). See docs/M2-RUNBOOK.md.',
    });
  }
  const ics = new IcsSource({
    urls: config.icsUrls,
    dataDir: config.dataDir,
    tz: config.tz,
    logger,
    ...(deps.fetchImpl || deps.sleep
      ? {
          fetchOptions: {
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
            ...(deps.sleep ? { sleep: deps.sleep } : {}),
          },
        }
      : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.pauseBetweenFeedsMs !== undefined
      ? { pauseBetweenFeedsMs: deps.pauseBetweenFeedsMs }
      : {}),
  });
  return { sources: [ics], ics };
}

/**
 * The real path used by `sync` and `serve`: ICS feeds -> engine -> the dedicated Google calendar.
 * A real run holds the data-folder lock, so two syncs never overlap. A dry run reads only.
 */
export async function runConfiguredSync(
  ctx: RunContext,
  options: { dryRun: boolean; force: boolean },
): Promise<RunOutput> {
  const { config, logger, deps = {} } = ctx;
  const { sources, ics } = buildSources(ctx);
  ensureDataDir(config.dataDir);
  const lock = options.dryRun ? undefined : acquireRunLock(config.dataDir, deps.now);
  let state: StateStore | undefined;
  try {
    const google = await (
      deps.googleFactory ??
      ((c) =>
        connectGoogle(c, (err) =>
          logger.warn({ err }, 'could not save the refreshed Google login'),
        ))
    )(config);
    const results: SourceResult[] = [];
    for (const source of sources) results.push(await source.fetch());
    state = options.dryRun ? undefined : StateStore.open(StateStore.fileIn(config.dataDir));
    const report = await runSync(
      {
        calendar: new OwnedCalendar(google.api, google.calendarId),
        tz: config.tz,
        threshold: config.deleteThreshold,
        logger,
        ...(state ? { state } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      },
      results,
      options,
    );
    return { report, results, calendarId: google.calendarId, feeds: ics?.lastReport ?? [] };
  } finally {
    state?.close();
    lock?.release();
  }
}
