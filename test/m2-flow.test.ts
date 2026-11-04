import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliDeps, type CliIo } from '../src/cli/index.js';
import { MemoryEventsApi } from '../src/google/memory.js';
import { evaluateHealth, HeartbeatStore } from '../src/serve/heartbeat.js';
import { ServeLoop } from '../src/serve/loop.js';
import { createStatusServer } from '../src/serve/status.js';
import { acquireRunLock, LOCK_STALE_MS } from '../src/sync/lock.js';
import { createLogger } from '../src/util/logger.js';
import { loadConfig } from '../src/config/index.js';

const FEED = 'https://feed.example.invalid/secret-feed-token-AAAABBBBCCCC/me.ics';
const CAL_ID = 'dedicated-cal';
const NOW = new Date('2026-11-04T10:00:00Z');

const ics = (...events: [uid: string, start: string, title: string][]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    ...events.flatMap(([uid, start, title]) => [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      'DTSTAMP:20261001T000000Z',
      `DTSTART:${start}`,
      `DTEND:${start.replace(/T(\d\d)/, (_m, h: string) => `T${String(Number(h) + 1).padStart(2, '0')}`)}`,
      `SUMMARY:${title}`,
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ].join('\r\n');

function harness(feedText: () => string | number) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pcs-flow-'));
  const api = new MemoryEventsApi();
  const out: string[] = [];
  const err: string[] = [];
  const logs: string[] = [];
  const io: CliIo = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    logStream: { write: (s: string) => void logs.push(s) },
  };
  const deps: CliDeps = {
    now: () => NOW,
    pauseBetweenFeedsMs: 0,
    sleep: () => Promise.resolve(),
    googleFactory: () => Promise.resolve({ api, calendarId: CAL_ID }),
    fetchImpl: () => {
      const v = feedText();
      return Promise.resolve(
        typeof v === 'number'
          ? new Response(null, { status: v })
          : new Response(v, { status: 200 }),
      );
    },
  };
  const env = { DATA_DIR: dataDir, SOURCE_POLITO_ICS_URLS: FEED, TZ: 'Europe/Rome' };
  const run = async (argv: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
    out.length = err.length = 0;
    const code = await runCli(argv, { ...env, ...extraEnv }, io, deps);
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { dataDir, api, run, logs };
}

const A = ['a', '20261110T090000Z', 'Fisica'] as [string, string, string];
const B = ['b', '20261111T090000Z', 'Chimica'] as [string, string, string];
const C = ['c', '20261112T090000Z', 'Analisi'] as [string, string, string];
const D = ['d', '20261113T090000Z', 'Algebra'] as [string, string, string];

const managed = (api: MemoryEventsApi) =>
  api
    .snapshot(CAL_ID)
    .filter(
      (e) => e.extendedProperties?.private?.['polito_cal_sync'] === '1' && e.status !== 'cancelled',
    );

describe('M2 real path: ICS feed -> engine -> OwnedCalendar (fake Google, fake network)', () => {
  it('first run creates, second run is a no-op, a removed event is deleted', async () => {
    let feed = ics(A, B, C, D);
    const h = harness(() => feed);
    h.api.seed(CAL_ID, {
      id: 'foreign-1',
      status: 'confirmed',
      summary: 'Dentist',
      start: { dateTime: '2026-11-12T15:00:00.000Z' },
      end: { dateTime: '2026-11-12T16:00:00.000Z' },
    });

    const dry = await h.run(['sync', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('would create 4, update 0, delete 0');
    expect(h.api.writes).toHaveLength(0);
    expect(existsSync(join(h.dataDir, 'state.db'))).toBe(false); // a dry run writes no history

    const first = await h.run(['sync']);
    expect(first.code).toBe(0);
    expect(first.out).toContain('created 4, updated 0, deleted 0');
    expect(managed(h.api)).toHaveLength(4);

    h.api.calls.length = 0;
    const second = await h.run(['sync']);
    expect(second.code).toBe(0);
    expect(second.out).toContain('created 0, updated 0, deleted 0, unchanged 4');
    expect(h.api.writes).toHaveLength(0);

    feed = ics(A, B, C); // D disappears from the feed: 1 of 4 = 25% < 30%
    const third = await h.run(['sync']);
    expect(third.code).toBe(0);
    expect(third.out).toContain('deleted 1');
    expect(
      managed(h.api)
        .map((e) => e.summary)
        .sort(),
    ).toEqual(['Analisi', 'Chimica', 'Fisica']);
    // The foreign event was never touched.
    expect(h.api.snapshot(CAL_ID).find((e) => e.id === 'foreign-1')?.summary).toBe('Dentist');
    expect(h.api.writes.every((c) => c.eventId !== 'foreign-1')).toBe(true);
    expect(existsSync(join(h.dataDir, 'state.db'))).toBe(true);
  });

  it('a feed that fails deletes nothing, and the exit code says so', async () => {
    let feed: string | number = ics(A, B, C, D);
    const h = harness(() => feed);
    await h.run(['sync']);
    feed = 503;
    const r = await h.run(['sync']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('INCOMPLETE');
    expect(r.err).toContain('E_ICS_FEED_FETCH_FAILED');
    expect(managed(h.api)).toHaveLength(4);
  });

  it('a feed that now returns an empty calendar is refused by the safety threshold', async () => {
    let feed = ics(A, B, C, D);
    const h = harness(() => feed);
    await h.run(['sync']);
    feed = ics();
    const r = await h.run(['sync']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('E_DELETE_THRESHOLD');
    expect(managed(h.api)).toHaveLength(4);
  });

  it('never prints the feed URL or token, on screen or in the logs', async () => {
    let feed: string | number = ics(A);
    const h = harness(() => feed);
    await h.run(['sync'], { LOG_LEVEL: 'debug' });
    feed = 404;
    const r = await h.run(['sync'], { LOG_LEVEL: 'debug' });
    expect(r.err).toContain('E_ICS_FEED_REJECTED');
    const all = r.out + r.err + h.logs.join('');
    expect(all).not.toContain('secret-feed-token');
    expect(all).not.toContain('AAAABBBB');
  });

  it('two syncs at once: the second is refused with E_SYNC_ALREADY_RUNNING', async () => {
    const h = harness(() => ics(A));
    const lock = acquireRunLock(h.dataDir, () => NOW);
    const r = await h.run(['sync']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('E_SYNC_ALREADY_RUNNING');
    lock.release();
    expect((await h.run(['sync'])).code).toBe(0);
  });

  it('without sources or Google it explains what is missing', async () => {
    const h = harness(() => ics(A));
    const r = await h.run(['sync'], { SOURCE_POLITO_ICS_URLS: '' });
    expect(r.err).toContain('E_NOT_CONFIGURED');
    expect(r.err).toContain('SOURCE_POLITO_ICS_URLS');
  });
});

describe('config', () => {
  it('names the bad feed entry but never shows it', () => {
    try {
      loadConfig({ SOURCE_POLITO_ICS_URLS: `${FEED}, not a url secret=abc123456789` });
      expect.unreachable();
    } catch (e) {
      const text = (e as Error).message;
      expect(text).toContain('SOURCE_POLITO_ICS_URLS');
      expect(text).toContain('entry 2');
      expect(text).not.toContain('abc123456789');
    }
  });
  it('splits the list and trims', () => {
    expect(
      loadConfig({ SOURCE_POLITO_ICS_URLS: `${FEED} , https://b.example.invalid/x.ics,` }).icsUrls,
    ).toHaveLength(2);
  });
});

describe('run lock', () => {
  it('a stale lock from a crashed run is taken over', () => {
    const d = mkdtempSync(join(tmpdir(), 'pcs-lock-'));
    acquireRunLock(d, () => new Date(0)); // never released: pretend it crashed long ago
    const l = acquireRunLock(d, () => new Date(LOCK_STALE_MS + 10 * 60_000 + Date.now()));
    l.release();
  });
});

describe('serve loop', () => {
  const quiet = createLogger('silent');

  it('runs, never overlaps, and shuts down gracefully (waits for the run in progress)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pcs-serve-'));
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const loop = new ServeLoop({
      heartbeat: new HeartbeatStore(d),
      intervalMinutes: 0.0001, // 6 ms
      logger: quiet,
      runOnce: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        runs++;
        if (runs === 3) await gate; // a slow run: the interval passes several times meanwhile
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return {};
      },
    });
    const finished = loop.start();
    while (runs < 3) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 40)); // many intervals elapse during the slow run
    expect(runs).toBe(3);
    expect(maxActive).toBe(1);
    const stopping = loop.stop(5000);
    release();
    await stopping;
    await finished;
    expect(active).toBe(0); // the run in progress was allowed to finish
    const hb = new HeartbeatStore(d).read();
    expect(hb?.stoppedAt).toBeDefined();
  });

  it('a failing run is recorded, not fatal, and clears the next time', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pcs-serve-'));
    let n = 0;
    const loop = new ServeLoop({
      heartbeat: new HeartbeatStore(d),
      intervalMinutes: 0.0001,
      quickRetryMs: 5,
      logger: quiet,
      runOnce: () => {
        n++;
        if (n === 1) {
          return Promise.reject(Object.assign(new Error('x'), {}));
        }
        return Promise.resolve({
          report: {
            status: 'ok' as const,
            plan: { unchanged: 3 } as never,
            options: { dryRun: false, force: false },
          },
        });
      },
    });
    const finished = loop.start();
    while (n < 2) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    await loop.stop(1000);
    await finished;
    const hb = new HeartbeatStore(d).read();
    expect(hb?.lastStatus).toBe('ok');
    expect(hb?.lastErrorCode).toBeUndefined();
    expect(hb?.lastOkAt).toBeDefined();
  });
});

