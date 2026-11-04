import { describe, expect, it } from 'vitest';
import { retry } from '../src/util/retry.js';

const base = { baseMs: 100, maxMs: 1000, random: () => 1, shouldRetry: () => true };

describe('retry', () => {
  it('backs off exponentially up to maxMs and rethrows the last error', async () => {
    const sleeps: number[] = [];
    let n = 0;
    await expect(
      retry(
        () => {
          n++;
          return Promise.reject(new Error(`fail ${n}`));
        },
        { ...base, attempts: 6, sleep: (ms) => (sleeps.push(ms), Promise.resolve()) },
      ),
    ).rejects.toThrow('fail 6');
    expect(sleeps).toEqual([100, 200, 400, 800, 1000]);
  });

  it('applies jitter between 50% and 100%', async () => {
    const sleeps: number[] = [];
    let n = 0;
    await retry(() => (++n < 2 ? Promise.reject(new Error('x')) : Promise.resolve('ok')), {
      ...base,
      attempts: 3,
      random: () => 0,
      sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
    });
    expect(sleeps).toEqual([50]);
  });

  it('does not retry when shouldRetry says no', async () => {
    let n = 0;
    await expect(
      retry(() => (n++, Promise.reject(new Error('nope'))), {
        ...base,
        attempts: 5,
        shouldRetry: () => false,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow('nope');
    expect(n).toBe(1);
  });
});
