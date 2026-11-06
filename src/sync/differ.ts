import type { ManagedEvent } from '../google/calendar.js';
import type { CanonicalEvent, SourceResult } from '../sources/types.js';
import { UserError } from '../util/errors.js';
import { googleEventId } from './mapper.js';

export interface PlannedChange {
  googleId: string;
  event: CanonicalEvent;
}

export interface PlannedDelete {
  googleId: string;
  remote: ManagedEvent;
}

export interface SafetyReport {
  /** Events we manage that belong to sources whose fetch fully succeeded (deletion candidates). */
  managedInScope: number;
  deletes: number;
  /** deletes / managedInScope, 0 if nothing is in scope. */
  ratio: number;
  threshold: number;
  /** True when the deletions would be refused without --force. */
  exceeded: boolean;
}

export interface Plan {
  creates: PlannedChange[];
  patches: PlannedChange[];
  deletes: PlannedDelete[];
  unchanged: number;
  /** Sources that returned `complete: false`: nothing of theirs is deleted. */
  incompleteSources: string[];
  /** Our events that this run does not judge (source not in this run, or not attributable). */
  untouched: ManagedEvent[];
  safety: SafetyReport;
}

function bySortKey<T>(key: (t: T) => string) {
  return (a: T, b: T) => key(a).localeCompare(key(b));
}

/**
 * Compares what the sources say should exist with what we previously wrote (events carrying our
 * marker). Pure function: no I/O.
 *
 * Deletions follow two rules from AGENTS.md: an event is a deletion candidate only if its source
 * returned a COMPLETE result, and the run is flagged `exceeded` when the candidates are more than
 * `threshold` of the managed events in that scope.
 */
export function diff(
  results: readonly SourceResult[],
  remote: readonly ManagedEvent[],
  threshold: number,
): Plan {
  const seenSources = new Set<string>();
  const desired = new Map<string, CanonicalEvent>();
  for (const r of results) {
    if (seenSources.has(r.source)) {
      throw new UserError({
        code: 'E_DUPLICATE_SOURCE_ID',
        what: `Two results were given for the source "${r.source}".`,
        why: 'The same source was fetched twice in one run, so one result would hide the other.',
        action: 'Nothing was written. Report it in an issue.',
      });
    }
    seenSources.add(r.source);
    for (const e of r.events) {
      if (e.source !== r.source) {
        throw new UserError({
          code: 'E_EVENT_INVALID',
          what: `An event (${e.source}:${e.sourceId}) was returned by source "${r.source}".`,
          why: 'A source adapter labelled an event with another source id.',
          action: 'Nothing was written. Report it in an issue.',
        });
      }
      const id = googleEventId(e.source, e.sourceId);
      if (desired.has(id)) {
        throw new UserError({
          code: 'E_DUPLICATE_SOURCE_ID',
          what: `Source "${e.source}" returned two events with the id "${e.sourceId}".`,
          why: 'The source has no stable id for them, or the adapter built ids badly; both would overwrite each other on every run.',
          action: 'Nothing was written. Report it in an issue (without the event text).',
        });
      }
      desired.set(id, e);
    }
  }

  const completeSources = new Set(results.filter((r) => r.complete).map((r) => r.source));
  const remoteById = new Map(remote.map((r) => [r.googleId, r]));

  const creates: PlannedChange[] = [];
  const patches: PlannedChange[] = [];
  let unchanged = 0;
  for (const [googleId, event] of desired) {
    const current = remoteById.get(googleId);
    if (!current) creates.push({ googleId, event });
    else if (current.hash !== event.hash) patches.push({ googleId, event });
    else unchanged++;
  }

  const deletes: PlannedDelete[] = [];
  const untouched: ManagedEvent[] = [];
  let managedInScope = 0;
  for (const r of remote) {
    const attributable =
      r.source !== undefined &&
      r.sourceId !== undefined &&
      googleEventId(r.source, r.sourceId) === r.googleId;
    if (!attributable || !completeSources.has(r.source as string)) {
      if (!desired.has(r.googleId)) untouched.push(r);
      continue;
    }
    managedInScope++;
    if (!desired.has(r.googleId)) deletes.push({ googleId: r.googleId, remote: r });
  }

  const ratio = managedInScope === 0 ? 0 : deletes.length / managedInScope;
  const order = (e: { start: string }, id: string) => `${e.start}|${id}`;
  return {
    creates: creates.sort(bySortKey((c) => order(c.event, c.googleId))),
    patches: patches.sort(bySortKey((c) => order(c.event, c.googleId))),
    deletes: deletes.sort(bySortKey((d) => `${d.remote.start ?? ''}|${d.googleId}`)),
    unchanged,
    incompleteSources: results.filter((r) => !r.complete).map((r) => r.source),
    untouched,
    safety: {
      managedInScope,
      deletes: deletes.length,
      ratio,
      threshold,
      exceeded: ratio > threshold,
    },
  };
}
