/**
 * RRULE expansion on calendar days. Pure date arithmetic on "local" days (no time zones here):
 * the caller combines each yielded day with the event's wall-clock time and zone, which is what
 * keeps a 09:00 lecture at 09:00 across the daylight-saving change.
 *
 * Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (with ordinals in
 * MONTHLY, and in YEARLY together with BYMONTH), BYMONTHDAY, BYMONTH, BYSETPOS, WKST.
 * Anything else (HOURLY/MINUTELY/SECONDLY, BYWEEKNO, BYYEARDAY, BYHOUR...) throws
 * RRuleUnsupported so the caller can mark the feed incomplete instead of guessing.
 */

export class RRuleUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RRuleUnsupported';
  }
}

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface ByDay {
  /** Ordinal within the month (1, -1, ...), absent for "every such weekday". */
  n?: number;
  /** 0 = Sunday ... 6 = Saturday. */
  wd: number;
}

export interface RRule {
  freq: Freq;
  interval: number;
  count?: number;
  /** Raw UNTIL value; the caller resolves it to an instant. */
  until?: string;
  byDay: ByDay[];
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  wkst: number;
}

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY_MS = 86_400_000;
const MAX_PERIODS = 200_000;

/** Days are UTC-midnight milliseconds, only used as a day counter. */
export function dayMs(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

export function ymd(ms: number): { y: number; m: number; d: number } {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function weekday(ms: number): number {
  return new Date(ms).getUTCDay();
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function intList(raw: string, what: string, min: number, max: number): number[] {
  return raw.split(',').map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) < min || Math.abs(n) > max) {
      throw new RRuleUnsupported(`${what} has a value this program cannot read`);
    }
    return n;
  });
}

export function parseRRule(value: string): RRule {
  const rule: RRule = {
    freq: 'DAILY',
    interval: 1,
    byDay: [],
    byMonthDay: [],
    byMonth: [],
    bySetPos: [],
    wkst: 1,
  };
  let hasFreq = false;
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const val = part.slice(eq + 1).trim();
    switch (key) {
      case 'FREQ':
        if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(val.toUpperCase())) {
          throw new RRuleUnsupported(`FREQ=${val.toUpperCase()} is not supported`);
        }
        rule.freq = val.toUpperCase() as Freq;
        hasFreq = true;
        break;
      case 'INTERVAL': {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 1000) throw new RRuleUnsupported('bad INTERVAL');
        rule.interval = n;
        break;
      }
      case 'COUNT': {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1) throw new RRuleUnsupported('bad COUNT');
        rule.count = n;
        break;
      }
      case 'UNTIL':
        rule.until = val;
        break;
      case 'BYDAY':
        rule.byDay = val.split(',').map((tok) => {
          const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(tok.trim());
          if (!m) throw new RRuleUnsupported('bad BYDAY');
          const wd = WEEKDAYS[(m[2] as string).toUpperCase()] as number;
          return m[1] ? { n: Number(m[1]), wd } : { wd };
        });
        break;
      case 'BYMONTHDAY':
        rule.byMonthDay = intList(val, 'BYMONTHDAY', 1, 31);
        break;
      case 'BYMONTH':
        rule.byMonth = intList(val, 'BYMONTH', 1, 12);
        break;
      case 'BYSETPOS':
        rule.bySetPos = intList(val, 'BYSETPOS', 1, 366);
        break;
      case 'WKST': {
        const wd = WEEKDAYS[val.toUpperCase()];
        if (wd === undefined) throw new RRuleUnsupported('bad WKST');
        rule.wkst = wd;
        break;
      }
      default:
        throw new RRuleUnsupported(`${key} is not supported`);
    }
  }
  if (!hasFreq) throw new RRuleUnsupported('RRULE has no FREQ');
  if (rule.count !== undefined && rule.until !== undefined) {
    throw new RRuleUnsupported('COUNT and UNTIL together are not allowed by RFC 5545');
  }
  if (rule.freq !== 'MONTHLY' && rule.freq !== 'YEARLY' && rule.byDay.some((b) => b.n)) {
    throw new RRuleUnsupported('a BYDAY ordinal needs FREQ=MONTHLY or YEARLY');
  }
  if (rule.freq === 'YEARLY' && rule.byMonth.length === 0 && rule.byDay.some((b) => b.n)) {
    throw new RRuleUnsupported('a YEARLY BYDAY ordinal without BYMONTH is not supported');
  }
  return rule;
}

/** Days of month `m` in year `y` that match BYDAY (with or without ordinals). */
function weekdaysInMonth(y: number, m: number, byDay: ByDay[]): number[] {
  const n = daysInMonth(y, m);
  const out: number[] = [];
  for (const b of byDay) {
    const all: number[] = [];
    for (let d = 1; d <= n; d++) if (weekday(dayMs(y, m, d)) === b.wd) all.push(d);
    if (b.n === undefined) out.push(...all);
    else {
      const pick = b.n > 0 ? all[b.n - 1] : all[all.length + b.n];
      if (pick !== undefined) out.push(pick);
    }
  }
  return out;
}

