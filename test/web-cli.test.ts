import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli/index.js';
import { SettingsStore } from '../src/settings/store.js';
import { PassphraseStore } from '../src/web/auth.js';

const M1 = new URL('./fixtures/m1', import.meta.url).pathname;

function io(): { io: CliIo; out: string[]; err: string[]; logs: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const logs: string[] = [];
  return {
    out,
    err,
    logs,
    io: {
      out: (t) => void out.push(t),
      err: (t) => void err.push(t),
      logStream: { write: (s: string) => void logs.push(s) },
    },
  };
}

describe('settings saved by the UI reach the CLI', () => {
  it('settings.json is used, and the environment wins over it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcs-webcli-'));
    new SettingsStore(dir).apply({ set: { deleteThreshold: 0.05 } }, {});
    // fixture M1 deletes 1 of 7 events (14%): refused at 5%, allowed at 30%
    const a = io();
    expect(await runCli(['sync', '--dry-run', '--fixture', M1], { DATA_DIR: dir }, a.io)).toBe(2);
    const b = io();
    expect(
      await runCli(
        ['sync', '--dry-run', '--fixture', M1],
        { DATA_DIR: dir, DELETE_THRESHOLD: '0.3' },
        b.io,
      ),
    ).toBe(0);
  });

  it('a damaged settings file stops the command with a coded error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcs-webcli-'));
    writeFileSync(join(dir, 'settings.json'), '{broken');
    const a = io();
    expect(await runCli(['sync', '--dry-run', '--fixture', M1], { DATA_DIR: dir }, a.io)).toBe(1);
    expect(a.err.join('\n')).toContain('E_SETTINGS_FILE_INVALID');
    expect(a.err.join('\n')).not.toContain('broken');
  });
});

describe('reset-ui-passphrase', () => {
  it('forgets the passphrase, keeps the settings, and says when there is nothing to do', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcs-webcli-'));
    new SettingsStore(dir).apply({ set: { deleteThreshold: 0.2 } }, {});
    await new PassphraseStore(dir, { cost: 1024 }).initialize('a long enough passphrase');
    const a = io();
    expect(await runCli(['reset-ui-passphrase'], { DATA_DIR: dir }, a.io)).toBe(0);
    expect(a.out.join('\n')).toContain('was removed');
    expect(existsSync(join(dir, 'ui-auth.json'))).toBe(false);
    expect(existsSync(join(dir, 'settings.json'))).toBe(true);
    const b = io();
    expect(await runCli(['reset-ui-passphrase'], { DATA_DIR: dir }, b.io)).toBe(0);
    expect(b.out.join('\n')).toContain('nothing to reset');
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

function getStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path, headers: { Host: `localhost:${port}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    }).on('error', reject);
  });
}

async function serveFor(env: NodeJS.ProcessEnv, probe: (port: number) => Promise<void>) {
  const port = await freePort();
  const ctl = new AbortController();
  const a = io();
  const running = runCli(
    ['serve'],
    { ...env, STATUS_PORT: String(port), LOG_LEVEL: 'silent' },
    a.io,
    { signal: ctl.signal, shutdownGraceMs: 200 },
  );
  for (let i = 0; i < 100; i++) {
    try {
      await getStatus(port, '/healthz');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  try {
    await probe(port);
  } finally {
    ctl.abort();
    await running;
  }
}

describe('serve and the web UI API', () => {
  it('UI_ENABLED=true serves the API next to the status page; default leaves it off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcs-webcli-'));
    await serveFor({ DATA_DIR: dir, UI_ENABLED: 'true' }, async (port) => {
      expect(await getStatus(port, '/api/session')).toBe(200);
      expect(await getStatus(port, '/healthz')).toBeGreaterThan(0);
    });
    const dir2 = mkdtempSync(join(tmpdir(), 'pcs-webcli-'));
    await serveFor({ DATA_DIR: dir2 }, async (port) => {
      expect(await getStatus(port, '/api/session')).toBe(404);
    });
  });
});
