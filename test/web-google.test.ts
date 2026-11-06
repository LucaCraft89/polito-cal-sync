/* eslint-disable @typescript-eslint/no-unsafe-member-access -- test code reads loose JSON answers */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TokenStore } from '../src/google/oauth.js';
import { CalendarChoice } from '../src/google/calendars.js';
import { FakeCalendars, fakeFlow, FAKE_REFRESH_TOKEN } from './support/fake-calendars.js';
import { startHarness, type Harness } from './support/web.js';

// Nothing here talks to Google: the sign-in is a fake OAuth client (the same shape as the real one) and the
// calendar list is in memory. The "browser" is a plain request to the loopback address the flow listens on.
const CLIENT_SECRET = 'client-secret-for-tests-ZZZZ'; // secret-scan:ignore
const REFRESH = FAKE_REFRESH_TOKEN;
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function setup(opts: { env?: NodeJS.ProcessEnv; calendars?: FakeCalendars } = {}) {
  const flow = fakeFlow();
  const calendars = opts.calendars ?? new FakeCalendars();
  if (!opts.calendars) {
    calendars.add({ id: 'me@example.invalid', summary: 'me@example.invalid', primary: true });
    calendars.add({ id: 'work', summary: 'Work' });
    calendars.add({ id: 'holidays', summary: 'Holidays', accessRole: 'reader' });
  }
  h = await startHarness({
    env: opts.env ?? {},
    app: { google: { flowClient: flow.client, calendars }, googleConnectTimeoutMs: 5000 },
  });
  const auth = await h.setup();
  const call = (method: string, path: string, body?: unknown) =>
    h!.call(method, path, {
      ...(method !== 'GET' ? { body: body ?? {} } : {}),
      cookie: auth.cookie,
      headers: { 'X-CSRF-Token': auth.csrf },
    });
  const saveClient = () =>
    h!.put('/api/settings', auth, {
      set: { 'google.clientId': 'client-id-for-tests', 'google.clientSecret': CLIENT_SECRET },
    });
  return { flow, calendars, auth, call, saveClient };
}

/** Plays the browser coming back from Google. */
async function comeBack(seen: { state?: string; redirect?: string }, query = 'code=the-code') {
  return fetch(`${seen.redirect}?state=${seen.state}&${query}`);
}
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await read();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
}

