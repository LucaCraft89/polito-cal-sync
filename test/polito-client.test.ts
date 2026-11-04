import { describe, expect, it } from 'vitest';
import {
  PolitoHttpClient,
  UnavailableAuth,
  type PolitoAuth,
} from '../src/sources/polito/client.js';
import { formatUserError, UserError } from '../src/util/errors.js';
import { USER_AGENT } from '../src/util/version.js';

const TOKEN = 'tok-INVENTED-0123456789abcdefghij';
const auth = (): PolitoAuth & { invalidated: number } => ({
  invalidated: 0,
  token: () => Promise.resolve(TOKEN),
  invalidate() {
    this.invalidated++;
  },
});

function client(
  responses: (() => Response)[],
  a: PolitoAuth = auth(),
  extra: { sleeps?: number[] } = {},
) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  let n = 0;
  const c = new PolitoHttpClient({
    auth: a,
    baseUrl: 'https://api.example.invalid/api/',
    pauseMs: 7,
    baseMs: 1,
    maxMs: 10,
    random: () => 0.5,
    sleep: (ms) => {
      extra.sleeps?.push(ms);
      return Promise.resolve();
    },
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const make = responses[Math.min(n++, responses.length - 1)] as () => Response;
      return Promise.resolve(make());
    },
  });
  return { c, seen };
}
const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), { status, headers });

describe('Polito HTTP client', () => {
  it('sends the honest User-Agent and a bearer token, builds the URL, pauses between requests', async () => {
    const sleeps: number[] = [];
    const { c, seen } = client([json([1])], auth(), { sleeps });
    expect(await c.get('/lectures', { fromDate: '2026-01-01' })).toEqual([1]);
    await c.get('/exams');
    expect(seen[0]?.url).toBe('https://api.example.invalid/api/lectures?fromDate=2026-01-01');
    expect(seen[0]?.headers['User-Agent']).toBe(USER_AGENT);
    expect(seen[0]?.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(sleeps).toEqual([7]); // none before the first request, one pause before the second
  });

  it('never retries 401/403, drops the token, and the message has no token or body', async () => {
    for (const status of [401, 403]) {
      const a = auth();
      const { c, seen } = client([json({ secret: 'leak-me' }, status)], a);
      const err = await c.get('/lectures').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UserError);
      expect((err as UserError).code).toBe('E_POLITO_API_AUTH_REJECTED');
      expect(seen).toHaveLength(1);
      expect(a.invalidated).toBe(1);
      const text = formatUserError(err);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('leak-me');
    }
  });

  it('retries 5xx with backoff, then succeeds', async () => {
    const { c, seen } = client([json({}, 503), json({}, 500), json(['ok'])]);
    expect(await c.get('/exams')).toEqual(['ok']);
    expect(seen).toHaveLength(3);
  });

  it('after exhausted 429s it fails and makes no further requests in the run', async () => {
    const { c, seen } = client([json({}, 429, { 'retry-after': '1' })]);
    const err = await c.get('/exams').catch((e: unknown) => e);
    expect((err as UserError).code).toBe('E_POLITO_API_FETCH_FAILED');
    expect(seen).toHaveLength(4);
    const again = await c.get('/lectures').catch((e: unknown) => e);
    expect((again as UserError).code).toBe('E_POLITO_API_FETCH_FAILED');
    expect(seen).toHaveLength(4); // nothing more was sent
  });

  it('an answer that is not JSON is UNEXPECTED_DATA', async () => {
    const { c } = client([() => new Response('<html>login</html>', { status: 200 })]);
    const err = await c.get('/exams').catch((e: unknown) => e);
    expect((err as UserError).code).toBe('E_POLITO_API_UNEXPECTED_DATA');
  });

  it('a redirect (for example to a login page) is not followed and is a failure', async () => {
    const { c } = client([
      () =>
        new Response(null, { status: 302, headers: { location: 'https://idp.example.invalid/' } }),
    ]);
    const err = await c.get('/exams').catch((e: unknown) => e);
    expect((err as UserError).code).toBe('E_POLITO_API_FETCH_FAILED');
  });
});

describe('UnavailableAuth', () => {
  it('says plainly that login is not available yet', async () => {
    const err = await new UnavailableAuth().token().catch((e: unknown) => e);
    expect((err as UserError).code).toBe('E_POLITO_API_NOT_READY');
  });
});
