/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- code evaluated in the page is loosely typed */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { scheme } from '../scripts/palette.js';
import { SettingsStore } from '../src/settings/store.js';
import { startHarness, PASS, type Harness } from './support/web.js';
import { FEED, ics, previewWorld } from './support/preview-world.js';
import { FakeCalendars, fakeFlow } from './support/fake-calendars.js';
import { opts, PASS as PORTAL_PASS, USER, world as portalWorld } from './support/portal-world.js';

// Real browser tests (Chromium via Playwright): responsive layout, accessibility (axe-core), keyboard,
// reduced motion, CSP and stored-XSS rendering. They need a Chromium; without one they are skipped locally,
// but in CI (REQUIRE_BROWSER=1) a missing browser is a failure, never a silent skip.
vi.setConfig({ testTimeout: 60_000 });
let browser: Browser | undefined;
try {
  browser = await chromium.launch();
} catch (err) {
  if (process.env['REQUIRE_BROWSER'] === '1') throw err;
}
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const VIEWPORTS = [
  { name: '360x800', width: 360, height: 800 },
  { name: '390x844', width: 390, height: 844 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1280x800', width: 1280, height: 800 },
] as const;
const ROUTES = ['overview', 'preview', 'sources', 'settings'] as const;
const XSS_TITLE = '<img src=x onerror="window.__xss=1">';

interface Watch {
  problems: string[];
}

/** Records everything that must never happen: page errors, CSP violations, requests to other origins. */
function watch(page: Page): Watch {
  const w: Watch = { problems: [] };
  page.on('pageerror', (e) => w.problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (/content security policy|refused to/i.test(m.text())) w.problems.push(`csp: ${m.text()}`);
    if (m.type() === 'error' && !/status of (4\d\d|5\d\d)/.test(m.text()))
      w.problems.push(`console: ${m.text()}`);
  });
  page.on('request', (r) => {
    if (new URL(r.url()).hostname !== 'localhost' && !r.url().startsWith('data:'))
      w.problems.push(`foreign request: ${r.url()}`);
  });
  return w;
}

function seed(h: Harness): void {
  new SettingsStore(h.dataDir).apply(
    {
      set: {
        'polito.enabled': true,
        'polito.username': 's000000',
        'polito.password': 'fake-password-not-real', // secret-scan:ignore
        'polito.squads': { '111111': ['A'] },
        'google.clientId': 'fake-client-id',
        icsUrls: [FEED],
      },
    },
    {},
  );
}

async function layoutProblems(page: Page, vw: number): Promise<string[]> {
  return page.evaluate((viewport) => {
    const out: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > window.innerWidth)
      out.push(`horizontal scroll: ${doc.scrollWidth} > ${window.innerWidth}`);
    for (const el of document.querySelectorAll('main *, .top-bar *, .nav *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > window.innerWidth + 1)
        out.push(`overflows right: <${el.tagName.toLowerCase()} class="${el.className}">`);
    }
    const SEL = 'a[href], button, input, select, textarea, summary';
    for (const el of document.querySelectorAll(SEL)) {
      if (
        el.closest('[hidden]') ||
        el.classList.contains('skip-link') ||
        el.matches('input[type=hidden]')
      )
        continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.tagName === 'A' && el.closest('p, .field-help, .t-small, dd')) continue; // inline links are exempt
      const target = el.matches('input[type=checkbox], input[type=radio]')
        ? (el.closest('label') ?? el)
        : el;
      const r = target.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.width < 47.5 || r.height < 47.5)
        out.push(
          `small target ${Math.round(r.width)}x${Math.round(r.height)}: <${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 24)}"`,
        );
    }
    const nav = document.getElementById('nav');
    if (nav && document.getElementById('shell')?.dataset['view'] === 'app') {
      const r = nav.getBoundingClientRect();
      const dir = getComputedStyle(nav.querySelector('.nav-item') as Element).flexDirection;
      if (viewport < 600) {
        if (Math.round(r.width) !== viewport || Math.round(r.bottom) !== window.innerHeight)
          out.push(
            `compact: nav is not a bottom bar (${Math.round(r.left)},${Math.round(r.bottom)} ${Math.round(r.width)}w)`,
          );
        if (dir !== 'column') out.push('compact: nav items should stack icon over label');
      } else if (viewport < 840) {
        if (Math.round(r.width) !== 96 || Math.round(r.left) !== 0)
          out.push(`medium: nav is not a 96px rail (${Math.round(r.width)})`);
        if (dir !== 'column') out.push('medium: rail items should stack icon over label');
      } else {
        if (Math.round(r.width) !== 280 || Math.round(r.left) !== 0)
          out.push(`expanded: nav is not a 280px drawer (${Math.round(r.width)})`);
        if (dir !== 'row') out.push('expanded: drawer items should have the label beside the icon');
      }
    }
    return out;
  }, vw);
}

