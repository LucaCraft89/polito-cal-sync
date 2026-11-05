// Step 8 - Moodle: the month view shows more events than the export. Which, and why? READ probe/README.md FIRST.
//   node probe/08-moodle-monthly.mjs
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

const BASE = 'https://moodle.polito.it';
const ALLOWED = new Set(['moodle.polito.it', 'idp.polito.it']);
const MAX_REQUESTS = 50;
const PAUSE_MS = 1500;
const passport = `probe-${Math.random().toString(36).slice(2, 10)}`;
const START = `${BASE}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${passport}&urlscheme=moodlemobile`;
const say = (l = '') => console.log(l);

say('probe 08 - Moodle month view vs export vs event query');
say(`  User-Agent: ${USER_AGENT}`);
say('  It behaves like the Moodle app, one request at a time, 1.5 s apart, at most 50 requests:');
say('    - open the Moodle app-login page and follow the redirects to the IdP login form');
say('    - POST your username and password to the IdP ONCE (typed below, hidden, never saved)');
say('    - forward the SAML answer back to Moodle; the final redirect carries a token for the app');
say('    - read the calendar MONTH VIEW (what the Moodle page shows) for 8 months, read-only');
say('    - read the event query and your own export link, and compare all three by event id');
say('    - print only COUNTS per module, event type and course (no titles)');
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
        report.tokenReceived = Boolean(token);
        report.tokenLength = token?.length ?? 0;
        report.privateTokenPresent = parts.length > 2;
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
      report.privateTokenPresent = parts.length > 2;
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
      if (data && !Array.isArray(data) && data.exception)
        report.calls.push({
          function: name,
          status: res.status,
          error: { exception: data.exception, errorcode: data.errorcode },
        });
      else report.calls.push({ function: name, status: res.status });
      return data;
    }
    const tally = (list, f) => {
      const out = {};
      for (const e of list) {
        const k = String(f(e));
        out[k] = (out[k] ?? 0) + 1;
      }
      return out;
    };
    const now = Math.floor(Date.now() / 1000);
    const from = now - 62 * 86400;
    const to = now + 240 * 86400;
    const site = await ws('core_webservice_get_site_info');
    const courses = await ws('core_enrol_get_users_courses', { userid: site?.userid });
    const ids = Array.isArray(courses) ? courses.map((c) => c.id) : [];
    const params = {
      'options[userevents]': 1,
      'options[siteevents]': 1,
      'options[timestart]': from,
      'options[timeend]': to,
      'options[ignorehidden]': 0,
    };
    ids.forEach((id, i) => (params[`events[courseids][${i}]`] = id));
    const legacy = await ws('core_calendar_get_calendar_events', params);
    const apiIds = new Set((legacy?.events ?? []).map((e) => String(e.id)));
    report.query = { count: apiIds.size };

    const exp = await ws('core_calendar_get_calendar_export_token');
    const exportIds = new Set();
    if (exp?.token) {
      const url = `${BASE}/calendar/export_execute.php?userid=${site.userid}&authtoken=${exp.token}&preset_what=all&preset_time=custom`;
      const { text } = await send('GET', url);
      for (const b of text.split('BEGIN:VEVENT').slice(1)) {
        const u = /UID:(\d+)@/.exec(b)?.[1];
        if (u) exportIds.add(u);
      }
    }
    report.export = { count: exportIds.size };

    const seen = new Map();
    const perMonth = {};
    const d = new Date();
    for (let k = -2; k <= 5; k++) {
      const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1));
      const view = await ws('core_calendar_get_calendar_monthly_view', {
        year: t.getUTCFullYear(),
        month: t.getUTCMonth() + 1,
      });
      const days = (view?.weeks ?? []).flatMap((w) => w.days ?? []);
      const occurrences = days.flatMap((x) => x.events ?? []);
      for (const e of occurrences) if (!seen.has(e.id)) seen.set(e.id, e);
      perMonth[t.toISOString().slice(0, 7)] = {
        occurrences: occurrences.length,
        distinctIds: new Set(occurrences.map((e) => e.id)).size,
      };
    }
    const all = [...seen.values()];
    const only = all.filter((e) => !apiIds.has(String(e.id)) && !exportIds.has(String(e.id)));
    const inQueryNotExport = all.filter(
      (e) => apiIds.has(String(e.id)) && !exportIds.has(String(e.id)),
    );
    const view = (list) => ({
      count: list.length,
      byModule: tally(list, (e) => e.modulename || 'none'),
      byEventtype: tally(list, (e) => e.eventtype),
      byNormalised: tally(list, (e) => e.normalisedeventtype),
      byComponent: tally(list, (e) => e.component || 'none'),
      isAction: tally(list, (e) => e.isactionevent),
      isCourseEvent: tally(list, (e) => e.iscourseevent),
      byCourse: tally(list, (e) => `course${ids.indexOf(e.course?.id) + 1}`),
      durationZero: list.filter((e) => !e.timeduration).length,
      visibleZero: list.filter((e) => e.visible === 0).length,
      withGroup: list.filter((e) => e.groupname).length,
      byMonth: tally(list, (e) => new Date(e.timestart * 1000).toISOString().slice(0, 7)),
    });
    report.monthly = {
      perMonth,
      distinctEvents: all.length,
      inQueryAndExport: all.filter((e) => apiIds.has(String(e.id)) && exportIds.has(String(e.id)))
        .length,
    };
    report.monthlyOnly = view(only);
    report.inQueryNotExport = view(inQueryNotExport);
    report.allMonthly = view(all);
  }
} catch (err) {
  if (!(err instanceof Stop)) throw err;
  report.stopped = err.message;
  say(`\nSTOPPED: ${err.message}`);
}
report.requests = requests;
report.cookies = jar.describe();
const file = writeOut('08-moodle-monthly.json', report);
say(`\nWritten: ${file}`);
say(
  'It holds shapes, counts and codes only (no token, no cookie values, no titles). Send back ONLY this file.',
);
