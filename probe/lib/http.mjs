// One request at a time, honest User-Agent, a pause between requests, backoff on 5xx for safe
// (GET) requests, and a hard stop on 401/403/429 when the caller asks for it.
// Nothing here writes bodies or credentials anywhere; the caller decides what to record.

import { readFileSync } from 'node:fs';

export const DEFAULT_BASE_URL = 'https://app.didattica.polito.it/api';
const PAUSE_MS = 1500;
const TIMEOUT_MS = 20_000;

const version = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();
export const USER_AGENT = `polito-cal-sync/${version} (personal, self-hosted)`;

/** Response headers worth keeping. Never cookies or authorization values. */
const KEEP_HEADERS = [
  'server',
  'date',
  'content-type',
  'www-authenticate',
  'retry-after',
  'cache-control',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'strict-transport-security',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'via',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class StopProbe extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status) {
    super(message);
    this.name = 'StopProbe';
    this.status = status;
  }
}

export class Http {
  /**
   * @param {{ baseUrl: string, log: (line: string) => void, requestLog?: object[] }} o
   */
  constructor(o) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.log = o.log;
    /** Method, path and status of each request, no bodies and no headers. Goes into the summary. */
    this.requestLog = o.requestLog ?? [];
    this.last = 0;
  }

  /**
   * @param {string} method
   * @param {string} path  starts with "/" (or is "" for the base URL itself)
   * @param {{ query?: Record<string, string>, body?: unknown, token?: string,
   *           stopOn?: number[], retry5xx?: boolean }} [o]
   */
  async request(method, path, o = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
    const maxAttempts = method === 'GET' && o.retry5xx !== false ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      const wait = this.last + PAUSE_MS - Date.now();
      if (wait > 0) await sleep(wait);
      /** @type {Record<string, string>} */
      const headers = { 'user-agent': USER_AGENT, accept: 'application/json' };
      if (o.body !== undefined) headers['content-type'] = 'application/json';
      if (o.token) headers.authorization = `Bearer ${o.token}`;
      let res;
      let text;
      try {
        res = await fetch(url, {
          method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        });
        text = await res.text();
      } catch (err) {
        this.last = Date.now();
        this.requestLog.push({ method, path: url.pathname, status: 'network-error' });
        throw new StopProbe(
          `Network error calling ${method} ${url.pathname}: ${err.cause?.code ?? err.name}`,
        );
      }
      this.last = Date.now();
      this.requestLog.push({ method, path: url.pathname, status: res.status });
      /** @type {Record<string, string>} */
      const kept = {};
      for (const h of KEEP_HEADERS) if (res.headers.has(h)) kept[h] = res.headers.get(h) ?? '';
      const setCookie = res.headers.getSetCookie?.() ?? [];
      const out = {
        status: res.status,
        headers: kept,
        // Only cookie NAMES, never values.
        cookieNames: setCookie.map((c) => c.split('=')[0]),
        location: res.headers.has('location') ? '(redirect present)' : undefined,
        text,
      };
      if (res.status === 429) {
        throw new StopProbe(
          `The server answered 429 (too many requests) to ${method} ${url.pathname}. Stopping; wait a while before trying again.`,
          429,
        );
      }
      if (res.status >= 500 && attempt < maxAttempts) {
        const retryAfter = Number(kept['retry-after']);
        const backoff =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 3000 * 2 ** (attempt - 1);
        this.log(
          `  server error ${res.status}, waiting ${Math.round(backoff / 1000)} s before one more try`,
        );
        await sleep(Math.min(backoff, 60_000));
        continue;
      }
      if ((o.stopOn ?? []).includes(res.status)) {
        throw new StopProbe(
          `The server answered ${res.status} to ${method} ${url.pathname}. Stopping here on purpose.`,
          res.status,
        );
      }
      return out;
    }
  }
}

/** Parses `--flag`, `--key value` and `--key=value` into an object. */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}
