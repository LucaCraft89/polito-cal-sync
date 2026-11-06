import type { OwnedCalendar } from '../google/calendar.js';
import { toUserError, type ErrorCode, type UserError } from '../util/errors.js';
import type { Plan } from './differ.js';
import { toGoogleEvent } from './mapper.js';
import type { AppliedRow } from './state.js';

export interface Failure {
  op: 'create' | 'patch' | 'delete';
  googleId: string;
  source?: string;
  sourceId?: string;
  code: ErrorCode;
}

export interface ApplyResult {
  created: number;
  patched: number;
  deleted: number;
  failures: Failure[];
  /** For the state mirror. */
  applied: AppliedRow[];
  removed: string[];
  /** Set if the run was stopped early because continuing cannot work (auth, quota, outage). */
  fatal?: UserError;
}

/** If one of these happens, every following call would fail the same way: stop the run. */
const FATAL_CODES = new Set<ErrorCode>([
  'E_GOOGLE_AUTH_EXPIRED',
  'E_GOOGLE_PERMISSION_DENIED',
  'E_GOOGLE_CALENDAR_NOT_FOUND',
  'E_GOOGLE_QUOTA',
  'E_GOOGLE_UNAVAILABLE',
  'E_INTERNAL',
]);

/**
 * Executes a plan one call at a time (no parallel hammering): creates, then patches, then
 * deletes, so an aborted run leaves the calendar with too much rather than too little.
 * A failure of one event is recorded and the run goes on, unless the error is fatal.
 */
export async function applyPlan(
  plan: Plan,
  calendar: OwnedCalendar,
  tz: string,
): Promise<ApplyResult> {
  const result: ApplyResult = {
    created: 0,
    patched: 0,
    deleted: 0,
    failures: [],
    applied: [],
    removed: [],
  };

  const attempt = async <T>(
    op: Failure['op'],
    googleId: string,
    ident: { source: string; sourceId: string } | undefined,
    run: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> => {
    try {
      return { ok: true, value: await run() };
    } catch (err) {
      const e = toUserError(err);
      result.failures.push({
        op,
        googleId,
        // Only the ids: event text is personal data and must not end up in history or logs.
        ...(ident ? { source: ident.source, sourceId: ident.sourceId } : {}),
        code: e.code,
      });
      if (FATAL_CODES.has(e.code)) result.fatal = e;
      return { ok: false };
    }
  };

  for (const { googleId, event } of plan.creates) {
    if (result.fatal) break;
    const r = await attempt('create', googleId, event, () =>
      calendar.create(
        toGoogleEvent(event, tz) as ReturnType<typeof toGoogleEvent> & { id: string },
      ),
    );
    if (r.ok) {
      result.created++;
      result.applied.push({
        googleId,
        source: event.source,
        sourceId: event.sourceId,
        kind: event.kind,
        hash: event.hash,
      });
    }
  }

  for (const { googleId, event } of plan.patches) {
    if (result.fatal) break;
    const r = await attempt('patch', googleId, event, () =>
      calendar.patch(googleId, toGoogleEvent(event, tz)),
    );
    if (r.ok) {
      if (r.value === 'created') result.created++;
      else result.patched++;
      result.applied.push({
        googleId,
        source: event.source,
        sourceId: event.sourceId,
        kind: event.kind,
        hash: event.hash,
      });
    }
  }

  for (const { googleId, remote } of plan.deletes) {
    if (result.fatal) break;
    const ident =
      remote.source !== undefined && remote.sourceId !== undefined
        ? { source: remote.source, sourceId: remote.sourceId }
        : undefined;
    const r = await attempt('delete', googleId, ident, () => calendar.delete(googleId));
    if (r.ok) {
      result.deleted++;
      result.removed.push(googleId);
    }
  }

  return result;
}