describe('healthcheck and status', () => {
  const t0 = new Date('2026-11-04T10:00:00Z');
  const at = (min: number) => new Date(t0.getTime() + min * 60_000);
  const hb = { version: '0', pid: 1, startedAt: t0.toISOString(), intervalMinutes: 60 };

  it('no heartbeat file means "serve never ran here": healthy', () => {
    expect(evaluateHealth(undefined, t0).healthy).toBe(true);
  });
  it('healthy while the last successful sync is younger than 3 intervals, then not', () => {
    const ok = {
      ...hb,
      lastRunAt: at(100).toISOString(),
      lastOkAt: at(100).toISOString(),
      lastStatus: 'ok',
    };
    expect(evaluateHealth(ok, at(170)).healthy).toBe(true);
    const stale = evaluateHealth(ok, at(100 + 181));
    expect(stale.healthy).toBe(false);
    expect(stale.reason).toContain('no sync attempt');
  });
  it('runs that keep failing make it unhealthy even though the loop is alive', () => {
    const failing = {
      ...hb,
      lastRunAt: at(170).toISOString(),
      lastStatus: 'failed',
      lastErrorCode: 'E_GOOGLE_AUTH_EXPIRED',
    };
    const h = evaluateHealth(failing, at(181));
    expect(h.healthy).toBe(false);
    expect(h.reason).toContain('E_GOOGLE_AUTH_EXPIRED');
  });
  it('a loop that was stopped is unhealthy', () => {
    expect(evaluateHealth({ ...hb, stoppedAt: t0.toISOString() }, t0).healthy).toBe(false);
  });

  it('the healthcheck command reads the heartbeat from DATA_DIR', async () => {
    const h = harness(() => ics(A));
    const store = new HeartbeatStore(h.dataDir);
    expect((await h.run(['healthcheck'])).code).toBe(0);
    store.write({ ...hb, startedAt: '2026-11-01T00:00:00Z' }); // NOW is 3 days later
    const r = await h.run(['healthcheck']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('unhealthy');
  });

  it('the status endpoint answers on localhost only and shows no secrets', async () => {
    const server = createStatusServer(() => ({ ...hb, lastStatus: 'ok' }), {
      bind: '127.0.0.1',
      port: 0,
      now: () => t0,
    });
    const port = await server.listen();
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/status`);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as Record<string, unknown>;
      expect(body['lastStatus']).toBe('ok');
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
      const rebinding = await new Promise<number>((resolve, reject) => {
        http
          .get(
            { host: '127.0.0.1', port, path: '/status', headers: { Host: 'evil.example.invalid' } },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            },
          )
          .on('error', reject);
      });
      expect(rebinding).toBe(421);
      expect((await fetch(`http://127.0.0.1:${port}/status`, { method: 'POST' })).status).toBe(405);
    } finally {
      await server.close();
    }
  });
});

