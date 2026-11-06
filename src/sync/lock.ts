import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { UserError } from '../util/errors.js';

/**
 * A lock whose holder has shown no sign of life for this long is dead (a crashed run, a container that was stopped
 * or recreated in the middle of a sync). The holder refreshes it every BEAT_MS while it works, so a long sync is
 * never taken for dead. It used to be 20 minutes from the START, which left a lock behind a stopped container
 * blocking every sync for that long.
 */
export const LOCK_STALE_MS = 90_000;
export const LOCK_BEAT_MS = 15_000;

export interface RunLock {
  release(): void;
}

export interface LockInfo {
  /** Who holds it, in words ("the scheduled service", "the Sync now button", "a command-line sync"). */
  by: string;
  since: string;
}

interface LockFile {
  pid?: number;
  at?: string;
  beat?: string;
  by?: string;
  token?: string;
}

const lockPath = (dataDir: string): string => join(dataDir, 'sync.lock');

/** Age in ms of the holder's last sign of life, or undefined if the file is unreadable (then its file time is used). */
function ageMs(path: string, now: () => Date): { age: number; info: LockFile } | undefined {
  let info: LockFile = {};
  let last: number | undefined;
  try {
    info = JSON.parse(readFileSync(path, 'utf8')) as LockFile;
    for (const v of [info.at, info.beat]) {
      const t = Date.parse(v ?? '');
      if (!Number.isNaN(t)) last = Math.max(last ?? t, t);
    }
  } catch {
    /* unreadable content: fall back to the file time below */
  }
  try {
    if (last === undefined) last = statSync(path).mtimeMs;
  } catch {
    return undefined; // vanished
  }
  return { age: now().getTime() - last, info };
}

/** The live lock, if one is held right now (a dead one is not reported). */
export function readRunLock(
  dataDir: string,
  now: () => Date = () => new Date(),
): LockInfo | undefined {
  const r = ageMs(lockPath(dataDir), now);
  if (!r || r.age > LOCK_STALE_MS) return undefined;
  return { by: r.info.by ?? 'another sync', since: r.info.at ?? '' };
}

/**
 * One sync at a time per data folder, across processes and containers (the scheduled `serve` loop, the web page's
 * Sync now and a manual `sync` must not write the same calendar together). The holder refreshes the file while it
 * works; `by` says who holds it, for the message.
 */
export function acquireRunLock(
  dataDir: string,
  now: () => Date = () => new Date(),
  by = 'a sync',
  beatMs = LOCK_BEAT_MS,
): RunLock {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = lockPath(dataDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      const at = now().toISOString();
      const token = randomBytes(8).toString('hex');
      writeSync(fd, JSON.stringify({ pid: process.pid, at, beat: at, by, token }));
      closeSync(fd);
      const timer = setInterval(() => {
        try {
          // Only keep a lock that is still ours: if it was taken over as dead, stop beating and never overwrite it.
          const now0 = JSON.parse(readFileSync(path, 'utf8')) as LockFile;
          if (now0.token !== token) {
            clearInterval(timer);
            return;
          }
          writeFileSync(
            path,
            JSON.stringify({ pid: process.pid, at, beat: now().toISOString(), by, token }),
            { mode: 0o600 },
          );
        } catch {
          /* the folder is gone or full: the next beat tries again */
        }
      }, beatMs);
      timer.unref();
      return {
        release: () => {
          clearInterval(timer);
          try {
            // Remove only our own lock (it may have been taken over after a long pause).
            if ((JSON.parse(readFileSync(path, 'utf8')) as LockFile).token !== token) return;
            unlinkSync(path);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const r = ageMs(path, now);
      if (!r) continue; // vanished in between: try again
      if (r.age > LOCK_STALE_MS) {
        try {
          unlinkSync(path);
        } catch {
          /* someone else took it */
        }
        continue;
      }
      const holder = r.info.by ?? 'another sync';
      const since = r.info.at ? ` since ${r.info.at.slice(11, 16)} UTC` : '';
      throw new UserError({
        code: 'E_SYNC_ALREADY_RUNNING',
        what: `Another sync is running on this data folder (${holder}${since}), so this one did not start.`,
        why: 'Only one sync writes to the calendar at a time.',
        action:
          'Wait for it to finish, then try again. If nothing is really running (the service was stopped in the middle of a sync), the lock clears by itself about 90 seconds after the last sign of life.',
      });
    }
  }
  throw new UserError({
    code: 'E_SYNC_ALREADY_RUNNING',
    what: 'Another sync is running on this data folder, so this one did not start.',
    why: 'Only one sync writes to the calendar at a time.',
    action: 'Wait a minute and try again.',
  });
}
