// Step 5 - web-portal SSO (SAML via idp.polito.it) login probe. READ probe/README.md FIRST.
//   node probe/05-idp-login.mjs [--shift-days N] [--start URL --allow-host HOST[,HOST]]
// Follows the same login a browser does (as seen in the owner's HAR): the portal redirects to the IdP,
// the password form is submitted once, the SAML answer is forwarded back, then ONE data call is made.
// It records the redirect chain (host/path/status), whether any extra step (MFA?) appears, and cookie
// NAMES and lifetimes - never cookie values, never your password. The data is sanitized in memory.

import { CookieJar } from './lib/cookies.mjs';
import { parseForms, visibleMessages } from './lib/html.mjs';
import { USER_AGENT, parseArgs } from './lib/http.mjs';
import { askHidden, askYesNo } from './lib/prompt.mjs';
import { writeOut } from './lib/out.mjs';
import { Sanitizer } from './lib/sanitize.mjs';
import { shapeOfBody } from './lib/shape.mjs';

const args = parseArgs(process.argv.slice(2));
const start = typeof args.start === 'string' ? args.start : 'https://didattica.polito.it/login';
const extraHosts = typeof args['allow-host'] === 'string' ? args['allow-host'].split(',') : [];
const ALLOWED = new Set(['didattica.polito.it', 'idp.polito.it', ...extraHosts]);
const shiftDays = Number(args['shift-days'] ?? 0);
const MAX_REQUESTS = 30;
const PAUSE_MS = 1500;
const DATA_PATH = '/pls/portal30/sviluppo.studente.getStudentData';

const say = (l = '') => console.log(l);
say('probe 05 - web-portal SSO login (SAML via the university IdP)');
say(`  start:       ${start}`);
say(`  User-Agent:  ${USER_AGENT}`);
say('');
say(
  '  It will behave like a browser logging in, one request at a time, 1.5 s apart, at most 30 requests:',
);
say('    - GET the portal login page and follow the redirects to the IdP login form');
say('    - POST your username and password to the IdP ONCE (typed below, hidden, never saved)');
say('    - forward the SAML answer back to the portal and follow the redirects');
say(`    - GET ${DATA_PATH} ONCE (your own schedule data; sanitized in memory before saving)`);
say(
  `  Only these hosts are ever contacted: ${[...ALLOWED].join(', ')}. A redirect anywhere else stops it.`,
);
say(
  '  If the IdP asks for ANYTHING else (a code, a passkey, a question) it stops and records the field NAMES.',
);
say(
  '  It stops on HTTP 429 and never retries a login. It records no cookie values and no password.',
);
say('  Note: a server is a new "device" for the IdP; if it asks for MFA now, that is the finding.');
say('');
if (!(await askYesNo('Continue?'))) {
  say('Nothing was sent.');
  process.exit(0);
}
const username = (await askHidden('Polito username (hidden): ')).trim();
const password = await askHidden('Polito password (hidden): ');
if (!username || !password) {
  say('Empty username or password: nothing was sent.');
  process.exit(1);
}

// Typing check: only LENGTHS are shown, so a paste or keyboard problem can be noticed before the IdP
// counts a failed attempt.
say(
  `  You typed a username of ${username.length} characters and a password of ${password.length} characters.`,
);
if (!(await askYesNo('Are those the lengths you expect? Send the login now?'))) {
  say('Nothing was sent.');
  process.exit(0);
}

const jar = new CookieJar();
const steps = [];
const report = { when: new Date().toISOString(), userAgent: USER_AGENT, start, steps };
let last = 0;
let requests = 0;
let credsSent = false;
let idpHost = 'idp.polito.it';
let currentUrl = start;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOk = (u) => ALLOWED.has(new URL(u).hostname);
const secureOk = (u) =>
  new URL(u).protocol === 'https:' || extraHosts.includes(new URL(u).hostname);