describe('Google connect in the UI', () => {
  it('needs a session, and a CSRF token for every change', async () => {
    const s = await setup();
    expect((await h!.call('GET', '/api/google')).status).toBe(401);
    expect((await h!.call('GET', '/api/google/calendars')).status).toBe(401);
    for (const path of [
      '/api/google/connect',
      '/api/google/connect/cancel',
      '/api/google/calendar',
    ]) {
      const r = await h!.call('POST', path, { body: {}, cookie: s.auth.cookie });
      expect(r.status, path).toBe(403);
      expect(r.json.error.code).toBe('E_UI_REQUEST_REFUSED');
    }
  });

  it('starts empty: nothing saved, nothing connected, no tokens or secrets in the answer', async () => {
    const s = await setup();
    const r = await s.call('GET', '/api/google');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      clientConfigured: false,
      connected: false,
      calendarLocked: false,
      splitMoodle: false,
      moodleCalendarLocked: false,
      connect: { state: 'idle' },
    });
  });

  it('refuses to connect without the client id and secret (three-line error, 409)', async () => {
    const s = await setup();
    const r = await s.call('POST', '/api/google/connect');
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('E_GOOGLE_CLIENT_MISSING');
    expect(r.json.error.action).toContain('Settings');
  });

  it('connect: waits for the browser, checks the state, saves the login (0600), shows account and never leaks a secret', async () => {
    const s = await setup();
    await s.saveClient();
    const start = await s.call('POST', '/api/google/connect');
    expect(start.status).toBe(200);
    expect(start.json.state).toBe('waiting');
    expect(start.json.authUrl).toBe(
      `https://accounts.example.invalid/auth?state=${s.flow.seen.state}&redirect_uri=${encodeURIComponent(s.flow.seen.redirect!)}`,
    );
    expect(start.json.redirectPort).toBe(Number(new URL(s.flow.seen.redirect!).port));
    expect(new URL(s.flow.seen.redirect!).hostname).toBe('127.0.0.1');

    // The status shows the waiting sign-in, and a second start joins it instead of opening another port.
    const waiting = await s.call('GET', '/api/google');
    expect(waiting.json.connect.state).toBe('waiting');
    expect(waiting.json.connected).toBe(false);
    const again = await s.call('POST', '/api/google/connect');
    expect(again.json.redirectPort).toBe(start.json.redirectPort);

    // A request with the wrong state is ignored; the real redirect finishes the sign-in.
    const wrong = await fetch(`${s.flow.seen.redirect}?state=nope&code=x`);
    expect(wrong.status).toBe(400);
    expect((await s.call('GET', '/api/google')).json.connect.state).toBe('waiting');
    const back = await comeBack(s.flow.seen);
    expect(await back.text()).toContain('go back to the program');

    const done = await until(
      () => s.call('GET', '/api/google'),
      (r) => r.json.connect.state === 'done',
    );
    expect(done.json).toMatchObject({
      clientConfigured: true,
      connected: true,
      account: 'me@example.invalid',
      connect: { state: 'done' },
    });
    expect(done.json.calendar).toBeUndefined();
    expect(s.flow.seen.exchanged).toMatchObject({ codeVerifier: 'ver', code: 'the-code' });
    expect(new TokenStore(h!.dataDir).read()?.refresh_token).toBe(REFRESH);
    expect(statSync(join(h!.dataDir, 'google-token.json')).mode & 0o777).toBe(0o600);

    // Nothing secret in any answer, the audit log or the server log.
    const everything = [
      start.text,
      done.text,
      (await s.call('GET', '/api/settings')).text,
      (await s.call('GET', '/api/audit')).text,
      h!.logs.join('\n'),
      readFileSync(join(h!.dataDir, 'audit.log'), 'utf8'),
    ].join('\n');
    expect(everything).not.toContain(REFRESH);
    expect(everything).not.toContain(CLIENT_SECRET);
    expect(everything).not.toContain('the-code');
    const entries = (await s.call('GET', '/api/audit')).json.entries as { action: string }[];
    const audit = entries.map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['google.connect.started', 'google.connected']));
  });

  it('cancel ends the wait, frees the port and saves nothing', async () => {
    const s = await setup();
    await s.saveClient();
    await s.call('POST', '/api/google/connect');
    await s.call('POST', '/api/google/connect/cancel');
    const r = await until(
      () => s.call('GET', '/api/google'),
      (x) => x.json.connect.state === 'failed',
    );
    expect(r.json.connect.error.code).toBe('E_GOOGLE_AUTH_FAILED');
    expect(r.json.connected).toBe(false);
    expect(existsSync(join(h!.dataDir, 'google-token.json'))).toBe(false);
    await expect(fetch(s.flow.seen.redirect!)).rejects.toThrow(); // the listener is gone
  });

  it('a refusal on the Google page (Cancel) is a failed connect with the three-line error', async () => {
    const s = await setup();
    await s.saveClient();
    await s.call('POST', '/api/google/connect');
    await fetch(`${s.flow.seen.redirect}?state=${s.flow.seen.state}&error=access_denied`);
    const r = await until(
      () => s.call('GET', '/api/google'),
      (x) => x.json.connect.state === 'failed',
    );
    expect(r.json.connect.error).toMatchObject({
      code: 'E_GOOGLE_AUTH_FAILED',
      docs: 'docs/ERRORS.md#e_google_auth_failed',
    });
    expect(r.json.connect.error.why).toContain('access_denied');
  });

  it('times out when the browser never comes back', async () => {
    const flow = fakeFlow();
    h = await startHarness({
      app: {
        google: { flowClient: flow.client, calendars: new FakeCalendars() },
        googleConnectTimeoutMs: 50,
      },
    });
    const a = await h.setup();
    await h.put('/api/settings', a, {
      set: { 'google.clientId': 'id', 'google.clientSecret': CLIENT_SECRET },
    });
    await h.call('POST', '/api/google/connect', {
      body: {},
      cookie: a.cookie,
      headers: { 'X-CSRF-Token': a.csrf },
    });
    const r = await until(
      () => h!.call('GET', '/api/google', { cookie: a.cookie }),
      (x) => x.json.connect.state === 'failed',
    );
    expect(r.json.connect.error.why).toContain('Nothing came back');
  });

  it('a port that is already taken is answered at once, not left waiting', async () => {
    const first = await setup({ env: {} });
    await first.saveClient();
    await first.call('POST', '/api/google/connect');
    const port = new URL(first.flow.seen.redirect!).port;
    await first.call('POST', '/api/google/connect/cancel');
    await h!.close();
    // Occupy a port, then ask for exactly that one.
    const { createServer } = await import('node:net');
    const busy = createServer();
    await new Promise<void>((ok) => busy.listen(Number(port), '127.0.0.1', ok));
    try {
      const s = await setup({ env: { GOOGLE_AUTH_PORT: port } });
      await s.saveClient();
      const r = await s.call('POST', '/api/google/connect');
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('E_GOOGLE_AUTH_FAILED');
      expect(r.json.error.why).toContain('already in use');
    } finally {
      busy.close();
    }
  });
});

