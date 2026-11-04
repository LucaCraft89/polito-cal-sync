import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDedicatedCalendar,
  CalendarChoice,
  chooseCalendar,
  DEFAULT_CALENDAR_NAME,
  type CalendarEntry,
  type CalendarsApi,
} from '../src/google/calendars.js';
import { MemoryEventsApi, type TombstonePatch } from '../src/google/memory.js';
import {
  GOOGLE_SCOPE,
  loopbackAuthorize,
  TokenStore,
  type OAuthFlowClient,
} from '../src/google/oauth.js';
import { verifyGoogle } from '../src/google/verify.js';
import { OwnedCalendar } from '../src/google/calendar.js';
import { isUserError } from '../src/util/errors.js';
import { CAL, draft, event } from './support/helpers.js';
import { toGoogleEvent } from '../src/sync/mapper.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'pcs-g-'));

class FakeCalendars implements CalendarsApi {
  readonly entries = new Map<string, CalendarEntry>();
  deleted: string[] = [];
  failDelete = false;
  private n = 0;
  add(e: Partial<CalendarEntry> & { id: string }): void {
    this.entries.set(e.id, { summary: e.id, primary: false, accessRole: 'owner', ...e });
  }
  list = () => Promise.resolve([...this.entries.values()]);
  get = (id: string) => {
    const e = this.entries.get(id);
    return e ? Promise.resolve(e) : Promise.reject(new Error('missing'));
  };
  insert = (p: { summary: string }) => {
    const e: CalendarEntry = {
      id: `new-${++this.n}`,
      summary: p.summary,
      primary: false,
      accessRole: 'owner',
    };
    this.entries.set(e.id, e);
    return Promise.resolve(e);
  };
  delete = (id: string) => {
    if (this.failDelete) return Promise.reject(new Error('nope'));
    this.deleted.push(id);
    this.entries.delete(id);
    return Promise.resolve();
  };
}

describe('TokenStore', () => {
  it('writes the login with mode 0600 and reads it back', () => {
    const d = tmp();
    const s = new TokenStore(d);
    expect(s.read()).toBeUndefined();
    s.write({ refresh_token: 'rt-1', access_token: 'a' });
    expect(statSync(join(d, 'google-token.json')).mode & 0o777).toBe(0o600);
    expect(s.read()?.refresh_token).toBe('rt-1');
  });
  it('a damaged file is E_GOOGLE_AUTH_EXPIRED and does not echo the content', () => {
    const d = tmp();
    writeFileSync(join(d, 'google-token.json'), '{"refresh_token": "NOPE"'); // not valid JSON
    try {
      new TokenStore(d).read();
      expect.unreachable();
    } catch (e) {
      expect(isUserError(e) && e.code).toBe('E_GOOGLE_AUTH_EXPIRED');
      expect(String((e as Error).message)).not.toContain('NOPE');
    }
  });
});

