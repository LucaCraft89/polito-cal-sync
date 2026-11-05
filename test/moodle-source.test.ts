import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MoodleSource } from '../src/sources/moodle/index.js';
import { htmlToText } from '../src/sources/moodle/map.js';
import { MoodleTokenStore, tokenFromRedirect } from '../src/sources/moodle/token.js';
import { LoginLatch } from '../src/sources/polito/portal/latch.js';
import { createLogger } from '../src/util/logger.js';
import { html, PASS, USER } from './support/portal-world.js';
import {
  course,
  event,
  MOODLE,
  moodleOpts,
  moodleWorld,
  TOKEN_A,
  TOKEN_B,
} from './support/moodle-world.js';

// Everything here is invented: no test reaches the real Moodle (decisions 033 to 036).
const NOW = new Date('2027-01-15T10:00:00Z'); // 1_800_000_000 is 2027-01-15T08:00:00Z
const logs: string[] = [];
const logger = createLogger('debug', { write: (m: string) => void logs.push(m) });

function make(
  world: ReturnType<typeof moodleWorld>,
  o: { password?: string; dataDir?: string } = {},
) {
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), 'pcs-moodle-'));
  const source = new MoodleSource({
    username: USER,
    password: o.password ?? PASS,
    baseUrl: MOODLE,
    dataDir,
    logger,
    now: () => NOW,
    portal: moodleOpts(world.fetchImpl),
  });
  return { source, dataDir };
}
const logins = (w: ReturnType<typeof moodleWorld>) =>
  w.log.filter((l) => l.method === 'POST' && l.url.endsWith('/idp/sso')).length;

describe('Moodle source: mapping', () => {
  it('turns events into kind "moodle" with a label, the course, a link and plain text', async () => {
    const w = moodleWorld({
      courses: [course(11, 'Invented Chemistry')],
      events: [
        event(1),
        event(2, { timeduration: 5400, name: 'Lab', description: '' }),
        event(3, { visible: 0 }),
      ],
    });
    const { source } = make(w);
    const r = await source.fetch();
    expect(r.complete).toBe(true);
    expect(r.events).toHaveLength(2); // the hidden one is left out
    const [a, b] = r.events;
    expect(a).toMatchObject({
      source: 'moodle',
      sourceId: '1',
      kind: 'moodle',
      title: '[Moodle] Quiz 1 opens',
      start: '2027-01-15T09:00:00.000Z',
      end: '2027-01-15T09:00:00.000Z', // a point in time
      allDay: false,
      course: 'moodle:11',
      url: `${MOODLE}/course/view.php?id=11`,
    });
    expect(a?.description).toBe('Course: Invented Chemistry\n\nOpen the quiz & good luck');
    expect(b?.end).toBe('2027-01-15T11:30:00.000Z'); // start + 5400 s
    expect(b?.description).toBe('Course: Invented Chemistry');
    expect(source.courseNames.get('moodle:11')).toBe('Invented Chemistry');
  });

  it('asks for a window of a year each way, with the courses, user and site events', async () => {
    const w = moodleWorld({ courses: [course(11, 'A'), course(12, 'B')] });
    await make(w).source.fetch();
    const p = w.calls.find((c) => c.fn === 'core_calendar_get_calendar_events')?.params;
    expect(Number(p?.get('options[timestart]'))).toBe(
      Math.floor(NOW.getTime() / 1000) - 366 * 86400,
    );
    expect(Number(p?.get('options[timeend]'))).toBe(Math.floor(NOW.getTime() / 1000) + 366 * 86400);
    expect(p?.get('events[courseids][0]')).toBe('11');
    expect(p?.get('events[courseids][1]')).toBe('12');
    expect(p?.get('options[userevents]')).toBe('1');
    expect(p?.get('options[siteevents]')).toBe('1');
  });

  it('htmlToText keeps text only', () => {
    expect(htmlToText('<div>a<br/>b</div><script>x</script>&lt;t&gt;')).toBe('a\nb\n<t>');
  });
});

