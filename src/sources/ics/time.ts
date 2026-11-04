import { allProps, firstProp, type IcsComponent, type IcsProp } from './parse.js';
import { dayMs, parseRRule, recurrenceDays, ymd } from './rrule.js';

/** Wall-clock reading without a zone. */
export interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export class IcsTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcsTimeError';
  }
}

export type IcsValue =
  | { kind: 'date'; y: number; m: number; d: number }
  | { kind: 'utc'; ms: number }
  | { kind: 'local'; wall: Wall; tzid?: string };

const DATE = /^(\d{4})(\d{2})(\d{2})$/;
const DATETIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

export function wallToUtcFields(w: Wall): number {
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
}

/** Parses a DATE or DATE-TIME property value (TZID taken from the parameter). */
export function parseValue(prop: IcsProp): IcsValue {
  const raw = prop.value.trim();
  const dm = DATE.exec(raw);
  if (dm) {
    const [y, m, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
    if (ymd(dayMs(y, m, d)).d !== d) throw new IcsTimeError(`${prop.name} is not a real date`);
    return { kind: 'date', y, m, d };
  }
  const tm = DATETIME.exec(raw);
  if (!tm) throw new IcsTimeError(`${prop.name} is not a valid date or date-time`);
  const wall: Wall = {
    y: Number(tm[1]),
    m: Number(tm[2]),
    d: Number(tm[3]),
    h: Number(tm[4]),
    mi: Number(tm[5]),
    s: Math.min(Number(tm[6]), 59),
  };
  if (ymd(dayMs(wall.y, wall.m, wall.d)).d !== wall.d || wall.h > 23 || wall.mi > 59) {
    throw new IcsTimeError(`${prop.name} is not a real date-time`);
  }
  if (tm[7] === 'Z') return { kind: 'utc', ms: wallToUtcFields(wall) };
  const tzid = prop.params['TZID']?.[0];
  return { kind: 'local', wall, ...(tzid ? { tzid } : {}) };
}

export function isDateOnly(prop: IcsProp): boolean {
  return prop.params['VALUE']?.[0]?.toUpperCase() === 'DATE' || DATE.test(prop.value.trim());
}

/** Parses an ISO-8601 duration such as P1D, PT1H30M, P2W. Returns whole days and seconds. */
export function parseDuration(value: string): { days: number; seconds: number; sign: 1 | -1 } {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim().toUpperCase(),
  );
  if (!m) throw new IcsTimeError('DURATION is not valid');
  const n = (i: number) => Number(m[i] ?? 0);
  return {
    sign: m[1] === '-' ? -1 : 1,
    days: n(2) * 7 + n(3),
    seconds: n(4) * 3600 + n(5) * 60 + n(6),
  };
}

// ---------------------------------------------------------------------------------------------
// Zones. A zone is just "offset from UTC in seconds at a given instant".
// ---------------------------------------------------------------------------------------------

type OffsetAt = (utcMs: number) => number;

const formatters = new Map<string, Intl.DateTimeFormat>();

function ianaOffsetAt(tz: string): OffsetAt {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  const fmt = f;
  return (utcMs) => {
    const t = Math.floor(utcMs / 1000) * 1000;
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(
      Number(p['year']),
      Number(p['month']) - 1,
      Number(p['day']),
      Number(p['hour']),
      Number(p['minute']),
      Number(p['second']),
    );
    return Math.round((asUtc - t) / 1000);
  };
}

function isIana(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** libical writes "/vendor/path/Europe/Rome": try the trailing parts. */
function ianaCandidate(tzid: string): string | undefined {
  if (isIana(tzid)) return tzid;
  const parts = tzid.split('/').filter(Boolean);
  for (const n of [3, 2, 1]) {
    if (parts.length >= n) {
      const c = parts.slice(-n).join('/');
      if (c.includes('/') || n === 1) {
        if (isIana(c)) return c;
      }
    }
  }
  return undefined;
}

function offsetSeconds(v: string): number {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(v.trim());
  if (!m) throw new IcsTimeError('a VTIMEZONE offset is not valid');
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0));
}

