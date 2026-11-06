// Step 1 - unauthenticated recon. No password, no login, 4 GET requests, 1.5 s apart.
//   node probe/01-recon.mjs [--base-url https://...]
// Writes probe/out/01-recon.json (git-ignored). It is safe to send that file back.

import { DEFAULT_BASE_URL, Http, parseArgs, StopProbe, USER_AGENT } from './lib/http.mjs';
import { shapeOfBody } from './lib/shape.mjs';
import { writeOut } from './lib/out.mjs';

const args = parseArgs(process.argv.slice(2));
const baseUrl = typeof args['base-url'] === 'string' ? args['base-url'] : DEFAULT_BASE_URL;

// Candidate paths. A 404 is a perfectly good answer: it tells us the path does not exist.
// /lectures needs a login: the point is to see HOW the server says "log in" (401? header?).
const TARGETS = [
  { path: '', why: 'the API root itself' },
  { path: '/health', why: 'a common health endpoint (candidate, may not exist)' },
  { path: '/version', why: 'a common version endpoint (candidate, may not exist)' },
  {
    path: '/lectures',
    why: 'a protected endpoint, called WITHOUT a token to see how the server asks for one',
  },
];

console.log('probe 01 - unauthenticated recon');
console.log(`  base URL:    ${baseUrl}`);
console.log(`  User-Agent:  ${USER_AGENT}`);
console.log('  It will send these requests, one at a time, 1.5 s apart, with no credentials:');
for (const t of TARGETS) console.log(`    GET ${baseUrl}${t.path}   (${t.why})`);
console.log(
  '  It stops at once on HTTP 429. It records status codes, a few harmless headers and the',
);
console.log('  shape of each answer (key names only).\n');

const log = (l) => console.log(l);
const http = new Http({ baseUrl, log });
const results = [];
try {
  for (const t of TARGETS) {
    const r = await http.request('GET', t.path);
    const entry = {
      path: t.path || '/',
      why: t.why,
      status: r.status,
      headers: r.headers,
      cookieNames: r.cookieNames,
      bodyShape: shapeOfBody(r.text, r.headers['content-type']),
    };
    results.push(entry);
    console.log(`  GET ${t.path || '/'} -> ${r.status}`);
  }
} catch (err) {
  if (!(err instanceof StopProbe)) throw err;
  console.log(`\nSTOPPED: ${err.message}`);
  results.push({ stopped: err.message });
}

const file = writeOut('01-recon.json', {
  when: new Date().toISOString(),
  baseUrl,
  userAgent: USER_AGENT,
  results,
  requests: http.requestLog,
});
console.log(`\nWritten: ${file}`);
console.log(
  'Next: node probe/02-login.mjs   (read probe/README.md first: it asks for your password locally)',
);