describe('serve command', () => {
  it('starts, syncs once, and stops on the abort signal; heartbeat says so', async () => {
    const h = harness(() => ics(A, B));
    const ac = new AbortController();
    const done = runCli(
      ['serve'],
      { DATA_DIR: h.dataDir, SOURCE_POLITO_ICS_URLS: FEED, STATUS_PORT: '0' },
      {
        out: () => undefined,
        err: () => undefined,
        logStream: { write: () => undefined },
      },
      {
        now: () => NOW,
        pauseBetweenFeedsMs: 0,
        googleFactory: () => Promise.resolve({ api: h.api, calendarId: CAL_ID }),
        fetchImpl: () => Promise.resolve(new Response(ics(A, B), { status: 200 })),
        signal: ac.signal,
        shutdownGraceMs: 2000,
      },
    );
    const hbPath = join(h.dataDir, 'heartbeat.json');
    for (let i = 0; i < 200; i++) {
      if (
        existsSync(hbPath) &&
        (JSON.parse(readFileSync(hbPath, 'utf8')) as { lastStatus?: string }).lastStatus
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    ac.abort();
    expect(await done).toBe(0);
    const hb = JSON.parse(readFileSync(hbPath, 'utf8')) as {
      lastStatus: string;
      stoppedAt: string;
      lastCounts: { created: number };
    };
    expect(hb.lastStatus).toBe('ok');
    expect(hb.lastCounts.created).toBe(2);
    expect(hb.stoppedAt).toBeDefined();
    expect(managed(h.api)).toHaveLength(2);
    void writeFileSync;
  });
});
