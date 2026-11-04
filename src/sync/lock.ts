import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { UserError } from '../util/errors.js';

/** A crashed run leaves its lock behind; after this long it is considered dead. */
export const LOCK_STALE_MS = 20 * 60_000;

export interface RunLock {
  release(): void;
}

/**
 * One sync at a time per data folder, across processes and containers (the scheduled `serve`
 * loop and a manual `sync` must not write the same calendar together).
 */
export function acquireRunLock(dataDir: string, now: () => Date = () => new Date()): RunLock {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'sync.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: now().toISOString() }));
      closeSync(fd);
      return {
        release: () => {
          try {
            unlinkSync(path);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let ageMs: number;
      try {
        // The time written inside follows the injected clock; the file time is the fallback.
        let writtenAt = statSync(path).mtimeMs;
        try {
          const at = Date.parse(
            (JSON.parse(readFileSync(path, 'utf8')) as { at?: string }).at ?? '',
          );
          if (!Number.isNaN(at)) writtenAt = at;
        } catch {
          /* unreadable content: keep the file time */
        }
        ageMs = now().getTime() - writtenAt;
      } catch {
        continue; // vanished in between: try again
      }
      if (ageMs > LOCK_STALE_MS) {
        try {
          unlinkSync(path);
        } catch {
          /* someone else took it */
        }
        continue;
      }
      break;
    }
  }
  throw new UserError({
    code: 'E_SYNC_ALREADY_RUNNING',
    what: 'Another sync is running on this data folder, so this one did not start.',
    why: 'The scheduled loop or a manual sync is working right now.',
    action: 'Wait a minute and try again.',
  });
}
