import { UserError } from '../../util/errors.js';
import { retry } from '../../util/retry.js';
import { USER_AGENT } from '../../util/version.js';
import { ENDPOINTS } from './fields.js';

/** UNVERIFIED (docs/RESEARCH.md). The probe settles it; this is the only place that names the host. */
export const DEFAULT_POLITO_API_BASE = 'https://app.didattica.polito.it/api';

/**
 * How the source gets a token. The login method for an unattended server (password only? enrolled MFA
 * device?) is exactly what the M3 probe has to settle, so NO real implementation exists yet:
 * `UnavailableAuth` is what ships. A real one must (a) never log or print credentials, (b) never retry a
 * rejected login, (c) keep secrets only in DATA_DIR (0600).
 */
export interface PolitoAuth {
  token(): Promise<string>;
  /** Called after a 401: drop any cached token. The client does NOT retry the request. */
  invalidate(): void;
}

export class UnavailableAuth implements PolitoAuth {
  token(): Promise<string> {
    return Promise.reject(
      new UserError({
        code: 'E_POLITO_API_NOT_READY',
        what: 'The Polito API source is switched on, but this version cannot log in to it yet.',
        why: 'How an unattended server can log in (password only, or an enrolled MFA device) is still unverified. The owner-run probe in probe/ settles it.',
        action:
          'Nothing was deleted and the ICS source is unaffected. Set SOURCE_POLITO_API_ENABLED=false to silence this, or follow docs/M3-RUNBOOK.md.',
      }),
    );
  }
  invalidate(): void {
    /* nothing cached */
  }
}

/** The calls the source needs. Tests replace it; production uses PolitoHttpClient. */
export interface PolitoApi {
  /** Every method resolves with the parsed JSON body, untrusted: the source validates it. */
  get(path: string, query?: Record<string, string>): Promise<unknown>;
}

export interface HttpClientOptions {
  auth: PolitoAuth;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  /** Pause before every request after the first, to stay gentle. Default 1000 ms. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

class HttpStatus extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status}`);
  }
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  return Number.isFinite(secs) ? Math.max(0, secs) * 1000 : undefined;
}

/**
 * One request at a time, honest User-Agent, bearer token (scheme UNVERIFIED), timeout, backoff on
 * 429/5xx/network errors. 401/403 are never retried. Errors never contain the token or the response body.
 */
export class PolitoHttpClient implements PolitoApi {
  private requests = 0;
  /** Set after a 429: the source stops asking for the rest of this run. */
  rateLimited = false;

  constructor(private readonly o: HttpClientOptions) {}

  async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    if (this.rateLimited)
      throw this.fetchFailed('the server asked us to slow down earlier in this run (429)');
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    if (this.requests++ > 0) await sleep(this.o.pauseMs ?? 1000);
    const token = await this.o.auth.token();
    const url = new URL((this.o.baseUrl ?? DEFAULT_POLITO_API_BASE).replace(/\/+$/, '') + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const doFetch = this.o.fetchImpl ?? fetch;
    try {
      return await retry(
        async () => {
          const res = await doFetch(url, {
            method: 'GET',
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
            },
            redirect: 'manual',
            signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
          });
          if (res.status === 401 || res.status === 403) {
            this.o.auth.invalidate();
            throw new UserError({
              code: 'E_POLITO_API_AUTH_REJECTED',
              what: `The Polito server refused our access to ${path} (HTTP ${res.status}).`,
              why: 'Expired or wrong credentials, or the account needs multi-factor authentication that has not been completed.',
              action:
                'Nothing was deleted and the login is not retried automatically. Check the credentials and read docs/M3-RUNBOOK.md about MFA.',
            });
          }
          if (res.status === 429 || res.status >= 500) {
            await res.body?.cancel();
            throw new HttpStatus(res.status, retryAfter(res.headers.get('retry-after')));
          }
          if (res.status < 200 || res.status >= 300) {
            await res.body?.cancel();
            throw this.fetchFailed(`HTTP ${res.status} for ${path}`);
          }
          try {
            return await res.json();
          } catch {
            throw this.unexpected(path, 'the answer is not JSON');
          }
        },
        {
          attempts: this.o.attempts ?? 4,
          baseMs: this.o.baseMs ?? 1000,
          maxMs: this.o.maxMs ?? 60_000,
          shouldRetry: (err) => !(err instanceof UserError),
          retryAfterMs: (err) => (err instanceof HttpStatus ? err.retryAfterMs : undefined),
          ...(this.o.sleep ? { sleep: this.o.sleep } : {}),
          ...(this.o.random ? { random: this.o.random } : {}),
        },
      );
    } catch (err) {
      if (err instanceof UserError) throw err;
      if (err instanceof HttpStatus && err.status === 429) this.rateLimited = true;
      throw this.fetchFailed(
        err instanceof HttpStatus
          ? `HTTP ${err.status} for ${path}`
          : `no usable answer for ${path}`,
        err,
      );
    }
  }

  private fetchFailed(what: string, cause?: unknown): UserError {
    return new UserError({
      code: 'E_POLITO_API_FETCH_FAILED',
      what: `A request to the Polito API failed: ${what}.`,
      why: 'The service is down or busy, this machine is offline, or we asked too often.',
      action:
        'Nothing was deleted. The next scheduled run tries again; after a 429 no more requests are made in the same run.',
      cause,
    });
  }

  private unexpected(path: string, problem: string): UserError {
    return new UserError({
      code: 'E_POLITO_API_UNEXPECTED_DATA',
      what: `The Polito API answer for ${path} was not understood: ${problem}.`,
      why: 'Polito changed its API, or our description of it was a guess that the real data does not match.',
      action: 'Nothing was deleted. See docs/M3-RUNBOOK.md and report it (without content).',
    });
  }
}

export { ENDPOINTS };