async function axeProblems(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  const res = await page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const r = await window.axe.run(document, {
      // target-size is replaced by our own 48 px check; a sticky bar overlapping a control at the current scroll
      // position (which axe counts) is covered by the "never hidden behind the bars" test below.
      rules: { 'target-size': { enabled: false } },
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
    });
    return r.violations.map(
      (v: { id: string; impact: string; nodes: { target: unknown[] }[] }) => ({
        id: v.id,
        impact: v.impact,
        targets: v.nodes.slice(0, 3).map((n) => String(n.target[0])),
      }),
    );
  });
  return res
    .filter((v: { impact: string }) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v: { id: string; impact: string; targets: string[] }) =>
        `${v.impact} ${v.id}: ${v.targets.join(' | ')}`,
    );
}

const waitPage = async (page: Page, text: string | RegExp): Promise<void> => {
  try {
    await page.locator('main').getByText(text).first().waitFor({ timeout: 8000 });
  } catch (err) {
    const seen = (
      await page
        .locator('main')
        .innerText()
        .catch(() => '(no main)')
    ).slice(0, 600);
    throw new Error(`waiting for ${String(text)}; the page shows: ${seen}`, { cause: err });
  }
};

/** Waits until finite animations (entrance pop-ins) are done, so sizes are measured at rest. */
const settle = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime as number))
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );

