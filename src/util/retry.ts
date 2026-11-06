export interface RetryOptions {
  /** Total tries including the first. */
  attempts: number;
  baseMs: number;
  maxMs: number;
  shouldRetry: (err: unknown) => boolean;
  /** Server-requested delay (Retry-After), if any. */
  retryAfterMs?: (err: unknown) => number | undefined;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sequential retry with exponential backoff and jitter. Rethrows the last error. */
export async function retry<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
  const sleep = o.sleep ?? realSleep;
  const random = o.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= o.attempts || !o.shouldRetry(err)) throw err;
      const exponential = Math.min(o.maxMs, o.baseMs * 2 ** (attempt - 1));
      const jittered = Math.round(exponential * (0.5 + random() / 2));
      const requested = o.retryAfterMs?.(err);
      await sleep(Math.min(o.maxMs, Math.max(jittered, requested ?? 0)));
    }
  }
}
