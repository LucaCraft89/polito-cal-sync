import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFile } from '../util/files.js';

export interface Heartbeat {
  version: string;
  pid: number;
  startedAt: string;
  intervalMinutes: number;
  lastRunAt?: string;
  /** Last run whose status was ok or partial. */
  lastOkAt?: string;
  lastStatus?: string;
  lastErrorCode?: string;
  nextRunAt?: string;
  lastCounts?: {
    created: number;
    patched: number;
    deleted: number;
    unchanged: number;
    failed: number;
  };
  /** Set on a clean shutdown. */
  stoppedAt?: string;
}

/** The loop's pulse, written to DATA_DIR so the Docker healthcheck (another process) can read it. */
export class HeartbeatStore {
  private readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, 'heartbeat.json');
  }
  read(): Heartbeat | undefined {
    try {
      const v = JSON.parse(readFileSync(this.path, 'utf8')) as Heartbeat;
      return typeof v.startedAt === 'string' && typeof v.intervalMinutes === 'number'
        ? v
        : undefined;
    } catch {
      return undefined;
    }
  }
  write(hb: Heartbeat): void {
    writePrivateFile(this.path, JSON.stringify(hb));
  }
}

export interface Health {
  healthy: boolean;
  reason?: string;
}

const minutes = (ms: number) => Math.round(ms / 60_000);

/**
 * Healthy = the loop is alive and its last successful sync is not older than 3x the interval.
 * No heartbeat file at all means `serve` never ran in this data folder (a one-off container,
 * the CI check): then only the basic checks matter.
 */
export function evaluateHealth(hb: Heartbeat | undefined, now: Date): Health {
  if (!hb) return { healthy: true };
  if (hb.stoppedAt) return { healthy: false, reason: 'the serve loop was stopped' };
  const allowance = 3 * hb.intervalMinutes * 60_000;
  const age = (iso: string) => now.getTime() - Date.parse(iso);
  const lastRun = hb.lastRunAt ?? hb.startedAt;
  if (age(lastRun) > allowance) {
    return { healthy: false, reason: `no sync attempt for ${minutes(age(lastRun))} minutes` };
  }
  const lastOk = hb.lastOkAt ?? hb.startedAt;
  if (age(lastOk) > allowance) {
    return {
      healthy: false,
      reason: `no successful sync for ${minutes(age(lastOk))} minutes (last result: ${hb.lastStatus ?? 'none yet'}${hb.lastErrorCode ? `, ${hb.lastErrorCode}` : ''})`,
    };
  }
  return { healthy: true };
}