/** Builds an offset function from the STANDARD/DAYLIGHT observances of a VTIMEZONE. */
function vtimezoneOffsetAt(vtz: IcsComponent, horizonYear: number): OffsetAt {
  const onsets: { utc: number; offsetFrom: number; offsetTo: number }[] = [];
  for (const obs of vtz.children) {
    if (obs.name !== 'STANDARD' && obs.name !== 'DAYLIGHT') continue;
    const dt = firstProp(obs, 'DTSTART');
    const from = firstProp(obs, 'TZOFFSETFROM');
    const to = firstProp(obs, 'TZOFFSETTO');
    if (!dt || !from || !to) throw new IcsTimeError('a VTIMEZONE observance is incomplete');
    const start = parseValue(dt);
    if (start.kind !== 'local') throw new IcsTimeError('a VTIMEZONE start must be a local time');
    const offsetFrom = offsetSeconds(from.value);
    const offsetTo = offsetSeconds(to.value);
    const wallMs = wallToUtcFields(start.wall);
    const timeOfDay = wallMs - dayMs(start.wall.y, start.wall.m, start.wall.d);
    const rrule = firstProp(obs, 'RRULE');
    const rdates = allProps(obs, 'RDATE');
    const days: number[] = [];
    if (rrule) {
      const rule = parseRRule(rrule.value);
      delete rule.until; // observance rules are bounded by the horizon instead
      const last = dayMs(horizonYear, 12, 31);
      for (const day of recurrenceDays(
        rule,
        dayMs(start.wall.y, start.wall.m, start.wall.d),
        last,
        400,
      )) {
        days.push(day);
      }
    } else {
      days.push(dayMs(start.wall.y, start.wall.m, start.wall.d));
    }
    for (const r of rdates) {
      for (const piece of r.value.split(',')) {
        const v = parseValue({ ...r, value: piece });
        if (v.kind === 'local') days.push(dayMs(v.wall.y, v.wall.m, v.wall.d));
      }
    }
    for (const day of days)
      onsets.push({ utc: day + timeOfDay - offsetFrom * 1000, offsetFrom, offsetTo });
  }
  if (onsets.length === 0) throw new IcsTimeError('a VTIMEZONE has no observances');
  onsets.sort((a, b) => a.utc - b.utc);
  return (utcMs) => {
    let current = (onsets[0] as (typeof onsets)[number]).offsetFrom;
    for (const o of onsets) {
      if (o.utc <= utcMs) current = o.offsetTo;
      else break;
    }
    return current;
  };
}

export interface ZoneResolver {
  /** Converts a wall-clock reading in `tzid` (or the default zone when absent) to a UTC instant. */
  toUtc(wall: Wall, tzid: string | undefined): number;
}

/**
 * RFC 5545 gap and overlap rules: a time that does not exist (spring forward) uses the offset
 * before the change; a time that happens twice (fall back) is the first occurrence.
 */
function wallToUtc(wall: Wall, offsetAt: OffsetAt): number {
  const w = wallToUtcFields(wall);
  const candidates = new Set<number>();
  for (const probe of [w - 86_400_000, w + 86_400_000]) {
    const off = offsetAt(probe);
    const utc = w - off * 1000;
    if (offsetAt(utc) === off) candidates.add(utc);
  }
  if (candidates.size > 0) return Math.min(...candidates);
  return w - offsetAt(w - 86_400_000) * 1000;
}

/**
 * `vtimezones` are the feed's VTIMEZONE components; IANA names are resolved by the runtime and
 * preferred, the feed's own rules are the fallback for names like "W. Europe Standard Time".
 */
export function createZoneResolver(
  vtimezones: readonly IcsComponent[],
  defaultTz: string,
  horizonYear: number,
): ZoneResolver {
  const cache = new Map<string, OffsetAt>();
  const lookup = (tzid: string): OffsetAt => {
    const hit = cache.get(tzid);
    if (hit) return hit;
    let fn: OffsetAt | undefined;
    const iana = ianaCandidate(tzid);
    if (iana) fn = ianaOffsetAt(iana);
    else {
      const vtz = vtimezones.find((v) => firstProp(v, 'TZID')?.value.trim() === tzid);
      if (vtz) fn = vtimezoneOffsetAt(vtz, horizonYear);
    }
    if (!fn) throw new IcsTimeError('an event uses a time zone this program does not know');
    cache.set(tzid, fn);
    return fn;
  };
  return {
    toUtc: (wall, tzid) => wallToUtc(wall, lookup(tzid ?? defaultTz)),
  };
}

export function utcCompact(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}
