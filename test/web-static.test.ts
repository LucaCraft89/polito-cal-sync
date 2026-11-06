/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- test code reads loose JSON answers */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTokensCss, CONTRAST_PAIRS, contrast, scheme } from '../scripts/palette.js';
import { SettingsStore } from '../src/settings/store.js';
import { PREVIEW_MIN_INTERVAL_MS } from '../src/web/preview.js';
import { startHarness, type Harness } from './support/web.js';
import { FEED, ics, previewWorld } from './support/preview-world.js';

const ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) =>
    statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)],
  );
const clientFiles = walk(ROOT).filter((f) => /\.(js|html)$/.test(f));

describe('design tokens', () => {
  it('web/assets/tokens.css is exactly what scripts/palette.ts generates (run `pnpm tokens`)', () => {
    expect(readFileSync(join(ROOT, 'assets/tokens.css'), 'utf8')).toBe(buildTokensCss());
  });

  for (const dark of [false, true]) {
    it(`every text and control pair meets WCAG AA in the ${dark ? 'dark' : 'light'} scheme`, () => {
      const roles = scheme(dark);
      const failures: string[] = [];
      for (const [fg, bg, min, why] of CONTRAST_PAIRS) {
        const a = roles[fg];
        const b = roles[bg];
        if (!a || !b) {
          failures.push(`${fg}/${bg}: unknown role`);
          continue;
        }
        const ratio = contrast(a, b);
        if (ratio < min) failures.push(`${why}: ${fg} on ${bg} = ${ratio.toFixed(2)} < ${min}`);
      }
      expect(failures).toEqual([]);
    });
  }
});

describe('client source rules (CSP: no inline script or style; untrusted text as text only)', () => {
  it('has no way to turn text into markup, no eval, no inline style', () => {
    const forbidden = [
      /\binnerHTML\b/,
      /\bouterHTML\b/,
      /insertAdjacentHTML/,
      /document\.write/,
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /setAttribute\(\s*['"]style['"]/,
      /\.srcdoc\b/,
      /createContextualFragment/,
      /setHTML/,
    ];
    const hits: string[] = [];
    for (const f of clientFiles) {
      const text = readFileSync(f, 'utf8');
      for (const re of forbidden)
        if (re.test(text)) hits.push(`${relative(ROOT, f)}: ${String(re)}`);
    }
    expect(hits).toEqual([]);
  });

  it('index.html has no inline script, no style attribute and no third-party address', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    expect(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)).toBe(false);
    expect(/\sstyle\s*=/.test(html)).toBe(false);
    expect(/<style/i.test(html)).toBe(false);
    expect(/https?:\/\//.test(html)).toBe(false);
    for (const f of clientFiles)
      expect(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(readFileSync(f, 'utf8'))).toBe(false);
  });

  it('every file the page references exists', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1] as string);
    expect(refs.length).toBeGreaterThan(3);
    for (const r of refs) expect(() => statSync(join(ROOT, r))).not.toThrow();
    for (const f of clientFiles.filter((x) => x.endsWith('.js'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
        const target = join(f, '..', m[1] as string);
        expect(() => statSync(target), `${relative(ROOT, f)} imports ${m[1]}`).not.toThrow();
      }
    }
  });
});

