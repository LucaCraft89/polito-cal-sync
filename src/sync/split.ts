import type { Logger } from 'pino';
import type { ManagedEvent, OwnedCalendar } from '../google/calendar.js';
import type { CanonicalEvent, SourceResult } from '../sources/types.js';
import { toUserError } from '../util/errors.js';
import type { ApplyResult } from './applier.js';
import type { Plan } from './differ.js';
import { runSync, type SyncOptions, type SyncReport, type SyncStatus } from './engine.js';
import { googleEventId } from './mapper.js';
import type { RunResult, StateStore } from './state.js';

export interface SplitDeps {
  /** The calendar of the Polito agenda and everything that is not Moodle. */
  polito: OwnedCalendar;
  /** The calendar of the Moodle events. */
  moodle: OwnedCalendar;
  tz: string;
  threshold: number;
  state?: StateStore;
  now?: () => Date;
  logger?: Logger;
  /**
   * `split` (default): Moodle events in the Moodle calendar. `merge`: everything belongs in the Polito calendar, so
   * what is still in the Moodle calendar moves back (the setting was switched off).
   */
  routing?: 'split' | 'merge';
}

export interface SplitReport extends SyncReport {
  /** Events that change calendar in this run (their old copy is deleted only after the new one exists). */
  moves: { toMoodle: number; toPolito: number };
  /** In `merge` routing: the Moodle calendar holds no more event of ours after this run. */
  moveBack?: { empty: boolean };
}

/** Where an event belongs when Moodle events are kept apart. The label "[Moodle]" stays in the title. */
export const belongsToMoodle = (e: { kind?: string }): boolean => e.kind === 'moodle';

const RANK: Record<SyncStatus, number> = { 'dry-run': 0, ok: 1, partial: 2, refused: 3, failed: 4 };
const worst = (a: SyncStatus, b: SyncStatus): SyncStatus => (RANK[a] >= RANK[b] ? a : b);

function mergePlans(a: Plan, b: Plan): Plan {
  return {
    creates: [...a.creates, ...b.creates],
    patches: [...a.patches, ...b.patches],
    deletes: [...a.deletes, ...b.deletes],
    unchanged: a.unchanged + b.unchanged,
    incompleteSources: [...new Set([...a.incompleteSources, ...b.incompleteSources])],
    untouched: [...a.untouched, ...b.untouched],
    safety: {
      managedInScope: a.safety.managedInScope + b.safety.managedInScope,
      deletes: a.safety.deletes + b.safety.deletes,
      ratio: Math.max(a.safety.ratio, b.safety.ratio),
      threshold: a.safety.threshold,
      exceeded: a.safety.exceeded || b.safety.exceeded,
    },
  };
}

function mergeApplied(a?: ApplyResult, b?: ApplyResult): ApplyResult | undefined {
  if (!a && !b) return undefined;
  const fatal = a?.fatal ?? b?.fatal;
  return {
    created: (a?.created ?? 0) + (b?.created ?? 0),
    patched: (a?.patched ?? 0) + (b?.patched ?? 0),
    deleted: (a?.deleted ?? 0) + (b?.deleted ?? 0),
    failures: [...(a?.failures ?? []), ...(b?.failures ?? [])],
    applied: [...(a?.applied ?? []), ...(b?.applied ?? [])],
    removed: [...(a?.removed ?? []), ...(b?.removed ?? [])],
    ...(fatal ? { fatal } : {}),
  };
}

/** One run row for the two calendars: the first `startRun` creates it, `finishRun` is held back and merged. */
function sharedRun(state: StateStore): { state: StateStore; finish(at: Date): void } {
  let id: number | undefined;
  const results: RunResult[] = [];
  const proxy = Object.create(state) as StateStore;
  proxy.startRun = (input) => {
    id ??= state.startRun(input);
    return id;
  };
  proxy.finishRun = (_id, result) => void results.push(result);
  return {
    state: proxy,
    finish: (at) => {
      if (id === undefined || results.length === 0) return;
      const rank = (s: RunResult['status']) => RANK[s];
      const status = results.map((r) => r.status).reduce((a, b) => (rank(a) >= rank(b) ? a : b));
      const errorCode = results.find((r) => r.errorCode)?.errorCode;
      state.finishRun(
        id,
        {
          status,
          created: results.reduce((n, r) => n + r.created, 0),
          patched: results.reduce((n, r) => n + r.patched, 0),
          deleted: results.reduce((n, r) => n + r.deleted, 0),
          unchanged: results.reduce((n, r) => n + r.unchanged, 0),
          failed: results.reduce((n, r) => n + r.failed, 0),
          ...(errorCode ? { errorCode } : {}),
          details: {
            calendars: 2,
            failures: results.flatMap(
              (r) => (r.details as { failures?: unknown[] } | undefined)?.failures ?? [],
            ),
            incompleteSources: [
              ...new Set(
                results.flatMap(
                  (r) =>
                    (r.details as { incompleteSources?: string[] } | undefined)
                      ?.incompleteSources ?? [],
                ),
              ),
            ],
          },
        },
        at,
      );
    },
  };
}

/**
 * A sync into TWO calendars: Moodle events (kind "moodle", the title keeps "[Moodle]") in one, everything else in the
 * other (decision 040, the simple case of decision 013). Safety is the one of a single run, spread over two calendars:
 *  - each calendar has its own plan and its own deletion limit; if EITHER exceeds its limit the whole run is refused
 *    (nothing is written anywhere) unless forced;
 *  - an event that changes calendar (the setting was switched on or off) is a MOVE: the new copy is created first and
 *    the old one is deleted only after that succeeded; moves do not count toward the deletion limit, so switching the
 *    setting never looks like a mass deletion; a crash in between leaves two copies, never none;
 *  - an incomplete source deletes nothing in either calendar (per-calendar plans keep the source's flag).
 * The two runs write ONE history row.
 */
