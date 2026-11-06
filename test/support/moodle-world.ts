// An invented Moodle behind the invented identity provider of portal-world.ts (all data invented). It follows the
// shape seen in probes 06 to 08 (decisions 033 to 035): app launch -> SSO -> a `moodlemobile://token=...` redirect,
// then the REST web service with the token in the POST body.
import { html, IDP, LOGIN_FORM, PASS } from './portal-world.js';

export const MOODLE = 'https://moodle.example.test';
export const TOKEN_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const TOKEN_B = 'b9b8b7b6b5b4b3b2b1b0a9a8a7a6a5a4';

export interface MoodleOpts {
  /** What `core_calendar_get_calendar_events` answers. */
  events?: unknown[];
  courses?: unknown[];
  idpAnswer?: (form: URLSearchParams) => Response;
  /** Make a function answer a Moodle exception. */
  exceptions?: Record<string, string>;
}

const redirect = (to: string, cookies: string[] = [], status = 302) => {
  const h = new Headers({ location: to });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status, headers: h });
};

export function moodleWorld(o: MoodleOpts = {}) {
  const log: { method: string; url: string; body: string }[] = [];
  const calls: { fn: string; params: URLSearchParams }[] = [];
  const state = {
    token: TOKEN_A,
    nextToken: TOKEN_A,
    events: o.events ?? [],
    courses: o.courses ?? [],
  };
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    log.push({ method, url: `${url.origin}${url.pathname}`, body });
    const key = `${method} ${url.origin}${url.pathname}`;
    const form = new URLSearchParams(body);
    const cookie = (init?.headers as Record<string, string> | undefined)?.['Cookie'] ?? '';
    switch (key) {
      case `GET ${MOODLE}/admin/tool/mobile/launch.php`:
        return Promise.resolve(
          cookie.includes('MSESS=1')
            ? redirect(
                `moodlemobile://token=${Buffer.from(`site1:::${state.nextToken}:::private`).toString('base64')}`,
                [],
                302,
              )
            : redirect(`${IDP}/idp/sso`),
        );
      case `GET ${IDP}/idp/sso`:
        return Promise.resolve(
          url.search ? html(LOGIN_FORM) : redirect(`${IDP}/idp/sso?execution=e1s1`),
        );
      case `POST ${IDP}/idp/sso`:
        return Promise.resolve(
          o.idpAnswer
            ? o.idpAnswer(form)
            : form.get('j_password') === PASS && form.get('_eventId_proceed') === '1'
              ? html(
                  `<form action="${MOODLE}/sp/acs" method="post"><input type="hidden" name="SAMLResponse" value="S"></form>`,
                )
              : html(LOGIN_FORM),
        );
      case `POST ${MOODLE}/sp/acs`:
        return Promise.resolve(
          redirect(`${MOODLE}/admin/tool/mobile/launch.php`, ['MSESS=1; Path=/; Secure']),
        );
      case `POST ${MOODLE}/webservice/rest/server.php`: {
        const fn = form.get('wsfunction') ?? '';
        calls.push({ fn, params: form });
        const json = (v: unknown) =>
          Promise.resolve(new Response(JSON.stringify(v), { status: 200 }));
        if (form.get('wstoken') !== state.token) {
          return json({
            exception: 'moodle_exception',
            errorcode: 'invalidtoken',
            message: 'Invalid token - token not found',
          });
        }
        const ex = o.exceptions?.[fn];
        if (ex) return json({ exception: 'moodle_exception', errorcode: ex, message: 'refused' });
        if (fn === 'core_webservice_get_site_info')
          return json({ userid: 77, sitename: 'x', functions: [] });
        if (fn === 'core_enrol_get_users_courses') return json(state.courses);
        if (fn === 'core_calendar_get_calendar_events')
          return json({ events: state.events, warnings: [] });
        return json({ exception: 'moodle_exception', errorcode: 'invalidrecord' });
      }
      default:
        return Promise.resolve(new Response('no', { status: 404 }));
    }
  }) as typeof fetch;
  return { fetchImpl, log, calls, state };
}

export const moodleOpts = (fetchImpl: typeof fetch, extra: object = {}) => ({
  fetchImpl,
  allowedHosts: ['moodle.example.test', 'idp.example.test'],
  pauseMs: 0,
  sleep: () => Promise.resolve(),
  ...extra,
});

export const event = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  name: `Quiz ${id} opens`,
  description: '<p>Open the <b>quiz</b> &amp; good luck</p>',
  format: 1,
  courseid: 11,
  modulename: 'quiz',
  instance: 5,
  eventtype: 'open',
  timestart: 1_800_000_000 + id * 3600,
  timeduration: 0,
  visible: 1,
  sequence: 1,
  timemodified: 1_790_000_000,
  categoryid: null,
  groupid: null,
  repeatid: null,
  userid: 77,
  subscriptionid: null,
  ...over,
});

export const course = (id: number, fullname: string) => ({
  id,
  fullname,
  shortname: `C${id}`,
  displayname: fullname,
});