describe.skipIf(!browser)('web UI in a real browser', () => {
  let h: Harness;
  let base: string;
  let world: ReturnType<typeof previewWorld>;
  const contexts: BrowserContext[] = [];

  const newPage = async (o: { width: number; height: number } & Record<string, unknown>) => {
    const ctx = await (browser as Browser).newContext({
      viewport: { width: o.width, height: o.height },
      ...o,
    });
    contexts.push(ctx);
    const page = await ctx.newPage();
    return { ctx, page, w: watch(page) };
  };

  beforeAll(async () => {
    world = previewWorld(() =>
      ics(['x1', '20261110T090000Z', XSS_TITLE], ['x2', '20261111T090000Z', 'Chimica']),
    );
    h = await startHarness({
      env: { TZ: 'Europe/Rome' },
      app: { runDeps: world.deps, previewMinIntervalMs: 0 },
    });
    base = `http://localhost:${h.port}`;
  });
  afterAll(async () => {
    for (const c of contexts) await c.close();
    await browser?.close();
    await h?.close();
  });

  it('first run: choose a passphrase, then log in again from a new browser', async () => {
    const { page, w } = await newPage({ width: 390, height: 844 });
    await page.goto(`${base}/`);
    await waitPage(page, 'Choose a passphrase');
    // mismatch is caught on the page, a weak passphrase is refused by the server with the three-line form
    await page.getByLabel('Passphrase', { exact: true }).fill('short');
    await page.getByLabel('Type it again').fill('short');
    await page.getByRole('button', { name: 'Set passphrase' }).click();
    await waitPage(page, 'What to do');
    await page.getByLabel('Passphrase', { exact: true }).fill(PASS);
    await page.getByLabel('Type it again').fill(`${PASS}x`);
    await page.getByRole('button', { name: 'Set passphrase' }).click();
    await waitPage(page, 'The two passphrases are not the same.');
    await page.getByLabel('Type it again').fill(PASS);
    await page.getByRole('button', { name: 'Set passphrase' }).click();
    await waitPage(page, 'Last sync');
    expect(await page.title()).toContain('Overview');

    const other = await newPage({ width: 390, height: 844 });
    await other.page.goto(`${base}/`);
    await waitPage(other.page, 'Log in');
    await other.page.getByLabel('Passphrase').fill('wrong wrong wrong wrong');
    await other.page.getByRole('button', { name: 'Log in' }).click();
    await waitPage(other.page, 'The passphrase is not correct.');
    await other.page.getByLabel('Passphrase').fill(PASS);
    await other.page.getByRole('button', { name: 'Log in' }).click();
    await waitPage(other.page, 'Last sync');
    expect([...w.problems, ...other.w.problems]).toEqual([]);
    seed(h);
  });

  for (const vp of VIEWPORTS) {
    it(`layout and accessibility at ${vp.name}`, async () => {
      const { page, w } = await newPage(vp);
      await page.goto(`${base}/`);
      await waitPage(page, 'Log in');
      expect(await layoutProblems(page, vp.width)).toEqual([]);
      expect(await axeProblems(page)).toEqual([]);
      await page.getByLabel('Passphrase').fill(PASS);
      await page.getByRole('button', { name: 'Log in' }).click();
      await waitPage(page, 'Last sync');
      for (const route of ROUTES) {
        await page.goto(`${base}/#/${route}`);
        await page.locator('.nav-item[aria-current="page"]').waitFor();
        await page.waitForLoadState('networkidle');
        await settle(page);
        const label = await page.locator('.nav-item[aria-current="page"]').textContent();
        expect(label?.toLowerCase(), route).toContain(route);
        expect(await layoutProblems(page, vp.width), `${route} layout`).toEqual([]);
        expect(await axeProblems(page), `${route} axe (light)`).toEqual([]);
        if (vp.width === 1280 || vp.width === 360) {
          await page.emulateMedia({ colorScheme: 'dark' });
          await settle(page); // colour transitions must be over before contrast is measured
          expect(await axeProblems(page), `${route} axe (dark)`).toEqual([]);
          await page.emulateMedia({ colorScheme: 'light' });
          await settle(page);
        }
      }
      // The main action is visible, and not hidden behind the bottom bar.
      await page.goto(`${base}/#/overview`);
      const fab = page.locator('.fab');
      await fab.waitFor();
      const box = await fab.boundingBox();
      const nav = await page.locator('#nav').boundingBox();
      expect(box && box.y >= 0 && box.y + box.height <= vp.height).toBe(true);
      if (vp.width < 600 && box && nav) expect(box.y + box.height).toBeLessThanOrEqual(nav.y);
      expect(w.problems).toEqual([]);
    }, 60_000);
  }

  it('has no horizontal scroll at 320 px', async () => {
    for (const width of [320]) {
      const { page } = await newPage({ width, height: 700 });
      await page.goto(`${base}/`);
      await page.getByLabel('Passphrase').fill(PASS);
      await page.getByRole('button', { name: 'Log in' }).click();
      await waitPage(page, 'Last sync');
      for (const route of ROUTES) {
        await page.goto(`${base}/#/${route}`);
        await page.waitForLoadState('networkidle');
        const over = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(over, `${route} at ${width}`).toBeLessThanOrEqual(0);
      }
    }
  });

  it('keeps the main action visible when the on-screen keyboard shrinks the window', async () => {
    const { page } = await newPage({ width: 360, height: 340 });
    await page.goto(`${base}/`);
    await page.getByLabel('Passphrase').fill(PASS);
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.goto(`${base}/#/preview`);
    const fab = page.getByRole('button', { name: 'Preview now' });
    await fab.waitFor();
    const box = await fab.boundingBox();
    expect(box && box.y >= 0 && box.y + box.height <= 340).toBe(true);
  });

  it('can be used with the keyboard alone, with a visible focus', async () => {
    const { page } = await newPage({ width: 1280, height: 800 });
    await page.goto(`${base}/`);
    await page.keyboard.press('Tab'); // the skip link
    expect(await page.evaluate(() => document.activeElement?.className)).toContain('skip-link');
    await page.getByLabel('Passphrase').focus();
    await page.keyboard.type(PASS);
    await page.keyboard.press('Enter');
    await waitPage(page, 'Last sync');
    await page.goto(`${base}/#/settings`);
    await waitPage(page, 'General');
    // A radio group is ONE tab stop (the arrow keys move inside it): count the checked radio only.
    const STOPS = `[...document.querySelectorAll('main a[href], main button, main input')].filter((e) => e.offsetParent !== null && !e.disabled && !(e.type === 'radio' && !e.checked))`;
    const total = await page.evaluate(`${STOPS}.length`);
    const seen = new Set<string>();
    const unfocusable: string[] = [];
    await page.locator('main').focus();
    for (let i = 0; i < (total as number) + 12 && seen.size < (total as number); i++) {
      await page.keyboard.press('Tab');
      await settle(page); // the focus ring fades in; measure it once it is there
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || !el.closest('main')) return null;
        const cs = getComputedStyle(el);
        let visible =
          (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) ||
          /\b3px\b/.test(cs.boxShadow);
        if (
          !visible &&
          el instanceof HTMLInputElement &&
          (el.type === 'checkbox' || el.type === 'radio')
        ) {
          const vis = (el.parentElement?.querySelector('.track') ??
            el.nextElementSibling) as HTMLElement | null;
          if (vis) {
            const v = getComputedStyle(vis);
            visible = v.outlineStyle !== 'none' && parseFloat(v.outlineWidth) > 0;
          }
        }
        const idx = [...document.querySelectorAll('main a[href], main button, main input')]
          .filter(
            (e) =>
              (e as HTMLElement).offsetParent !== null &&
              !(e as HTMLInputElement).disabled &&
              !((e as HTMLInputElement).type === 'radio' && !(e as HTMLInputElement).checked),
          )
          .indexOf(el);
        return {
          idx,
          visible,
          name: `${el.tagName} ${(el.textContent || el.id).trim().slice(0, 20)}`,
        };
      });
      if (info) {
        seen.add(String(info.idx));
        if (!info.visible) unfocusable.push(info.name);
      }
    }
    expect(seen.size).toBe(total as number);
    expect(unfocusable).toEqual([]);
  });

  it('a focused control is never hidden behind the top bar or the bottom bar', async () => {
    const { page } = await newPage({ width: 360, height: 560 });
    await page.goto(`${base}/`);
    await page.getByLabel('Passphrase').fill(PASS);
    await page.getByRole('button', { name: 'Log in' }).click();
    for (const route of ['sources', 'settings']) {
      await page.goto(`${base}/#/${route}`);
      await waitPage(page, route === 'sources' ? 'Polito portal' : 'General');
      await settle(page);
      await page.locator('main').focus();
      const hidden: string[] = [];
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        await page.waitForTimeout(60);
        const r = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || !el.closest('main')) return null;
          const target = el.matches('input[type=checkbox], input[type=radio]')
            ? (el.closest('label') ?? el)
            : el;
          const b = target.getBoundingClientRect();
          const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          const ok = !!top && (target.contains(top) || top.contains(target));
          return ok
            ? null
            : `${el.tagName} ${(el.id || el.textContent || '').trim().slice(0, 20)} at y=${Math.round(b.top)}`;
        });
        if (r) hidden.push(r);
      }
      expect(hidden, route).toEqual([]);
    }
  });

  it('follows the size class for navigation and turns motion off on request', async () => {
    const { page } = await newPage({ width: 1280, height: 800 });
    await page.goto(`${base}/`);
    await page.getByLabel('Passphrase').fill(PASS);
    await page.getByRole('button', { name: 'Log in' }).click();
    await waitPage(page, 'Last sync');
    // resizing the window changes the navigation without a reload
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    expect(await layoutProblems(page, 390)).toEqual([]);
    await page.setViewportSize({ width: 700, height: 900 });
    expect(await layoutProblems(page, 700)).toEqual([]);

    const dur = () =>
      page.evaluate(() => {
        const b = document.querySelector('.btn') as HTMLElement;
        const pill = document.querySelector('.nav-item .icon-pill') as HTMLElement;
        const toS = (v: string) =>
          Math.max(
            ...v
              .split(',')
              .map((x) => (x.trim().endsWith('ms') ? parseFloat(x) / 1000 : parseFloat(x))),
          );
        return {
          btn: toS(getComputedStyle(b).transitionDuration),
          pill: toS(getComputedStyle(pill).transitionDuration),
          fab: toS(
            getComputedStyle(document.querySelector('.fab') as HTMLElement).animationDuration,
          ),
        };
      });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const normal = await dur();
    expect(normal.btn).toBeGreaterThan(0.1);
    expect(normal.fab).toBeGreaterThan(0.1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await dur();
    expect(reduced.btn).toBeLessThan(0.001);
    expect(reduced.pill).toBeLessThan(0.001);
    expect(reduced.fab).toBeLessThan(0.001);
    // information is not carried by motion: the loading state has words
    await page.goto(`${base}/#/preview`);
    expect(await page.locator('.loading').count()).toBeLessThanOrEqual(1);
  });

  it('theme: automatic follows the system, a manual choice wins and is remembered', async () => {
    const { page } = await newPage({ width: 1280, height: 800, colorScheme: 'light' });
    await page.goto(`${base}/`);
    await page.getByLabel('Passphrase').fill(PASS);
    await page.getByRole('button', { name: 'Log in' }).click();
    await waitPage(page, 'Last sync');
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const rgb = (hex: string) =>
      `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    expect(await bg()).toBe(rgb(scheme(false)['surface'] as string));
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await bg()).toBe(rgb(scheme(true)['surface'] as string));
    await page.goto(`${base}/#/settings`);
    await waitPage(page, 'Appearance');
    await page.getByLabel('Light').check({ force: true });
    expect(await bg()).toBe(rgb(scheme(false)['surface'] as string));
    await page.reload();
    await waitPage(page, 'Appearance');
    expect(await bg()).toBe(rgb(scheme(false)['surface'] as string));
    await page.getByLabel('Automatic').check({ force: true });
    expect(await bg()).toBe(rgb(scheme(true)['surface'] as string));
  });

  it('secrets are write-only: never in the page, replaceable, clearable', async () => {
    const { page, w } = await newPage({ width: 1280, height: 800 });
    await page.goto(`${base}/#/sources`);
    await page.getByLabel('Passphrase').fill(PASS);
    await page.getByRole('button', { name: 'Log in' }).click();
    await waitPage(page, 'Polito portal');
    expect(await page.content()).not.toContain('fake-password-not-real');
    expect(await page.locator('input[type=password]:visible').count()).toBe(0);
    await page.getByRole('button', { name: 'Replace' }).click();
    const field = page.getByLabel('New password');
    expect(await field.getAttribute('type')).toBe('password');
    expect(await field.getAttribute('autocomplete')).toBe('off');
    await field.fill('another-fake-password');
    await page.getByRole('button', { name: 'Save' }).first().click();
    await page.locator('.snackbar').getByText('Saved').waitFor();
    expect(new SettingsStore(h.dataDir).read()['polito.password']).toBe('another-fake-password');
    expect(await page.content()).not.toContain('another-fake-password');
    await page.getByRole('button', { name: 'Clear' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Clear' }).click();
    await page.locator('.snackbar').getByText('Password cleared').waitFor();
    expect(new SettingsStore(h.dataDir).read()['polito.password']).toBeUndefined();
    expect(w.problems).toEqual([]);
    new SettingsStore(h.dataDir).apply(
      { set: { 'polito.password': 'fake-password-not-real' } }, // secret-scan:ignore
      {},
    );
  });

  it('shows hostile text as text: stored XSS in a username and in an event title', async () => {
    const { page, w } = await newPage({ width: 1280, height: 800 });
    new SettingsStore(h.dataDir).apply(
      { set: { 'polito.username': '"><img src=x onerror="window.__xss=2">' } },
      {},
    );
    await page.goto(`${base}/#/sources`);
    await page.getByLabel('Passphrase').fill(PASS);
    await page.getByRole('button', { name: 'Log in' }).click();
    await waitPage(page, 'Polito portal');
    expect(await page.getByLabel('Student ID (username)').inputValue()).toBe(
      '"><img src=x onerror="window.__xss=2">',
    );
    expect(await page.locator('main img').count()).toBe(0);

    await page.goto(`${base}/#/preview`);
    await page.getByRole('button', { name: 'Preview now' }).click();
    await waitPage(page, 'To add (2)');
    const shown = await page.locator('main .list-item .t-label').allTextContents();
    expect(shown).toContain(XSS_TITLE);
    // the enabled Polito source was attempted only through the offline fake
    expect(world.portalAttempts.length).toBeGreaterThan(0);
    expect(world.portalAttempts.every((u) => u.startsWith('https://'))).toBe(true);
    expect(await page.locator('main img').count()).toBe(0);
    expect(await page.locator('main [onerror]').count()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
    expect(await axeProblems(page)).toEqual([]);
    expect(await layoutProblems(page, 1280)).toEqual([]);
    expect(w.problems).toEqual([]);
    new SettingsStore(h.dataDir).apply({ set: { 'polito.username': 's000000' } }, {});
  });

  it('preview page: the second click inside 15 minutes explains the limit (rate limit on)', async () => {
    const limited = previewWorld();
    const h2 = await startHarness({ env: { TZ: 'Europe/Rome' }, app: { runDeps: limited.deps } });
    try {
      new SettingsStore(h2.dataDir).apply({ set: { icsUrls: [FEED] } }, {});
      const { page } = await newPage({ width: 390, height: 844 });
      const b2 = `http://localhost:${h2.port}`;
      await page.goto(`${b2}/`);
      await page.getByLabel('Passphrase', { exact: true }).fill(PASS);
      await page.getByLabel('Type it again').fill(PASS);
      await page.getByRole('button', { name: 'Set passphrase' }).click();
      await page.goto(`${b2}/#/preview`);
      await page.getByRole('button', { name: 'Preview now' }).click();
      await waitPage(page, 'To add (1)');
      await page.getByRole('button', { name: 'Preview now' }).click();
      await waitPage(page, 'less than 15 minutes ago');
      await waitPage(page, 'To add (1)'); // the last result stays on the page
      expect(limited.fetched.length).toBe(1);
    } finally {
      await h2.close();
    }
  });

  it('a setting held by an environment variable is read-only and says which one', async () => {
    const h3 = await startHarness({ env: { POLITO_USERNAME: 'sENV123', TZ: 'Europe/Rome' } });
    try {
      const { page } = await newPage({ width: 1280, height: 800 });
      const b3 = `http://localhost:${h3.port}`;
      await page.goto(`${b3}/`);
      await page.getByLabel('Passphrase', { exact: true }).fill(PASS);
      await page.getByLabel('Type it again').fill(PASS);
      await page.getByRole('button', { name: 'Set passphrase' }).click();
      await page.goto(`${b3}/#/sources`);
      await waitPage(page, 'Polito portal');
      const input = page.getByLabel('Student ID (username)');
      expect(await input.isDisabled()).toBe(true);
      expect(await input.inputValue()).toBe('sENV123');
      await page.getByText('POLITO_USERNAME').first().waitFor();
    } finally {
      await h3.close();
    }
  });

  it('squads are picked with checkboxes from the ones the preview saw', async () => {
    const data = JSON.parse(
      readFileSync(new URL('./fixtures/polito-portal/student-data.json', import.meta.url), 'utf8'),
    ) as { data: { orari: { data: { lezioni: Record<string, unknown>[] } } } };
    const lessons = data.data.orari.data.lezioni;
    lessons[0] = { ...lessons[0], description: 'SQUADRA A' };
    lessons[1] = { ...lessons[1], id: 9002, description: 'SQUADRA B' };
    const w2 = previewWorld();
    const portal = portalWorld({ data });
    w2.deps.politoPortal = opts(portal.fetchImpl);
    const h4 = await startHarness({
      env: { TZ: 'Europe/Rome' },
      app: { runDeps: w2.deps, previewMinIntervalMs: 0 },
    });
    try {
      new SettingsStore(h4.dataDir).apply(
        {
          set: {
            'polito.enabled': true,
            'polito.username': USER,
            'polito.password': PORTAL_PASS, // secret-scan:ignore
          },
        },
        {},
      );
      const { page, w } = await newPage({ width: 390, height: 844 });
      const b4 = `http://localhost:${h4.port}`;
      await page.goto(`${b4}/`);
      await page.getByLabel('Passphrase', { exact: true }).fill(PASS);
      await page.getByLabel('Type it again').fill(PASS);
      await page.getByRole('button', { name: 'Set passphrase' }).click();
      await page.goto(`${b4}/#/sources`);
      await waitPage(page, 'Run a preview'); // no preview yet: no checkboxes, a way to get them
      await page.goto(`${b4}/#/preview`);
      await page.getByRole('button', { name: 'Preview now' }).click();
      await waitPage(page, 'To add');
      await page.goto(`${b4}/#/sources`);
      await waitPage(page, 'Squad A');
      expect(await page.getByRole('checkbox', { name: 'Squad A' }).isChecked()).toBe(false);
      expect(await page.getByRole('checkbox', { name: 'Squad B' }).isChecked()).toBe(false);
      expect(await layoutProblems(page, 390)).toEqual([]);
      expect(await axeProblems(page)).toEqual([]);
      await page.getByRole('checkbox', { name: 'Squad B' }).check();
      await page.getByRole('button', { name: 'Save' }).first().click();
      await page.locator('.snackbar').getByText('Saved').waitFor();
      expect(new SettingsStore(h4.dataDir).read()['polito.squads']).toEqual({ '5002': ['B'] });
      // after saving, the choice is shown ticked; unticking everything keeps all squads again
      await waitPage(page, 'Squad B');
      expect(await page.getByRole('checkbox', { name: 'Squad B' }).isChecked()).toBe(true);
      await page.getByRole('checkbox', { name: 'Squad B' }).uncheck();
      await page.getByRole('button', { name: 'Save' }).first().click();
      await page.locator('.snackbar').getByText('Saved').waitFor();
      expect(new SettingsStore(h4.dataDir).read()['polito.squads']).toBeUndefined();
      expect(w.problems).toEqual([]);
    } finally {
      await h4.close();
    }
  });

  it('Google: save the client, connect through the (fake) sign-in, create or pick the calendar', async () => {
    const flow = fakeFlow();
    const calendars = new FakeCalendars();
    calendars.add({ id: 'me@example.invalid', summary: 'me@example.invalid', primary: true });
    calendars.add({ id: 'work', summary: XSS_TITLE });
    calendars.add({ id: 'ro', summary: 'Read only', accessRole: 'reader' });
    const h5 = await startHarness({
      env: { TZ: 'Europe/Rome' },
      app: { google: { flowClient: flow.client, calendars } },
    });
    try {
      const { page, w } = await newPage({ width: 390, height: 844 });
      const b5 = `http://localhost:${h5.port}`;
      await page.goto(`${b5}/`);
      await page.getByLabel('Passphrase', { exact: true }).fill(PASS);
      await page.getByLabel('Type it again').fill(PASS);
      await page.getByRole('button', { name: 'Set passphrase' }).click();
      await page.goto(`${b5}/#/settings`);
      await waitPage(page, 'Google client missing');
      expect(await page.getByRole('button', { name: 'Connect Google' }).isDisabled()).toBe(true);

      // Save the client (id + secret), then the connect button works.
      await page.getByLabel('Google client id').fill('fake-client-id');
      await page.getByRole('button', { name: 'Set', exact: true }).click();
      await page.getByLabel('New google client secret').fill('fake-client-secret-not-real'); // secret-scan:ignore
      await page.getByRole('button', { name: 'Save' }).nth(1).click();
      await page.locator('.snackbar').getByText('Saved').waitFor();
      await waitPage(page, 'Not connected');
      await settle(page);
      expect(await layoutProblems(page, 390)).toEqual([]);
      expect(await axeProblems(page)).toEqual([]);

      await page.getByRole('button', { name: 'Connect Google' }).click();

      await waitPage(page, 'Waiting for you to sign in with Google');
      const link = page.getByRole('link', { name: 'Open the Google sign-in' });
      expect(await link.getAttribute('href')).toContain('https://accounts.example.invalid/auth');
      expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
      await settle(page);
      expect(await layoutProblems(page, 390)).toEqual([]);
      expect(await axeProblems(page)).toEqual([]);

      // The "browser" comes back from Google; the page notices by itself.
      await fetch(`${flow.seen.redirect}?state=${flow.seen.state}&code=the-code`);
      await waitPage(page, 'Connected');
      await waitPage(page, 'me@example.invalid');
      await settle(page);
      expect(await layoutProblems(page, 390)).toEqual([]);
      expect(await axeProblems(page)).toEqual([]);

      // Pick an existing calendar: the hostile name is text, the main and read-only calendars are not offered.
      await page.getByRole('button', { name: 'Pick one of my calendars' }).click();
      await page.getByRole('radio', { name: XSS_TITLE }).waitFor();
      expect(await page.locator('main img').count()).toBe(0);
      expect(await page.locator('input[name=cal]').count()).toBe(1);
      expect(
        await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
      ).toBeUndefined();
      await settle(page);
      expect(await layoutProblems(page, 390)).toEqual([]);
      expect(await axeProblems(page)).toEqual([]);
      await page.emulateMedia({ colorScheme: 'dark' });
      await settle(page);
      expect(await axeProblems(page)).toEqual([]);
      await page.emulateMedia({ colorScheme: 'light' });
      await page.getByRole('radio', { name: XSS_TITLE }).check();
      await page.getByRole('button', { name: 'Use the selected calendar' }).click();
      await page.locator('.snackbar').getByText('Calendar chosen').waitFor();
      expect(await page.locator('main dd', { hasText: XSS_TITLE }).count()).toBe(1);

      // Or create the dedicated one.
      await page.getByRole('button', { name: 'Create the dedicated calendar' }).click();
      await page.locator('.snackbar').getByText('Calendar ready').waitFor();
      await page.locator('main dd', { hasText: 'Polito (polito-cal-sync)' }).waitFor();

      // Overview shows the three Google steps as done.
      await page.goto(`${b5}/#/overview`);
      await waitPage(page, 'Dedicated calendar chosen');
      expect(
        await page
          .locator('.list-item', { hasText: 'Google account connected' })
          .getByText('Done')
          .count(),
      ).toBe(1);
      expect(
        await page
          .locator('.list-item', { hasText: 'Dedicated calendar chosen' })
          .getByText('Done')
          .count(),
      ).toBe(1);
      expect(w.problems).toEqual([]);
    } finally {
      await h5.close();
    }
  });
});