describe('Moodle source: login and token', () => {
  it('logs in once through the SSO, keeps the token (0600) and reuses it without a new login', async () => {
    const w = moodleWorld({ events: [event(1)] });
    const { source, dataDir } = make(w);
    expect((await source.fetch()).complete).toBe(true);
    expect(logins(w)).toBe(1);
    expect(statSync(join(dataDir, 'moodle-token.json')).mode & 0o777).toBe(0o600);
    expect(new MoodleTokenStore(dataDir).read(USER)).toBe(TOKEN_A);
    const before = w.log.length;
    expect((await make(w, { dataDir }).source.fetch()).complete).toBe(true);
    expect(logins(w)).toBe(1); // no second login
    expect(w.log.length - before).toBe(3); // site, courses, events
    expect(new MoodleTokenStore(dataDir).read('someone-else')).toBeUndefined();
  });

  it('the token goes in the POST body, never in an address, a log or an error', async () => {
    const w = moodleWorld({ events: [event(1)] });
    await make(w).source.fetch();
    expect(
      w.log
        .filter((l) => l.url.includes('webservice'))
        .every((l) => l.body.includes(`wstoken=${TOKEN_A}`)),
    ).toBe(true);
    expect(w.log.some((l) => l.url.includes(TOKEN_A))).toBe(false);
    expect(logs.join('\n')).not.toContain(TOKEN_A);
    expect(logs.join('\n')).not.toContain(PASS);
  });

  it('a refused saved token: one new login, one retry, then it works', async () => {
    const w = moodleWorld({ events: [event(1)] });
    const { source, dataDir } = make(w);
    await source.fetch();
    w.state.token = TOKEN_B; // Moodle reset the token
    w.state.nextToken = TOKEN_B;
    const r = await make(w, { dataDir }).source.fetch();
    expect(r.complete).toBe(true);
    expect(logins(w)).toBe(2);
    expect(new MoodleTokenStore(dataDir).read(USER)).toBe(TOKEN_B);
  });

  it('a token that is refused right after a fresh login is NOT retried in a loop', async () => {
    const w = moodleWorld({ events: [event(1)] });
    w.state.token = TOKEN_B; // login keeps handing out TOKEN_A, which Moodle refuses
    const { source } = make(w);
    const r = await source.fetch();
    expect(r).toMatchObject({ complete: false, events: [] });
    expect(source.lastReport[0]?.error?.code).toBe('E_MOODLE_API_ERROR');
    expect(logins(w)).toBe(1);
  });

  it('a refused university login is latched for the account and never repeated (decision 018)', async () => {
    const w = moodleWorld();
    const { source, dataDir } = make(w, { password: 'a-wrong-password-123' }); // secret-scan:ignore
    const r = await source.fetch();
    expect(r.complete).toBe(false);
    expect(source.lastReport[0]?.error?.code).toBe('E_POLITO_API_AUTH_REJECTED');
    expect(() => new LoginLatch(dataDir).assertOpen(USER, 'a-wrong-password-123')).toThrow();
    const again = make(w, { password: 'a-wrong-password-123', dataDir }); // secret-scan:ignore
    await again.source.fetch();
    expect(again.source.lastReport[0]?.error?.code).toBe('E_POLITO_LOGIN_BLOCKED');
    expect(logins(w)).toBe(1);
  });

  it('a latch written by the portal source blocks Moodle as well (one account)', async () => {
    const w = moodleWorld();
    const { source, dataDir } = make(w);
    new LoginLatch(dataDir).block(USER, PASS, NOW);
    await source.fetch();
    expect(source.lastReport[0]?.error?.code).toBe('E_POLITO_LOGIN_BLOCKED');
    expect(w.log).toHaveLength(0);
  });

  it('an extra login step is reported, not answered, and not latched', async () => {
    const w = moodleWorld({
      idpAnswer: () => html('<form action="/idp/mfa" method="post"><input name="otp"></form>'),
    });
    const { source, dataDir } = make(w);
    expect((await source.fetch()).complete).toBe(false);
    expect(source.lastReport[0]?.error?.code).toBe('E_POLITO_LOGIN_EXTRA_STEP');
    expect(w.log.some((l) => l.body.includes('otp'))).toBe(false);
    expect(() => new LoginLatch(dataDir).assertOpen(USER, PASS)).not.toThrow();
  });

  it('tokenFromRedirect parses the app redirect and nothing else', () => {
    const ok = `moodlemobile://token=${Buffer.from(`s:::${TOKEN_A}:::p`).toString('base64')}`;
    expect(tokenFromRedirect(ok)).toBe(TOKEN_A);
    expect(tokenFromRedirect('https://x/token=abc')).toBeUndefined();
    expect(tokenFromRedirect('moodlemobile://token=%%%')).toBeUndefined();
    expect(
      tokenFromRedirect(`moodlemobile://token=${Buffer.from('s:::short').toString('base64')}`),
    ).toBeUndefined();
  });
});

