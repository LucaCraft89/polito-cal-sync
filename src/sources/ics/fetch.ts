import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from '../../util/errors.js';
import { retry } from '../../util/retry.js';
import { USER_AGENT } from '../../util/version.js';

/** What identifies a feed in messages. The URL itself may contain a secret token, so it is never shown. */
export function feedLabel(index: number, url: string): string {
  let host = 'unknown host';
  try {
    host = new URL(url).host;
  } catch {
    /* keep placeholder */
  }
  return `feed #${index + 1} (${host})`;
}

interface CacheEntry {
  etag?: string;
  lastModified?: string;
  body: string;
  savedAt: string;
}

/** Conditional-GET cache in DATA_DIR. File names are a hash of the URL, so the token never appears there. */
export class FeedCache {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'ics-cache');
  }

  private file(url: string): string {
    return join(this.dir, `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.json`);
  }

  read(url: string): CacheEntry | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.file(url), 'utf8')) as Partial<CacheEntry>;
      return typeof parsed.body === 'string' && parsed.body.length > 0
        ? (parsed as CacheEntry)
        : undefined;
    } catch {
      return undefined;
    }
  }

  write(url: string, entry: CacheEntry): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = this.file(url);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  }
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface FetchedFeed {
  text: string;
  /** True when the server said 304 and the saved copy was used. */
  fromCache: boolean;
  /** Call after the text parsed fine, to remember it (and its ETag) for the next conditional GET. */
  commit(): void;
}

class HttpStatus extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status}`);
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

async function readCapped(res: Response, maxBytes: number): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done || !value) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const isTransient = (err: unknown): boolean =>
  err instanceof HttpStatus ? err.status === 429 || err.status >= 500 : !(err instanceof UserError);

/**
 * One polite GET: honest User-Agent, timeout, ETag/Last-Modified, backoff on 429/5xx and network
 * errors (honouring Retry-After). Callers fetch feeds one after another, never in parallel.
 * Every failure is a UserError that does not contain the URL.
 */
export async function fetchFeed(
  url: string,
  label: string,
  cache: FeedCache,
  o: FetchOptions = {},
): Promise<FetchedFeed> {
  const doFetch = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 30_000;
  const maxBytes = o.maxBytes ?? 10 * 1024 * 1024;
  const cached = cache.read(url);

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'text/calendar, text/plain;q=0.5, */*;q=0.1',
  };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  const failed = (what: string, why: string, action: string, cause?: unknown) =>
    new UserError({
      code: 'E_ICS_FEED_FETCH_FAILED',
      what: `${label}: ${what}`,
      why,
      action,
      ...(cause === undefined ? {} : { cause }),
    });

  let res: Response;
  let body: string | undefined;
  try {
    ({ res, body } = await retry(
      async () => {
        const r = await doFetch(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (r.status === 429 || r.status >= 500) {
          await r.body?.cancel();
          throw new HttpStatus(r.status, parseRetryAfter(r.headers.get('retry-after')));
        }
        if (r.status !== 200) return { res: r, body: undefined };
        return { res: r, body: await readCapped(r, maxBytes) };
      },
      {
        attempts: o.attempts ?? 4,
        baseMs: o.baseMs ?? 2000,
        maxMs: o.maxMs ?? 60_000,
        shouldRetry: isTransient,
        retryAfterMs: (e) => (e instanceof HttpStatus ? e.retryAfterMs : undefined),
        ...(o.sleep ? { sleep: o.sleep } : {}),
        ...(o.random ? { random: o.random } : {}),
      },
    ));
  } catch (cause) {
    if (cause instanceof HttpStatus) {
      throw failed(
        `the server kept answering HTTP ${cause.status} after several waits.`,
        cause.status === 429
          ? 'The server asked us to slow down.'
          : 'The server had a problem or is down.',
        'Nothing: the next scheduled run tries again. Nothing was deleted because of this.',
        cause,
      );
    }
    throw failed(
      'the server could not be reached.',
      'No internet connection from this machine or container, a DNS problem, or the server timed out.',
      'Check the network. The next scheduled run tries again; nothing was deleted because of this.',
      cause,
    );
  }

  if (res.status === 304) {
    if (!cached) {
      throw failed(
        'the server answered "not modified" but there is no saved copy to use.',
        'The cache file in the data folder was removed or damaged after the last download.',
        'Run again: without a saved copy the next request downloads the feed in full.',
      );
    }
    return { text: cached.body, fromCache: true, commit: () => undefined };
  }
  if ([401, 403, 404, 410].includes(res.status)) {
    throw new UserError({
      code: 'E_ICS_FEED_REJECTED',
      what: `${label}: the server refused the request (HTTP ${res.status}).`,
      why: 'The feed URL is wrong, was regenerated (its secret token changed) or was removed.',
      action:
        'Copy the feed URL again from the course page and update SOURCE_POLITO_ICS_URLS. Nothing was deleted because of this.',
    });
  }
  if (res.status !== 200) {
    throw failed(
      `the server answered HTTP ${res.status}, which this program does not expect.`,
      'The URL does not point to a plain calendar feed.',
      'Check SOURCE_POLITO_ICS_URLS.',
    );
  }
  if (body === undefined) {
    throw new UserError({
      code: 'E_ICS_FEED_INVALID',
      what: `${label}: the answer is larger than ${Math.round(maxBytes / 1024 / 1024)} MB, so it was not read.`,
      why: 'A calendar feed is normally a few hundred kilobytes. This URL probably is not a feed.',
      action: 'Check SOURCE_POLITO_ICS_URLS.',
    });
  }
  const etag = res.headers.get('etag') ?? undefined;
  const lastModified = res.headers.get('last-modified') ?? undefined;
  return {
    text: body,
    fromCache: false,
    commit: () =>
      cache.write(url, {
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
        body,
        savedAt: new Date().toISOString(),
      }),
  };
}
