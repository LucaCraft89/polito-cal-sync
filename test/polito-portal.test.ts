import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoginLatch } from '../src/sources/polito/portal/latch.js';
import { PortalSession } from '../src/sources/polito/portal/login.js';
import { formatUserError, type UserError } from '../src/util/errors.js';

// An invented identity provider and portal, as a fake fetch. Flow shape follows decision 018.
const PORTAL = 'https://portal.example.test';
const IDP = 'https://idp.example.test';
const USER = 'u123456';
const PASS = 'p4ss-INVENTED-word';

const html = (body: string, headers: Record<string, string | string[]> = {}) => {
  const h = new Headers({ 'content-type': 'text/html' });
  for (const [k, v] of Object.entries(headers)) for (const x of [v].flat()) h.append(k, x);
  return new Response(body, { status: 200, headers: h });
};
const redirect = (to: string, cookies: string[] = [], status = 302) => {
  const h = new Headers({ location: to });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status, headers: h });
};
const LOGIN_FORM = `<form action="/idp/sso?execution=e1s1" method="post">
  <input type="hidden" name="csrf_token" value="CSRF1">
  <input name="j_username"><input type="password" name="j_password">
  <input type="hidden" name="_eventId_proceed" value="">
  <input type="checkbox" name="donotcache" value="1">
  <button name="_eventId_fudispasskeys" value="">passkey</button></form>`;

interface Opts {
  idpAnswer?: (form: URLSearchParams) => Response;
  samlAction?: string;
}

function world(o: Opts = {}) {
  const log: { method: string; url: string; body: string; cookie: string }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    const cookie = (init?.headers as Record<string, string>)['Cookie'] ?? '';
    log.push({ method, url: `${url.origin}${url.pathname}`, body, cookie });
    const key = `${method} ${url.origin}${url.pathname}`;
    const form = new URLSearchParams(body);
    switch (key) {
      case `GET ${PORTAL}/login`:
        return Promise.resolve(redirect(`${IDP}/idp/sso`, ['PORTALPRE=1; Path=/; Secure']));
      case `GET ${IDP}/idp/sso`:
        return Promise.resolve(
          url.search
            ? html(LOGIN_FORM, { 'set-cookie': '__Host-J=abc; Path=/; Secure' })
            : redirect(`${IDP}/idp/sso?execution=e1s1`),
        );
      case `POST ${IDP}/idp/sso`:
        return Promise.resolve(
          o.idpAnswer
            ? o.idpAnswer(form)
            : form.get('j_password') === PASS &&
                form.get('csrf_token') === 'CSRF1' &&
                form.get('_eventId_proceed') === '1' &&
                !form.has('donotcache')
              ? html(
                  `<form action="${o.samlAction ?? `${PORTAL}/sp/acs`}" method="post"><input type="hidden" name="RelayState" value="r"><input type="hidden" name="SAMLResponse" value="S"></form>`,
                  { 'set-cookie': 'IDPS=zz; Path=/; Secure; Max-Age=7776000' },
                )
              : html(LOGIN_FORM),
        );
      case `POST ${PORTAL}/sp/acs`:
        return Promise.resolve(redirect(`${PORTAL}/home`, ['SESS=s1; Path=/; Secure']));
      case `GET ${PORTAL}/home`:
        return Promise.resolve(html('<html>welcome</html>'));
      case `GET ${PORTAL}/data`:
        return Promise.resolve(
          cookie.includes('SESS=s1')
            ? new Response(JSON.stringify({ ok: true }), { status: 200 })
            : html('<html>login</html>'),
        );
      default:
        return Promise.resolve(new Response('no', { status: 404 }));
    }
  }) as typeof fetch;
  return { fetchImpl, log };
}

const opts = (fetchImpl: typeof fetch, extra: object = {}) => ({
  fetchImpl,
  startUrl: `${PORTAL}/login`,
  allowedHosts: ['portal.example.test', 'idp.example.test'],
  pauseMs: 0,
  sleep: () => Promise.resolve(),
  ...extra,
});

