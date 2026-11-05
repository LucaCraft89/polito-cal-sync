/**
 * "Not more often than" for actions that contact someone else's server (docs/UI.md section 4, decision 028).
 * Counted per key from the START of the last attempt (a failed attempt costs traffic too), plus an optional
 * cap over all keys in a window. A refused request costs no traffic and is not counted.
 */
export class RateGate {
  private readonly last = new Map<string, number>();
  private recent: number[] = [];

  constructor(
    private readonly o: {
      minIntervalMs: number;
      now: () => number;
      /** At most this many starts over all keys within `windowMs`. */
      globalMax?: number;
      windowMs?: number;
    },
  ) {}

  /** Milliseconds until `key` may start again; 0 when it may start now. */
  waitMs(key: string): number {
    const now = this.o.now();
    const own = this.last.get(key);
    let wait = own === undefined ? 0 : Math.max(0, own + this.o.minIntervalMs - now);
    if (this.o.globalMax !== undefined) {
      const win = this.o.windowMs ?? this.o.minIntervalMs;
      const inWindow = this.recent.filter((t) => t > now - win);
      if (inWindow.length >= this.o.globalMax) {
        wait = Math.max(wait, (inWindow[inWindow.length - this.o.globalMax] ?? now) + win - now);
      }
    }
    return wait;
  }

  start(key: string): void {
    const now = this.o.now();
    this.last.set(key, now);
    this.recent.push(now);
    const keep = Math.max(this.o.minIntervalMs, this.o.windowMs ?? 0);
    this.recent = this.recent.filter((t) => t > now - keep);
    for (const [k, t] of this.last) if (t <= now - this.o.minIntervalMs) this.last.delete(k);
  }
}
