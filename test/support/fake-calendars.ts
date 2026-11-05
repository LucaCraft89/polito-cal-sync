import type { CalendarEntry, CalendarsApi } from '../../src/google/calendars.js';
import { GOOGLE_SCOPE, type OAuthFlowClient } from '../../src/google/oauth.js';

export const FAKE_REFRESH_TOKEN = 'refresh-token-for-tests-QQQQ';

/** An in-memory list of the account's calendars. Never a real Google account. */
export class FakeCalendars implements CalendarsApi {
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

/** A fake Google sign-in: records the state and redirect address it was given, never contacts Google. */
export function fakeFlow(tokens: Record<string, unknown> = {}) {
  const seen: { state?: string; redirect?: string; exchanged?: Record<string, unknown> } = {};
  const client: OAuthFlowClient = {
    generateCodeVerifierAsync: () =>
      Promise.resolve({ codeVerifier: 'ver', codeChallenge: 'chal' }),
    generateAuthUrl: (o) => {
      seen.state = String(o.state);
      seen.redirect = String(o.redirect_uri);
      const u = new URL('https://accounts.example.invalid/auth');
      u.searchParams.set('state', seen.state);
      u.searchParams.set('redirect_uri', seen.redirect);
      return u.href;
    },
    getToken: (o) => {
      seen.exchanged = o as unknown as Record<string, unknown>;
      return Promise.resolve({
        tokens: {
          refresh_token: FAKE_REFRESH_TOKEN,
          access_token: 'at',
          scope: GOOGLE_SCOPE,
          ...tokens,
        },
      });
    },
  };
  return { client, seen };
}
