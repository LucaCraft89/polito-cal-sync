import type { Logger } from 'pino';
import { loadConfig } from '../config/index.js';
import type { AuditLog } from '../settings/audit.js';
import type { SettingsStore } from '../settings/store.js';
import { runConfiguredSync, type RunOutput, type RuntimeDeps } from '../sync/run.js';
import { toUserError, UserError } from '../util/errors.js';
import {
  problem,
  problemsOf,
  settingsStamp,
  type PreviewService,
  type ProblemView,
} from './preview.js';

/** A real sync from the page: not more often than this, counted from the start of the last attempt. */
export const SYNC_MIN_INTERVAL_MS = 15 * 60_000;
/** The preview a sync is confirmed on must be younger than this. */
export const PREVIEW_FRESH_MS = 30 * 60_000;

/** What a person types to confirm a run that removes more than the limit allows. */
export const confirmationPhrase = (deletes: number): string => `remove ${deletes}`;

export interface SyncResultView {
  status: 'ok' | 'partial' | 'refused' | 'failed';
  created: number;
  patched: number;
  deleted: number;
  /** Single events that could not be written. */
  failed: number;
  unchanged: number;
  /** Why it was refused or stopped. */
  error?: ProblemView;
  /** Feed and source problems met on the way. */
  problems: ProblemView[];
}

export interface SyncRunView {
  state: 'idle' | 'running' | 'done';
  startedAt?: string;
  finishedAt?: string;
  result?: SyncResultView;
}

export interface SyncStartBody {
  /** `generatedAt` of the preview the person looked at and confirmed. */
  previewAt: string;
  confirm: true;
  /** Only needed when the preview shows more removals than the limit. */
  typed?: string | undefined;
}

export interface SyncOptions {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  settings: SettingsStore;
  audit: AuditLog;
  preview: PreviewService;
  logger: Logger;
  deps?: RuntimeDeps;
  now: () => number;
  minIntervalMs?: number;
  /** Called when the run started or ended (the live updates). */
  onChange?: () => void;
}

const needsPreview = (why: string): UserError =>
  new UserError({
    code: 'E_UI_SYNC_NEEDS_PREVIEW',
    what: 'Sync now needs a fresh preview that you looked at, so nothing was changed.',
    why,
    action: 'Open Preview, press "Preview now", read the result, then press "Sync now" there.',
  });

/**
 * Sync now (docs/UI.md section 4, "Dangerous actions"; decision 029). A real run that WRITES to the dedicated
 * Google calendar, so every guard is here, on the server:
 *  - it works on a preview made less than 30 minutes ago from the same settings, and on the one the person was
 *    looking at (`previewAt`);
 *  - one explicit confirmation; when the preview shows more removals than the limit, also the typed phrase
 *    "remove N", and only then the run is forced (decision 001) - otherwise the engine's own limit applies;
 *  - the real run may never remove more than the preview showed (`guard`): a source that changes meanwhile
 *    cannot turn a confirmed small run into a big one;
 *  - not more often than every 15 minutes (a refusal costs nothing), one at a time here, and the data-folder
 *    run lock of decision 012 against `serve` and a manual `sync`.
 * It runs in the background; the page polls `GET /api/sync`. Nothing here ever runs by itself.
 */
export class SyncService {
  private view: SyncRunView = { state: 'idle' };
  private lastStartedAt: number | undefined;
  private job: Promise<void> | undefined;

  constructor(private readonly o: SyncOptions) {}

  private get minInterval(): number {
    return this.o.minIntervalMs ?? SYNC_MIN_INTERVAL_MS;
  }

  private nextAllowed(): string | null {
    if (this.lastStartedAt === undefined) return null;
    const at = this.lastStartedAt + this.minInterval;
    return at > this.o.now() ? new Date(at).toISOString() : null;
  }

  get status(): { run: SyncRunView; nextAllowedAt: string | null } {
    return { run: this.view, nextAllowedAt: this.nextAllowed() };
  }

  /** Resolves when a run in progress has finished (shutdown waits for it). */
  settle(): Promise<void> {
    return this.job ?? Promise.resolve();
  }