function monthDays(y: number, m: number, rule: RRule, dtDay: number): number[] {
  const n = daysInMonth(y, m);
  const fromMonthDay = rule.byMonthDay
    .map((d) => (d > 0 ? d : n + d + 1))
    .filter((d) => d >= 1 && d <= n);
  if (rule.byDay.length > 0 && rule.byMonthDay.length > 0) {
    const wd = new Set(weekdaysInMonth(y, m, rule.byDay));
    return fromMonthDay.filter((d) => wd.has(d));
  }
  if (rule.byDay.length > 0) return weekdaysInMonth(y, m, rule.byDay);
  if (rule.byMonthDay.length > 0) return fromMonthDay;
  return dtDay <= n ? [dtDay] : [];
}

function applySetPos(days: number[], setPos: number[]): number[] {
  if (setPos.length === 0) return days;
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const out: number[] = [];
  for (const p of setPos) {
    const pick = p > 0 ? sorted[p - 1] : sorted[sorted.length + p];
    if (pick !== undefined) out.push(pick);
  }
  return out;
}

/** Candidate days (UTC-midnight ms) of one period, unsorted, may include days before DTSTART. */
function periodCandidates(
  rule: RRule,
  start: number,
  k: number,
): { days: number[]; first: number } {
  const { y: sy, m: sm, d: sd } = ymd(start);
  const step = k * rule.interval;
  switch (rule.freq) {
    case 'DAILY': {
      const day = start + step * DAY_MS;
      const wd = rule.byDay.map((b) => b.wd);
      const { m, d } = ymd(day);
      const ok =
        (wd.length === 0 || wd.includes(weekday(day))) &&
        (rule.byMonth.length === 0 || rule.byMonth.includes(m)) &&
        (rule.byMonthDay.length === 0 ||
          rule.byMonthDay.some((x) => (x > 0 ? x : daysInMonth(ymd(day).y, m) + x + 1) === d));
      return { days: ok ? [day] : [], first: day };
    }
    case 'WEEKLY': {
      const back = (weekday(start) - rule.wkst + 7) % 7;
      const weekStart = start - back * DAY_MS + step * 7 * DAY_MS;
      const wds = rule.byDay.length > 0 ? rule.byDay.map((b) => b.wd) : [weekday(start)];
      const days: number[] = [];
      for (let i = 0; i < 7; i++) {
        const day = weekStart + i * DAY_MS;
        if (
          wds.includes(weekday(day)) &&
          (rule.byMonth.length === 0 || rule.byMonth.includes(ymd(day).m))
        ) {
          days.push(day);
        }
      }
      return { days: applySetPos(days, rule.bySetPos), first: weekStart };
    }
    case 'MONTHLY': {
      const idx = sy * 12 + (sm - 1) + step;
      const y = Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      const first = dayMs(y, m, 1);
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(m)) return { days: [], first };
      const ds = applySetPos(monthDays(y, m, rule, sd), rule.bySetPos);
      return { days: ds.map((d) => dayMs(y, m, d)), first };
    }
    case 'YEARLY': {
      const y = sy + step;
      const months = rule.byMonth.length > 0 ? rule.byMonth : [sm];
      const days: number[] = [];
      for (const m of months) {
        for (const d of monthDays(y, m, rule, sd)) days.push(dayMs(y, m, d));
      }
      days.sort((a, b) => a - b);
      return {
        days: rule.bySetPos.length > 0 ? pickPositions(days, rule.bySetPos) : days,
        first: dayMs(y, 1, 1),
      };
    }
  }
}

function pickPositions(sorted: number[], setPos: number[]): number[] {
  const out: number[] = [];
  for (const p of setPos) {
    const pick = p > 0 ? sorted[p - 1] : sorted[sorted.length + p];
    if (pick !== undefined) out.push(pick);
  }
  return out;
}

/**
 * Yields the days of the recurrence set in ascending order: DTSTART's day first (always an
 * instance), then the days the rule produces. COUNT counts every yielded day (EXDATE and
 * overrides are applied by the caller afterwards, as RFC 5545 requires). Stops after `lastDay`.
 * `maxInstances` bounds a runaway rule.
 */
export function* recurrenceDays(
  rule: RRule,
  startDay: number,
  lastDay: number,
  maxInstances = 5000,
): Generator<number> {
  let yielded = 0;
  const emit = (): boolean => {
    yielded++;
    return rule.count !== undefined && yielded >= rule.count;
  };
  yield startDay;
  if (emit()) return;

  for (let k = 0; k < MAX_PERIODS; k++) {
    const { days, first } = periodCandidates(rule, startDay, k);
    if (first > lastDay) return;
    for (const day of [...new Set(days)].sort((a, b) => a - b)) {
      if (day <= startDay) continue;
      if (day > lastDay) return;
      yield day;
      if (emit() || yielded >= maxInstances) return;
    }
  }
}
