import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from '../util/errors.js';

const SCHEMA_VERSION = 1;

export type RunStatus = 'running' | 'ok' | 'partial' | 'refused' | 'failed';

export interface RunResult {
  status: Exclude<RunStatus, 'running'>;
  created: number;
  patched: number;
  deleted: number;
  unchanged: number;
  failed: number;
  errorCode?: string;
  /** JSON-serialisable; ids and codes only, never event text. */
  details?: unknown;
}

export interface RunRow {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  forced: boolean;
  calendarId: string;
  created: number;
  patched: number;
  deleted: number;
  unchanged: number;
  failed: number;
  errorCode: string | null;
  details: unknown;
}

export interface AppliedRow {
  googleId: string;
  source: string;
  sourceId: string;
  kind: string;
  hash: string;
}

interface RawRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  forced: number;
  calendar_id: string;
  created: number;
  patched: number;
  deleted: number;
  unchanged: number;
  failed: number;
  error_code: string | null;
  details: string | null;
}

/**
 * Sync history and a local mirror of what we last wrote. The calendar itself (events with our
 * marker and hash) is the source of truth for diffing, so losing this file loses history only.
 * Dry runs never touch it.
 */
export class StateStore {
  private constructor(private readonly db: Database.Database) {}

  static fileIn(dataDir: string): string {
    return join(dataDir, 'state.db');
  }

  /** `path` may be ':memory:' for tests. */
  static open(path: string): StateStore {
    let db: Database.Database;
    try {
      db = new Database(path);
      if (path !== ':memory:') {
        db.pragma('journal_mode = WAL');
        chmodSync(path, 0o600);
      }
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 3000');
      const version = db.pragma('user_version', { simple: true }) as number;
      if (version > SCHEMA_VERSION) {
        db.close();
        throw new UserError({
          code: 'E_STATE_DB_SCHEMA_NEWER',
          what: 'The state database was written by a newer version of this program.',
          why: 'An older version was started on a data folder used by a newer one.',
          action: 'Upgrade to the newer version, or use a separate data folder.',
        });
      }
      if (version < SCHEMA_VERSION) StateStore.migrate(db);
    } catch (cause) {
      if (cause instanceof UserError) throw cause;
      throw new UserError({
        code: 'E_STATE_DB_OPEN_FAILED',
        what: 'The sync history database could not be opened.',
        why: 'The file is corrupt, locked by another running instance, or the disk is full.',
        action:
          'Make sure only one instance runs. If the file is corrupt, move state.db out of the data folder: the next run rebuilds from the calendar, nothing is lost.',
        cause,
      });
    }
    const store = new StateStore(db);
    store.failInterruptedRuns();
    return store;
  }

  private static migrate(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        status      TEXT NOT NULL,
        forced      INTEGER NOT NULL DEFAULT 0,
        calendar_id TEXT NOT NULL,
        created     INTEGER NOT NULL DEFAULT 0,
        patched     INTEGER NOT NULL DEFAULT 0,
        deleted     INTEGER NOT NULL DEFAULT 0,
        unchanged   INTEGER NOT NULL DEFAULT 0,
        failed      INTEGER NOT NULL DEFAULT 0,
        error_code  TEXT,
        details     TEXT
      );
      CREATE TABLE IF NOT EXISTS managed_events (
        google_id   TEXT PRIMARY KEY,
        calendar_id TEXT NOT NULL,
        source      TEXT NOT NULL,
        source_id   TEXT NOT NULL,
        kind        TEXT NOT NULL,
        hash        TEXT NOT NULL,
        synced_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS managed_events_source ON managed_events (calendar_id, source);
    `);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  /** A crash mid-run leaves status "running"; the next start records that honestly. */
  private failInterruptedRuns(): void {
    this.db
      .prepare(
        `UPDATE runs SET status = 'failed', error_code = 'E_INTERNAL', finished_at = ?
         WHERE status = 'running'`,
      )
      .run(new Date().toISOString());
  }

  startRun(input: { calendarId: string; forced: boolean; now: Date }): number {
    const info = this.db
      .prepare(
        `INSERT INTO runs (started_at, status, forced, calendar_id) VALUES (?, 'running', ?, ?)`,
      )
      .run(input.now.toISOString(), input.forced ? 1 : 0, input.calendarId);
    return Number(info.lastInsertRowid);
  }

  finishRun(id: number, result: RunResult, now: Date): void {
    this.db
      .prepare(
        `UPDATE runs SET finished_at = ?, status = ?, created = ?, patched = ?, deleted = ?,
           unchanged = ?, failed = ?, error_code = ?, details = ? WHERE id = ?`,
      )
      .run(
        now.toISOString(),
        result.status,
        result.created,
        result.patched,
        result.deleted,
        result.unchanged,
        result.failed,
        result.errorCode ?? null,
        result.details === undefined ? null : JSON.stringify(result.details),
        id,
      );
  }

  recordApplied(calendarId: string, rows: readonly AppliedRow[], now: Date): void {
    const stmt = this.db.prepare(
      `INSERT INTO managed_events (google_id, calendar_id, source, source_id, kind, hash, synced_at)
       VALUES (@googleId, @calendarId, @source, @sourceId, @kind, @hash, @syncedAt)
       ON CONFLICT(google_id) DO UPDATE SET calendar_id = excluded.calendar_id, kind = excluded.kind,
         hash = excluded.hash, synced_at = excluded.synced_at`,
    );
    this.db.transaction(() => {
      for (const r of rows) stmt.run({ ...r, calendarId, syncedAt: now.toISOString() });
    })();
  }

  forget(googleIds: readonly string[]): void {
    const stmt = this.db.prepare('DELETE FROM managed_events WHERE google_id = ?');
    this.db.transaction(() => {
      for (const id of googleIds) stmt.run(id);
    })();
  }

  managedCount(calendarId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM managed_events WHERE calendar_id = ?')
      .get(calendarId) as { n: number };
    return row.n;
  }

  lastRun(): RunRow | undefined {
    const r = this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() as
      RawRun | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      forced: r.forced === 1,
      calendarId: r.calendar_id,
      created: r.created,
      patched: r.patched,
      deleted: r.deleted,
      unchanged: r.unchanged,
      failed: r.failed,
      errorCode: r.error_code,
      details: r.details === null ? null : (JSON.parse(r.details) as unknown),
    };
  }

  close(): void {
    this.db.close();
  }
}
