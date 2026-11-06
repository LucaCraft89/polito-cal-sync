import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IcsSource } from '../src/sources/ics/index.js';
import { USER_AGENT } from '../src/util/version.js';

const NOW = new Date('2026-11-04T10:00:00Z');
const SECRET_URL = 'https://calendar.example.invalid/feed/ZZSECRETTOKEN123456/polito.ics';
const OTHER_URL = 'https://other.example.invalid/c/Q9SECRETQ9SECRETQ9.ics';

const ICS = (title: string, uid = 'u1') =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261001T000000Z',
    'DTSTART:20261110T090000Z',
    'DTEND:20261110T100000Z',
    `SUMMARY:${title}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

interface Seen {
  url: string;
  headers: Record<string, string>;
}

/** A fake network: url -> list of responses, used in order (the last repeats). */
function fakeNetwork(script: Record<string, (() => Response)[]>) {
  const seen: Seen[] = [];
  const counters = new Map<string, number>();
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const list = script[url];
    if (!list) return Promise.reject(new TypeError('fetch failed'));
    const n = counters.get(url) ?? 0;
    counters.set(url, n + 1);
    const make = list[Math.min(n, list.length - 1)] as () => Response;
    return Promise.resolve(make());
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const ok =
  (body: string, headers: Record<string, string> = {}) =>
  () =>
    new Response(body, { status: 200, headers });
const status =
  (code: number, headers: Record<string, string> = {}) =>
  () =>
    new Response(null, { status: code, headers });

function source(
  urls: string[],
  net: ReturnType<typeof fakeNetwork>,
  dataDir: string,
  sleeps: number[] = [],
) {
  return new IcsSource({
    urls,
    dataDir,
    tz: 'Europe/Rome',
    now: () => NOW,
    pauseBetweenFeedsMs: 0,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    fetchOptions: {
      fetchImpl: net.fetchImpl,
      baseMs: 10,
      maxMs: 100,
      random: () => 1,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  });
}

const dir = () => mkdtempSync(join(tmpdir(), 'pcs-ics-'));

describe('IcsSource', () => {
  it('reads a feed, is complete, and sends our honest User-Agent', async () => {
    const net = fakeNetwork({ [SECRET_URL]: [ok(ICS('Fisica'), { etag: '"v1"' })] });
    const src = source([SECRET_URL], net, dir());
    const r = await src.fetch();
    expect(r.complete).toBe(true);
    expect(r.source).toBe('ics');
    expect(r.events.map((e) => e.title)).toEqual(['Fisica']);
    expect(net.seen[0]?.headers['User-Agent']).toBe(USER_AGENT);
  });

  it('uses ETag / Last-Modified on the next run and falls back to the cached copy on 304', async () => {
    const d = dir();
    const net = fakeNetwork({
      [SECRET_URL]: [
        ok(ICS('Fisica'), { etag: '"v1"', 'last-modified': 'Mon, 02 Nov 2026 08:00:00 GMT' }),
        status(304),
      ],
    });
    await source([SECRET_URL], net, d).fetch();
    const second = await source([SECRET_URL], net, d).fetch();
    expect(net.seen[1]?.headers['If-None-Match']).toBe('"v1"');
    expect(net.seen[1]?.headers['If-Modified-Since']).toBe('Mon, 02 Nov 2026 08:00:00 GMT');
    expect(second.complete).toBe(true);
    expect(second.events.map((e) => e.title)).toEqual(['Fisica']);
  });

  it('a 304 with no usable cache makes the result incomplete', async () => {
    const net = fakeNetwork({ [SECRET_URL]: [status(304)] });
    const src = source([SECRET_URL], net, dir());
    const r = await src.fetch();
    expect(r.complete).toBe(false);
    expect(r.events).toEqual([]);
    expect(src.lastReport[0]?.error?.code).toBe('E_ICS_FEED_FETCH_FAILED');
  });

  it('retries 5xx and 429 with backoff, honouring Retry-After, then succeeds', async () => {
    const sleeps: number[] = [];
    const net = fakeNetwork({
      [SECRET_URL]: [status(503), status(429, { 'retry-after': '1' }), ok(ICS('Fisica'))],
    });
    const r = await source([SECRET_URL], net, dir(), sleeps).fetch();
    expect(r.complete).toBe(true);
    expect(net.seen).toHaveLength(3);
    expect(sleeps).toEqual([10, 100]); // 10 ms backoff, then Retry-After 1s capped at maxMs
  });

  it('gives up after the attempts and reports the feed as failed (incomplete)', async () => {
    const net = fakeNetwork({ [SECRET_URL]: [status(500)] });
    const src = source([SECRET_URL], net, dir());
    const r = await src.fetch();
    expect(net.seen).toHaveLength(4);
    expect(r.complete).toBe(false);
    expect(src.lastReport[0]?.error?.code).toBe('E_ICS_FEED_FETCH_FAILED');
  });

  it('does not retry a refused URL', async () => {
    const net = fakeNetwork({ [SECRET_URL]: [status(404)] });
    const src = source([SECRET_URL], net, dir());
    expect((await src.fetch()).complete).toBe(false);
    expect(net.seen).toHaveLength(1);
    expect(src.lastReport[0]?.error?.code).toBe('E_ICS_FEED_REJECTED');
  });

  it('one failed feed makes the whole result incomplete but keeps the events of the good feed', async () => {
    const net = fakeNetwork({ [SECRET_URL]: [ok(ICS('Fisica', 'a'))], [OTHER_URL]: [status(503)] });
    const r = await source([SECRET_URL, OTHER_URL], net, dir()).fetch();
    expect(r.complete).toBe(false);
    expect(r.events.map((e) => e.title)).toEqual(['Fisica']);
  });

  it('feeds are fetched one after another, with a pause between them', async () => {
    const sleeps: number[] = [];
    let active = 0;
    let maxActive = 0;
    const base = fakeNetwork({
      [SECRET_URL]: [ok(ICS('A', 'a'))],
      [OTHER_URL]: [ok(ICS('B', 'b'))],
    });
    const fetchImpl = (async (u: string | URL | Request, i?: RequestInit) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      const res = await base.fetchImpl(u, i);
      active--;
      return res;
    }) as typeof fetch;
    const src = new IcsSource({
      urls: [SECRET_URL, OTHER_URL],
      dataDir: dir(),
      tz: 'Europe/Rome',
      now: () => NOW,
      pauseBetweenFeedsMs: 1000,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      fetchOptions: { fetchImpl },
    });
    const r = await src.fetch();
    expect(r.events).toHaveLength(2);
    expect(maxActive).toBe(1);
    expect(sleeps).toEqual([1000]);
  });

  it('an HTML login page is not a feed: incomplete, with E_ICS_FEED_INVALID', async () => {
    const net = fakeNetwork({ [SECRET_URL]: [ok('<html><body>Login</body></html>')] });
    const src = source([SECRET_URL], net, dir());
    expect((await src.fetch()).complete).toBe(false);
    expect(src.lastReport[0]?.error?.code).toBe('E_ICS_FEED_INVALID');
  });

  it('unsupported content makes the result incomplete but the rest is returned', async () => {
    const text = ICS('Fisica').replace(
      'END:VCALENDAR',
      [
        'BEGIN:VEVENT',
        'UID:h',
        'DTSTART:20261110T090000Z',
        'RRULE:FREQ=HOURLY',
        'SUMMARY:H',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    );
    const src = source([SECRET_URL], fakeNetwork({ [SECRET_URL]: [ok(text)] }), dir());
    const r = await src.fetch();
    expect(r.complete).toBe(false);
    expect(r.events).toHaveLength(1);
    expect(src.lastReport[0]?.error?.code).toBe('E_ICS_FEED_UNSUPPORTED');
  });

  it('no feeds configured is never "complete"', async () => {
    const r = await source([], fakeNetwork({}), dir()).fetch();
    expect(r.complete).toBe(false);
  });

  it('never leaks the feed URL: not in errors, reports, log lines or cache file names', async () => {
    const d = dir();
    const lines: string[] = [];
    const { createLogger } = await import('../src/util/logger.js');
    const logger = createLogger('debug', { write: (s: string) => void lines.push(s) });
    const net = fakeNetwork({ [SECRET_URL]: [ok(ICS('Fisica'))], [OTHER_URL]: [status(404)] });
    const src = new IcsSource({
      urls: [SECRET_URL, OTHER_URL],
      dataDir: d,
      tz: 'Europe/Rome',
      now: () => NOW,
      pauseBetweenFeedsMs: 0,
      logger,
      fetchOptions: { fetchImpl: net.fetchImpl },
    });
    await src.fetch();
    const everything =
      JSON.stringify(
        src.lastReport.map((r) => ({
          ...r,
          error: r.error && {
            ...r.error,
            message: r.error.message,
            what: r.error.what,
            why: r.error.why,
            action: r.error.action,
          },
        })),
      ) + lines.join('');
    for (const secret of ['ZZSECRETTOKEN123456', 'Q9SECRETQ9SECRETQ9', '/feed/', '/c/']) {
      expect(everything).not.toContain(secret);
    }
    const files = readdirSync(join(d, 'ics-cache'));
    expect(files.every((f) => /^[0-9a-f]{32}\.json$/.test(f))).toBe(true);
    // The cache holds the schedule, so it is private to the owner.
    const mode = statSync(join(d, 'ics-cache', files[0] as string)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(join(d, 'ics-cache', files[0] as string), 'utf8')).not.toContain(
      'ZZSECRET',
    );
  });
});
