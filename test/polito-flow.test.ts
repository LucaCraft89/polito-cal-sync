import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliDeps, type CliIo } from '../src/cli/index.js';
import { MemoryEventsApi } from '../src/google/memory.js';

// Invented feed; the point is the interaction between the ICS source and the (disabled / not ready) Polito API source.
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
  'CATEGORIES:2026_ABC_1',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'pcs-polito-'));
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

describe('Polito API source inside a real run', () => {
  it('is off by default: nothing about it appears', async () => {
    const h = harness();
    const r = await h.run(['sync']);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('polito');
    expect(live(h.api)).toHaveLength(1);
  });

  it('enabled but not able to log in: says so with its code, ICS still syncs, exit code 2 (incomplete)', async () => {
    const h = harness();
    const r = await h.run(['sync'], { SOURCE_POLITO_API_ENABLED: 'true' });
    expect(r.code).toBe(2);
    expect(r.err).toContain('E_POLITO_API_NOT_READY');
    expect(r.out).toContain('INCOMPLETE');
    expect(live(h.api)).toHaveLength(1);
  });

  it('never deletes ICS events or earlier Polito events while it is incomplete', async () => {
    const h = harness();
    await h.run(['sync']);
    const before = live(h.api).length;
    // An event the Polito source wrote in an earlier life: it must survive an incomplete run.
    const { toGoogleEvent } = await import('../src/sync/mapper.js');
    const { toCanonical } = await import('../src/sync/mapper.js');
    const old = toGoogleEvent(
      toCanonical({
        source: 'polito',
        sourceId: 'lecture:1',
        kind: 'lecture',
        title: 'Old',
        start: '2026-11-20T09:00:00Z',
      }),
      'Europe/Rome',
    );
    h.api.seed(CAL, old as typeof old & { id: string });
    const r = await h.run(['sync'], { SOURCE_POLITO_API_ENABLED: 'true' });
    expect(r.code).toBe(2);
    expect(live(h.api)).toHaveLength(before + 1);
  });

  it('works with the Polito API alone (no ICS URLs) and reports not ready instead of "nothing to sync"', async () => {
    const h = harness();
    const r = await h.run(['sync'], {
      SOURCE_POLITO_ICS_URLS: '',
      SOURCE_POLITO_API_ENABLED: 'true',
    });
    expect(r.err).toContain('E_POLITO_API_NOT_READY');
    expect(r.err).not.toContain('E_NOT_CONFIGURED');
  });

  it('rejects a bad value for the switch naming the variable, not the value', async () => {
    const h = harness();
    const r = await h.run(['sync'], { SOURCE_POLITO_API_ENABLED: 'maybe' });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('E_CONFIG_INVALID');
    expect(r.err).toContain('SOURCE_POLITO_API_ENABLED');
    expect(r.err).not.toContain('maybe');
  });
});