describe('serving the UI files', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('serves the shell and assets with the security headers, revalidating', async () => {
    h = await startHarness();
    const r = await h.call('GET', '/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('<title>polito-cal-sync</title>');
    expect(String(r.headers['content-type'])).toContain('text/html');
    expect(String(r.headers['content-security-policy'])).toContain("script-src 'self'");
    expect(String(r.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-cache');
    for (const path of [
      '/assets/app.js',
      '/assets/base.css',
      '/assets/fonts/RobotoFlex-latin-wght.woff2',
    ]) {
      const a = await h.call('GET', path);
      expect(a.status, path).toBe(200);
      expect(a.headers['x-content-type-options']).toBe('nosniff');
    }
    expect(String((await h.call('GET', '/assets/app.js')).headers['content-type'])).toContain(
      'javascript',
    );
    const etag = String(r.headers['etag']);
    expect((await h.call('GET', '/', { headers: { 'If-None-Match': etag } })).status).toBe(304);
    expect((await h.call('HEAD', '/')).text).toBe('');
  });

  it('refuses a foreign Host with 421 and never serves anything outside web/', async () => {
    h = await startHarness();
    expect((await h.call('GET', '/', { headers: { Host: 'evil.example' } })).status).toBe(421);
    expect(
      (await h.call('GET', '/assets/app.js', { headers: { Host: 'evil.example' } })).status,
    ).toBe(421);
    for (const path of [
      '/assets/../../package.json',
      '/%2e%2e/package.json',
      '/assets/%2e%2e/%2e%2e/package.json',
      '/package.json',
      '/index.html',
      '/assets/',
    ]) {
      const r = await h.call('GET', path);
      expect(r.text.includes('polito-cal-sync"'), path).toBe(false);
      expect(r.status, path).not.toBe(200);
    }
    expect((await h.call('POST', '/')).status).not.toBe(200);
  });

  it('the status page endpoints still work next to the UI', async () => {
    h = await startHarness();
    expect((await h.call('GET', '/healthz')).status).toBe(200);
  });
});

describe('feed list edits (the browser never sees feed addresses)', () => {
  it('adds and removes by index without echoing the address', async () => {
    const h = await startHarness();
    try {
      const a = await h.setup();
      const A =
        'https://moodle.example.invalid/calendar/export_execute.php?userid=1&authtoken=aaaabbbbccccddddeeee'; // secret-scan:ignore
      let r = await h.put('/api/settings', a, { icsFeeds: { add: [A, FEED] } });
      expect(r.status).toBe(200);
      expect(r.text).not.toContain('authtoken');
      expect(r.text).not.toContain('secret-feed-token');
      const view = (r.json.settings as { key: string; value?: unknown; env?: string }[]).find(
        (s) => s.key === 'icsUrls',
      );
      expect(view?.value).toEqual([
        { index: 1, host: 'moodle.example.invalid' },
        { index: 2, host: 'feed.example.invalid' },
      ]);
      expect(view?.env).toBe('SOURCE_POLITO_ICS_URLS');
      expect(new SettingsStore(h.dataDir).read()['icsUrls']).toEqual([A, FEED]);

      r = await h.put('/api/settings', a, { icsFeeds: { remove: [0] } });
      expect(r.status).toBe(200);
      expect(new SettingsStore(h.dataDir).read()['icsUrls']).toEqual([FEED]);
      // an index that no longer exists is refused, nothing changes
      r = await h.put('/api/settings', a, { icsFeeds: { remove: [5] } });
      expect(r.status).toBe(422);
      expect(r.json.error.code).toBe('E_SETTING_INVALID');
      // removing the last one clears the setting
      r = await h.put('/api/settings', a, { icsFeeds: { remove: [0] } });
      expect(r.status).toBe(200);
      expect(new SettingsStore(h.dataDir).read()['icsUrls']).toBeUndefined();
      // both ways at once is refused
      r = await h.put('/api/settings', a, { icsFeeds: { add: [A] }, set: { icsUrls: [A] } });
      expect(r.status).toBe(403);
    } finally {
      await h.close();
    }
  });

  it('is refused when the environment sets the list', async () => {
    const h = await startHarness({ env: { SOURCE_POLITO_ICS_URLS: FEED } });
    try {
      const a = await h.setup();
      const r = await h.put('/api/settings', a, {
        icsFeeds: { add: ['https://x.example.invalid/a.ics'] },
      });
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe('E_SETTING_LOCKED');
    } finally {
      await h.close();
    }
  });
});

describe('preview endpoint (dry run, rate limited, single flight)', () => {
  const setupWith = async (feed = ics(['a', '20261110T090000Z', 'Fisica'])) => {
    const w = previewWorld(() => feed);
    const t = { now: Date.parse('2026-11-04T10:00:00Z') };
    const h = await startHarness({
      env: { TZ: 'Europe/Rome' },
      app: { runDeps: w.deps, now: () => t.now },
    });
    const a = await h.setup();
    await h.put('/api/settings', a, { icsFeeds: { add: [FEED] } });
    const post = () =>
      h.call('POST', '/api/preview', {
        body: {},
        cookie: a.cookie,
        headers: { 'X-CSRF-Token': a.csrf },
      });
    const get = () => h.call('GET', '/api/preview', { cookie: a.cookie });
    return { w, h, t, a, post, get };
  };

  it('needs a login and the CSRF token', async () => {
    const { h } = await setupWith();
    try {
      expect((await h.call('GET', '/api/preview')).status).toBe(401);
      expect((await h.call('POST', '/api/preview', { body: {} })).status).toBe(401);
      const a = await h.login();
      const noCsrf = await h.call('POST', '/api/preview', { body: {}, cookie: a.cookie });
      expect(noCsrf.status).toBe(403);
    } finally {
      await h.close();
    }
  });

  it('returns the plan and writes nothing to the calendar', async () => {
    const { w, h, post, get } = await setupWith();
    try {
      expect((await get()).json).toEqual({ preview: null, nextAllowedAt: null });
      const r = await post();
      expect(r.status).toBe(200);
      const p = r.json.preview;
      expect(p.counts).toEqual({ creates: 1, patches: 0, deletes: 0, unchanged: 0 });
      expect(p.creates[0].title).toBe('Fisica');
      expect(p.complete).toBe(true);
      expect(p.safety.exceeded).toBe(false);
      // No write of any kind reached Google; the feed address is in no answer and no log line.
      expect(w.api.calls.filter((c) => c.op !== 'list')).toEqual([]);
      expect(r.text).not.toContain('secret-feed-token');
      expect(h.logs.join('\n')).not.toContain('secret-feed-token');
      expect((await get()).json.preview.counts.creates).toBe(1);
      expect(w.fetched).toEqual([FEED]);
    } finally {
      await h.close();
    }
  });

  it('allows one preview per 15 minutes, counted from the start of the last attempt', async () => {
    const { w, h, t, post, get } = await setupWith();
    try {
      expect((await post()).status).toBe(200);
      t.now += 14 * 60_000;
      const early = await post();
      expect(early.status).toBe(429);
      expect(early.json.error.code).toBe('E_UI_PREVIEW_RATE_LIMITED');
      expect(w.fetched.length).toBe(1); // the refused request cost no traffic
      expect((await get()).json.nextAllowedAt).toBe(
        new Date(Date.parse('2026-11-04T10:00:00Z') + PREVIEW_MIN_INTERVAL_MS).toISOString(),
      );
      t.now += 61_000;
      expect((await post()).status).toBe(200);
      expect(w.fetched.length).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('a failed preview also counts against the limit (no retry hammering)', async () => {
    const { w, h, t, post } = await setupWith();
    try {
      w.deps.googleFactory = () => Promise.reject(new Error('boom'));
      expect((await post()).status).toBeGreaterThanOrEqual(400);
      expect((await post()).status).toBe(429);
      t.now += PREVIEW_MIN_INTERVAL_MS + 1;
      w.deps.googleFactory = () => Promise.resolve({ api: w.api, calendarId: 'dedicated-cal' });
      expect((await post()).status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('is single flight: a second request while one runs is refused', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { w, h, post } = await setupWith();
    try {
      const real = w.deps.googleFactory;
      w.deps.googleFactory = async (c) => {
        await gate;
        return real ? real(c) : Promise.reject(new Error('no google'));
      };
      const first = post();
      await new Promise((r) => setTimeout(r, 50));
      const second = await post();
      expect(second.status).toBe(409);
      expect(second.json.error.code).toBe('E_UI_PREVIEW_BUSY');
      release();
      expect((await first).status).toBe(200);
    } finally {
      release();
      await h.close();
    }
  });

  it('says what is missing when nothing is configured', async () => {
    const h = await startHarness({
      env: { TZ: 'Europe/Rome' },
      app: { runDeps: previewWorld().deps },
    });
    try {
      const a = await h.setup();
      const r = await h.call('POST', '/api/preview', {
        body: {},
        cookie: a.cookie,
        headers: { 'X-CSRF-Token': a.csrf },
      });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('E_NOT_CONFIGURED');
      expect(r.json.error.docs).toBe('docs/ERRORS.md#e_not_configured');
    } finally {
      await h.close();
    }
  });
});