export async function runSplitSync(
  deps: SplitDeps,
  results: readonly SourceResult[],
  options: SyncOptions,
): Promise<SplitReport> {
  const now = deps.now ?? (() => new Date());
  const partition = (pred: (e: CanonicalEvent) => boolean): SourceResult[] =>
    results.map((r) => ({ ...r, events: r.events.filter(pred) }));
  const idsOf = (list: SourceResult[]) =>
    new Set(list.flatMap((r) => r.events.map((e) => googleEventId(e.source, e.sourceId))));
  const merge = deps.routing === 'merge';
  const forMoodle = partition((e) => !merge && belongsToMoodle(e));
  const forPolito = partition((e) => merge || !belongsToMoodle(e));
  const idsMoodle = idsOf(forMoodle);
  const idsPolito = idsOf(forPolito);

  // What is found in a calendar but belongs to the other one is a move, not a deletion.
  const leavingPolito: ManagedEvent[] = [];
  const leavingMoodle: ManagedEvent[] = [];
  const viewPolito = (remote: ManagedEvent[]) =>
    remote.filter((r) => (idsMoodle.has(r.googleId) ? (leavingPolito.push(r), false) : true));
  const viewMoodle = (remote: ManagedEvent[]) =>
    remote.filter((r) => (idsPolito.has(r.googleId) ? (leavingMoodle.push(r), false) : true));
  const base = {
    tz: deps.tz,
    threshold: deps.threshold,
    now,
    ...(deps.logger ? { logger: deps.logger } : {}),
  };
  const sideP = { ...base, calendar: deps.polito, remoteView: viewPolito };
  const sideM = { ...base, calendar: deps.moodle, remoteView: viewMoodle };

  // 1. Plan both calendars without writing.
  const dryP = await runSync(sideP, forPolito, { dryRun: true, force: false });
  const leavingP = [...leavingPolito];
  const dryM = await runSync(sideM, forMoodle, { dryRun: true, force: false });
  const leavingM = [...leavingMoodle];
  const moves = { toMoodle: leavingP.length, toPolito: leavingM.length };
  const plan = mergePlans(dryP.plan, dryM.plan);
  if (options.dryRun) {
    const error = dryP.error ?? dryM.error;
    return {
      status: 'dry-run',
      plan,
      options,
      moves,
      ...(error ? { error } : {}),
    };
  }

  // 2. Either calendar beyond its limit refuses the whole run (nothing is written, the refusal is recorded).
  if (!options.force && (dryP.plan.safety.exceeded || dryM.plan.safety.exceeded)) {
    const side = dryP.plan.safety.exceeded ? sideP : sideM;
    const res = dryP.plan.safety.exceeded ? forPolito : forMoodle;
    const refused = await runSync(
      { ...side, ...(deps.state ? { state: deps.state } : {}) },
      res,
      options,
    );
    return { ...refused, plan, moves };
  }

  // 3. Write: the Polito calendar, then the Moodle calendar (creates and patches), one history row for both.
  const run = deps.state ? sharedRun(deps.state) : undefined;
  const real = { ...(run ? { state: run.state } : {}) };
  const rp = await runSync({ ...sideP, ...real }, forPolito, options);
  const rm = rp.applied?.fatal
    ? undefined
    : await runSync({ ...sideM, ...real }, forMoodle, options);

  // 4. Moves: delete the old copy only where the new one is there.
  let moveFailures = 0;
  const wrote = (r: SyncReport | undefined) =>
    r !== undefined && (r.status === 'ok' || r.status === 'partial');
  const failedIds = (r: SyncReport | undefined) =>
    new Set(r?.applied?.failures.map((f) => f.googleId));
  const finishMoves = async (
    leaving: ManagedEvent[],
    from: OwnedCalendar,
    into: SyncReport | undefined,
  ): Promise<void> => {
    if (!wrote(into)) return;
    const bad = failedIds(into);
    for (const ev of leaving) {
      if (bad.has(ev.googleId)) continue;
      try {
        await from.delete(ev.googleId);
      } catch (err) {
        moveFailures++;
        deps.logger?.warn(
          { code: toUserError(err).code },
          'the old copy of a moved event was not deleted',
        );
      }
    }
  };
  await finishMoves(leavingP, deps.polito, rm);
  await finishMoves(leavingM, deps.moodle, rp);
  run?.finish(now());

  const applied = mergeApplied(rp.applied, rm?.applied);
  let status = worst(rp.status, rm?.status ?? rp.status);
  if (moveFailures > 0) status = worst(status, 'partial');
  const error = rp.error ?? rm?.error;
  deps.logger?.info(
    { status, movedToMoodle: moves.toMoodle, movedToPolito: moves.toPolito, moveFailures },
    'split sync finished',
  );
  const moodlePlan = rm?.plan ?? dryM.plan;
  const empty =
    merge &&
    moveFailures === 0 &&
    wrote(rp) &&
    moodlePlan.creates.length === 0 &&
    moodlePlan.patches.length === 0 &&
    moodlePlan.unchanged === 0 &&
    moodlePlan.deletes.length === 0 &&
    moodlePlan.untouched.length === 0 &&
    (rp.applied?.failures.length ?? 0) === 0;
  return {
    status,
    plan: mergePlans(rp.plan, moodlePlan),
    options,
    moves,
    ...(merge ? { moveBack: { empty } } : {}),
    ...(applied ? { applied } : {}),
    ...(error ? { error } : {}),
  };
}
