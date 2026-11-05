/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- test code reads loose JSON answers */
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStatusServer } from '../../src/serve/status.js';
import { createWebApp, type WebAppOptions } from '../../src/web/app.js';
import { LoginThrottle, SessionStore } from '../../src/web/auth.js';
import { createLogger } from '../../src/util/logger.js';

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface Harness {
  dataDir: string;
  port: number;
  logs: string[];
  clock: { t: number };
  sessions: SessionStore;
  throttle: LoginThrottle;
  web: ReturnType<typeof createWebApp>;
  /** One raw request. Defaults: Host localhost:<port>, same-origin Origin for non-GET. */
  call(
    method: string,
    path: string,
    o?: {
      body?: unknown;
      rawBody?: string;
      headers?: Record<string, string | undefined>;
      cookie?: string;
    },
  ): Promise<Reply>;
  /** Sets the passphrase and returns the cookie + CSRF token of the new session. */
  setup(passphrase?: string): Promise<{ cookie: string; csrf: string }>;
  login(passphrase?: string): Promise<{ cookie: string; csrf: string }>;
  put(path: string, auth: { cookie: string; csrf: string }, body: unknown): Promise<Reply>;
  close(): Promise<void>;
}

export const PASS = 'correct horse battery staple';

export async function startHarness(
  o: { env?: NodeJS.ProcessEnv; app?: Partial<WebAppOptions>; dataDir?: string } = {},
): Promise<Harness> {
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), 'pcs-web-'));
  const logs: string[] = [];
  const logger = createLogger('debug', { write: (m: string) => void logs.push(m) });
  const clock = { t: 1_800_000_000_000 };
  const sessions = new SessionStore({ now: () => clock.t });
  const throttle = new LoginThrottle({ now: () => clock.t });
  const web = createWebApp({
    dataDir,
    env: o.env ?? {},
    logger,
    passphraseCost: 1024,
    sessions,
    throttle,
    ...o.app,
  });
  const server = createStatusServer(() => ({}) as never, { bind: '127.0.0.1', port: 0, web });
  const port = await server.listen();

  const call: Harness['call'] = (method, path, c = {}) =>
    new Promise((resolve, reject) => {
      const payload = c.rawBody ?? (c.body === undefined ? undefined : JSON.stringify(c.body));
      const headers: Record<string, string> = {
        Host: `localhost:${port}`,
        ...(method !== 'GET' ? { Origin: `http://localhost:${port}` } : {}),
        ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(c.cookie ? { Cookie: c.cookie } : {}),
      };
      for (const [k, v] of Object.entries(c.headers ?? {})) {
        const existing = Object.keys(headers).find((h) => h.toLowerCase() === k.toLowerCase());
        if (v === undefined) delete headers[existing ?? k];
        else {
          if (existing && existing !== k) delete headers[existing];
          headers[k] = v;
        }
      }
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  const sessionFrom = (r: Reply): { cookie: string; csrf: string } => {
    const set = String(r.headers['set-cookie']?.[0] ?? '');
    return { cookie: set.split(';')[0] ?? '', csrf: r.json.csrfToken };
  };
  return {
    dataDir,
    port,
    logs,
    clock,
    sessions,
    throttle,
    web,
    call,
    async setup(p = PASS) {
      const r = await call('POST', '/api/setup', { body: { passphrase: p } });
      if (r.status !== 201) throw new Error(`setup failed: ${r.status} ${r.text}`);
      return sessionFrom(r);
    },
    async login(p = PASS) {
      const r = await call('POST', '/api/login', { body: { passphrase: p } });
      if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`);
      return sessionFrom(r);
    },
    put: (path, a, body) =>
      call('PUT', path, { body, cookie: a.cookie, headers: { 'X-CSRF-Token': a.csrf } }),
    close: () => server.close(),
  };
}
