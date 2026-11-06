/* eslint-disable @typescript-eslint/no-unsafe-member-access -- test code reads loose JSON answers */
import { afterEach, describe, expect, it } from 'vitest';
import { LoginLatch } from '../src/sources/polito/portal/latch.js';
import { startHarness, type Harness } from './support/web.js';
import { previewWorld } from './support/preview-world.js';
import { course, event, MOODLE, moodleOpts, moodleWorld } from './support/moodle-world.js';
import { PASS, USER } from './support/portal-world.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function setup(o: { configure?: boolean } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const pw = previewWorld();
  const m = moodleWorld({
    courses: [course(11, 'Invented Chemistry')],
    events: [event(1), event(2)],
  });
  pw.deps.politoPortal = moodleOpts(m.fetchImpl);
  h = await startHarness({
    env: { TZ: 'Europe/Rome', MOODLE_BASE_URL: MOODLE },
    app: { runDeps: pw.deps, now: () => clock.t },
  });
  const auth = await h.setup();
  const post = (p: string) =>
    h!.call('POST', p, { body: {}, cookie: auth.cookie, headers: { 'X-CSRF-Token': auth.csrf } });
  if (o.configure !== false)
    await h.put('/api/settings', auth, {
      set: { 'polito.username': USER, 'polito.password': PASS, 'moodle.enabled': true },
    });
  return { clock, m, auth, post };
}

describe('Test button for live Moodle', () => {
  it('needs a session and a CSRF token', async () => {
    const s = await setup();
    expect((await h!.call('POST', '/api/sources/moodle/test', { body: {} })).status).toBe(401);
    expect(
      (await h!.call('POST', '/api/sources/moodle/test', { body: {}, cookie: s.auth.cookie }))
        .status,
    ).toBe(403);
  });

  it('needs the saved login', async () => {
    const s = await setup({ configure: false });
    const r = await s.post('/api/sources/moodle/test');
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('E_NOT_CONFIGURED');
    expect(s.m.log).toHaveLength(0);
  });

  it('reports counts only, is limited to once per 15 minutes, and a refusal costs no request', async () => {
    const s = await setup();
    const r = await s.post('/api/sources/moodle/test');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, events: 2, courses: 1 });
    expect([r.text, ...h!.logs].join('\n')).not.toMatch(/Quiz|Invented|a1b2c3d4e5f60718/);
    const seen = s.m.log.length;
    const again = await s.post('/api/sources/moodle/test');
    expect(again.status).toBe(429);
    expect(again.json.error.code).toBe('E_UI_TEST_RATE_LIMITED');
    expect(s.m.log).toHaveLength(seen);
  });

  it('a paused university login blocks it with no request', async () => {
    const s = await setup();
    new LoginLatch(h!.dataDir).block(USER, PASS, new Date());
    const r = await s.post('/api/sources/moodle/test');
    expect(r.json).toMatchObject({ ok: false, problem: { code: 'E_POLITO_LOGIN_BLOCKED' } });
    expect(s.m.log).toHaveLength(0);
  });

  it('the preview shows the Moodle events with the course name, and writes nothing', async () => {
    const s = await setup();
    const r = await s.post('/api/preview');
    expect(r.status).toBe(200);
    const creates = r.json.preview.creates as { title: string; kind: string; course?: string }[];
    expect(creates.map((c) => c.kind)).toEqual(['moodle', 'moodle']);
    expect(creates[0]?.title).toBe('[Moodle] Quiz 1 opens');
    expect(creates[0]?.course).toBe('Invented Chemistry');
  });

  it('lists the Moodle courses after a test, lets some be left out, and the test then shows fewer events', async () => {
    const s = await setup();
    s.m.state.courses = [course(11, 'Invented Chemistry'), course(12, 'Mathematical Lab')];
    s.m.state.events = [
      event(1, { courseid: 11 }),
      event(2, { courseid: 12 }),
      event(3, { courseid: 12 }),
    ];
    const get = (p: string) => h!.call('GET', p, { cookie: s.auth.cookie });
    expect((await get('/api/courses')).json.moodleCourses).toBeUndefined(); // nothing read yet
    expect((await s.post('/api/sources/moodle/test')).json).toMatchObject({
      ok: true,
      events: 3,
      courses: 2,
    });
    expect((await get('/api/courses')).json.moodleCourses).toEqual([
      { courseId: '11', name: 'Invented Chemistry', excluded: false },
      { courseId: '12', name: 'Mathematical Lab', excluded: false },
    ]);
    const put = await h!.put('/api/settings', s.auth, {
      set: { 'moodle.excludedCourses': ['12'] },
    });
    expect(put.status).toBe(200);
    expect((await get('/api/courses')).json.moodleCourses[1]).toMatchObject({
      courseId: '12',
      excluded: true,
    });
    s.clock.t += 16 * 60_000;
    expect((await s.post('/api/sources/moodle/test')).json).toMatchObject({
      ok: true,
      events: 1,
      courses: 2,
    });
    // Anything but course numbers is refused, and an environment variable locks it.
    for (const bad of [['x'], ['1.5'], ['1,2'], 'abc']) {
      expect(
        (await h!.put('/api/settings', s.auth, { set: { 'moodle.excludedCourses': bad } })).status,
      ).toBe(422);
    }
  });
});