describe('PortalSession.login', () => {
  it('follows the flow, posts the password once to the IdP only, then reads JSON with the session', async () => {
    const w = world();
    const session = await PortalSession.login(USER, PASS, opts(w.fetchImpl));
    expect(await session.getJson('/data')).toEqual({ ok: true });
    const posts = w.log.filter((l) => l.method === 'POST');
    expect(posts.map((p) => p.url)).toEqual([`${IDP}/idp/sso`, `${PORTAL}/sp/acs`]);
    expect(posts[0]?.body).toContain('j_password');
    expect(posts[1]?.body).not.toContain('j_password');
    expect(w.log.filter((l) => l.body.includes(encodeURIComponent(PASS)))).toHaveLength(1);
    // cookies are replayed per host: the IdP cookie goes to the IdP only
    expect(w.log.find((l) => l.url === `${PORTAL}/home`)?.cookie).toBe('PORTALPRE=1; SESS=s1');
    expect(w.log.find((l) => l.url === `${PORTAL}/sp/acs`)?.cookie).not.toContain('__Host-J');
  });

  it('a redisplayed login form means refused: one attempt only, no password in the message', async () => {
    const w = world({ idpAnswer: () => html(LOGIN_FORM) });
    const err = await PortalSession.login(USER, 'wrong-PASS-word', opts(w.fetchImpl)).catch(
      (e: unknown) => e,
    );
    expect((err as UserError).code).toBe('E_POLITO_API_AUTH_REJECTED');
    expect(w.log.filter((l) => l.method === 'POST')).toHaveLength(1);
    expect(formatUserError(err)).not.toContain('wrong-PASS-word');
  });

  it('any other form at the IdP is an extra step (MFA) and is not answered', async () => {
    const w = world({
      idpAnswer: () => html('<form action="/mfa" method="post"><input name="otp_code"></form>'),
    });
    const err = await PortalSession.login(USER, PASS, opts(w.fetchImpl)).catch((e: unknown) => e);
    expect((err as UserError).code).toBe('E_POLITO_LOGIN_EXTRA_STEP');
    expect(w.log.filter((l) => l.method === 'POST')).toHaveLength(1);
  });

  it('refuses a form or redirect that points to a host outside the allow-list; the SAML answer is not forwarded', async () => {
    const w = world({ samlAction: 'https://evil.example.test/acs' });
    const err = await PortalSession.login(USER, PASS, opts(w.fetchImpl)).catch((e: unknown) => e);
    expect((err as UserError).code).toBe('E_POLITO_API_UNEXPECTED_DATA');
    expect(w.log.some((l) => l.url.startsWith('https://evil'))).toBe(false);
  });

  it('never sends the password to a login form on a foreign host', async () => {
    const w = world();
    const evilForm = LOGIN_FORM.replace(
      '/idp/sso?execution=e1s1',
      'https://evil.example.test/steal',
    );
    const f = ((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      return u.pathname === '/idp/sso' && u.search
        ? Promise.resolve(html(evilForm))
        : w.fetchImpl(input, init);
    }) as typeof fetch;
    const err = await PortalSession.login(USER, PASS, opts(f)).catch((e: unknown) => e);
    expect((err as UserError).code).toBe('E_POLITO_API_UNEXPECTED_DATA');
    expect(w.log.some((l) => l.body.includes('j_password'))).toBe(false);
  });

  it('429 and 5xx are fetch failures, not login failures', async () => {
    for (const status of [429, 503]) {
      const f = (() => Promise.resolve(new Response(null, { status }))) as typeof fetch;
      const err = await PortalSession.login(USER, PASS, opts(f)).catch((e: unknown) => e);
      expect((err as UserError).code).toBe('E_POLITO_API_FETCH_FAILED');
    }
  });

  it('a data answer that is a login page (expired session) is not mistaken for data', async () => {
    const w = world();
    const session = await PortalSession.login(USER, PASS, opts(w.fetchImpl));
    const err = await session.getJson('/data-other').catch((e: unknown) => e);
    expect((err as UserError).code).toBe('E_POLITO_API_UNEXPECTED_DATA');
  });

  it('refuses http hosts unless listed as insecure (tests only)', async () => {
    const f = (() => Promise.resolve(new Response('x'))) as typeof fetch;
    const err = await PortalSession.login(USER, PASS, {
      fetchImpl: f,
      startUrl: 'http://portal.example.test/login',
      allowedHosts: ['portal.example.test'],
    }).catch((e: unknown) => e);
    expect((err as UserError).code).toBe('E_POLITO_API_UNEXPECTED_DATA');
  });
});

describe('LoginLatch', () => {
  it('blocks the same credentials after a refusal and opens when they change', () => {
    const latch = new LoginLatch(mkdtempSync(join(tmpdir(), 'pcs-latch-')));
    latch.assertOpen(USER, PASS);
    latch.block(USER, PASS, new Date('2026-11-04T10:00:00Z'));
    expect(() => latch.assertOpen(USER, PASS)).toThrowError(/E_POLITO_LOGIN_BLOCKED/);
    expect(() => latch.assertOpen(USER, 'a-new-PASS-word')).not.toThrow();
    latch.clear();
    expect(() => latch.assertOpen(USER, PASS)).not.toThrow();
  });
});