  start(body: SyncStartBody): { run: SyncRunView; nextAllowedAt: string | null } {
    if (this.view.state === 'running') {
      throw new UserError({
        code: 'E_SYNC_ALREADY_RUNNING',
        what: 'A sync started from this page is still running.',
        why: 'Only one sync runs at a time.',
        action: 'Wait for it to finish; the result appears on this page.',
      });
    }
    const current = this.o.preview.current;
    if (!current)
      throw needsPreview(
        'There is no preview yet (or a sync has just made the last one outdated).',
      );
    const { view: preview, stamp } = current;
    if (preview.generatedAt !== body.previewAt) {
      throw needsPreview(
        'The preview you confirmed is not the latest one. Look at the latest before you confirm.',
      );
    }
    if (this.o.now() - Date.parse(preview.generatedAt) > PREVIEW_FRESH_MS) {
      throw needsPreview(
        'The preview is older than 30 minutes, so it may no longer match your sources.',
      );
    }
    if (stamp !== settingsStamp(this.o.dataDir, this.o.settings)) {
      throw needsPreview('A setting changed after the preview was made.');
    }
    const forced = preview.safety.exceeded;
    if (forced) {
      const want = confirmationPhrase(preview.safety.deletes);
      if ((body.typed ?? '').trim().toLowerCase() !== want) {
        throw new UserError({
          code: 'E_UI_SYNC_CONFIRMATION',
          what: `This run would remove ${preview.safety.deletes} of ${preview.safety.managedInScope} events, more than the limit, so it needs a typed confirmation. Nothing was changed.`,
          why: 'Removing most of a calendar usually means a source came back empty or partial, not that the schedule vanished.',
          action: `Type "${want}" in the box, exactly like that, or cancel and check your sources.`,
        });
      }
    }
    const wait = this.nextAllowed();
    if (wait !== null) {
      const minutes = Math.max(1, Math.ceil((Date.parse(wait) - this.o.now()) / 60_000));
      throw new UserError({
        code: 'E_UI_SYNC_RATE_LIMITED',
        what: `A sync was started less than ${Math.round(this.minInterval / 60_000)} minutes ago, so no new one was started.`,
        why: 'A sync logs in to the university and writes to Google. Limiting how often protects your account and your Google quota. The limit counts from the start of the last attempt, also when it failed.',
        action: `Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}. The scheduled sync (if it is running) keeps going on its own.`,
      });
    }

    const confirmedDeletes = preview.counts.deletes;
    this.lastStartedAt = this.o.now();
    this.view = { state: 'running', startedAt: new Date(this.o.now()).toISOString() };
    this.o.audit.append('sync.started', {
      forced,
      creates: preview.counts.creates,
      patches: preview.counts.patches,
      deletes: confirmedDeletes,
    });
    this.o.logger.info(
      { forced, deletes: confirmedDeletes },
      'ui sync started on a confirmed preview',
    );
    this.o.onChange?.();
    this.job = this.run(forced, confirmedDeletes).finally(() => {
      this.job = undefined;
    });
    return this.status;
  }

  private async run(forced: boolean, confirmedDeletes: number): Promise<void> {
    let result: SyncResultView;
    try {
      const config = loadConfig(
        { ...this.o.env, DATA_DIR: this.o.dataDir },
        this.o.settings.read(),
      );
      const out = await runConfiguredSync(
        {
          config,
          logger: this.o.logger,
          lockLabel: 'the Sync now button',
          ...(this.o.deps ? { deps: this.o.deps } : {}),
        },
        {
          dryRun: false,
          force: forced,
          guard: (plan) =>
            plan.deletes.length > confirmedDeletes
              ? new UserError({
                  code: 'E_SYNC_PLAN_CHANGED',
                  what: `Refused: this run would remove ${plan.deletes.length} events, more than the ${confirmedDeletes} the preview showed. Nothing was changed.`,
                  why: 'A source changed between the preview and the sync.',
                  action: 'Run a new preview, read it, and confirm again.',
                })
              : undefined,
        },
      );
      result = toResult(out);
    } catch (err) {
      const e = toUserError(err);
      this.o.logger.warn({ code: e.code }, 'ui sync did not run');
      result = {
        status: 'failed',
        created: 0,
        patched: 0,
        deleted: 0,
        failed: 0,
        unchanged: 0,
        error: problem(e),
        problems: [],
      };
    }
    // Whatever happened, the preview no longer describes the calendar.
    this.o.preview.invalidate();
    this.view = {
      state: 'done',
      startedAt: this.view.startedAt ?? new Date(this.o.now()).toISOString(),
      finishedAt: new Date(this.o.now()).toISOString(),
      result,
    };
    this.o.audit.append('sync.finished', {
      status: result.status,
      created: result.created,
      patched: result.patched,
      deleted: result.deleted,
      ...(result.error ? { code: result.error.code } : {}),
    });
    this.o.onChange?.();
  }
}

function toResult(out: RunOutput): SyncResultView {
  const { report } = out;
  const applied = report.applied;
  return {
    status: report.status === 'dry-run' ? 'failed' : report.status,
    created: applied?.created ?? 0,
    patched: applied?.patched ?? 0,
    deleted: applied?.deleted ?? 0,
    failed: applied?.failures.length ?? 0,
    unchanged: report.plan.unchanged,
    ...(report.error ? { error: problem(report.error) } : {}),
    problems: problemsOf(out),
  };
}
