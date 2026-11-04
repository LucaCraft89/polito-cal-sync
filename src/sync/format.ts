import type { ManagedEvent } from '../google/calendar.js';
import type { CanonicalEvent, SourceResult } from '../sources/types.js';
import type { SyncReport } from './engine.js';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function clip(s: string, max: number): string {
  return s.length <= max ? s.padEnd(max) : `${s.slice(0, max - 1)}…`;
}

function dateTimeParts(iso: string, tz: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

/** "2026-11-12 09:00–11:00", "2026-11-20 (all day)", or a full range if it spans days. */
function when(start: string, end: string | undefined, allDay: boolean, tz: string): string {
  if (allDay) {
    return end && end !== start ? `${start} → ${end} (all day)` : `${start} (all day)`;
  }
  const s = dateTimeParts(start, tz);
  if (!end || end === start) return `${s.date} ${s.time}`;
  const e = dateTimeParts(end, tz);
  return s.date === e.date
    ? `${s.date} ${s.time}–${e.time}`
    : `${s.date} ${s.time} → ${e.date} ${e.time}`;
}

function describeCanonical(e: CanonicalEvent, tz: string): string {
  return `${clip(when(e.start, e.end, e.allDay, tz), 27)} ${clip(`[${e.kind}]`, 12)} ${clip(e.title, 36)} ${e.source}:${e.sourceId}`;
}

function describeManaged(m: ManagedEvent, tz: string): string {
  const dateOnly = m.start !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(m.start);
  const w = m.start ? when(m.start, undefined, dateOnly, tz) : '(unknown time)';
  const src = m.source ? `${m.source}:${m.sourceId ?? '?'}` : m.googleId;
  return `${clip(w, 27)} ${clip(`[${m.kind ?? '?'}]`, 12)} ${clip(m.summary ?? '(no title)', 36)} ${src}`;
}

export interface FormatContext {
  tz: string;
  calendarId: string;
  results: readonly SourceResult[];
  /** Printed first, e.g. the fixture-mode warning. */
  banner?: string;
  /** One line per feed / source detail, printed under "Sources". */
  sourceNotes?: readonly string[];
}

/** Human-readable plan / result. Contains event titles: print it to the user's terminal only, never to logs. */
export function formatReport(report: SyncReport, ctx: FormatContext): string {
  const { plan } = report;
  const lines: string[] = [];
  if (ctx.banner) lines.push(ctx.banner, '');
  lines.push(`Calendar: ${ctx.calendarId}`);
  lines.push(
    report.options.dryRun
      ? 'Mode: DRY RUN. Nothing is written to the calendar or to the history.'
      : `Mode: APPLY${report.options.force ? ' (--force: deletion limit overridden)' : ''}`,
  );
  lines.push('', 'Sources');
  for (const r of ctx.results) {
    lines.push(
      `  ${r.source.padEnd(8)} ${r.complete ? 'complete  ' : 'INCOMPLETE'} ${plural(r.events.length, 'event')}${r.complete ? '' : '  (no deletions for this source)'}`,
    );
  }
  if (ctx.results.length === 0) lines.push('  (none)');
  for (const note of ctx.sourceNotes ?? []) lines.push(`    ${note}`);

  lines.push('', report.options.dryRun ? 'Plan' : 'Plan (as computed before applying)');
  for (const c of plan.creates) lines.push(`  + create  ${describeCanonical(c.event, ctx.tz)}`);
  for (const c of plan.patches) lines.push(`  ~ update  ${describeCanonical(c.event, ctx.tz)}`);
  for (const d of plan.deletes) lines.push(`  - delete  ${describeManaged(d.remote, ctx.tz)}`);
  lines.push(`  = ${plan.unchanged} unchanged`);
  if (plan.untouched.length > 0) {
    lines.push(
      `  · ${plural(plan.untouched.length, 'event')} of ours left alone (their source is not part of this run, or its fetch was incomplete)`,
    );
  }

  const s = plan.safety;
  lines.push(
    '',
    s.managedInScope === 0
      ? 'Safety: no existing events of ours to delete from.'
      : `Safety: ${s.deletes} of ${s.managedInScope} events of ours would be removed (${pct(s.ratio)}); limit ${pct(s.threshold)} - ${s.exceeded ? 'EXCEEDED' : 'ok'}.`,
  );

  lines.push('');
  if (report.status === 'dry-run') {
    const verdict = `would create ${plan.creates.length}, update ${plan.patches.length}, delete ${plan.deletes.length}, keep ${plan.unchanged}`;
    if (report.error) {
      lines.push(`Result: ${verdict}.`, 'A real run would be REFUSED:', ...indent(report.error));
    } else {
      lines.push(`Result: ${verdict}. Run without --dry-run to apply.`);
    }
  } else if (report.status === 'refused') {
    lines.push('Result: REFUSED, nothing was changed.');
  } else if (report.applied) {
    const a = report.applied;
    lines.push(
      `Result (${report.status}): created ${a.created}, updated ${a.patched}, deleted ${a.deleted}, unchanged ${plan.unchanged}, failed ${a.failures.length}.`,
    );
    for (const f of a.failures) {
      lines.push(
        `  ! ${f.op} ${f.source ?? ''}:${f.sourceId ?? f.googleId} -> ${f.code} (see docs/ERRORS.md)`,
      );
    }
  }
  return lines.join('\n');
}

function indent(e: { code: string; what: string; why: string; action: string }): string[] {
  return [`  ${e.code}: ${e.what}`, `    Why: ${e.why}`, `    Do:  ${e.action}`];
}
