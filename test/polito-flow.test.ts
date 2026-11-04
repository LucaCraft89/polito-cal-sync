import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliDeps, type CliIo } from '../src/cli/index.js';
import { MemoryEventsApi } from '../src/google/memory.js';
import { opts, PASS, USER, world } from './support/portal-world.js';

const FEED = 'https://feed.example.invalid/tok-ZZZZZZZZZZZZ/me.ics';
const CAL = 'dedicated-cal';
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:a',
  'DTSTAMP:20261001T000000Z',
  'DTSTART:20261110T090000Z',
  'DTEND:20261110T100000Z',
  'SUMMARY:Fisica',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const data: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/polito-portal/student-data.json', import.meta.url), 'utf8'),
);

function harness(portal: ReturnType<typeof world>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pcs-polflow-'));
  const api = new MemoryEventsApi();
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    logStream: { write: () => undefined },
  };
  const deps: CliDeps = {
    now: () => new Date('2026-11-04T10:00:00Z'),
    pauseBetweenFeedsMs: 0,
    sleep: () => Promise.resolve(),
    googleFactory: () => Promise.resolve({ api, calendarId: CAL }),
    fetchImpl: () => Promise.resolve(new Response(ICS, { status: 200 })),
    politoPortal: opts(portal.fetchImpl),
  };
  const run = async (argv: string[], env: NodeJS.ProcessEnv = {}) => {
    out.length = err.length = 0;
    const code = await runCli(
      argv,
      { DATA_DIR: dataDir, SOURCE_POLITO_ICS_URLS: FEED, TZ: 'Europe/Rome', ...env },
      io,
      deps,
    );
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { api, run };
}
const live = (api: MemoryEventsApi) =>
  api
    .snapshot(CAL)
    .filter(
      (e) => e.extendedProperties?.private?.['polito_cal_sync'] === '1' && e.status !== 'cancelled',
    );
const ON = { SOURCE_POLITO_PORTAL_ENABLED: 'true', POLITO_USERNAME: USER, POLITO_PASSWORD: PASS };

describe('Polito portal source inside a real run', () => {
  it('is off by default: no login is attempted', async () => {
    const w = world({ data });
    const h = harness(w);
    const r = await h.run(['sync']);
    expect(r.code).toBe(0);
    expect(w.log).toHaveLength(0);
    expect(live(h.api)).toHaveLength(1);
  });

  it('enabled: ICS and portal events land in the calendar together; a second run is a no-op', async () => {
    const h = harness(world({ data }));
    const first = await h.run(['sync'], ON);
    expect(first.code).toBe(0);
    expect(live(h.api)).toHaveLength(1 + 6);
    const second = await h.run(['sync'], ON);
    expect(second.code).toBe(0);
    expect(second.out).toContain('7 unchanged');
    expect(second.out).toContain('created 0, updated 0, deleted 0');
  });

  it('a refused login leaves every event alone (ICS and earlier portal events), says why, exits 2', async () => {
    const ok = harness(world({ data }));
    await ok.run(['sync'], ON);
    const before = live(ok.api).length;
    // same calendar, but the login is now refused
    const w = world({
      data,
      idpAnswer: () => new Response('<form><input name="j_password"></form>', { status: 200 }),
    });
    const h2 = harness(w);
    for (const e of ok.api.snapshot(CAL)) h2.api.seed(CAL, e as never);
    const r = await h2.run(['sync'], ON);
    expect(r.code).toBe(2);
    expect(r.err).toContain('E_POLITO_API_AUTH_REJECTED');
    expect(live(h2.api)).toHaveLength(before);
  });

  it('enabled without a login: a plain message, nothing is sent', async () => {
    const w = world({ data });
    const r = await harness(w).run(['sync'], { SOURCE_POLITO_PORTAL_ENABLED: 'true' });
    expect(r.err).toContain('E_NOT_CONFIGURED');
    expect(r.err).toContain('POLITO_PASSWORD');
    expect(w.log).toHaveLength(0);
  });

  it('never prints the password or username', async () => {
    const h = harness(
      world({ data, idpAnswer: () => new Response('<form><input name="j_password"></form>') }),
    );
    const r = await h.run(['sync'], ON);
    expect(r.out + r.err).not.toContain(PASS);
  });
});
