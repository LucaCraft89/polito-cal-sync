/* eslint-disable @typescript-eslint/no-unsafe-member-access -- test code reads loose JSON answers */
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Heartbeat } from '../src/serve/heartbeat.js';
import type { ServiceControl } from '../src/web/app.js';
import { startHarness, type Harness } from './support/web.js';
import { FEED, previewWorld } from './support/preview-world.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** Opens /api/events and collects what arrives. */
function openStream(port: number, headers: Record<string, string> = {}) {
  const lines: string[] = [];
  let status = 0;
  let ended = false;
  let headersSeen: Record<string, string | string[] | undefined> = {};
  const req = request(
    {
      host: '127.0.0.1',
      port,
      path: '/api/events',
      headers: { Host: `localhost:${port}`, ...headers },
    },
    (res) => {
      status = res.statusCode ?? 0;
      headersSeen = res.headers;
      res.setEncoding('utf8');
      res.on('data', (d: string) => lines.push(...d.split('\n').filter(Boolean)));
      res.on('end', () => (ended = true));
      res.on('close', () => (ended = true));
    },
  );
  req.on('error', () => (ended = true));
  req.end();
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!ok()) throw new Error(`timed out; got ${JSON.stringify(lines)}`);
  };
  return {
    lines,
    get status() {
      return status;
    },
    get ended() {
      return ended;
    },
    get headers() {
      return headersSeen;
    },
    until,
    close: () => req.destroy(),
  };
}
const topics = (s: { lines: string[] }) =>
  s.lines
    .filter((l) => l.startsWith('data: {"topic"'))
    .map((l) => (JSON.parse(l.slice(6)) as { topic: string }).topic);

function fakeService(o: Partial<Heartbeat> = {}) {
  let hb: Heartbeat = {
    version: '0',
    pid: 1,
    startedAt: '2026-11-06T08:00:00.000Z',
    intervalMinutes: 120,
    autoSync: true,
    ...o,
  };
  const cbs: (() => void)[] = [];
  let changed = 0;
  const control: ServiceControl = {
    snapshot: () => hb,
    settingsChanged: () => void changed++,
    onChange: (cb) => void cbs.push(cb),
  };
  return {
    control,
    set: (next: Partial<Heartbeat>) => {
      hb = { ...hb, ...next };
      cbs.forEach((c) => c());
    },
    get changed() {
      return changed;
    },
  };
}

async function setup(app: Parameters<typeof startHarness>[0] = {}) {
  await h?.close();
  h = await startHarness({ env: { TZ: 'Europe/Rome' }, ...app });
  const auth = await h.setup();
  const post = (p: string, body: unknown = {}) =>
    h!.call('POST', p, { body, cookie: auth.cookie, headers: { 'X-CSRF-Token': auth.csrf } });
  const get = (p: string, headers: Record<string, string> = {}) =>
    h!.call('GET', p, { cookie: auth.cookie, headers });
  return { auth, post, get };
}

describe('live updates (server-sent events)', () => {
  it('needs a session, a local Host and GET', async () => {
    await setup();
    const none = openStream(h!.port);
    await none.until(() => none.ended);
    expect(none.status).toBe(401);
    const s = await setup();
    const foreign = openStream(h!.port, { Cookie: s.auth.cookie, Host: 'evil.example' });
    await foreign.until(() => foreign.ended);
    expect(foreign.status).toBe(421);
  });

  it('sends hello with the security headers, then only "topic changed" messages for each kind of change', async () => {
    const world = previewWorld();
    const s = await setup({ app: { runDeps: world.deps, previewMinIntervalMs: 0 } });
    const stream = openStream(h!.port, { Cookie: s.auth.cookie });
    await stream.until(() => stream.lines.includes('event: hello'));
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.headers['cache-control']).toBe('no-store');
    expect(String(stream.headers['content-security-policy'])).toContain("default-src 'none'");
    await h!.put('/api/settings', s.auth, { set: { icsUrls: [FEED] } });
    await stream.until(() => topics(stream).includes('settings'));
    await s.post('/api/preview');
    await stream.until(() => topics(stream).includes('preview'));
    // Nothing but topic names travels on the stream: no titles, no addresses, no tokens.
    const all = stream.lines.join('\n');
    expect(all).not.toContain('Fisica');
    expect(all).not.toContain('feed.example');
    expect(all).not.toContain(s.auth.csrf);
    stream.close();
  });

  it('a sync started from the page and the Google sign-in are announced too', async () => {
    const world = previewWorld();
    const s = await setup({ app: { runDeps: world.deps, previewMinIntervalMs: 0 } });
    await h!.put('/api/settings', s.auth, { set: { icsUrls: [FEED] } });
    const p = (await s.post('/api/preview')).json.preview as { generatedAt: string };
    const stream = openStream(h!.port, { Cookie: s.auth.cookie });
    await stream.until(() => stream.lines.includes('event: hello'));
    await s.post('/api/sync', { previewAt: p.generatedAt, confirm: true });
    await stream.until(() => topics(stream).filter((t) => t === 'sync').length >= 2); // started and finished
    stream.close();
  });

  it('ends when the session ends, and never keeps an idle session alive', async () => {
    const s = await setup({ app: { streamBeatMs: 20 } });
    const stream = openStream(h!.port, { Cookie: s.auth.cookie });
    await stream.until(() => stream.lines.includes('event: hello'));
    await stream.until(() => stream.lines.includes(': ping'));
    h!.clock.t += 31 * 60_000; // idle for longer than 30 minutes: only pings happened, nothing refreshed it
    await stream.until(() => stream.lines.includes('event: bye'));
    await stream.until(() => stream.ended);

    const s2 = await setup({ app: { streamBeatMs: 20 } });
    const stream2 = openStream(h!.port, { Cookie: s2.auth.cookie });
    await stream2.until(() => stream2.lines.includes('event: hello'));
    await s2.post('/api/logout');
    await stream2.until(() => stream2.lines.includes('event: bye'));
  });

  it('a background refresh does not refresh the idle timer; a normal request does', async () => {
    const s = await setup();
    h!.clock.t += 20 * 60_000;
    expect((await s.get('/api/service', { 'X-Pcs-Background': '1' })).status).toBe(200);
    h!.clock.t += 20 * 60_000; // 40 minutes since the last real request
    expect((await s.get('/api/service', { 'X-Pcs-Background': '1' })).status).toBe(401);
    const s2 = await setup();
    h!.clock.t += 20 * 60_000;
    expect((await s2.get('/api/service')).status).toBe(200); // a normal request refreshes it
    h!.clock.t += 20 * 60_000;
    expect((await s2.get('/api/service')).status).toBe(200);
  });

  it('at most 20 streams at once', async () => {
    const s = await setup();
    const open = Array.from({ length: 20 }, () => openStream(h!.port, { Cookie: s.auth.cookie }));
    await Promise.all(open.map((o) => o.until(() => o.lines.includes('event: hello'))));
    const extra = openStream(h!.port, { Cookie: s.auth.cookie });
    await extra.until(() => extra.ended);
    expect(extra.status).toBe(403);
    for (const o of open) o.close();
  });
});

