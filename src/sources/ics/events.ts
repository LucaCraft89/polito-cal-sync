import { createHash } from 'node:crypto';
import { toCanonical } from '../../sync/mapper.js';
import type { CanonicalEvent, EventDraft } from '../types.js';
import {
  allProps,
  firstProp,
  parseIcs,
  unescapeText,
  type IcsComponent,
  type IcsProp,
} from './parse.js';
import { dayMs, parseRRule, recurrenceDays, RRuleUnsupported, ymd, type RRule } from './rrule.js';
import {
  createZoneResolver,
  IcsTimeError,
  parseDuration,
  parseValue,
  utcCompact,
  type IcsValue,
  type Wall,
  type ZoneResolver,
} from './time.js';

const DAY_MS = 86_400_000;
const MAX_INSTANCES = 5000;
const SOURCE = 'ics';

export interface ExpandOptions {
  /** Zone for floating times (no TZID, no Z). */
  defaultTz: string;
  /** Only occurrences that overlap [windowStart, windowEnd] are returned. */
  windowStart: Date;
  windowEnd: Date;
}

export interface FeedEvents {
  events: CanonicalEvent[];
  /**
   * Things in the feed this program could not handle. Contains positions and reasons only, never
   * event text. Any issue makes the feed "incomplete", so nothing is deleted because of it.
   */
  issues: string[];
  /** CANCELLED events and occurrences that were left out on purpose. */
  cancelled: number;
}

interface Times {
  allDay: boolean;
  /** UTC milliseconds (timed) or UTC-midnight day (all-day, last day inclusive for `end`). */
  start: number;
  end: number;
  /** Timed only: wall clock of DTSTART and its zone, to generate later occurrences. */
  wall?: Wall;
  tzid?: string;
}

function text(c: IcsComponent, name: string): string | undefined {
  const p = firstProp(c, name);
  return p ? unescapeText(p.value).trim() : undefined;
}

function isCancelled(c: IcsComponent): boolean {
  return (text(c, 'STATUS') ?? '').toUpperCase() === 'CANCELLED';
}

