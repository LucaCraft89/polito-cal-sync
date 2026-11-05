/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- test code reads loose JSON answers */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PASS, startHarness, type Harness, type Reply } from './support/web.js';

// Invented secrets; assembled so the repository secret scan does not flag them.
const PORTAL_PW = ['invented', 'portal', 'pw', '123'].join('-');
const GOOGLE_SECRET = ['invented', 'google', 'secret', '456'].join('-');
const FEED = 'https://moodle.example.test/cal.php?authtoken=' + 'Q'.repeat(24); // secret-scan:ignore
const NEW_PASS = 'another long passphrase 99';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const REQUIRED_HEADERS = [
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
  'cross-origin-opener-policy',
  'permissions-policy',
  'cache-control',
];

const auth = (a: { cookie: string; csrf: string }, extra: Record<string, string> = {}) => ({
  cookie: a.cookie,
  headers: { 'X-CSRF-Token': a.csrf, ...extra },
});

function expectError(r: Reply, status: number, code: string) {
  expect(r.status).toBe(status);
  expect(r.json.error.code).toBe(code);
  // the three-line form plus the docs link
  for (const k of ['what', 'why', 'action', 'docs']) expect(typeof r.json.error[k]).toBe('string');
  expect(r.json.error.docs).toBe(`docs/ERRORS.md#${code.toLowerCase()}`);
}

