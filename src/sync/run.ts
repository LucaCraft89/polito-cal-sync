import type { Logger } from 'pino';
import { ensureDataDir, type Config } from '../config/index.js';
import { OwnedCalendar } from '../google/calendar.js';
import { connectGoogle, type GoogleRuntime } from '../google/runtime.js';
import { IcsSource, type FeedReport } from '../sources/ics/index.js';
import { MoodleSource } from '../sources/moodle/index.js';
import { CourseCatalog } from '../sources/polito/catalog.js';
import { PolitoPortalSource } from '../sources/polito/index.js';
import type { PortalOptions } from '../sources/polito/portal/login.js';
import type { Source, SourceResult } from '../sources/types.js';
import { toUserError, UserError } from '../util/errors.js';
import { runSync, type SyncOptions, type SyncReport } from './engine.js';
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
  /** Test hooks for the Polito portal login (fetch, allowed hosts, pauses). */
  politoPortal?: PortalOptions;
}

export interface RunContext {
  /** Who is running this sync, in words, for the lock's message ("the scheduled service"). */
  lockLabel?: string;
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
  /** Hints from sources (not errors), shown under "Sources". */
  sourceNotes: string[];
  /** `polito:<course id>` -> course name (empty when the portal is off or failed). */
  courseNames: ReadonlyMap<string, string>;
  /** Polito course id -> every squad label seen (empty when the portal is off or failed). */
  squadsSeen: ReadonlyMap<string, readonly string[]>;
}

/** The sources switched on by the configuration: the ICS feeds and, if enabled, the Polito portal. */
export function buildSources(ctx: RunContext): {
  sources: Source[];
  ics?: IcsSource;
  polito?: PolitoPortalSource;
  moodle?: MoodleSource;
} {
  const { config, logger, deps = {} } = ctx;
  if (config.icsUrls.length === 0 && !config.polito.enabled && !config.moodle.enabled) {
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
  let polito: PolitoPortalSource | undefined;
  if (config.polito.enabled) {
    const { username, password } = config.polito;
    if (!username || !password) {
      throw new UserError({
        code: 'E_NOT_CONFIGURED',
        what: 'The Polito portal source is switched on, but the login is not set.',
        why: 'POLITO_USERNAME and/or POLITO_PASSWORD are empty.',
        action:
          'Put your university username and password in .env (git-ignored; never share the file), or set SOURCE_POLITO_PORTAL_ENABLED=false. See docs/M3-RUNBOOK.md.',
      });
    }
    polito = new PolitoPortalSource({
      username,
      password,
      tz: config.tz,
      dataDir: config.dataDir,
      examCalls: config.polito.examCalls,
      squads: new Map(Object.entries(config.polito.squads).map(([id, v]) => [id, new Set(v)])),
      logger,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.politoPortal ? { portal: deps.politoPortal } : {}),
    });
    sources.push(polito);
  }
  let moodle: MoodleSource | undefined;
  if (config.moodle.enabled) {
    const { username, password } = config.polito;
    if (!username || !password) {
      throw new UserError({
        code: 'E_NOT_CONFIGURED',
        what: 'The live Moodle source is switched on, but the university login is not set.',
        why: 'Moodle uses the same username and password as the Polito portal, and they are empty.',
        action: 'Enter them under Sources (Polito portal card), or switch the Moodle source off.',
      });
    }
    moodle = new MoodleSource({
      username,
      password,
      baseUrl: config.moodleBaseUrl,
      dataDir: config.dataDir,
      logger,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.politoPortal ? { portal: deps.politoPortal } : {}),
    });
    sources.push(moodle);
  }
  return {
    sources,
    ...(ics ? { ics } : {}),
    ...(polito ? { polito } : {}),
    ...(moodle ? { moodle } : {}),
  };
}

function buildIcs(ctx: RunContext): IcsSource {
  const { config, logger, deps = {} } = ctx;
  return new IcsSource({
    urls: config.icsUrls,
    dataDir: config.dataDir,
    tz: config.tz,
    moodleHost: config.moodleHost,
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
export async function runConfiguredSync(ctx: RunContext, options: SyncOptions): Promise<RunOutput> {
  const { config, logger, deps = {} } = ctx;
  const { sources, ics, polito, moodle } = buildSources(ctx);
  ensureDataDir(config.dataDir);
  const lock = options.dryRun ? undefined : acquireRunLock(config.dataDir, deps.now, ctx.lockLabel);
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
    if (polito && polito.courseNames.size > 0) {
      // Remember the course list for the Courses page and the squad picker (names and squad labels only).
      try {
        new CourseCatalog(config.dataDir).write(
          polito.courseNames,
          polito.squadsSeen,
          (deps.now ?? (() => new Date()))(),
        );
      } catch (err) {
        logger.warn({ err }, 'could not save the course list');
      }
    }
    for (const r of polito?.lastReport ?? []) {
      if (r.error) sourceErrors.push({ source: polito?.id ?? 'polito', error: r.error });
    }
    for (const r of moodle?.lastReport ?? []) {
      if (r.error) sourceErrors.push({ source: moodle?.id ?? 'moodle', error: r.error });
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
      sourceNotes: polito?.notes ?? [],
      courseNames: new Map([...(polito?.courseNames ?? []), ...(moodle?.courseNames ?? [])]),
      squadsSeen: polito?.squadsSeen ?? new Map(),
    };
  } finally {
    state?.close();
    lock?.release();
  }
}
