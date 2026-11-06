// Shared fake university login + portal for tests (all data invented).
// An invented identity provider and portal, as a fake fetch. Flow shape follows decision 018.
export const PORTAL = 'https://portal.example.test';
export const IDP = 'https://idp.example.test';
export const USER = 'u123456';
export const PASS = 'p4ss-INVENTED-word';

export const html = (body: string, headers: Record<string, string | string[]> = {}) => {
  const h = new Headers({ 'content-type': 'text/html' });
  for (const [k, v] of Object.entries(headers)) for (const x of [v].flat()) h.append(k, x);
  return new Response(body, { status: 200, headers: h });
};
const redirect = (to: string, cookies: string[] = [], status = 302) => {
  const h = new Headers({ location: to });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status, headers: h });
};
export const LOGIN_FORM = `<form action="/idp/sso?execution=e1s1" method="post">
  <input type="hidden" name="csrf_token" value="CSRF1">
  <input name="j_username"><input type="password" name="j_password">
  <input type="hidden" name="_eventId_proceed" value="">
  <input type="checkbox" name="donotcache" value="1">
  <button name="_eventId_fudispasskeys" value="">passkey</button></form>`;

export interface Opts {
  /** JSON served at the student-data path to a logged-in session. */
  data?: unknown;
  idpAnswer?: (form: URLSearchParams) => Response;
  samlAction?: string;
}

export function world(o: Opts = {}) {
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
      case `GET ${PORTAL}/pls/portal30/sviluppo.studente.getStudentData`:
        return Promise.resolve(
          cookie.includes('SESS=s1')
            ? new Response(JSON.stringify(o.data ?? {}), { status: 200 })
            : html('<html>login</html>'),
        );
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

export const opts = (fetchImpl: typeof fetch, extra: object = {}) => ({
  fetchImpl,
  startUrl: `${PORTAL}/login`,
  allowedHosts: ['portal.example.test', 'idp.example.test'],
  pauseMs: 0,
  sleep: () => Promise.resolve(),
  ...extra,
});
