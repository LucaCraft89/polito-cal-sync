import type { Logger } from 'pino';
import { toUserError, type UserError } from '../util/errors.js';
import { VERSION } from '../util/version.js';
import type { SyncReport } from '../sync/engine.js';
import type { HeartbeatStore, Heartbeat } from './heartbeat.js';

export interface TickOutcome {
  report?: SyncReport;
  /** Extra error to show even if the report is ok (e.g. a feed that failed). */
  warning?: UserError;
}

export interface LoopOptions {
  /** One sync. May throw a UserError. */
  runOnce(): Promise<TickOutcome>;
  heartbeat: HeartbeatStore;
  /** Minutes between runs; a function is read again before every wait, so a changed setting applies at once. */
  intervalMinutes: number | (() => number);
  /** False = idle (no run) until it turns true; default always on. Checked before every run and on `poke()`. */
  enabled?: () => boolean;
  /** Called whenever the heartbeat changed (a run started or ended, the schedule moved). */
  onChange?: () => void;
  logger: Logger;
  now?: () => Date;
  /** Retry after a configuration problem that needs no network (default 60 s). */
  quickRetryMs?: number;
}

/** Problems the user fixes locally; checking again soon costs no traffic. */
const QUICK_RETRY_CODES = new Set(['E_NOT_CONFIGURED', 'E_GOOGLE_CLIENT_MISSING']);

/**
 * Runs `runOnce` now and then every interval, one run at a time: the next wait starts only when
 * a run has finished, so runs can never overlap. `stop()` cancels the wait and lets a run in
 * progress finish (up to a grace period).
 */
export class ServeLoop {
  private stopping = false;
  private cancelWait: (() => void) | undefined;
  private current: Promise<number> | undefined;
  private done: Promise<void> | undefined;
  private hb: Heartbeat;

  constructor(private readonly o: LoopOptions) {
    const now = (o.now ?? (() => new Date()))();
    this.hb = {
      version: VERSION,
      pid: process.pid,
      startedAt: now.toISOString(),
      intervalMinutes: this.minutes(),
      autoSync: this.on(),
    };
  }

  private minutes(): number {
    return typeof this.o.intervalMinutes === 'function'
      ? this.o.intervalMinutes()
      : this.o.intervalMinutes;
  }

  private on(): boolean {
    return this.o.enabled ? this.o.enabled() : true;
  }

  /** Settings changed: wake the wait and plan again (a new interval or the on/off switch applies at once). */
  poke(): void {
    this.cancelWait?.();
  }

  private publish(): void {
    this.o.heartbeat.write(this.hb);
    this.o.onChange?.();
  }

  snapshot(): Heartbeat {
    return { ...this.hb };
  }

  /** Starts the loop. Resolves after `stop()`. */
  start(): Promise<void> {
    this.o.heartbeat.write(this.hb);
    this.o.onChange?.();
    this.done = this.run();
    return this.done;
  }

  private now(): Date {
    return (this.o.now ?? (() => new Date()))();
  }

  private async run(): Promise<void> {
    let lastEnd: number | undefined;
    let retryMs: number | undefined;
    while (!this.stopping) {
      const enabled = this.on();
      const interval = this.minutes() * 60_000;
      const due = lastEnd === undefined ? 0 : lastEnd + (retryMs ?? interval);
      const nowMs = this.now().getTime();
      if (enabled && nowMs >= due) {
        this.hb = { ...this.hb, intervalMinutes: this.minutes(), autoSync: true, running: true };
        delete this.hb.nextRunAt;
        this.publish();
        this.current = this.tick();
        const waitMs = await this.current;
        this.current = undefined;
        if (this.stopping) break;
        lastEnd = this.now().getTime();
        retryMs = waitMs === interval ? undefined : waitMs;
        this.hb = { ...this.hb, running: false };
        this.publish();
        continue;
      }
      this.hb = { ...this.hb, intervalMinutes: this.minutes(), autoSync: enabled, running: false };
      if (enabled) this.hb.nextRunAt = new Date(due).toISOString();
      else delete this.hb.nextRunAt;
      this.publish();
      const waitMs = enabled ? Math.min(Math.max(due - nowMs, 0), 300_000) : 60_000;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, waitMs);
        this.cancelWait = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.cancelWait = undefined;
    }
  }

  /** One run; returns how long to wait before the next. */
  private async tick(): Promise<number> {
    const { logger } = this.o;
    const interval = this.minutes() * 60_000;
    let wait = interval;
    let status = 'failed';
    let errorCode: string | undefined;
    let counts: Heartbeat['lastCounts'];
    try {
      const out = await this.o.runOnce();
      if (out.report) {
        status = out.report.status;
        counts = {
          created: out.report.applied?.created ?? 0,
          patched: out.report.applied?.patched ?? 0,
          deleted: out.report.applied?.deleted ?? 0,
          unchanged: out.report.plan.unchanged,
          failed: out.report.applied?.failures.length ?? 0,
        };
        if (out.report.error) errorCode = out.report.error.code;
      }
      const problem = out.report?.error ?? out.warning;
      if (problem) {
        logger.error(
          { code: problem.code, what: problem.what, why: problem.why, action: problem.action },
          `sync problem ${problem.code}`,
        );
      }
      if (!errorCode && out.warning) errorCode = out.warning.code;
    } catch (err) {
      const e = toUserError(err);
      errorCode = e.code;
      logger.error(
        { code: e.code, what: e.what, why: e.why, action: e.action, err: e.cause },
        `sync failed ${e.code}`,
      );
      if (QUICK_RETRY_CODES.has(e.code)) wait = this.o.quickRetryMs ?? 60_000;
    }
    const at = this.now().toISOString();
    const ok = status === 'ok' || status === 'partial';
    this.hb = {
      ...this.hb,
      lastRunAt: at,
      ...(ok ? { lastOkAt: at } : {}),
      lastStatus: status,
      ...(counts ? { lastCounts: counts } : {}),
    };
    if (errorCode) this.hb.lastErrorCode = errorCode;
    else delete this.hb.lastErrorCode;
    this.o.heartbeat.write(this.hb);
    this.o.onChange?.();
    logger.info({ status, ...(errorCode ? { code: errorCode } : {}) }, 'sync run finished');
    return wait;
  }

  /** Graceful shutdown: no new runs; a run in progress may finish for up to `graceMs`. */
  async stop(graceMs = 25_000): Promise<void> {
    this.stopping = true;
    this.cancelWait?.();
    if (this.current) {
      await Promise.race([
        this.current.then(() => undefined),
        new Promise<void>((r) => setTimeout(r, graceMs).unref()),
      ]);
    }
    this.hb = { ...this.hb, stoppedAt: this.now().toISOString() };
    delete this.hb.nextRunAt;
    this.hb.running = false;
    this.o.heartbeat.write(this.hb);
    this.o.onChange?.();
  }
}
