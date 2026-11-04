// Step 2 - login probe (interactive). READ probe/README.md FIRST.
//   node probe/02-login.mjs                 find out what logging in demands (no account change)
//   node probe/02-login.mjs --enrol         ALSO register a device key as an MFA factor (changes your account)
//   node probe/02-login.mjs --body-template FILE --base-url URL   (options)
// The password is typed into a hidden prompt, used for one login request, and then forgotten.
// Only status codes, key names, lengths and the token lifetime are written (probe/out/02-login.json).

import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_BASE_URL, Http, parseArgs, StopProbe, USER_AGENT } from './lib/http.mjs';
import { askHidden, askYesNo } from './lib/prompt.mjs';
import { shapeOfBody } from './lib/shape.mjs';
import { describeToken } from './lib/jwt.mjs';
import {
  errorEvidence,
  findAcceptedVariant,
  loadTemplate,
  login,
  LOGIN_VARIANTS,
  safeParse,
  todayIso,
} from './lib/session.mjs';
import { OUT_DIR, writeOut } from './lib/out.mjs';
import { dirname, join } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const baseUrl = typeof args['base-url'] === 'string' ? args['base-url'] : DEFAULT_BASE_URL;
const wantEnrol = args.enrol === true;
const variants =
  typeof args['body-template'] === 'string'
    ? [{ name: 'custom', template: loadTemplate(args['body-template']) }]
    : LOGIN_VARIANTS;

const say = (l = '') => console.log(l);
say('probe 02 - login probe');
say(`  server:      ${baseUrl}`);
say(`  User-Agent:  ${USER_AGENT}`);
say('');
say('  It will send, one at a time and 1.5 s apart (at most 7 requests):');
say(
  '    1. POST /auth/login with a FAKE username and password, up to 3 times with different request',
);
say(
  '       shapes (the server needs device fields; where they go is unknown). Fake logins for a user that',
);
say(
  '       does not exist are harmless. YOUR password is sent only with a shape the server answered',
);
say('       with 401/403; if none is accepted the script stops and your password is never sent.');
say('    2. POST /auth/login with YOUR username and password (typed below, hidden, never saved).');
say(
  '    3. GET  /deadlines for today only (tests whether the token you got is enough to read data).',
);
say('    4. GET  /auth/mfa/status (asks the server which MFA state it sees for this token).');
if (wantEnrol) say('    5. --enrol: the MFA device registration described below.');
say(
  '  The device fields sent are: your OS name, the Node version, and the text "polito-cal-sync".',
);
say('  It stops at once on HTTP 429, and it never retries a login.');
say('  It records: status codes, which MFA path the server demands, key names and lengths of the');
say('  answers (no values), the token lifetime if the token states one. Nothing is sent anywhere');
say('  except to the server above; output goes to probe/out/ on this machine.');
say('');

if (wantEnrol) {
  say('!!! --enrol WARNING !!!');
  say(
    '  This registers a NEW multi-factor "device" on YOUR Polito account, using a key pair made on this',
  );
  say('  computer. Consequences you must accept before continuing:');
  say(
    '   - Your account gets one more MFA factor. If you had none, MFA becomes REQUIRED for the student',
  );
  say(
    '     app too ("once a factor is registered it is required"), and your phone app may then ask for it.',
  );
  say(
    '   - The private key is saved in probe/out/mfa-device.json (mode 0600). Anyone holding that file can',
  );
  say(
    '     pass MFA for your account. Never commit it, never send it. Delete it if you stop here.',
  );
  say(
    '   - We do NOT know yet where in the Polito portal/app you can remove the device again. Check that',
  );
  say('     before you continue, and ask Polito ICT if unsure.');
  say(
    '   - The request fields for enrol/challenge/validate come from the public spec and are UNVERIFIED.',
  );
  say(
    '     This is a single best-effort attempt: nothing is retried. It may fail and need a second round.',
  );
  say(
    '   - Polito may consider an unattended server a different thing from "a device". Their rules on',
  );
  say('     automated access are unknown (docs/RESEARCH.md); emailing ICT first is recommended.');
  say('');
}

if (!(await askYesNo('Continue?'))) {
  say('Nothing was sent.');
  process.exit(0);
}
if (wantEnrol) {
  const typed = await askYesNo('Type y once more to confirm you read the --enrol warning');
  if (!typed) {
    say('Nothing was sent.');
    process.exit(0);
  }
}

