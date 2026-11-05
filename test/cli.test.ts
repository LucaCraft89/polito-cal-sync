import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli/index.js';

const M1 = new URL('./fixtures/m1', import.meta.url).pathname;
const M2 = new URL('./fixtures/m2', import.meta.url).pathname;
const WIPE = new URL('./fixtures/m1-wipe', import.meta.url).pathname;

function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const logs: string[] = [];
  const io: CliIo = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    logStream: { write: (s: string) => void logs.push(s) },
  };
  return runCli(argv, env, io).then((code) => ({
    code,
    out: out.join('\n'),
    err: err.join('\n'),
    logs: logs.join(''),
  }));
}

describe('cli: sync --dry-run on fixture data', () => {
  it('prints the plan and exits 0', async () => {
    const r = await run(['sync', '--dry-run', '--fixture', M1]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('FIXTURE MODE');
    expect(r.out).toContain('DRY RUN');
    expect(r.out).toMatch(/\+ create .*Fisica I/);
    expect(r.out).toMatch(/~ update .*Analisi matematica I/);
    expect(r.out).toMatch(/- delete .*Chimica/);
    expect(r.out).toContain('= 5 unchanged');
    expect(r.out).toContain('INCOMPLETE');
    expect(r.out).toContain('would create 3, update 1, delete 1, keep 5');
    expect(r.err).toBe('');
  });

  it('never prints event titles into the JSON log stream', async () => {
    const r = await run(['sync', '--dry-run', '--fixture', M1], { LOG_LEVEL: 'debug' });
    expect(r.logs).toContain('sync plan computed');
    expect(r.logs).not.toContain('Analisi');
    expect(r.logs).not.toContain('Dentista');
  });

  it('exits 2 and explains when the run would be refused by the safety threshold', async () => {
    const r = await run(['sync', '--dry-run', '--fixture', WIPE]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('A real run would be REFUSED');
    expect(r.out).toContain('E_DELETE_THRESHOLD');
  });

  it('honours DELETE_THRESHOLD from the environment', async () => {
    const r = await run(['sync', '--dry-run', '--fixture', M1], { DELETE_THRESHOLD: '0.05' });
    expect(r.code).toBe(2); // 1 of 7 = 14% > 5%
  });
});

describe('cli: sync (apply) on fixture data', () => {
  it('applies to the in-memory calendar', async () => {
    const r = await run(['sync', '--fixture', M1]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Mode: APPLY');
    expect(r.out).toContain('created 3, updated 1, deleted 1, unchanged 5, failed 0');
  });

  it('refuses a mass deletion without --force and allows it with --force', async () => {
    const refused = await run(['sync', '--fixture', WIPE]);
    expect(refused.code).toBe(2);
    expect(refused.out).toContain('REFUSED, nothing was changed');
    expect(refused.err).toContain('E_DELETE_THRESHOLD');
    const forced = await run(['sync', '--force', '--fixture', WIPE]);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain('deleted 7');
  });
});

describe('cli: sync --dry-run on the sanitized ICS fixture (real parser, in-memory calendar)', () => {
  it('creates, updates the moved lecture, deletes the cancelled ones, leaves foreign events alone', async () => {
    const r = await run(['sync', '--dry-run', '--fixture', M2]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('polito.ics: 15 event(s), 2 cancelled left out');
    expect(r.out).toContain('would create 7, update 1, delete 2, keep 7');
    expect(r.out).toMatch(/~ update .*Analisi matematica I/);
    expect(r.out).toMatch(/- delete .*Chimica/);
    expect(r.out).toContain('(all day)');
    expect(r.out).not.toContain('Dentista');
    expect(r.err).toBe('');
  });
});

describe('cli: errors are coded, explained, and free of stack traces', () => {
  const cases: [string[], string, NodeJS.ProcessEnv?][] = [
    [['sync'], 'E_NOT_CONFIGURED'],
    [['sync', '--bogus'], 'E_USAGE'],
    [['frobnicate'], 'E_USAGE'],
    [['auth', 'google'], 'E_GOOGLE_CLIENT_MISSING'],
    [['auth', 'nope'], 'E_USAGE'],
    [['verify-google'], 'E_GOOGLE_CLIENT_MISSING'],
    [['sync', '--fixture', '/nonexistent/dir'], 'E_FIXTURE_INVALID'],
    [['sync', '--dry-run', '--fixture', M1], 'E_CONFIG_INVALID', { TZ: 'Not/AZone' }],
  ];
  it.each(cases)('%j -> %s', async (argv, code, env) => {
    const r = await run(argv, env ?? {});
    expect(r.code).toBe(1);
    expect(r.err).toContain(code);
    expect(r.err).toContain('Why:');
    expect(r.err).toContain('Do:');
    expect(r.err).toContain(`docs/ERRORS.md#${code.toLowerCase()}`);
    expect(r.err).not.toMatch(/\n\s+at /);
  });
});

describe('cli: help and healthcheck', () => {
  it('prints usage', async () => {
    for (const argv of [[], ['--help'], ['sync', '--help']]) {
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(r.out).toContain('Usage: polito-cal-sync');
    }
  });

  it('healthcheck passes on a usable data dir and creates the database', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'pcs-hc-')), 'data');
    const r = await run(['healthcheck'], { DATA_DIR: dir });
    expect(r).toMatchObject({ code: 0, out: 'ok' });
  });

  it('healthcheck fails with a coded error when the data dir is unusable', async () => {
    // A directory below a regular file can never be created (ENOTDIR).
    const file = join(mkdtempSync(join(tmpdir(), 'pcs-hc-')), 'a-file');
    writeFileSync(file, 'x');
    const r = await run(['healthcheck'], { DATA_DIR: join(file, 'data') });
    expect(r.code).toBe(1);
    expect(r.err).toContain('E_DATA_DIR_NOT_WRITABLE');
  });
});