describe('Moodle source: fail closed', () => {
  it('a Moodle exception on any call: incomplete, nothing returned, the code is named', async () => {
    const w = moodleWorld({ exceptions: { core_calendar_get_calendar_events: 'accessexception' } });
    const { source } = make(w);
    const r = await source.fetch();
    expect(r).toMatchObject({ complete: false, events: [] });
    expect(source.lastReport[0]?.error?.code).toBe('E_MOODLE_API_ERROR');
    expect(source.lastReport[0]?.error?.what).toContain('accessexception');
  });

  it('an answer without the event list is not an empty calendar', async () => {
    const w = moodleWorld();
    const base = w.fetchImpl;
    const f = ((i: string | URL | Request, init?: RequestInit) =>
      typeof init?.body === 'string' && init.body.includes('get_calendar_events')
        ? Promise.resolve(new Response(JSON.stringify({ nothing: true })))
        : base(i, init)) as typeof fetch;
    const source = new MoodleSource({
      username: USER,
      password: PASS,
      baseUrl: MOODLE,
      dataDir: mkdtempSync(join(tmpdir(), 'pcs-moodle-')),
      now: () => NOW,
      portal: moodleOpts(f),
    });
    const r = await source.fetch();
    expect(r).toMatchObject({ complete: false, events: [] });
    expect(source.lastReport[0]?.error?.code).toBe('E_POLITO_API_UNEXPECTED_DATA');
  });

  it('one event with an unexpected shape: the others are kept, the result is incomplete (no deletions)', async () => {
    const w = moodleWorld({ events: [event(1), { id: 'x', name: 5 }, event(3), event(3)] });
    const { source } = make(w);
    const r = await source.fetch();
    expect(r.complete).toBe(false);
    expect(r.events.map((e) => e.sourceId)).toEqual(['1', '3']);
    const issues = source.lastReport.find((x) => x.step === 'events')?.issues ?? [];
    expect(issues).toHaveLength(2);
    expect(issues.join(' ')).not.toContain('Quiz');
  });

  it('a server error or timeout is an outage, not a login failure', async () => {
    const source = new MoodleSource({
      username: USER,
      password: PASS,
      baseUrl: MOODLE,
      dataDir: mkdtempSync(join(tmpdir(), 'pcs-moodle-')),
      now: () => NOW,
      portal: moodleOpts(() => Promise.resolve(new Response(null, { status: 503 }))),
    });
    expect((await source.fetch()).complete).toBe(false);
    expect(source.lastReport[0]?.error?.code).toBe('E_POLITO_API_FETCH_FAILED');
  });

  it('refuses a host that is not allowed (the token and password go nowhere else)', async () => {
    const w = moodleWorld();
    const source = new MoodleSource({
      username: USER,
      password: PASS,
      baseUrl: 'https://evil.example.test',
      dataDir: mkdtempSync(join(tmpdir(), 'pcs-moodle-')),
      now: () => NOW,
      portal: moodleOpts(w.fetchImpl),
    });
    expect((await source.fetch()).complete).toBe(false);
    expect(w.log).toHaveLength(0);
  });
});

describe('Moodle source in a real sync (fake Google, invented Moodle)', () => {
  it('creates the events, a second run is a no-op, a removed event is deleted only from a complete read', async () => {
    const { runConfiguredSync } = await import('../src/sync/run.js');
    const { loadConfig } = await import('../src/config/index.js');
    const { MemoryEventsApi } = await import('../src/google/memory.js');
    const w = moodleWorld({
      courses: [course(11, 'Invented Chemistry')],
      events: [event(1), event(2), event(3)],
    });
    const api = new MemoryEventsApi();
    const dataDir = mkdtempSync(join(tmpdir(), 'pcs-moodle-e2e-'));
    const config = loadConfig({
      DATA_DIR: dataDir,
      TZ: 'Europe/Rome',
      SOURCE_MOODLE_ENABLED: 'true',
      MOODLE_BASE_URL: MOODLE,
      POLITO_USERNAME: USER,
      POLITO_PASSWORD: PASS,
      DELETE_THRESHOLD: '0.5',
    });
    const deps = {
      now: () => NOW,
      sleep: () => Promise.resolve(),
      politoPortal: moodleOpts(w.fetchImpl),
      googleFactory: () => Promise.resolve({ api, calendarId: 'cal' }),
    };
    const run = () => runConfiguredSync({ config, logger, deps }, { dryRun: false, force: false });

    const first = await run();
    expect(first.report.applied).toMatchObject({ created: 3 });
    expect(first.courseNames.get('moodle:11')).toBe('Invented Chemistry');
    const written = api.snapshot('cal');
    expect(written).toHaveLength(3);
    expect(written[0]?.summary).toMatch(/^\[Moodle\] Quiz/);
    expect(written.every((e) => e.extendedProperties?.private?.['polito_cal_sync'] === '1')).toBe(
      true,
    );

    const second = await run();
    expect(second.report.plan).toMatchObject({
      creates: [],
      patches: [],
      deletes: [],
      unchanged: 3,
    });

    // Moodle changes an event and drops one: patched and deleted (one of three is within the 50% limit).
    w.state.events = [event(1, { name: 'Quiz 1 moved', timestart: 1_800_100_000 }), event(2)];
    const third = await run();
    expect(third.report.applied).toMatchObject({ created: 0, patched: 1, deleted: 1 });

    // An outage deletes nothing.
    const before = api.snapshot('cal').filter((e) => e.status !== 'cancelled').length;
    w.state.token = 'something-else-entirely-000000000000'; // every call is refused, also after a new login
    const down = await run();
    expect(down.report.plan.incompleteSources).toContain('moodle');
    expect(down.report.plan.deletes).toHaveLength(0);
    expect(api.snapshot('cal').filter((e) => e.status !== 'cancelled')).toHaveLength(before);
    expect(down.sourceErrors[0]?.source).toBe('moodle');
  });
});
