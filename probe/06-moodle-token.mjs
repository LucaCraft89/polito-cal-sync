// Step 6 - Moodle mobile web service via SSO. READ probe/README.md FIRST.
//   node probe/06-moodle-token.mjs
// moodle.polito.it logs in through the same university IdP (Shibboleth), and its public config says the mobile
// web service is enabled with browser login (decision 031). This does what the Moodle app does: opens
// /admin/tool/mobile/launch.php, logs in at the IdP ONCE, and receives a token in the final redirect. The token
// is held in memory only, used for a few READ-ONLY web-service calls, and never written anywhere. The output holds
// only the SHAPES of the answers (key names, types, counts) and the sets of event types and module names.

import { CookieJar } from './lib/cookies.mjs';
import { parseForms } from './lib/html.mjs';
import { USER_AGENT } from './lib/http.mjs';
import { askHidden, askYesNo } from './lib/prompt.mjs';
import { writeOut } from './lib/out.mjs';
import { shapeOfBody } from './lib/shape.mjs';

const BASE = 'https://moodle.polito.it';
const ALLOWED = new Set(['moodle.polito.it', 'idp.polito.it']);
const MAX_REQUESTS = 40;
const PAUSE_MS = 1500;
const passport = `probe-${Math.random().toString(36).slice(2, 10)}`;
const START = `${BASE}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${passport}&urlscheme=moodlemobile`;
const say = (l = '') => console.log(l);

say('probe 06 - Moodle mobile web service login and read-only calls');
say(`  User-Agent: ${USER_AGENT}`);
say('  It behaves like the Moodle app, one request at a time, 1.5 s apart, at most 40 requests:');
say('    - open the Moodle app-login page and follow the redirects to the IdP login form');
say('    - POST your username and password to the IdP ONCE (typed below, hidden, never saved)');
say('    - forward the SAML answer back to Moodle; the final redirect carries a token for the app');
say('    - call a few READ-ONLY web-service functions about YOUR OWN calendar and courses');
say(
  `  Only ${[...ALLOWED].join(' and ')} are contacted. Any extra IdP step stops it. 429 stops it.`,
);
say(
  '  The token is kept in memory only and is never printed or saved. Titles, names and places are not saved.',
);
say('');
if (!(await askYesNo('Continue?'))) process.exit(0);
const username = (await askHidden('Polito username (hidden): ')).trim();
const password = await askHidden('Polito password (hidden): ');
if (!username || !password) {
  say('Empty username or password: nothing was sent.');
  process.exit(1);
}
say(`  Lengths typed: username ${username.length}, password ${password.length}.`);
if (!(await askYesNo('Are those the lengths you expect? Send the login now?'))) process.exit(0);