describe('Service: status and settings', () => {
  it('needs a session; says "not available" without the scheduled loop', async () => {
    const s = await setup();
    expect((await h!.call('GET', '/api/service')).status).toBe(401);
    expect((await s.get('/api/service')).json).toEqual({ available: false });
  });

  it('shows the loop: on/off, interval, last run, next run, the error in the three-line form, the limit', async () => {
    const svc = fakeService({
      lastRunAt: '2026-11-06T09:00:00.000Z',
      lastOkAt: '2026-11-06T09:00:00.000Z',
      lastStatus: 'ok',
      nextRunAt: '2026-11-06T11:00:00.000Z',
      lastCounts: { created: 1, patched: 0, deleted: 0, unchanged: 4, failed: 0 },
    });
    const s = await setup({
      app: { service: svc.control, now: () => Date.parse('2026-11-06T09:30:00Z') },
    });
    const r = await s.get('/api/service');
    expect(r.json).toMatchObject({
      available: true,
      autoSync: true,
      intervalMinutes: 120,
      running: false,
      healthy: true,
      lastStatus: 'ok',
      nextRunAt: '2026-11-06T11:00:00.000Z',
      deleteThreshold: 0.3,
    });
    expect(r.json.error).toBeUndefined();
    svc.set({ lastErrorCode: 'E_GOOGLE_AUTH_EXPIRED', autoSync: false, running: true });
    const r2 = await s.get('/api/service');
    expect(r2.json).toMatchObject({ autoSync: false, running: true, healthy: true });
    expect(r2.json.error).toMatchObject({
      code: 'E_GOOGLE_AUTH_EXPIRED',
      docs: 'docs/ERRORS.md#e_google_auth_expired',
    });
    expect(r2.json.error.what.length).toBeGreaterThan(10);
  });

  it('saving the interval or the switch tells the loop at once, and is announced; env locks it', async () => {
    const svc = fakeService();
    const s = await setup({ app: { service: svc.control } });
    const stream = openStream(h!.port, { Cookie: s.auth.cookie });
    await stream.until(() => stream.lines.includes('event: hello'));
    const r = await h!.put('/api/settings', s.auth, {
      set: { syncAuto: false, syncIntervalMinutes: 360 },
    });
    expect(r.status).toBe(200);
    expect([...(r.json.changed as string[])].sort()).toEqual(['syncAuto', 'syncIntervalMinutes']);
    expect(svc.changed).toBe(1);
    await stream.until(() => topics(stream).includes('settings'));
    expect(
      (await h!.put('/api/settings', s.auth, { set: { syncIntervalMinutes: 5 } })).status,
    ).toBe(422); // below the 15 minute minimum
    expect(svc.changed).toBe(1); // a refused change tells nobody
    stream.close();
    await h!.close();
    const locked = await setup({
      env: { SYNC_AUTO: 'false', TZ: 'Europe/Rome' },
      app: { service: svc.control },
    });
    const refusal = await h!.put('/api/settings', locked.auth, { set: { syncAuto: true } });
    expect(refusal.status).toBe(409);
    expect(refusal.json.error.code).toBe('E_SETTING_LOCKED');
  });

  it('a scheduled run that changed the calendar makes the preview outdated; one that changed nothing does not', async () => {
    const svc = fakeService();
    const world = previewWorld();
    const s = await setup({
      app: { service: svc.control, runDeps: world.deps, previewMinIntervalMs: 0 },
    });
    await h!.put('/api/settings', s.auth, { set: { icsUrls: [FEED] } });
    await s.post('/api/preview');
    expect((await s.get('/api/preview')).json.preview).not.toBeNull();
    svc.set({
      lastRunAt: '2026-11-06T09:00:00.000Z',
      lastCounts: { created: 0, patched: 0, deleted: 0, unchanged: 5, failed: 0 },
    });
    expect((await s.get('/api/preview')).json.preview).not.toBeNull();
    svc.set({
      lastRunAt: '2026-11-06T10:00:00.000Z',
      lastCounts: { created: 2, patched: 0, deleted: 0, unchanged: 5, failed: 0 },
    });
    expect((await s.get('/api/preview')).json.preview).toBeNull();
  });
});
