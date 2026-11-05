/* eslint-disable @typescript-eslint/no-unsafe-member-access -- test code reads loose JSON answers */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LoginLatch } from '../src/sources/polito/portal/latch.js';
import { startHarness, type Harness } from './support/web.js';
import { FEED, previewWorld } from './support/preview-world.js';
import { html, opts, PASS, USER, world as portalWorld } from './support/portal-world.js';

// No test here reaches a real server: feeds come from an in-memory fetch, the portal is the invented one of
// test/support/portal-world.ts (and the default of previewWorld() is an offline portal that refuses at once).
const DATA = JSON.parse(
  readFileSync(new URL('./fixtures/polito-portal/student-data.json', import.meta.url), 'utf8'),
) as unknown;
const TOKEN = 'secret-feed-token-AAAABBBBCCCC';
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function setup(
  o: { env?: NodeJS.ProcessEnv; feedText?: () => string; feed?: (url: string) => Response } = {},
) {
  const clock = { t: 1_800_000_000_000 };
  const world = previewWorld(o.feedText);
  const fetched: string[] = [];
  const base = world.deps.fetchImpl as typeof fetch;
  world.deps.fetchImpl = (url: string | URL | Request, init?: RequestInit) => {
    fetched.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
    return o.feed ? Promise.resolve(o.feed(fetched.at(-1) as string)) : base(url, init);
  };
  h = await startHarness({
    env: { TZ: 'Europe/Rome', ...o.env },
    app: { runDeps: world.deps, now: () => clock.t },
  });
  const auth = await h.setup();
  const call = (path: string, body: unknown = {}) =>
    h!.call('POST', path, { body, cookie: auth.cookie, headers: { 'X-CSRF-Token': auth.csrf } });
  const settings = (set: Record<string, unknown>) => h!.put('/api/settings', auth, { set });
  return { clock, world, fetched, auth, call, settings };
}

