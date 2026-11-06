import { describe, expect, it } from 'vitest';
import type { ManagedEvent } from '../src/google/calendar.js';
import { diff } from '../src/sync/differ.js';
import { googleEventId } from '../src/sync/mapper.js';
import type { SourceResult } from '../src/sources/types.js';
import { event } from './support/helpers.js';

function managed(n: number, patch: Partial<ManagedEvent> = {}, source = 'ics'): ManagedEvent {
  const e = event(n, { source });
  return {
    googleId: googleEventId(source, `ev-${n}`),
    source,
    sourceId: `ev-${n}`,
    kind: 'lecture',
    hash: e.hash,
    ...patch,
  };
}
const result = (ns: number[], complete = true, source = 'ics'): SourceResult => ({
  source,
  complete,
  events: ns.map((n) => event(n, { source })),
});

describe('diff', () => {
  it('creates what is missing', () => {
    const plan = diff([result([1, 2])], [managed(1)], 0.3);
    expect(plan.creates.map((c) => c.event.sourceId)).toEqual(['ev-2']);
    expect(plan.unchanged).toBe(1);
    expect(plan.patches).toEqual([]);
    expect(plan.deletes).toEqual([]);
  });

  it('patches when the hash differs', () => {
    const plan = diff([result([1])], [managed(1, { hash: 'old' })], 0.3);
    expect(plan.patches.map((c) => c.event.sourceId)).toEqual(['ev-1']);
    expect(plan.unchanged).toBe(0);
  });

  it('is a no-op when nothing changed', () => {
    const plan = diff([result([1, 2, 3])], [managed(1), managed(2), managed(3)], 0.3);
    expect(plan).toMatchObject({ creates: [], patches: [], deletes: [], unchanged: 3 });
    expect(plan.safety.exceeded).toBe(false);
  });

  it('deletes events that disappeared from a complete source', () => {
    const plan = diff(
      [result([1, 2, 3, 4])],
      [managed(1), managed(2), managed(3), managed(4), managed(5)],
      0.3,
    );
    expect(plan.deletes.map((d) => d.remote.sourceId)).toEqual(['ev-5']);
    expect(plan.safety).toMatchObject({ managedInScope: 5, deletes: 1, exceeded: false });
  });

  it('never deletes for an incomplete source, but still creates and patches', () => {
    const plan = diff([result([1, 9], false)], [managed(1, { hash: 'old' }), managed(2)], 0.3);
    expect(plan.deletes).toEqual([]);
    expect(plan.incompleteSources).toEqual(['ics']);
    expect(plan.patches).toHaveLength(1);
    expect(plan.creates).toHaveLength(1);
    expect(plan.untouched.map((u) => u.sourceId)).toEqual(['ev-2']);
    expect(plan.safety.managedInScope).toBe(0);
  });

  it('does not judge events of sources that were not part of this run', () => {
    const plan = diff([result([1])], [managed(1), managed(7, {}, 'moodle')], 0.3);
    expect(plan.deletes).toEqual([]);
    expect(plan.untouched.map((u) => u.source)).toEqual(['moodle']);
  });

  it('leaves events with our marker but no source info alone', () => {
    const odd: ManagedEvent = { googleId: 'abc123' };
    const plan = diff([result([])], [odd], 0.3);
    expect(plan.deletes).toEqual([]);
    expect(plan.untouched).toEqual([odd]);
  });

  it('leaves an event whose id does not match its source/sourceId alone', () => {
    const odd = managed(1, { googleId: 'not-the-hash-of-it' });
    const plan = diff([result([])], [odd], 0.3);
    expect(plan.deletes).toEqual([]);
  });

  describe('deletion safety threshold', () => {
    const remote = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => managed(n));

    it('allows exactly the threshold (3 of 10 at 30%)', () => {
      const plan = diff([result([1, 2, 3, 4, 5, 6, 7])], remote, 0.3);
      expect(plan.safety).toMatchObject({ deletes: 3, managedInScope: 10, exceeded: false });
    });

    it('flags anything above it (4 of 10)', () => {
      const plan = diff([result([1, 2, 3, 4, 5, 6])], remote, 0.3);
      expect(plan.safety).toMatchObject({ deletes: 4, ratio: 0.4, exceeded: true });
    });

    it('flags an empty complete result when we manage events (feed went blank)', () => {
      const plan = diff([result([])], remote, 0.3);
      expect(plan.safety).toMatchObject({ deletes: 10, ratio: 1, exceeded: true });
    });

    it('counts only the scope of complete sources', () => {
      const mixed = [...remote, managed(1, {}, 'moodle'), managed(2, {}, 'moodle')];
      const plan = diff(
        [result([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), result([], false, 'moodle')],
        mixed,
        0.3,
      );
      expect(plan.safety).toMatchObject({ managedInScope: 10, deletes: 0, exceeded: false });
    });

    it('honours a stricter or a looser threshold', () => {
      const r = result([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(diff([r], remote, 0.05).safety.exceeded).toBe(true);
      expect(diff([result([1, 2, 3, 4, 5])], remote, 0.5).safety.exceeded).toBe(false);
    });

    it('is not exceeded when there is nothing to delete from', () => {
      expect(diff([result([1])], [], 0.3).safety).toMatchObject({ ratio: 0, exceeded: false });
    });
  });

  describe('invalid input', () => {
    it('rejects two events with the same source id', () => {
      const dup: SourceResult = {
        source: 'ics',
        complete: true,
        events: [event(1), event(1, { title: 'x' })],
      };
      expect(() => diff([dup], [], 0.3)).toThrowError(/E_DUPLICATE_SOURCE_ID/);
    });
    it('rejects two results for one source', () => {
      expect(() => diff([result([1]), result([2])], [], 0.3)).toThrowError(/E_DUPLICATE_SOURCE_ID/);
    });
    it('rejects an event labelled with a different source than its result', () => {
      const bad: SourceResult = { source: 'moodle', complete: true, events: [event(1)] };
      expect(() => diff([bad], [], 0.3)).toThrowError(/E_EVENT_INVALID/);
    });
  });

  it('orders the plan by start time so output is stable', () => {
    const plan = diff([result([3, 1, 2])], [], 0.3);
    expect(plan.creates.map((c) => c.event.sourceId)).toEqual(['ev-1', 'ev-2', 'ev-3']);
  });
});