const username = (await askHidden('Polito username (hidden): ')).trim();
const password = await askHidden('Polito password (hidden): ');
if (!username || !password) {
  say('Empty username or password: nothing was sent.');
  process.exit(1);
}

const http = new Http({ baseUrl, log: say });
const report = {
  when: new Date().toISOString(),
  baseUrl,
  userAgent: USER_AGENT,
  bodyTemplate: args['body-template'] ? 'custom file' : 'built-in variants',
  assumptions: ['Authorization scheme for data calls: Bearer <token> (UNVERIFIED)'],
};
const secrets = [username, password];

try {
  // 1. Shape check with fake credentials: the real password is sent ONLY with a variant the server
  //    answered with 401/403 (it understood the request and rejected the fake credentials).
  say('\n[1] shape check with fake logins ...');
  const found = await findAcceptedVariant(http, variants);
  report.shapeCheck = { tries: found.tries, accepted: found.accepted?.name };
  for (const t of found.tries) say(`    ${t.variant} -> ${t.status}`);
  if (!found.accepted) {
    report.stoppedBecause =
      'no login request shape was accepted by the server; the real login was NOT sent';
    say('    The server did not accept any request shape (see the messages above/in the file).');
    say('    Your real password was NOT sent. Send back probe/out/02-login.json.');
    throw new StopProbe(report.stoppedBecause);
  }
  const accepted = found.accepted;
  writeOut('login-variant.json', { variant: accepted.name });

  // 2. Real login.
  say('\n[2] login with your credentials ...');
  const real = await login(http, accepted, username, password);
  report.login = real.record;
  say(`    -> ${real.record.status}${real.token ? '  (token received, not shown)' : ''}`);
  const loginOk = real.record.status >= 200 && real.record.status < 300;
  if (real.record.status === 401 || real.record.status === 403) {
    report.stoppedBecause = `login answered ${real.record.status}; stopping (no retry, to avoid locking the account)`;
    say(`    ${report.stoppedBecause}`);
    throw new StopProbe(report.stoppedBecause, real.record.status);
  }
  if (!loginOk || !real.token) {
    report.stoppedBecause = 'login did not return a token';
    throw new StopProbe(report.stoppedBecause);
  }
  const token = real.token;

  // 3. Is the token enough for a data call?
  say('\n[3] one small data request with the token ...');
  const day = todayIso();
  const data = await http.request('GET', '/deadlines', {
    query: { fromDate: day, toDate: day },
    token,
  });
  report.dataCall = {
    endpoint: 'GET /deadlines?fromDate=today&toDate=today',
    status: data.status,
    headers: data.headers,
    bodyShape: shapeOfBody(data.text, data.headers['content-type']),
    evidence:
      data.status >= 200 && data.status < 300
        ? undefined
        : errorEvidence(data.text, [...secrets, token]),
  };
  say(`    -> ${data.status}`);

  // 4. MFA status (also when the data call was refused: that is when it matters most).
  say('\n[4] MFA status ...');
  const mfa = await http.request('GET', '/auth/mfa/status', { token });
  report.mfaStatus = {
    status: mfa.status,
    headers: mfa.headers,
    bodyShape: shapeOfBody(mfa.text, mfa.headers['content-type']),
    // Booleans and short enum-like words are what we need to read the answer.
    flatValues: flatten(safeParse(mfa.text)),
    evidence:
      mfa.status >= 200 && mfa.status < 300
        ? undefined
        : errorEvidence(mfa.text, [...secrets, token]),
  };
  say(`    -> ${mfa.status}`);

  const dataOk = data.status >= 200 && data.status < 300;
  report.verdict = dataOk
    ? 'A token from a password-only login was accepted for a data call: MFA was NOT demanded for this account in this situation.'
    : data.status === 401 || data.status === 403
      ? 'A token from a password-only login was NOT enough (' +
        data.status +
        '). See mfaStatus for what the server says is missing.'
      : `The data call answered ${data.status}: inconclusive.`;
  say(`\nVerdict: ${report.verdict}`);
  report.unattendedAssessment = dataOk
    ? [
        'Unattended login would be: POST /auth/login on a schedule with stored credentials.',
        'Open: token lifetime (see login.token), whether the password must be stored in DATA_DIR (it must), whether login from a server triggers a new-device MFA prompt later.',
      ]
    : [
        'MFA is the blocker. An unattended server would have to hold a device key registered with POST /auth/mfa/enrol,',
        'then for each login: POST /auth/mfa/challenge (get a nonce), sign it with the device key, POST /auth/mfa/validate.',
        'Run again with --enrol only after reading its warning. Until then the Polito API source stays disabled; the ICS source is unaffected.',
      ];

  // 5. Optional enrolment.
  if (wantEnrol && !dataOk) {
    say('\n[5] --enrol: registering a device key (single best-effort attempt) ...');
    report.enrol = await enrol(http, token, secrets);
  } else if (wantEnrol) {
    say('\n[5] --enrol skipped: the token already works, there is nothing to enrol for.');
    report.enrol = { skipped: 'token already accepted for data calls' };
  }
} catch (err) {
  if (!(err instanceof StopProbe)) throw err;
  report.stopped = err.message;
  say(`\nSTOPPED: ${err.message}`);
}

