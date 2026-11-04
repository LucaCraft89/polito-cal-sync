import type { Logger } from 'pino';
import { ensureDataDir, type Config } from '../config/index.js';
import { OwnedCalendar } from '../google/calendar.js';
import { connectGoogle, type GoogleRuntime } from '../google/runtime.js';
import { IcsSource, type FeedReport } from '../sources/ics/index.js';
import { UnavailableAuth, type PolitoApi } from '../sources/polito/client.js';
import { PolitoApiSource } from '../sources/polito/index.js';
import type { Source, SourceResult } from '../sources/types.js';
import { toUserError, UserError } from '../util/errors.js';
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
  /** Replaces the Polito API client (tests). Production uses the one that is not able to log in yet. */
  politoApi?: PolitoApi;
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
  /** Sources other than ICS that failed or came back incomplete, with the reason. */
  sourceErrors: { source: string; error: UserError }[];
}

/** The sources switched on by the configuration: the ICS feeds and, if enabled, the Polito API. */
export function buildSources(ctx: RunContext): {
  sources: Source[];
  ics?: IcsSource;
  polito?: PolitoApiSource;
} {
  const { config, logger, deps = {} } = ctx;
  if (config.icsUrls.length === 0 && !config.polito.enabled) {
    throw new UserError({
      code: 'E_NOT_CONFIGURED',
      what: 'No source is enabled, so there is nothing to sync.',
      why: 'SOURCE_POLITO_ICS_URLS is empty.',
      action:
        'Put the calendar feed URL(s) of your courses in .env as SOURCE_POLITO_ICS_URLS (comma separated). See docs/M2-RUNBOOK.md.',
    });
  }
  const sources: Source[] = [];
  let ics: IcsSource | undefined;
  if (config.icsUrls.length > 0) {
    ics = buildIcs(ctx);
    sources.push(ics);
  }
  let polito: PolitoApiSource | undefined;
  if (config.polito.enabled) {
    // Until the probe settles how an unattended login works, the only auth is one that says so (E_POLITO_API_NOT_READY).
    const api: PolitoApi = deps.politoApi ?? {
      get: () => new UnavailableAuth().token().then(() => undefined),
    };
    polito = new PolitoApiSource({
      api,
      logger,
      ...(deps.now ? { now: deps.now } : {}),
    });
    sources.push(polito);
  }
  return { sources, ...(ics ? { ics } : {}), ...(polito ? { polito } : {}) };
}

function buildIcs(ctx: RunContext): IcsSource {
  const { config, logger, deps = {} } = ctx;
  return new IcsSource({
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
  const { sources, ics, polito } = buildSources(ctx);
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
    const sourceErrors: RunOutput['sourceErrors'] = [];
    for (const source of sources) {
      try {
        results.push(await source.fetch());
      } catch (err) {
        // A source that blows up must never stop the others, and counts as incomplete: no deletions for it.
        if (source === ics) throw err;
        const error = toUserError(err);
        logger.warn(
          { source: source.id, code: error.code },
          'source failed; treated as incomplete',
        );
        results.push({ source: source.id, complete: false, events: [] });
        sourceErrors.push({ source: source.id, error });
      }
    }
    for (const r of polito?.lastReport ?? []) {
      if (r.error) sourceErrors.push({ source: polito?.id ?? 'polito', error: r.error });
    }
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
    return {
      report,
      results,
      calendarId: google.calendarId,
      feeds: ics?.lastReport ?? [],
      sourceErrors,
    };
  } finally {
    state?.close();
    lock?.release();
  }
}
