import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli/index.js';
import { loadConfig } from '../src/config/index.js';
import { runDoctor, formatChecks, type Check } from '../src/doctor/index.js';
import { CalendarChoice } from '../src/google/calendars.js';
import { TokenStore } from '../src/google/oauth.js';
import { LoginLatch } from '../src/sources/polito/portal/latch.js';
import { StateStore } from '../src/sync/state.js';
import { createLogger } from '../src/util/logger.js';
import { FakeCalendars } from './support/fake-calendars.js';
import { FEED, ics, NOW } from './support/preview-world.js';
import { opts, PASS, USER, world as portalWorld } from './support/portal-world.js';

// Everything is fake: in-memory calendars, an in-memory feed, the invented portal. Nothing reaches a real server.
const DATA = JSON.parse(
  readFileSync(new URL('./fixtures/polito-portal/student-data.json', import.meta.url), 'utf8'),
) as unknown;
const TOKEN = 'secret-feed-token-AAAABBBBCCCC';
const logger = createLogger('silent', { write: () => undefined });

function setup(
  env: NodeJS.ProcessEnv = {},
  o: { calendars?: FakeCalendars; connected?: boolean } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pcs-doc-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    TZ: 'Europe/Rome',
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'client-secret-for-tests', // secret-scan:ignore
    ...env,
  });
  const calendars = o.calendars ?? new FakeCalendars();
  if (!o.calendars) {
    calendars.add({ id: 'me@example.invalid', summary: 'me', primary: true });
    calendars.add({ id: 'cal', summary: 'Polito (polito-cal-sync)' });
  }
  if (o.connected !== false) {
    new TokenStore(dataDir).write({ refresh_token: 'rt' });
    new CalendarChoice(dataDir).write('cal', 'Polito (polito-cal-sync)');
  }
  const fetched: string[] = [];
  const portal = portalWorld({ data: DATA });
  const run = (extra: { local?: boolean; now?: () => Date } = {}) =>
    runDoctor({
      config,
      logger,
      ...(extra.local ? { local: true } : {}),
      deps: {
        calendars,
        now: extra.now ?? (() => NOW),
        sleep: () => Promise.resolve(),
        politoPortal: opts(portal.fetchImpl),
        fetchImpl: (input) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          fetched.push(url);
          return Promise.resolve(
            url.endsWith('missing.ics')
              ? new Response('x', { status: 404 })
              : new Response(ics(['a', '20261110T090000Z', 'Fisica']), { status: 200 }),
          );
        },
      },
    });
  return { dataDir, config, run, fetched, portal, calendars };
}
const by = (checks: Check[], id: string) => checks.find((c) => c.id === id);