describe('Test button for a calendar feed', () => {
  it('needs a session and a CSRF token', async () => {
    const s = await setup();
    expect((await h!.call('POST', '/api/sources/feeds/test', { body: { index: 0 } })).status).toBe(
      401,
    );
    const r = await h!.call('POST', '/api/sources/feeds/test', {
      body: { index: 0 },
      cookie: s.auth.cookie,
    });
    expect(r.status).toBe(403);
  });

  it('reads the feed once, reports counts, never shows the address and leaves no cache behind', async () => {
    const s = await setup();
    await s.settings({ icsUrls: [FEED] });
    const r = await s.call('/api/sources/feeds/test', { index: 0 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      label: 'feed #1 (feed.example.invalid)',
      ok: true,
      events: 1,
      cancelled: 0,
      issues: 0,
    });
    expect(r.json.nextAllowedAt).toBe(new Date(s.clock.t + 15 * 60_000).toISOString());
    expect(s.fetched).toEqual([FEED]); // one GET
    expect(existsSync(join(h!.dataDir, 'ics-cache'))).toBe(false);
    expect([r.text, ...h!.logs].join('\n')).not.toContain(TOKEN);
  });

  it('a feed that is refused is a result with the three-line problem, after exactly one attempt', async () => {
    const s = await setup({ feed: () => new Response('x', { status: 503 }) });
    await s.settings({ icsUrls: [FEED] });
    const r = await s.call('/api/sources/feeds/test', { index: 0 });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.problem.code).toBe('E_ICS_FEED_FETCH_FAILED');
    expect(s.fetched).toHaveLength(1); // no backoff loop against a server that is struggling
    expect(r.text).not.toContain(TOKEN);

    const s2 = await setup({ feed: () => new Response('x', { status: 404 }) });
    await s2.settings({ icsUrls: [FEED] });
    expect((await s2.call('/api/sources/feeds/test', { index: 0 })).json.problem.code).toBe(
      'E_ICS_FEED_REJECTED',
    );
  });

  it('a page that is not a calendar is reported as unreadable', async () => {
    const s = await setup({ feedText: () => '<html>please log in</html>' });
    await s.settings({ icsUrls: [FEED] });
    const r = await s.call('/api/sources/feeds/test', { index: 0 });
    expect(r.json.ok).toBe(false);
    expect(r.json.problem.code).toBe('E_ICS_FEED_INVALID');
  });

  it('is limited per feed to once in 15 minutes (a refusal costs no traffic); another address is free', async () => {
    const s = await setup();
    await s.settings({ icsUrls: [FEED, `${FEED}2`] });
    await s.call('/api/sources/feeds/test', { index: 0 });
    const again = await s.call('/api/sources/feeds/test', { index: 0 });
    expect(again.status).toBe(429);
    expect(again.json.error.code).toBe('E_UI_TEST_RATE_LIMITED');
    expect(again.json.error.action).toContain('15 minute');
    expect(s.fetched).toHaveLength(1);
    expect((await s.call('/api/sources/feeds/test', { index: 1 })).status).toBe(200);
    s.clock.t += 14 * 60_000;
    expect((await s.call('/api/sources/feeds/test', { index: 0 })).status).toBe(429);
    s.clock.t += 61_000;
    expect((await s.call('/api/sources/feeds/test', { index: 0 })).status).toBe(200);
  });

  it('at most 10 feed tests in 15 minutes in all', async () => {
    const s = await setup();
    await s.settings({ icsUrls: Array.from({ length: 12 }, (_, i) => `${FEED}-${i}`) });
    for (let i = 0; i < 10; i++)
      expect((await s.call('/api/sources/feeds/test', { index: i })).status, `#${i}`).toBe(200);
    const r = await s.call('/api/sources/feeds/test', { index: 10 });
    expect(r.status).toBe(429);
    expect(s.fetched).toHaveLength(10);
    s.clock.t += 15 * 60_000 + 1;
    expect((await s.call('/api/sources/feeds/test', { index: 10 })).status).toBe(200);
  });

  it('one test at a time', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const s = await setup();
    const base = s.world.deps.fetchImpl as typeof fetch;
    s.world.deps.fetchImpl = async (...a: Parameters<typeof fetch>) => {
      await gate;
      return base(...a);
    };
    await s.settings({ icsUrls: [FEED, `${FEED}2`] });
    const first = s.call('/api/sources/feeds/test', { index: 0 });
    await new Promise((r) => setTimeout(r, 100));
    const second = await s.call('/api/sources/feeds/test', { index: 1 });
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe('E_UI_TEST_BUSY');
    release();
    expect((await first).status).toBe(200);
  });

  it('refuses a feed number that does not exist and a malformed body', async () => {
    const s = await setup();
    await s.settings({ icsUrls: [FEED] });
    const r = await s.call('/api/sources/feeds/test', { index: 3 });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('E_SETTING_INVALID');
    for (const body of [{}, { index: -1 }, { index: 'a' }, { index: 0, url: FEED }]) {
      expect((await s.call('/api/sources/feeds/test', body)).status).toBe(403);
    }
    expect(s.fetched).toHaveLength(0);
  });

  it('numbers the feed as in the list, and works for a list locked by the environment', async () => {
    const s = await setup({ env: { SOURCE_POLITO_ICS_URLS: `${FEED}9,${FEED}8` } });
    const r = await s.call('/api/sources/feeds/test', { index: 1 });
    expect(r.json.label).toBe('feed #2 (feed.example.invalid)');
    expect(s.fetched).toEqual([`${FEED}8`]);
  });
});