class Stop extends Error {}
const jar = new CookieJar();
const report = { when: new Date().toISOString(), steps: [], calls: [] };
let last = 0;
let requests = 0;
let credsSent = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(method, url, form, headers = {}) {
  const u = new URL(url);
  if (!ALLOWED.has(u.hostname) || u.protocol !== 'https:')
    throw new Stop(`refused to contact ${u.hostname}`);
  if (++requests > MAX_REQUESTS) throw new Stop('request limit reached');
  const wait = last + PAUSE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const h = {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/json;q=0.9,*/*;q=0.5',
    ...headers,
  };
  const cookie = jar.header(url);
  if (cookie) h.cookie = cookie;
  if (form) h['content-type'] = 'application/x-www-form-urlencoded';
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: h,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
  } catch (err) {
    throw new Stop(`network error (${err.cause?.code ?? err.name})`);
  }
  last = Date.now();
  const text = await res.text();
  jar.store(u.hostname, res.headers.getSetCookie?.() ?? []);
  report.steps.push({
    n: report.steps.length + 1,
    method,
    host: u.hostname,
    path: u.pathname,
    status: res.status,
  });
  say(`  ${method} ${u.hostname}${u.pathname} -> ${res.status}`);
  if (res.status === 429) throw new Stop('the server answered 429 (too many requests)');
  return { res, text };
}

let token;
let privateTokenPresent = false;
try {
  let method = 'GET';
  let form;
  let url = START;
  for (;;) {
    const { res, text } = await send(method, url, form);
    method = 'GET';
    form = undefined;
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      if (loc.startsWith('moodlemobile://')) {
        // The app's custom-scheme redirect: token=base64("<siteid>:::<token>[:::<privatetoken>]").
        const raw = loc.slice('moodlemobile://'.length).replace(/^token=/, '');
        const parts = Buffer.from(decodeURIComponent(raw), 'base64').toString('utf8').split(':::');
        token = parts[1];
        privateTokenPresent = parts.length > 2;
        report.tokenReceived = Boolean(token);
        report.tokenLength = token?.length ?? 0;
        report.privateTokenPresent = privateTokenPresent;
        break;
      }
      const target = new URL(loc, url);
      report.steps.at(-1).redirectsTo = `${target.hostname}${target.pathname}`;
      url = target.href;
      continue;
    }
    if (res.status !== 200) throw new Stop(`unexpected status ${res.status}`);
    const forms = parseForms(text);
    const login = forms.find((f) => f.inputs.some((i) => i.name === 'j_password'));
    const saml = forms.find((f) => f.inputs.some((i) => i.name === 'SAMLResponse'));
    if (login) {
      if (credsSent)
        throw new Stop(
          'login form shown again after the password was sent (credentials rejected?)',
        );
      const action = new URL(login.action || url, url).href;
      if (!ALLOWED.has(new URL(action).hostname))
        throw new Stop('login form points to a host that is not allowed; password NOT sent');
      form = {};
      for (const i of login.inputs) {
        if (i.type === 'password' || i.name === 'j_password') form[i.name] = password;
        else if (i.name === 'j_username') form[i.name] = username;
        else if (i.name === '_eventId_proceed') form[i.name] = i.value || '1';
        else if (i.type === 'hidden') form[i.name] = i.value;
      }
      credsSent = true;
      method = 'POST';
      url = action;
      continue;
    }
    if (saml) {
      form = Object.fromEntries(
        saml.inputs.filter((i) => i.type === 'hidden').map((i) => [i.name, i.value]),
      );
      method = 'POST';
      url = new URL(saml.action, url).href;
      continue;
    }
    // A Moodle page (not a redirect): it may hold the token link (a page with a "moodlemobile://" link).
    const m = /moodlemobile:\/\/token=([A-Za-z0-9+/=%]+)/.exec(text);
    if (m) {
      const parts = Buffer.from(decodeURIComponent(m[1]), 'base64').toString('utf8').split(':::');
      token = parts[1];
      privateTokenPresent = parts.length > 2;
      report.tokenReceived = Boolean(token);
      report.tokenInPageLink = true;
      break;
    }
    report.finalPageForms = forms.map((f) => f.inputs.map((i) => `${i.name}:${i.type}`));
    throw new Stop(
      forms.length > 0
        ? 'a form I do not know (an extra login step?): stopped, nothing was sent to it'
        : 'ended on a page with no token',
    );
  }

  if (token) {
    async function ws(name, params = {}) {
      const { res, text } = await send('POST', `${BASE}/webservice/rest/server.php`, {
        wstoken: token,
        wsfunction: name,
        moodlewsrestformat: 'json',
        ...params,
      });
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
      const call = {
        function: name,
        status: res.status,
        shape: shapeOfBody(text, res.headers.get('content-type')),
      };
      if (data && !Array.isArray(data) && data.exception) {
        call.error = { exception: data.exception, errorcode: data.errorcode };
        delete call.shape;
      }
      report.calls.push(call);
      return { call, data };
    }
    const now = Math.floor(Date.now() / 1000);
    const { data: site } = await ws('core_webservice_get_site_info');
    if (site && !site.exception) {
      report.site = {
        release: site.release,
        version: site.version,
        functionCount: site.functions?.length,
        calendarFunctions: (site.functions ?? [])
          .map((f) => f.name)
          .filter((n) => /calendar|assign|enrol_get_users_courses|get_course_contents/.test(n)),
        userKeys: Object.keys(site)
          .filter(
            (k) =>
              !/fullname|firstname|lastname|username|userpictureurl|siteurl|sitename|userid/.test(
                k,
              ),
          )
          .sort(),
      };
    }
    const events = await ws('core_calendar_get_action_events_by_timesort', {
      timesortfrom: now - 30 * 86400,
      timesortto: now + 120 * 86400,
      limitnum: 50,
    });
    const list = events.data?.events;
    if (Array.isArray(list)) {
      report.actionEvents = {
        count: list.length,
        eventKeys: Object.keys(list[0] ?? {}).sort(),
        modules: [...new Set(list.map((e) => e.modulename))].sort(),
        eventtypes: [...new Set(list.map((e) => e.eventtype))].sort(),
        timeKeys: ['timestart', 'timesort', 'timeduration', 'timemodified'].filter(
          (k) => list[0] && k in list[0],
        ),
        hasCourseKey: Boolean(list[0]?.course),
        courseKeys: Object.keys(list[0]?.course ?? {}).sort(),
        actionKeys: Object.keys(list[0]?.action ?? {}).sort(),
      };
    }
    await ws('core_calendar_get_calendar_upcoming_view');
    if (site?.userid) {
      const courses = await ws('core_enrol_get_users_courses', { userid: site.userid });
      if (Array.isArray(courses.data)) {
        report.courses = {
          count: courses.data.length,
          keys: Object.keys(courses.data[0] ?? {}).sort(),
        };
        const ids = courses.data.slice(0, 20).map((c) => c.id);
        const assigns = await ws(
          'mod_assign_get_assignments',
          Object.fromEntries(ids.map((id, i) => [`courseids[${i}]`, id])),
        );
        const a = assigns.data?.courses?.flatMap((c) => c.assignments ?? []);
        if (Array.isArray(a))
          report.assignments = {
            count: a.length,
            keys: Object.keys(a[0] ?? {}).sort(),
            hasDuedate: a.some((x) => x.duedate > 0),
          };
      }
    }
    await ws('core_calendar_get_calendar_export_token');
  }
} catch (err) {
  if (!(err instanceof Stop)) throw err;
  report.stopped = err.message;
  say(`\nSTOPPED: ${err.message}`);
}
report.requests = requests;
report.cookies = jar.describe();
const file = writeOut('06-moodle-token.json', report);
say(`\nWritten: ${file}`);
say(
  'It holds shapes, counts and codes only (no token, no cookie values, no titles). Send back ONLY this file.',
);