function wallOf(ms: number): Wall {
  const d = new Date(ms);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

function resolveInstant(v: IcsValue, zones: ZoneResolver): number {
  if (v.kind === 'utc') return v.ms;
  if (v.kind === 'local') return zones.toUtc(v.wall, v.tzid);
  return dayMs(v.y, v.m, v.d);
}

/** DTSTART/DTEND/DURATION of one VEVENT, in absolute terms. DTEND of an all-day event is exclusive in ICS. */
function resolveTimes(ev: IcsComponent, zones: ZoneResolver): Times {
  const dtstart = firstProp(ev, 'DTSTART');
  if (!dtstart) throw new IcsTimeError('an event has no DTSTART');
  const startV = parseValue(dtstart);
  const dtend = firstProp(ev, 'DTEND');
  const duration = firstProp(ev, 'DURATION');

  if (startV.kind === 'date') {
    const startDay = dayMs(startV.y, startV.m, startV.d);
    let endDay = startDay;
    if (dtend) {
      const endV = parseValue(dtend);
      if (endV.kind !== 'date') throw new IcsTimeError('DTSTART is a date but DTEND is not');
      endDay = Math.max(startDay, dayMs(endV.y, endV.m, endV.d) - DAY_MS); // exclusive -> inclusive
    } else if (duration) {
      const dur = parseDuration(duration.value);
      endDay = startDay + Math.max(1, dur.days) * DAY_MS - DAY_MS;
    }
    return { allDay: true, start: startDay, end: endDay };
  }

  const tzid = startV.kind === 'utc' ? 'UTC' : startV.tzid;
  const wall = startV.kind === 'utc' ? wallOf(startV.ms) : startV.wall;
  const start = resolveInstant(startV, zones);
  let end = start;
  if (dtend) {
    const endV = parseValue(dtend);
    if (endV.kind === 'date') throw new IcsTimeError('DTSTART has a time but DTEND is a date');
    end = Math.max(start, resolveInstant(endV, zones));
  } else if (duration) {
    const dur = parseDuration(duration.value);
    // Nominal days keep the wall-clock time across a DST change.
    const shifted = dur.days
      ? zones.toUtc({ ...wall, d: wall.d + dur.sign * dur.days }, tzid)
      : start;
    end = Math.max(start, shifted + dur.sign * dur.seconds * 1000);
  }
  return { allDay: false, start, end, wall, ...(tzid ? { tzid } : {}) };
}

function occurrenceKey(allDay: boolean, start: number): string {
  return allDay ? new Date(start).toISOString().slice(0, 10).replace(/-/g, '') : utcCompact(start);
}

/** Key of a RECURRENCE-ID / EXDATE / RDATE value, comparable with `occurrenceKey`. */
function valueKey(prop: IcsProp, piece: string, zones: ZoneResolver): string {
  const v = parseValue({ ...prop, value: piece });
  const start = resolveInstant(v, zones);
  return occurrenceKey(v.kind === 'date', start);
}

function splitValues(prop: IcsProp): string[] {
  return prop.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function sourceIdFor(uid: string, key: string | undefined): string {
  const base =
    uid.length > 400 ? `h:${createHash('sha256').update(uid).digest('hex').slice(0, 40)}` : uid;
  return key ? `${base}#${key}` : base;
}

function safeUrl(raw: string | undefined): string | undefined {
  if (!raw || raw.length > 1000 || !URL.canParse(raw)) return undefined;
  const proto = new URL(raw).protocol;
  return proto === 'http:' || proto === 'https:' ? raw : undefined;
}

function toDraft(c: IcsComponent, t: Times, sourceId: string): EventDraft {
  const title = (text(c, 'SUMMARY') ?? '').slice(0, 300) || '(no title)';
  const location = text(c, 'LOCATION')?.slice(0, 1000);
  const description = text(c, 'DESCRIPTION')?.slice(0, 20_000);
  const url = safeUrl(firstProp(c, 'URL')?.value.trim());
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    source: SOURCE,
    sourceId,
    kind: 'lecture',
    title,
    allDay: t.allDay,
    start: t.allDay ? iso(t.start).slice(0, 10) : iso(t.start),
    end: t.allDay ? iso(t.end).slice(0, 10) : iso(t.end),
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
    ...(url ? { url } : {}),
  };
}

interface VEvent {
  comp: IcsComponent;
  index: number;
  uid: string;
}

/**
 * Turns the text of one feed into canonical events for a time window.
 * Handles TZID/VTIMEZONE, floating and UTC times, all-day events, RRULE/RDATE/EXDATE,
 * RECURRENCE-ID overrides and cancelled events. Never throws for content problems: it records
 * them in `issues` and carries on with the rest of the feed. Throws IcsParseError only if the
 * text is not iCalendar at all.
 */
export function eventsFromIcs(icsText: string, o: ExpandOptions): FeedEvents {
  const roots = parseIcs(icsText);
  const calendars = roots.filter((r) => r.name === 'VCALENDAR');
  const vtimezones = calendars.flatMap((c) => c.children.filter((x) => x.name === 'VTIMEZONE'));
  const zones = createZoneResolver(vtimezones, o.defaultTz, o.windowEnd.getUTCFullYear() + 1);
  const vevents = calendars.flatMap((c) => c.children.filter((x) => x.name === 'VEVENT'));

  const issues: string[] = [];
  let cancelled = 0;
  const found = new Map<string, CanonicalEvent>();
  const winStart = o.windowStart.getTime();
  const winEnd = o.windowEnd.getTime();

  const inWindow = (t: Times): boolean =>
    t.allDay
      ? t.end + DAY_MS >= winStart && t.start <= winEnd
      : t.end >= winStart && t.start <= winEnd;

  const emit = (c: IcsComponent, t: Times, sourceId: string, index: number): void => {
    if (!inWindow(t)) return;
    try {
      const event = toCanonical(toDraft(c, t, sourceId));
      if (!found.has(sourceId)) found.set(sourceId, event);
    } catch {
      issues.push(`event #${index}: its fields could not be turned into a calendar event`);
    }
  };

  // Group by UID. Index is the 1-based position in the feed, used in messages instead of text.
  const byUid = new Map<string, { masters: VEvent[]; overrides: VEvent[] }>();
  vevents.forEach((comp, i) => {
    const uid = text(comp, 'UID');
    if (!uid) {
      issues.push(`event #${i + 1}: it has no UID, so it has no stable identity`);
      return;
    }
    const g = byUid.get(uid) ?? { masters: [], overrides: [] };
    byUid.set(uid, g);
    (firstProp(comp, 'RECURRENCE-ID') ? g.overrides : g.masters).push({ comp, index: i + 1, uid });
  });

  for (const [uid, group] of byUid) {
    // Several versions of the same event: keep the highest SEQUENCE, the later one on a tie.
    const seq = (e: VEvent) => Number(text(e.comp, 'SEQUENCE') ?? 0) || 0;
    const master = group.masters.reduce<VEvent | undefined>(
      (best, e) => (best === undefined || seq(e) >= seq(best) ? e : best),
      undefined,
    );
    const overrideKeys = new Set<string>();

    for (const ov of group.overrides) {
      try {
        const rid = firstProp(ov.comp, 'RECURRENCE-ID') as IcsProp;
        if (rid.params['RANGE']?.[0]?.toUpperCase() === 'THISANDFUTURE') {
          throw new RRuleUnsupported('RECURRENCE-ID with RANGE=THISANDFUTURE is not supported');
        }
        const key = valueKey(rid, rid.value, zones);
        overrideKeys.add(key);
        if (isCancelled(ov.comp)) {
          cancelled++;
          continue;
        }
        emit(ov.comp, resolveTimes(ov.comp, zones), sourceIdFor(uid, key), ov.index);
      } catch (err) {
        issues.push(`event #${ov.index}: ${reason(err)}`);
      }
    }

    if (!master) continue;
    try {
      if (isCancelled(master.comp)) {
        cancelled++;
        continue;
      }
      const times = resolveTimes(master.comp, zones);
      const rrule = firstProp(master.comp, 'RRULE');
      const rdates = allProps(master.comp, 'RDATE');
      if (!rrule && rdates.length === 0) {
        emit(master.comp, times, sourceIdFor(uid, undefined), master.index);
        continue;
      }

      const exKeys = new Set<string>();
      const exDays = new Set<string>();
      for (const ex of allProps(master.comp, 'EXDATE')) {
        for (const piece of splitValues(ex)) {
          const v = parseValue({ ...ex, value: piece });
          if (v.kind === 'date' && !times.allDay)
            exDays.add(occurrenceKey(true, dayMs(v.y, v.m, v.d)));
          else exKeys.add(valueKey(ex, piece, zones));
        }
      }

      const rule: RRule | undefined = rrule ? parseRRule(rrule.value) : undefined;
      const span = times.end - times.start;
      const instances = new Map<string, Times>();
      const add = (t: Times): void => {
        const key = occurrenceKey(t.allDay, t.start);
        const w = t.wall ?? wallOf(t.start);
        const dayKey = occurrenceKey(true, t.allDay ? t.start : dayMs(w.y, w.m, w.d));
        if (exKeys.has(key) || exDays.has(dayKey) || overrideKeys.has(key)) return;
        if (!instances.has(key)) instances.set(key, t);
      };

      if (times.allDay) {
        // The yielded days are all-day starts; the span (in days) is kept.
        const startDay = times.start;
        const untilDay = rule?.until ? untilBound(rule.until, times, zones) : Infinity;
        if (rule) {
          let n = 0;
          for (const day of recurrenceDays(rule, startDay, winEnd + 2 * DAY_MS, MAX_INSTANCES)) {
            n++;
            if (day > untilDay) break;
            add({ allDay: true, start: day, end: day + span });
          }
          if (n >= MAX_INSTANCES)
            throw new RRuleUnsupported('the recurrence produces too many events');
        } else add(times);
        for (const r of rdates) {
          for (const piece of splitValues(r)) {
            const v = parseValue({ ...r, value: piece });
            if (v.kind !== 'date')
              throw new IcsTimeError('RDATE does not match the all-day DTSTART');
            const day = dayMs(v.y, v.m, v.d);
            add({ allDay: true, start: day, end: day + span });
          }
        }
      } else {
        const wall = times.wall as Wall;
        const untilMs = rule?.until ? untilBound(rule.until, times, zones) : Infinity;
        const startDay = dayMs(wall.y, wall.m, wall.d);
        if (rule) {
          let n = 0;
          for (const day of recurrenceDays(rule, startDay, winEnd + 2 * DAY_MS, MAX_INSTANCES)) {
            n++;
            const d = ymd(day);
            const start = zones.toUtc({ ...wall, y: d.y, m: d.m, d: d.d }, times.tzid);
            if (start > untilMs || start > winEnd + DAY_MS) break;
            add({ ...times, start, end: start + span, wall: { ...wall, y: d.y, m: d.m, d: d.d } });
          }
          if (n >= MAX_INSTANCES)
            throw new RRuleUnsupported('the recurrence produces too many events');
        } else add(times);
        for (const r of rdates) {
          if (r.params['VALUE']?.[0]?.toUpperCase() === 'PERIOD') {
            throw new RRuleUnsupported('RDATE with PERIOD is not supported');
          }
          for (const piece of splitValues(r)) {
            const v = parseValue({ ...r, value: piece });
            if (v.kind === 'date') throw new IcsTimeError('RDATE does not match the timed DTSTART');
            const start = resolveInstant(v, zones);
            add({
              ...times,
              start,
              end: start + span,
              wall: v.kind === 'local' ? v.wall : wallOf(start),
            });
          }
        }
      }
      for (const [key, t] of instances) emit(master.comp, t, sourceIdFor(uid, key), master.index);
    } catch (err) {
      issues.push(`event #${master.index}: ${reason(err)}`);
    }
  }

  const events = [...found.values()].sort(
    (a, b) => a.start.localeCompare(b.start) || a.sourceId.localeCompare(b.sourceId),
  );
  return { events, issues, cancelled };
}

/** UNTIL as a bound comparable with the occurrence starts (ms for timed, day for all-day). */
function untilBound(raw: string, times: Times, zones: ZoneResolver): number {
  const v = parseValue({ name: 'UNTIL', params: {}, value: raw });
  if (times.allDay) return v.kind === 'date' ? dayMs(v.y, v.m, v.d) : resolveInstant(v, zones);
  if (v.kind === 'date') return dayMs(v.y, v.m, v.d) + DAY_MS - 1; // the whole last day counts
  if (v.kind === 'local') return zones.toUtc(v.wall, times.tzid);
  return v.ms;
}

function reason(err: unknown): string {
  if (err instanceof RRuleUnsupported) return `unsupported recurrence (${err.message})`;
  if (err instanceof IcsTimeError) return `unreadable time (${err.message})`;
  return 'it could not be read';
}