describe('Test login for the Polito portal', () => {
  function portal(extra: Parameters<typeof portalWorld>[0] = { data: DATA }) {
    const w = portalWorld(extra);
    return w;
  }
  async function withPortal(w: ReturnType<typeof portalWorld>, password = PASS) {
    const s = await setup();
    s.world.deps.politoPortal = opts(w.fetchImpl);
    await s.settings({ 'polito.username': USER, 'polito.password': password });
    return s;
  }

  it('needs both username and password, and does not touch the network without them', async () => {
    const s = await setup();
    const r = await s.call('/api/sources/polito/test');
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('E_NOT_CONFIGURED');
    expect(s.world.portalAttempts).toEqual([]);
  });

  it('logs in once, reports counts only, and is limited to once per 15 minutes', async () => {
    const w = portal();
    const s = await withPortal(w);
    const r = await s.call('/api/sources/polito/test');
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.courses).toBe(2);
    const sections = r.json.sections as { section: string; issues: number }[];
    expect(sections.map((x) => x.section)).toEqual(['carico', 'orari', 'appelli', 'agenda']);
    expect(sections.every((x) => x.issues === 0)).toBe(true);
    // Counts and codes only: no course names, rooms, titles or the password.
    const everything = [
      r.text,
      ...h!.logs,
      readFileSync(join(h!.dataDir, 'audit.log'), 'utf8'),
    ].join('\n');
    for (const leak of ['Invented', 'Room 9', PASS]) expect(everything).not.toContain(leak);
    const requests = w.log.length;
    expect(requests).toBeGreaterThan(5);
    expect(w.log.filter((l) => l.method === 'POST' && l.url.endsWith('/idp/sso'))).toHaveLength(1);
    // Immediately again: refused, no traffic.
    const again = await s.call('/api/sources/polito/test');
    expect(again.status).toBe(429);
    expect(again.json.error.code).toBe('E_UI_TEST_RATE_LIMITED');
    expect(w.log).toHaveLength(requests);
    s.clock.t += 15 * 60_000 + 1;
    expect((await s.call('/api/sources/polito/test')).status).toBe(200);
  });

  it('a refused login is latched: it is NEVER repeated until the credentials change (decision 018)', async () => {
    const w = portal();
    const s = await withPortal(w, 'a-wrong-password-123');
    const first = await s.call('/api/sources/polito/test');
    expect(first.status).toBe(200);
    expect(first.json.ok).toBe(false);
    expect(first.json.problem.code).toBe('E_POLITO_API_AUTH_REJECTED');
    const posts = () =>
      w.log.filter((l) => l.method === 'POST' && l.url.endsWith('/idp/sso')).length;
    expect(posts()).toBe(1);

    // Even long after the rate limit, the latch holds: answered at once, no request at all.
    const seen = w.log.length;
    s.clock.t += 24 * 3600_000;
    const second = await s.call('/api/sources/polito/test');
    expect(second.json.problem.code).toBe('E_POLITO_LOGIN_BLOCKED');
    expect(second.json.ok).toBe(false);
    expect(w.log).toHaveLength(seen);
    const third = await s.call('/api/sources/polito/test');
    expect(third.json.problem.code).toBe('E_POLITO_LOGIN_BLOCKED'); // not rate limited either: it costs nothing
    expect(w.log).toHaveLength(seen);

    // Changing the credentials lifts it, and the new credentials are not held back by the old attempt's time.
    await s.settings({ 'polito.password': PASS });
    const fixed = await s.call('/api/sources/polito/test');
    expect(fixed.json.ok).toBe(true);
    expect(posts()).toBe(2);
    expect(() => new LoginLatch(h!.dataDir).assertOpen(USER, PASS)).not.toThrow();
  });

  it('the latch is shared with sync and preview: a login they found refused blocks the test', async () => {
    const w = portal();
    const s = await withPortal(w);
    new LoginLatch(h!.dataDir).block(USER, PASS, new Date());
    const r = await s.call('/api/sources/polito/test');
    expect(r.json.problem.code).toBe('E_POLITO_LOGIN_BLOCKED');
    expect(w.log).toHaveLength(0);
  });

  it('an extra step (MFA) is reported, the form is not answered and nothing is latched', async () => {
    const w = portal({
      data: DATA,
      idpAnswer: () =>
        html('<form action="/idp/mfa" method="post"><input name="otp"><button>go</button></form>'),
    });
    const s = await withPortal(w);
    const r = await s.call('/api/sources/polito/test');
    expect(r.json.ok).toBe(false);
    expect(r.json.problem.code).toBe('E_POLITO_LOGIN_EXTRA_STEP');
    expect(w.log.some((l) => l.body.includes('otp'))).toBe(false);
    expect(() => new LoginLatch(h!.dataDir).assertOpen(USER, PASS)).not.toThrow();
  });

  it('an outage is a problem, not a latch', async () => {
    const s = await setup();
    await s.settings({ 'polito.username': USER, 'polito.password': PASS });
    const r = await s.call('/api/sources/polito/test'); // default test portal: offline
    expect(r.json.ok).toBe(false);
    expect(r.json.problem.code).toBe('E_POLITO_API_FETCH_FAILED');
    expect(s.world.portalAttempts.length).toBeGreaterThan(0);
    expect(() => new LoginLatch(h!.dataDir).assertOpen(USER, PASS)).not.toThrow();
  });

  it('a portal answer that is not understood is reported with counts of the parts that were', async () => {
    const w = portal({ data: { success: true, data: { carico: { data: [] } } } });
    const s = await withPortal(w);
    const r = await s.call('/api/sources/polito/test');
    expect(r.json.ok).toBe(false);
    expect(r.json.problem.code).toBe('E_POLITO_API_UNEXPECTED_DATA');
  });

  it('works before the source is switched on (the switch is not needed to test the login)', async () => {
    const w = portal();
    const s = await withPortal(w);
    const st = (await h!.call('GET', '/api/settings', { cookie: s.auth.cookie })).json.settings as {
      key: string;
      value: unknown;
    }[];
    expect(st.find((x) => x.key === 'polito.enabled')?.value).toBe(false);
    expect((await s.call('/api/sources/polito/test')).json.ok).toBe(true);
  });
});
