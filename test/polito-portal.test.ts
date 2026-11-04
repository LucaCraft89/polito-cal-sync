import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoginLatch } from '../src/sources/polito/portal/latch.js';
import { PortalSession } from '../src/sources/polito/portal/login.js';
import { formatUserError, type UserError } from '../src/util/errors.js';
import { html, IDP, LOGIN_FORM, opts, PASS, PORTAL, USER, world } from './support/portal-world.js';

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