describe('loopbackAuthorize', () => {
  function fakeClient(tokens: Record<string, unknown>) {
    const calls: { authUrl?: URL; exchange?: Record<string, unknown> } = {};
    const client: OAuthFlowClient = {
      generateCodeVerifierAsync: () =>
        Promise.resolve({ codeVerifier: 'ver', codeChallenge: 'chal' }),
      generateAuthUrl: (o) => {
        const u = new URL('https://accounts.example.invalid/auth');
        for (const [k, v] of Object.entries(o))
          u.searchParams.set(k, Array.isArray(v) ? v.join(' ') : String(v));
        calls.authUrl = u;
        return u.href;
      },
      getToken: (o) => {
        calls.exchange = o as unknown as Record<string, unknown>;
        return Promise.resolve({ tokens });
      },
    };
    return { client, calls };
  }

  it('prints the URL, receives the redirect on 127.0.0.1, checks state, exchanges with PKCE', async () => {
    const { client, calls } = fakeClient({
      refresh_token: 'rt',
      access_token: 'at',
      scope: GOOGLE_SCOPE,
    });
    let wrong = 0;
    const result = await loopbackAuthorize(client, {
      bind: '127.0.0.1',
      port: 0,
      timeoutMs: 5000,
      announce: (url) => {
        const u = new URL(url);
        const redirect = new URL(u.searchParams.get('redirect_uri') as string);
        expect(redirect.hostname).toBe('127.0.0.1');
        expect(u.searchParams.get('access_type')).toBe('offline');
        expect(u.searchParams.get('code_challenge_method')).toBe('S256');
        void (async () => {
          // A request with the wrong state is ignored (and answered 400)...
          const bad = await fetch(`${redirect.href}?code=evil&state=nope`);
          wrong = bad.status;
          // ...the real redirect completes the flow.
          await fetch(`${redirect.href}?code=good-code&state=${u.searchParams.get('state')}`);
        })();
      },
    });
    expect(wrong).toBe(400);
    expect(result.tokens.refresh_token).toBe('rt');
    expect(calls.exchange?.['code']).toBe('good-code');
    expect(calls.exchange?.['codeVerifier']).toBe('ver');
    expect(calls.exchange?.['redirect_uri']).toBe(result.redirectUri);
  });

  const runWith = (
    client: OAuthFlowClient,
    redirectQuery: (state: string) => string,
    timeoutMs = 3000,
  ) =>
    loopbackAuthorize(client, {
      bind: '127.0.0.1',
      port: 0,
      timeoutMs,
      announce: (url) => {
        const u = new URL(url);
        const redirect = u.searchParams.get('redirect_uri') as string;
        void fetch(`${redirect}?${redirectQuery(u.searchParams.get('state') as string)}`);
      },
    });

  it('a cancelled sign-in is E_GOOGLE_AUTH_FAILED', async () => {
    const { client } = fakeClient({});
    await expect(runWith(client, (s) => `error=access_denied&state=${s}`)).rejects.toMatchObject({
      code: 'E_GOOGLE_AUTH_FAILED',
    });
  });
  it('no refresh token, or missing calendar scope, is E_GOOGLE_AUTH_FAILED and saves nothing', async () => {
    await expect(
      runWith(
        fakeClient({ access_token: 'a', scope: GOOGLE_SCOPE }).client,
        (s) => `code=c&state=${s}`,
      ),
    ).rejects.toMatchObject({ code: 'E_GOOGLE_AUTH_FAILED' });
    await expect(
      runWith(
        fakeClient({ refresh_token: 'r', scope: 'openid' }).client,
        (s) => `code=c&state=${s}`,
      ),
    ).rejects.toMatchObject({ code: 'E_GOOGLE_AUTH_FAILED' });
  });
  it('times out when nothing comes back', async () => {
    const { client } = fakeClient({});
    await expect(
      loopbackAuthorize(client, {
        bind: '127.0.0.1',
        port: 0,
        timeoutMs: 50,
        announce: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'E_GOOGLE_AUTH_FAILED' });
  });
});

describe('dedicated calendar', () => {
  it('creates one when none exists, and reuses it the next time', async () => {
    const admin = new FakeCalendars();
    admin.add({ id: 'me@example.invalid', summary: 'me', primary: true });
    const first = await chooseCalendar(admin, { tz: 'Europe/Rome' });
    expect(first.action).toBe('created');
    expect(first.summary).toBe(DEFAULT_CALENDAR_NAME);
    const second = await chooseCalendar(admin, { tz: 'Europe/Rome' });
    expect([second.action, second.id]).toEqual(['reused', first.id]);
  });
  it('never uses or picks the primary calendar', async () => {
    const admin = new FakeCalendars();
    admin.add({ id: 'me@example.invalid', summary: DEFAULT_CALENDAR_NAME, primary: true });
    // A primary calendar with our name is not "reused": a new one is created.
    expect((await chooseCalendar(admin, { tz: 'Europe/Rome' })).action).toBe('created');
    for (const id of ['primary', 'me@example.invalid']) {
      await expect(assertDedicatedCalendar(admin, id)).rejects.toMatchObject({
        code: 'E_GOOGLE_CALENDAR_IS_PRIMARY',
      });
    }
  });
  it('refuses a read-only calendar', async () => {
    const admin = new FakeCalendars();
    admin.add({ id: 'ro', accessRole: 'reader' });
    await expect(assertDedicatedCalendar(admin, 'ro')).rejects.toMatchObject({
      code: 'E_GOOGLE_PERMISSION_DENIED',
    });
  });
  it('remembers the choice in DATA_DIR', () => {
    const d = tmp();
    const c = new CalendarChoice(d);
    expect(c.read()).toBeUndefined();
    c.write('abc');
    expect(c.read()).toBe('abc');
    expect(statSync(join(d, 'google-calendar.json')).mode & 0o777).toBe(0o600);
  });
});

describe('restoring a deleted event (decision 002 / 010)', () => {
  for (const behaviour of ['restores', 'answers-410', 'stays-cancelled'] as TombstonePatch[]) {
    it(`works whether patch ${behaviour}: falls back to update`, async () => {
      const api = new MemoryEventsApi(250, behaviour);
      const cal = new OwnedCalendar(api, CAL, { sleep: () => Promise.resolve(), random: () => 1 });
      const g = toGoogleEvent(event(1), 'Europe/Rome') as ReturnType<typeof toGoogleEvent> & {
        id: string;
      };
      await cal.create(g);
      await cal.listManaged();
      await cal.delete(g.id);
      const outcome = await cal.create({ ...g, summary: 'back' });
      expect(outcome).toBe('revived');
      const stored = api.snapshot(CAL).find((e) => e.id === g.id);
      expect(stored?.status).toBe('confirmed');
      expect(stored?.summary).toBe('back');
      expect(stored?.extendedProperties?.private?.['polito_cal_sync']).toBe('1');
      expect(api.calls.some((c) => c.op === 'update')).toBe(behaviour !== 'restores');
    });
  }
});

describe('verify-google', () => {
  for (const [behaviour, patchWorks, updateWorks] of [
    ['restores', true, undefined],
    ['answers-410', false, true],
    ['stays-cancelled', false, true],
  ] as [TombstonePatch, boolean, boolean | undefined][]) {
    it(`reports a patch that ${behaviour}, on a throw-away calendar it removes again`, async () => {
      const admin = new FakeCalendars();
      const api = new MemoryEventsApi(250, behaviour);
      const lines: string[] = [];
      const r = await verifyGoogle(admin, api, 'Europe/Rome', (l) => lines.push(l));
      expect(r.tombstoneIsCancelled).toBe(true);
      expect(r.tombstoneKeepsMarker).toBe(false);
      expect(r.insertAfterDeleteStatus).toBe(409);
      expect(r.patchRestores).toBe(patchWorks);
      expect(r.updateRestores).toBe(updateWorks);
      expect(r.cleanedUp).toBe(true);
      expect(admin.deleted).toHaveLength(1);
      expect(admin.entries.size).toBe(0);
      expect(r.recommendation.length).toBeGreaterThan(10);
      expect(lines.join('\n')).not.toContain('verify event');
    });
  }
  it('tells the user which calendar to delete by hand if cleanup fails', async () => {
    const admin = new FakeCalendars();
    admin.failDelete = true;
    const r = await verifyGoogle(admin, new MemoryEventsApi(), 'Europe/Rome');
    expect(r.cleanedUp).toBe(false);
    expect(r.steps.at(-1)).toContain('Delete the calendar named');
  });
  void draft;
});
