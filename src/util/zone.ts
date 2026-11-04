/** Offset (ms) of a time zone at an instant: wall time in the zone minus UTC. */
function zoneOffsetMs(tz: string, instantMs: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const wallAsUtc = Date.UTC(
    n('year'),
    n('month') - 1,
    n('day'),
    n('hour'),
    n('minute'),
    n('second'),
  );
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Turns a wall-clock time without a zone ("2027-02-14T14:30:00") into a UTC ISO string, reading it in
 * `tz`. In the autumn overlap the first occurrence wins, in the spring gap the time before the change is
 * used (same rule as decision 009). Returns undefined if the text is not such a time.
 */
export function zonedToUtcIso(naive: string, tz: string): string | undefined {
  const m = NAIVE.exec(naive);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(guess)) return undefined;
  const DAY = 86_400_000;
  const before = guess - zoneOffsetMs(tz, guess - DAY);
  const after = guess - zoneOffsetMs(tz, guess + DAY);
  const valid = [before, after].filter((utc) => guess - zoneOffsetMs(tz, utc) === utc);
  // Overlap: both readings exist, the first occurrence wins. Gap: none exists, use the offset before the change.
  const utc = valid.length > 0 ? Math.min(...valid) : before;
  return new Date(utc).toISOString();
}