describe('calendar picker', () => {
  it('lists only calendars that can be used: never the main one, never read-only', async () => {
    const s = await setup();
    const r = await s.call('GET', '/api/google/calendars');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      calendars: [{ id: 'work', name: 'Work', current: false }],
      hidden: 2,
    });
  });

  it('picks an existing calendar and remembers its name', async () => {
    const s = await setup();
    const r = await s.call('POST', '/api/google/calendar', { id: 'work' });
    expect(r.status).toBe(200);
    expect(r.json.calendar).toEqual({ name: 'Work' });
    expect(new CalendarChoice(h!.dataDir).read()).toBe('work');
    expect((await s.call('GET', '/api/google/calendars')).json.calendars[0].current).toBe(true);
  });

  it('NEVER the main calendar: its id and "primary" are refused and nothing is saved', async () => {
    const s = await setup();
    for (const id of ['me@example.invalid', 'primary']) {
      const r = await s.call('POST', '/api/google/calendar', { id });
      expect(r.status, id).toBe(422);
      expect(r.json.error.code).toBe('E_GOOGLE_CALENDAR_IS_PRIMARY');
    }
    expect(new CalendarChoice(h!.dataDir).read()).toBeUndefined();
  });

  it('refuses a calendar the account can only read', async () => {
    const s = await setup();
    const r = await s.call('POST', '/api/google/calendar', { id: 'holidays' });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('E_GOOGLE_PERMISSION_DENIED');
  });

  it('creates the dedicated calendar (default or chosen name) and reuses one of the same name', async () => {
    const s = await setup();
    const made = await s.call('POST', '/api/google/calendar', { create: {} });
    expect(made.json.calendar.name).toBe('Polito (polito-cal-sync)');
    expect(s.calendars.entries.size).toBe(4);
    const again = await s.call('POST', '/api/google/calendar', { create: {} });
    expect(again.json.calendar.name).toBe('Polito (polito-cal-sync)');
    expect(s.calendars.entries.size).toBe(4); // reused, not created twice
    const named = await s.call('POST', '/api/google/calendar', { create: { name: 'Uni' } });
    expect(named.json.calendar.name).toBe('Uni');
    expect(s.calendars.entries.size).toBe(5);
  });

  it('validates the body: unknown fields, empty names and control characters are refused', async () => {
    const s = await setup();
    for (const body of [
      {},
      { id: '' },
      { id: 'a', create: {} },
      { create: { name: '' } },
      { create: { name: 'a\nb' } },
      { create: { name: 'x'.repeat(101) } },
      { id: 'work', extra: 1 },
    ]) {
      const r = await s.call('POST', '/api/google/calendar', body);
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(r.json.error.code).toBe('E_UI_REQUEST_REFUSED');
    }
    expect(s.calendars.entries.size).toBe(3);
  });

  it('GOOGLE_CALENDAR_ID in the environment locks the choice', async () => {
    const s = await setup({ env: { GOOGLE_CALENDAR_ID: 'work' } });
    const st = await s.call('GET', '/api/google');
    expect(st.json.calendarLocked).toBe(true);
    expect(st.json.calendar).toEqual({});
    const r = await s.call('POST', '/api/google/calendar', { id: 'work' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('E_SETTING_LOCKED');
  });

  it('a calendar id saved as a setting is replaced by the new choice, so the choice wins', async () => {
    const s = await setup();
    await h!.put('/api/settings', s.auth, { set: { 'google.calendarId': 'old' } });
    await s.call('POST', '/api/google/calendar', { id: 'work' });
    const settings = (await s.call('GET', '/api/settings')).json.settings as {
      key: string;
      set: boolean;
    }[];
    expect(settings.find((x) => x.key === 'google.calendarId')?.set).toBe(false);
  });

  it('listing without a saved login says Google is not connected', async () => {
    const flow = fakeFlow();
    h = await startHarness({ app: { google: { flowClient: flow.client } } });
    const a = await h.setup();
    await h.put('/api/settings', a, {
      set: { 'google.clientId': 'id', 'google.clientSecret': CLIENT_SECRET },
    });
    const r = await h.call('GET', '/api/google/calendars', { cookie: a.cookie });
    expect(r.json.error.code).toBe('E_NOT_CONFIGURED');
  });
});