/** One browser-like request. Never follows redirects itself. */
async function send(method, url, form) {
  if (!hostOk(url) || !secureOk(url)) {
    throw new Stop(
      `refused to contact a host that is not on the allowed list: ${new URL(url).hostname}`,
    );
  }
  if (++requests > MAX_REQUESTS) throw new Stop('request limit reached');
  const wait = last + PAUSE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const headers = {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/json;q=0.9,*/*;q=0.5',
  };
  const cookie = jar.header(url);
  if (cookie) headers.cookie = cookie;
  if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
  } catch (err) {
    throw new Stop(`network error (${err.cause?.code ?? err.name})`);
  }
  last = Date.now();
  const text = await res.text();
  jar.store(new URL(url).hostname, res.headers.getSetCookie?.() ?? []);
  const u = new URL(url);
  steps.push({
    n: steps.length + 1,
    method,
    host: u.hostname,
    path: u.pathname,
    status: res.status,
  });
  say(`  ${method} ${u.hostname}${u.pathname} -> ${res.status}`);
  if (res.status === 429) throw new Stop('the server answered 429 (too many requests)');
  return { res, text };
}

class Stop extends Error {}

try {
  let method = 'GET';
  let form;
  let outcome;
  for (;;) {
    const { res, text } = await send(method, currentUrl, form);
    method = 'GET';
    form = undefined;
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      const target = new URL(loc, currentUrl);
      steps[steps.length - 1].redirectsTo =
        `${target.hostname}${target.pathname}?[${[...target.searchParams.keys()].join(',')}]`;
      currentUrl = new URL(loc, currentUrl).href;
      continue;
    }
    if (res.status !== 200) {
      outcome = `stopped: unexpected status ${res.status}`;
      break;
    }
    const forms = parseForms(text);
    const login = forms.find((f) => f.inputs.some((i) => i.name === 'j_password'));
    const saml = forms.find((f) => f.inputs.some((i) => i.name === 'SAMLResponse'));
    if (login) {
      idpHost = new URL(currentUrl).hostname;
      if (credsSent) {
        outcome =
          'login form shown again after the password was sent (credentials rejected, or an extra requirement)';
        report.secondLoginForm = describeForm(login);
        // What the IdP itself says on the redisplayed form (its text, scrubbed of what was typed).
        report.secondLoginMessages = visibleMessages(text).map((m) =>
          [username, password].reduce((acc, secret) => acc.split(secret).join('<redacted>'), m),
        );
        report.secondLoginKeywords = keywords(text, [
          'errat',
          'invalid',
          'non valid',
          'incorrect',
          'scadut',
          'bloccat',
          'blocked',
          'expired',
          'attempt',
        ]);
        break;
      }
      const action = new URL(login.action || currentUrl, currentUrl).href;
      if (!hostOk(action) || !secureOk(action))
        throw new Stop('the login form points to a host that is not allowed; password NOT sent');
      form = {};
      for (const i of login.inputs) {
        if (i.type === 'password' || i.name === 'j_password') form[i.name] = password;
        else if (i.name === 'j_username') form[i.name] = username;
        // In the browser the proceed button's script fills this field with "1" (the HAR showed a one
        // character value); an empty value makes the flow show the login form again.
        else if (i.name === '_eventId_proceed') form[i.name] = i.value || '1';
        else if (i.type === 'hidden') form[i.name] = i.value;
        // checkboxes (donotcache) are left out: unchecked boxes are not sent by a browser
      }
      report.loginFormFields = describeForm(login);
      report.sentFieldNames = Object.keys(form);
      credsSent = true;
      method = 'POST';
      currentUrl = action;
      continue;
    }
    if (saml) {
      const action = new URL(saml.action, currentUrl).href;
      form = Object.fromEntries(
        saml.inputs.filter((i) => i.type === 'hidden').map((i) => [i.name, i.value]),
      );
      method = 'POST';
      currentUrl = action;
      report.samlForwardedToHost = new URL(action).hostname;
      continue;
    }
    if (forms.length > 0 && new URL(currentUrl).hostname === idpHost) {
      outcome = 'EXTRA STEP at the IdP (MFA or another question): stopped, nothing was sent to it';
      report.extraStep = forms.map(describeForm);
      report.extraStepKeywords = keywords(text);
      break;
    }
    outcome = 'reached a page without further forms';
    break;
  }
  report.outcome = outcome;
  report.finalHost = new URL(currentUrl).hostname;

  // One data call, only if we ended up logged in on the portal.
  const loggedIn =
    outcome === 'reached a page without further forms' &&
    new URL(currentUrl).hostname === new URL(start).hostname;
  if (loggedIn) {
    const dataUrl = new URL(DATA_PATH, start).href;
    const { res, text } = await send('GET', dataUrl);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    report.dataCall = {
      path: DATA_PATH,
      status: res.status,
      contentType: res.headers.get('content-type'),
      bodyShape: shapeOfBody(text, res.headers.get('content-type')),
    };
    if (parsed) {
      const s = new Sanitizer({ shiftDays, secrets: [username, password] });
      const { sanitized, problems } = s.run(parsed);
      const dir = problems.length > 0 ? 'needs-review' : 'sanitized';
      report.dataCall.sanitizedTo = `probe/out/${dir}/idp-student-data.json`;
      report.dataCall.problems = problems;
      writeOut(`${dir}/idp-student-data.json`, sanitized);
    }
  }
} catch (err) {
  if (!(err instanceof Stop)) throw err;
  report.stopped = err.message;
  say(`\nSTOPPED: ${err.message}`);
}

report.cookies = jar.describe();
report.requests = requests;
const file = writeOut('05-idp-login.json', report);
say(`\nOutcome: ${report.outcome ?? report.stopped}`);
say(`Written: ${file}`);
say(
  'Review it (no password, no cookie values) and send back ONLY this file, plus probe/out/sanitized/idp-student-data.json after the checklist.',
);

function describeForm(f) {
  return { method: f.method, inputs: f.inputs.map((i) => `${i.name}:${i.type}`) };
}
function keywords(
  text,
  list = [
    'otp',
    'mfa',
    'passkey',
    'webauthn',
    'totp',
    'sms',
    'authenticator',
    'codice',
    'verifica',
  ],
) {
  const t = text.toLowerCase();
  return list.filter((k) => t.includes(k));
}