report.requests = http.requestLog;
const file = writeOut('02-login.json', report);
say(`\nWritten: ${file}`);
say(
  'Review it (it holds no password, token or values), then send back ONLY this file. See probe/README.md.',
);

/** Flattens a small JSON answer to booleans and short enum-like words, for the MFA status reading. */
function flatten(value, prefix = '', out = {}, depth = 0) {
  if (value === null || value === undefined || depth > 4) return out;
  if (typeof value === 'boolean') out[prefix || 'value'] = value;
  else if (typeof value === 'string' && /^[A-Za-z_-]{1,24}$/.test(value))
    out[prefix || 'value'] = value;
  else if (typeof value === 'number' && /(count|length|size)$/i.test(prefix)) out[prefix] = value;
  else if (Array.isArray(value)) out[`${prefix || 'value'}.length`] = value.length;
  else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value))
      flatten(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  }
  return out;
}

async function enrol(http, token, secrets) {
  const result = {};
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubkey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  result.keyType = 'ECDSA P-256, public key sent as base64 SPKI DER (UNVERIFIED guess)';
  const enrolRes = await http.request('POST', '/auth/mfa/enrol', {
    token,
    body: { description: 'polito-cal-sync probe', pubkey },
  });
  result.enrol = {
    status: enrolRes.status,
    bodyShape: shapeOfBody(enrolRes.text, enrolRes.headers['content-type']),
    evidence: enrolRes.status < 300 ? undefined : errorEvidence(enrolRes.text, [...secrets, token]),
  };
  const serial = safeParse(enrolRes.text)?.serial;
  if (enrolRes.status >= 300 || typeof serial !== 'string') {
    result.outcome =
      'enrolment did not return a serial: nothing was registered or the field names differ. No key file was written.';
    return result;
  }
  const keyFile = join(OUT_DIR, 'mfa-device.json');
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  writeFileSync(
    keyFile,
    JSON.stringify(
      { serial, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  chmodSync(keyFile, 0o600);
  result.keyFile = 'probe/out/mfa-device.json (0600; SECRET, never commit or send)';

  // Prove the unattended cycle: challenge -> sign -> validate -> a data call.
  const ch = await http.request('POST', '/auth/mfa/challenge', { token, body: { serial } });
  result.challenge = {
    status: ch.status,
    bodyShape: shapeOfBody(ch.text, ch.headers['content-type']),
    evidence: ch.status < 300 ? undefined : errorEvidence(ch.text, [...secrets, token, serial]),
  };
  const nonce = safeParse(ch.text)?.nonce;
  if (ch.status >= 300 || typeof nonce !== 'string') {
    result.outcome =
      'enrolled, but the challenge step did not give a nonce: field names differ. The device exists on your account; remove it if you stop here.';
    return result;
  }
  const signature = sign('sha256', Buffer.from(nonce), privateKey).toString('base64');
  const val = await http.request('POST', '/auth/mfa/validate', {
    token,
    body: { serial, nonce, signature },
  });
  result.validate = {
    status: val.status,
    bodyShape: shapeOfBody(val.text, val.headers['content-type']),
    token: describeToken(safeParse(val.text)?.token),
    evidence: val.status < 300 ? undefined : errorEvidence(val.text, [...secrets, token, serial]),
  };
  const newToken = safeParse(val.text)?.token ?? token;
  const day = todayIso();
  const after = await http.request('GET', '/deadlines', {
    query: { fromDate: day, toDate: day },
    token: typeof newToken === 'string' ? newToken : token,
  });
  result.dataCallAfterValidate = { status: after.status };
  result.outcome =
    after.status >= 200 && after.status < 300
      ? 'An unattended cycle (enrolled key -> challenge -> signature -> validate -> data) WORKED.'
      : 'Cycle completed but the data call was still refused: see the statuses above.';
  return result;
}
