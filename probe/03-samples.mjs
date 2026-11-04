// Step 3 - authenticated sample fetch + redact-and-save. READ probe/README.md FIRST.
//   node probe/03-samples.mjs [--shift-days N] [--assignment-courses N] [--body-template FILE] [--base-url URL]
// Logs in (hidden prompt, as in step 2), reads each endpoint ONCE, and keeps the raw answers only in
// memory. What reaches the disk is (a) key-name/type shapes and (b) sanitized copies, in probe/out/.

import { Sanitizer } from './lib/sanitize.mjs';
import { DEFAULT_BASE_URL, Http, parseArgs, StopProbe, USER_AGENT } from './lib/http.mjs';
import { askHidden, askYesNo } from './lib/prompt.mjs';
import { shapeOfBody } from './lib/shape.mjs';
import { loadTemplate, login, safeParse } from './lib/session.mjs';
import { writeOut } from './lib/out.mjs';

const args = parseArgs(process.argv.slice(2));
const baseUrl = typeof args['base-url'] === 'string' ? args['base-url'] : DEFAULT_BASE_URL;
const shiftDays = Number(args['shift-days'] ?? 0);
const assignmentCourses = Math.min(Number(args['assignment-courses'] ?? 2), 3);
const template = loadTemplate(
  typeof args['body-template'] === 'string' ? args['body-template'] : undefined,
);
if (!Number.isInteger(shiftDays) || !Number.isInteger(assignmentCourses)) {
  console.error('--shift-days and --assignment-courses must be whole numbers.');
  process.exit(1);
}

const DAY = 86_400_000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const range = { fromDate: iso(-14), toDate: iso(60) };

const say = (l = '') => console.log(l);
say('probe 03 - authenticated samples');
say(`  server:      ${baseUrl}`);
say(`  User-Agent:  ${USER_AGENT}`);
say('');
say('  It will send, one at a time and 1.5 s apart (about 8 requests):');
say('    POST /auth/login                     (your credentials, hidden prompt, one attempt)');
say(`    GET  /lectures   ${range.fromDate} .. ${range.toDate}`);
say('    GET  /exams');
say('    GET  /bookings');
say(`    GET  /deadlines  ${range.fromDate} .. ${range.toDate}`);
say('    GET  /v2/courses');
say(`    GET  /courses/{id}/assignments       for up to ${assignmentCourses} course(s)`);
say(
  '  It stops at once on 401, 403 or 429. Raw answers are NEVER written to disk: they are redacted in',
);
say(
  '  memory first (names, ids, rooms, links replaced consistently). You still review the result.',
);
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

const http = new Http({ baseUrl, log: say });
const summary = {
  when: new Date().toISOString(),
  userAgent: USER_AGENT,
  range,
  shiftDays,
  endpoints: {},
};
const raw = {}; // in memory only
let token;

try {
  const l = await login(http, template, username, password);
  summary.login = { status: l.record.status };
  say(`login -> ${l.record.status}`);
  if (l.record.status === 401 || l.record.status === 403 || !l.token) {
    throw new StopProbe(
      `Login did not give a token (status ${l.record.status}). Run 02-login.mjs to find out why. Stopping; nothing retried.`,
    );
  }
  token = l.token;

  const plan = [
    ['lectures', '/lectures', range],
    ['exams', '/exams', {}],
    ['bookings', '/bookings', {}],
    ['deadlines', '/deadlines', range],
    ['courses', '/v2/courses', {}],
  ];
  for (const [name, path, query] of plan) {
    const r = await http.request('GET', path, { query, token, stopOn: [401, 403] });
    summary.endpoints[name] = {
      path,
      status: r.status,
      bodyShape: shapeOfBody(r.text, r.headers['content-type']),
    };
    say(`GET ${path} -> ${r.status}`);
    if (r.status >= 200 && r.status < 300) raw[name] = safeParse(r.text);
  }

  // Assignments: need course ids. The field name `id` is a spec-based guess (UNVERIFIED).
  const courses = pickList(raw.courses);
  const ids = courses
    .map((c) => (c && typeof c === 'object' ? c.id : undefined))
    .filter(
      (id) =>
        (typeof id === 'string' || typeof id === 'number') &&
        /^[A-Za-z0-9_-]{1,40}$/.test(String(id)),
    )
    .slice(0, assignmentCourses);
  summary.assignmentCourseIdsFound = ids.length;
  const assignments = [];
  for (const id of ids) {
    const r = await http.request('GET', `/courses/${encodeURIComponent(String(id))}/assignments`, {
      token,
      stopOn: [401, 403],
    });
    summary.endpoints[`assignments(${assignments.length + 1})`] = {
      path: '/courses/{id}/assignments',
      status: r.status,
      bodyShape: shapeOfBody(r.text, r.headers['content-type']),
    };
    say(`GET /courses/{id}/assignments -> ${r.status}`);
    if (r.status >= 200 && r.status < 300)
      assignments.push({ courseId: id, response: safeParse(r.text) });
  }
  if (assignments.length > 0) raw.assignments = assignments;
} catch (err) {
  if (!(err instanceof StopProbe)) throw err;
  summary.stopped = err.message;
  say(`\nSTOPPED: ${err.message}`);
}

// Redact in memory, one sanitizer for everything so placeholders are consistent across files.
const sanitizer = new Sanitizer({ shiftDays, secrets: [username, password, token] });
const clean = {};
const problems = {};
for (const [name, value] of Object.entries(raw)) {
  const { sanitized, problems: p } = sanitizer.run(value);
  clean[name] = sanitized;
  if (p.length > 0) problems[name] = p;
}
const flagged = Object.keys(problems).length > 0;
const dir = flagged ? 'needs-review' : 'sanitized';
for (const [name, value] of Object.entries(clean)) writeOut(`${dir}/${name}.json`, value);
summary.sanitizer = { ...sanitizer.stats, outputDir: `probe/out/${dir}`, problems };
summary.requests = http.requestLog;
writeOut('03-samples-summary.json', summary);

say('');
if (flagged) {
  say(
    `SOMETHING LOOKS UNSAFE. The files were written to probe/out/needs-review/ (NOT sanitized/).`,
  );
  for (const [n, p] of Object.entries(problems)) say(`  ${n}: ${p.join(', ')}`);
  say(
    '  Do not send or commit them. Tell the assistant which field names survived (not their values).',
  );
} else {
  say(`Sanitized files: probe/out/sanitized/*.json  (${Object.keys(clean).join(', ') || 'none'})`);
}
say('Summary: probe/out/03-samples-summary.json');
say('Now run the checklist: node probe/04-check.mjs   (and read the checklist in probe/README.md)');

/** A list response may be a bare array or wrapped as {data:[...]} or similar (shape UNVERIFIED). */
function pickList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) if (Array.isArray(v)) return v;
  }
  return [];
}
