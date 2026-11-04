import type { Logger } from 'pino';
import type { OwnedCalendar } from '../google/calendar.js';
import type { SourceResult } from '../sources/types.js';
import { toUserError, UserError } from '../util/errors.js';
import { applyPlan, type ApplyResult } from './applier.js';
import { diff, type Plan } from './differ.js';
import type { StateStore } from './state.js';

export interface SyncDeps {
  calendar: OwnedCalendar;
  tz: string;
  /** Max share of managed events a run may delete without `force` (0..1). */
  threshold: number;
  /** Absent for dry runs: a dry run writes nothing, not even history. */
  state?: StateStore;
  now?: () => Date;
  logger?: Logger;
}

export interface SyncOptions {
  dryRun: boolean;
  force: boolean;
}

export type SyncStatus = 'dry-run' | 'ok' | 'partial' | 'refused' | 'failed';

export interface SyncReport {
  status: SyncStatus;
  plan: Plan;
  applied?: ApplyResult;
  /** Why the run was refused or stopped. For a dry run that WOULD be refused, it is set too. */
  error?: UserError;
  options: SyncOptions;
}

function thresholdError(plan: Plan): UserError {
  const s = plan.safety;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return new UserError({
    code: 'E_DELETE_THRESHOLD',
    what: `Refused: this run would remove ${s.deletes} of the ${s.managedInScope} events we manage (${pct(s.ratio)}); the limit is ${pct(s.threshold)}. Nothing was changed.`,
    why: 'A source reporting that most events are gone usually means an empty or partial list (moved feed, expired login), not that the whole schedule vanished.',
    action:
      'Check the source (doctor). If the removal is really what you want, run the sync again with --force.',
  });
}

/**
 * One sync: list what we manage, diff against the sources, then (unless dry run) apply.
 * Never throws for a refusal; throws UserError for Google/state failures after recording them.
 */
export async function runSync(
  deps: SyncDeps,
  results: readonly SourceResult[],
  options: SyncOptions,
): Promise<SyncReport> {
  const now = deps.now ?? (() => new Date());
  const state = options.dryRun ? undefined : deps.state;
  const runId = state?.startRun({
    calendarId: deps.calendar.calendarId,
    forced: options.force,
    now: now(),
  });
  const finish = (r: Parameters<StateStore['finishRun']>[1]) => {
    if (state && runId !== undefined) state.finishRun(runId, r, now());
  };

  let plan: Plan;
  try {
    const remote = await deps.calendar.listManaged();
    plan = diff(results, remote, deps.threshold);
  } catch (err) {
    const e = toUserError(err);
    finish({
      status: 'failed',
      created: 0,
      patched: 0,
      deleted: 0,
      unchanged: 0,
      failed: 0,
      errorCode: e.code,
    });
    throw e;
  }

  deps.logger?.info(
    {
      creates: plan.creates.length,
      patches: plan.patches.length,
      deletes: plan.deletes.length,
      unchanged: plan.unchanged,
      incompleteSources: plan.incompleteSources,
      dryRun: options.dryRun,
    },
    'sync plan computed',
  );

  const refused = plan.safety.exceeded && !options.force;
  if (options.dryRun) {
    return {
      status: 'dry-run',
      plan,
      options,
      ...(refused ? { error: thresholdError(plan) } : {}),
    };
  }

  if (refused) {
    const error = thresholdError(plan);
    finish({
      status: 'refused',
      created: 0,
      patched: 0,
      deleted: 0,
      unchanged: plan.unchanged,
      failed: 0,
      errorCode: error.code,
      details: { safety: plan.safety, incompleteSources: plan.incompleteSources },
    });
    return { status: 'refused', plan, options, error };
  }

  const applied = await applyPlan(plan, deps.calendar, deps.tz);
  if (state) {
    state.recordApplied(deps.calendar.calendarId, applied.applied, now());
    state.forget(applied.removed);
  }
  const status: SyncStatus = applied.fatal
    ? 'failed'
    : applied.failures.length > 0
      ? 'partial'
      : 'ok';
  finish({
    status,
    created: applied.created,
    patched: applied.patched,
    deleted: applied.deleted,
    unchanged: plan.unchanged,
    failed: applied.failures.length,
    ...(applied.fatal ? { errorCode: applied.fatal.code } : {}),
    details: { failures: applied.failures, incompleteSources: plan.incompleteSources },
  });
  deps.logger?.info(
    {
      status,
      created: applied.created,
      patched: applied.patched,
      deleted: applied.deleted,
      failed: applied.failures.length,
    },
    'sync finished',
  );
  return { status, plan, options, applied, ...(applied.fatal ? { error: applied.fatal } : {}) };
}