describe('first run and login', () => {
  it('setup works once, stores only a scrypt hash, and opens a session', async () => {
    h = await startHarness();
    const s0 = await h.call('GET', '/api/session');
    expect(s0.json).toEqual({ setupRequired: true, authenticated: false });
    const a = await h.setup();
    expect(a.csrf.length).toBeGreaterThan(30);
    const file = join(h.dataDir, 'ui-auth.json');
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(PASS);
    expect(JSON.parse(text)).toMatchObject({ kdf: 'scrypt', version: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const s1 = await h.call('GET', '/api/session', { cookie: a.cookie });
    expect(s1.json).toMatchObject({ setupRequired: false, authenticated: true, csrfToken: a.csrf });
    // closed afterwards
    expectError(
      await h.call('POST', '/api/setup', { body: { passphrase: NEW_PASS } }),
      409,
      'E_UI_SETUP_STATE',
    );
  });

  it('setup is refused through any Host that is not loopback, even an allowed one', async () => {
    h = await startHarness({ app: { allowedHosts: ['cal.example.test'] } });
    const r = await h.call('POST', '/api/setup', {
      body: { passphrase: PASS },
      headers: { Host: 'cal.example.test', Origin: 'http://cal.example.test' },
    });
    expectError(r, 421, 'E_UI_HOST_REFUSED');
    expect(h.dataDir).toBeTruthy();
    expect((await h.call('GET', '/api/session')).json.setupRequired).toBe(true);
  });

  it('refuses a weak passphrase with a plain reason', async () => {
    h = await startHarness();
    for (const p of ['short', 'aaaaaaaaaaaaaaaa', '']) {
      expectError(
        await h.call('POST', '/api/setup', { body: { passphrase: p } }),
        422,
        'E_UI_PASSPHRASE_WEAK',
      );
    }
    expect((await h.call('GET', '/api/session')).json.setupRequired).toBe(true);
  });

  it('login: right passphrase gets a session, wrong one does not', async () => {
    h = await startHarness();
    await h.setup();
    expectError(
      await h.call('POST', '/api/login', { body: { passphrase: 'wrong wrong wrong' } }),
      401,
      'E_UI_LOGIN_FAILED',
    );
    const a = await h.login();
    expect((await h.call('GET', '/api/settings', { cookie: a.cookie })).status).toBe(200);
  });

  it('the session cookie is HttpOnly, SameSite=Strict, and Secure only behind HTTPS', async () => {
    h = await startHarness();
    const r = await h.call('POST', '/api/setup', { body: { passphrase: PASS } });
    const cookie = String(r.headers['set-cookie']?.[0]);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toMatch(/Secure/);
    expect(cookie).not.toContain('csrf');
    await h.close();
    h = await startHarness({ app: { https: true } });
    const r2 = await h.call('POST', '/api/setup', {
      body: { passphrase: PASS },
      headers: { Origin: `https://localhost:${h.port}` },
    });
    expect(r2.status).toBe(201);
    expect(String(r2.headers['set-cookie']?.[0])).toMatch(/; Secure/);
    expect(r2.headers['strict-transport-security']).toBeTruthy();
  });

  it('logout ends the session', async () => {
    h = await startHarness();
    const a = await h.setup();
    expect((await h.call('POST', '/api/logout', auth(a))).status).toBe(200);
    expectError(
      await h.call('GET', '/api/settings', { cookie: a.cookie }),
      401,
      'E_UI_AUTH_REQUIRED',
    );
  });

  it('changing the passphrase needs the old one and ends every other session', async () => {
    h = await startHarness();
    const a = await h.setup();
    const b = await h.login();
    expectError(
      await h.call('POST', '/api/passphrase', {
        ...auth(a),
        body: { current: 'nope nope nope', next: NEW_PASS },
      }),
      401,
      'E_UI_LOGIN_FAILED',
    );
    const r = await h.call('POST', '/api/passphrase', {
      ...auth(a),
      body: { current: PASS, next: NEW_PASS },
    });
    expect(r.status).toBe(200);
    expectError(
      await h.call('GET', '/api/settings', { cookie: a.cookie }),
      401,
      'E_UI_AUTH_REQUIRED',
    );
    expectError(
      await h.call('GET', '/api/settings', { cookie: b.cookie }),
      401,
      'E_UI_AUTH_REQUIRED',
    );
    expect((await h.call('POST', '/api/login', { body: { passphrase: PASS } })).status).toBe(401);
    expect((await h.call('POST', '/api/login', { body: { passphrase: NEW_PASS } })).status).toBe(
      200,
    );
  });
});

describe('request safety', () => {
  it('everything needs a session except the state, setup and login', async () => {
    h = await startHarness();
    await h.setup();
    for (const [m, p] of [
      ['GET', '/api/settings'],
      ['PUT', '/api/settings'],
      ['GET', '/api/audit'],
      ['POST', '/api/logout'],
      ['POST', '/api/passphrase'],
    ] as const) {
      expectError(await h.call(m, p, m === 'GET' ? {} : { body: {} }), 401, 'E_UI_AUTH_REQUIRED');
    }
  });

  it('CSRF: a change without the token, or with a wrong one, is refused and changes nothing', async () => {
    h = await startHarness();
    const a = await h.setup();
    const body = { set: { syncIntervalMinutes: 30 } };
    expectError(
      await h.call('PUT', '/api/settings', { body, cookie: a.cookie }),
      403,
      'E_UI_REQUEST_REFUSED',
    );
    expectError(
      await h.call('PUT', '/api/settings', {
        body,
        cookie: a.cookie,
        headers: { 'X-CSRF-Token': 'x'.repeat(a.csrf.length) },
      }),
      403,
      'E_UI_REQUEST_REFUSED',
    );
    expectError(
      await h.call('PUT', '/api/settings', {
        body,
        cookie: a.cookie,
        headers: { 'X-CSRF-Token': 'short' },
      }),
      403,
      'E_UI_REQUEST_REFUSED',
    );
    const view = (await h.call('GET', '/api/settings', { cookie: a.cookie })).json.settings;
    expect(view.find((s: { key: string }) => s.key === 'syncIntervalMinutes').source).toBe(
      'default',
    );
    expect((await h.put('/api/settings', a, body)).status).toBe(200);
  });

  it('Origin: missing, foreign or another port is refused; Sec-Fetch-Site must be same-origin', async () => {
    h = await startHarness();
    const a = await h.setup();
    const body = { set: { deleteThreshold: 0.1 } };
    const base = auth(a);
    for (const origin of [
      undefined,
      'http://evil.example',
      'http://localhost:1',
      'null',
      `https://localhost:${h.port}`,
    ]) {
      expectError(
        await h.call('PUT', '/api/settings', {
          ...base,
          body,
          headers: { ...base.headers, Origin: origin },
        }),
        403,
        'E_UI_REQUEST_REFUSED',
      );
    }
    expectError(
      await h.call('PUT', '/api/settings', {
        ...base,
        body,
        headers: { ...base.headers, 'Sec-Fetch-Site': 'cross-site' },
      }),
      403,
      'E_UI_REQUEST_REFUSED',
    );
    expect(
      (
        await h.call('PUT', '/api/settings', {
          ...base,
          body,
          headers: { ...base.headers, 'Sec-Fetch-Site': 'same-origin' },
        })
      ).status,
    ).toBe(200);
    // login is a state change too: it needs the Origin check as well
    expectError(
      await h.call('POST', '/api/login', {
        body: { passphrase: PASS },
        headers: { Origin: 'http://evil.example' },
      }),
      403,
      'E_UI_REQUEST_REFUSED',
    );
  });

  it('Host: anything but localhost names is refused with 421, also on GET', async () => {
    h = await startHarness({ app: { allowedHosts: ['cal.example.test'] } });
    const a = await h.setup();
    for (const host of [
      'evil.example',
      'localhost.evil.example',
      '127.0.0.1.evil.example',
      'evil.example:80',
    ]) {
      expectError(
        await h.call('GET', '/api/session', { headers: { Host: host } }),
        421,
        'E_UI_HOST_REFUSED',
      );
    }
    expect(
      (await h.call('GET', '/api/session', { headers: { Host: '127.0.0.1:8787' } })).status,
    ).toBe(200);
    expect((await h.call('GET', '/api/session', { headers: { Host: '[::1]:8787' } })).status).toBe(
      200,
    );
    // an operator-allowed name works, with its own matching Origin
    const r = await h.call('PUT', '/api/settings', {
      body: { set: { deleteThreshold: 0.2 } },
      cookie: a.cookie,
      headers: {
        Host: 'cal.example.test',
        Origin: 'http://cal.example.test',
        'X-CSRF-Token': a.csrf,
      },
    });
    expect(r.status).toBe(200);
  });

  it('a request with no Host header at all is refused too', async () => {
    h = await startHarness();
    const answer = await new Promise<string>((resolve, reject) => {
      const sock = connect(h!.port, '127.0.0.1', () =>
        sock.write('GET /api/session HTTP/1.0\r\n\r\n'),
      );
      let data = '';
      sock.on('data', (d) => (data += d.toString()));
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    expect(answer.split('\r\n')[0]).toContain('421');
    expect(answer).toContain('E_UI_HOST_REFUSED');
  });

  it('GET never changes anything: files are identical after reading everything', async () => {
    h = await startHarness();
    const a = await h.setup();
    await h.put('/api/settings', a, { set: { deleteThreshold: 0.2 } });
    const snapshot = () =>
      Object.fromEntries(
        readdirSync(h!.dataDir).map((f) => [f, readFileSync(join(h!.dataDir, f), 'utf8')]),
      );
    const before = snapshot();
    for (const p of ['/api/session', '/api/settings', '/api/audit', '/api/audit?limit=3']) {
      expect((await h.call('GET', p, { cookie: a.cookie })).status).toBe(200);
    }
    expect(snapshot()).toEqual(before);
  });

  it('bodies: JSON only, size limited, objects only, unknown fields refused, nothing echoed', async () => {
    h = await startHarness();
    const a = await h.setup();
    const hdr = { 'X-CSRF-Token': a.csrf };
    expectError(
      await h.call('PUT', '/api/settings', {
        rawBody: 'set=1',
        cookie: a.cookie,
        headers: { ...hdr, 'Content-Type': 'text/plain' },
      }),
      403,
      'E_UI_REQUEST_REFUSED',
    );
    expectError(
      await h.call('PUT', '/api/settings', { rawBody: '{oops', cookie: a.cookie, headers: hdr }),
      403,
      'E_UI_REQUEST_REFUSED',
    );
    expectError(
      await h.call('PUT', '/api/settings', { rawBody: '[1]', cookie: a.cookie, headers: hdr }),
      403,
      'E_UI_REQUEST_REFUSED',
    );
    const big = await h.call('PUT', '/api/settings', {
      rawBody: JSON.stringify({ set: { tz: 'x'.repeat(400_000) } }),
      cookie: a.cookie,
      headers: hdr,
    });
    expectError(big, 403, 'E_UI_REQUEST_REFUSED');
    expect(big.json.error.what).toContain('larger than');
    const extra = await h.call('PUT', '/api/settings', {
      body: { set: {}, evil: PORTAL_PW },
      cookie: a.cookie,
      headers: hdr,
    });
    expectError(extra, 403, 'E_UI_REQUEST_REFUSED');
    expect(extra.text).not.toContain(PORTAL_PW);
  });

  it('methods and paths: wrong method 405, unknown path 404, other paths are not the API', async () => {
    h = await startHarness();
    const a = await h.setup();
    expectError(await h.call('DELETE', '/api/settings', auth(a)), 405, 'E_UI_REQUEST_REFUSED');
    expectError(await h.call('POST', '/api/session', auth(a)), 405, 'E_UI_REQUEST_REFUSED');
    expectError(await h.call('GET', '/api/nothing', { cookie: a.cookie }), 404, 'E_UI_NOT_FOUND');
    // the status page keeps working next to the API
    expect((await h.call('GET', '/healthz')).status).toBeGreaterThan(0);
  });
});

describe('headers', () => {
  it('every API answer and the status page carry the security headers, errors included', async () => {
    h = await startHarness();
    const a = await h.setup();
    const replies = [
      await h.call('GET', '/api/session'),
      await h.call('GET', '/api/settings', { cookie: a.cookie }),
      await h.call('GET', '/api/settings'), // 401
      await h.call('GET', '/api/nothing'), // 404
      await h.call('GET', '/api/session', { headers: { Host: 'evil.example' } }), // 421
      await h.call('POST', '/api/login', { body: { passphrase: 'x' } }), // 401
      await h.call('GET', '/status'),
    ];
    for (const r of replies) {
      for (const name of REQUIRED_HEADERS)
        expect(r.headers[name], `${name} on ${r.status}`).toBeTruthy();
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['content-security-policy']).toContain("default-src 'none'");
      expect(r.headers['content-security-policy']).not.toContain('unsafe');
      expect(r.headers['content-type']).toMatch(/^application\/json/);
      expect(r.headers['access-control-allow-origin']).toBeUndefined(); // CORS is not enabled
    }
  });
});

describe('sessions and throttling', () => {
  it('a session expires after 30 idle minutes, but activity keeps it alive; 12 hours is the limit', async () => {
    h = await startHarness();
    const a = await h.setup();
    h.clock.t += 29 * 60_000;
    expect((await h.call('GET', '/api/settings', { cookie: a.cookie })).status).toBe(200);
    h.clock.t += 29 * 60_000; // still alive: the last request refreshed it
    expect((await h.call('GET', '/api/settings', { cookie: a.cookie })).status).toBe(200);
    h.clock.t += 31 * 60_000;
    expectError(
      await h.call('GET', '/api/settings', { cookie: a.cookie }),
      401,
      'E_UI_AUTH_REQUIRED',
    );
    // absolute limit
    const b = await h.login();
    for (let i = 0; i < 25; i++) {
      h.clock.t += 29 * 60_000;
      await h.call('GET', '/api/session', { cookie: b.cookie });
    }
    expectError(
      await h.call('GET', '/api/settings', { cookie: b.cookie }),
      401,
      'E_UI_AUTH_REQUIRED',
    );
  });

  it('wrong passphrases are slowed down; while blocked even the right one is refused', async () => {
    h = await startHarness();
    await h.setup();
    const wrong = () =>
      h!.call('POST', '/api/login', { body: { passphrase: 'wrong wrong wrong' } });
    expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(401); // two free typos
    const third = await wrong();
    expect(third.status).toBe(401); // this one starts the wait
    const blocked = await wrong();
    expectError(blocked, 429, 'E_UI_LOGIN_THROTTLED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expectError(
      await h.call('POST', '/api/login', { body: { passphrase: PASS } }),
      429,
      'E_UI_LOGIN_THROTTLED',
    );
    h.clock.t += 5_000;
    expect((await h.call('POST', '/api/login', { body: { passphrase: PASS } })).status).toBe(200);
  });

  it('the back-off grows and is capped at the lockout limit', async () => {
    h = await startHarness();
    await h.setup();
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await h.call('POST', '/api/login', { body: { passphrase: 'wrong wrong wrong' } });
      if (r.status === 429) {
        const w = Number(r.headers['retry-after']);
        waits.push(w);
        h.clock.t += w * 1000;
        await h.call('POST', '/api/login', { body: { passphrase: 'wrong wrong wrong' } });
      }
    }
    expect(waits.length).toBeGreaterThan(3);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
    expect(Math.max(...waits)).toBeLessThanOrEqual(15 * 60);
  });

  it('a global ceiling blocks every address after too many failures', async () => {
    h = await startHarness();
    await h.setup();
    for (let i = 0; i < 40; i++) {
      h.throttle.failure(`10.0.0.${i}`);
    }
    expectError(
      await h.call('POST', '/api/login', { body: { passphrase: PASS } }),
      429,
      'E_UI_LOGIN_THROTTLED',
    );
  });
});

describe('settings over the API', () => {
  it('saves, validates like .env, shows what is locked by the environment', async () => {
    h = await startHarness({ env: { POLITO_USERNAME: 'envuser' } });
    const a = await h.setup();
    const ok = await h.put('/api/settings', a, {
      set: { syncIntervalMinutes: 45, 'polito.squads': { '309865': ['A'], '309742': ['2'] } },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.changed.sort()).toEqual(['polito.squads', 'syncIntervalMinutes']);
    const by = (r: Reply, k: string) => r.json.settings.find((s: { key: string }) => s.key === k);
    expect(by(ok, 'syncIntervalMinutes')).toMatchObject({ source: 'ui', value: 45 });
    expect(by(ok, 'polito.username')).toMatchObject({
      source: 'env',
      locked: true,
      value: 'envuser',
    });
    expectError(
      await h.put('/api/settings', a, { set: { syncIntervalMinutes: 5 } }),
      422,
      'E_SETTING_INVALID',
    );
    expectError(
      await h.put('/api/settings', a, { set: { 'polito.username': 'x' } }),
      409,
      'E_SETTING_LOCKED',
    );
    expectError(await h.put('/api/settings', a, { set: { nope: 1 } }), 422, 'E_SETTING_INVALID');
    const file = join(h.dataDir, 'settings.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const audit = (await h.call('GET', '/api/audit', { cookie: a.cookie })).json.entries;
    expect(audit.map((e: { action: string }) => e.action)).toContain('settings.update');
  });
});

describe('secrets never leave', () => {
  it('no answer, header, log line, audit entry or error contains a configured secret', async () => {
    h = await startHarness({ env: { GOOGLE_CLIENT_SECRET: GOOGLE_SECRET } });
    const a = await h.setup();
    const wrong = await h.put('/api/settings', a, {
      set: { 'polito.password': PORTAL_PW, syncIntervalMinutes: 1 },
    });
    const saved = await h.put('/api/settings', a, {
      set: { 'polito.password': PORTAL_PW, icsUrls: [FEED], 'polito.username': 'someone' },
    });
    const locked = await h.put('/api/settings', a, {
      set: { 'google.clientSecret': PORTAL_PW + '-2' },
    });
    const replies: Reply[] = [
      wrong,
      saved,
      locked,
      await h.call('GET', '/api/settings', { cookie: a.cookie }),
      await h.call('GET', '/api/audit', { cookie: a.cookie }),
      await h.call('GET', '/api/session', { cookie: a.cookie }),
      await h.call('POST', '/api/login', { body: { passphrase: 'wrong wrong ' + PORTAL_PW } }),
      await h.call('POST', '/api/passphrase', {
        ...auth(a),
        body: { current: PORTAL_PW, next: NEW_PASS },
      }),
      await h.call('PUT', '/api/settings', {
        rawBody: `{"set": {"polito.password": "${PORTAL_PW}"`,
        cookie: a.cookie,
        headers: { 'X-CSRF-Token': a.csrf },
      }),
    ];
    expect(saved.status).toBe(200);
    const secrets = [PORTAL_PW, GOOGLE_SECRET, 'authtoken', 'Q'.repeat(24), PASS, NEW_PASS];
    const view = (await h.call('GET', '/api/settings', { cookie: a.cookie })).json.settings;
    expect(view.find((s: { key: string }) => s.key === 'polito.password')).toMatchObject({
      set: true,
      secret: true,
    });
    expect(view.find((s: { key: string }) => s.key === 'google.clientSecret')).toMatchObject({
      set: true,
      locked: true,
    });
    const files = readdirSync(h.dataDir).filter((f) => f === 'audit.log' || f === 'ui-auth.json');
    const surfaces = [
      ...replies.map((r) => r.text + JSON.stringify(r.headers).replace(/pcs_session=[^"]*/g, '')),
      h.logs.join('\n'),
      ...files.map((f) => readFileSync(join(h!.dataDir, f), 'utf8')),
    ];
    for (const s of surfaces) for (const secret of secrets) expect(s).not.toContain(secret);
    // the one place a secret is allowed to live: the 0600 settings file
    expect(readFileSync(join(h.dataDir, 'settings.json'), 'utf8')).toContain(PORTAL_PW);
  });
});
