/* eslint-disable @typescript-eslint/no-unsafe-member-access -- test code reads loose JSON answers */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { LoginLatch } from '../src/sources/polito/portal/latch.js';
import { StateStore } from '../src/sync/state.js';
import { startHarness, type Harness } from './support/web.js';
import { previewWorld } from './support/preview-world.js';
import { opts, PASS, USER, world as portalWorld } from './support/portal-world.js';

const DATA = JSON.parse(
  readFileSync(new URL('./fixtures/polito-portal/student-data.json', import.meta.url), 'utf8'),
) as unknown;
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function setup(env: NodeJS.ProcessEnv = {}) {
  const world = previewWorld();
  const portal = portalWorld({ data: DATA });
  world.deps.politoPortal = opts(portal.fetchImpl);
  h = await startHarness({
    env: { TZ: 'Europe/Rome', ...env },
    app: { runDeps: world.deps, previewMinIntervalMs: 0 },
  });
  const auth = await h.setup();
  const get = (p: string) => h!.call('GET', p, { cookie: auth.cookie });
  const post = (p: string, body: unknown = {}) =>
    h!.call('POST', p, { body, cookie: auth.cookie, headers: { 'X-CSRF-Token': auth.csrf } });
  await h.put('/api/settings', auth, {
    set: { 'polito.enabled': true, 'polito.username': USER, 'polito.password': PASS },
  });
  return { get, post, portal, auth };
}

describe('Courses', () => {
  it('needs a session; empty before the portal was read', async () => {
    const s = await setup();
    expect((await h!.call('GET', '/api/courses')).status).toBe(401);
    expect((await s.get('/api/courses')).json).toEqual({ courses: [] });
  });

  it('after a preview lists the courses and survives without another login; chosen squads follow the settings', async () => {
    const s = await setup();
    expect((await s.post('/api/preview')).status).toBe(200);
    const r = await s.get('/api/courses');
    expect(r.json.updatedAt).toBeTypeOf('string');
    expect((r.json.courses as { name: string }[]).map((c) => c.name)).toEqual([
      'Invented Analysis',
      'Invented Physics',
    ]);
    const requests = s.portal.log.length;
    await h!.put('/api/settings', s.auth, { set: { 'polito.squads': { '5001': ['A'] } } });
    const again = await s.get('/api/courses');
    expect(again.json.courses[0].chosen).toEqual(['A']);
    expect(s.portal.log).toHaveLength(requests); // read from the saved list, no login
    // Titles, rooms and the password are not in the saved list.
    const raw = readFileSync(`${h!.dataDir}/courses.json`, 'utf8');
    expect(raw).not.toContain('Room 9');
    expect(raw).not.toContain(PASS);
  });
});

describe('History', () => {
  it('is empty at first and needs a session', async () => {
    const s = await setup();
    expect((await h!.call('GET', '/api/history')).status).toBe(401);
    expect((await s.get('/api/history')).json).toEqual({ runs: [] });
  });

  it('lists runs newest first with the three-line form for a stored error code, without changing the database', async () => {
    const s = await setup();
    const db = StateStore.open(StateStore.fileIn(h!.dataDir));
    const a = db.startRun({
      calendarId: 'c',
      forced: false,
      now: new Date('2026-11-05T10:00:00Z'),
    });
    db.finishRun(
      a,
      { status: 'ok', created: 2, patched: 1, deleted: 0, unchanged: 5, failed: 0 },
      new Date('2026-11-05T10:00:05Z'),
    );
    const b = db.startRun({ calendarId: 'c', forced: true, now: new Date('2026-11-05T11:00:00Z') });
    db.finishRun(
      b,
      {
        status: 'partial',
        created: 0,
        patched: 0,
        deleted: 4,
        unchanged: 1,
        failed: 2,
        errorCode: 'E_DELETE_THRESHOLD',
        details: {
          failures: [{ code: 'E_GOOGLE_QUOTA' }, { code: 'E_GOOGLE_QUOTA' }],
          incompleteSources: ['polito'],
        },
      },
      new Date('2026-11-05T11:00:05Z'),
    );
    db.startRun({ calendarId: 'c', forced: false, now: new Date('2026-11-05T12:00:00Z') }); // still running
    db.close();
    const r = await s.get('/api/history');
    const runs = r.json.runs as {
      id: number;
      status: string;
      forced: boolean;
      error?: { code: string; what: string; docs: string };
      failures: unknown[];
      incompleteSources: string[];
    }[];
    expect(runs.map((x) => x.status)).toEqual(['running', 'partial', 'ok']); // the open run was NOT marked failed
    expect(runs[1]).toMatchObject({
      forced: true,
      incompleteSources: ['polito'],
      failures: [{ code: 'E_GOOGLE_QUOTA', count: 2 }],
    });
    expect(runs[1]?.error?.code).toBe('E_DELETE_THRESHOLD');
    expect(runs[1]?.error?.what).toContain('too many events');
    expect(runs[1]?.error?.docs).toBe('docs/ERRORS.md#e_delete_threshold');
    expect(runs[2]?.error).toBeUndefined();
    expect((await s.get('/api/history?limit=1')).json.runs).toHaveLength(1);
  });

  it('shows the paused login and "I fixed the credentials" ends it for the current credentials only', async () => {
    const s = await setup();
    expect((await s.get('/api/history')).json.loginPaused).toBeUndefined();
    expect((await s.post('/api/sources/polito/resume')).json).toEqual({ resumed: false });
    new LoginLatch(h!.dataDir).block(USER, PASS, new Date('2026-11-05T09:00:00Z'));
    expect((await s.get('/api/history')).json.loginPaused).toEqual({
      since: '2026-11-05T09:00:00.000Z',
    });
    expect(
      (await h!.call('POST', '/api/sources/polito/resume', { body: {}, cookie: s.auth.cookie }))
        .status,
    ).toBe(403); // CSRF
    expect(() => new LoginLatch(h!.dataDir).assertOpen(USER, PASS)).toThrow();
    expect((await s.post('/api/sources/polito/resume')).json).toEqual({ resumed: true });
    expect(() => new LoginLatch(h!.dataDir).assertOpen(USER, PASS)).not.toThrow();
    expect((await s.get('/api/history')).json.loginPaused).toBeUndefined();
    // A pause for other credentials is not shown and not touched.
    new LoginLatch(h!.dataDir).block(USER, 'other-password-1', new Date());
    expect((await s.get('/api/history')).json.loginPaused).toBeUndefined();
    expect((await s.post('/api/sources/polito/resume')).json).toEqual({ resumed: false });
    const audit = (await s.get('/api/audit')).json.entries as { action: string }[];
    expect(audit.filter((e) => e.action === 'polito.login.resumed')).toHaveLength(1);
  });

  it('a refused login in a preview shows up as paused', async () => {
    const s = await setup();
    await h!.put('/api/settings', s.auth, { set: { 'polito.password': 'wrong-password-123' } }); // secret-scan:ignore
    await s.post('/api/preview');
    expect((await s.get('/api/history')).json.loginPaused?.since).toBeTypeOf('string');
  });
});