describe('another Google account', () => {
  it('signing in with a different account drops the calendar chosen for the first one', async () => {
    const calendars = new FakeCalendars();
    calendars.add({ id: 'first@example.invalid', summary: 'first', primary: true });
    calendars.add({ id: 'work', summary: 'Work' });
    const s = await setup({ calendars });
    await s.saveClient();
    await s.call('POST', '/api/google/connect');
    await comeBack(s.flow.seen);
    await until(
      () => s.call('GET', '/api/google'),
      (r) => r.json.connect.state === 'done',
    );
    await s.call('POST', '/api/google/calendar', { id: 'work' });
    expect(new CalendarChoice(h!.dataDir).read()).toBe('work');

    // Same account again: the choice stays.
    await s.call('POST', '/api/google/connect');
    await comeBack(s.flow.seen);
    await until(
      () => s.call('GET', '/api/google'),
      (r) => r.json.connect.state === 'done',
    );
    expect(new CalendarChoice(h!.dataDir).read()).toBe('work');

    // Another account: the old calendar id is not valid there and must not stay selected.
    calendars.entries.delete('first@example.invalid');
    calendars.add({ id: 'second@example.invalid', summary: 'second', primary: true });
    await s.call('POST', '/api/google/connect');
    await comeBack(s.flow.seen);
    const r = await until(
      () => s.call('GET', '/api/google'),
      (x) => x.json.connect.state === 'done',
    );
    expect(r.json.account).toBe('second@example.invalid');
    expect(r.json.calendar).toBeUndefined();
    expect(new CalendarChoice(h!.dataDir).read()).toBeUndefined();
  });
});

describe('a second calendar for Moodle events', () => {
  it('shows the split setting and the Moodle calendar; picks and creates it in its own slot, never the same as the Polito one', async () => {
    const s = await setup();
    const status = async (): Promise<Record<string, unknown>> =>
      (await s.call('GET', '/api/google')).json as Record<string, unknown>;
    expect(await status()).toMatchObject({ splitMoodle: false, moodleCalendarLocked: false });
    expect((await status()).moodleCalendar).toBeUndefined();

    await s.call('POST', '/api/google/calendar', { id: 'work' });
    // Same calendar for Moodle: refused, nothing saved.
    const same = await s.call('POST', '/api/google/calendar', { id: 'work', slot: 'moodle' });
    expect(same.status).toBe(409);
    expect(same.json.error.code).toBe('E_GOOGLE_CALENDARS_SAME');
    expect((await status()).moodleCalendar).toBeUndefined();

    // Create it: default name, in the Moodle slot; the Polito calendar is untouched.
    const made = await s.call('POST', '/api/google/calendar', { create: {}, slot: 'moodle' });
    expect(made.status).toBe(200);
    expect(made.json.moodleCalendar.name).toBe('Moodle (polito-cal-sync)');
    expect(made.json.calendar.name).toBe('Work');
    expect(new CalendarChoice(h!.dataDir).read()).toBe('work');
    expect(new CalendarChoice(h!.dataDir, 'google-calendar-moodle.json').read()).toBeDefined();

    // The Polito calendar cannot be moved onto the Moodle one either.
    const moodleId = new CalendarChoice(h!.dataDir, 'google-calendar-moodle.json').read();
    const back = await s.call('POST', '/api/google/calendar', { id: moodleId, slot: 'polito' });
    expect(back.json.error.code).toBe('E_GOOGLE_CALENDARS_SAME');

    // The list marks the current one per slot; the main calendar is never offered.
    const list = (await s.call('GET', '/api/google/calendars?slot=moodle')).json.calendars as {
      id: string;
      current: boolean;
    }[];
    expect(list.find((c) => c.id === moodleId)?.current).toBe(true);
    expect(list.some((c) => c.id === 'me@example.invalid')).toBe(false);
    const primary = await s.call('POST', '/api/google/calendar', {
      id: 'me@example.invalid',
      slot: 'moodle',
    });
    expect(primary.json.error.code).toBe('E_GOOGLE_CALENDAR_IS_PRIMARY');
  });

  it('the setting is saved like the others, and the Moodle calendar id can be locked by the environment', async () => {
    const s = await setup();
    await h!.put('/api/settings', s.auth, { set: { 'calendars.splitMoodle': true } });
    expect((await s.call('GET', '/api/google')).json.splitMoodle).toBe(true);
    await h!.close();
    const locked = await setup({
      env: { GOOGLE_MOODLE_CALENDAR_ID: 'work', CALENDAR_SPLIT_MOODLE: 'true' },
    });
    const st = (await locked.call('GET', '/api/google')).json as unknown;
    expect(st).toMatchObject({ splitMoodle: true, moodleCalendarLocked: true, moodleCalendar: {} });
    const r = await locked.call('POST', '/api/google/calendar', { id: 'work', slot: 'moodle' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('E_SETTING_LOCKED');
    expect(r.json.error.what).toContain('GOOGLE_MOODLE_CALENDAR_ID');
  });
});