describe('doctor', () => {
  it('everything fine: every check ok, only "no sync yet" is a warning', async () => {
    const s = setup({
      SOURCE_POLITO_ICS_URLS: FEED,
      SOURCE_POLITO_PORTAL_ENABLED: 'true',
      POLITO_USERNAME: USER,
      POLITO_PASSWORD: PASS,
    });
    const checks = await s.run();
    expect(checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      'data-dir:ok',
      'clock:ok',
      'state:ok',
      'google:ok',
      'feed-1:ok',
      'polito:ok',
      'last-sync:warn',
    ]);
    expect(by(checks, 'google')?.detail).toContain('Polito (polito-cal-sync)');
    expect(by(checks, 'feed-1')?.detail).toBe('1 event(s), 0 cancelled left out');
    expect(by(checks, 'polito')?.detail).toContain('2 course(s)');
    const text = formatChecks(checks);
    expect(text).toContain('Nothing is broken; 1 warning(s).');
    for (const secret of [TOKEN, PASS, 'client-secret-for-tests', 'Invented', 'Fisica'])
      expect(text).not.toContain(secret);
  });

  it('not connected to Google: a fail with the three lines', async () => {
    const s = setup({}, { connected: false });
    const g = by(await s.run(), 'google');
    expect(g?.status).toBe('fail');
    expect(g?.error?.code).toBe('E_NOT_CONFIGURED');
  });

  it('a missing client, the main calendar and a read-only calendar are reported', async () => {
    const noClient = setup({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' });
    expect(by(await noClient.run(), 'google')?.error?.code).toBe('E_GOOGLE_CLIENT_MISSING');
    const primary = setup();
    new CalendarChoice(primary.dataDir).write('me@example.invalid');
    expect(by(await primary.run(), 'google')?.error?.code).toBe('E_GOOGLE_CALENDAR_IS_PRIMARY');
    const ro = setup();
    ro.calendars.add({ id: 'ro', summary: 'ro', accessRole: 'reader' });
    new CalendarChoice(ro.dataDir).write('ro');
    expect(by(await ro.run(), 'google')?.error?.code).toBe('E_GOOGLE_PERMISSION_DENIED');
  });

  it('a feed that is refused fails, names the feed by host only, and the others are still checked', async () => {
    const s = setup({
      SOURCE_POLITO_ICS_URLS: `https://feed.example.invalid/${TOKEN}/missing.ics,${FEED}`,
    });
    const checks = await s.run();
    expect(by(checks, 'feed-1')).toMatchObject({
      status: 'fail',
      error: { code: 'E_ICS_FEED_REJECTED' },
    });
    expect(by(checks, 'feed-2')?.status).toBe('ok');
    expect(s.fetched).toHaveLength(2); // one GET each, no retries
    expect(formatChecks(checks)).not.toContain(TOKEN);
    expect(formatChecks(checks)).toContain('feed #1 (feed.example.invalid)');
  });

  it('no source on: a warning', async () => {
    const checks = await setup().run();
    expect(by(checks, 'sources')).toMatchObject({
      status: 'warn',
      error: { code: 'E_NOT_CONFIGURED' },
    });
  });

  it('a paused Polito login is reported without any request; a refused one latches', async () => {
    const env = {
      SOURCE_POLITO_PORTAL_ENABLED: 'true',
      POLITO_USERNAME: USER,
      POLITO_PASSWORD: PASS,
    };
    const paused = setup(env);
    new LoginLatch(paused.dataDir).block(USER, PASS, NOW);
    const p = by(await paused.run(), 'polito');
    expect(p?.status).toBe('fail');
    expect(p?.error?.code).toBe('E_POLITO_LOGIN_BLOCKED');
    expect(paused.portal.log).toHaveLength(0);

    const wrong = setup({ ...env, POLITO_PASSWORD: 'a-wrong-password-123' });
    expect(by(await wrong.run(), 'polito')?.error?.code).toBe('E_POLITO_API_AUTH_REJECTED');
    const posts = () =>
      wrong.portal.log.filter((l) => l.method === 'POST' && l.url.endsWith('/idp/sso')).length;
    expect(posts()).toBe(1);
    expect(by(await wrong.run(), 'polito')?.error?.code).toBe('E_POLITO_LOGIN_BLOCKED'); // not repeated
    expect(posts()).toBe(1);
  });

  it('--local contacts nobody', async () => {
    const s = setup({
      SOURCE_POLITO_ICS_URLS: FEED,
      SOURCE_POLITO_PORTAL_ENABLED: 'true',
      POLITO_USERNAME: USER,
      POLITO_PASSWORD: PASS,
    });
    const checks = await s.run({ local: true });
    expect(s.fetched).toHaveLength(0);
    expect(s.portal.log).toHaveLength(0);
    expect(by(checks, 'google')?.status).toBe('skipped');
    expect(by(checks, 'feed-1')?.status).toBe('skipped');
    expect(by(checks, 'polito')?.status).toBe('skipped');
  });

  it('a wrong clock fails', async () => {
    const s = setup();
    const c = by(await s.run({ now: () => new Date('2001-01-01T00:00:00Z') }), 'clock');
    expect(c?.status).toBe('fail');
  });

  it('reports the last run: failed or refused is a warning with its code', async () => {
    const s = setup();
    const db = StateStore.open(StateStore.fileIn(s.dataDir));
    const id = db.startRun({ calendarId: 'cal', forced: false, now: NOW });
    db.finishRun(
      id,
      {
        status: 'refused',
        created: 0,
        patched: 0,
        deleted: 5,
        unchanged: 0,
        failed: 0,
        errorCode: 'E_DELETE_THRESHOLD',
      },
      NOW,
    );
    db.close();
    const l = by(await s.run(), 'last-sync');
    expect(l).toMatchObject({ status: 'warn', error: { code: 'E_DELETE_THRESHOLD' } });
  });
});

describe('cli: doctor', () => {
  function cli(env: NodeJS.ProcessEnv) {
    const out: string[] = [];
    const io: CliIo = {
      out: (t) => void out.push(t),
      err: () => undefined,
      logStream: { write: () => undefined },
    };
    return runCli(['doctor', '--local'], env, io).then((code) => ({ code, out: out.join('\n') }));
  }
  it('exits 1 when something fails and prints the three-line form', async () => {
    const r = await cli({ DATA_DIR: mkdtempSync(join(tmpdir(), 'pcs-doc-')), TZ: 'Europe/Rome' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('[FAIL] Google login and calendar');
    expect(r.out).toContain('E_GOOGLE_CLIENT_MISSING');
    expect(r.out).toContain('Docs: docs/ERRORS.md#e_google_client_missing');
  });
  it('exits 0 with warnings only', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pcs-doc-'));
    new TokenStore(dataDir).write({ refresh_token: 'rt' });
    new CalendarChoice(dataDir).write('cal');
    const r = await cli({
      DATA_DIR: dataDir,
      TZ: 'Europe/Rome',
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'client-secret-for-tests',
    }); // secret-scan:ignore
    expect(r.code).toBe(0);
  });
});
